'use strict';

// 运维门面（组合 + 导出），不再承载业务逻辑。组合 ops/{browser,oauth,apps-registry,quotasync,admin}，
// 由 createAuxCore(deps) 显式注入依赖。

require('./port-segments'); // 本域端口段/独立池申报（require 即注入）
const ports = require('../../platform/service/ports').shared;
const { maskKey } = require('./providers/base');
const { openInBrowser } = require('./ops/browser');
const { createOAuthOps } = require('./ops/oauth');
const { createAppsRegistryOps } = require('./ops/apps-registry');
const { createQuotaSyncOps } = require('./ops/quotasync');
const { createAdminOps } = require('./ops/admin');

/** 显式组合：deps 由调用方注入（推荐新门面使用）。 */
function createAuxCore(deps) {
  const d = deps || {};
  const getProviders = d.getProviders || (() => []);
  const oauth = createOAuthOps({ ports, openInBrowser });
  const apps = createAppsRegistryOps({
    getProviders, proxyUpdateCache: d.proxyUpdateCache, dist: d.dist,
    events: d.events, tasks: d.tasks, save: d.save, logger: d.logger,
  });
  const quota = createQuotaSyncOps({
    getProviders, findProvider: d.findProvider, save: d.save,
    events: d.events, setPriceIndex: d.setPriceIndex,
  });
  const admin = createAdminOps({
    findProvider: d.findProvider, save: d.save, ports, maskKey, logger: d.logger,
  });
  return { ...oauth, ...apps, ...quota, ...admin };
}

module.exports = { createAuxCore };
