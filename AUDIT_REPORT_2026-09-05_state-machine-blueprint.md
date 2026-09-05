# 状态机修复蓝图：只收状态、不碰业务（2026-09-05 评审后定）

> 依据：TARGET-ARCHITECTURE.md §7（统一状态机 + 守护策略下发）、PHASE1-4 落地记录、
> 运行中 /lifecycle/status 实测（见「现状取证」）。
> 原则：每个资源把【对守卫可见的最小健康面】上报进统一状态机；守卫只读、只收，绝不读写资源内部业务。
> 业务零改动：router 账号/实例/配额、lan relay、实例 watchdog 的内部逻辑全部不动。

---

## 0. 现状取证（运行中 /lifecycle/status 实测 + 代码）

| 模块 | 注册? | healthy 被喂? | detail | 根因 |
|---|---|---|---|---|
| dsh | ✅ | ✅ mirror(5s tick) | ✅ statusSummary | 相对完整（正例） |
| router | ✅ | ✅ mirror(30s ctl) | ❌ **恒 null** | adapters:43 调 `router.routerStatus()`，RouterService 只有 `status()` → 恒走 null 分支 |
| lan | ❌ **未注册** | ❌ | ❌ | daemon 模式 `get lan()` 返回 null（supervisor:236）→ registerAll 收到 null → adapters `if(lan)` 跳过；守卫日志实证"已注册: router,instances,dsh,plugins"（无 lan） |
| instances | ✅ | ❌ **从不喂** | ❌ 恒 null | (a) 无 _mirrorHealth('instances') 调用；(b) adapters:77 调 `instances.summary()`，方法不存在 → null |
| plugins | ✅ | 合理不喂 | null | 设计如此（无守护） |

**你判断"状态机没做好"的精确含义**：5 个注册项里 1 个彻底丢失(lan)、2 个 detail 是死回调(router/instances)、1 个从不喂(instances) —— 收状态通道大面积断线。

---

## 1. 蓝图总则

- **不碰业务**：所有改动在「守卫观测/收口层 + adapters 适配层」，router/lan/instance 内部零改动。
- **只收状态**：状态机继续只存健康面（phase/desired/healthy/error/lastProbeAt/detail），detail 是「该资源对外的只读视图」，不是业务控制面。
- **每个资源一个薄适配**：adapters 的 status 回调指向真实存在的只读方法。

---

## 2. 修复项（按影响排序）

### FIX-1 lan 注册断线（最严重：整个模块丢失）
**问题**：supervisor.js:236 `get lan()` daemon 模式返回 null → registerAll 收不到。
**修法**（不动 lan-daemon / LanManager 业务）：
- supervisor 新增 `lanView()`（或 `lanState()`）：daemon 模式返回「lan-daemon 状态代理」——
  `{ status: () => null, start/stop: 幂等门面(经 _superviseLanDaemon/_ensureLanRuntime 语义, 同 router 的 setRouterRunning 模式) }`；
  非 daemon 模式返回 `this.lan`。
- registerAll 传入 `lan: this.lanState()`（恒非 null）→ adapters 注册 lan 项成立。
- lan 项健康喂入已存在（supervisor:800 `_mirrorHealth('lan', {ok: _lanDaemonActive()})`）——注册补上后即生效。
- **detail 接真实视图**：lan-daemon ctl(43108) 已暴露 list/frpStatus（通用 dispatcher）→ detail 经 `_lanCtlCall('list')` 异步取（守卫侧收状态，不建本地 relay）。

### FIX-2 router detail 死回调
**问题**：adapters:43 `router.routerStatus ? ... : null`——方法不存在恒 null。
**修法**：改 `status: () => router.status ? router.status() : null`（RouterService.status() 返回
running/activatedProviders/providers/keysTotal/usage，正是 router 对外只读视图）。
- **daemon 监督模式注意**：守卫内嵌 RouterService 的 status() 是本地副本（可能陈旧）——TARGET 定稿
  router 业务视图经 ctl 实时代理。故守卫侧 detail 在 daemon 激活时应取 `routerApi().status()`（ctl 转发），
  内嵌/降级才取本地 status()。适配层需感知 daemon 模式（经 supervisor 门面，不改 RouterService）。

### FIX-3 instances 聚合喂入 + detail
**问题**：实例状态从未进状态机（无 mirror、无 summary）。
**修法**：
- InstanceManager **新增只读 summary()**（纯聚合，不动实例业务）：
  `{ total, running, stopped, failed, installing, guarded }（按 list() 的 state.running/phase 汇总）`
  —— 或直接复用 list() 让守卫聚合。
- adapters:77 改 `status: () => instances.summary ? instances.summary() : null`。
- supervisor 增加周期 `_mirrorHealth('instances', {ok: 有守护目标均健康})`（喂入源 = 实例 watchdog 已判结果，只读 list()）。

### FIX-4 前端消费状态机（PHASE1 §4 / TARGET §8.3-3 欠账）
**问题**：前端只有 lifecycleStart/Stop（启停），无 lifecycleStatus；健康/状态展示各自直读（/ports、实例 state）。
**修法**（前端，零后端）：
- client.ts 加 `lifecycleStatus: () => get<LifecycleResponse>('/lifecycle/status')`（类型已有 LifecycleResponse）。
- polling.ts 快照增 `lifecycle: LifecycleResponse | null`（并入 2s syncAll）。
- OverviewPage 顶部状态卡 / 端口面板读 snap.lifecycle.modules（router/lan/dsh/instances 的 healthy/phase/error）。
- 原则：展示性健康字段从状态机取；**写操作仍走 /lifecycle/{id}/start|stop**（已接）。

### FIX-5 router 自治段端口展示（端口面板丢 4100x —— 与状态机无关的另一条欠账）
**定位**：TARGET §6.3 定稿 router 内部（proxyInstance 4100x）不进状态机，走 /router/ports ctl 自供。
**修法**（前端接线，后端已通）：
- client.ts 加 `routerPorts: () => get<PortsResponse>('/router/ports')`。
- polling.ts syncAll 加一路 routerPorts；PortPanel 合并 `snap.ports.records + snap.routerPorts.records`
  （守卫段 + router 段；resolveOwner 已支持 proxyInstance/providerApi 渲染）。

---

## 3. 明确不做（防过度）

- 不把 router 内部反代实例/账号注册进状态机（TARGET §6.3 黑盒边界，id 预留但注释明确不展开）。
- 不改任何资源业务逻辑（router 切换/回收/冻结、lan relay、实例 watchdog）。
- 不引入新框架/新状态字段（复用 phase/healthy/error/lastProbeAt/detail）。

---

## 4. 实施顺序与验证

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | FIX-1 lan 注册 + FIX-2 router detail + FIX-3 instances 喂入/detail（后端收口） | /lifecycle/status 含 lan；router/instances detail 非 null；全量 npm test |
| 2 | FIX-4 前端消费 /lifecycle（健康展示统一） | 面板状态卡来自 snapshot；typecheck/vitest/build |
| 3 | FIX-5 前端接 /router/ports（端口面板 router 段） | 端口管理显示 4100x/43011 + active |

每步独立可回滚（1 是守卫侧 + adapters；2/3 是前端，互不影响）。
