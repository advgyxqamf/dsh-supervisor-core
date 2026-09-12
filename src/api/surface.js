'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// API 契约面（单一事实源）—— P3 断点修复。
//
// 背景（功能断点审计 D1）：仓库长期**无受强制的 API 契约**，表现为：
//   1) README 的 API 清单已过期（仍文档化 R3 已删除的 POST /start|/stop|/restart，
//      却遗漏 /lifecycle、/session、/ports、/metrics、/logs、/env/status 等大半真实路由）；
//   2) 「端点是否有消费者」只能靠一次性 grep 审计，无法作为**常驻不变量**防回归。
//
// 本模块把「每个路由属于哪一类、谁在消费」显式声明；test/api-surface-test.js 断言
// 源码里出现的每个路由都在此处登记（双向一致）。新增路由若不登记 → 测试失败。
//
// 分类语义：
//   public      一方客户端消费（前端 UI / CLI / 桌面壳）
//   operational 运维/监控/审计面（外部工具消费，一方 UI 不调用——工业标准的可观测接口）
//   internal    守卫自身内部消费（不对外承诺稳定性）
//   deprecated  兼容保留（明确移除条件，避免静默删除破坏旧客户端）
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIES = ['public', 'operational', 'internal', 'deprecated'];

/** 精确路由（pathname ===）。methods 为实际支持的方法。 */
const SURFACE = [
  // ── 生命周期域（lifecycle.js）──
  { path: '/status',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(polling)', 'CLI(status)'], note: '状态摘要' },
  { path: '/events',         methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI(timeline)'], note: '增量事件' },
  { path: '/healthz',        methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['壳(握手探针)'], note: '存活探针' },
  { path: '/readyz',         methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控/编排探针'], note: '就绪探针（守卫已初始化且未停机）' },
  { path: '/session/status', methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['壳(get_session_state)'], note: '会话态读取口' },
  { path: '/session/stop',   methods: ['POST'], domain: 'lifecycle', category: 'public',      consumers: ['壳(退出握手)'], note: '停全部被管对象 + 回执（守卫不自停）' },
  { path: '/metrics',        methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['监控接入'], note: '监控：事件流派生遥测（bySource/topTypes/事件率）' },
  { path: '/logs/tail',      methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['远程诊断'], note: '诊断：各 stream 日志尾部（跨机排障；本机 CLI 直读文件）' },
  { path: '/logs/export',    methods: ['GET'],  domain: 'lifecycle', category: 'operational', consumers: ['审计/离线备份'], note: '审计：聚合流 JSONL 导出（离线备份/合规留痕）' },
  { path: '/lifecycle',      methods: ['GET'],  domain: 'lifecycle', category: 'public',      consumers: ['UI'], note: '模块生命周期一览（=/lifecycle/status）' },
  { path: '/lifecycle/status', methods: ['GET'], domain: 'lifecycle', category: 'public',     consumers: ['UI'], note: '同上（显式别名）' },

  // ── 守卫/设置域（guard.js）──
  { path: '/changelog',            methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: 'DSH 更新日志（text/plain）' },
  { path: '/guard/changelog',      methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '管家更新日志（CHANGELOG.md）' },
  { path: '/guard/version',        methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '本地版本（无网络 I/O）' },
  { path: '/guard/version/check',  methods: ['POST'], domain: 'guard', category: 'public',      consumers: ['UI(AboutCard, 源码形态)'], note: 'git 上游检查（源码部署形态更新通道）' },
  { path: '/autostart',            methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '整条服务链开机自启' },
  { path: '/shutdown',             methods: ['POST'], domain: 'guard', category: 'deprecated',  consumers: ['旧版壳兼容'], note: '已由 POST /session/stop 取代；保留供旧壳退出（移除条件：壳最低版本 >= 使用 /session/stop 的版本）' },
  { path: '/ports',                methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(PortPanel)'], note: '端口视图（聚合三注册表）' },
  { path: '/env/dsh',              methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['README 文档化（外部脚本）'], note: 'DSH 本体安装/纳管判定（bin/binOk/managed/phase）' },
  { path: '/env/status',           methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(InstancesPage 能力矩阵)'], note: '环境 + 平台能力矩阵 + catalog' },
  { path: '/env/node-lts',         methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(OverviewPage)'], note: 'Node 当前 vs 官方最新 LTS' },
  { path: '/settings/access-key',  methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '访问密钥' },
  { path: '/settings/close-action', methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)', '壳(读取执行)'], note: '关窗行为（hide/exit）' },
  { path: '/settings/lan',         methods: ['GET', 'POST'], domain: 'guard', category: 'public', consumers: ['UI(StartupCard)'], note: '面板局域网访问开关' },
  { path: '/self-update/status',   methods: ['GET'],  domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '内核自更新状态' },
  { path: '/self-update/apply',    methods: ['POST'], domain: 'guard', category: 'public',      consumers: ['UI(AboutCard)'], note: '执行内核自更新' },
  { path: '/self-update/restart-guard', methods: ['POST'], domain: 'guard', category: 'public', consumers: ['UI(AboutCard)'], note: '重启守卫以生效（守卫退出 + systemd 重拉）' },

  // ── 原生 DSH（native.js）──
  { path: '/native/status',       methods: ['GET'],  domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(status)'], note: '安装状态 + 版本 + 升级状态机' },
  { path: '/native/check-update', methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '触发版本检查' },
  { path: '/native/install',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI'], note: '异步安装（202）' },
  { path: '/native/uninstall',    methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)'], note: '异步卸载（202）' },
  { path: '/native/upgrade',      methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage)', 'CLI(upgrade)'], note: '一键升级（失败回滚）' },
  { path: '/native/settings',     methods: ['POST'], domain: 'native', category: 'public', consumers: ['UI(OverviewPage/LanPage)'], note: 'main 元数据补丁（guardian/remote/frp）' },

  // ── 沙箱实例（instances.js）──
  { path: '/instances',           methods: ['GET'],  domain: 'instances', category: 'public', consumers: ['UI(InstancesPage)'], note: '实例列表（+ POST /instances/{action}）' },

  // ── 插件（plugins.js）──
  { path: '/plugins/market',         methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '市场索引（TTL 缓存）' },
  { path: '/plugins/installed',      methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装第三方插件' },
  { path: '/plugins/check-updates',  methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage)'], note: '已装插件更新检测' },
  { path: '/plugins/install-status', methods: ['GET'], domain: 'plugins', category: 'public', consumers: ['UI(PluginsPage, job 轮询)'], note: '插件任务进度（A2 接线）' },

  // ── 智能路由（router.js）──
  { path: '/router/status',          methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '中转状态 + 用量' },
  { path: '/router/providers',       methods: ['GET'],  domain: 'router', category: 'public',   consumers: ['UI(RouterPage)'], note: '供应商 + 账号 + 实例视图' },
  { path: '/router/ports',           methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['p2p-api 契约测试（域分离验证）'], note: 'router 自治段端口视图（daemon 模式物理分离）' },
  { path: '/router/domain-summary',  methods: ['GET'],  domain: 'router', category: 'internal', consumers: ['守卫监督拍自消费（写目录 domainSummary）'], note: '域摘要只读缓存' },
  { path: '/router/providers/account/confirm', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '账号确认' },
  { path: '/router/providers/account/discard', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '账号丢弃' },
  { path: '/router/providers/activate',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '激活供应商' },
  { path: '/router/providers/add',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '新增供应商' },
  { path: '/router/providers/deactivate', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '停用供应商' },
  { path: '/router/providers/key/use',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '切换使用中的 Key' },
  { path: '/router/providers/keys/set',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '设置供应商 Key' },
  { path: '/router/providers/proxy/key',        methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 写入' },
  { path: '/router/providers/proxy/key/remove', methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代 Key 移除' },
  { path: '/router/providers/proxy/select',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '选择反代' },
  { path: '/router/providers/refresh',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '刷新供应商' },
  { path: '/router/providers/remove',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '删除供应商' },
  { path: '/router/proxy/login/start',    methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: 'Command Code 一键登录（发起）' },
  { path: '/router/proxy/login/wait',     methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '登录等待' },
  { path: '/router/proxy/update/apply',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代更新（job）' },
  { path: '/router/proxy/update/check',   methods: ['POST'], domain: 'router', category: 'public', consumers: ['UI(RouterPage)'], note: '反代版本检测' },
  { path: '/router/proxy/update/status',  methods: ['GET'],  domain: 'router', category: 'public', consumers: ['UI(RouterPage, job 轮询)'], note: '反代更新进度（A3 接线）' },

  // ── 镜像源（dist.js）──
  { path: '/dist/registry',         methods: ['GET'],  domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源状态' },
  { path: '/dist/registry/refresh', methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源测速刷新' },
  { path: '/dist/registry/set',     methods: ['POST'], domain: 'dist', category: 'public', consumers: ['UI(RegistryCard)'], note: '镜像源手动固定' },

  // ── 局域网/公网（relay.js）──
  { path: '/lan-access', methods: ['GET'], domain: 'relay', category: 'public', consumers: ['UI(LanPage)'], note: '远程代理列表' },
  { path: '/lan/frp',    methods: ['GET'], domain: 'relay', category: 'public', consumers: ['UI(LanPage)'], note: 'FRP 状态（+ POST /lan/frp/{action}）' },

  // ── 任务（tasks.js）──
  { path: '/tasks', methods: ['GET'], domain: 'tasks', category: 'public', consumers: ['UI(TasksPage)'], note: '统一任务列表（+ /tasks/{id}）' },

  // ── 桌面壳更新安全网（shell.js）──
  // 定位：内核**不是**壳的更新源（壳直连 npm CDN 自更新）；本域只做安全网：
  // 预取/备份/观察/有界回退/审计。壳不受监督（崩溃无人拉起），内核是唯一能救它的角色。
  { path: '/shell/status',         methods: ['GET'],  domain: 'shell', category: 'public',      consumers: ['UI(壳状态卡)', 'CLI'], note: '壳身份 + 更新账本 + 判定结论' },
  // ⚠ 2026-09-12（审计 P0）：以下两个端点的 `consumers` 曾声明为「壳」——**与事实不符**。
  //   实测壳仓（Tauri）**从不 POST 它们**（grep 零命中）；壳走本地命令 `shell_set_phase`
  //   + 独立账本 `update-guard.json`。声明成「壳在用」会让读者以为该安全网已闭环。
  //   现按真实情况标注为「无人消费（待接线）」，并保留端点（运维/未来接线可用）。
  { path: '/shell/health',         methods: ['POST'], domain: 'shell', category: 'operational', consumers: ['运维：排障时手工上报壳阶段（壳未接线；原声明为壳，实测零调用）'], note: '诊断用途：phase=ready 即更新确认信号，供排障手工驱动安全网；当前 evaluate() 因缺输入恒 idle' },
  { path: '/shell/update-pending', methods: ['POST'], domain: 'shell', category: 'operational', consumers: ['运维：排障时手工建立更新账本（壳未接线；原声明为壳，实测零调用）'], note: '诊断用途：建立更新账本（待重启确认），供排障手工驱动内核侧安全网' },
  { path: '/shell/check-update',   methods: ['POST'], domain: 'shell', category: 'public',      consumers: ['UI(关于卡)'], note: '壳版本检测（与内核自更新同源：npm registry + 镜像回退）' },
  { path: '/shell/restart',        methods: ['POST'], domain: 'shell', category: 'public',      consumers: ['UI(关于卡)'], note: '重启桌面壳以应用更新（壳门 0 在新进程内完成安装）' },
  { path: '/shell/rollback',       methods: ['POST'], domain: 'shell', category: 'operational', consumers: ['排障/运维'], note: '诊断/运维：手动回退，把待确认版本拉黑（拉黑后壳门 0 不再尝试）' },

];

/** 前缀路由（pathname.startsWith）。{prefix} 表示动态段。 */

const PREFIXES = [
  { prefix: '/dist/',        domain: 'dist',      category: 'public',      consumers: ['UI'], note: '/dist/registry/{refresh|set}' },
  { prefix: '/guard/',       domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/guard/version|changelog 等' },
  { prefix: '/instances/',   domain: 'instances', category: 'public',      consumers: ['UI'], note: '/instances/{add|remove|update|start|stop|check-update|open-web|upgrade}' },
  { prefix: '/lan/frp/',     domain: 'relay',     category: 'public',      consumers: ['UI'], note: '/lan/frp/{settings|install|toggle|expose}' },
  { prefix: '/lifecycle',    domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '/lifecycle/{id}[/{action}]（唯一启停入口）' },
  { prefix: '/lifecycle/',   domain: 'lifecycle', category: 'public',      consumers: ['UI', 'CLI'], note: '同上（显式前缀）' },
  { prefix: '/logs',         domain: 'lifecycle', category: 'operational', consumers: ['诊断/审计'], note: '/logs/{tail|export}（events-tail 已删除：与 /events 语义重复）' },
  { prefix: '/native/',      domain: 'native',    category: 'public',      consumers: ['UI', 'CLI'], note: '/native/{status|install|uninstall|upgrade|...}' },
  { prefix: '/plugins/',     domain: 'plugins',   category: 'public',      consumers: ['UI'], note: '/plugins/{install|enable|disable|uninstall|update}' },
  { prefix: '/router/',      domain: 'router',    category: 'public',      consumers: ['UI'], note: '/router/... （ports/domain-summary 为 internal，见 SURFACE）' },
  { prefix: '/shell/',       domain: 'shell',     category: 'public',      consumers: ['壳', 'UI'], note: '/shell/{status|health|update-pending|rollback}（壳更新安全网）' },
  { prefix: '/self-update/', domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/self-update/{status|apply|restart-guard}' },
  { prefix: '/settings/',    domain: 'guard',     category: 'public',      consumers: ['UI'], note: '/settings/{lan|access-key|close-action}' },
  { prefix: '/tasks/',       domain: 'tasks',     category: 'public',      consumers: ['UI'], note: '/tasks/{id}' },
];

/** 汇总统计（供审计/文档生成）。 */
function summary() {
  const byCat = {};
  for (const c of CATEGORIES) byCat[c] = 0;
  for (const e of SURFACE) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return { exact: SURFACE.length, prefixes: PREFIXES.length, byCategory: byCat };
}

module.exports = { SURFACE, PREFIXES, CATEGORIES, summary };
