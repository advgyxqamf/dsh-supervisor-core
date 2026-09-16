'use strict';

// api/security —— HTTP 层安全判定（步骤 9 拆分：从 index.js 按职责切出）。
//
// 为什么单独成文件：
//   index.js 原先同时承载「安全模型 + 传输 + 静态托管 + UI 目录探测」四种职责，
//   既难审阅，也让安全逻辑无法被测试定点驱动。拆分后本文件是 Host/Origin 深化校验
//   与访问密钥比较的**唯一归属处**；网关只做门卫调用与分派。
//
// 分层职责不变（三层，职责单一）：
//   1. 身份层（../platform/security/identity.js，socket 事实）：回环/私有网段判定——
//      token 下发、access-key 豁免只消费该层；公网来源连不上（远端地址非 RFC1918/回环）。
//   2. CSRF 深化层（originAllowed）：带 Origin 的写请求须与本服务同源——防"用户浏览器
//      里的恶意网页"驱动 API；身份层不覆盖该威胁（浏览器发起的请求源 IP 是合法的）。
//   3. 访问密钥层（apiAccessKey，可选）：非回环请求须携带 Bearer/?access_key=。
//   不返回 CORS 头（面板同源托管 + 壳源白名单）→ 其他网站浏览器读不到响应。

const crypto = require('node:crypto');

// 安全信任根（P0-1 结构性修复）：访问者身份 = socket 层事实（req.socket.remoteAddress），
// 唯一判定实现见 ./identity.js。请求头（Host/Origin）只做浏览器语义的深化校验，
// 绝不参与身份/鉴权判定——详见 identity.js 头注与 DESIGN.md 安全边界契约。
// P1-E：`isPrivateIpv4` 与 identity 同一份 RFC1918 判定（Host/Origin 闸复用，不重写）。
// ⚠ 本文件仍经 ./identity shim 取用：identity.js 是步骤 2 建立的兼容门面（其移除条件
//   写在该文件头注）。此处只做「结构搬家」，不改 require 目标，避免与并行重构双改冲突。
const { isPrivateIpv4 } = require('./identity');

// CSRF 深化校验（第二层）：请求须与本服务**同源且同主机**。
//
// ⚠ 2026-09-11 修复（安全，K6）：旧实现**只比较端口** ——
//   恶意页可从 `http://任意域:36360` 发起请求：Origin 端口匹配即放行；
//   而 socket 层看到的是回环（浏览器代发）→ identity.loopback=true →
//   连 apiAccessKey 都被豁免。CORS 只挡**读取**，不挡 CSRF 的**副作用**，
//   于是 stop / upgrade / uninstall / restart-guard / settings 全可被驱动。
//
//   同时 identity.js 明确声称「Host 头：仅用于防 DNS-rebinding 的深化校验」，
//   但**实现里从未读取过 req.headers.host** —— 又一处「注释声称、代码没有」。
//
// 现按声称补齐双闸（P1-E 修复后，信任集合 = 回环 ∪ RFC1918 私有网段）：
//   ① Host 头（若有）必须是**本机或局域网**名 —— 防 DNS-rebinding
//      （攻击者把 evil.com 解析到 127.0.0.1，浏览器会带 `Host: evil.com` → 被拒）；
//   ② Origin（只影响带 Origin 的请求）：
//      · 壳内 webview（tauri://localhost）→ 合法（面板就在壳里）；
//      · 其余必须是**本机/局域网**名 + 本服务端口。
//
// ⚠ 2026-09-12（P1-E）：此处曾只查回环，与上方的「只允许本机与 RFC1918」声明白相矛盾 ——
//   开启局域网访问后面板能开、写操作全 403。详见 isLocalOrLanHost 的说明。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 是否为本机回环主机名（含 IPv6 方括号形态）。 */
function isLoopbackHost(h) {
  if (!h) return false;
  return LOOPBACK_HOSTS.has(String(h).toLowerCase());
}

/**
 * 是否为「本机或局域网」主机名 —— Host/Origin 闸的**信任集合**（P1-E 修复，2026-09-12）。
 *
 * ⚠ 为什么必须有它：index.js 头部（与本函数上方注释）**明文声称**
 *   「只允许本机(回环)与 **RFC1918 私有 IP** 的 Host/Origin」，
 *   而闸①②此前只查 `LOOPBACK_HOSTS` —— 于是开启「局域网访问」（apiHost=0.0.0.0）后，
 *   局域网浏览器带的 `Host: 192.168.x.x:36360` 一律被拒：
 *     · 面板 GET 能打开（静态资源不走 originAllowed）；
 *     · 但**所有写操作静默 403** —— 与注释承诺的行为**完全相反**。
 *
 *   实测（直调 originAllowed）：LAN Host + LAN Origin = DENY；LAN 无 Origin = DENY。
 *
 * 修法：复用 identity.js 的 **RFC1918 判定**（那里已有 `isPrivateIpv4`），
 *   而不是在此重写一遍 —— 「同一事实两处实现」正是本仓反复出现的失效模式
 *   （`identity.isPrivateIpv4` 早已实现同一语义，只是 Host 闸从未消费它）。
 *
 * 安全影响：这不放宽对**公网**的拒绝 —— 私有网段之外的 Host（如 evil.com）仍被拒；
 *   DNS-rebinding 防护依赖的是「Host 不是本机/局域网名」，语义不变。
 *   局域网来源仍须通过第三层（apiAccessKey，非回环请求强制）；
 *   且写请求仍须 Origin 同源（闸②）。
 */
function isLocalOrLanHost(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  if (LOOPBACK_HOSTS.has(s)) return true;
  // IPv6 方括号形态 → 去掉括号再判
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

function originAllowed(req, apiPort) {
  // ── 闸 ①：Host 头（防 DNS-rebinding）──
  //   浏览器会把 URL 里的域名放进 Host；若它不是回环名，
  //   说明请求来自「被解析到 127.0.0.1 的外部域名」→ 拒绝。
  const host = req.headers.host;
  if (host) {
    // Host 形如 `127.0.0.1:36360` / `[::1]:36360` / `evil.com`
    const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(host).trim());
    const hostname = m ? m[1] : String(host).trim();
    // P1-E：接受「本机或 RFC1918 私有网段」—— 与文件头声明的信任集合一致。
    if (!isLocalOrLanHost(hostname)) return false;
  }

  // ── 闸 ②：Origin（哪些页面能驱动本 API）──
  const o = req.headers.origin;
  if (!o) return true; // curl / CLI / 同源 GET 无 Origin
  try {
    const u = new URL(o);
    if (isShellOrigin(u.protocol, u.hostname)) return true;
    // P1-E：Origin 同样接受私有网段（局域网设备的浏览器就是合法面板来源）。
    if (!isLocalOrLanHost(u.hostname)) return false;
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

module.exports = { originAllowed, isLocalOrLanHost, isShellOrigin, isLoopbackHost, requestHasAccessKey, safeKeyEqual };
