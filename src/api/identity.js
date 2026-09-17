'use strict';

// api/identity —— re-export shim（DIRECTORY-STRUCTURE-DESIGN §2.2/§3）：
// 纯 IP 事实转出 src/shared/ip.js，HTTP 身份转出 src/platform/security/identity.js；
// 消费者（api/index.js、test/lan-access-boundary、test/relay-source-gate）零改动。
//
// 移除条件（须同时满足）：api/index.js 与 api/security.js 改直引真实归属路径，
// 且上述测试改 require 真实归属路径。在此之前只做 re-export，不得写入任何判定逻辑
//（否则又成「同一事实两份实现」）。

// 纯 IP 事实：唯一实现在 shared/ip.js —— 此处仅转出，绝不重写第二份。
const { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 } = require('../shared/ip');
// HTTP 身份：唯一实现在 platform/security/identity.js —— 此处仅转出。
const { identify } = require('../platform/security/identity');

module.exports = {
  identify,
  // 纯 IP 事实 re-export（保持既有消费者零改动）
  normalizeRemoteAddress,
  isPrivateIpv4,
  isLoopbackAddress,
};
