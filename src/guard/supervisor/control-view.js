'use strict';

// §7.6 拆分自 supervisor.js：control-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const pidlook = require('../../platform/os/pidlookup');
const { DaemonLifecycle } = require('../../guard/proc/daemon-lifecycle');
const platform = require('../../platform/os/index');
const monitor = require('../../guard/monitor/index');
const ports = require('../../guard/lifecycle/ports').shared;
const guardian = require('../../guard/guardian/index');

class ControlView {
  routerProviders() {
    const presets = this.router.constructor.presets();
    // 阶段三：local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本——见 PHASE3 设计）
    const local = () => ({ presets, providers: this.router.listProviders(), proxyApps: this.router.proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!this.routerDaemonActive()) return local();
    const rt = this.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (this.logger && this.logger.warn) this.logger.warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  }

  // ---- L3 监督模式：router 控制通道（daemon 唯一事实源，2026-09）----
  // 守卫 API/视图统一从 routerApi() 取 router 门面：daemon 在跑 → 方法调用转发 ctl
  // （POST /ctl {method,args}，见 src/domains/router/ctl.js）——写即 daemon 生效、
  // 读即 daemon 最新（消除此前「守卫本地副本视图陈旧 / 写不生效」的双脑不一致，HANDOFF #4）；
  // daemon 未跑 → 守卫本地实例（内嵌回退路径，行为不变）。
  routerApi() {
    if (this.routerDaemonActive()) {
      if (!this._routerFacade) this._routerFacade = this._makeRouterFacade();
      return this._routerFacade;
    }
    return this.router;
  }

  routerDaemonActive() {
    // 仅当本守卫「期望 daemon 运行（routerAutostart）」且「管理锁在手（本守卫写过的 lock）」且
    // 43011 监听者为 router-daemon 时，才视为「daemon 监督模式」（routerApi/门面/ctl 生效）。
    // 关键：绝不因全局 43011 被占就把任意 Supervisor 实例（含测试内嵌实例，乃至运行中把
    // routerAutostart 置真的测试/内嵌路径）误判为监督模式——否则测试 api 调用会经 ctl 打到
    // 线上 daemon（2026-09 实测 p2p-api-test 误接生产路由：/router/start 置 autostart=true 后
    // 后续全部 provider 视图/写操作打到生产 daemon）。
    try {
      if (!this.config || this.config.routerAutostart !== true) return false;
      if (!this._daemonManaged()) return false;
      return this._routerDaemonActive();
    } catch { return false; }
  }

  /** 通用 ctl 调用（router 43107 / lan 43108 共用）。 */
  _ctlCall(port, method, args, timeoutMs) {
    const http = require('node:http');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, args: Array.isArray(args) ? args : [] });
      const req = http.request({
        host: '127.0.0.1', port, path: '/ctl', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs || 120000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf || '{}');
            if (j && j.ok) return resolve(j.value);
            const err = new Error((j && j.error) || ('ctl:' + port + ' ' + method + ' failed'));
            err.ok = false;
            err.error = (j && j.error) || null;
            return reject(err);
          } catch { return reject(new Error('ctl:' + port + ' 响应解析失败')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('ctl:' + port + ' 超时')));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** router-daemon 控制通道端口（单一来源：config；缺省见 platform/config DEFAULTS）。
   *  历史教训：曾散落硬编码 43011，而该值实际落在 providerApi 动态段（43000+）内，
   *  与供应商独立端点发生注册表双占冲突；ctl 通道必须与动态分配段解耦。 */
  _routerCtlPort() { return Number(this.config && this.config.routerCtlPort) || 43107; }
  /** lan-daemon 控制通道端口（单一来源：config）。 */
  _lanCtlPort() { return Number(this.config && this.config.lanCtlPort) || 43108; }

  _makeRouterFacade() { return this._makeCtlFacade(this._routerCtlPort()); }

  _makeCtlFacade(port) {
    const self = this;
    const cache = new Map();
    const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BANNED.has(prop)) return undefined;
        if (cache.has(prop)) return cache.get(prop);
        const fn = (...args) => self._ctlCall(port, prop, args);
        cache.set(prop, fn);
        return fn;
      },
      has() { return true; },
    });
  }

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
  async routerStatusView() {
    if (this.routerDaemonActive()) {
      try {
        const st = await this.routerApi().status();
        return { running: !!(st && st.running), autostart: this.config.routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return this.routerStatus();
  }

  // ---- 端口管理门面：统一端口 registry 清单经 sup 接口暴露（presentation 不直连 infra）----
  // 2026-09 修复：原实现 records 恒缺 active → 前端端口管理「状态」列全部显示停用（接线断裂）。
  // 现为每条记录补 active（端口当前真实监听中）。探测按「端口集合」整批缓存 3s TTL，
  // 避免前端 2s 心跳每次触发全量同步扫 /proc 挤占事件循环。
  async listPorts() {
    // 归一化收拢（2026-09）：系统端口登记分散在 3 个注册表文件（同 stateDir）——
    //   ports.json（守卫共享：system/inst/oauth/managed-ctl）
    //   ports-lan.json（lan-daemon 独占：relay 隧道 40000+ —— 远程控制/局域网暴露端口）
    //   ports-router.json（router-daemon 独占：proxyInstance 反代 41000+ / providerApi 43000+ —— 智能路由实例）
    // /ports 必须聚合三文件去重合并，才是「整个系统的运行状态」；此前只返回守卫共享段，
    // 导致智能路由反代/供应商 API、relay 隧道端口在前端缺失（结构失衡）。
    try { ports.reload(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('ports reload: ' + (e && e.message)); }
    const swDir = path.dirname(this.config.stateFile);
    const byPort = new Map();
    const adopt = (rec) => {
      if (!rec || !Number.isInteger(rec.port) || !rec.role || byPort.has(rec.port)) return;
      byPort.set(rec.port, {
        port: rec.port, role: rec.role, owner: rec.owner || null,
        createdAt: Number.isInteger(rec.createdAt) ? rec.createdAt : Date.now(),
      });
    };
    for (const r of ports.list()) adopt(r);
    for (const f of ['ports-lan.json', 'ports-router.json']) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(swDir, f), 'utf8'));
        for (const r of (Array.isArray(doc.records) ? doc.records : [])) adopt(r);
      } catch {}
    }
    // 运行状态视图归一化: oauthCallback 是登录瞬态回调(非服务)不进常驻列表; supervisor-api 历史残留段保留供 active 筛选
    const merged = [...byPort.values()].filter((r) => r.role !== "oauthCallback");
    const activeByPort = await this._portActives(merged.map((r) => r.port));
    const records = merged.map((r) => ({
      port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt,
      active: !!(activeByPort && activeByPort[r.port]) || false,
    }));
    const snap = ports.snapshotAll();
    // supervisor-api 多端口历史残留(3100/36360/36361): 只保留正在监听者, 废弃端口不占位
    const apiAct = records.filter((r) => r.role === "supervisor-api" && r.active);
    const out = apiAct.length ? records.filter((r) => r.role !== "supervisor-api" || r.active) : records;
    // 池容量可观测（工业标准：运维可见 used/free/utilization，池满前可预警/扩容）
    let capacity = null;
    try { capacity = (typeof ports.capacity === 'function') ? ports.capacity() : null; } catch {}
    return { records: out, snapshot: snap, capacity };
  }

  /** 端口集合激活探测（整批 3s TTL 缓存）。active=true 表示该端口当前有进程在监听。
   *  2026-09 复检根治：改为纯 TCP connect 探测（probe.portListening）——不再依赖 pid 映射。
   *  背景：findListeningPing 需读 /proc/<pid>/fd 反查 socket→pid，对本机「守卫管理树外/孙进程」
   *  （router-daemon 的反代子进程）常因读取权限返回 null → 端口明明在监听却恒报 inactive（前端端口
   *  管理「无任何实例激活」失真，实测 41038 在听而 active=false）。TCP connect 与端口是否被监听
   *  直接等价（同 infra/ports 判占用语义），无需任何 /proc 权限，三平台一致。 */
  async _portActives(portsList) {
    const now = Date.now();
    const key = portsList.join(',');
    if (this._portActivesCache && this._portActivesCache.key === key && now - this._portActivesCache.at < 3000) {
      return this._portActivesCache.map;
    }
    // 拆分后相对路径须相对本文件：src/guard/supervisor/ → ../../guard/monitor/probe
    const probe = require('../../guard/monitor/probe');
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    this._portActivesCache = { key, at: now, map };
    return map;
  }

  // ---- L3b：lan(relay) daemon 解耦（config.lanDaemon=true，2026-09）----
  // 门控默认关：关闭时行为与历史一致（LanManager 驻守卫）。开启后：
  //   - relay/frpc 由独立 lan-daemon 承载（守卫重启不影响远程控制）
  //   - 守卫写 lan-state.json（实例清单+令牌）供 daemon 轮询；本守卫不再本地建 relay
  //   - 全部 lan 读/写经 43108 ctl 委托 daemon；守卫 30s 监督 tick 拉起失联 daemon
  lanDaemonEnabled() { return !!(this.config && this.config.lanDaemon === true); }

  _lanDaemonActive() {
    try {
      const pid = pidlook.findListeningPid(this._lanCtlPort());
      if (!pid) return false;
      const cmd = pidlook.readCmdline(pid) || '';
      return cmd.indexOf('lan-daemon') >= 0 || cmd.indexOf('/domains/relay/daemon.js') >= 0;
    } catch { return false; }
  }

  /** 统一受管进程生命周期实例（懒加载单例；lan/router 共用 DaemonLifecycle 核心，2026-09 架构定稿）。
   *  身份文件（owner 连续：守卫重启=接管既有 daemon）+ spawn latch + 换代停旧→等死→等端口释放 全在核心内。 */
  _daemonLifecycle(kind) {
    if (!this.configPath) return null; // 非守卫实例（测试）绝不管理独立 daemon
    if (!this._lc) this._lc = {};
    if (this._lc[kind]) return this._lc[kind];
    const cfgPath = this.configPath;
    const isLan = kind === 'lan';
    // ⚠ 路径解析必须用**单一真源**（2026-09-11 生产级修复）：
    //   旧实现 `path.join(__dirname, '..')` + `'src/domains/...'` 在 §7.6 拆分后
    //   （__dirname 由 src/ 变为 src/guard/supervisor/）解析成 `src/guard/src/...`
    //   —— **文件不存在**，于是 `_daemonLifecycle` 恒为 null，
    //   **守卫永远无法自起 router/lan daemon**（且既有测试完全绕过此路径）。
    //   srcpath 用「存在性验证」代替脆弱的相对推算法。
    const script = require('../../platform/srcpath').daemonScript(isLan ? 'lan' : 'router');
    if (!script) return null;
    const dir = path.dirname(this.config.stateFile);
    this._lc[kind] = new DaemonLifecycle({
      name: kind,
      script,
      args: ['-c', cfgPath],
      ctlPort: isLan ? this._lanCtlPort() : this._routerCtlPort(),
      cmdMark: isLan ? 'lan-daemon' : 'router-daemon',
      identityFile: path.join(dir, kind + '-daemon.identity.json'),
      spawnEnv: () => ({ DSH_SUPERVISOR_CONFIG: cfgPath }),
      logger: this.logger,
      events: this.events,
    });
    return this._lc[kind];
  }

  /** ensure 结果 → 旧调用方契约翻译（adopted 不带 spawned：避免监督误报“失联重拉”）。 */
  _daemonEnsureResult(lc, writeOwnerLock) {
    const rr = lc.ensureRunning();
    if (rr.mode === 'started' || rr.mode === 'adopted') {
      if (writeOwnerLock) writeOwnerLock();
      return rr.mode === 'started'
        ? { active: true, mode: 'daemon', spawned: rr.pid }
        : { active: true, mode: 'daemon' }; // adopted：既有进程，owner 连续
    }
    if (rr.mode === 'barrier') return { active: false, mode: 'barrier', reason: '生命周期窗口内' };
    if (rr.mode === 'reclaiming') return { active: false, mode: 'reclaiming', stale: rr.stale };
    return { active: false, mode: 'error', error: 'unexpected lifecycle mode: ' + rr.mode };
  }

  _lanLockPath() { try { return path.join(path.dirname(this.config.stateFile), 'lan-daemon.lock'); } catch { return null; } }
  _lanManaged() { try { const p = this._lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } }
  _writeLanLock() { try { const p = this._lanLockPath(); if (p) fs.writeFileSync(p, String(process.pid)); } catch {} }
  _clearLanLock() { try { const p = this._lanLockPath(); if (p) { try { fs.unlinkSync(p); } catch {} } } catch {} }

  _lanCtlCall(method, args, timeoutMs) { return this._ctlCall(this._lanCtlPort(), method, args, timeoutMs); }

  /** lan 门面（2026-09 端口权威修复）：daemon 模式【已启用】即一律走 ctl（daemon 事实源）——
   *  【绝不退回本地 LanManager】。daemon 换代/启动窗口不可达时也绝不退回本地路径——否则
   *  前端轮询/内部路径会触发本地 syncProxy 建 relay（漂移族 ghost 40000 等，
   *  与 daemon 注册表正确族并存 = 用户反复"40000 仍可访问/端口混乱"根因）。
   *  daemon 暂不可达 → ctl 调用失败返回空/错误（不建本地 relay），等 daemon 恢复由监督拉起。 */
  /** 实例清单+令牌 → lan-state.json（原子 0600；daemon 轮询消费）。hash 相同不落盘。 */
  _syncLanState() {
    if (!this.lanDaemonEnabled()) return;
    try {
      const dir = path.dirname(this.config.stateFile);
      const file = path.join(dir, 'lan-state.json');
      // main(原生主干)由守卫核心持有(dsh-main.json)，不再在沙箱数组——lan-state 合成两者(协议不变)
      const instances = [
        ...((this.instances && this.instances.instances) || []),
        ...(this.dshMainView ? [this.dshMainView()] : []),
      ];
      const tokens = {};
      for (const inst of instances) {
        try {
          const t = this.tokenService && this.tokenService.get(inst.id);
          if (t) tokens[inst.id] = t;
        } catch {}
      }
      // 稳定性（2026-09）：哈希用稳定内容（无易变时间戳）——否则 30s 监督 tick 每次重写 lan-state，
      // lan-daemon 每轮视为「变化」→ 对全部实例重复 applyToken/重换 cookie（实测每 30s 全员重换）。
      // 文件保持顶层 {instances, tokens} 与 lan-daemon 解析兼容；仅当内容真变化才落盘。
      // 2026-09 端口权威修复：同步实例【不含 wanPort】——relay 端口唯一权威是端口注册表
      // (ports-lan.json, daemon claimSlot byOwner 复用)，lan-state 只传实例身份/开关。
      // 曾含 wanPort → 守卫把 instances.json 的历史写死值(如 main=40000 漂移)传播给 daemon，
      // 与注册表(40002)分裂 → ghost 双族并存（用户反复 40000 可访问/端口混乱根因）。
      const body = JSON.stringify({ instances: instances.map((i) => ({
        id: i.id, name: i.name, port: i.port, remoteEnabled: !!i.remoteEnabled,
        remoteToken: i.remoteToken || '', frpEnabled: !!i.frpEnabled,
        frpRemotePort: i.frpRemotePort || null,
      })), tokens }, null, 1);
      if (body === this._lastLanStateJson) return;
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
      this._lastLanStateJson = body;
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('_syncLanState: ' + (e && e.message));
    }
  }

  /** L3b：拉起独立 lan-daemon（detached；幂等：43108 已被本守卫管理 daemon 占用则不重复拉起）。 */
  _ensureLanRuntime(desiredRunning) {
    try {
      const active = this._lanDaemonActive();
      const managed = this._lanManaged();
      if (desiredRunning !== false && active && managed) return { active: true, mode: 'daemon' };
      if (desiredRunning !== false && active && !managed) return { active: false, mode: 'external' }; // 异主不接管
      if (desiredRunning === false) {
        if (active && managed) {
          const pid = pidlook.findListeningPid(this._lanCtlPort());
          if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
          this._clearLanLock();
          const lcS = this._daemonLifecycle('lan');
          if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
          return { active: false, mode: 'daemon', stopping: true };
        }
        return { active: false, mode: 'none' };
      }
      // ══ 统一进程生命周期（2026-09 架构定稿）：spawn 一次性 + 换代停旧→等死→等端口释放，
      //  身份文件 owner 连续（守卫重启=接管）——全部收敛在 DaemonLifecycle，此处只做契约翻译 ══
      const lc = this._daemonLifecycle('lan');
      if (!lc) return { active: false, mode: 'none', error: 'lan-daemon 脚本缺失' };
      return this._daemonEnsureResult(lc, () => this._writeLanLock());
    } catch (e) {
      return { active: false, mode: 'error', error: e.message };
    }
  }

  /** 沙箱实例监督单拍（v3 R3 C3-4a observe → C3-4b supervise 接管）：heartbeat 经 adapter
   *  对每个沙箱实例执行监督收敛（InstanceManager.supervise 单实例状态机，语义=旧 tick per-instance），
   *  并把目录项与实例域状态对齐（desired/phase/guardian——目录=真实视图，防 ghost/死登记）。
   *  域业务 CRUD/安装/装配/systemd/持久化保留 InstanceManager；本方法只做心跳驱动 + 目录同步。
   *  @returns {ok:boolean} 实例当前在线（heartbeat 统一写目录 lastObserved） */
  async _sandboxSuperviseOnce(entry) {
    if (this._stopping) return { ok: false, error: 'guard stopping' };
    // INV-S1 全域（契约 §3.3）：会话退出中/已退出 → 沙箱不再监督收敛（防 shutdownAll 停掉后又被拉起）。
    if (this._sessionHalting()) return { ok: false, error: 'session halting' };
    if (entry && this.instances && typeof this.instances.supervise === 'function') {
      try {
        await this.instances.supervise(entry.id);
      } catch (e) {
        this.logger && this.logger.warn && this.logger.warn('sandbox supervise(' + entry.id + '): ' + ((e && e.message) || e));
      }
    }
    let st = null;
    try {
      if (entry && this.instances && typeof this.instances.probeInstance === 'function') {
        st = this.instances.probeInstance(entry.id);
      }
    } catch (e) {
      this.logger && this.logger.warn && this.logger.warn('sandbox probe(' + (entry && entry.id) + '): ' + ((e && e.message) || e));
    }
    const running = !!(st && st.running);
    try { this._syncSandboxRegistryEntry(entry); } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox entry sync: ' + ((e && e.message) || e)); }
    return { ok: running, error: running ? null : '沙箱实例未运行' };
  }

  /** 目录项 ← 实例域状态对齐（heartbeat 监督拍后调用）：实例已删 → 注销（防死登记）；
   *  实例存在 → desired/guardian/name/ownership 经 _managedSandboxSpec 申报，phase 落目录唯一词表。 */
  _syncSandboxRegistryEntry(entry) {
    if (!entry || !this.managedObjects || !this.instances) return;
    if (this.managedObjects.get(entry.id) !== entry) return; // 条目已被替换/注销
    const inst = (this.instances.instances || []).find((i) => i.id === entry.id);
    if (!inst) {
      this._unregisterManaged(entry.id); // 实例已不存在：目录注销（heartbeat 不再空转）
      return;
    }
    try { this._upsertManaged(this._managedSandboxSpec(inst)); } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox upsert: ' + ((e && e.message) || e)); }
    const map = { STOPPED: 'stopped', INSTALLING: 'installing', STARTING: 'starting', RUNNING: 'running', BACKOFF: 'backoff', FAILED: 'failed' };
    const ph = map[(inst.state && inst.state.phase) || 'STOPPED'] || 'stopped';
    try {
      if (entry.phase !== ph) this.managedObjects.setPhase(entry.id, ph);
    } catch (e) { this.logger && this.logger.warn && this.logger.warn('sandbox setPhase: ' + ((e && e.message) || e)); }
  }

  /** 唯一心跳驱动的 daemon 监督单拍（v3 R3 C3-2）：
   *  router/lan-daemon 的「期望运行 + 失联守护拉起」，由 ManagedRegistry.heartbeat 经 adapter 调用
   *  （节流≈30s，与原 L3 监督 tick 等价）。守卫重启不影响 daemon（进程独立）。
   *  @returns {ok:boolean} daemon 当前在线（heartbeat 统一写入目录实然）。 */
  async _daemonSuperviseOnce(kind) {
    if (this._stopping) return { ok: false };
    // INV-S1 全域（契约 §3.3）：会话退出中/已退出 → 不再监督拉起 router/lan daemon。
    if (this._sessionHalting()) return { ok: false, error: 'session halting' };
    try {
      if (kind === 'router') {
        const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
        const wantRunning = this.config.routerAutostart === true || (rlc && rlc.desired === 'running');
        if (!wantRunning) return { ok: this._routerDaemonActive() };
        if (!this._daemonManaged()) return { ok: this._routerDaemonActive() }; // 异主隔离：监督不介入
        // 代际分类（DaemonLifecycle.classify）：识别「ctl 被外部/异代际进程占用」的 external 情形——
        // 原路径只按 cmdline 判 active，无法区分本守卫 daemon 与外部同名 daemon（classify 接线，2026-09）。
        const rlcx = this._daemonLifecycle('router');
        if (rlcx && typeof rlcx.classify === 'function') {
          const c = rlcx.classify();
          if (c && c.mode === 'external') {
            this.logger && this.logger.warn && this.logger.warn('[router] 监督：ctl ' + this._routerCtlPort() + ' 被外部进程占用（pid=' + c.owner + '），不接管不拉起');
            this._guardianEvent('router', 'external', { owner: c.owner });
            return { ok: false };
          }
        }
        if (this._routerDaemonActive()) {
          try { this._syncRouterLifecycleView({ ok: true }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          // R4 域摘要入目录（黑盒摘要引用，只读缓存；拉取失败仅降级——不影响监督）
          try {
            if (this.routerDaemonActive() && this.managedObjects) {
              const s = await this.routerApi().domainSummary();
              const e = this.managedObjects.get('router-daemon');
              if (e && s && typeof s === 'object') {
                e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
              }
            }
          } catch (e2) { this.logger && this.logger.debug && this.logger.debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
          return { ok: true };
        }
        if (rlc && rlc.guardian !== true) {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联但守护开关关闭，不自动拉起（仅观测）');
          this._guardianEvent('router', 'skip-guardian-off');
          return { ok: false };
        }
        if (rlc) rlc.restartCount = (rlc.restartCount || 0) + 1;
        const rt = this._ensureRouterRuntime(true);
        if (rt.mode === 'daemon' && rt.spawned) {
          this.events.append('router_daemon_supervised', { pid: rt.spawned });
          this._guardianEvent('router', 'pull', { pid: rt.spawned });
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督：router-daemon 失联，已重新拉起 pid=' + rt.spawned);
          if (rlc) { rlc._setPhase('starting'); }
          setTimeout(() => {
            const up = pidlook.findListeningPid(this._routerCtlPort());
            try { this._syncRouterLifecycleView({ ok: !!up, error: up ? null : 'router-daemon 拉起后未就绪' }); } catch (e) { this.logger && this.logger.warn && this.logger.warn('router view sync: ' + (e && e.message)); }
          }, 3000);
        } else if (rt.mode === 'error') {
          if (this.logger && this.logger.warn) this.logger.warn('[router] 监督拉起失败: ' + (rt.error || '未知'));
        }
        return { ok: false };
      }
      // kind === 'lan'
      if (!this.lanDaemonEnabled()) return { ok: this._lanDaemonActive() };
      this._syncLanState();
      const activeNow = this._lanDaemonActive();
      if (activeNow) return { ok: true };
      const entry = (this.managedObjects && typeof this.managedObjects.get === 'function') ? this.managedObjects.get('lan-daemon') : null;
      if (entry && entry.guardian !== true) {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督：lan-daemon 失联但守护开关关闭，不自动拉起（仅观测）');
        this._guardianEvent('lan', 'skip-guardian-off');
        return { ok: false };
      }
      if (entry) entry.restartCount = (entry.restartCount || 0) + 1;
      const rt = this._ensureLanRuntime(true);
      if (rt.mode === 'daemon' && rt.spawned) {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督：lan-daemon 失联，已重新拉起 pid=' + rt.spawned);
        this._guardianEvent('lan', 'pull', { pid: rt.spawned });
      } else if (rt.mode === 'error') {
        if (this.logger && this.logger.warn) this.logger.warn('[lan] 监督拉起失败: ' + (rt.error || '未知'));
      }
      return { ok: false };
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('[' + kind + '] 监督异常: ' + (e && e.message));
      return { ok: false };
    }
  }


  // ---- 远程控制委托：全部转发给 LanManager（system-services/relay/manager.js）----
  // L3b：daemon 监督模式 → 经 43108 ctl 委托（异步）；本地模式 → LanManager（同步）
  // 令牌收敛（2026-09）：listLan 输出剔除 token/dshToken——
  // /lan-access 允许 LAN/私网 Host 访问，直出 dshToken 会把 DSH 会话令牌泄漏给局域网；
  // 权威仍在 DshTokenService（relay 经 tokenOf 内部读取，无需经此透传）。返回形如 {items,addresses}。
  listLan() {
    // 白名单外显（2026-09 可诊断层）：只放行结构字段与注入状态 inject；任何令牌字段都不外传。
    const sanitize = (r) => {
      if (!r || !r.items) return r;
      return { items: r.items.map((it) => {
        const out = {
          id: it.id, name: it.name, dshPort: it.dshPort, wanPort: it.wanPort,
          enabled: !!it.enabled, localPort: it.localPort || null, running: !!it.running,
          // FRP 修复：公网暴露状态（非机密）必须过白名单，否则 UI 无法呈现开关与远端端口。
          frpEnabled: it.frpEnabled === true,
          frpRemotePort: it.frpRemotePort || null,
          // 令牌**状态**（布尔，不泄明文）——公网暴露的安全闸要求已设令牌，UI 据此引导。
          tokenSet: !!String(it.token || '').trim(),
        };
        if (it.inject) {
          out.inject = {
            tokenSet: !!it.inject.tokenSet,
            cookieReady: !!it.inject.cookieReady,
            lastOkAt: it.inject.lastOkAt || null,
            lastError: it.inject.lastError || null,
            lastErrorAt: it.inject.lastErrorAt || null,
          };
        }
        return out;
      }), addresses: r.addresses || [] };
    };
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('list').then(sanitize).catch(() => ({ items: [], addresses: [] }));
    try { return sanitize(this.lan.list()); } catch { return { items: [], addresses: [] }; }
  }

  setLanFrp(id, frpEnabled, frpRemotePort) {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('setFrp', [id, frpEnabled, frpRemotePort]);
    return this.lan.setFrp(id, frpEnabled, frpRemotePort);
  }

  frpStatus() {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('frpStatus');
    return this.lan.frpStatus();
  }
  lanFrpc(action, body) {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) return this._lanCtlCall('frpAction', [action, body]);
    return this.lan.frpAction(action, body);
  }

  syncFrpc() {
    if (this.lanDaemonEnabled() /* daemon 启用即 ctl */) { this._lanCtlCall('syncFrpc').catch(() => {}); return; }
    this.lan.syncFrpc();
  }
  // ---- 智能路由开关管理 ----
  async setRouterRunning(on) {
    // 统一生命周期视图同步：router 启停状态镜像到 lifecycleManager（归一化：启停路径收敛）
    const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (on) {
      // L3：优先独立 router-daemon（detached，守卫重启不影响）；daemon 不可用退回内嵌
      const rt = this._ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        this.config.routerAutostart = true;
        this.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting'); /* healthy 由 _supervise mirror 观测置位 */ }
        return { ok: true, mode: rt.mode, ...this.routerStatus() };
      }
      const r = await this.router.start();
      this.config.routerAutostart = true;
      this.persistConfigPatch({ routerAutostart: true });
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; } /* healthy 由 _supervise mirror 观测置位 */ }
      return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...this.routerStatus() };
    }
    // 停止：若 daemon 在跑 → 停 daemon；否则停内嵌 router
    const rt = this._ensureRouterRuntime(false);
    if (rt.mode === 'daemon' && rt.stopping) {
      this.config.routerAutostart = false;
      this.persistConfigPatch({ routerAutostart: false });
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
      return { ok: true, mode: 'daemon', ...this.routerStatus() };
    }
    const r = this.router.stop();
    this.config.routerAutostart = false;
    this.persistConfigPatch({ routerAutostart: false });
    if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
    return { ok: r.ok !== false, already: !!r.already, mode: 'embedded', ...this.routerStatus() };
  }

  routerStatus() {
    const st = this.router.status();
    return { running: !!st.running, autostart: this.config.routerAutostart === true, ...st };
  }

  /** R4 域摘要（目录合成视图）：daemon 监督模式 → 目录 router-daemon 项 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式 → 本地 RouterService 实时摘要。 */
  routerDomainSummary() {
    if (this.routerDaemonActive()) {
      try {
        const e = this.managedObjects && typeof this.managedObjects.get === 'function' ? this.managedObjects.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const s = this.router && typeof this.router.domainSummary === 'function' ? this.router.domainSummary() : null;
      return { ok: true, source: 'embedded', summary: s };
    } catch (e2) {
      return { ok: false, source: 'embedded', error: (e2 && e2.message) || String(e2) };
    }
  }

  /** router 生命周期视图同步（C3-5b：取代旧观测镜像层——视图数据并入目录/本拍实然）。
   *  契约：desired 只表达「应运行」（由启停动作设置）；healthy/error/lastProbeAt 只由真实观测写入；
   *  phase 收敛为守卫视角期望视图（desired=running→running；stopped→stopped）。
   *  红线：不读取/不写入 router 业务状态（回收/切换/预热/冻结仍归资源自治）。
   *  @param o { ok?:boolean, error?:string } 本拍实然（缺省回退目录 router-daemon lastObserved） */
  _syncRouterLifecycleView(o) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (!lc) return;
    const e = (this.managedObjects && typeof this.managedObjects.get === 'function') ? this.managedObjects.get('router-daemon') : null;
    const ob = (e && e.lastObserved) || null;
    const ok = !!(o && o.ok !== undefined) ? !!(o && o.ok) : !!(ob && ob.ok);
    const err = (o && o.error !== undefined) ? o.error : ((ob && ob.error) || 'router-daemon 未就绪');
    const at = (o && o.at) || (ob && ob.at) || new Date().toISOString();
    const wantRunning = lc.desired === 'running' || lc._monitoring === true;
    lc.lastProbeAt = at;
    if (!wantRunning) {
      // 期望停止：phase=stopped、healthy=false（观测无意义）
      if (lc.phase !== 'stopped') lc._setPhase('stopped');
      lc.healthy = false;
      return;
    }
    // ⚠ phase 必须反映**观测到的 ok**，不能无条件置 running（2026-09-11 修复，与 K4 同族）：
    //   旧实现无论 ok 与否都 _setPhase('running') ——
    //   于是 daemon 还没就绪时面板显示「运行中」，与 healthy=false 自相矛盾。
    //   现：ok → running；未 ok 且从未 running 过 → starting（拉起中，不谎报）；
    //       曾 running 则保持 running 相位（进程可能仍在，只是探活失败）。
    if (ok) {
      if (lc.phase !== 'running') lc._setPhase('running');
      lc.error = null;
    } else if (lc.phase !== 'running') {
      if (lc.phase !== 'starting') lc._setPhase('starting');
      lc.error = err;
    } else {
      lc.error = err;
    }
    lc.healthy = ok;
  }

  /** instances 聚合视图真实化（C3-5b）：lifecycle 的 instances 项表示「实例管理服务」（驻守卫进程，
   *  恒 running/healthy），不再是无观测的死登记。每心跳刷新一次（_dshSuperviseOnce 调用）。 */
  _syncInstancesLifecycleView() {
    const lc = this.lifecycleManager ? this.lifecycleManager.get('instances') : null;
    if (!lc) return;
    lc.wantRunning();
    lc._monitoring = true;
    lc.healthy = true;
    lc.error = null;
    lc.lastProbeAt = new Date().toISOString();
    if (lc.phase !== 'running') {
      lc._setPhase('running');
      lc.startedAt = lc.startedAt || new Date().toISOString();
    }
  }

  /** 守护动作事件（阶段四，事件脊）：统一记录守护决策/动作，带资源关联键，供审计回放。
   *   action: pull(拉起) | skip-guardian-off(守护关闭仅观测)。只读统一状态机 restartCount，不碰业务。 */
  _guardianEvent(resource, action, extra) {
    const lc = this.lifecycleManager ? this.lifecycleManager.get(resource) : null;
    const e = Object.assign({ resource, action }, extra || {});
    if (lc) e.restartCount = lc.restartCount || 0;
    if (this.events && this.events.append) { try { this.events.append('guardian_action', e); } catch (err) { this.logger && this.logger.warn && this.logger.warn('guardian_action event: ' + (err && err.message)); } }
    return e;
  }



}

const _desc = Object.getOwnPropertyDescriptors(ControlView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
