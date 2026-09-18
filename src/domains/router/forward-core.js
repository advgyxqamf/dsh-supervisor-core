'use strict';

// 转发门面（组合 + 导出），不再承载业务逻辑。组合 handlers/parse（纯） + handlers/forward（IO）
// + store/usage（账本） + model/inflight（纯状态）。createForwardCore(deps) 由门面显式注入依赖，
// 装配边界唯一，不调用 this.<index方法>。

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

module.exports = { createForwardCore, maskKey, joinUpstream };
