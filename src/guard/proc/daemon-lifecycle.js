'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 受管进程生命周期核心（2026-09-04 架构定稿，docs/lifecycle-unified-process-management.md）
//
// 统一不变量（router-daemon / lan-daemon / 未来一切受管常驻进程共用）：
//   1) 一个逻辑服务 = 一个受管进程（单实例）；
//   2) 服务与绑定端口持久（注册表 truth；本层不碰端口分配，只保证换代期间「端口先释放后复用」）；
//   3) 换代（replace）必须：TERM 旧代 → 验证旧进程已死 → 验证端口已释放 → 才 spawn 新代；
//      旧没死透/端口没放 → 绝不起新（此前双代并存→端口漂移的根因在此被硬性杜绝）；
//   4) spawn 一次性：spawn 后 latch 窗口内任何入口（启动/监督/手动）不得再 spawn；
//   5) 守卫重启 ≠ 服务重启：身份文件（{guardPid, daemonPid, startedAt}）让新守卫「接管」既有进程，
//      owner 连续，绝不另起一个；身份丢失/异主不接管（由上层门禁把关）。
//
// 与端口注册表的分工：注册表记录 owner→固定端口（由被管进程维护）；本层只对进程负责，
// 两者拼成完整链条 =「端口持久化成立的前提：进程换代先无后有」。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');

/** 轮询等待：某 pid 进程真正消失（/proc 确认）。 */
async function waitProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = false;
    try { alive = pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { alive = false; }
    if (!alive) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 轮询等待：端口可绑（无监听者）——用 bind 探测（与真实监听语义一致，见 infra/ports）。 */
async function portFree(port) {
  return new Promise((resolve) => {
    const net = require('node:net');
    let done = false;
    const s = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { s.close(); } catch {} resolve(ok); };
    s.once('error', () => finish(false));
    s.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function waitPortFree(port, timeoutMs) {
  if (!port) return true;
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

class DaemonLifecycle {
  /**
   * @param {object} o
   *  - name: 标识（'router' | 'lan'）
   *  - script / args: spawn 命令
   *  - ctlPort: 就绪/换代仲裁端口
   *  - cmdMark: cmdline 识别子串（防误接管异主）
   *  - identityFile: JSON {guardPid, daemonPid, startedAt}
   *  - spawnEnv(extra) / logger / events
   *  - readyTimeoutMs / stopGraceMs / portReleaseTimeoutMs / spawnWindowMs
   */
  constructor(o) {
    this.name = o.name;
    this.script = o.script;
    this.args = o.args || [];
    this.ctlPort = o.ctlPort;
    this.cmdMark = o.cmdMark;
    this.identityFile = o.identityFile;
    this.spawnEnv = o.spawnEnv || (() => ({}));
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.readyTimeoutMs = o.readyTimeoutMs || 10000;
    this.stopGraceMs = o.stopGraceMs || 4000;
    this.portReleaseTimeoutMs = o.portReleaseTimeoutMs || 5000;
    this.spawnWindowMs = o.spawnWindowMs || 25000;
    this._spawnWindowUntil = 0; // spawn latch
    this._stopping = false;
  }

  /* ── 身份文件（owner 连续的关键）── */
  _readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')); } catch { return null; }
  }
  _writeIdentity(daemonPid) {
    try {
      const dir = path.dirname(this.identityFile);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const tmp = this.identityFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ guardPid: process.pid, daemonPid, startedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, this.identityFile);
    } catch {}
  }
  _clearIdentity() { try { fs.unlinkSync(this.identityFile); } catch {} }

  _pidAlive(pid) {
    if (!pid) return false;
    try { return pidlook.isAlive ? !!pidlook.isAlive(pid) : true; } catch { return true; }
  }

  /** ctl 端口的监听者是否就是本服务进程（cmdline 匹配）。 */
  _ctlOwnerPid() {
    try {
      const pid = pidlook.findListeningPid(this.ctlPort);
      if (!pid) return null;
      const cmd = pidlook.readCmdline(pid) || '';
      return cmd.indexOf(this.cmdMark) >= 0 ? pid : null;
    } catch { return null; }
  }

  /** 当前「期望进程」= 身份文件里的 daemonPid（若还活着）。 */
  expectedPid() { const id = this._readIdentity(); return id && id.daemonPid ? id.daemonPid : null; }

  /** 回收非当前受管代际的旧代进程（2026-09 架构补齐：YAMA 下 /proc fd 对非祖先不可读，
   *  socket→pid 无法映射；改用 pgrep -af 读 cmdline（同 frpmgr 范式，跨平台/YAMA 免疫）——
   *  凡 cmdline 命中本 daemon（script+configPath 特征）且 pid ≠ 当前身份 pid/≠自己/≠ctl 属主，
   *  一律视为旧代残留，TERM 回收。任何上下文（含不可见命名空间）拉起的同 cmdline 旧代都会被清掉，
   *  「固定端口被看不见的旧代占用」从此不可能存活。@returns 回收数 */
  reclaimOrphans() {
    const { execFileSync } = require('node:child_process');
    // cfg = args 中 -c/--config 的值（生产 daemon 为 configPath，用于精确匹配防误杀其它实例/用户）；
    // 无 -c（如测试夹具/简化调用）→ cfg 为空 → 仅按 cmdMark 匹配（仍排除自己/受管代/ctl 属主）
    const args = this.args || [];
    let cfg = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--config') { cfg = String(args[i + 1] || ''); break; }
    }
    const marker = this.cmdMark;
    let killed = 0;
    try {
      const out = execFileSync('pgrep', ['-af', marker], { encoding: 'utf8', timeout: 3000 }).toString();
      const mine = this.expectedPid();
      const ctlOwner = this._ctlOwnerPid();
      for (const line of out.split(/\r?\n/)) {
        const m = /^(\d+)\s+(.*)$/.exec(line.trim());
        if (!m) continue;
        const pid = Number(m[1]);
        const cmd = m[2];
        if (pid === process.pid) continue;
        if (pid === mine) continue;             // 当前受管代际
        if (pid === ctlOwner) continue;         // ctl 属主（就是当前在管进程）
        if (cfg && cmd.indexOf(cfg) < 0) continue; // 必须同配置（防误杀其它用户/实例的同名 daemon）
        try { process.kill(pid, 'SIGTERM'); killed++; this.logger.warn && this.logger.warn('[' + this.name + '] 回收旧代孤儿 pid=' + pid + ' ' + cmd.slice(0, 90)); } catch {}
      }
    } catch (e) { /* pgrep 无匹配/不可用：忽略 */ }
    return killed;
  }

  /** 换代/启动仲裁总入口：
   *  - 期望 pid 活且 ctl 就绪 → {mode:'adopted', pid}
   *  - 无进程 → spawn（latch）→ {mode:'started', pid}
   *  - 期望 pid 死或失联 → replace（停残留→等死→等端口→spawn）→ {mode:'replaced', pid}
   *  - spawn latch 窗口内 → {mode:'barrier'} */
  ensureRunning() {
    if (this._stopping) return { mode: 'stopping' };
    try { this.reclaimOrphans(); } catch {}
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      // 期望进程在：等就绪（首次可能 ctl 未起）；直接认为在管（监督层再按 ctl 判 ready）
      return { mode: 'adopted', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    // 换代前：ctl 若仍被「本 cmdMark 的残留」占着 → TERM，等死 + 等端口释放；绝不起新
    const stale = this._ctlOwnerPid();
    if (stale) {
      this._stopPid(stale);
      this._spawnWindowUntil = Date.now() + 3000; // 短暂 latch：等旧代退出，下一轮仲裁走 spawn
      this.logger.warn && this.logger.warn('[' + this.name + '] 换代：旧代 pid=' + stale + ' 仍在 ' + this.ctlPort + '，已 TERM，稍后启新');
      return { mode: 'reclaiming', stale };
    }
    return this._spawn();
  }

  _stopPid(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, this.stopGraceMs).unref();
  }

  _spawn() {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [this.script, ...this.args], {
      stdio: 'ignore', detached: true, env: { ...process.env, ...(this.spawnEnv() || {}) },
    });
    child.unref();
    this._spawnWindowUntil = Date.now() + this.spawnWindowMs;
    this._writeIdentity(child.pid);
    if (this.logger && this.logger.info) this.logger.info('[' + this.name + '] 已拉起独立 daemon pid=' + child.pid + '（spawn 窗口至 ' + new Date(this._spawnWindowUntil).toISOString() + '）');
    return { mode: 'started', pid: child.pid };
  }

  /** 周期监督：期望进程失联 → 先验证死透再 replace（死透由 ensureRunning 的 stale/死pid 分支处理）。 */
  async superviseOnce() {
    if (!this.expectedPid()) { try { this.reclaimOrphans(); } catch {} }
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      // 期望进程在：仅当 ctl 也起来才算真正 in-service；否则等（ready 窗口内）
      const owner = this._ctlOwnerPid();
      if (owner && owner !== exp) {
        // ctl 被异进程占（罕见）：不接管不杀——报告 external
        return { mode: 'external', owner };
      }
      return { mode: 'running', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    const stale = this._ctlOwnerPid();
    if (stale) {
      // 期望 pid 已死但 ctl 仍被同 cmdMark 残留占着：停残留并等释放（换代）
      this._stopPid(stale);
      this._spawnWindowUntil = Date.now() + 3000;
      return { mode: 'reclaiming', stale };
    }
    if (!this._stopping) return this._spawn();
    return { mode: 'stopping' };
  }

  /** 停服：TERM → 等死 → 等 ctl 端口释放 → 清身份（绑定注册表由被管进程侧语义保留）。 */
  async stop() {
    this._stopping = true;
    const exp = this.expectedPid();
    let stopped = null;
    if (exp && this._pidAlive(exp)) { this._stopPid(exp); stopped = exp; }
    else {
      const owner = this._ctlOwnerPid();
      if (owner) { this._stopPid(owner); stopped = owner; }
    }
    if (stopped) {
      const dead = await waitProcessExit(stopped, this.stopGraceMs + 1500);
      if (!dead) this.logger.warn && this.logger.warn('[' + this.name + '] 停止超时 pid=' + stopped);
    }
    if (!(await waitPortFree(this.ctlPort, this.portReleaseTimeoutMs))) {
      this.logger.warn && this.logger.warn('[' + this.name + '] 停止后端口 ' + this.ctlPort + ' 未释放');
    }
    this._clearIdentity();
    return { ok: true, stopped };
  }

  status() {
    const id = this._readIdentity();
    const exp = (id && id.daemonPid) || null;
    return {
      name: this.name,
      pid: exp,
      alive: exp ? this._pidAlive(exp) : false,
      ctlUp: !!this._ctlOwnerPid(),
      since: (id && id.startedAt) || null,
      guardPid: (id && id.guardPid) || null,
      spawnWindow: this._spawnWindowUntil > Date.now(),
    };
  }
}

module.exports = { DaemonLifecycle };
