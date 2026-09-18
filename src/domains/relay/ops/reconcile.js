'use strict';

// 远程代理对账与实例联动（域：relay / ops 叶子；从 ops.js 抽出）。
// 所有操作用例显式传入 host（LanManager 实例），无隐式 this。
// 依赖：ports（端口登记）、monitor（TCP 探活）、host 上的同步/生命周期方法。

const portsvc = require('../ports');
const monitor = require('../../../platform/service/monitor');

/** 目标实例是否可达（TCP 直连探测，跨平台可靠）。 */
async function targetReachable(inst) {
  if (!inst || !inst.port) return false;
  const host = inst.host || '127.0.0.1';
  return monitor.isPortListening(host, inst.port, 600);
}

/** 串行执行 syncProxy（队列）：isTaken/allocate 是异步，并发调用会同时通过检查拿到同一 wanPort。 */
function syncProxyQueued(host, inst) {
  const run = host._proxyChain = host._proxyChain.then(() => host.syncProxy(inst)).catch(() => {});
  return run;
}

/** 删除单个代理登记（移除原因写入事件）。 */
function removeOne(host, proxy, inst) {
  host.logger.warn && host.logger.warn('[reconcile] remove proxy ' + proxy.id + ' wanPort=' + proxy.wanPort
    + ' (inst=' + !!inst + ' remoteEnabled=' + (inst && inst.remoteEnabled) + ')');
  if (host._lanServers && host._lanServers[proxy.id]) host._stopLanServer(proxy.id);
  portsvc.releaseOwner('relay:' + proxy.id); // 端口随 relay 移除（保留 inst.wanPort 绑定供再开复用）
  if (host.events) host.events.append('lan_instance_removed', { id: proxy.id, reason: !inst ? 'stale' : 'disabled' });
}

/** relay 运行 = 目标存活：up 则确保在监听，down 则暂停（保留注册）。 */
async function ensureProxyRunning(host, proxy, inst) {
  const targetAlive = await targetReachable(inst);
  const running = !!(host._lanServers && host._lanServers[proxy.id]);
  if (targetAlive && !running) {
    if (!proxy.wanPort) {
      syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
    } else {
      host._startLanServer(proxy);
    }
  } else if (!targetAlive && running) {
    host._stopLanServer(proxy.id);
  }
}

/** 剔除孤儿/关闭开关的代理；返回是否发生移除。 */
async function removeStaleProxies(host, insts) {
  let removed = false;
  const kept = [];
  for (const proxy of host.lanInstances) {
    const inst = insts.find((i) => i.port === proxy.dshPort);
    if (!inst || !inst.remoteEnabled) {
      removeOne(host, proxy, inst);
      removed = true;
    } else {
      kept.push(proxy);
      await ensureProxyRunning(host, proxy, inst);
    }
  }
  if (removed) host.lanInstances = kept;
  return removed;
}

/** 确保 remoteEnabled=true 的实例都有代理注册（新开开关/新实例；串行防竞态）。 */
function ensureRegistrations(host, insts) {
  for (const inst of insts) {
    if (inst.remoteEnabled && !host.lanInstances.some((p) => p.dshPort === inst.port)) {
      syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
    }
  }
}

/** 对账主体（由 reconcile 单飞包装调用；不直接外部调用）。 */
async function reconcileOnce(host) {
  try {
    const insts = host._allManaged();
    const removed = await removeStaleProxies(host, insts);
    if (removed) {
      host.syncFrpc();
      if (host.logger && host.logger.info) host.logger.info('reconcile lan proxies: removed disabled/stale (' + host.lanInstances.length + ' kept)');
    }
    ensureRegistrations(host, insts);
  } catch (e) {
    if (host.logger && host.logger.warn) host.logger.warn('reconcile: ' + e.message);
  }
}

/** 删除某实例关联的局域网代理（实例被删除时调用）。 */
async function removeProxyForInstance(host, instId) {
  const proxy = host.lanInstances.find((p) => p.id === instId);
  if (!proxy) return;
  host._stopLanServer(proxy.id);
  host.lanInstances = host.lanInstances.filter((p) => p.id !== instId);
  portsvc.releaseOwner('relay:' + instId); // 实例删除：端口随对象释放
  if (host.events) host.events.append('lan_instance_removed', { id: instId });
  host.syncFrpc();
}

/** 实例启动时联动远程代理：remoteEnabled 且实例在跑时确保对应 relay 在监听。 */
async function instanceStart(host, inst) {
  if (!inst || !inst.remoteEnabled || !inst.port) return;
  const existing = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (existing) host._startLanServer(existing);
  else await syncProxyQueued(host, inst);
}

/** 实例停止时联动远程代理：停止对应 relay（保留 lanInstances 注册，便于再次启动）。 */
function instanceStop(host, inst) {
  if (!inst || !inst.port) return;
  const proxy = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (proxy) host._stopLanServer(proxy.id);
}

module.exports = { targetReachable, syncProxyQueued, reconcileOnce, removeProxyForInstance, instanceStart, instanceStop };
