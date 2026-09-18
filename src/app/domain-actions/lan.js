'use strict';

// app/domain-actions/lan.js —— relay(lan) 域写动作（facade 只读，写动作下沉至此）。
// 导出形态 { createLanActions(deps) }：**原地去 this**（P6-B-3），实现只经注入的惰性 deps 取事实。
// 本地（非 daemon）模式不直接穿透 lan 改 LanManager 状态，而是经 lifecycleManager 的
// 'lan' 登记项（app/control/adapters.js 注册时把 module 挂上）这一唯一入口取用模块，
// 生命周期登记/视图不被绕开；daemon 模式仍经 43108 ctl 委托（daemon 是唯一事实源）。

/** 经生命周期登记项取本地 LanManager（唯一入口；非 daemon 模式）。
 *  无 lifecycleManager（非守卫/单测上下文）时回退注入的 lan，保证可独立单测。 */
function lanModule(deps) {
  const lm = typeof deps.getLifecycleManager === 'function' ? deps.getLifecycleManager() : null;
  const hostLan = typeof deps.getLan === 'function' ? deps.getLan() : null;
  if (lm && typeof lm.get === 'function') {
    const lc = lm.get('lan');
    if (!lc) return null;
    // 模块挂载在 adapters 注册的 ManagedLifecycle 登记项上（首次经此取用时绑定）——
    // 写动作只经此「唯一入口」，不直接穿透 lan。
    if (!lc.module && hostLan) lc.module = hostLan;
    return lc.module || null;
  }
  return hostLan || null;
}

/** setLanFrp/lanFrpc/syncFrpc 工厂。
 *  @param deps { getDaemons, getCtl, getLifecycleManager, getLan } 全为惰性取值。 */
function createLanActions(deps) {
  const g = deps || {};
  return {

    /** 设置实例公网暴露（frp）。写动作必须经登记项；未注册则拒绝（不静默穿透）。 */
    setLanFrp(id, frpEnabled, frpRemotePort) {
      if (g.getDaemons().enabled() /* daemon 启用即 ctl */) return g.getCtl().lanCall('setFrp', [id, frpEnabled, frpRemotePort]);
      const lan = lanModule(g);
      if (!lan || typeof lan.setFrp !== 'function') return { ok: false, error: '远程控制模块未注册（lan），拒绝本地写' };
      return lan.setFrp(id, frpEnabled, frpRemotePort);
    },

    /** frpc 操作门面（settings/install/toggle）。返回 Promise（api/domains/relay.js 直接 .then）。 */
    lanFrpc(action, body) {
      if (g.getDaemons().enabled() /* daemon 启用即 ctl */) return g.getCtl().lanCall('frpAction', [action, body]);
      const lan = lanModule(g);
      if (!lan || typeof lan.frpAction !== 'function') return Promise.resolve({ ok: false, error: '远程控制模块未注册（lan），拒绝本地写' });
      return lan.frpAction(action, body);
    },

    /** 实例变化后同步 frpc 配置与进程（尽力而为，不抛异常影响主流程）。 */
    syncFrpc() {
      if (g.getDaemons().enabled() /* daemon 启用即 ctl */) { g.getCtl().lanCall('syncFrpc').catch(() => {}); return; }
      const lan = lanModule(g);
      if (lan && typeof lan.syncFrpc === 'function') lan.syncFrpc();
    },
  };
}

module.exports = { createLanActions };
