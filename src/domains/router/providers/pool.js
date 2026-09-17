'use strict';

// 实例池策略（B12）：纯决策。IO（启停/对账）由 proxy/restart 编排；
// 状态一律显式入参（账号数组、在用指向、上限），不读 this。

const { quotaPercent } = require('./policies/quota');

/** HOT 态实例上限（可立即服务的进程数）。默认 2 = 1 常驻 + 1 备胎。 */
const DEFAULT_MAX_HOT = 2;
/** WARM 态实例上限（启动中但未就绪）。默认 1。 */
const DEFAULT_MAX_WARM = 1;
/** 请求路径同步等待预算（ms）：目标未就绪时最多等这么久，超预算立即换号。 */
const DEFAULT_SWITCH_BUDGET_MS = 2000;

/** 资源上限（配置优先）。 */
function limits(config) {
  const cfg = (config && config.proxyInstanceLimits) || {};
  return {
    maxHot: Number.isFinite(cfg.maxHot) ? cfg.maxHot : DEFAULT_MAX_HOT,
    maxWarm: Number.isFinite(cfg.maxWarm) ? cfg.maxWarm : DEFAULT_MAX_WARM,
  };
}

/** 同步等待预算（ms）。 */
function switchBudgetMs(config) {
  const v = config && config.switchBudgetMs;
  return Number.isFinite(v) ? v : DEFAULT_SWITCH_BUDGET_MS;
}

/** 各态实例计数（观测口径）。 */
function stateCounts(instances) {
  const c = { COLD: 0, WARM: 0, HOT: 0, DEAD: 0 };
  for (const i of (instances || [])) if (c[i.status] !== undefined) c[i.status]++;
  return c;
}

/** 常驻账号（应保活实例）：服务跟随 + sticky 兜底。
 *  @returns {resident, residentKeyId}（调用方决定是否落 sticky） */
function residentAccount(state) {
  const s = state || {};
  const usable = (s.accounts || []).filter((a) => s.isUsable(a));
  let res = null;
  if (s.selectedAccountKeyId) {
    const sel = usable.find((a) => a.keyId === s.selectedAccountKeyId);
    if (sel) res = sel;
  }
  if (!res && s.activeKeyId) {
    const cur = usable.find((a) => a.keyId === s.activeKeyId);
    if (cur) res = cur;
  }
  if (!res && s.residentKeyId) {
    const stable = usable.find((a) => a.keyId === s.residentKeyId);
    if (stable) res = stable;
  }
  if (!res) res = usable[0] || null;
  return { resident: res, residentKeyId: res ? res.keyId : null };
}

/** 是否需要备胎（预热规范化：额度将尽 / 故障前兆 / 时间维度 / 资源闸）。 */
function needSpare(state) {
  const s = state || {};
  const res = s.resident;
  if (!res) return false;
  const lim = s.limits || limits(s.config);
  const counts = s.counts || stateCounts(s.instances);
  if (counts.HOT >= lim.maxHot) return false;
  if (quotaPercent(res) >= 80) return true;
  if (res.instance && res.instance._unhealthyCount > 0) return true;
  const q = res.quota || {};
  const now = s.now || Date.now();
  const soon = [q.rolling, q.weekly].some((w) => {
    if (!w || !w.resetsAt) return false;
    const msLeft = new Date(w.resetsAt).getTime() - now;
    return msLeft > 0 && msLeft < 10 * 60 * 1000 && Number(w.percent) > 50;
  });
  return soon;
}

/** 期望运行账号集：{ resident 必选, spare 至多 1 }，受资源上限约束。 */
function desiredRunningAccounts(state) {
  const s = state || {};
  const lim = s.limits || limits(s.config);
  const res = s.resident;
  const desired = [];
  if (res) desired.push(res);
  const allowSpare = desired.length < lim.maxHot;
  if (allowSpare && s.needSpare) {
    const spare = (s.accounts || [])
      .filter((a) => s.isUsable(a) && (!res || a.keyId !== res.keyId))
      .sort((a, b) => quotaPercent(a) - quotaPercent(b))[0];
    if (spare) desired.push(spare);
  }
  return desired;
}

/** 账号是否属于期望运行集。 */
function isDesired(desired, acc) {
  if (!acc) return false;
  return (desired || []).some((d) => d.keyId === acc.keyId);
}

/** 绑定额度上限读取的池策略工厂（config 引用在调用时读取，支持运行期变更）。 */
function createPoolPolicy(opts) {
  const getConfig = (opts && opts.getConfig) || (() => (opts && opts.config) || {});
  return {
    limits: () => limits(getConfig()),
    switchBudgetMs: () => switchBudgetMs(getConfig()),
    stateCounts,
    residentAccount,
    needSpare,
    desiredRunningAccounts,
    isDesired,
  };
}

module.exports = { createPoolPolicy, limits, switchBudgetMs, stateCounts, residentAccount, needSpare, desiredRunningAccounts, isDesired, quotaPercent, DEFAULT_MAX_HOT, DEFAULT_MAX_WARM, DEFAULT_SWITCH_BUDGET_MS };
