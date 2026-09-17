'use strict';

// app/assembly/compose.js —— 编排层组装门面（原 supervisor.js constructor）。
//
// 按序调用三个「切面组」步骤，构造全部子系统并接线到 host；这是唯一知道全局对象图的地方
// （契约 §2.1：assembly 是唯一 DI 发生地）：
//   installFacets（切面装配）-> composeCore（宿主/基础设施）
//     -> composeDomains（各域构造）-> composeObservers（实例事件接线 + 生命周期注册）。
//
// 本文件只做组合与编排；各步骤体量分置 compose/{core,domains,observers}.js
// （按职责分组；单向 facade -> steps）。

const { installFacets } = require('./facets');
const { composeCore } = require('./compose/core');
const { composeDomains } = require('./compose/domains');
const { composeObservers } = require('./compose/observers');

function composeSystem(host, rawConfig, configPath, deps) {
  installFacets(host, deps);
  composeCore(host, rawConfig, configPath);
  composeDomains(host);
  composeObservers(host);
  return host;
}

module.exports = { composeSystem };
