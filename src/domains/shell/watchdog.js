'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 桌面壳看护（Shell Watchdog）—— 2026-09-11
//
// ## 为什么由守卫做
//
// 产品意图：**壳关不掉**（关窗=隐藏到托盘；「退出管家」=停止全部服务链）。
// 故壳只有在**崩溃**时才会在没有停服务的情况下消失。
//
// 而壳无法监督自己 —— 它的监督者会随它一起死。
// 守卫是抗重启的那个（systemd Restart=always / launchd KeepAlive / schtasks Watchdog），
// 且**已在读取** `~/.dsh/shell/identity.json`、**已实现** `restartShell()`。
// 故由守卫承担壳看护，且**三平台一套机制**、无需新增服务定义。
//
// ## 修复的历史缺口
//
// 修复前：Linux ❌ 无任何壳自愈（仅 XDG 登录自启）；macOS ❌ 完全没有；
//          Windows ⚠️ 有 watchdog 但壳检查被嵌在 `if (-not $up)` 内，
//          「壳崩、守卫活」时整块跳过 —— 而那恰是唯一需要它的场景。
//
// ## 设计要点
//
// 1. **只在壳确实缺失时动作**（以进程实际存在为准，不以文件/心跳推断）；
// 2. **宽限期**：连续缺失达阈值才拉起 —— 避让壳自更新/自重启的瞬时空窗；
// 3. **预期缺席延长宽限**：壳上报 `restarting` / `shell-update-*` / 有未确认的更新账本时，
//    用更长的宽限（否则会在安装过程中抢跑）；
// 4. **必须有图形会话**：Linux 注销后守卫经 linger 仍在运行，
//    此时拉起 GUI 必然失败并造成重启风暴 —— 无会话则跳过（待会话恢复自动继续）；
// 5. **有界重试**：窗口内上限，防「壳起不来」变成无限风暴；
// 6. **决策是纯函数**（`decide()`）：可脱离进程/时钟/文件系统单测。
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  enabled: true,
  intervalMs: 20000,        // 检查周期
  graceMs: 90000,           // 壳缺失多久才动作（避让自更新/自重启空窗）
  updateGraceMs: 300000,    // 壳正处于更新/重启预期态时的宽限（5 分钟）
  maxRestarts: 5,           // 窗口内拉起次数上限
  windowMs: 1800000,        // 30 分钟窗口
  procPattern: 'dsh-supervisor-gui',
};

/** 判定一个进程是否**桌面壳主程序**（而非本仓的无头自检进程）。 */
function isShellProcess(proc) {
  const c = String((proc && proc.cmdline) || '');
  // 无头自检入口会同时匹配进程名，必须排除 —— 否则看护会把自检当成壳。
  if (/--shell-update-plan|--core-plan|--node-plan|--mirror-plan|--env-plan|--service-plan/.test(c)) return false;
  return /dsh-supervisor-gui(\.exe)?/.test(c);
}

/**
 * 纯决策函数（不碰进程/时钟/文件系统 —— 便于穷举单测）。
 *
 * @param {object} i
 *   - alive            壳进程数（>0 视为存活）
 *   - absentForMs      已连续缺失多久（alive=false 时有效；null = 首次发现缺失）
 *   - expectedAbsence  壳是否处于「预期缺席」（自更新/重启中/更新待确认）
 *   - sessionAvailable 当前是否有图形会话
 *   - restartsInWindow 窗口内已拉起次数
 *   - hasExe           能否定位壳可执行文件
 *   - config           { graceMs, updateGraceMs, maxRestarts }
 * @returns {{action:'alive'|'record'|'wait'|'skip'|'restart', reason:string, needMs?:number}}
 */
function decide(i) {
  const c = i.config || {};
  if (i.alive > 0) return { action: 'alive', reason: '壳在运行' };
  if (i.absentForMs === null || i.absentForMs === undefined) {
    return { action: 'record', reason: '首次观察到壳缺失，开始计时' };
  }
  const needMs = i.expectedAbsence
    ? (c.updateGraceMs || DEFAULTS.updateGraceMs)
    : (c.graceMs || DEFAULTS.graceMs);
  if (i.absentForMs < needMs) {
    return { action: 'wait', reason: i.expectedAbsence ? '壳处于预期缺席（更新/重启）' : '未达宽限期', needMs };
  }
  if (!i.sessionAvailable) {
    return { action: 'skip', reason: '无图形会话（注销/纯终端），拉起 GUI 必失败' };
  }
  if ((i.restartsInWindow || 0) >= (c.maxRestarts || DEFAULTS.maxRestarts)) {
    return { action: 'skip', reason: '窗口内拉起次数已达上限，停止重试（防风暴）' };
  }
  if (!i.hasExe) {
    return { action: 'skip', reason: '无法定位壳可执行文件（identity.json 未记录 exe）' };
  }
  return { action: 'restart', reason: '壳缺失且已过宽限期', needMs };
}

/**
 * 创建壳看护实例。
 *
 * @param {object} deps
 *   - shell     domains/shell（identity / readJournal / restartShell）
 *   - pidlookup platform/os/pidlookup（pgrepList）
 *   - desktop   platform/os/desktop（sessionAvailable / describe）
 *   - logger / events / config
 *   - now       注入时钟（测试用）
 */
function createShellWatchdog(deps) {
  const o = deps || {};
  const shell = o.shell;
  const pidlookup = o.pidlookup;
  const desktop = o.desktop;
  const logger = o.logger || console;
  const events = o.events || null;
  const config = o.config || {};
  const now = o.now || (() => Date.now());
  const procPattern = config.shellProcPattern || DEFAULTS.procPattern;

  let missingSince = null;
  let restarts = [];
  let busy = false;
  let lastSkipReason = null;
  let everSawAlive = false;

  const log = (m) => { try { logger.info && logger.info('[shell-watchdog] ' + m); } catch {} };
  const warn = (m) => { try { logger.warn && logger.warn('[shell-watchdog] ' + m); } catch {} };

  function shellProcs() {
    let procs = [];
    try { procs = pidlookup.pgrepList(procPattern) || []; } catch { procs = []; }
    return procs.filter(isShellProcess);
  }

  /** 壳是否处于「预期缺席」：自更新/重启中，或有未确认的更新账本。 */
  function expectedAbsence() {
    let phase = '';
    try { const id = shell.identity(); phase = String((id && id.phase) || ''); } catch {}
    if (phase === 'restarting' || phase.indexOf('shell-update') === 0) return true;
    try {
      const j = shell.readJournal && shell.readJournal();
      if (j && j.to && !j.confirmed && !j.rolledBack) return true;
    } catch {}
    return false;
  }

  function exePath() {
    if (config.shellExePath) return config.shellExePath;
    try { const id = shell.identity(); return (id && id.exe) || null; } catch { return null; }
  }

  async function tick() {
    if (config.shellWatchdog === false) return { skipped: 'disabled' };
    if (busy) return { skipped: 'busy' };
    busy = true;
    try {
      const t = now();
      const procs = shellProcs();
      const alive = procs.length;
      if (alive > 0 && !everSawAlive) { everSawAlive = true; log('已观测到桌面壳在运行（pid=' + procs[0].pid + '）'); }
      const absentForMs = alive > 0 ? null : (missingSince === null ? null : (t - missingSince));
      const expected = absentForMs === null ? false : expectedAbsence();
      const exe = exePath();
      restarts = restarts.filter((x) => t - x < (config.shellWatchdogWindowMs || DEFAULTS.windowMs));

      const d = decide({
        alive, absentForMs, expectedAbsence: expected,
        sessionAvailable: desktop.sessionAvailable(),
        restartsInWindow: restarts.length,
        hasExe: !!exe,
        config: {
          graceMs: config.shellWatchdogGraceMs || DEFAULTS.graceMs,
          updateGraceMs: config.shellWatchdogUpdateGraceMs || DEFAULTS.updateGraceMs,
          maxRestarts: config.shellWatchdogMaxRestarts || DEFAULTS.maxRestarts,
        },
      });

      if (d.action === 'alive') { missingSince = null; lastSkipReason = null; return { alive }; }
      if (d.action === 'record') {
        missingSince = t;
        log('桌面壳缺失，开始计时（宽限 ' + Math.round((config.shellWatchdogGraceMs || DEFAULTS.graceMs) / 1000) + 's）');
        return { absent: true };
      }
      if (d.action === 'wait') { lastSkipReason = d.reason + '（' + Math.round(absentForMs / 1000) + 's/' + Math.round(d.needMs / 1000) + 's）'; return { waiting: d.reason }; }
      if (d.action === 'skip') {
        if (lastSkipReason !== d.reason) { lastSkipReason = d.reason; warn('不拉起桌面壳：' + d.reason); }
        return { skipped: d.reason };
      }

      // action === 'restart'
      restarts.push(t);   // 记账 **在尝试前**：失败同样计入上限，防失败风暴
      const r = await shell.restartShell({ exePath: exe, procPattern });
      if (r && r.ok) {
        if (events) events.append('shell_watchdog_restart', { pid: r.pid, exe: r.exe, absentMs: absentForMs });
        log('桌面壳缺失 ' + Math.round(absentForMs / 1000) + 's，已拉起 pid=' + r.pid + ' exe=' + r.exe);
        missingSince = null;   // 重新观察；若仍未起来，下一轮重新计时
      } else {
        if (events) events.append('shell_watchdog_restart_failed', { error: (r && r.error) || '未知', absentMs: absentForMs });
        warn('拉起桌面壳失败：' + ((r && r.error) || '未知'));
      }
      return { restarted: !!(r && r.ok), error: (r && r.error) || null };
    } catch (e) {
      warn('看护异常：' + ((e && e.message) || e));
      return { error: (e && e.message) || String(e) };
    } finally { busy = false; }
  }

  /** 观测快照（供 /env/status 或诊断）。 */
  function status() {
    const t = now();
    let session = { available: null, reason: null };
    try { session = desktop.describe(); } catch {}
    return {
      enabled: config.shellWatchdog !== false,
      intervalMs: config.shellWatchdogIntervalMs || DEFAULTS.intervalMs,
      graceMs: config.shellWatchdogGraceMs || DEFAULTS.graceMs,
      updateGraceMs: config.shellWatchdogUpdateGraceMs || DEFAULTS.updateGraceMs,
      maxRestarts: config.shellWatchdogMaxRestarts || DEFAULTS.maxRestarts,
      absentForMs: missingSince === null ? null : (t - missingSince),
      restartsInWindow: restarts.filter((x) => t - x < (config.shellWatchdogWindowMs || DEFAULTS.windowMs)).length,
      everSawAlive,
      lastSkipReason,
      session,
      expectedAbsence: expectedAbsence(),
    };
  }

  /** 仅供测试：重置内部状态。 */
  function _reset() { missingSince = null; restarts = []; busy = false; lastSkipReason = null; everSawAlive = false; }

  return { tick, status, _reset, intervalMs: config.shellWatchdogIntervalMs || DEFAULTS.intervalMs };
}

module.exports = { createShellWatchdog, decide, isShellProcess, DEFAULTS };