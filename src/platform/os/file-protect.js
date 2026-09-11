'use strict';

// ★ 跨平台文件/目录访问保护（P1 修复）★
//
// 问题：产品大量使用 `fs.writeFileSync(f, data, { mode: 0o600 })` 保护敏感文件
// （config.json 含 lanToken、dsh-main-token.log 含 DSH 访问令牌、registry.json、state.json）。
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
const ex = require('../exec');

const IS_WINDOWS = process.platform === 'win32';
let _icacls = null; // 缓存 icacls 可用性

function hasIcacls(platform) {
  if ((platform || process.platform) !== 'win32') return false;
  if (_icacls !== null) return _icacls;
  // 经统一执行器（`icacls /?` 退出码非 0 即视为不可用）。
  _icacls = ex.run('icacls', ['/?'], { stdio: 'ignore', timeoutMs: 3000 }) !== null;
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
 *  @param {string} file 目标文件（自动创建父目录）
 *  @param {string|Buffer} data
 *  @returns {{ok:boolean, reason?:string}} */
function writePrivate(file, data) {
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    protectFile(tmp);
    fs.renameSync(tmp, file);
    protectFile(file); // rename 后再次确保（部分平台 rename 不保留 ACL）
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { protectFile, protectDir, ensurePrivateDir, writePrivate, hasIcacls, currentUser, IS_WINDOWS };
