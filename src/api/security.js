'use strict';

// api/security —— HTTP 层安全判定：Host/Origin 深化校验与访问密钥比较的唯一归属处。
//
// 分层职责（三层，职责单一）：
//   1. 身份层（../platform/security/identity.js，socket 事实）：回环/私有网段判定，
//      token 下发、access-key 豁免只消费该层；公网来源连不上（远端地址非 RFC1918/回环）。
//   2. CSRF 深化层（originAllowed）：带 Origin 的写请求须与本服务同源，防"用户浏览器
//      里的恶意网页"驱动 API；身份层不覆盖该威胁（浏览器发起的请求源 IP 是合法的）。
//   3. 访问密钥层（apiAccessKey，可选）：非回环请求须携带 Bearer/?access_key=。
//   不返回 CORS 头（面板同源托管 + 壳源白名单），其他网站浏览器读不到响应。

const crypto = require('node:crypto');

// 安全信任根：访问者身份 = socket 层事实（req.socket.remoteAddress），唯一判定实现见
// ./identity.js。请求头（Host/Origin）只做浏览器语义的深化校验，绝不参与身份/鉴权判定。
// `isPrivateIpv4` 与 identity 同一份 RFC1918 判定（Host/Origin 闸复用，不重写）。
// 本文件仍经 ./identity shim 取用（兼容门面，移除条件见其头注）。
const { isPrivateIpv4 } = require('./identity');

// CSRF 深化校验（第二层）：请求须与本服务同源且同主机。信任集合 = 回环 ∪ RFC1918 私有网段。
//   - Host 头（若有）必须是本机或局域网名，防 DNS-rebinding
//     （攻击者把 evil.com 解析到 127.0.0.1，浏览器会带 `Host: evil.com`，被拒）。
//   - Origin（只影响带 Origin 的请求）：壳内 webview（tauri://localhost）合法（面板就在壳里）；
//     其余必须是本机/局域网名 + 本服务端口。
// CORS 只挡读取，不挡 CSRF 的副作用：旧实现只比较端口，恶意页可从 `http://任意域:36360`
// 发起请求（端口匹配即放行，且 socket 层看到的是回环、连 apiAccessKey 都被豁免）。
// 注意：若 Host/Origin 闸只查回环，开启局域网访问后写操作会全 403（详见 isLocalOrLanHost）。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 是否为本机回环主机名（含 IPv6 方括号形态）。 */
function isLoopbackHost(h) {
  if (!h) return false;
  return LOOPBACK_HOSTS.has(String(h).toLowerCase());
}

/**
 * 是否为「本机或局域网」主机名 —— Host/Origin 闸的信任集合。
 *
 * 为什么必须有它：开启「局域网访问」（apiHost=0.0.0.0）后，局域网浏览器带的
 *   `Host: 192.168.x.x:36360` 若只按回环判定会被一律拒绝：面板 GET 能打开
 *   （静态资源不走 originAllowed），但所有写操作静默 403，与「只允许本机与 RFC1918」
 *   的声明完全相反。
 *
 * 修法：复用 identity.js 的 RFC1918 判定（`isPrivateIpv4`），不在此重写第二份。
 *
 * 安全影响：不放宽对公网的拒绝，私有网段之外的 Host（如 evil.com）仍被拒；
 *   DNS-rebinding 防护语义不变（依赖「Host 不是本机/局域网名」）。
 *   局域网来源仍须通过第三层（apiAccessKey，非回环请求强制），写请求仍须 Origin 同源。
 */
function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  const bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (bare === '::1') return true;
  // RFC1918 私有 IPv4（与 identity.isPrivateIpv4 同一份判定）
  return isPrivateIpv4(bare);
}

/** 壳（Tauri webview）的来源：唯一被接受的非 HTTP 来源。 */
function isShellOrigin(protocol, hostname) {
  if (protocol !== 'tauri:') return false;
  return hostname === 'localhost' || /(^|\.)tauri\.localhost$/.test(hostname);
}

/** 主机名归一（小写 + 去 IPv6 方括号），用于 Host/Origin 主机一致性比较。 */
function normalizeHostname(h) {
  const s = String(h || '').toLowerCase();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

function originAllowed(req, apiPort) {
  // 闸 1：Host 头（防 DNS-rebinding）
  //   浏览器会把 URL 里的域名放进 Host；若它不是回环名，
  //   说明请求来自「被解析到 127.0.0.1 的外部域名」，拒绝。
  const host = req.headers.host;
  let hostname = '';
  if (host) {
    // Host 形如 `127.0.0.1:36360` / `[::1]:36360` / `evil.com`
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    hostname = m ? m[1] : String(host).trim();
    if (!isLocalOrLanHost(hostname)) return false;
  }

  // 闸 2：Origin（哪些页面能驱动本 API）
  const o = req.headers.origin;
  if (!o) return true; // curl / CLI / 同源 GET 无 Origin
  try {
    const u = new URL(o);
    if (isShellOrigin(u.protocol, u.hostname)) return true;
    // Origin 同样接受私有网段（局域网设备的浏览器就是合法面板来源）。
    if (!isLocalOrLanHost(u.hostname)) return false;
    // 主机一致性（防 LAN CSRF）：Origin 主机必须与请求实际到达的 Host 相同。
    // 旧实现只比较端口 -> 局域网内任意主机上端口相同的恶意页面
    // （如 http://192.168.1.5:36360）可驱动本 API；socket 层看到的是合法私网来源，
    // 身份层与访问密钥层都不拦。壳来源（tauri://）已在上方放行，不受此比较影响。
    if (host && normalizeHostname(u.hostname) !== normalizeHostname(hostname)) return false;
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

/** 常数时间字符串比较（防时序侧信道）。 */
function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 请求是否携带正确的出回环访问密钥（apiAccessKey，F2 定案）：
 *  Authorization: Bearer <key> 或 ?access_key=<key> 二选一（常数时间比较）。
 *  无密钥配置时恒放行（本函数不调用：调用侧仅在配置了 key 且非回环请求时才走门卫）。 */
function requestHasAccessKey(req, key) {
  if (!key) return true;
  const ah = req.headers.authorization;
  if (typeof ah === 'string' && ah.startsWith('Bearer ') && safeKeyEqual(ah.slice(7), key)) return true;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('access_key');
    if (q && safeKeyEqual(q, key)) return true;
  } catch {}
  return false;
}

module.exports = { originAllowed, isLocalOrLanHost, isShellOrigin, isLoopbackHost, requestHasAccessKey };
