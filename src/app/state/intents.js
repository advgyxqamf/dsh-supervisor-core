'use strict';

// 显式意图登记簿（IntentLedger）。
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

  /** intent 必须在词表内（否则抛错）；payload 可选，消费时取回。 */
  register(intent, payload) {
    if (!INTENTS.includes(intent)) throw new Error('未知意图: ' + intent + '（词表: ' + INTENTS.join(',') + '）');
    this._pending.set(intent, payload === undefined ? null : payload);
    return this;
  }

  consume(intent) {
    const p = this._pending.get(intent);
    if (this._pending.has(intent)) this._pending.delete(intent);
    return p;
  }

  /** 仅测试/守卫 shutdown 用。 */
  clear() {
    this._pending.clear();
  }
}

module.exports = { IntentLedger, INTENTS };
