'use strict';

// 桌面壳看护：由守卫承担壳自愈。壳无法监督自己（其监督者会随它一起死），而守卫是
// 抗重启的那个（systemd Restart=always / launchd KeepAlive / schtasks Watchdog），
// 三平台一套机制。
// 设计要点：
// 1. 只在壳确实缺失时动作（以进程实际存在为准，不以文件/心跳推断）；
// 2. 宽限期：连续缺失达阈值才拉起，避让壳自更新/自重启的瞬时空窗；
// 3. 预期缺席（restarting / shell-update-* / 未确认更新账本）用更长宽限；
// 4. 无图形会话则跳过（Linux 注销后经 linger 仍在运行，拉起 GUI 必失败成风暴）；
// 5. 窗口内有界重试，防无限风暴；6. decide() 是纯函数，可脱离进程/时钟/fs 单测；
// 7. **会话退出中/已退出（INV-S1）恒不动作**——退出的语义就是「不再拉起」（2026-09-18 修：
//    原实现只判壳缺失、不看会话态，导致「退出管家」后守卫多活一拍即把壳拉回）。
// 纯决策（DEFAULTS/decide/isShellProcess/isUpdatePhase）在 core.js；本文件只保留有状态看护。
const { DEFAULTS, decide, isShellProcess, isUpdatePhase } = require('./core');

/**
 * 创建壳看护实例。
 * deps: { shell(identity/readJournal/restartShell), pidlookup(pgrepList),
 *         desktop(sessionAvailable/describe), logger, events, config, now(注入时钟),
 *         halted(退出中/已退出谓词), onShellAlive(观测到壳在线回调) }
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
  let expectedSince = null;
  let phaseStale = false;
  let phaseStaleWarned = false;
  let journalStale = false;
  let journalStaleWarned = false;

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
    if (!inUpdate) { expectedSince = null; phaseStale = false; phaseStaleWarned = false; return; }
    if (expectedSince === null) expectedSince = t;
    const maxAge = config.shellWatchdogPhaseMaxAgeMs || DEFAULTS.phaseMaxAgeMs;
    phaseStale = (t - expectedSince) >= maxAge;
    if (phaseStale && !phaseStaleWarned) {
      phaseStaleWarned = true;
      warn("identity.phase 停留过久（" + Math.round((t - expectedSince) / 1000) + "s > " + Math.round(maxAge / 1000) + "s），判定为陈旧；不再延长宽限");
    }
  }

  /** 更新账本时效跟踪（由 tick 每拍调用，与 updatePhaseTracking 对称）。
   *  账本只由壳侧上报（journal.js markPending）写入，`startedAt` 是**唯一**时间戳（ISO 串）；
   *  `lastAttemptAt` 只在默认形状里声明、全仓无写入点，不可依赖。
   *  壳 pending 后一直不回来确认时 j.to 会永久留着，只看 j.to 会让宽限永远走 updateGraceMs
   *  （自愈被拖慢），故超过 phaseMaxAgeMs 即判陈旧、不再据此延长宽限（并 warn 一次）。
   *  ⚠ 无法解析 `startedAt` 时按「未陈旧」处理：既有测试（watchdog-phase-freshness N-d）
   *    用无 startedAt 的账本桩锁定「未确认账本 → 预期缺席」语义，不得改变该行为。 */
  function updateJournalTracking(t) {
    let j = null;
    try { j = shell.readJournal && shell.readJournal(); } catch {}
    if (!j || !j.to || j.confirmed) { journalStale = false; journalStaleWarned = false; return; }
    const t0 = Date.parse(String(j.startedAt || ''));
    if (!Number.isFinite(t0)) { journalStale = false; return; }
    const maxAge = config.shellWatchdogPhaseMaxAgeMs || DEFAULTS.phaseMaxAgeMs;
    journalStale = (t - t0) >= maxAge;
    if (journalStale && !journalStaleWarned) {
      journalStaleWarned = true;
      warn('更新账本未确认已超 ' + Math.round((t - t0) / 1000) + 's（> ' + Math.round(maxAge / 1000) + 's），判定为陈旧；不再据此延长宽限');
    }
  }

  /** 壳是否处于预期缺席：更新/重启相位（且未陈旧）或有**未过时效**的未确认更新账本。
   *  只读快照：账本时效由 updateJournalTracking 每拍算好，本函数不得产生副作用。 */
  function expectedAbsence() {
    let phase = '';
    try { const id = shell.identity(); phase = String((id && id.phase) || ''); } catch {}
    const inUpdate = isUpdatePhase(phase);
    if (inUpdate && !phaseStale) return true;
    try {
      const j = shell.readJournal && shell.readJournal();
      // journalStale 由每拍更新；陈旧账本不再算「预期缺席」，让看护按正常宽限介入。
      if (j && j.to && !j.confirmed) return !journalStale;
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
      // ⚠ 2026-09-18 修（严重缺陷：退出管家后自动重启）——门**下沉到看护域**：
      //   任何 tick 调用者（bootstrap 定时器/诊断/未来接线）都受同一门约束。
      //   ① 壳已在线 -> 先清除持久退出标记（用户重新打开了壳，自愈恢复）；
      //   ② 退出中/已退出（INV-S1）-> 恒不动作。
      if (alive > 0 && typeof o.onShellAlive === 'function') { try { o.onShellAlive(); } catch {} }
      if (typeof o.halted === 'function' && o.halted()) {
        lastSkipReason = '会话退出中/用户已退出（不拉起）';
        return { skipped: 'halted', reason: lastSkipReason };
      }
      if (alive > 0 && !everSawAlive) { everSawAlive = true; log('已观测到桌面壳在运行（pid=' + procs[0].pid + '）'); }
      const absentForMs = alive > 0 ? null : (missingSince === null ? null : (t - missingSince));
      // 每拍都跟踪相位（不只缺失时），否则陈旧判定要多等一轮，且存活期相位变化无法复位计时。
      updatePhaseTracking(t);
      updateJournalTracking(t);
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
      const r = await shell.restartShell({
        exePath: exe, procPattern,
        // 在飞复判（K4）：杀旧壳与 spawn 之间有 ~8s 窗口，退出请求可能在窗口内到达。
        shouldAbort: (typeof o.halted === 'function') ? () => o.halted() : undefined,
      });
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

  return { tick, status, intervalMs: config.shellWatchdogIntervalMs || DEFAULTS.intervalMs };
}

module.exports = { createShellWatchdog };
