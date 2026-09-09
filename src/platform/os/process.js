'use strict';

// 平台进程控制：组信号 / 树杀 / 存活探测。
// - POSIX（Linux/macOS）：进程组信号（spawn detached 的组）直接 `kill(-pid)`；
// - Windows：无进程组语义 → 单进程信号 + `taskkill /T` 整树终止（能力等价）。

const isWindows = process.platform === 'win32';

/** kill(pid,0) 存活探测（三平台通用）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** 向进程（组）发信号：
 *  - POSIX：先组信号（-pid），失败退单进程；
 *  - Windows：仅单进程（树语义由 killTree 提供）。 */
function signalProcess(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    try { process.kill(pid, sig); } catch {}
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** 整树终止（尽力而为，回调式）：
 *  - POSIX：进程组 SIGTERM（或指定信号）；
 *  - Windows：`taskkill /PID <pid> /T`（整棵树，含子进程）。 */
function killTree(pid, sig, cb) {
  if (!Number.isInteger(pid) || pid <= 0) { if (cb) cb(new Error('invalid pid')); return; }
  if (isWindows) {
    const { execFile } = require('node:child_process');
    execFile('taskkill', ['/PID', String(pid), '/T'], (err, stdout, stderr) => {
      if (cb) cb(err || null);
    });
    return;
  }
  signalProcess(pid, sig || 'SIGTERM');
  if (cb) process.nextTick(cb, null);
}

module.exports = { isAlive, signalProcess, killTree };
