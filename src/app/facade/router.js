'use strict';

// app/facade/router.js —— router 域**只读门面**（R7：facade 只留只读视图）。
//
// 步骤 7 迁移：自 control-view.js 逐字搬出；2026-09-17 R7 纯化：写动作 setRouterRunning
//   下沉 app/domain-actions/router.js —— 本文件只保留 5 个只读视图。
// 导出契约不变：module.exports = { methods }；方法内部仍走 this（装配契约，批 10 前不变）。
//
//  只读白名单（不得再引入写动词；门禁 test/domain-structure-gate-test.js DG-14 强制）：
//   routerDaemonActive / routerStatusView / routerProviders / routerStatus / routerDomainSummary；
//   另含只读访问器 routerApi（SCC④ 由 ctl/facades 上移，返回 ctl Proxy / 本地 RouterService，自身不写）。

module.exports = { methods: {

  routerDaemonActive() {
    // 仅当本守卫「期望 daemon 运行（routerAutostart）」且「管理锁在手（本守卫写过的 lock）」且
    // ctl 端口（_routerCtlPort，默认 43107）监听者为 router-daemon 时，才视为「daemon 监督模式」
    // （routerApi/门面/ctl 生效）。
    // 关键：绝不因全局 ctl 端口被占就把任意 Supervisor 实例（含测试内嵌实例，乃至运行中把
    // routerAutostart 置真的测试/内嵌路径）误判为监督模式——否则测试 api 调用会经 ctl 打到
    // 线上 daemon（2026-09 实测 p2p-api-test 误接生产路由：/router/start 置 autostart=true 后
    // 后续全部 provider 视图/写操作打到生产 daemon）。
    try {
      if (!this.config || this.config.routerAutostart !== true) return false;
      if (!this.daemons.managed()) return false;
      return this.daemons.routerActive();
    } catch { return false; }
  },

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
  async routerStatusView() {
    if (this.routerDaemonActive()) {
      try {
        const st = await this.routerApi().status();
        return { running: !!(st && st.running), autostart: this.config.routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return this.routerStatus();
  },

  routerProviders() {
    const presets = this.router.constructor.presets();
    // 阶段三：local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本——见 PHASE3 设计）
    const local = () => ({ presets, providers: this.router.listProviders(), proxyApps: this.router.proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!this.routerDaemonActive()) return local();
    const rt = this.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (this.logger && this.logger.warn) this.logger.warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  },

  routerStatus() {
    const st = this.router.status();
    return { running: !!st.running, autostart: this.config.routerAutostart === true, ...st };
  },

  /** R4 域摘要（目录合成视图）：daemon 监督模式 → 目录 router-daemon 项 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式 → 本地 RouterService 实时摘要。 */
  routerDomainSummary() {
    if (this.routerDaemonActive()) {
      try {
        const e = this.managedObjects && typeof this.managedObjects.get === 'function' ? this.managedObjects.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const s = this.router && typeof this.router.domainSummary === 'function' ? this.router.domainSummary() : null;
      return { ok: true, source: 'embedded', summary: s };
    } catch (e2) {
      return { ok: false, source: 'embedded', error: (e2 && e2.message) || String(e2) };
    }
  },

  // ---- L3 监督模式：router 控制通道（daemon 唯一事实源，2026-09）----
  // ⚠ R7/SCC④（2026-09-17）：本方法原在 app/ctl/facades.js。上移至此以打断
  //   `facade/router ↔ ctl/facades` 的 this 调用环 —— ctl/facades 不再调用本文件的
  //   routerDaemonActive；本文件对 ctl 的依赖是单向的（经 this._makeRouterFacade）。
  // 守卫 API/视图统一从 routerApi() 取 router 门面：daemon 在跑 → 方法调用转发 ctl
  // （POST /ctl {method,args}，见 src/platform/ctl/server.js）——写即 daemon 生效、
  // 读即 daemon 最新；daemon 未跑 → 守卫本地实例（内嵌回退路径，行为不变）。
  routerApi() {
    if (this.routerDaemonActive()) {
      if (!this._routerFacade) this._routerFacade = this.ctl.routerFacade();
      return this._routerFacade;
    }
    return this.router;
  },
} };
