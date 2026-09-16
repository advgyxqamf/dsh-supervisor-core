'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// router 域端口段/池声明（DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」）
//
// 结构门禁 DS-G4 要求 platform 源码（去注释）不得出现业务域名词。端口注册表
// （platform/service/ports）因此只保留**通用**机制：物理池 + 分配算法 + 注册接口，
// 段名（proxyInstance/oauthCallback/providerApi）与独立池（providerApi）作为**域知识**
// 在此申报。
//
// 本模块 require 即申报（模块顶层副作用，Node 模块缓存保证幂等）：
//   · registerPools   —— 申报额外物理池（providerApi 独立池，base/count = 反转前字面量）
//   · registerSegment —— 申报「逻辑段 → 物理池」映射
// 由本域各入口（index/providers/proxy/router-ops/daemon）require，确保任何消费点使用前已就位。
// 未申报时 platform 的行为与反转前逐字一致：未注册段一律回退通用池 managed。
// ═══════════════════════════════════════════════════════════════════════════

const ports = require('../../platform/service/ports');

/** router 域独立池。base/count = 反转前 platform DEFAULT_POOLS.providerApi 的字面量，逐字未改。 */
const POOLS = {
  providerApi: { base: 24000, count: 2000 },  // 智能路由每供应商独立 API 端点（24000-25999，可容 2000 供应商）
};

/** 逻辑段 → 物理池。值 = 反转前 platform SEGMENT_POOL 的映射，逐字未改。 */
// anchor = 池内显式起点（原实现按「同池段序 × 1000」得出同值，现显式固定 → 与申报顺序无关）。
const SEGMENTS = {
  proxyInstance: { pool: 'managed', anchor: 1000 },
  oauthCallback: { pool: 'managed', anchor: 2000 },
  providerApi: { pool: 'providerApi', anchor: 0 },
};

/** 本域自治段在共享注册表 owner 字段上的前缀（端口段迁出/清理的判据）。 */
const OWNER_PREFIXES = ['proxy:', 'providerApi:'];

ports.registerPools(POOLS);
ports.registerSegment(SEGMENTS);

module.exports = { POOLS, SEGMENTS, OWNER_PREFIXES };
