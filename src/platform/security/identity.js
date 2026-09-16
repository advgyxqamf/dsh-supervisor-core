'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 请求身份判定（请求 → socket 事实）—— DIRECTORY-STRUCTURE-DESIGN §2.2 / D6
//
// 归属裁决（2026-09-16 结构设计）：
//   · **纯 IP 事实**（normalize/isLoopback/isPrivateIpv4）→ `src/shared/ip.js`
//     （L0 纯函数层：零依赖、零 IO、出度恒 0）
//   · **HTTP 身份**（socketIsLoopback / identify）→ **本文件**
//   原先两者同住 `api/identity.js`，导致 `domains/relay` 为复用 IP 判定而
//   **反向依赖 api 层**（domains→api 违规边）。拆开后 relay 走 shared/ip，
//   本文件只服务 api 层，该违规边归零。
//
//   为什么 HTTP 部分不放进 shared/：
//     shared 是「零依赖、零 IO 的纯函数层」，而本函数消费 `req`（HTTP 请求
//     对象）—— 那是**传输层概念**，不属于纯事实，放进 shared 会污染其 L0 契约。
//   为什么放 platform/security 而不是留在 api/：
//     socket 来源判定是**平台安全事实**（token 下发与 access-key 豁免的唯一
//     依据）。未来 api/index.js 拆出 api/security.js 后由 api 直接引用，
//     api 层只做传输，不再承载安全判定的实现。
//
// 信任根（唯一）：`req.socket.remoteAddress` —— 操作系统层的连接事实，
// 客户端无法伪造。请求头（Host/Origin/Referer）属于「浏览器语义」数据，
// 绝不参与身份/鉴权判定。
// ═══════════════════════════════════════════════════════════════════════════

// 复用 shared/ip 的**唯一实现**——绝不在本文件重写第二份 IP 判定
//   （「同一事实两处实现、其中一处漏改」正是本仓反复出问题的形态）。
// 注：platform→shared 是 §2.2 矩阵允许的向下依赖，并已在
//   test/layering-and-dependency-gate-test.js 的 CROSS_LAYER 显式登记。
const { normalizeRemoteAddress, isLoopbackAddress } = require('../../shared/ip');

/** 是否来自本机回环（socket 事实）。 */
function socketIsLoopback(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

/** 请求身份快照（每请求一次，分派器写入 ctx；域内不得重复判定）。
 *
 *  只保留**真正被消费**的两个字段：
 *    · `remote`   —— 诊断/日志用（原始 socket 地址归一化）
 *    · `loopback` —— token 下发与 access-key 豁免的唯一依据
 */
function identify(req) {
  return {
    remote: normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress),
    loopback: socketIsLoopback(req),
  };
}

module.exports = { socketIsLoopback, identify };
