'use strict';

// ctl 门面工厂：把 ctl 端口包成方法转发 Proxy（router/lan 共用）。
// 导出形态 module.exports = { methods }；内部使用 this。

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

// routerApi() 门面在 app/facade/router.js —— 打断 facade/router 与 ctl/facades 的 this 调用环。
// 本文件只保留「ctl 端口 -> 方法转发 Proxy」的通用构造，供 routerApi 单向取用。
