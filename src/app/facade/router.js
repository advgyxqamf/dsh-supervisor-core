'use strict';

// app/facade/router.js —— router 域只读门面（写动作 setRouterRunning 在
// app/domain-actions/router.js）。只读白名单（不得引入写动词；DG-14 强制）：
// routerDaemonActive / routerStatusView / routerProviders / routerStatus / routerDomainSummary；
// 另含只读访问器 routerApi（返回 ctl Proxy / 本地 RouterService，自身不写）。
// 导出契约：module.exports = { methods }，方法内部走 this。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的**惰性 deps**
// （WeakMap；getter 每次读 host 实时值，装配期 host 未就绪也安全）。方法仍以 { methods }
// 导出、名字与体逐字保留：装配路径 installMethods(host, mod.methods) 不变，读源码形态的门禁
// （DG-14 对 app/facade/*）覆盖面不变，AT 棘轮统计的直接方法调用计数据此归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      daemons() { return host.daemons; },
      router() { return host.router; },
      logger() { return host.logger; },
      managedObjects() { return host.managedObjects; },
      ctl() { return host.ctl; },
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用；外部覆写 host 方法仍生效）。
      routerDaemonActive() { return host.routerDaemonActive(); },
      routerApi() { return host.routerApi(); },
      routerStatus() { return host.routerStatus(); },
      readRouterFacade() { return host._routerFacade; },
      writeRouterFacade(v) { host._routerFacade = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  routerDaemonActive() {
    const d = depsOf(this);
    // 仅当本守卫期望 daemon 运行（routerAutostart）且管理锁在手（本守卫写过的 lock）且
    // ctl 端口（_routerCtlPort，默认 43107）监听者为 router-daemon 时，才视为 daemon 监督模式
    // （routerApi/门面/ctl 生效）。
    // 绝不因全局 ctl 端口被占就把任意 Supervisor 实例（含测试内嵌实例）误判为监督模式，
    // 否则测试 api 调用会经 ctl 打到线上 daemon（曾把测试的 provider 写操作打到生产路由）。
    try {
      const cfg = d.config();
      if (!cfg || cfg.routerAutostart !== true) return false;
      if (!d.daemons().managed()) return false;
      return d.daemons().routerActive();
    } catch { return false; }
  },

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
  async routerStatusView() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      try {
        const st = await d.routerApi().status();
        return { running: !!(st && st.running), autostart: d.config().routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (d.logger() && d.logger().warn) d.logger().warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return d.routerStatus();
  },

  routerProviders() {
    const d = depsOf(this);
    const presets = d.router().constructor.presets();
    // local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本）
    const local = () => ({ presets, providers: d.router().listProviders(), proxyApps: d.router().proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!d.routerDaemonActive()) return local();
    const rt = d.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (d.logger() && d.logger().warn) d.logger().warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  },

  routerStatus() {
    const d = depsOf(this);
    const st = d.router().status();
    return { running: !!st.running, autostart: d.config().routerAutostart === true, ...st };
  },

  /** 域摘要（目录合成视图）：daemon 监督模式取目录 router-daemon 项的 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式取本地 RouterService 实时摘要。 */
  routerDomainSummary() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      try {
        const mo = d.managedObjects();
        const e = mo && typeof mo.get === 'function' ? mo.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const r = d.router();
      const s = r && typeof r.domainSummary === 'function' ? r.domainSummary() : null;
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
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      if (!d.readRouterFacade()) d.writeRouterFacade(d.ctl().routerFacade());
      return d.readRouterFacade();
    }
    return d.router();
  },
} };
