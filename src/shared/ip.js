'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// IP 地址判定（纯函数）—— 目录结构设计 DIRECTORY-STRUCTURE-DESIGN §2.2 / D6
//
// 归属裁决：这些是**平台事实**（地址语义），无 HTTP 语义。
//   原先住在 api/identity.js → 被 domains/relay 反向依赖（domains→api 违规边）。
//   现拆两半：
//     · 纯 IP 事实 → 本文件（shared/，出度 0）
//     · HTTP 请求→socket 事实 → platform/security/identity.js
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

module.exports = { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 };
