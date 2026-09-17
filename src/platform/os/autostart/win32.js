'use strict';

// Windows 自启策略（schtasks DSH-Supervisor-GUI）。
// schtasks ONLOGON 只在登录时启动一次，进程崩溃后不会重启，故由壳建立 watchdog 任务每 5 分钟
// 检查守卫。守卫任务与 watchdog 的所有者都是桌面壳；本模块只保留「GUI 壳开机自启」这一个语义，
// 不再创建 watchdog、不再 enable/disable 守卫任务（否则与壳争定义，且形成第二个启动器）。

const ex = require('../../util/exec');

/** 自启状态（三个任务职责分离）：DSH-Supervisor 为守卫守护进程（壳建立），
 *  DSH-Supervisor-GUI 为登录时打开桌面壳（本开关管理），DSH-Supervisor-Watchdog 为每 5 分钟保活（归壳）。 */
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
