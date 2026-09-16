'use strict';

// 转发门面（组合 + 导出）——不再承载业务逻辑。
// 组合：handlers/parse（纯） + handlers/forward（IO） + store/usage（账本） + model/inflight（纯状态）。
//
// 两条消费路径：
//  1) createForwardCore(deps)：显式注入（门面改造后 index.js ctor 使用）；
//  2) forwardMethods：兼容方法集（index.js:758 现存 Object.assign 消费面），
//     经 coreFor(host) 把 host 字段/方法映射为显式 deps —— 装配边界唯一，无 this.<index方法>。

const { keyFingerprint, maskKey } = require('./providers/base');
const parse = require('./handlers/parse');
const { joinUpstream } = parse;
const { createForwarder } = require('./handlers/forward');
const { UsageLedger } = require('./store/usage');
const { createInflight } = require('./model/inflight');

/** 显式组合：deps 由调用方注入（推荐新门面使用）。 */
function createForwardCore(deps) {
  const d = deps || {};
  const usage = new UsageLedger({
    file: d.usageTotalsFile,
    canPersist: d.canPersist,
    keyFingerprint: d.keyFingerprint || keyFingerprint,
    estimateCost: parse.estimateCost,
    events: d.events,
    logger: d.logger,
  });
  const inflight = createInflight();
  const forwarder = createForwarder({
    log: d.log, logger: d.logger, readBody: parse.readBody, canPersist: d.canPersist,
    parse, usage, inflight, switcher: d.switcher, events: d.events,
    getPricing: d.getPricing, agents: d.agents, maskKey,
  });
  return { proxyFor: forwarder.proxyFor, writeThrough: forwarder.writeThrough, forwardOnce: forwarder.forwardOnce, endInflight: forwarder.endInflight, recordError: forwarder.recordError, usage, inflight };
}

/** host → 显式 deps 的唯一装配边界（只读 host 字段，不调用 this.<index方法>）。 */
function coreFor(host) {
  if (!host.__forwardCore) {
    host.__forwardCore = createForwardCore({
      log: (line) => host.log(line),
      logger: host.logger,
      canPersist: () => (host.store && typeof host.store.canPersist === 'function')
        ? host.store.canPersist()
        : (typeof host.canPersist === 'function' ? host.canPersist() : true),
      switcher: host.switcher,
      events: host.events,
      usageTotalsFile: host.usageTotalsFile,
      getPricing: () => host.modelPriceIndex,
      agents: { http: host._agentHttp, https: host._agentHttps },
    });
  }
  return host.__forwardCore;
}

/** 兼容方法集（当前 index.js 经 Object.assign 合并到 prototype）。 */
const forwardMethods = {
  proxyFor(prov, req, res) { return coreFor(this).proxyFor(prov, req, res); },
  writeThrough(req, res, out, acc, prov, meta) { return coreFor(this).writeThrough(req, res, out, acc, prov, meta); },
  forwardOnce(target, method, srcHeaders, bodyBuf, key, clientRes) { return coreFor(this).forwardOnce(target, method, srcHeaders, bodyBuf, key, clientRes); },
  _beginInflight(acc) { return coreFor(this).inflight.begin(acc); },
  _endInflight(acc, prov) { return coreFor(this).endInflight(acc, prov); },
  recordUsage(entry) { return coreFor(this).usage.recordUsage(entry); },
  recordError() { return coreFor(this).usage.recordError(); },
  _writeTotals() { return coreFor(this).usage._writeTotals(); },
  _loadTotals() { return coreFor(this).usage.load(); },
  getUsage() { return coreFor(this).usage.getUsage(); },
};

module.exports = { forwardMethods, createForwardCore, maskKey, joinUpstream };
