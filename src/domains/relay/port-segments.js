'use strict';

// relay 域端口段声明（DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」）。
// 结构门禁 DS-G4 要求 platform 源码（去注释）不得出现业务域名词，relay 段作为域知识在此申报；
// platform 端口注册表只提供通用池与分配算法。require 即申报（顶层副作用，模块缓存保证幂等）。
// 未申报时行为与反转前一致：未注册段回退通用池 managed（relay 本就落在该池）。

const ports = require('../../platform/service/ports');

/** 逻辑段到物理池的映射。relay 与反代实例/回调共用通用共享池（K8s 单一范围思想）。 */
// anchor 是池内显式起点（与申报顺序无关）。
const SEGMENTS = {
  relay: { pool: 'managed', anchor: 0 },
};

ports.registerSegment(SEGMENTS);

// 零外部消费者：本模块唯一对外契约是 require 即申报的顶层副作用；SEGMENTS 仅供上面 registerSegment 使用。
module.exports = {};
