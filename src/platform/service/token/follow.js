'use strict';

// 跟随变动广播（DSH-TOKEN-CONTRACT 契约3/4，TK-8）。
// 令牌变动有值与失效两个方向，消费方只关心结果，故把订阅与广播收敛于此。
// 强制一条：凡对外状态变化（含 value=null）必须经 emit，不允许内部静默 set/delete；历史上清空不广播会让 relay 继续用旧 cookie 直到 401。
// emit 第 3 参 record 是契约4 的向后兼容新增；单个 listener 抛异常不得影响其它 listener。

class FollowBus {
  /** @param {object} opts { logger }，仅用于记录 listener 自身异常。 */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this._listeners = new Set(); // 订阅者集合，Set 去重，同一函数重复订阅只广播一次
  }

  /** 订阅令牌变化，返回取消订阅函数（幂等，重复调用无副作用）。 */
  on(fn) {
    if (typeof fn === 'function') this._listeners.add(fn);
    return () => { try { this._listeners.delete(fn); } catch { /* 集合删除不应抛 */ } };
  }

  /** 广播一次令牌变化，唯一的对外通知出口（TK-8）。value 为 null 表示失效或清空。 */
  emit(id, value, record) {
    // 快照后再遍历：listener 在回调里退订/再订阅不应影响本次分发的确定性。
    for (const fn of Array.from(this._listeners)) {
      try { fn(id, value === undefined ? null : value, record || null); }
      catch (e) {
        // 吞掉 listener 异常是有意的：令牌链路恒通优先于单个消费方的 bug（TK-1）。
        this.logger.warn && this.logger.warn('[token] onChange(' + id + ') listener error: ' + ((e && e.message) || e));
      }
    }
  }
}

module.exports = { FollowBus };
