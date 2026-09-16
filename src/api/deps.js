'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// api/deps —— 每域所需的 supervisor 成员**显式声明**（步骤 9 建立）
//
// ## 为什么有本文件（解决的问题）
//   各域 handler 直接读 `sup.xxx`（共 40+ 个成员），而 supervisor 是一个巨型对象。
//   于是「某域到底依赖哪些能力」只存在于**代码文本**里：删掉一个 sup 方法时，
//   没有任何地方能告诉你谁会断、有几个消费者——这正是本仓反复出现的
//   「接口面不可见 → 耦合只增不减」的病态。
//   把依赖**写成数据**后：改 supervisor 前可先查本表（谁在用），
//   后续（步骤 10+）可据此把门面收紧为**显式注入的具名协作者**。
//
// ## ⚠ 本步骤（9）的约束：**只声明，不强制**
//   另一个并行重构正在把 supervisor 降为薄壳（但保留兼容门面）。
//   若本文件此刻就做运行期校验（缺成员即报错），会与那次重构双向冲突：
//   门面方法在过渡期可能被移动/改名，而声明表尚未同步 → 误报为运行时故障。
//   因此本文件当前**只是文档性数据**（无逻辑、无副作用、不被 index.js 加载）。
//   强制校验留到两路重构汇合后单独立项（见文末"启用条件"）。
//
// ## 声明口径（如何读/如何维护）
//   · 只列该域**直接消费**的 supervisor 成员；经其它模块（如 ctx 里的 send）转交的不计。
//   · `config` 在本仓语义为 sup.config（apiPort/apiAccessKey 等）。
//   · 新增域 / 新增 sup 读取点时必须同步本表——否则本表即失效，
//     与「注释声称、代码没有」是同一类失效模式（见 test 里的反向判据思路）。
//   · 网关自身（index.js）消费的成员单列在 GATEWAY 下，不摊到任何域。
// ═══════════════════════════════════════════════════════════════════════════

/** 网关自身（api/index.js）直接消费的 sup 成员（域分派之前/之后）。 */
const GATEWAY = {
  // 第三层访问密钥门卫：读 sup.config.apiAccessKey；令牌下发经 sup.tokenService。
  sup: ['config', 'tokenService'],
};

/** 每域 handle(ctx) 直接读取的 sup 成员（按 domains/ 下模块归集）。 */
const DOMAIN_DEPS = {
  // 统一安装/更新任务（Task Registry）。
  tasks: ['tasks'],

  // 统一生命周期：status/lifecycle/healthz/readyz/events/logs/metrics/session。
  lifecycle: [
    'config',            // originAllowed 需要 apiPort（写动作 CSRF 闸）
    'desired', 'phase',  // /lifecycle/dsh/{start|stop|restart} 回执形状
    'eventHub',          // /events、/logs/tail、/logs/export、/metrics 的统一读路径
    'events',            // eventHub 缺失时的空事件兜底（seq）
    'health',            // /healthz、/readyz（缺失时回退默认）
    'lifecycleManager',  // 模块生命周期唯一入口
    'sessionState',      // /session/status（INV-S4 唯一读取口）
    'shutdownAll',       // /session/stop（INV-S2 退出唯一入口）
    'statusSummary',     // /status、dsh 启停回执
  ],

  // 原生 DSH 生命周期（唯一通道）。
  native: [
    'config',         // 写动作 CSRF 闸
    'nativeManager',  // status/versionInfo/upgradeStatus/install/upgrade/uninstall
    'patchDshMain',   // /native/settings：main 元数据补丁（guardian/remoteEnabled/frp）——实现：app/domain-actions/main.js（R7 写动作下沉）
  ],

  // 守卫/设置域：changelog·版本·autostart·settings·self-update·env·ports·shutdown。
  guard: [
    'config',
    'nativeManager',         // /changelog：DSH 版本信息
    'guardVersionLocal', 'guardVersionCheck',
    'autostartStatus', 'setAutostart',
    'lanPanelStatus', 'setLanPanel',
    'accessKeyStatus', 'setAccessKey',
    'closeActionStatus', 'setCloseAction',
    'shutdownAll',           // /shutdown（旧退出入口）
    'guardSelfUpdateStatus', // /self-update/status（只读；写端点已下架=410）
    'dshenvStatus', 'envStatus', 'nodeLtsStatus',
    'listPorts',             // /ports 统一端口清单
  ],

  // 智能路由（中转服务）：状态/生命周期/供应商/反代/账号。
  router: [
    'config',
    'routerApi',            // ctl 门面（portsView/providers/keys/login/update/...）——实现：app/facade/router.js（R7/SCC④ 由 ctl/facades 上移）
    'routerDomainSummary',  // daemon 监督拍的域摘要缓存
    'routerProviders', 'routerStatusView',
    'setRouterRunning',     // /router/{start|stop}——实现：app/domain-actions/router.js（R7 写动作下沉）
  ],

  // 插件管理。
  plugins: ['config', 'pluginManager', 'pluginMarket'],

  // 镜像源分发（/dist/registry*，DistributionManager 统一管理）。
  dist: ['config', 'dist'],

  // 沙箱实例 CRUD/启停/open-web/版本更新（+ 原生 main 只读视图）。
  instances: [
    'config',
    'instances',    // 沙箱实例管理对象（list/addInstance/startInstance/...）
    'dshMainView',  // 原生主干 main 的守卫核心视图（只读条目）
    'listLan',      // 局域网 relay 条目（authUrl/lanUrl 装饰）
  ],

  // 远程控制/中继（lan frp·lan-access）。
  // ⚠ R7（2026-09-17）：读写已分层——只读 frpStatus/listLan 在 app/facade/lan.js；
  //   写动作 setLanFrp/lanFrpc/syncFrpc 在 app/domain-actions/lan.js（本地经 lifecycle 'lan' 登记项唯一入口）。
  relay: ['config', 'frpStatus', 'lanFrpc', 'setLanFrp', 'listLan'],

  // 桌面壳更新安全网（/shell/*）——内核仅做安全网，非更新源。
  shell: [
    'config',
    'shellDomain',  // 壳安全网（status/health/markPending/checkUpdate/restartShell）
    'dist',         // checkUpdate 复用分发服务查版本
    'events',       // 更新账本事件追加
  ],
};

// ── 启用条件（本步骤不做，留待汇合后立项）────────────────────────────────
//   1) 并行 guard 重构落地、supervisor 门面稳定；
//   2) index.js 以 DOMAIN_DEPS 做**装配期**校验：域模块加载时断言
//      "该域声明的成员在 sup 上可用（函数/对象）"，缺失即 fail-fast；
//   3) 同步更新 test：源码扫描出的 sup.* 集合必须与 DOMAIN_DEPS 完全一致
//      （双向一致，防声明表腐化——与 api-surface 的"双向一致"同一纪律）。
//   在此之前，本表是**权威的依赖清单**，供人/工具查询，不产生运行期行为。

module.exports = { GATEWAY, DOMAIN_DEPS };
