'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 请求身份判定（唯一模块）—— P0-1 结构性修复。
//
// 信任根（唯一）：req.socket.remoteAddress —— 操作系统层的连接事实，
// 客户端无法伪造。请求头（Host/Origin/Referer）属于"浏览器语义"数据：
//   - Host 头：仅用于防 DNS-rebinding 的深化校验（identity 已覆盖其安全职责）；
//   - Origin 头：仅用于防跨站网页驱动的 CSRF 深化校验。
// 任何鉴权/敏感数据下发判定（token 下发、access-key 豁免）只允许消费本模块，
// 绝不允许重新从请求头推断"请求来自哪里"。
// ═══════════════════════════════════════════════════════════════════════════

/** 解析 socket 远端地址为规范 IPv4/IPv6 形态（去除 IPv4-mapped 前缀）。 */
function normalizeRemoteAddress(ra) {
  if (typeof ra !== 'string' || !ra) return null;
  // Node 对 IPv4-mapped IPv6 呈现 ::ffff:a.b.c.d —— 归一为 IPv4 字面量
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ra);
  return m ? m[1] : ra.toLowerCase();
}

function isLoopbackAddress(ra) {
  const a = normalizeRemoteAddress(ra);
  if (!a) return false;
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function isPrivateIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o = Number(m[1]), t = Number(m[2]);
  if (o === 10) return true;
  if (o === 172 && t >= 16 && t <= 31) return true;
  if (o === 192 && t === 168) return true;
  return false;
}

/** 是否来自本机回环（socket 事实）。 */
function socketIsLoopback(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

/** 是否来自本机或 RFC1918 私有网段（socket 事实）——对外 API 的信任边界。
 *  回环之外的来源仍需通过 apiAccessKey 门卫（若有配置）。 */
function socketIsTrusted(req) {
  const a = normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress);
  if (!a) return false;
  return isLoopbackAddress(a) || isPrivateIpv4(a);
}

/** 请求身份快照（每请求一次，分派器写入 ctx；域内不得重复判定）。 */
function identify(req) {
  return {
    remote: normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress),
    loopback: socketIsLoopback(req),
    trusted: socketIsTrusted(req),
  };
}

module.exports = { identify, socketIsLoopback, socketIsTrusted, normalizeRemoteAddress };
