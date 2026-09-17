'use strict';

// 桌面壳看护：由守卫承担壳自愈。壳无法监督自己（其监督者会随它一起死），而守卫是
// 抗重启的那个（systemd Restart=always / launchd KeepAlive / schtasks Watchdog），
// 三平台一套机制。
// 设计要点：
// 1. 只在壳确实缺失时动作（以进程实际存在为准，不以文件/心跳推断）；
// 2. 宽限期：连续缺失达阈值才拉起，避让壳自更新/自重启的瞬时空窗；
// 3. 预期缺席（restarting / shell-update-* / 未确认更新账本）用更长宽限；
// 4. 无图形会话则跳过（Linux 注销后经 linger 仍在运行，拉起 GUI 必失败成风暴）；
// 5. 窗口内有界重试，防无限风暴；6. decide() 是纯函数，可脱离进程/时钟/fs 单测。
// 纯决策（DEFAULTS/decide/isShellProcess/isUpdatePhase）在 core.js；本文件只保留有状态看护。
const { DEFAULTS, decide, isShellProcess, isUpdatePhase } = require('./core');

/**
 * 创建壳看护实例。
 * deps: { shell(identity/readJournal/restartShell), pidlookup(pgrepList),
 *         desktop(sessionAvailable/describe), logger, events, config, now(注入时钟) }
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
  // P2：相位时效跟踪（由 tick 维护，见 updatePhaseTracking）
  let expectedSince = null;
  let phaseStale = false;
  let phaseStaleWarned = false;

  const log = (m) => { try { logger.info && logger.info('[shell-watchdog] ' + m); } catch {} };
  const warn = (m) => { try { logger.warn && logger.warn('[shell-watchdog] ' + m); } catch {} };

  function shellProcs() {
    let procs = [];
    try { procs = pidlookup.pgrepList(procPattern) || []; } catch { procs = []; }
    return procs.filter(isShellProcess);
  }

  /** 相位跟踪（由 tick 每拍调用；expectedAbsence 是只读快照，不能带副作用）。
   *  phase 只由壳写入，唯一复位点是壳成功启动；壳更新中途崩溃且不再起来会让 phase
   *  永久停在 shell-update-* 或 restarting，使宽限永远走 5min、自愈被拖慢。
   *  故进入更新相位即计时，超过 phaseMaxAgeMs（默认 10 分钟）视为陈旧，不再延长宽限；
   *  离开该相位即复位。用看护自己的时钟而非 identity 文件 mtime：identity 在测试里是
   *  注入桩，且壳的 set_phase() 只写 phase、不写 lastSeenAt。
   */
  function updatePhaseTracking(t) {
    let phase = "";
    try { const id = shell.identity(); phase = String((id && id.phase) || ""); } catch {}
    const inUpdate = isUpdatePhase(phase);
    if (!inUpdate) { expectedSince = null; phaseStale = false; return; }
    if (expectedSince === null) expectedSince = t;
    const maxAge = config.shellWatchdogPhaseMaxAgeMs || DEFAULTS.phaseMaxAgeMs;
    phaseStale = (t - expectedSince) >= maxAge;
    if (phaseStale && !phaseStaleWarned) {
      phaseStaleWarned = true;
      warn("identity.phase 停留过久（" + Math.round((t - expectedSince) / 1000) + "s > " + Math.round(maxAge / 1000) + "s），判定为陈旧；不再延长宽限");
    }
  }

  /** 壳是否处于预期缺席：更新/重启相位（且未陈旧）或有未确认的更新账本。 */
  function expectedAbsence() {
    let phase = '';
    try { const id = shell.identity(); phase = String((id && id.phase) || ''); } catch {}
    const inUpdate = isUpdatePhase(phase);
    if (inUpdate && !phaseStale) return true;
    try {
      const j = shell.readJournal && shell.readJournal();
      if (j && j.to && !j.confirmed) return true;
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
      // 每拍都跟踪相位（不只缺失时），否则陈旧判定要多等一轮，且存活期相位变化无法复位计时。
      updatePhaseTracking(t);
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
      restarts.push(t);   // 记账在尝试前：失败同样计入上限，防失败风暴
      const r = await shell.restartShell({ exePath: exe, procPattern });
      if (r && r.ok) {
        if (events) events.append('shell_watchdog_restart', { pid: r.pid, exe: r.exe, absentMs: absentForMs });
        log('桌面壳缺失 ' + Math.round(absentForMs / 1000) + 's，已拉起 pid=' + r.pid + ' exe=' + r.exe);
        missingSince = null;   // 重新观察；若仍未起来，下轮重新计时
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
  function _reset() { missingSince = null; restarts = []; busy = false; lastSkipReason = null; everSawAlive = false; expectedSince = null; phaseStale = false; phaseStaleWarned = false; }

  return { tick, status, _reset, intervalMs: config.shellWatchdogIntervalMs || DEFAULTS.intervalMs };
}

module.exports = { createShellWatchdog };
