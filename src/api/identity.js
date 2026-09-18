'use strict';

// api/identity —— re-export shim（DIRECTORY-STRUCTURE-DESIGN §2.2/§3）：
// 纯 IP 事实转出 src/shared/ip.js，HTTP 身份转出 src/platform/security/identity.js。
//
// 实际消费者（2026-09-17 复核）：生产侧 src/api/security.js（isPrivateIpv4）与
//   src/api/transport/server.js（identify）；测试侧 test/relay-source-gate-test.js 与
//   test/lan-access-boundary-test.js **按路径 require 本文件**。
//   （原头注称消费者含 api/index.js —— 实测零引用，已更正。）
//
// 移除条件（须同时满足全部，缺一即转红）：security.js 与 transport/server.js 改直引真实
//   归属路径；上述两个测试改 require 真实归属路径；且 test/lan-access-boundary-test.js
//   的 E-g 判据不再硬匹配 require('./identity') 的解构形态。
//   在此之前只做 re-export，不得写入任何判定逻辑（否则又成「同一事实两份实现」）。

const { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 } = require('../shared/ip');
const { identify } = require('../platform/security/identity');

module.exports = {
  identify,
  normalizeRemoteAddress,
  isPrivateIpv4,
  isLoopbackAddress,
};
