'use strict';

// 平台化浏览器打开：三端同一 open(url) 接口；仅接受本机回环 URL（调用方已校验），失败返回 false。
// launchIsolated 把「隔离 profile + 无痕 + 反指纹参数打开浏览器」的平台差异收敛到平台层，
// 调用方只提供策略参数，不再出现 process.platform 分支与二进制名。

// 异步 spawn 统一封装（固定 windowsHide:true）；浏览器打开完全脱离本进程，
// 用 detachedIgnored（detached + stdio ignore）。
const spawnOS = require('./spawn');

/** 平台到打开 URL 的命令（纯函数，可穷举；不 spawn）。
 *  Windows 的 start 第一个参数是窗口标题，必须显式给空串，否则 URL 被当标题、浏览器不打开。
 *  未知平台有意退化为 xdg-open（best-effort 且失败静默）：这里不宣称任何能力，只尽力尝试；
 *  与 autostart 不同 —— 那里要向用户宣称服务管理器 kind，故未知平台必须显式 none。 */
function openCommand(platform, url) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return { cmd: 'open', args: [url] };
  if (pl === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

function open(url) {
  try {
    const c = openCommand(process.platform, url);
    const p = spawnOS.detachedIgnored(c.cmd, c.args);
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function _spawnDetached(bin, args, env, onExit) {
  let child;
  try { child = spawnOS.detachedIgnored(bin, args, { env: env || process.env }); }
  catch { return null; }
  child.on('error', () => {});
  if (typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
  child.unref();
  return child;
}

/** 平台到隔离打开的命令规划（纯函数，可穷举；不 spawn）。
 *  返回 {kind:single,bin,args,isolated} 或 {kind:chain,candidates}（linux 按可用性依次尝试）。
 *  Windows 有意只传 --incognito + --user-data-dir，不传 antiArgs：cmd start 对含引号/反斜杠的
 *  参数转义脆弱，宁可少传也不传坏（用断言固定，防止顺手补全反而引入转义 bug）。
 *  @param {{profileDir?:string, antiArgs?:string[]}} [opts] */
function isolatedPlan(platform, url, opts) {
  const o = opts || {};
  const antiArgs = o.antiArgs || [];
  const profileDir = o.profileDir;
  const pl = platform || process.platform;
  if (pl === 'darwin') {
    return { kind: 'single', bin: 'open', args: ['-na', 'Google Chrome', '--args', ...antiArgs], isolated: true, label: 'Google Chrome' };
  }
  if (pl === 'win32') {
    return {
      kind: 'single', bin: 'cmd',
      args: ['/c', 'start', '', 'chrome', '--incognito', '--user-data-dir=' + profileDir, url],
      isolated: true, label: 'chrome',
    };
  }
  // Linux（及未知平台，同 openCommand 的有意退化）：候选按「防风控强度 + 可用性」排序
  return {
    kind: 'chain',
    candidates: [
      { bin: 'microsoft-edge', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'microsoft-edge-stable', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'google-chrome', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'chromium', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'chromium-browser', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'firefox', args: ['--private-window', url], isolated: false, watch: true, envKind: 'sys' },
      { bin: 'xdg-open', args: [url], isolated: false, watch: false, envKind: 'sys' }, // 兜底：无隔离
    ],
  };
}

/**
 * 以隔离 profile + 无痕打开浏览器（OAuth 反指纹登录用）。
 * @param {string} url
 * @param {{profileDir:string, antiArgs?:string[], antiEnv?:object, sysEnv?:object, onExit?:Function}} o
 * @returns {{ok:boolean, bin:string|null, isolated:boolean}} bin=null 表示全部候选失败
 */
function launchIsolated(url, o) {
  const opts = o || {};
  const profileDir = opts.profileDir;
  const antiArgs = opts.antiArgs || [];
  const antiEnv = opts.antiEnv || opts.sysEnv || process.env;
  const sysEnv = opts.sysEnv || process.env;
  const onExit = opts.onExit;
  try {
    const plan = isolatedPlan(process.platform, url, { profileDir, antiArgs });
    if (plan.kind === 'single') {
      const env = plan.bin === 'open' ? antiEnv : sysEnv;
      const p = _spawnDetached(plan.bin, plan.args, env, onExit);
      return { ok: !!p, bin: p ? plan.label : null, isolated: plan.isolated };
    }
    let idx = 0;
    const tryNext = () => {
      if (idx >= plan.candidates.length) return { ok: false, bin: null, isolated: false };
      const c = plan.candidates[idx++];
      const env = c.envKind === 'anti' ? antiEnv : sysEnv;
      let child;
      try { child = spawnOS.detachedIgnored(c.bin, c.args, { env: env || sysEnv }); }
      catch { return tryNext(); }
      // bin 不存在 -> 下一个候选（error 事件同步触发，故递归前先注册）
      child.on('error', () => { tryNext(); });
      if (c.watch && typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
      child.unref();
      return { ok: true, bin: c.bin, isolated: c.isolated };
    };
    return tryNext();
  } catch { return { ok: false, bin: null, isolated: false }; }
}

module.exports = { open, launchIsolated, openCommand, isolatedPlan };
