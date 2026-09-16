'use strict';

// 步骤 7 迁移：自 control-view.js 逐字搬出；2026-09-17 R7/SCC④：routerApi 上移 facade/router
//   —— 本文件只留「ctl 端口 → 方法转发 Proxy」通用构造（2 个方法）。
// ctl 门面工厂：把 ctl 端口包成方法转发 Proxy（router/lan 共用）。
// 方法体逐字复制，仅导出形态规范化为 module.exports = { methods }；内部仍用 this。

module.exports = { methods: {

  _makeRouterFacade() { return this._makeCtlFacade(this.ctl.routerPort()); },

  _makeCtlFacade(port) {
    const self = this;
    const cache = new Map();
    const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (BANNED.has(prop)) return undefined;
        if (cache.has(prop)) return cache.get(prop);
        const fn = (...args) => self._ctlCall(port, prop, args);
        cache.set(prop, fn);
        return fn;
      },
      has() { return true; },
    });
  },

} };

// ⚠ R7/SCC④（2026-09-17）：routerApi() 门面已上移 app/facade/router.js —— 打断
//   `facade/router ↔ ctl/facades` 的 this 调用环（本文件不再调用 this.routerDaemonActive）。
//   本文件只保留「ctl 端口 → 方法转发 Proxy」的通用构造，供 routerApi 单向取用。
