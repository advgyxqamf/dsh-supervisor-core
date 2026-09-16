'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 跟随变动广播（DSH-TOKEN-CONTRACT §3/§4，TK-8）
//
// ## 为什么把订阅管理单独抽出来
//   令牌的「变动」有两个方向：值变了、值没了。消费方（relay 热换 cookie、
//   API 生成直连 URL、UI 展示）只关心**结果**，不该关心是哪个源、哪条路径
//   造成的。历史上「清空不广播」正是缺陷的来源：relay 手里还拿着上一代
//   cookie 继续转发，直到下一个请求 401（TK-8 要防的就是这个）。
//   故把「谁订阅、何时广播」收敛到本模块，并强制一条：凡对外状态变化
//   （含 value=null）**必须**经 emit，绝不允许内部静默 set/delete。
//
// ## 不变式（实现层可读）
//   · emit(id, value, record) —— value 为 string 表示有值；**null 表示失效/清空**。
//   · 第 3 参 record 是 §4 要求的向后兼容新增（旧回调只写两个形参也能工作）。
//   · 一个 listener 抛异常不得影响其它 listener（单个消费方的 bug 不能拖垮令牌链路）。
//   · on() 返回取消订阅函数（既有语义，消费方 shutdown 时调用）。
// ═══════════════════════════════════════════════════════════════════════════

class FollowBus {
  /** @param {object} opts { logger } —— 仅用于记录 listener 自身异常，不参与业务。 */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this._listeners = new Set(); // 订阅者集合（Set 天然去重：同一函数重复订阅只广播一次）
  }

  /**
   * 订阅令牌变化。返回取消订阅函数（幂等：重复调用无副作用）。
   * @param {(id:string, value:string|null, record:object|null) => void} fn
   */
  on(fn) {
    if (typeof fn === 'function') this._listeners.add(fn);
    return () => { try { this._listeners.delete(fn); } catch { /* 集合删除不应抛 */ } };
  }

  /** 当前订阅者数量（仅供自测/诊断，不参与分发逻辑）。 */
  listenerCount() {
    return this._listeners.size;
  }

  /**
   * 广播一次令牌变化。**唯一**的对外通知出口（TK-8）。
   * @param {string} id
   * @param {string|null} value  令牌值；null 表示失效/清空（TK-8 的强制形态）
   * @param {object|null} record getRecord 同形的记录（含 gen；清空时为 null）
   */
  emit(id, value, record) {
    // 快照后再遍历：listener 在回调里退订/再订阅不应影响本次分发的确定性。
    for (const fn of Array.from(this._listeners)) {
      try { fn(id, value === undefined ? null : value, record || null); }
      catch (e) {
        // 吞掉 listener 异常是**有意**的：令牌链路恒通优先于单个消费方的 bug（TK-1）。
        this.logger.warn && this.logger.warn('[token] onChange(' + id + ') listener error: ' + ((e && e.message) || e));
      }
    }
  }
}

module.exports = { FollowBus };
