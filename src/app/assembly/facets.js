'use strict';

// app/assembly/facets.js —— 编排层「切面装配清单 + 兼容门面落地」。
//
// 取代旧 supervisor.js 末尾的原型挂载（DG-8 / DS-G3b 硬失败项）：装配目标是 host
// 实例（Supervisor 的组装上下文），不再触碰任何 prototype：
//   { methods }             -> 成员方法，this = host（跨文件 this.X() 语义不变）
//   { accessors }           -> get/set 描述符（落到 host 实例）
//   host-first 自由函数模块 -> 首参绑定包装（fn(this, ...args)）
//   api-rebind              -> 需 root 注入 createServer（app 不得 require api，DS-3）
// 每个模块在 FACETS 里是一个具名切面（name）；本表是「哪些模块 -> 哪些成员」的唯一声明处。

const { installCollaborators } = require('./collaborators');

// 切面清单（顺序与旧 APP_MODULES 逐字一致，保证同名成员覆盖序不变）
const FACETS = [
  { name: 'assembly/bootstrap', mod: require('./bootstrap'), hostFirst: true },
  { name: 'assembly/api-rebind', mod: require('./api-rebind'), apiRebind: true },
  // 级 2：session/machine + state/{store,fields,desired,upgrade-hold,main-store}
  //   + control/{projection,specs} 已改为**真 ctor 工厂**，经 assembly/collaborators.js 装配，
  //   不再在此以 { methods }/{ hostFirst } 形态安装（见 collaborators.js）。
  { name: 'session/shutdown', mod: require('../session/shutdown'), hostFirst: true },
  { name: 'self/notify', mod: require('../self/notify'), hostFirst: true },
  { name: 'control/scheduler', mod: require('../control/scheduler') },
  { name: 'control/instance-adapter', mod: require('../control/instance-adapter') },
  { name: 'main/decide', mod: require('../main/decide') },
  { name: 'main/controller', mod: require('../main/controller') },
  { name: 'main/shadow', mod: require('../main/shadow') },
  { name: 'main/process', mod: require('../main/process') },
  // R3 严值 DF-2：端口运行时再推导从 main/process.js 拆为独立切面（_findManagedDshPort/_applyMainPort）。
  { name: 'main/port-rederive', mod: require('../main/port-rederive') },
  { name: 'main/signals', mod: require('../main/signals') },
  { name: 'main/health-gate', mod: require('../main/health-gate') },
  { name: 'daemons/supervise', mod: require('../daemons/supervise') },
  { name: 'daemons/runtime', mod: require('../daemons/runtime') },
  { name: 'daemons/identity', mod: require('../daemons/identity') },
  { name: 'daemons/probe', mod: require('../daemons/probe') },
  { name: 'ctl/client', mod: require('../ctl/client') },
  { name: 'ctl/facades', mod: require('../ctl/facades') },
  { name: 'facade/router', mod: require('../facade/router') },
  { name: 'facade/lan', mod: require('../facade/lan') },
  { name: 'facade/ports', mod: require('../facade/ports') },
  { name: 'facade/main', mod: require('../facade/main') },
  { name: 'facade/status', mod: require('../facade/status'), hostFirst: true },
  // 域写动作下沉 app/domain-actions/（facade 只读），同一装配契约。
  //   ⚠ P6-B：三者已改为**真 ctor 工厂**（实现体经显式 deps 取事实，不再直连 this），
  //   故不再走 `f.mod.methods` 分支 —— 用 factory 名在装配期构造，并把产物**平铺安装**到 host，
  //   保证 api 消费面（sup.setRouterRunning / patchDshMain / setLanFrp …）名字逐个不变。
  { name: 'domain-actions/router', mod: require('../domain-actions/router'), factory: 'createRouterActions' },
  { name: 'domain-actions/lan', mod: require('../domain-actions/lan'), factory: 'createLanActions' },
  { name: 'domain-actions/main', mod: require('../domain-actions/main'), factory: 'createMainActions' },
  { name: 'audit/orphan-scan', mod: require('../audit/orphan-scan') },
  { name: 'settings/env', mod: require('../settings/env') },
  { name: 'settings/node-lts', mod: require('../settings/node-lts') },
  { name: 'settings/versions', mod: require('../settings/versions') },
  { name: 'settings/access', mod: require('../settings/access') },
  { name: 'settings/lan-panel', mod: require('../settings/lan-panel') },
];

/** 把 methods 逐个装到 host 实例（不碰 prototype）。 */
function installMethods(host, methods) {
  for (const name of Object.keys(methods || {})) {
    const fn = methods[name];
    if (typeof fn === 'function') host[name] = fn;
  }
}

/** 把 accessors 逐个装到 host 实例（get/set 无法经赋值复制）。 */
function installAccessors(host, accessors) {
  for (const name of Object.keys(accessors || {})) {
    Object.defineProperty(host, name, accessors[name]);
  }
}

/** host-first 自由函数模块：把 (host, ...args) 绑成 host 上的方法（this 动态）。 */
function installHostFirst(host, mod) {
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    host[name] = function (...args) { return fn(this, ...args); };
  }
}

/**
 * 组装期把全部切面装到 host 实例。必须在 composeSystem 业务体之前调用：
 * compose 构造期即会经 host._mSetX()/_bindNativeDshCommand()/loadState() 取用。
 * @param host  组装上下文（Supervisor 实例）
 * @param deps  { createServer } 由 root 注入（app 不得 require api，DS-3）
 */
/** 域写动作工厂的惰性 deps：装配期 host 尚未就绪，故一律 getter（与 collaborators.js 同范式）。
 *  覆盖三个工厂实际取用的全部成员（router: config/daemons/lifecycleManager/router/state/views；
 *  lan: ctl/daemons/lifecycleManager/lan；main: daemons/events/logger/state/views）。 */
function domainActionDeps(host) {
  return {
    getConfig: () => host.config,
    getDaemons: () => host.daemons,
    getState: () => host.state,
    getViews: () => host.views,
    getRouter: () => host.router,
    getLan: () => host.lan,
    getCtl: () => host.ctl,
    getEvents: () => host.events,
    getLogger: () => host.logger,
    getLifecycleManager: () => host.lifecycleManager,
  };
}

function installFacets(host, deps) {
  const d = deps || {};
  for (const f of FACETS) {
    if (f.apiRebind) {
      // api-rebind 的 startApi/_rebindApiHost 需要 createServer，以注入方式提供。
      host._apiStart = function _apiStart() { return f.mod.startApi(this, d.createServer); };
      host._apiRebind = function _apiRebind() { return f.mod._rebindApiHost(this, d.createServer); };
      continue;
    }
    if (f.hostFirst) { installHostFirst(host, f.mod); continue; }
    // 真 ctor 工厂切面（域写动作）：构造后平铺安装，平铺名与旧 { methods } 逐字一致。
    if (f.factory) { installMethods(host, f.mod[f.factory](domainActionDeps(host))); continue; }
    if (f.mod.methods) installMethods(host, f.mod.methods);
    if (f.mod.accessors) installAccessors(host, f.mod.accessors);
    // 字段 helper（_mXxx/_mSetXxx）由生成器产出于实例上（取代挂原型）。
    if (typeof f.mod.buildFieldHelpers === 'function') f.mod.buildFieldHelpers(host);
  }
  // state/session/control 由真 ctor 工厂构造（自己持有实现）；其余切面为薄委托。
  // 必须在全部切面装毕之后：薄委托协作方转发到 host 上的既有切面方法。
  installCollaborators(host, { validate: true });
}

module.exports = { FACETS, installFacets };
