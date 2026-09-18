'use strict';

// 命令拼装（B9）：纯函数，零 IO / 零 require。缓存优先（~/.npm/_npx 已缓存的包直接用
// node <bin>，零解析/零下载/秒起），缓存未命中则 npx --yes。注意：凭证不在本模块处理，
// {{key}} / --api-key 的剔除是调用方（provider）的凭证纪律，本模块绝不持有或注入密钥。

/** 由 app 模板 + 端口构造 spawn argv（纯）。
 *  @param ctx { app, port, cachedBin, registry, npxBin, execPath }
 *  @returns { ok:boolean, cmd:string[], registry:string|null } */
function buildCommand(ctx) {
  const { app, port, cachedBin, registry, npxBin, execPath } = ctx || {};
  if (!app || !Array.isArray(app.command)) return { ok: false, error: '无效应用命令模板', cmd: [], registry: registry || null };
  if (cachedBin) {
    // 标准参数统一注入（host/port）——api-key 绝不写入 cmdline
    const args = ['--host', '127.0.0.1', '--port', String(port)];
    const STANDARD = new Set(['--host', '--port', '--api-key', 'npx', '--yes']);
    const extra = [];
    const cmdList = app.command;
    for (let i = 0; i < cmdList.length; i++) {
      const t = String(cmdList[i]);
      if (STANDARD.has(t) || t.includes('{{') || (app.pkg && t === app.pkg)) continue;
      if (t === '127.0.0.1' || t === String(port)) continue;
      if (String(t).startsWith('--registry') || t === '--registry') continue;
      if (i > 0 && STANDARD.has(String(cmdList[i - 1]))) continue;
      extra.push(t);
    }
    return { ok: true, cmd: [execPath, cachedBin, ...extra, ...args], registry: registry || null };
  }
  // fallback：npx --yes（首次安装/缓存丢失）——只替换 {{port}}；{{key}}/--api-key 交由调用方剔除
  const mapped = app.command.map((t) => String(t).replace('{{port}}', String(port)));
  const cmd = mapped;
  const args = [...cmd.slice(1)];
  if (cmd[0] === 'npx' && registry) {
    const ri = args.findIndex((a) => a === '--registry');
    if (ri >= 0) args[ri + 1] = registry;
    else { args.unshift(registry); args.unshift('--registry'); }
  }
  const bin = (cmd[0] === 'npx') ? npxBin : cmd[0];
  return { ok: true, cmd: [bin, ...args], registry: registry || null };
}

module.exports = { buildCommand };
