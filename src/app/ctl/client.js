'use strict';

const hub = require('../../platform/service/log/hub');

// 步骤 7 迁移：自 control-view.js 逐字搬出（4 个方法）。
// ctl 客户端：router(43107)/lan(43108) 控制通道调用与端口解析。
// 方法体逐字复制，仅导出形态规范化为 module.exports = { methods }；内部仍用 this。

module.exports = { methods: {

  /** 通用 ctl 调用（router 43107 / lan 43108 共用）。
   *
   *  ⚠ 2026-09-12（P2 去重）：实现已收敛到 `platform/service/log/hub.ctlCall` ——
   *    此前这里是**第二份逐行近似**的实现，与 loghub 那份已分叉：
   *      默认超时不同（此处 120s / 那边 3s）、错误对象形状不同。
   *    本包装只负责本层契约：默认 120s（面板写操作可达秒级） + 在 Error 上挂 ok/error。
   */
  _ctlCall(port, method, args, timeoutMs) {
    return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
  },

  /** router-daemon 控制通道端口（单一来源：config；缺省见 platform/service/config DEFAULTS）。
   *  历史教训：曾散落硬编码 43011，而该值实际落在（当时的）providerApi 动态段内，
   *  与供应商独立端点发生注册表双占冲突；ctl 通道必须与动态分配段解耦。 */
  _routerCtlPort() { return Number(this.config && this.config.routerCtlPort) || 43107; },

  /** lan-daemon 控制通道端口（单一来源：config）。 */
  _lanCtlPort() { return Number(this.config && this.config.lanCtlPort) || 43108; },

  _lanCtlCall(method, args, timeoutMs) { return this._ctlCall(this._lanCtlPort(), method, args, timeoutMs); },
} };
