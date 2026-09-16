'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// api/identity —— **re-export shim**（DIRECTORY-STRUCTURE-DESIGN §2.2 / §3 定版）
//
// 为什么保留这个文件而不是直接删掉：
//   实现已按 D6 拆到两处——
//     · 纯 IP 事实 → `src/shared/ip.js`
//     · HTTP 身份   → `src/platform/security/identity.js`
//   但 `api/index.js` 仍以 `require('./identity')` 消费 `identify` / `isPrivateIpv4`，
//   且 `test/lan-access-boundary-test.js`、`test/relay-source-gate-test.js`
//   也直接 require 本路径。保留 shim 让这些消费者**零改动**，
//   使「纯搬家」与「改消费者」两件事解耦——后者是步骤 3 的独立动作。
//
// 【移除条件】——必须**同时**满足，否则删除本文件会打断消费者：
//   1) `api/index.js` 完成 §3 的拆分：安全判定归 `api/security.js`，
//      传输/分派留在 `api/index.js`；
//   2) `api/index.js` 与 `api/security.js` 改为**直接**引用：
//        · `identify`           ← `../platform/security/identity`
//        · `isPrivateIpv4` 等纯 IP ← `../shared/ip`
//   3) 上述两个测试改为 require 真实归属路径。
//   在此之前本文件**只做 re-export，不得再写任何判定逻辑**
//   （否则又变成「同一事实两份实现」——本仓反复出问题的形态）。
// ═══════════════════════════════════════════════════════════════════════════

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
