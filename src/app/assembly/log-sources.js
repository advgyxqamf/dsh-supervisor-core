'use strict';

// app/assembly/log-sources.js —— 日志汇聚「业务源」声明（DS-G4 反转法注入点）。
//
// DIRECTORY-STRUCTURE-DESIGN §4.2：platform 不得出现业务域名词（DS-G4）。EventHub 只保留
// registerSource(name) 注册接口；源名单（域名词）在本文件声明——本文件属 app/（编排层），
// 是唯一允许知道「有哪些业务源、哪个键对应哪个源」的地方。
//
// 注入时机：require 即注入（模块顶层副作用）。compose.js 在构造 LogCore 之前 require 本模块，
// 故 LogCore 构造 EventHub 时源名单已就位；Node 模块缓存保证启动期只注入一次（幂等）。
// 未注入时（单测直接 require platform/log/hub）：EventHub 退化为「仅本进程本地源」，
// 不猜测任何业务源名——platform 零域名词。

const hub = require('../../platform/service/log/hub');

// 聚合源：
//   name  聚合流 source 字段 / 水位键 / ctl 拉取身份
//   key   装配短键：ctlPorts / daemonLogs / /logs/tail stream 的键
//   local true 表示本进程本地推源（守卫自身），不参与 ctl 拉取
const SOURCES = [
  { name: 'guard', key: 'guard', local: true },
  { name: 'router-daemon', key: 'router' },
  { name: 'lan-daemon', key: 'lan' },
];

// 内部簿记事件类型（进审计、不进默认用户时间线）；域名词同样只在编排层声明。
const INTERNAL_TYPES = ['router_daemon_supervised', 'orphan_audit'];

hub.setSources(SOURCES);
hub.setInternalTypes(INTERNAL_TYPES);

// 仅顶层副作用（hub.setSources/setInternalTypes），无对外导出。
