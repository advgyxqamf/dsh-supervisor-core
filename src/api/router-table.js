'use strict';

// api/router-table —— 域注册表（步骤 9：从 index.js 的 API_DOMAINS 常量拆出）。
//
// 为什么单独成文件：
//   index.js 的目标是"薄网关（≤180 行）"——createServer + 门卫 + 分派 + 异常边界。
//   把"有哪些域、按什么顺序匹配"作为数据挪到这里，网关只负责遍历分派；
//   新增/删除域只动本文件，不必打开网关核心。
//
// ⚠ 顺序即优先级：每域 owns() 是**粗前缀超集**，域内未匹配由该域 handle 兜底 404/405。
//   故本表的顺序必须与历史行为一致，改动顺序会改变路由归属。

const API_DOMAINS = [
  require('./domains/tasks'),
  require('./domains/lifecycle'),
  require('./domains/native'),
  require('./domains/guard'),
  require('./domains/router'),
  require('./domains/plugins'),
  require('./domains/dist'),
  require('./domains/instances'),
  require('./domains/relay'),
  require('./domains/shell'),   // 桌面壳更新安全网（/shell/*）——内核仅做安全网，非更新源
];

module.exports = { API_DOMAINS };
