'use strict';

const hub = require('../../platform/service/log/hub');

// ctl 客户端：router(43107)/lan(43108) 控制通道调用与端口解析。
// 导出形态 module.exports = { methods }；内部使用 this。

module.exports = { methods: {

  /** 通用 ctl 调用（router 43107 / lan 43108 共用）。
   *  实现收敛到 platform/service/log/hub.ctlCall，本包装只负责本层契约：
   *  默认 120s（面板写操作可达秒级）+ 在 Error 上挂 ok/error。 */
  _ctlCall(port, method, args, timeoutMs) {
    return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
  },

  /** router-daemon 控制通道端口（单一来源：config；缺省见 platform/service/config DEFAULTS）。
   *  必须与动态分配段解耦：曾硬编码 43011，落在 providerApi 动态段内导致端口双占冲突。 */
  _routerCtlPort() { return Number(this.config && this.config.routerCtlPort) || 43107; },

  /** lan-daemon 控制通道端口（单一来源：config）。 */
  _lanCtlPort() { return Number(this.config && this.config.lanCtlPort) || 43108; },

  _lanCtlCall(method, args, timeoutMs) { return this._ctlCall(this._lanCtlPort(), method, args, timeoutMs); },
} };
