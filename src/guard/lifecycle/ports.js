'use strict';

// 系统级统一端口管理（v2 持久化）：
//  - 全系统所有端口（固定/实例/动态分配段）统一登记为「端口记录」，单一来源；
//  - 端口记录持久化到 ports.json（0600）：守卫重启后固定/实例/已分配绑定全量恢复，不丢、不重复分配；
//  - 每条记录含 owner（归属对象）：删除对象即释放端口（实例删除→释放、relay 关闭→释放、反代实例停止→释放）；
//  - 所有监听/分配逻辑统一从 registry 取端口 + 对应关系（port/role/owner），杜绝散落与冲突。
// 记录结构：{ port, role, owner, createdAt }

const fs = require('node:fs');
const path = require('node:path');
const probe = require('../monitor/probe'); // 同层依赖（infra/probe），不依赖上层 domain/monitor（消除越界）

// 动态分配段：全部选用非常用端口段，避开开发/常用服务端口
const RANGES = {
  relay: { base: 40000, count: 200 },        // 局域网反向代理（每实例一个对外端口）
  proxyInstance: { base: 41000, count: 200 }, // 反代应用实例（npx 子进程）
  oauthCallback: { base: 42000, count: 20 },  // 本地 OAuth 回调服务器
  providerApi: { base: 43000, count: 32 },   // 智能路由每供应商独立 API 端点（激活供应商监听）
};

class PortRegistry {
  constructor(opts) {
    this._file = (opts && opts.file) || path.join(process.env.HOME || '/tmp', '.dsh', 'supervisor', 'ports.json');
    this._records = new Map();   // port -> { port, role, owner, createdAt }
    this._allocLock = false;     // 分配互斥：isTaken(await) 窗口内并发调用必须串行
    this._load();
  }

  /** 重设持久化文件（守卫构造时注入：与 stateFile 同域；测试可指向临时目录，避免污染生产记录）。
   *  重新加载新文件内容；旧内存记录废弃（不写回旧文件——测试进程绝不触碰生产 ports.json）。 */
  configureFile(file) {
    if (typeof file !== 'string' || !file) return;
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  /* ═══════ 持久化 ═══════ */
  _load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const r of (Array.isArray(doc.records) ? doc.records : [])) {
        if (r && Number.isInteger(r.port) && r.role) this._records.set(r.port, { port: r.port, role: r.role, owner: r.owner || null, createdAt: r.createdAt || Date.now() });
      }
    } catch {}
  }

  /** 迁移S2：把 router 自治端口段（owner 前缀 proxy:/providerApi:）从共享 oldFile 迁出到 newFile 并清旧段。幂等；失败抛错由调用方保留旧文件。 */
  migrateRouterSegment(oldFile, newFile) {
    const isRouterRec = (r) => String((r && r.owner) || "").startsWith("proxy:") || String((r && r.owner) || "").startsWith("providerApi:");
    if (!fs.existsSync(oldFile)) return 0;
    const doc = JSON.parse(fs.readFileSync(oldFile, "utf8"));
    const routerRecs = (doc.records || []).filter(isRouterRec);
    if (!routerRecs.length) return 0;
    let target = { records: [] };
    try { if (fs.existsSync(newFile)) target = JSON.parse(fs.readFileSync(newFile, "utf8")); } catch {}
    const seen = new Set((target.records || []).map((r) => r.port));
    let moved = 0;
    for (const r of routerRecs) { if (!seen.has(r.port)) { target.records.push(r); moved += 1; } }
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    const tmpN = newFile + ".tmp";
    fs.writeFileSync(tmpN, JSON.stringify(target, null, 2), { mode: 0o600 });
    fs.renameSync(tmpN, newFile);
    const keep = (doc.records || []).filter((r) => !isRouterRec(r));
    const tmpO = oldFile + ".tmp";
    fs.writeFileSync(tmpO, JSON.stringify({ records: keep }, null, 2), { mode: 0o600 });
    fs.renameSync(tmpO, oldFile);
    return moved;
  }

  /** 重新从文件加载（阶段三：守卫读路径先 reload，以权威文件为准，防跨进程陈旧内存快照）。 */
  reload() {
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ records: [...this._records.values()] }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._file);
    } catch (e) { /* 持久化失败不阻塞运行（内存态仍准确） */ }
  }

  /* ═══════ 登记（固定 / 用户 / 动态）═══════ */
  /** 登记固定端口（主DSH/API/中转等）。同端口已被其他固定角色占用 → 报错；
   *  user/动态记录（如实例 main 端口 = 主 DSH 端口）→ 固定端口权威覆盖。 */
  register(role, port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.register: 非法端口 ' + port);
    const existing = this._records.get(p);
    if (existing) {
      const existingFixed = String(existing.owner || '').startsWith('system:');
      if (existingFixed && existing.role !== role) throw new Error('端口 ' + p + ' 已被 [' + existing.role + '] 占用，无法登记为 [' + role + ']');
      // 覆盖 user/动态记录（固定端口权威；main 实例端口 = dsh-main 同一端口）
      if (existing.owner && !existingFixed) this._records.delete(p);
    }
    this._records.set(p, { port: p, role, owner: 'system:' + role, createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 登记用户配置端口（实例内部端口等）。冲突（固定/保留段/已占用）抛错。 */
  registerUser(port, owner) {
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.registerUser: 非法端口 ' + port);
    if (this._records.has(p)) throw new Error('端口 ' + p + ' 已被 [' + this._records.get(p).role + '] 占用');
    // 实例端口不得落入任何动态分配保留段
    for (const key of Object.keys(RANGES)) {
      const rng = RANGES[key];
      if (p >= rng.base && p < rng.base + rng.count) throw new Error('端口 ' + p + ' 位于保留段 [' + key + ']，实例端口不可占用');
    }
    this._records.set(p, { port: p, role: 'user', owner: owner || 'user', createdAt: Date.now() });
    this._save();
    return p;
  }

  /** 按 owner 释放端口（对象删除/关闭时调用：实例删除、relay 关闭、反代实例停止、oauth 用完）。 */
  unregister(owner) {
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  /** 释放单个端口（按端口号）。 */
  release(port) {
    const p = Number(port);
    if (this._records.has(p)) { this._records.delete(p); this._save(); }
  }

  /* ═══════ 查询 ═══════ */
  /** 按 role 取端口（固定端口）。 */
  get(role) {
    for (const r of this._records.values()) if (r.role === role) return r.port;
    return null;
  }

  /** 端口是否已登记（任意来源）。 */
  isRegistered(port) {
    return this._records.has(Number(port));
  }

  /** 端口登记记录（含 owner/role）；未登记返回 null。 */
  recordOf(port) {
    return this._records.get(Number(port)) || null;
  }

  /** 按 owner 查端口（业务对象从 registry 取自己的端口——端口唯一活在 registry，业务侧不持久化）。 */
  byOwner(owner) {
    for (const r of this._records.values()) if (r.owner === owner) return r.port;
    return null;
  }

  /** 端口是否被占用：已登记 ∪ 本机实际监听。
   *  @param excludeOwner 若提供：该 owner 自己的登记不算占用（可复用自己绑定的端口）。 */
  async isTaken(port, excludeOwner) {
    const rec = this._records.get(Number(port));
    if (rec && (!excludeOwner || rec.owner !== excludeOwner)) return true;
    return probe.portListening('127.0.0.1', Number(port), 300);
  }

  /** 全部端口清单（端口/角色/归属，供审计展示）。 */
  list() {
    return [...this._records.values()].sort((a, b) => a.port - b.port);
  }

  /* ═══════ 确定性槽位仲裁（2026-09 架构定稿，docs/port-architecture.md）═══════
   * claimSlot(rangeKey, owner, opts)：统一「绑定持久 + 确定性分配 + 孤儿回收 + main 回迁」。
   *   期望槽位 = ① byOwner 既有绑定（绑定永久，重启复用）→ ② opts.preferred（如 main=40000）→
   *              ③ 段内最小空闲（按加入顺序补位，删除即释放补位）。
   *   期望被占（登记为异 owner / 本机监听）→ 先按 opts.reclaim 特征（cmdline pgrep，YAMA 免疫）
   *   回收「本工程旧代」→ 等释放（opts.waitMs）→ 重试；仍被外部占用 → 返回显式冲突（绝不静默跳号）。 */
  async claimSlot(rangeKey, owner, opts) {
    const o = opts || {};
    const range = o.range || RANGES[rangeKey];
    if (!range) throw new Error('ports.claimSlot: 未知端口段 ' + rangeKey);
    const reclaim = async (port) => {
      if (!o.reclaimCmdMark) return 0;
      let killed = 0;
      try {
        const { execFileSync } = require('node:child_process');
        const out = execFileSync('pgrep', ['-af', o.reclaimCmdMark], { encoding: 'utf8', timeout: 3000 }).toString();
        const cfg = o.reclaimCfg || '';
        for (const line of out.split(/\r?\n/)) {
          const m = /^(\d+)\s+(.*)$/.exec(line.trim());
          if (!m) continue;
          const pid = Number(m[1]);
          if (pid === process.pid) continue;
          const cmd = m[2];
          if (cfg && cmd.indexOf(cfg) < 0) continue;
          try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
        }
      } catch {}
      return killed;
    };
    const waitFree = async (port, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (!(await this.isTaken(port, owner))) return true; await new Promise((r) => setTimeout(r, 200)); }
      return !(await this.isTaken(port, owner));
    };
    const register = (port) => {
      if (!this._records.has(port)) { this._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() }); this._save(); }
    };
    // 尝试把 port 交给 owner：成功(空/自听/可回收)→register+返回；否则返回 null（不可用）
    const tryClaim = async (port) => {
      if (!port) return null;
      const rec = this._records.get(port);
      const selfListener = (() => { try { const pidlook = require('../../platform/os/pidlookup'); return pidlook.findListeningPid(port) === process.pid; } catch { return false; } })();
      if (selfListener) { register(port); return { port, mode: 'self-listening' }; }
      if (rec && rec.owner !== owner) return null; // 其它 owner 已登记：不抢（交上层裁决）
      const reused = !!(rec && rec.owner === owner);
      const taken = await this.isTaken(port, owner);
      if (!taken) { register(port); return { port, mode: reused ? 'reuse' : 'claim' }; }
      const killed = await reclaim(port);
      if (killed > 0 && (await waitFree(port, o.waitMs || 6000))) { register(port); return { port, mode: 'reclaimed' }; }
      return null; // 外部占用且回收失败
    };
    const bound = this.byOwner(owner);
    // ── ① 权威绑定（byOwner）── 绑定的端口优先；被占→回收；回收失败→显式迁移（不静默、不中断）
    if (bound) {
      const r = await tryClaim(bound);
      if (r) return Object.assign({ owner, segment: rangeKey, binding: true }, r);
      // 绑定被外部/其它 owner 永久占用：尝试立即回收等待后仍失败 → 迁移并显式事件（binding-lost）
      const alt = await this._allocFree(rangeKey, range, owner, o);
      if (alt) {
        if (o.onBindingLost) { try { o.onBindingLost({ owner, from: bound, to: alt.port }); } catch {} }
        return Object.assign({ owner, segment: rangeKey, binding: true, bindingLost: true, from: bound }, alt);
      }
      return Object.assign({ owner, segment: rangeKey, conflict: true, reason: 'binding-occupied-and-segment-full', port: bound });
    }
    // ── ② preferred ──
    //   - bindingPreferred=true（调用方持久绑定记忆，如 inst.wanPort 或 byOwner 曾绑定）：
    //     该端口被异 owner 抢注/外部占用且无法回收 → 迁移 + onBindingLost 显式事件（绑定被盗不静默）；
    //   - 普通 preferred（advisory，如 main→40000 默认槽位）：被占则回退最小空闲，绝不因偏好中断服务。
    if (o.preferred) {
      const r = await tryClaim(o.preferred);
      if (r) return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: !!o.bindingPreferred }, r);
      if (o.bindingPreferred) {
        // 持久绑定记忆的端口不可用（被盗/被占且回收失败）→ 迁移并显式标记
        const alt = await this._allocFree(rangeKey, range, owner, o);
        if (alt) {
          if (o.onBindingLost) { try { o.onBindingLost({ owner, from: o.preferred, to: alt.port }); } catch {} }
          return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: true, bindingLost: true, from: o.preferred }, alt);
        }
        return Object.assign({ owner, segment: rangeKey, conflict: true, reason: 'binding-preferred-occupied-and-segment-full', port: o.preferred });
      }
      // advisory preferred：静默回退（由 ③ 分配最小空闲）
    }
    // ── ③ 段内最小空闲 ──
    const free = await this._allocFree(rangeKey, range, owner, o);
    return Object.assign({ owner, segment: rangeKey }, free || { conflict: true, reason: 'segment-full' });
  }

  /** 段内最小空闲分配（含回收尝试后仍被占则跳过——但跳过即跳号，故先对候选做回收再定）。 */
  async _allocFree(rangeKey, range, owner, o) {
    while (this._allocLock) { await new Promise((r) => setTimeout(r, 10)); }
    this._allocLock = true;
    try {
      for (let i = 0; i < range.count; i++) {
        const p = range.base + i;
        if (this._records.has(p)) continue; // 已登记给任何 owner 都跳过（防同端口双 owner）
        if (await this.isTaken(p)) {
          // 候选被监听：尝试回收本工程旧代后重判（避免跳号）
          if (o.reclaimCmdMark) {
            const { execFileSync } = require('node:child_process');
            try {
              const out = execFileSync('pgrep', ['-af', o.reclaimCmdMark], { encoding: 'utf8', timeout: 3000 }).toString();
              const cfg = o.reclaimCfg || '';
              for (const line of out.split(/\r?\n/)) {
                const m = /^(\d+)\s+(.*)$/.exec(line.trim());
                if (!m) continue;
                const pid = Number(m[1]);
                if (pid === process.pid) continue;
                const cmd = m[2];
                if (cfg && cmd.indexOf(cfg) < 0) continue;
                try { process.kill(pid, 'SIGTERM'); } catch {}
              }
            } catch {}
            await new Promise((r2) => setTimeout(r2, o.waitMs || 2500));
          }
          if (await this.isTaken(p)) continue; // 仍被外部占：跳过（该槽位不可用）
        }
        if (!(await this._canBind(p))) continue;
        this._records.set(p, { port: p, role: rangeKey, owner, createdAt: Date.now() });
        this._save();
        return { port: p, mode: 'allocated' };
      }
      return null;
    } finally {
      this._allocLock = false;
    }
  }

  /* ═══════ 动态分配 ═══════ */
  /** bind 探测：尝试在本机 127.0.0.1 绑定端口。能绑定 → 可分配；任何 bind 错误（典型
   *  EADDRINUSE）→ 视为已占用。TCP connect 探测看不见“不监听但占 bind”的残留
   *  （如对已停止反代实例端口的空闲 keep-alive 连接——connect 失败但后续 spawn bind 会撞
   *  EADDRINUSE），本探测与真实 spawn 的绑定语义一致，能兜住这类隐藏占用。 */
  _canBind(port) {
    // 延迟 require：避免顶层依赖 net（本模块其余部分与网络无关）
    const net = require('node:net');
    return new Promise((resolve) => {
      let done = false;
      const srv = net.createServer();
      const finish = (ok) => { if (done) return; done = true; try { srv.close(); } catch {} resolve(ok); };
      srv.once('error', () => finish(false)); // EADDRINUSE / EACCES 等均视为不可绑
      srv.listen(port, '127.0.0.1', () => finish(true));
    });
  }

  /** 在指定段分配空闲端口并登记（owner 绑定）。互斥防并发同端口。
   *  候选判占 = 端口登记 ∪ TCP connect 探测 ∪ bind 探测（三重，防隐藏占用）。 */
  async allocate(rangeKey, owner, opts) {
    const range = RANGES[rangeKey];
    if (!range) throw new Error('ports.allocate: 未知端口段 ' + rangeKey);
    const start = (opts && opts.skipFirst) ? 1 : 0;
    while (this._allocLock) { await new Promise((r) => setTimeout(r, 10)); }
    this._allocLock = true;
    try {
      for (let i = start; i < range.count; i++) {
        const p = range.base + i;
        if (this._records.has(p)) continue;      // 已登记（含持久化恢复的绑定）
        if (await this.isTaken(p)) continue;
        if (!(await this._canBind(p))) continue; // 残留/隐藏占用：connect 探测不可见但 bind 会失败
        this._records.set(p, { port: p, role: rangeKey, owner: owner || 'dynamic:' + rangeKey, createdAt: Date.now() });
        this._save();
        return p;
      }
      return null;
    } finally {
      this._allocLock = false;
    }
  }

  /** 显式登记已分配端口（复用持久化端口时调用：端口记录恢复/回迁）。 */
  allocateMark(port, role, owner) {
    const p = Number(port);
    if (!this._records.has(p)) {
      this._records.set(p, { port: p, role: role || 'dynamic', owner: owner || 'dynamic', createdAt: Date.now() });
      this._save();
    }
  }

  /** 全部端口快照（固定/用户/分配，供审计）。 */
  snapshotAll() {
    const byRole = (fn) => [...this._records.values()].filter(fn).map((r) => r.port).sort((a, b) => a - b);
    return {
      fixed: Object.fromEntries([...this._records.values()].filter((r) => String(r.owner || '').startsWith('system:')).map((r) => [r.role, r.port])),
      user: byRole((r) => r.role === 'user'),
      allocated: byRole((r) => r.role !== 'user' && !String(r.role).startsWith('system:')),
    };
  }
}

// 单例：全系统共享（supervisor 构造时注入 file 路径）
const shared = new PortRegistry();

module.exports = { PortRegistry, shared, RANGES };
