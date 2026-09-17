'use strict';

// 账号与实例生命周期（providers 叶子）。有状态协作经 provider 显式入参（与 probe.js/restart.js
// 同形），无隐式 this。

const { INSTANCE_STATES } = require('../model');
const pidlook = require('../../../platform/os/pidlookup');
const { accountModel } = require('./model');

/** 实例停止仲裁：在途不停止；付费侧在用保留。 */
function canStopInstance(provider, acc) {
  if (!acc) return true;
  if ((acc.inflight || 0) > 0) return false;
  if (acc.status === 'ready' && provider.isAccountUsable(acc)) {
    if (provider.selectedAccountKeyId === acc.keyId || (provider.activeAccount && provider.activeAccount.keyId === acc.keyId)) return false;
  }
  return true;
}

/** 实例停止（幂等）：在途/在用 -> 标记待停（请求结束补刀/reconcile 补停）；force 跳过仲裁。 */
function stopInstance(provider, inst, force) {
  if (!inst) return;
  const acc = provider.accounts.find((a) => a.keyId === inst.keyId) || null;
  if (acc && !force && !canStopInstance(provider, acc)) {
    acc._stopPendingUntilIdle = true;
    return;
  }
  if (acc) acc._stopPendingUntilIdle = false;
  if (!inst.pid) {
    inst.status = INSTANCE_STATES.COLD;
    inst.healthy = false;
    provider._persist();
    return;
  }
  // pid 快照：必须在置 null 前保存，否则 kill(-null)=kill(-0) 会自杀当前进程组
  const pid = inst.pid;
  if (provider._terminatingPids && provider._terminatingPids.size) {
    for (const q of [...provider._terminatingPids]) {
      let al = true;
      try { al = pidlook.isAlive ? pidlook.isAlive(q) : true; } catch { al = false; }
      if (!al) provider._terminatingPids.delete(q);
    }
  }
  try { provider._terminatingPids.add(pid); } catch {}
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  // SIGKILL 兜底 1.5s（unref）；daemon 优雅退出必须另经 waitAllStopped 确认
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }, 1500).unref();
  inst.pid = null;
  inst.status = INSTANCE_STATES.COLD;
  inst.healthy = false;
  provider._persist();
}

/** 请求结束补刀：待停且已无在途 -> 立即停（取代旧一次性 timer 的泄漏根因）。 */
function retryPendingStop(provider, acc) {
  if (!acc || !acc._stopPendingUntilIdle) return;
  if ((acc.inflight || 0) > 0) return;
  const inst = provider.instanceOf(acc);
  if (inst && inst.pid) { stopInstance(provider, inst); }
  else acc._stopPendingUntilIdle = false;
}

/** 停掉账号实例（统一经 instanceOf 按 keyId 映射）。 */
function stopInstanceIfAny(provider, acc) {
  if (!acc) return;
  const inst = provider.instanceOf(acc);
  if (inst) { try { stopInstance(provider, inst); } catch {} }
}

async function waitHealthy(provider, inst, tries) {
  const n = tries === undefined ? 6 : tries;
  for (let i = 0; i < n; i++) {
    await provider.healthInstance(inst);
    if (inst.healthy) return true;
    // 只有「进程已不在」（COLD）才无望等待；DEAD/WARM 仍可重试（进程在但启动慢）
    if (inst.status === INSTANCE_STATES.COLD) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function isAccountUsable(provider, acc, opts) {
  if (!acc || acc.status !== 'ready') return false;
  if (provider._isCreditsLow(acc)) return false;
  const inst = acc.instance || (provider.instances || []).find((i) => i.keyId === acc.keyId);
  if (!inst) return false;
  if (opts && opts.checkWindows === false) return true;
  return !provider._windowExhausted(acc);
}

/** 加账号：建实例、启动、探活、配额检测，最后经统一 applyDetection 入库。 */
async function addAccount(provider, key, extra) {
  const existing = provider.accounts.find((a) => a.key === key);
  if (existing) return { ok: true, account: existing, already: true };
  const inst = await provider.ensureInstance(key);
  const acc = accountModel(key, { instance: inst, ...(extra || {}) });
  provider.accounts.push(acc);
  provider._persist();
  try { await provider._ensurePkgCached(provider.app); } catch {}
  const r = await provider.startInstance(inst);
  if (!r.ok) {
    acc.status = 'discarded';
    acc.detectError = r.error;
    provider._persist();
    return { ok: false, error: r.error, account: acc };
  }
  const healthy = await waitHealthy(provider, inst);
  if (!healthy) {
    acc.status = 'discarded';
    acc.detectError = '实例启动失败（探活超时）';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  const det = await provider.detectInstanceQuota(inst);
  if (!det.ok && !det.quota) {
    acc.status = 'discarded';
    acc.detectError = det.error || '无法获取配额';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  acc.quota = det.quota || null;
  inst.quota = det.quota || null;
  const summary = provider.accountQuotaSummary(acc);
  // 统一入库：与 base 同一 applyDetection 状态机（受限则 frozen + limit + recovery，正常则 ready）
  provider.applyDetection(acc, { ok: true, quota: det.quota || null });
  if (acc.status === 'frozen' && acc.instance && acc.instance.pid) { try { stopInstance(provider, acc.instance); } catch {} }
  if (acc.status === 'ready' && provider.events) provider.events.append('account_ready', { provider: provider.name, key: acc.maskedKey });
  const limited = (acc.limit && acc.limit.kind) || null;
  return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
}

module.exports = { canStopInstance, stopInstance, retryPendingStop, stopInstanceIfAny, waitHealthy, isAccountUsable, addAccount };
