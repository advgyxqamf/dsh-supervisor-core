'use strict';

// ★ 跨平台文件/目录访问保护（P1 修复）★
//
// 问题：产品大量使用 `fs.writeFileSync(f, data, { mode: 0o600 })` 保护敏感文件
// （config.json 含 apiAccessKey、dsh-main.json 含 remoteToken、dsh-main-token.log 含 DSH 会话令牌）。
// 但 **POSIX mode 在 Windows 被忽略**（NTFS 用 ACL，与 mode 无关）→ 这些文件对同机其他用户可读。
//
// 跨平台规范：
//   Unix   ：chmod（文件 0600 / 目录 0700）——进程内 POSIX mode 有效。
//   Windows：icacls —— 移除继承（/inheritance:r）并仅授予当前用户；目录用 (OI)(CI) 让内部文件继承。
//
// 工业级要点：**保护目录一次**即可让后续新建文件继承约束（比逐文件 icacls 快且不漏）；
// 逐文件保护用于「目录已存在、文件为历史遗留」的场景。全部 best-effort：失败不阻断主流程，
// 但结果可观测（返回值）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../util/exec');

const IS_WINDOWS = process.platform === 'win32';
let _icacls = null; // 缓存 icacls 可用性

function hasIcacls(platform) {
  if ((platform || process.platform) !== 'win32') return false;
  if (_icacls !== null) return _icacls;
  // 经统一执行器（`icacls /?` 退出码非 0 即视为不可用）。
  // ⚠ 2026-09-13（P0 修复）：改用 runOut —— 同 platform/os/index.js hasTool 的缺陷：
  //   execFileSync 在 stdio:'ignore' 下**成功也返回 null**，故旧的 '!== null' 判据恒为 false
  //   → hasIcacls() 在 Windows 上恒 false → 所有敏感文件/目录的 icacls 收紧**静默失效**
  //     （protectFile/protectDir/writePrivate 一律返回 {ok:false, mode:'none'}，
  //      只落一行警告，用户与审计都看不到权限没收紧）。runOut 下 null 只可能是失败。
  //   注：runDetail 在 stdio:'ignore' 下不受影响 —— 它以「是否抛异常」判 ok，不依赖返回值。
  _icacls = ex.runOut('icacls', ['/?'], { timeoutMs: 3000 }) !== null;
  return _icacls;
}

function currentUser() {
  return process.env.USERNAME || process.env.USER || (() => { try { return os.userInfo().username; } catch { return null; } })();
}

/** 保护单个文件（Unix chmod 0600；Windows icacls 仅当前用户）。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
function protectFile(file) {
  if (!IS_WINDOWS) {
    try { fs.chmodSync(file, 0o600); return { ok: true, mode: 'posix-0600' }; }
    catch (e) { return { ok: false, mode: 'posix-0600', reason: e.message }; }
  }
  if (!hasIcacls()) return { ok: false, mode: 'none', reason: 'icacls 不可用' };
  const user = currentUser();
  if (!user) return { ok: false, mode: 'icacls', reason: '无法确定当前用户' };
  // 经统一执行器：runDetail 保留退出码/错误，便于如实上报失败原因。
  const r = ex.runDetail('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore', timeoutMs: 5000 });
  return r.ok
    ? { ok: true, mode: 'icacls-file' }
    : { ok: false, mode: 'icacls-file', reason: r.error || ('退出码 ' + r.code) };
}

/** 保护目录（Unix chmod 0700；Windows icacls 继承性收紧 (OI)(CI)）。
 *  建议在数据目录创建后调用一次——内部新建文件自动继承约束。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
function protectDir(dir) {
  if (!IS_WINDOWS) {
    try { fs.chmodSync(dir, 0o700); return { ok: true, mode: 'posix-0700' }; }
    catch (e) { return { ok: false, mode: 'posix-0700', reason: e.message }; }
  }
  if (!hasIcacls()) return { ok: false, mode: 'none', reason: 'icacls 不可用' };
  const user = currentUser();
  if (!user) return { ok: false, mode: 'icacls', reason: '无法确定当前用户' };
  const r = ex.runDetail('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'], { stdio: 'ignore', timeoutMs: 10000 });
  return r.ok
    ? { ok: true, mode: 'icacls-dir' }
    : { ok: false, mode: 'icacls-dir', reason: r.error || ('退出码 ' + r.code) };
}

/** 确保目录存在并施加保护（创建 + 保护一步到位）。 */
function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, mode: 'mkdir', reason: e.message }; }
  return protectDir(dir);
}

/** 写入敏感文件并施加保护（原子写 + 保护；避免「写完到保护之间」的可读窗口）。
 *
 *  ⚠ P2-1 修复（2026-09-12）：**保护失败必须如实返回 `ok:false`**。
 *
 *    缺陷：此前两处 `protectFile(...)` 的返回值被**丢弃**，末尾无条件 `return {ok:true}` ——
 *      Windows 上 `icacls` 不可用/被策略拦截时，文件最终保持继承 ACL 可读，
 *      而调用方拿到「已 0600 写入」的假成功（本仓禁忌「catch 后当成功」）。
 *
 *    ⚠ 该函数当前**生产零调用点**（唯一调用方是 cross-platform-test）——
 *      也就是说这条事故链目前被「功能未接线」挡住；但同目录的 `protectDir`
 *      （`supervisor.js` 对 swDir/supervisorDir 调用）**是真正生效的那一半**，
 *      其失败同样只 `console.warn`（见 `supervisor.js` 的调用点）。
 *      这里先把 `writePrivate` 的契约修正确，避免将来接线时踩坑。
 *
 *  @param {string} file 目标文件（自动创建父目录）
 *  @param {string|Buffer} data
 *  @returns {{ok:boolean, reason?:string, mode?:string}} */
function writePrivate(file, data) {
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const p1 = protectFile(tmp);
    if (p1 && p1.ok === false) { try { fs.rmSync(tmp, { force: true }); } catch {} return { ok: false, reason: 'protect(tmp): ' + (p1.reason || p1.mode), mode: p1.mode }; }
    fs.renameSync(tmp, file);
    const p2 = protectFile(file); // rename 后再次确保（部分平台 rename 不保留 ACL）
    if (p2 && p2.ok === false) return { ok: false, reason: 'protect(file): ' + (p2.reason || p2.mode), mode: p2.mode };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { protectFile, protectDir, ensurePrivateDir, writePrivate, hasIcacls, currentUser, IS_WINDOWS };
