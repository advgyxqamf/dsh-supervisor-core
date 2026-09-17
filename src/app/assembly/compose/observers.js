'use strict';

// app/assembly/compose/observers.js —— 组装第三步：实例事件接线 + 生命周期注册/视图同步。
// 以 host 显式入参，零 this。
// 实例事件（onRemoteChange/onRemove/onInstanceStart/onInstanceStop/onCreate/onDestroy）
//   把域事件桥接到 relay 对账 / lan-state 收敛 / 受管目录申报；
// 末段把全部模块注册进 LifecycleManager 并立即同步视图（必须在 start() 之前完成）。
const { registerAll } = require('../../../app/control/adapters');

function composeObservers(host) {
    // 桥接：实例 remoteEnabled 变化时同步远程代理
    // 实例事件 -> 远程代理对账。config.lanDaemon 下守卫不再本地建 relay，只把实例清单写入
    // lan-state.json（daemon 轮询收敛：新增/启停/remoteEnabled 变化均经 reconcile 处理）。
    host.instances.onRemoteChange = (inst) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.syncProxy(inst).catch((e) => host.logger.warn && host.logger.warn('lan syncProxy: ' + e.message));
    };
    host.instances.onRemove = (id) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.removeProxyForInstance(id).catch((e) => host.logger.warn && host.logger.warn('lan removeProxy: ' + e.message));
    };
    // 实例启停时联动远程代理：启动则确保 relay 在跑，停止则停 relay（保留注册）。
    // 启停动作同时申报目录（desired 随动作立即对齐，不用等下一拍心跳同步）。
    host.instances.onInstanceStart = (inst) => {
      if (host.managedObjects) { try { host._upsertManaged(host._managedSandboxSpec(inst)); } catch {} }
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.instanceStart(inst).catch((e) => host.logger.warn && host.logger.warn('lan instanceStart: ' + e.message));
    };
    host.instances.onInstanceStop = (inst) => {
      if (host.managedObjects) { try { host._upsertManaged(host._managedSandboxSpec(inst)); } catch {} }
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      try { host.lan.instanceStop(inst); } catch (e) { host.logger.warn && host.logger.warn('lan stop: ' + e.message); }
    };
    // 控制平面申报：沙箱实例创建/销毁 -> 管家注册机登记/注销。
    host.instances.onCreate = (inst) => { if (host.managedObjects) host._upsertManaged(host._managedSandboxSpec(inst)); };
    host.instances.onDestroy = (id) => host._unregisterManaged(id);
    // 统一生命周期管理器注册：把全部模块注册为 ManagedLifecycle。
    // 必须在构造期完成：测试/API 在 start() 之前就会经 lifecycleManager.get('router')
    //   读视图，放到 bootstrap 会让它们拿到 null。
    try {
      registerAll(host.lifecycleManager, {
        router: host.router, lan: host.lan, instances: host.instances,
        supervisor: host, pluginManager: host.pluginManager, logger: host.logger,
      });
      if (host.logger && host.logger.info) host.logger.info('[lifecycle] 已注册模块: ' + host.lifecycleManager.all().map((l) => l.id).join(','));
      host._syncDshLifecycleView();   // 注册后立即同步 DSH 视图（不等首个 tick）
      try { host._syncInstancesLifecycleView(); } catch (e) {}
    } catch (e) { host.logger.warn && host.logger.warn('[lifecycle] 注册失败: ' + (e && e.message)); }
}

module.exports = { composeObservers };
