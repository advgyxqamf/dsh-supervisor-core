'use strict';

// relay 域纯层（DL-G8：不 require node:fs/http/https/net/child_process）。
// 只放判定与构造：来源信任、常数时间比较、令牌门卫决策、Cookie 取值、HTML polyfill 常量、
// frpc.toml 文本生成、frp 设置归一、公网暴露安全闸；副作用一律留在 proxy/session/tunnel/frp 等 IO 层。

const crypto = require('node:crypto');
// 来源必须落在回环或 RFC1918 私有网段；复用 shared/ip 的同一份判定，绝不在本域重写第二份。
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');

/** 来源地址是否可信（回环 ∪ RFC1918）。
 *
 *  relay 监听 0.0.0.0 且把 Origin/Referer 改写成回环权威（「回环呈现」），故「谁连得上」等于
 *  「谁拿到 DSH 特权面」；本闸把可达来源收窄到回环与私有网段。注意这不等于鉴权：私网内仍是
 *  共享信任域，只是堵住了暴露到公网这一档。
 *  @param req  HTTP 请求（取 req.socket.remoteAddress）
 *  @param sock 可选的原始 socket（Upgrade 路径的 socket）
 */
function isTrustedSource(req, sock) {
  const addr = (req && req.socket && req.socket.remoteAddress)
    || (sock && sock.remoteAddress)
    || '';
  if (!addr) return false;
  // Node 对 IPv4-mapped IPv6 呈现 ::ffff:a.b.c.d —— 归一到 IPv4 字面量后再判定。
  const norm = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
    ? addr.replace(/^::ffff:/i, '')
    : addr.toLowerCase();
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
}

/** 常数时间比较（先 sha256 归一到定长，避免长度侧信道）。 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 提取 Cookie 头中给定名字的值（只按分号切段，不做通用 Cookie 解析）。 */
function cookieByName(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return null;
}

/** 请求是否携带有效令牌（URL ?token= 或 Cookie）。纯判定，无 IO。 */
function hasValidToken(req, token) {
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      return safeEqual(decodeURIComponent(m[1]), token);
    } catch {
      return false;
    }
  }
  return false;
}

/** 令牌门卫决策（HTTP 响应路径）。纯函数，应答由调用方落笔。
 *  @returns {ok:true} 放行；
 *           {ok:false, redirect, cookie} 首次凭 URL 令牌进入，302 种 HttpOnly Cookie；
 *           {ok:false, unauthorized:true} 401。
 */
function tokenGateDecision(req, token) {
  if (!token) return { ok: true };
  const url = new URL(req.url, 'http://localhost');
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      if (safeEqual(decodeURIComponent(m[1]), token)) return { ok: true };
    } catch {}
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) {
    return {
      ok: false,
      redirect: url.pathname,
      cookie: 'dsh_lan_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax',
    };
  }
  return { ok: false, unauthorized: true };
}

// 非回环 HTTP 源上 crypto.randomUUID 不存在（secure-context-only），
// 而 DSH 客户端用它生成每个 RPC 的 id —— 缺失即所有请求抛错、WS 就绪握手失败。
// 反代在 HTML 注入此 polyfill，使局域网源的客户端获得等价能力。
const POLYFILL_SCRIPT = `<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += (i === 4 || i === 6 || i === 8 || i === 12 ? '-' : '') + ('0' + b[i].toString(16)).slice(-2);
    return h;
  };
}
</script>`;

/** settings 与 instances 生成 frpc.toml 文本（纯，无 IO）。
 *  loginFailExit 必须为 false：frpc 默认 true 时首次连不上 frps 即退出且不重试，隧道永久失效；
 *  置 false 让 frpc 自身持续重连。wanPort 未分配时不得写出无效 [[proxies]]。
 *  @returns {{ text:string, count:number }}
 */
function buildFrpcToml(settings, instances) {
  const s = settings || {};
  const lines = [];
  lines.push('serverAddr = "' + (s.serverAddr || '').replace(/"/g, '') + '"');
  lines.push('serverPort = ' + (Number(s.serverPort) || 7000));
  if (s.authToken) lines.push('auth.token = "' + String(s.authToken).replace(/"/g, '') + '"');
  lines.push('loginFailExit = false');
  lines.push('');
  let count = 0;
  for (const inst of instances || []) {
    if (!inst.frpEnabled || !inst.frpRemotePort || !Number.isInteger(inst.wanPort) || inst.wanPort <= 0) continue;
    const name = (s.user || 'dsh') + '-lan-' + String(inst.id).slice(-8);
    lines.push('[[proxies]]');
    lines.push('name = "' + name.replace(/"/g, '') + '"');
    lines.push('type = "tcp"');
    lines.push('localIP = "127.0.0.1"');
    lines.push('localPort = ' + inst.wanPort);
    lines.push('remotePort = ' + inst.frpRemotePort);
    lines.push('');
    count++;
  }
  return { text: lines.join('\n'), count };
}

/** frp 设置归并（patch 覆盖现值，纯）。 */
function normalizeFrpSettings(patch, current) {
  const j = patch || {};
  const cur = current || {};
  return {
    enabled: j.enabled !== undefined ? !!j.enabled : cur.enabled,
    serverAddr: String(j.serverAddr !== undefined ? j.serverAddr : cur.serverAddr).trim(),
    serverPort: Number(j.serverPort) || cur.serverPort,
    authToken: String(j.authToken !== undefined ? j.authToken : cur.authToken),
    user: String(j.user || cur.user || 'dsh'),
  };
}

/** frp 服务器地址前置校验（纯）：serverAddr 为空时 frpc 只会连到空地址、永不建隧道。
 *  ops.frpAction('settings') 仅在「启用」时据此拒启（关闭方向仍可保存空值）；
 *  frp.start() 在执行边界对任何 spawn 无条件复校。 */
function validateFrpServerSettings(settings) {
  const s = settings || {};
  if (!String(s.serverAddr || '').trim()) {
    return { ok: false, error: '启用 frp 前必须填写服务器地址（serverAddr）' };
  }
  return { ok: true };
}

/** 公网暴露（frp）安全闸（纯）：relay 空 token 恒放行 + 回环呈现，公网可零认证触达特权 API。
 *  开启前强制要求已设访问令牌，并做端口合法性与实例间占用校验。
 *  单一事实源：app 侧 patchDshMain 与 relay 侧 setFrp 必须调用本函数，不得各写一份。
 *  @param {boolean} enabled
 *  @param {string} remoteToken
 *  @param {number|string} frpRemotePort
 *  @param {Array} peers  受管清单（含 id/name/frpEnabled/frpRemotePort）
 *  @param {string} selfId 当前实例 id（端口占用校验排除自身）
 *  @returns {{ok:true, port?:number}} 或 {{ok:false, error:string}}
 */
function validateFrpExposure({ enabled, remoteToken, frpRemotePort, peers, selfId }) {
  if (!enabled) return { ok: true };
  if (!String(remoteToken || '').trim()) {
    return { ok: false, error: '开启公网暴露前请先为该实例设置远程访问令牌（remoteToken），否则 DSH 特权接口将对公网完全开放' };
  }
  const port = parseInt(frpRemotePort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效的公网端口' };
  const clash = (peers || []).find((x) => x.id !== selfId && x.frpRemotePort === port && x.frpEnabled);
  if (clash) return { ok: false, error: '公网端口 ' + port + ' 已被实例「' + clash.name + '」占用' };
  return { ok: true, port };
}

module.exports = {
  isTrustedSource,
  cookieByName,
  hasValidToken,
  tokenGateDecision,
  POLYFILL_SCRIPT,
  buildFrpcToml,
  normalizeFrpSettings,
  validateFrpServerSettings,
  validateFrpExposure,
};
