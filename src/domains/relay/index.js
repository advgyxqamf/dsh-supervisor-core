'use strict';

// relay 域门面（组合 + 导出，无逻辑）。
//
// 分层（单向依赖）：
//   index ─▶ ops ─▶ proxy ─▶ tunnel/session ─▶ core
//            ops ─▶ ports / managed / frp ─▶ frp-install
//
// 真域入口修正：历史上真正的入口是 manager.js（被 compose.js / supervisor.js 依赖），
// 而 index.js 是服务本体。现 manager.js → ops.js，服务本体 → proxy.js，
// 本文件回归纯门面 —— 域内任何文件都不得反向 require 本文件。

const { createRelay } = require('./proxy');
const { LanManager } = require('./ops');
const { FrpManager } = require('./frp');
const { frpPlatformTag, downloadUrls } = require('./frp-install');

module.exports = { createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls };
