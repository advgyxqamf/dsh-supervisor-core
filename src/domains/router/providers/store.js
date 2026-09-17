'use strict';

// 账号持久化网关（B8）：provider 侧落盘单闸。真实文件写入（原子写 + 锁 + 损坏现场保留）由
// router/store.js 的 RouterStore 统一持有（PG-7 单写者：守卫内嵌实例必须只读，绝不第二写者）；
// provider 侧只经 ctor 注入的 persist 回调触发，本类把「何时允许写」收敛为一个对象，杜绝各写一半。

class AccountStore {
  constructor(opts) {
    const o = opts || {};
    this._persistFn = typeof o.persist === 'function' ? o.persist : null;
    this._canPersist = typeof o.canPersist === 'function' ? o.canPersist : null;
    this.logger = o.logger || null;
  }

  /** 是否允许写入（未注入闸 = 允许；注入后以其为准）。 */
  canPersist() {
    return this._canPersist ? this._canPersist() !== false : true;
  }

  /** 触发一次落盘（经统一写权闸）。 */
  persist() {
    if (!this._persistFn) return;
    if (!this.canPersist()) return;
    return this._persistFn();
  }
}

module.exports = { AccountStore };
