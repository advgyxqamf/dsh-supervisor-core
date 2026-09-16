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

/** 标准安装目录（按优先级；跨平台）。
 *
 *  ⚠ 2026-09-13（跨平台架构规范化）：**env 可注入**（默认 process.env）。
 *    原实现直接读 process.env.APPDATA/LOCALAPPDATA —— 于是「注入 platform='win32'」
 *    在 Linux 上**拿不到 Windows 目录**（那是宿主 env 而非平台事实），
 *    使「在 Linux 上穷举 Windows 解析行为」不可能。现 env 与 platform 一并可注入。
 *  @param platform 可选（默认 process.platform）
 *  @param home 可选（默认 os.homedir()）
 *  @param env 可选（默认 process.env） */
function standardDirs(platform, home, env) {
  const pl = platform || process.platform;
  const h = home || os.homedir();
  const e = env || process.env;
  const dirs = [];
  if (pl === 'win32') {
    if (e.APPDATA) dirs.push(path.join(e.APPDATA, 'npm'));
    if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Programs', 'dsh-supervisor'));
    dirs.push(path.join(h, '.local', 'bin')); // 兼容旧布局（未必存在，解析时按 isFile 过滤）
  } else {
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.npm-global', 'bin'));
    if (pl === 'darwin') { dirs.push('/opt/homebrew/bin'); dirs.push('/usr/local/bin'); }
  }
  return dirs;
}

/** PATH 内查找（跨平台；Windows 走 PATHEXT；兼容大小写不一的 `Path`）。
 *  ⚠ env 可注入（默认 process.env）——理由同 standardDirs：让平台行为可在任意宿主上穷举。 */
function inPath(base, platform, env) {
  const e = env || process.env;
  const raw = e.PATH || e.Path || '';
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
  const pl = o.platform;              // 未传 = 宿主（保持既有默认行为不变）
  const env = o.env;                  // 未传 = process.env
  const E = env || process.env;
  if (o.envVar && E[o.envVar]) {
    const v = E[o.envVar];
    try { if (fs.statSync(v).isFile()) return v; } catch { /* 覆盖路径无效：继续常规解析 */ }
  }
  // ⚠ 2026-09-13：**platform / env 必须向下传播**（原实现两者都不传 →
  //   npmBin({platform:'win32'}) 在 Linux 上会按**宿主**规则解析出 POSIX 路径，
  //   使「platform 可注入，便于纯函数测试」形同虚设）。
  const inPathHit = inPath(base, pl, env);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs(pl, undefined, env)]) {
    const hit = firstExecutable(d, base, pl);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析 **npx** 的可执行路径（跨平台）。
 *
 * ⚠ 与 `npmBin()` **同一类缺陷**（P1-4，2026-09-12）：
 *   Windows 上 npx 的实际可执行是 `npx.cmd`，而 Node 的 `spawn`/`execFile`
 *   **不做 PATHEXT 解析** → 传裸 `'npx'` 一律 ENOENT。
 *   本仓已有 `npmBin()` 解决 npm 的同一问题，但反代路径用的是 npx ——
 *   而 `test/npm-resolution-test.js` 的门禁正则只匹配 `'npm'`，**对 npx 是盲区**，
 *   于是「已全部经 npmBin()」的保证是假的。
 *
 * 修法：与 npmBin 完全同构（Windows 走 PATHEXT，优先 `.cmd`）；解析失败仍返回
 *   `'npx.cmd'`，让失败留给定调用方的错误处理，而不是把 null 传进 spawn。
 *
 * @param {{platform?:string}} [opts] platform 可注入，便于纯函数测试
 * @returns {string} 可执行的绝对路径，或回退名（'npx'）
 */
function npxBin(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  if (pl !== 'win32') return 'npx';
  const resolved = resolveExecutable('npx', { platform: pl, env, extraDirs: [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  return 'npx.cmd';
}

/**
 * 解析 **npm** 的可执行路径（跨平台）。
 *
 * ⚠ 为什么必须存在（P1-C，2026-09-12）：
 *   Windows 上 npm 的实际可执行是 `npm.cmd`，而 Node 的 `spawn`/`execFileSync`
 *   **不做 PATHEXT 解析**（`.cmd`/`.bat` 必须由 cmd.exe 承载；自 CVE-2024-27980 起
 *   Node 也不再隐式代跑 `.cmd`）→ 传裸 `'npm'` 一律 `ENOENT`。
 *
 *   旧实现在**三处**各自硬编码 `'npm'`（原 `domains/dist`（步骤3 上移 `platform/distribution`）、`guard/native`、`platform/service/config`），
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
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  if (pl !== 'win32') return 'npm';
  // Windows：先按逻辑名解析（候选名含 npm.cmd / npm.bat / npm.exe，PATHEXT 展开）。
  const resolved = resolveExecutable('npm', { platform: pl, env, extraDirs: [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  // 解析不到时**仍返回 npm.cmd**：Windows 上 `npm` 无扩展名可执行的概率为零，
  // 而 `npm.cmd` 至少能在 PATH 生效时被 cmd.exe 找到（把失败留给定调用方的错误处理）。
  return 'npm.cmd';
}

const DSH_PKG = ['@deepseek-ai', 'dsh'];

/** 包内 DSH JS 入口（给定 npm 全局 prefix 或垫片所在目录）。 */
function dshJsIn(prefix) {
  return path.join(prefix, 'node_modules', ...DSH_PKG, 'lib', 'bin.js');
}

/**
 * 解析**原生 DSH** 的可执行入口（跨平台，优先包内 JS）。
 *
 * 为什么必须：原生 DSH 一直被当作**裸逻辑名** `'dsh'` 使用（`config.command[1]` / `dshBin`），
 *   而 `node dsh` 不做 PATH 解析、Windows 上裸 `dsh` 也无扩展名 —— 于是「是否已安装」永远判为 false，
 *   与「安装」分支形成**两套相反判定**（静态默认配置 vs 真实安装）。
 *
 * 解析顺序：显式 `DSH_BIN` → PATH（Windows 走 PATHEXT）→ 标准落点（standardDirs）→
 *   `<npmRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js`。
 * 返回 `{ runtime, bin, isJs, launcher }`：
 *   · 命中包内 JS → runtime=当前 node，bin=<abs js>（最稳：不依赖 shebang / .cmd 垫片）；
 *   · 只命中垫片（.cmd / 无扩展名 shim）→ 反查同前缀包内 JS；
 *   · 都没有 → null（调用方如实报「未安装」，绝不猜）。
 */
function resolveDsh(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const asJs = (bin, launcher) => ({ runtime: process.execPath, bin, isJs: true, launcher: launcher || null });
  // ① 显式覆盖
  if (env.DSH_BIN) { try { const r = fs.realpathSync(env.DSH_BIN); if (isFile(r)) return asJs(r, env.DSH_BIN); } catch {} }
  // ② PATH → 标准落点
  const hit = resolveExecutable('dsh', { platform: pl, env });
  if (hit) {
    // Unix：dsh 常是软链 → canonicalize 到包内 lib/bin.js
    try { const real = fs.realpathSync(hit); if (isFile(real) && /\.(js|cjs|mjs)$/i.test(real)) return asJs(real, hit); } catch {}
    // Windows：.cmd 垫片 → 同前缀的包内 JS
    const js = dshJsIn(path.dirname(hit));
    if (isFile(js)) return asJs(js, hit);
    // 无扩展名 JS（Unix 包内入口）→ 交给 node
    if (isFile(hit) && !/\.(cmd|bat|exe)$/i.test(hit)) return asJs(hit, hit);
    // 只能是垫片：调用方需 shell 承载（Windows）
    return { runtime: null, bin: hit, isJs: false, launcher: hit };
  }
  // ③ npm 全局 root 反查（调用方注入；不在此处执行 npm —— 保持纯解析）
  if (o.npmRoot) { const js = dshJsIn(o.npmRoot); if (isFile(js)) return asJs(js, null); }
  return null;
}

module.exports = { resolveExecutable, candidateNames, standardDirs, firstExecutable, npmBin, npxBin, resolveDsh, dshJsIn };
