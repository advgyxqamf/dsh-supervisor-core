'use strict';

// ★ 跨平台可执行文件解析（P0 修复）★
// 把「逻辑名」解析为「可实际 spawn 的绝对路径」。
//
// 跨平台规范（本模块的全部依据）：
//   Windows：可执行**必须有扩展名**（.exe/.cmd/.bat，按 PATHEXT 展开）——
//            旧实现硬拼 ~/.local/bin/dsh-supervisor（无 .exe）→ watchdog Start-Process 静默失败；
//            且 Windows 标准全局 bin 目录是 %APPDATA%\npm，而非 Unix 的 ~/.local/bin。
//   Unix   ：无扩展名；~/.local/bin（内核 install 写入的软链）、~/.npm-global/bin、
//            macOS 追加 /opt/homebrew/bin 与 /usr/local/bin。
// 解析顺序：显式 env 覆盖 → PATH（Windows 含 PATHEXT）→ 标准安装目录。
// 返回**绝对路径或 null**——绝不返回不可执行的猜测路径（调用方据此明确报「未找到」而非静默失败）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 候选文件名（含平台扩展名；platform 可注入以便纯函数测试）。 */
function candidateNames(base, platform) {
  const win = (platform || process.platform) === 'win32';
  if (!win) return [base];
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = [base + '.exe', base + '.cmd', base + '.bat'];
  for (const e of exts) {
    const n = base + e.toLowerCase();
    if (!names.some((x) => x.toLowerCase() === n)) names.push(n);
  }
  names.push(base); // 无扩展名兜底（少数 shim 形态）
  return [...new Set(names)];
}

function firstExecutable(dir, base, platform) {
  if (!dir) return null;
  for (const name of candidateNames(base, platform)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在/无权：跳过 */ }
  }
  return null;
}

/** 标准安装目录（按优先级；跨平台）。 */
function standardDirs(platform, home) {
  const pl = platform || process.platform;
  const h = home || os.homedir();
  const dirs = [];
  if (pl === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh-supervisor'));
    dirs.push(path.join(h, '.local', 'bin')); // 兼容旧布局（未必存在，解析时按 isFile 过滤）
  } else {
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.npm-global', 'bin'));
    if (pl === 'darwin') { dirs.push('/opt/homebrew/bin'); dirs.push('/usr/local/bin'); }
  }
  return dirs;
}

/** PATH 内查找（跨平台；Windows 走 PATHEXT；兼容大小写不一的 `Path`）。 */
function inPath(base, platform) {
  const raw = process.env.PATH || process.env.Path || '';
  for (const d of raw.split(path.delimiter)) {
    if (!d) continue;
    const hit = firstExecutable(d, base, platform);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析可执行绝对路径。
 * @param {string} base 逻辑名（如 'dsh-supervisor'）
 * @param {{envVar?:string, extraDirs?:string[]}} [opts]
 * @returns {string|null} 绝对路径或 null
 */
function resolveExecutable(base, opts) {
  const o = opts || {};
  if (o.envVar && process.env[o.envVar]) {
    const v = process.env[o.envVar];
    try { if (fs.statSync(v).isFile()) return v; } catch { /* 覆盖路径无效：继续常规解析 */ }
  }
  const inPathHit = inPath(base);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs()]) {
    const hit = firstExecutable(d, base);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析 **npm** 的可执行路径（跨平台）。
 *
 * ⚠ 为什么必须存在（P1-C，2026-09-12）：
 *   Windows 上 npm 的实际可执行是 `npm.cmd`，而 Node 的 `spawn`/`execFileSync`
 *   **不做 PATHEXT 解析**（`.cmd`/`.bat` 必须由 cmd.exe 承载；自 CVE-2024-27980 起
 *   Node 也不再隐式代跑 `.cmd`）→ 传裸 `'npm'` 一律 `ENOENT`。
 *
 *   旧实现在**三处**各自硬编码 `'npm'`（`domains/dist`、`guard/native`、`platform/config`），
 *   于是 Windows 用户的「升级内核 / 安装 / 卸载 DSH」全部失败，且错误只是含糊的 ENOENT。
 *   壳仓早已正确实现同一事实（`core.rs` 的 `npm_exe()` → `npm.cmd`），两仓答案不一致。
 *
 *   修法：**唯一解析入口**。Windows 走 PATHEXT 解析（优先 `.cmd`），其余平台直接用 `npm`。
 *   解析失败时返回**可执行名**而非 null —— 让调用方沿用既有错误路径（报「npm 不可用」），
 *   而不是把 null 传进 spawn 变成更难懂的 TypeError。
 *
 * @param {{platform?:string}} [opts] platform 可注入，便于纯函数测试
 * @returns {string} 可执行的绝对路径，或回退名（'npm'）
 */
function npmBin(opts) {
  const pl = (opts && opts.platform) || process.platform;
  if (pl !== 'win32') return 'npm';
  // Windows：先按逻辑名解析（候选名含 npm.cmd / npm.bat / npm.exe，PATHEXT 展开）。
  const resolved = resolveExecutable('npm', { extraDirs: [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  // 解析不到时**仍返回 npm.cmd**：Windows 上 `npm` 无扩展名可执行的概率为零，
  // 而 `npm.cmd` 至少能在 PATH 生效时被 cmd.exe 找到（把失败留给定调用方的错误处理）。
  return 'npm.cmd';
}

module.exports = { resolveExecutable, candidateNames, standardDirs, firstExecutable, npmBin };
