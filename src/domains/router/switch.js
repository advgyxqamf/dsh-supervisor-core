'use strict';

// 供应商独立账号「切换控制器」（SwitchController 职责，M3）：
//  - S1 选号：调纯策略 policies/switch.pickAccount，再施加副作用（markInUse/cursor/事件/持久化）
//  - S2 失败反应：调纯策略 policies/failure.decideFailure，再执行 provider.effect / 日志
// 信号语义（credits/window/banned/transient/none）由 provider.classifyResponse 判定；
// 账号处置副作用经 provider.effect 执行；本控制器只决定「是否重试 / 是否透传」。
// 绝不跨供应商 failover——每个供应商独立端点只在自己的账号池内选号。

const { pickAccount } = require('./policies/switch');
const { decideFailure } = require('./policies/failure');

class SwitchEngine {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onPersist = opts.onPersist || null; // selected 失效自动清理时持久化
  }

  /** 在指定供应商的账号池内选择（供应商独立端点语义）：绝不跨供应商 failover，本池无可用返回 null。
   *  opts.excludeKeys=Set 时把本请求内瞬时故障（5xx/net-error）账号直接排除，强制轮换不粘滞。 */
  pickFor(provider, opts) {
    if (!provider) return null;
    return this._pickIn(provider, opts);
  }

  /** 选号编排：预算 usable/running，调 S1 纯策略，再应用决策（清锁/写 cursor/标记在用/事件）。 */
  _pickIn(p, opts) {
    const isProxy = p.kind === 'proxy';
    const accounts = p.accounts || [];
    const state = {
      accounts: accounts.map((a) => ({
        key: a.key, keyId: a.keyId, maskedKey: a.maskedKey, status: a.status,
        usable: !!p.isAccountUsable(a),
        running: !isProxy || !!(a.instance && a.instance.pid),
      })),
      selectedAccountKeyId: p.selectedAccountKeyId || null,
      activeAccountKeyId: p.activeAccount ? p.activeAccount.keyId : null,
      cursor: p.cursor || 0,
      kind: p.kind,
    };
    const d = pickAccount(state, opts);
    // 锁定失效清理：仅当 S1 判定「永久失效」才清锁并持久化（临时冻结保留锁定）。
    if (d.clearSelected) {
      p.selectedAccountKeyId = null;
      if (this.onPersist) this.onPersist();
    }
    if (!d.keyId) return null;
    const picked = accounts.find((a) => a.keyId === d.keyId) || null;
    if (!picked) return null;
    if (d.reason === 'rotate') p.cursor = d.nextCursor;
    if (typeof p.markInUse === 'function') p.markInUse(picked.keyId); else p.activeAccount = picked;
    if (this.events) this.events.append('router_pick', { provider: p.name, key: picked.maskedKey });
    return picked;
  }

  /** 上游失败反应（唯一编排点）。ctx = { status, headers, body, attempt, attempts, error? }：
   *  1) provider.classifyResponse 给出 signal；
   *  2) provider.effect 执行账号副作用（credits/window 冻结，proxy 会停实例并预热；banned 封号）；
   *  3) 返回 action：'retry'（credits/window/transient，带 transient 标记供调用方定退避）或
   *     'passthrough'（banned/none/unknown 原样回状态/头/体，绝不误切）。 */
  reactToFailure(provider, acc, ctx) {
    const c = ctx || {};
    const status = c.status;
    const text = String(c.body || '');
    const sig = (provider && typeof provider.classifyResponse === 'function')
      ? provider.classifyResponse(status, c.headers, text)
      : 'none';
    const key = (acc && acc.maskedKey) || '?';
    const d = decideFailure(sig, { status, headers: c.headers, body: text, key });
    // 行为不变量：window 信号必须在 provider.effect 之前把 retryMs 写入 ctx，
    // 否则 markQuotaExhausted(acc, cooldownMs) 拿到 undefined。
    if (sig === 'window') c.retryMs = d.retryMs;
    if (d.needEffect && provider && provider.effect) provider.effect(sig, acc, c);
    if (d.info && this.logger && this.logger.info) this.logger.info(d.info);
    if (d.action === 'retry') {
      const res = { action: 'retry', signal: sig };
      if (d.transient) res.transient = true;
      if (d.log) res.log = d.log;
      return res;
    }
    const res = { action: 'passthrough', signal: sig, status, headers: c.headers, body: text };
    if (d.log) res.log = d.log;
    return res;
  }
}

module.exports = { SwitchEngine };
