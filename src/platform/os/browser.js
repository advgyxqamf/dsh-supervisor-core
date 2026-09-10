'use strict';

// 平台化浏览器打开：三端同一 open(url) 接口（2024 起 Linux 也可走 xdg-open）。
// 仅接受本机回环 URL（调用方已校验）；失败返回 false。
//
// launchIsolated（跨平台审计 §7.1）：把「以隔离 profile + 无痕 + 反指纹参数打开浏览器」的
// **平台差异**（mac 的 `open -na`、Windows 的 `cmd start` 与参数转义、Linux 的候选二进制顺序）
// 收敛到平台层；调用方（router-ops）只提供策略参数，不再出现 process.platform 分支与二进制名。

const { spawn } = require('node:child_process');

function open(url) {
  try {
    const p = process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function _spawnDetached(bin, args, env, onExit) {
  let child;
  try { child = spawn(bin, args, { detached: true, stdio: 'ignore', env: env || process.env }); }
  catch { return null; }
  child.on('error', () => {});
  if (typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
  child.unref();
  return child;
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
    if (process.platform === 'darwin') {
      const p = _spawnDetached('open', ['-na', 'Google Chrome', '--args', ...antiArgs], antiEnv, onExit);
      return { ok: !!p, bin: p ? 'Google Chrome' : null, isolated: true };
    }
    if (process.platform === 'win32') {
      // cmd start 对复杂参数转义脆弱：仅传 incognito + 独立 profile
      const p = _spawnDetached('cmd', ['/c', 'start', '', 'chrome', '--incognito', '--user-data-dir=' + profileDir, url], sysEnv, onExit);
      return { ok: !!p, bin: p ? 'chrome' : null, isolated: true };
    }
    // Linux：候选按「防风控强度 + 可用性」排序：Edge → Chrome → Chromium → Firefox 无痕 → xdg-open 兜底
    const candidates = [
      { bin: 'microsoft-edge', args: antiArgs, env: antiEnv, isolated: true, watch: true },
      { bin: 'microsoft-edge-stable', args: antiArgs, env: antiEnv, isolated: true, watch: true },
      { bin: 'google-chrome', args: antiArgs, env: antiEnv, isolated: true, watch: true },
      { bin: 'chromium', args: antiArgs, env: antiEnv, isolated: true, watch: true },
      { bin: 'chromium-browser', args: antiArgs, env: antiEnv, isolated: true, watch: true },
      { bin: 'firefox', args: ['--private-window', url], env: sysEnv, isolated: false, watch: true },
      { bin: 'xdg-open', args: [url], env: sysEnv, isolated: false, watch: false }, // 兜底：无隔离
    ];
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return { ok: false, bin: null, isolated: false };
      const c = candidates[idx++];
      let child;
      try { child = spawn(c.bin, c.args, { detached: true, stdio: 'ignore', env: c.env || sysEnv }); }
      catch { return tryNext(); }
      // bin 不存在 → 下一个候选（error 事件同步触发，故递归前先注册）
      child.on('error', () => { tryNext(); });
      if (c.watch && typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
      child.unref();
      return { ok: true, bin: c.bin, isolated: c.isolated };
    };
    return tryNext();
  } catch { return { ok: false, bin: null, isolated: false }; }
}

module.exports = { open, launchIsolated };
