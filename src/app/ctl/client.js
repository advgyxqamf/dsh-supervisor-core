'use strict';

const hub = require('../../platform/service/log/hub');

// ctl 客户端工厂（DF-5）：router(43107)/lan(43108) 控制通道调用与端口解析。
// 实现收敛为具名纯函数 + deps 注入，不再依赖宿主隐式 this；host 兼容方法见 methods。

/** 通用 ctl 调用（router 43107 / lan 43108 共用）。
 *  实现收敛到 platform/service/log/hub.ctlCall，本包装只负责本层契约：
 *  默认 120s（面板写操作可达秒级）+ 在 Error 上挂 ok/error。 */
function ctlCall(port, method, args, timeoutMs) {
  return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
}

/** router-daemon 控制通道端口（单一来源：config；缺省见 platform/service/config DEFAULTS）。
 *  必须与动态分配段解耦：曾硬编码 43011，落在 providerApi 动态段内导致端口双占冲突。 */
function routerCtlPort(config) { return Number(config && config.routerCtlPort) || 43107; }

/** lan-daemon 控制通道端口（单一来源：config）。 */
function lanCtlPort(config) { return Number(config && config.lanCtlPort) || 43108; }

/**
 * ctl 客户端工厂。deps 为惰性 getter：{ getConfig }。
 * 返回 { ctlCall, routerCtlPort, lanCtlPort, lanCtlCall }，可只 require + 假 deps 直接断言。
 */
function createCtlClient(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? g.getConfig() : null);
  return {
    ctlCall,
    routerCtlPort: () => routerCtlPort(config()),
    lanCtlPort: () => lanCtlPort(config()),
    lanCtlCall: (method, args, timeoutMs) => ctlCall(lanCtlPort(config()), method, args, timeoutMs),
  };
}

// host 既有方法安装（facets.js 的 { methods } 不动）：其他切面仍经宿主方法取用。
// config 为宿主字段读取；其余实现走上面的具名函数/工厂，无跨文件 this。
const methods = {
  _ctlCall: ctlCall,
  _routerCtlPort() { return routerCtlPort(this.config); },
  _lanCtlPort() { return lanCtlPort(this.config); },
  _lanCtlCall(method, args, timeoutMs) { return ctlCall(lanCtlPort(this.config), method, args, timeoutMs); },
};

module.exports = { createCtlClient, methods };
