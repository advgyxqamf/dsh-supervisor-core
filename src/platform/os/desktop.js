'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台化「图形会话可用性」判定（2026-09-11）
//
// 用途：守卫看护桌面壳（domains/shell/watchdog）时，**必须先确认当前有图形会话**。
//
// 为什么必须有这一层：
//   Linux 上守卫经 `loginctl enable-linger` **在用户注销后仍运行**。
//   若在无图形会话时去拉起 GUI 壳，拉起必然失败，而看护会周期性重试 ——
//   结果是「重启风暴 + 满屏失败日志」，且掩盖真正的问题。
//   故「有没有图形会话」是拉起 GUI 的**前置条件**，必须显式判定。
//
// 平台差异（为何只有 Linux 需要真判定）：
//   linux  —— 需判定：看 DISPLAY / WAYLAND_DISPLAY 环境变量，或 X11/Wayland socket 实际存在。
//             （环境变量可能因 systemd --user 未 import 而为空，故必须补 socket 探测。）
//   darwin —— 恒为真：守卫由 LaunchAgent `bootstrap gui/<uid>` 载入（壳建立），
//             天然在图形会话内；用户注销时 launchd 会连同该 agent 一起结束。
//   win32  —— 恒为真：守卫由 schtasks ONLOGON（/RL HIGHEST）在用户会话内建立，
//             注销会结束该会话的进程。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const PLATFORM = process.platform;

/** X11 socket 目录中是否存在活动显示（/tmp/.X11-unix/X0 …）。 */
function hasX11Socket() {
  try {
    return fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f));
  } catch { return false; }
}

/** Wayland socket 是否存在（$XDG_RUNTIME_DIR/wayland-0 …）。 */
function hasWaylandSocket() {
  const uid = (typeof process.getuid === 'function') ? process.getuid() : 0;
  const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
  try {
    return fs.readdirSync(rt).some((f) => /^wayland-\d+$/.test(f));
  } catch { return false; }
}

/** 当前是否有可用于承载 GUI 的图形会话。 */
function sessionAvailable() {
  if (PLATFORM === 'linux') {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
    // 环境变量在 systemd --user 语境可能未被 import —— 退回实测 socket。
    return hasX11Socket() || hasWaylandSocket();
  }
  // darwin / win32：守卫本身只在图形会话内存活（见文件头说明）。
  return PLATFORM === 'darwin' || PLATFORM === 'win32';
}

/** 判定依据（供诊断/审计，说明**为什么**得出该结论）。 */
function describe() {
  if (PLATFORM === 'linux') {
    const byEnv = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const byX = hasX11Socket();
    const byWl = hasWaylandSocket();
    return {
      platform: PLATFORM,
      available: byEnv || byX || byWl,
      reason: byEnv ? 'env(DISPLAY/WAYLAND_DISPLAY)' : (byX ? 'x11-socket' : (byWl ? 'wayland-socket' : 'none')),
      display: process.env.DISPLAY || null,
      waylandDisplay: process.env.WAYLAND_DISPLAY || null,
    };
  }
  return { platform: PLATFORM, available: PLATFORM === 'darwin' || PLATFORM === 'win32',
           reason: 'session-scoped-by-launcher' };
}

module.exports = { sessionAvailable, describe, PLATFORM };