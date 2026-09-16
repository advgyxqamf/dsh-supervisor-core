'use strict';

// autostart/win32.js —— Windows 自启策略（schtasks DSH-Supervisor-GUI）。
//
// Windows 崩溃自拉宿主（2026-09 补齐）：schtasks ONLOGON 只登录启动一次，进程崩溃后不会重启。
// 方案：双任务——(a) ONLOGON 启动 GUI 壳（用户常驻入口）；(b) Watchdog 每 5 分钟检查守卫。
// 看护（DSH-Supervisor-Watchdog）与守卫任务（DSH-Supervisor）的所有者 = **桌面壳**
//   （KERNEL-DAEMON-CONTRACT D6 / KERNEL-LAUNCH-STANDARD H5）。
//   2026-09-15：本模块只保留「GUI 壳开机自启」这一个语义 —— 不再创建 watchdog、
//   不再 enable/disable 守卫任务（否则与壳争定义，且形成第二个启动器）。

const ex = require('../../util/exec');

/** 自启状态：三个任务的**职责分离**（2026-09-11 架构修正）：
 *   DSH-Supervisor          -> 守卫守护进程（**由桌面壳建立**）
 *   DSH-Supervisor-GUI      -> 登录时打开桌面壳（本开关管理）
 *   DSH-Supervisor-Watchdog -> 每 5 分钟保活（崩溃自拉，归壳） */
function status() {
  let guard = false, gui = false, watchdog = false;
  const has = (tn) => {
    try {
      const out = ex.runOut('schtasks', ['/Query', '/TN', tn], { stdio: ['ignore', 'pipe', 'ignore'] });
      return !!out && out.includes(tn);
    } catch { return false; }
  };
  guard = has('DSH-Supervisor');
  gui = has('DSH-Supervisor-GUI');
  watchdog = has('DSH-Supervisor-Watchdog');
  return { kind: 'schtasks', on: guard || gui || watchdog, gui, watchdog, guard };
}

/** GUI 壳登录自启开关（schtasks DSH-Supervisor-GUI，ONLOGON）。 */
function setAutostart(on, deps) {
  const errors = [];
  try {
    if (on) {
      const r = ex.runDetail('schtasks', ['/Create', '/TN', 'DSH-Supervisor-GUI', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + deps.guiCommand() + '"']);
      if (!r.ok) errors.push('schtasks gui: ' + (r.error || '执行失败'));
    } else {
      ex.run('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);
    }
  } catch (e) { errors.push('gui autostart: ' + e.message); }
  return { ok: errors.length === 0, errors, ...status() };
}

/** Windows 的壳自启由 setAutostart 的 schtasks DSH-Supervisor-GUI 承担（职责分离）。 */
function setGuiAutostart(on) {
  return { ok: true, platform: 'win32', enabled: !!on, via: 'schtasks', task: 'DSH-Supervisor-GUI' };
}

module.exports = { status, setAutostart, setGuiAutostart };
