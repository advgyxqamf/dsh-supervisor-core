'use strict';

// api —— 本地 HTTP API 门面：re-export 网关 createServer（实现 ./transport/server.js）
// 与安全判定三函数（实现 ./security.js）。
//
// 安全边界（三层，职责单一）：
//  - 默认仅回环绑定；开启局域网访问后，局域网内设备可访问面板/API；
//  - 只允许本机(回环)与 RFC1918 私有 IP 的 Host/Origin，外部/公网主机被拒（挡公网）；
//  - 仅对桌面壳来源（tauri:// / *.tauri.localhost）返回 CORS 头；其他 Origin 零 CORS；
//  - 带 Origin 的写请求必须来自本机/局域网面板来源，外部网页无法驱动 start/stop/upgrade。
//
// 导出面逐字保持（api-surface / api-contract / core-test / lan-access-boundary /
//   defects-batch-f K6 依赖）：createServer / originAllowed / isLoopbackHost / isShellOrigin。

const { createServer } = require('./transport/server');

// 兼容 re-export（测试行为断言依赖，不得移除）：
// originAllowed / isLoopbackHost / isShellOrigin 供测试直调做行为断言，仅源码正则不够
//   （本仓已有「注释声称、代码没有」的先例 K6，正则也会被注释示例骗过）。
// 消费方：api-contract / lan-access-boundary / defects-batch-f（K6 直调 originAllowed）；
// 实现归 ./security.js，本文件只 re-export。
const { originAllowed, isLoopbackHost, isShellOrigin } = require('./security');

module.exports = { createServer, originAllowed, isLoopbackHost, isShellOrigin };
