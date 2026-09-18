'use strict';

// 平台化「图形会话可用性」判定。
// 用途：守卫看护桌面壳前必须先确认有图形会话；否则无会话时拉起 GUI 必失败，看护周期性
// 重试会造成重启风暴并掩盖真正问题。
// 平台差异：Linux 需真判定（DISPLAY/WAYLAND_DISPLAY 可能未 import，故补 X11/Wayland socket
// 实测）；darwin/win32 恒为真（守卫由图形会话内的 LaunchAgent / schtasks ONLOGON 载入，
// 注销即随会话结束）。

const fs = require('node:fs');
const PLATFORM = process.platform;

function hasX11Socket() {
  try {
    return fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f));
  } catch { return false; }
}

function hasWaylandSocket() {
  const uid = (typeof process.getuid === 'function') ? process.getuid() : 0;
  const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
  try {
    return fs.readdirSync(rt).some((f) => /^wayland-\d+$/.test(f));
  } catch { return false; }
}

function sessionAvailable() {
  if (PLATFORM === 'linux') {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
    // 环境变量在 systemd --user 语境可能未被 import —— 退回实测 socket。
    return hasX11Socket() || hasWaylandSocket();
  }
  // darwin / win32：守卫本身只在图形会话内存活（见文件头说明）。
  return PLATFORM === 'darwin' || PLATFORM === 'win32';
}

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
  // 必须委托 sessionAvailable()：此处若重写判定表达式，两份副本会漂移
  // （把 sessionAvailable 改成 false 后 describe 仍报可用，即此症）。
  return { platform: PLATFORM, available: sessionAvailable(),
           reason: 'session-scoped-by-launcher' };
}

module.exports = { sessionAvailable, describe, PLATFORM };
