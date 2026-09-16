'use strict';

// 运维门面（组合 + 导出）——不再承载业务逻辑。
// 组合：ops/{browser,oauth,apps-registry,quotasync,admin}。
// 两条消费路径：createAuxCore(deps) 显式注入；auxMethods 兼容方法集
// （index.js:759 现存 Object.assign 消费面），经 coreFor(host) 显式映射 deps。

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

/** host → 显式 deps 的唯一装配边界（只读 host 字段，不调用 this.<index方法>）。 */
function coreFor(host) {
  if (!host.__auxCore) {
    host.__auxCore = createAuxCore({
      getProviders: () => host.providers || [],
      findProvider: (id) => host.getProvider(id),
      save: () => host._save(),
      proxyUpdateCache: host.proxyUpdateCache || (host.proxyUpdateCache = {}),
      dist: host.dist,
      events: host.events,
      tasks: host.tasks,
      logger: host.logger,
      setPriceIndex: (idx) => { host.modelPriceIndex = idx; },
    });
  }
  return host.__auxCore;
}

/** 兼容方法集（当前 index.js 经 Object.assign 合并到 prototype）。 */
const auxMethods = {
  commandcodeLoginStart() { return coreFor(this).commandcodeLoginStart(); },
  commandcodeLoginWait(timeoutMs) { return coreFor(this).commandcodeLoginWait(timeoutMs); },
  proxyApps() { return coreFor(this).proxyApps(); },
  refreshProxyUpdateInfo(force) { return coreFor(this).refreshProxyUpdateInfo(force); },
  applyProxyUpdate(appId) { return coreFor(this).applyProxyUpdate(appId); },
  proxyUpdateStatus(appId) { return coreFor(this).proxyUpdateStatus(appId); },
  refreshOfficialUsageAll() { return coreFor(this).refreshOfficialUsageAll(); },
  refreshProviderQuota(providerId) { return coreFor(this).refreshProviderQuota(providerId); },
  refreshOfficialPricingAll() { return coreFor(this).refreshOfficialPricingAll(); },
  setProviderKeys(id, opts) { return coreFor(this).setProviderKeys(id, opts); },
  setSelectedProxyKey(providerId, keyId) { return coreFor(this).setSelectedProxyKey(providerId, keyId); },
  switchToKey(providerId, keyId) { return coreFor(this).switchToKey(providerId, keyId); },
  removeProxyKey(providerId, keyId) { return coreFor(this).removeProxyKey(providerId, keyId); },
  addProxyKey(providerId, key) { return coreFor(this).addProxyKey(providerId, key); },
  discardAccount(providerId, keyId) { return coreFor(this).discardAccount(providerId, keyId); },
};

module.exports = { auxMethods, createAuxCore };
