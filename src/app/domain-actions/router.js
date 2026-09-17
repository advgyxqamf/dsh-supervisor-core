'use strict';

// app/domain-actions/router.js —— router 域写动作（facade 只读，写动作下沉至此）。
// 导出契约与 facade 一致：module.exports = { methods }（app/assembly/facets.js 切面装配到实例）。
// setRouterRunning 改 config + 持久化 + 生命周期镜像，是业务写动作；留在门面会让 api 经
// facade 直接改状态，绕过生命周期/事件记账。

module.exports = { methods: {

  // 智能路由开关管理
  async setRouterRunning(on) {
    // 统一生命周期视图同步：router 启停状态镜像到 lifecycleManager（归一化：启停路径收敛）
    const rlc = this.lifecycleManager ? this.lifecycleManager.get('router') : null;
    if (on) {
      // L3：优先独立 router-daemon（detached，守卫重启不影响）；daemon 不可用退回内嵌
      const rt = this.daemons.ensureRouterRuntime(true);
      if (rt.mode === 'daemon') {
        // daemon 模式下守卫不得写 providers.json（纪律本体在 _ensureRouterRuntime），但那条
        // 路径依赖返回值判定；本处是用户显式开启路径，须再兜一次，否则「三条 daemon 路径
        // 全覆盖」的不变量被破坏，双写 providers.json（漂移族 ghost）。
        this.daemons.disableRouterPersist();
        this.config.routerAutostart = true;
        this.state.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting'); /* healthy 由 _supervise mirror 观测置位 */ }
        return { ok: true, mode: rt.mode, ...this.views.routerStatus() };
      }
      const r = await this.router.start();
      this.config.routerAutostart = true;
      this.state.persistConfigPatch({ routerAutostart: true });
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; } /* healthy 由 _supervise mirror 观测置位 */ }
      return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...this.views.routerStatus() };
    }
    // 停止：若 daemon 在跑则停 daemon；否则停内嵌 router
    const rt = this.daemons.ensureRouterRuntime(false);
    if (rt.mode === 'daemon' && rt.stopping) {
      this.config.routerAutostart = false;
      this.state.persistConfigPatch({ routerAutostart: false });
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
      return { ok: true, mode: 'daemon', ...this.views.routerStatus() };
    }
    const r = this.router.stop();
    this.config.routerAutostart = false;
    this.state.persistConfigPatch({ routerAutostart: false });
    if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
    return { ok: r.ok !== false, already: !!r.already, mode: 'embedded', ...this.views.routerStatus() };
  },
} };
