'use strict';

// app/state/intents.js —— 显式意图登记簿（IntentLedger）。
// 结构语义：意图是一等公民状态，register 发生、consume 消费，词表强约束（无悬空意图）；
// 一次性语义（consume 即清除，同意图重复 register 覆盖）；无时间窗，不因拍数流逝失效。
//
// 词表（INTENTS；新增动作必须显式扩展）：start / restart / upgrade-resume。
//
// 定位（契约 ARCHITECTURE-CONTRACT-phase0 §6）：本登记簿是瞬态加速器（同一次运行内的即时
// 动作），不是恢复依据。「是否应运行」的持久权威是 desired（managed-objects.json），守卫
// 重启后由 desired 恢复，绝不依赖本登记簿（内存态、重启即空）；靠意图解锁首次拉起的逻辑
// 是错误的（已由 desired 无条件拉起取代）。

const INTENTS = ['start', 'restart', 'upgrade-resume'];

class IntentLedger {
  constructor() {
    this._pending = new Map(); // intent -> payload（最新意图权威）
  }

  /** 登记一次显式意图。intent 必须在词表内；payload 可选（消费时取回）。 */
  register(intent, payload) {
    if (!INTENTS.includes(intent)) throw new Error('未知意图: ' + intent + '（词表: ' + INTENTS.join(',') + '）');
    this._pending.set(intent, payload === undefined ? null : payload);
    return this;
  }

  /** 消费一次意图：存在则返回 payload 并清除；不存在返回 undefined。 */
  consume(intent) {
    const p = this._pending.get(intent);
    if (this._pending.has(intent)) this._pending.delete(intent);
    return p;
  }

  /** 非破坏性查询：某意图是否待消费（收敛循环决策用）。 */
  has(intent) {
    return this._pending.has(intent);
  }

  /** 是否存在任一待消费意图（守护 gate 的"显式动作穿透"判定）。 */
  any() {
    return this._pending.size > 0;
  }

  /** 清空全部（仅测试/守卫 shutdown 用）。 */
  clear() {
    this._pending.clear();
  }
}

module.exports = { IntentLedger, INTENTS };
