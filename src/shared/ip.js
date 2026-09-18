'use strict';

// IP 地址纯函数（L0，出度 0）。原在 api/identity.js，被 domains/relay 反向依赖后拆出：
// 纯 IP 事实归本文件；HTTP 请求到 socket 的事实见 platform/security/identity.js。

/** 规范 socket 远端地址：IPv4-mapped IPv6（::ffff:a.b.c.d）归一为 IPv4 字面量。 */
function normalizeRemoteAddress(ra) {
  if (typeof ra !== 'string' || !ra) return null;
  // Node 对 IPv4-mapped IPv6 呈现 ::ffff:a.b.c.d
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

module.exports = { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 };
