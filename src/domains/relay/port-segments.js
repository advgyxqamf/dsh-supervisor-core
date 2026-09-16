'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// relay 域端口段声明（DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」）
//
// 结构门禁 DS-G4 要求 platform 源码（去注释）不得出现业务域名词。relay 段作为
// **域知识**在此申报；platform 的端口注册表只提供通用池与分配算法。
// require 即申报（模块顶层副作用，Node 模块缓存保证幂等）。
// 未申报时行为与反转前逐字一致：未注册段回退通用池 managed（relay 本就落在该池）。
// ═══════════════════════════════════════════════════════════════════════════

const ports = require('../../platform/service/ports');

/** 逻辑段 → 物理池。relay 与反代实例/回调共用通用共享池（K8s 单一范围思想）。 */
// anchor = 池内显式起点（原实现按「同池段序 × 1000」得出同值，现显式固定 → 与申报顺序无关）。
const SEGMENTS = {
  relay: { pool: 'managed', anchor: 0 },
};

ports.registerSegment(SEGMENTS);

module.exports = { SEGMENTS };
