'use strict';

// 重启编排（B13）+ 实例对账编排 —— IO 编排，经 provider 显式入参（零 this 跨文件）。
// 重启后的「kill -> 延迟 -> 拉起 -> 探活」重拉段、以及 reconcile 单飞回路。
// 注意 在途延后/退避/停进程（restartInstance 主体）仍留在 proxy.js —— 那部分被源码门禁钉住。

const { INSTANCE_STATES } = require('../model');

/** 实例回收闲置宽限期（ms）：非期望集实例若在宽限期内被使用过，本轮不回收。 */
const IDLE_RECLAIM_GRACE_MS = 90 * 1000;

/** 重启重拉编排：kill 后短延迟（端口释放）-> 拉起 -> 探活。
 *  @param deps { startInstance, waitHealthy, isAlive, logger, isStopping } */
function createRestartOrchestrator(deps) {
  const d = deps || {};
  const { startInstance, waitHealthy, isAlive, logger } = d;
  const isStopping = d.isStopping || (() => false);

  /** 重拉一个已被 kill 的实例（账号须为 ready）。
   *  @param inst 实例  @param ctx { acc, hadPid } */
  function respawn(inst, ctx) {
    const acc = ctx && ctx.acc;
    const hadPid = ctx && ctx.hadPid;
    if (acc && acc.status === 'ready') {
      setTimeout(() => {
        logger.warn && logger.warn('[proxy-instance] 重启回调触发 key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status) + ' stopping=' + isStopping() + ' pid=' + inst.pid);
        if (isStopping() || acc.status !== 'ready') return;
        // 已恢复判定：pid 存在且进程真活（仅看 pid 会误判 adopt 残留）
        if (inst.pid) {
          const alive = isAlive ? isAlive(inst.pid) : true;
          if (alive) return;
          inst.pid = null; // 进程已死：清残留，走下方重拉
        }
        const attempt = () => startInstance(inst).then((sr) => {
          if (sr && sr.ok) return waitHealthy(inst).then((ok) => { if (!ok) logger.warn && logger.warn('[proxy-instance] 重启后不健康 key=' + inst.maskedKey); });
          logger.warn && logger.warn('[proxy-instance] 重启拉起失败 key=' + inst.maskedKey + ' err=' + (sr && sr.error));
          return null;
        }).catch((e) => { logger.warn && logger.warn('[proxy-instance] 重启拉起异常 key=' + inst.maskedKey + ' ' + (e && e.message)); });
        attempt();
      }, hadPid ? 1200 : 100);
    } else if (logger.debug) {
      logger.debug('[proxy-instance] 重启跳过（账号非 ready）key=' + inst.maskedKey + ' accStatus=' + (acc && acc.status));
    }
  }

  return { respawn };
}

/** 后台异步预置：把某账号实例不等候地拉向 HOT（受资源闸约束，幂等）。 */
function prewarmAsync(provider, acc) {
  if (!acc) return;
  const inst = provider.instanceOf(acc);
  if (!inst || inst.status === INSTANCE_STATES.HOT || inst.status === INSTANCE_STATES.WARM) return;
  const lim = provider._limits();
  const counts = provider._stateCounts();
  if (counts.HOT + counts.WARM >= lim.maxHot + lim.maxWarm) return; // 资源闸
  provider.startInstance(inst)
    .then((sr) => (sr && sr.ok ? provider._waitHealthy(inst) : null))
    .catch(() => {});
}

/** 对账单轮（幂等）：拉起 desired 缺口 + （可选）回收非期望集实例。 */
async function runReconcile(provider, allowStop) {
  const out = { started: [], stopped: [], desired: [] };
  const desired = provider.desiredRunningAccounts();
  out.desired = desired.map((a) => a.keyId);
  const desiredIds = new Set(desired.map((a) => a.keyId));
  for (const acc of desired) {
    const inst = provider.instanceOf(acc);
    if (!inst || inst.pid || inst.startingPromise) continue; // 已在跑/启动中跳过（幂等）
    try {
      const r = await provider.startInstance(inst);
      if (r && r.ok) {
        await provider._waitHealthy(inst).catch(() => {});
        out.started.push(acc.keyId);
        const res = provider.residentAccount();
        if (provider.logger && provider.logger.info) provider.logger.info('[reconcile] 拉起实例 key=' + acc.maskedKey + (res && acc.keyId === res.keyId ? '（常驻）' : '（备胎）'));
      }
    } catch {}
  }
  if (!allowStop) return out;
  const graceCut = Date.now() - IDLE_RECLAIM_GRACE_MS;
  for (const inst of (provider.instances || [])) {
    if (!inst.pid) continue;
    const acc = provider.accountOf(inst);
    if (acc && desiredIds.has(acc.keyId)) continue;
    if (acc && inst.lastUsedAt && inst.lastUsedAt > graceCut) continue; // 刚用过：给闲置宽限
    try {
      provider.stopInstance(inst);
      if (acc) out.stopped.push(acc.keyId);
      else out.stopped.push(inst.keyId || 'orphan');
    } catch {}
  }
  return out;
}

/** 实例对账（单飞互斥）：周期对账完整跑，事件补起撞 busy 直接跳过。 */
async function reconcileInstances(provider, opts) {
  if (!provider.activated || provider._stopping) return { started: [], stopped: [], desired: [] };
  const allowStop = !(opts && opts.stop === false);
  if (provider._reconcileBusy) {
    if (!allowStop) return { started: [], stopped: [], desired: [] };
    try { await provider._reconcileBusy; } catch {}
  }
  if (provider._reconcileBusy) return provider._reconcileBusy;
  const p = runReconcile(provider, allowStop);
  provider._reconcileBusy = p;
  try { return await p; } finally { if (provider._reconcileBusy === p) provider._reconcileBusy = null; }
}

/** 事件驱动即时对账（冻结 mark* 后）：仅补起 desired 缺口，不中途杀实例。 */
function reconcileNow(provider) {
  if (provider._stopping) return;
  reconcileInstances(provider, { stop: false }).catch(() => {});
}

module.exports = { createRestartOrchestrator, prewarmAsync, runReconcile, reconcileInstances, reconcileNow };
