'use strict';

// 用量账本（IO）：记账 + 按 key/model 聚合 + 原子落盘 + 汇总视图。写权单闸：落盘前问注入的
// canPersist()（store.js 提供唯一闸，本模块不再自行判断 _persistEnabled）。.tmp 命名与 store.js
// 统一为 <file>.tmp.<pid>.<ts>（唯一，防并发写混合内容）。依赖 node:fs/node:path 与注入的
// 纯函数（keyFingerprint/estimateCost）。

const fs = require('node:fs');
const path = require('node:path');

function defaults(t) {
  t.requests = t.requests || 0;
  t.promptTokens = t.promptTokens || 0;
  t.completionTokens = t.completionTokens || 0;
  t.totalTokens = t.totalTokens || 0;
  t.costUsd = t.costUsd || 0;
  t.errors = t.errors || 0;
  if (!t.byModel || typeof t.byModel !== 'object') t.byModel = {};
  if (!t.byKey || typeof t.byKey !== 'object') t.byKey = {};
  return t;
}

class UsageLedger {
  constructor(opts) {
    const o = opts || {};
    this.file = o.file || null;
    this.logger = o.logger || null;
    // 注入的纯函数（依赖倒置：账本本身不 require providers/parse）
    this._keyFingerprint = typeof o.keyFingerprint === 'function' ? o.keyFingerprint : ((k) => k);
    this._estimateCost = typeof o.estimateCost === 'function' ? o.estimateCost : (() => 0);
    // 唯一写权闸（谓词注入）；字段名加 _ 前缀与兄弟文件同名方法（RouterStore.canPersist）区分
    this._canPersist = typeof o.canPersist === 'function' ? o.canPersist : (() => true);
    this.events = o.events || null;
    this.totals = null;
  }

  /** 读盘（缓存于 this.totals；兼容旧格式补默认字段，防 undefined 崩溃）。 */
  load() {
    if (this.totals) return this.totals;
    let t;
    try { t = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (!t || typeof t !== 'object') t = {};
    this.totals = defaults(t);
    return this.totals;
  }

  /** 记账：累计总量 + byModel + byKey，按快照单价估算费用，原子落盘。 */
  recordUsage(entry) {
    const t = this.load();
    t.requests += 1;
    t.promptTokens += entry.promptTokens;
    t.completionTokens += entry.completionTokens;
    t.totalTokens += entry.totalTokens;
    const bm = t.byModel[entry.model] || (t.byModel[entry.model] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
    bm.requests += 1; bm.promptTokens += entry.promptTokens; bm.completionTokens += entry.completionTokens; bm.totalTokens += entry.totalTokens;
    const cost = this._estimateCost(entry);
    if (cost > 0) {
      t.costUsd = (t.costUsd || 0) + cost;
      bm.costUsd = (bm.costUsd || 0) + cost;
    }
    if (entry.key) {
      const kf = this._keyFingerprint(entry.key);
      const bk = t.byKey[kf] || (t.byKey[kf] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
      bk.requests += 1; bk.promptTokens += entry.promptTokens; bk.completionTokens += entry.completionTokens; bk.totalTokens += entry.totalTokens;
      if (cost > 0) bk.costUsd = (bk.costUsd || 0) + cost;
    }
    this._writeTotals();
    if (this.events) this.events.append('router_usage', { model: entry.model, tokens: entry.totalTokens });
    return t;
  }

  /** 错误计数（持久化）。 */
  recordError() {
    const t = this.load();
    t.errors = (t.errors || 0) + 1;
    this._writeTotals();
    return t.errors;
  }

  /** 汇总视图（byModel 取 token 前 12）。 */
  getUsage() {
    const t = this.load();
    const byModel = Object.entries(t.byModel || {}).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12);
    return { requests: t.requests, promptTokens: t.promptTokens, completionTokens: t.completionTokens, totalTokens: t.totalTokens, costUsd: t.costUsd, errors: t.errors || 0, byModel, byKey: t.byKey || {} };
  }

  /** 原子落盘（tmp+rename 防崩溃/断电损坏高频用量文件）；写权单闸。 */
  _writeTotals() {
    try {
      if (typeof this._canPersist === 'function' && !this._canPersist()) return;
      const t = this.totals;
      if (!t || !this.file) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp.' + process.pid + '.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}

module.exports = { UsageLedger };
