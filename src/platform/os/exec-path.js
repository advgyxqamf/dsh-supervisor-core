'use strict';

// 跨平台可执行文件解析：把逻辑名解析为可实际 spawn 的绝对路径。
// Windows 可执行必须有扩展名（.exe/.cmd/.bat，按 PATHEXT 展开），标准全局 bin 是 %APPDATA%\npm；
// Unix 无扩展名，标准目录为 ~/.local/bin、~/.npm-global/bin，macOS 追加 /opt/homebrew/bin 与
// /usr/local/bin。解析顺序：显式 env 覆盖，PATH（Windows 含 PATHEXT），标准安装目录。
// 返回绝对路径或 null —— 绝不返回不可执行的猜测路径（调用方据此明确报「未找到」）。

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

/** 标准安装目录（按优先级；跨平台）。env 可注入：原实现直读 process.env.APPDATA/
 *  LOCALAPPDATA，导致在 Linux 上注入 platform=win32 也拿不到 Windows 目录，无法穷举解析行为。 */
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

/** PATH 内查找（跨平台；Windows 走 PATHEXT；兼容大小写不一的 Path）。
 *  env 可注入（默认 process.env），理由同 standardDirs。 */
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
  // platform / env 必须向下传播：否则 npmBin({platform:win32}) 在 Linux 上会按宿主规则
  // 解析出 POSIX 路径，platform 可注入形同虚设。
  const inPathHit = inPath(base, pl, env);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs(pl, undefined, env)]) {
    const hit = firstExecutable(d, base, pl);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析 npx 的可执行路径（跨平台）。与 npmBin 同类缺陷：Windows 上实际可执行是 npx.cmd，
 * 而 Node 的 spawn/execFile 不做 PATHEXT 解析，传裸 npx 一律 ENOENT。
 * 解析失败仍返回 npx.cmd（失败留给调用方的错误处理，而不是把 null 传进 spawn）。
 * @param {{platform?:string}} [opts] platform 可注入，便于纯函数测试
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
 * 解析 npm 的可执行路径（跨平台）。Windows 上实际可执行是 npm.cmd，Node 的 spawn/execFileSync
 * 不做 PATHEXT 解析，传裸 npm 一律 ENOENT。历史上三处各自硬编码 'npm'，导致 Windows 上升级/
 * 安装/卸载全部失败且只报含糊 ENOENT。本函数是唯一解析入口：Windows 走 PATHEXT（优先 .cmd），
 * 其余平台直接用 npm；解析失败返回可执行名而非 null，让调用方沿用既有错误路径。
 * @param {{platform?:string}} [opts] platform 可注入，便于纯函数测试
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

function dshJsIn(prefix) {
  return path.join(prefix, 'node_modules', ...DSH_PKG, 'lib', 'bin.js');
}

/**
 * 解析原生 DSH 的可执行入口（跨平台，优先包内 JS）。
 * 原生 DSH 一直被当作裸逻辑名 'dsh' 使用，而 node dsh 不做 PATH 解析、Windows 上裸 dsh 也无
 * 扩展名，于是「是否已安装」永远判为 false，与「安装」分支形成两套相反判定。
 * 解析顺序：显式 DSH_BIN 到 PATH（Windows 走 PATHEXT）到标准落点，再到
 * <npmRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js。
 * 返回 { runtime, bin, isJs, launcher }：命中包内 JS 用当前 node 执行；只命中垫片则反查
 * 同前缀包内 JS；都没有返回 null（调用方如实报「未安装」，绝不猜）。
 */
function resolveDsh(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const asJs = (bin, launcher) => ({ runtime: process.execPath, bin, isJs: true, launcher: launcher || null });
  // (1) 显式覆盖
  if (env.DSH_BIN) { try { const r = fs.realpathSync(env.DSH_BIN); if (isFile(r)) return asJs(r, env.DSH_BIN); } catch {} }
  // (2) PATH -> 标准落点
  const hit = resolveExecutable('dsh', { platform: pl, env });
  if (hit) {
    // Unix：dsh 常是软链 -> canonicalize 到包内 lib/bin.js
    try { const real = fs.realpathSync(hit); if (isFile(real) && /\.(js|cjs|mjs)$/i.test(real)) return asJs(real, hit); } catch {}
    // Windows：.cmd 垫片 -> 同前缀的包内 JS
    const js = dshJsIn(path.dirname(hit));
    if (isFile(js)) return asJs(js, hit);
    // 无扩展名 JS（Unix 包内入口）-> 交给 node
    if (isFile(hit) && !/\.(cmd|bat|exe)$/i.test(hit)) return asJs(hit, hit);
    // 只能是垫片：调用方需 shell 承载（Windows）
    return { runtime: null, bin: hit, isJs: false, launcher: hit };
  }
  // (3) npm 全局 root 反查（调用方注入；不在此处执行 npm —— 保持纯解析）
  if (o.npmRoot) { const js = dshJsIn(o.npmRoot); if (isFile(js)) return asJs(js, null); }
  return null;
}

/** 内核已知的 DSH 入口位置（**单一事实源**：复用 resolveDsh()/dshJsIn()，供 api 形态闸与启动期复校共用）。
 *  返回**可能存在也可能不存在**的候选绝对路径；调用方按需 realpath（不存在者自动跳过）。
 *  为什么要有它：此前 api 层用硬编码子串 `/node_modules/@deepseek-ai/dsh/` 判「官方包内入口」，
 *  与内核自己的解析器各写一份 —— 阶段四实测该子串还可被「伪包内路径」（/tmp/... 前缀）绕过。
 *  @param {{platform?:string, env?:object, npmRoot?:string, dshBin?:string}} [opts]
 *  @returns {string[]}
 */
function knownDshEntries(opts) {
  const o = opts || {};
  const out = [];
  try {
    const r = resolveDsh(o);
    if (r) {
      if (typeof r.bin === 'string' && r.bin) out.push(r.bin);           // 已 realpath 的入口
      if (typeof r.launcher === 'string' && r.launcher) out.push(r.launcher); // 垫片/软链原路径
    }
  } catch { /* 解析失败：无已知入口（调用方按 fail-closed 自行决定） */ }
  if (o.npmRoot) { try { out.push(dshJsIn(o.npmRoot)); } catch { /* 前缀非法：跳过 */ } }
  // 配置的 DSH 可执行名：仅当它是**绝对路径**时才作为候选（裸名由下面的「裸名放行」覆盖）。
  if (typeof o.dshBin === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(o.dshBin)) out.push(o.dshBin);
  return [...new Set(out.filter((x) => typeof x === 'string' && x))];
}

/** 启动命令「入口归属」校验（**纯函数**：api 形态闸与启动期复校共用同一实现，避免第二份）。
 *
 *  解决的问题：`inst.command` 用户可填自由 argv，最终原样交给 systemd-run 执行。仅按 basename
 *  白名单判「是不是 DSH」可被「把脚本命名为 dsh*.js」绕过；而真正跨信任边界的方向是
 *  「沙箱内可写文件被守卫执行」（相对入口按沙箱可写的 workingDir 解析）。
 *
 *  判据（**保守即拒绝**，代价不对称：误放行=执行任意代码，误拒绝=一次可读错误）：
 *    · 形态：`[node, <entry>, ...]` 取 entry = cmdArr[1]；否则 entry = cmdArr[0]（DSH 自身打头）。
 *    · **裸名**（不含路径分隔符，如 'dsh'）→ 放行：交 exec 的 PATH 解析，本层无法 realpath；
 *      内核默认命令 defaultCommand 的 dshBin 正是此形态（native/main 依赖它，不得误拒）。
 *    · **相对路径**（含分隔符但不绝对）→ 拒绝：会按调用方 workingDir 解析；沙箱实例的 workingDir
 *      是**沙箱内可写**的 data 目录 ⇒「沙箱写文件 → 守卫重启执行」的低权限→高权限面。
 *    · **绝对路径** → 依次：① 调用方策略 allowEntry 放行；② realpath 后**精确等于** files 之一，
 *      或**位于** roots 之下；③ 否则拒绝。root/file 两侧均过 realpath，防「安装根内软链指向 /tmp」。
 *    · **ENOENT / realpath 失败** → 拒绝（fail-closed）：否则「先提交、后由外部创建」可绕过。
 *
 *  @param {string[]} cmdArr 有效启动命令（sandbox.effectiveCommand 的产出）
 *  @param {{
 *    roots?: string[],                       // 允许的**目录**前缀（如该实例 installDir）
 *    files?: string[],                       // 允许的**精确文件**（如 knownDshEntries() 的产出）
 *    requireAbsoluteEntry?: boolean,         // 默认 false；api 闸传 true（用户形态 A 必须绝对路径）
 *    allowEntry?: (entry:string, real:string|null)=>boolean,  // 调用方附加策略（api 的 basename/包形态/dshBin）
 *    realpath?: (p:string)=>string,          // 可注入（便于纯函数测试）
 *  }} [opts]
 *  @returns {string|null} 违规原因（可读文案）；null = 通过
 */
function commandEntryViolation(cmdArr, opts) {
  const o = opts || {};
  const rp = o.realpath || ((p) => fs.realpathSync(p));
  if (!Array.isArray(cmdArr) || !cmdArr.length) return null; // 无判定对象（默认命令由域内生成）
  const head = String(cmdArr[0] || '');
  const NODE_HEAD = new Set(['node', 'node.exe']);
  const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  let entry = head;
  const nodeHead = NODE_HEAD.has(baseOf(head));
  if (nodeHead) {
    if (cmdArr.length < 2) return '启动命令以 node 打头但缺少 DSH 入口参数';
    entry = String(cmdArr[1] || '');
  }
  if (!entry) return '启动命令缺少 DSH 入口';
  const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
  const hasSep = (p) => /[\\/]/.test(String(p));
  // 裸名：交 PATH 解析（内核默认命令 native/main 即 [node, 裸 dshBin]）。
  if (!hasSep(entry)) {
    if (nodeHead && o.requireAbsoluteEntry) {
      return 'command[0] 为 node 时 command[1] 必须是绝对路径的 DSH 入口（相对/裸名会按工作目录或 PATH 解析）';
    }
    return null;
  }
  if (!isAbsolute(entry)) {
    return 'DSH 入口不接受相对路径（会按调用方工作目录解析；沙箱实例的该目录沙箱内可写）';
  }
  let real = null;
  try { real = rp(entry); } catch { /* 不存在/不可解析：下面按 fail-closed 判 */ }
  if (typeof o.allowEntry === 'function') {
    try { if (o.allowEntry(entry, real)) return null; } catch { /* 策略异常：按未放行继续 */ }
  }
  if (real === null) return 'DSH 入口不存在或不可解析（fail-closed）：' + entry;
  for (const f of (Array.isArray(o.files) ? o.files : [])) {
    try { if (rp(f) === real) return null; } catch { /* 候选不存在：跳过 */ }
  }
  for (const r of (Array.isArray(o.roots) ? o.roots : [])) {
    let rr; try { rr = rp(r); } catch { continue; }
    const base = String(rr).replace(/[\\/]+$/, '');
    if (real === base || real.indexOf(base + path.sep) === 0) return null;
  }
  return 'DSH 入口不在允许位置（须为该实例安装根之下的入口，或内核解析出的已知 DSH 入口）：' + entry;
}

module.exports = {
  resolveExecutable, candidateNames, standardDirs, npmBin, npxBin, resolveDsh, dshJsIn,
  knownDshEntries, commandEntryViolation,
};
