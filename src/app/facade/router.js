'use strict';

// app/facade/router.js —— router 域只读门面（写动作 setRouterRunning 在
// app/domain-actions/router.js）。只读白名单（不得引入写动词；DG-14 强制）：
// routerDaemonActive / routerStatusView / routerProviders / routerStatus / routerDomainSummary；
// 另含只读访问器 routerApi（返回 ctl Proxy / 本地 RouterService，自身不写）。
// 导出契约：module.exports = { methods }，方法内部走 this。

module.exports = { methods: {

  routerDaemonActive() {
    // 仅当本守卫期望 daemon 运行（routerAutostart）且管理锁在手（本守卫写过的 lock）且
    // ctl 端口（_routerCtlPort，默认 43107）监听者为 router-daemon 时，才视为 daemon 监督模式
    // （routerApi/门面/ctl 生效）。
    // 绝不因全局 ctl 端口被占就把任意 Supervisor 实例（含测试内嵌实例）误判为监督模式，
    // 否则测试 api 调用会经 ctl 打到线上 daemon（曾把测试的 provider 写操作打到生产路由）。
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
    // local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本）
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

  /** 域摘要（目录合成视图）：daemon 监督模式取目录 router-daemon 项的 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式取本地 RouterService 实时摘要。 */
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

  // L3 监督模式：router 控制通道（daemon 唯一事实源）。
  // 本方法上移至此以打断 facade/router 与 ctl/facades 的 this 调用环：ctl/facades 不再
  // 调用本文件的 routerDaemonActive；本文件对 ctl 的依赖单向（经 this._makeRouterFacade）。
  // 守卫 API/视图统一从 routerApi() 取 router 门面：daemon 在跑则转发 ctl
  // （POST /ctl {method,args}，见 src/platform/ctl/server.js）——写即 daemon 生效、读即
  // daemon 最新；daemon 未跑则走守卫本地实例（内嵌回退路径）。
  routerApi() {
    if (this.routerDaemonActive()) {
      if (!this._routerFacade) this._routerFacade = this.ctl.routerFacade();
      return this._routerFacade;
    }
    return this.router;
  },
} };
