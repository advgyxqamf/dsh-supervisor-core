'use strict';

// 端口注册表门面：组合纯核心（core）+ 注册表（pool），只做导出。
// 注册接口签名（registerPools/registerSegment/readAll...）是域侧注入点，保持不变。

const core = require('./core');
const { PortRegistry } = require('./pool');

// 单例：全系统共享（supervisor 构造时注入 file 路径）。
const shared = new PortRegistry();
core.bindShared(shared);

module.exports = {
  PortRegistry, shared,
  BASE_POOLS: core.BASE_POOLS,
  DEFAULT_POOLS: core.DEFAULT_POOLS,
  SEGMENT_POOL: core.SEGMENT_POOL,
  registerPools: core.registerPools,
  registerSegment: core.registerSegment,
};
