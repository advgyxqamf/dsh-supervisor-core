# router 域 · 门面与持久化 功能设计

> **范围（本文负责）**：`src/domains/router/index.js`（read.totalLines = **763**）的全部六类职责——
> ①门面/组合 ②持久化 ③维护定时器 ④供应商 CRUD ⑤状态查询 ⑥HTTP 端点。
> 目标：**index.js 只留门面（DF-1 ≤150 行）**，其余五块全部切出为独立具名模块。
>
> **依据**：`DOMAIN-DESIGN-BRIEF.md` §1–§5、`DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）、
> **`design-notes/_RULING.md`（R1–R5，覆盖 BRIEF 相应表述）**；并与并行设计
> `router-daemon-and-depgraph.md`（记作 **D2**）、`router-switch-instance.md`（记作 **D5**）对齐。
>
> **取证纪律**：本文所有「文件:行号」均来自本轮实际 `read`/`grep`；行数取 `read.totalLines`
> （含末行；`wc -l` 因无尾换行少 1，例 index.js：totalLines 763 / wc 762）。
> require 边与 this 边均来自**去注释**源码（R1 取证陷阱：`daemon.js:184` 注释里的
> `require('.../router/daemon')` 不剥注释会伪造自环，本文已剥）。
>
> **只做设计，未改动任何 `src/` 代码，未 commit，未启动任何守卫进程，未触碰任何生产状态目录。**

---

## A. 现状审计

### A.1 文件清单与职责（逐文件）

> `wc -l` 全量实测（13 文件 / 4615 行）。**粗体 = 本文直接负责或主要波及**。

| 文件 | 行数 | 当前职责 | 问题 |
|---|---:|---|---|
| **index.js** | **763** | ①门面装配(`:22-62`) ②持久化(`:64-154`) ③维护定时器(`:156-429`) ④HTTP 端点(`:431-542`) ⑤状态查询(`:544-680`) ⑥供应商 CRUD(`:682-756`) ⑦mixin 注入(`:758-759`) | **六类职责挤一个文件**；DF-1 严重超标（763 → 目标 ≤150）；`:758-759` 是 R1 认定的 this 环成因 |
| forward-core.js | 548 | 转发主循环 + 透传 + 用量统计 IO + 网络守卫 | 纯函数与网络/文件 IO 混放；其 IO 部分与本文持久化重叠 |
| router-ops.js | 665 | OAuth 登录 + 反代更新 + 配额/价格同步 + 账号 Key 管理 | 4 类无关职责；对 index.js 有 **13 处 this 私调** |
| providers/proxy.js | 1110 | 反代 provider：spawn/探活/重启/回收/对账 | 全域最大文件 |
| providers/base.js | 776 | ProviderBase 基类 + 账号状态机 + 纯策略 + 预设表 | 纯函数与有状态类同文件 |
| providers/quota-strategies.js | 163 | 配额策略注册表 | 相对健康 |
| providers/direct.js | 47 | 直连 provider | 健康 |
| instances/proxy-instance.js | 102 | 实例对象 + 四态词表 | 健康（零 require） |
| switch.js | 117 | 选号 + 上游失败反应 | 健康；持久化已用 ctor 注入 |
| store.js | 53 | providers.json 原子写 + 损坏保护 | 健康，但**只覆盖 providers，不含用量** |
| proxy-apps.js | 49 | 反代应用注册表（纯数据） | 健康 |
| port-segments.js | 39 | 端口段/池申报 | 健康；靠 require 即申报 |
| daemon.js | 188 | 独立进程入口（**R5：文件名不得改**） | 含端口迁移业务 |

**index.js 六类职责的行区间（本设计要切的全部内容）**：

| # | 职责块 | 行区间 | 行数 | 块内成员 |
|---|---|---:|---:|---|
| ① | 门面/构造/导出 | `:22-62`、`:758-763` | ~50 | ctor、`Object.assign`、`presets`、`module.exports` |
| ② | 持久化 | `:64-154` | ~91 | `_load`(65)、`_deserializeProvider`(75)、`_save`(125)、`setPersistEnabled`(144)、`canPersist`(154) |
| ③ | 维护定时器 | `:156-429` | **274** | 生命周期(`159-208`) + 定时(`213-240`) + 监控/对账/探测(`244-429`) |
| ④ | HTTP 端点 | `:431-542` | ~112 | `handleForProvider`(433)、`_newServer`(443)、`activateProvider`(453)、`deactivateProvider`(480)、`_startProviderServer`(493)、`_stopProviderServer`(506)、`_startActivatedProviders`(515)、`log`(530)、`readBody`(535) |
| ⑤ | 状态查询 | `:544-680` | ~137 | `status`(545)、`domainSummary`(566)、`portsView`(594)、`listProviders`(601) |
| ⑥ | 供应商 CRUD | `:682-756` | ~75 | `addDirectProvider`(683)、`addProxyProvider`(701)、`removeProvider`(717)、`_releaseProviderPorts`(740)、`getProvider`(749) |

> ③ 与 ① 有交叠（`running` getter `:157`、`start`/`stop`/`stopAndWait`/`stopAllInstances` `:159-208`）——
> 服务生命周期（start/stop）功能上属**编排**，不属**定时**；本文把二者分开（见 B/C）。

### A.2 域内耦合图

#### (a) index.js 的 require 边（去注释，14 条；含 2 条 mixin）

| # | from | → to | 行 | 性质 |
|---:|---|---|---:|---|
| 1 | index.js | providers/direct.js | 12 | 组合（ctor 工厂） |
| 2 | index.js | providers/proxy.js | 13 | 组合 |
| 3 | index.js | switch.js | 14 | 组合 |
| 4 | index.js | store.js | 15 | 组合（持久化） |
| 5 | index.js | providers/base.js | 16 | 纯函数 `quotaOverallStatus` |
| 6 | index.js | proxy-apps.js | 17 | 纯数据 |
| 7 | index.js | shared/version.js | 18 | L0 纯函数（`semverCompare`） |
| 8 | index.js | port-segments.js | 19 | require 即申报（隐式副作用） |
| 9 | index.js | platform/service/ports | 20 | L0（`configureFile`/allocate/registerUser/list） |
| 10 | index.js | instances/proxy-instance.js | 82 | **方法体内延迟 require**（反序列化） |
| 11 | index.js | platform/util/probe.js | 595 | **方法体内延迟 require**（portsView） |
| 12 | index.js | providers/base.js | 684 | **方法体内延迟 require**（`PROVIDER_PRESETS`） |
| 13 | index.js | platform/service/ports | 742 | **方法体内延迟 require**（release ports） |
| 14 | index.js | **forward-core.js / router-ops.js** | **758 / 759** | **mixin 注入（R1/R4 病灶）** |

**入边**：`src/app/assembly/compose.js:20 → domains/router/index`（L2→L1，合法）、`src/domains/router/daemon.js:54 → ./index`（域内）、
6 个 test 直接 require（`router-test / p2p-router-test / core-test / router-e2e-test / ensure-instance-test` + 静态断言 `provider-gateway / round13-robustness / round13-router-relay-gaps / kernel-daemon-contract`）。

**实测结论（采纳 R1）**：**router 域 require 图 0 环**（13 节点 / 27 边，剥注释 + Tarjan）。
BRIEF §0 所称 `index.js ↔ forward-core.js` 循环 require **不成立**——forward-core.js 全文**零处** require `./index`。

#### (b) this 跨文件调用边（★ 真正的隐式耦合）

**调用进 index.js 定义的方法（in-edges）：**

| 被调方法 | 定义在 index.js | 调用方（文件:行） | 处数 |
|---|---|---:|---:|
| `_save()` | :125 | router-ops.js:393,457,509,582,607,618,646 | **7** |
| `getProvider(id)` | :749 | router-ops.js:448,517,595,633,651,659 | **6** |
| `log(line)` | :530 | forward-core.js:166,217,231,247,273,291,299,315,371 | **9** |
| `readBody(req)` | :535 | forward-core.js:168 | 1 |
| `canPersist()` | :154 | forward-core.js:508 | 1 |
| 字段 `providers` | :42 | router-ops.js:277,316,438,467,487 | 5 |
| 字段 `switcher` | :53 | forward-core.js:192,285 | 2 |

**index.js 调用出到别处定义的方法（out-edges）：**

| 调用 | 目标定义 | 调用点 | 处数 |
|---|---|---|---:|
| `this.proxyFor(prov,req,res)` | forward-core.js:159 | index.js:440 | 1 |
| `this.getUsage()` | forward-core.js:541 | index.js:558 | 1 |
| `this._loadTotals()` | forward-core.js:525 | index.js:546,603 | 2 |
| `this.refreshProxyUpdateInfo()` | router-ops.js:290 | index.js:215,223 | 2 |
| `this.refreshOfficialUsageAll()` | router-ops.js:437 | index.js:216 | 1 |
| `this.refreshOfficialPricingAll()` | router-ops.js:465 | index.js:217,233 | 2 |

**index.js 内部的 this 私调（切块后成为跨文件边，必须一并消解）：**

| 调用 | 目标 | 调用点 |
|---|---|---|
| `this._startMaintenance()` / `this._stopMaintenance()` | :213 / :236 | :164 / :175 |
| `this._startActivatedProviders()` | :515 | :165 |
| `this.stopAllInstances()` | :201 | :176 |
| `this._stopProviderServer(id)` | :506 | :177, :485, :721 |
| `this._ensureProviderInstances(p)` | :256 | :268, :471, :526 |
| `this._probeAccountStatesIfDue()` | :354 | :224, :231 |
| `this._probeAccountStates()` | :276 | :376 |
| `this._refreshReadyAccounts()` | :382 | :370 |
| `this._stopIdleProxyInstances()` | :342 | :378 |
| `this._hasImminentReset()` / `this._hasOverdueReset()` | :324 / :418 | :372 / :373 |
| `this._monitorProxyInstancesHealth()` | :244 | :229 |
| `this._load()` | :65 | :52（ctor） |
| `this._deserializeProvider(p)` | :75 | :67 |
| `this._startProviderServer(id)` | :493 | :472, :525 |
| `this.handleForProvider(id,req,res)` | :433 | :497 |
| `this._newServer(handler)` | :443 | :497 |
| `this._releaseProviderPorts(removed)` | :740 | :734 |
| `this._ensureProxyInstances()` | :264 | :220, :225 |

#### (c) this 调用图上的环（SCC，采纳 R1）

| 环 | 成员 | 载体 | 本文是否波及 |
|---|---|---|---|
| 环 1 | **{index.js, forward-core.js, router-ops.js}** | `index.js:758-759` 的 `Object.assign(RouterService.prototype, require(...).forwardMethods/.auxMethods)` | **是（本文拥有 758-759）** |
| 环 2 | {providers/base.js, providers/proxy.js} | `extends`（`base.js:307` 调只在 `proxy.js:412` 定义的 `this.stopInstance`） | 否（D2/D5） |

> ⇒ **DF-5 在本域的真实含义 = 禁止把两个文件的方法合并到同一 this**（R1）。本文对该环的处置：
> 删除 `758-759`，改为 **ctor 显式组装 + 薄委托**（见 C/E），使 ②–⑥ 成为**独立具名模块**，不再是 prototype 碎片。

#### (d) 跨域/跨层边（现状全部合法）

| 出边 | 条数 | 目标层 |
|---|---:|---|
| index.js → shared/version.js、platform/service/ports(×2)、platform/util/probe.js、port-segments.js(→platform) | 5 | L0 |
| index.js → proxy-apps.js / providers/* / switch.js / store.js / instances/* | 7 | 域内 |

**跨域 `domains→domains` = 0，非法越层边 = 0。** router 域无跨域问题需 E 节上报（**无需上层裁决**）。

### A.3 病症清单（对照 §0 四类，按 R1 更正）

| # | 病症 | 证据（文件:行号） |
|---|---|---|
| 1 | **巨型文件** | `index.js` 763（read.totalLines）——DF-2（≤400，R3）超标；且承载六类职责 |
| 2 | **this 隐式耦合** | 进 index.js：`_save` 7 处（router-ops.js:393,457,509,582,607,618,646）、`getProvider` 6 处（:448,517,595,633,651,659）、`log` 9 处（forward-core.js:166…371）、`readBody` 1、`canPersist` 1；出：`proxyFor`/getUsage/_loadTotals/refresh* 共 9 处（A.2(b)） |
| 3 | **「环」是 this 图而非 require 图** | 环 1 = `index.js:758-759` prototype 合并；require 图 0 环（R1） |
| 4 | **职责错位** | `index.js` 同时是门面(`:22-62`)+持久化(`:64-154`)+维护定时器(`:210-429`)+CRUD(`:682-756`)+状态查询(`:544-680`)+端点(`:431-542`) |
| 5 | **mixin 式 prototype 拼装** | `index.js:758-759` `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` / `require('./router-ops').auxMethods` —— **R4 认定 DS-G3 漏网**（现行门禁 `test/directory-structure-gate-test.js:122` 只匹配 `defineProperties`） |
| 6 | **持久化写权分叉** | 写权闸有**两处独立实现**：`index.js:144 setPersistEnabled/_persistEnabled`（服务级）与 `store.js:43 canPersist()/loadedOk`（文件级）；`index.js:133` 二者串联，但 `forward-core.js:508` 只查服务级。**三处各查一半**，正是 PG-7 反复复发的形态 |
| 7 | **持久化只覆盖一半** | providers.json 在 `store.js`（健康），而**用量文件**的读写散在 `forward-core.js:503-539`（`_writeTotals`/`_loadTotals`）——同一「域持久化」职责两个家，且后者用固定 `.tmp`（`forward-core.js:513`，与 `store.js:47` 的唯一 tmp 名不一致） |
| 8 | **装配期隐式副作用** | `index.js:19` `require('./port-segments')`（模块顶层 register）；`index.js:37` `ports.configureFile(opts.portsFile)` 在 **ctor 内改全局端口注册表**（测试靠它隔离，但也意味着「构造服务」不是纯装配） |
| 9 | **延迟 require 混在方法体** | `index.js:82`(proxy-instance)、`:595`(probe)、`:684`(presets)、`:742`(ports)——依赖方向合法但**时机隐式**，静态扫描难发现 |

---
## B. 功能切面（★ 设计核心）

> **先不看现有文件**，只回答：`index.js` 承载的这块（门面 + 持久化 + 生命周期 + 端点 + 视图 + CRUD），
> **功能上由哪几块组成**。结论：**13 个功能块**，每块给职责/输入/输出/副作用/是否纯。

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **Q1 组合根（Facade）** | 依 opts 组装全部协作者、暴露对外方法面 | `opts`{config,providerFile,usageTotalsFile,portsFile,logger,events,dist,tasks} | 一个具备完整方法面的服务对象 | 端口注册表 `configureFile`、触发一次加载 | ❌ |
| **Q2 域状态容器（State）** | 域内唯一可变状态的家（providers/running/stopped/ring/timers/caches/agents） | ctor 参数 | 状态对象句柄 | 无 | ✅ 纯（仅内存） |
| **Q3 域模型映射（Model）** | provider/账号/实例 JSON ↔ 对象 的双向映射（序列化形状 + 再水合） | 原始 JSON / provider 对象 + 注入的工厂 | provider 对象数组 / 快照对象 | 无 | ✅ 纯（工厂是入参） |
| **Q4 供应商快照持久化（Store）** | providers.json 原子写 + 损坏现场保护 | provider 快照 | 文件 | 文件 IO | ❌ |
| **Q5 用量持久化（Store）** | usage-totals.json 的原子读写 | totals 对象 | 文件 | 文件 IO | ❌ |
| **Q6 写权闸（Single-Writer Gate）** | 判定「本实例此刻是否允许落盘」（服务开关 ∪ 文件健康） | 服务写开关、文件 loadedOk | boolean | 无 | ✅ 纯 |
| **Q7 供应商注册表（Registry）** | 增/删/查供应商与账号，维持 id 唯一与端口登记一致 | CRUD 调用、preset/app 定义 | 结果对象 | 改内存 + 释放端口登记 | ❌ |
| **Q8 激活与端点启停（Activation）** | 分配/复用 providerApi 端口、按 `activated` 起停独立端点与实例 | provider、端口池 | 端点服务器 | 监听端口 + 起停进程 | ❌ |
| **Q9 请求分派与 HTTP 装配（Transport）** | 建 server（超时/keepalive/noDelay）、`/health` 短路、按 providerId 作用域转发、读 body | HTTP req/res | HTTP 响应 | 网络 IO | ❌ |
| **Q10 维护调度（Scheduler）** | 拥有全部周期/延时定时器，按「到期判据」触发维护任务 | 时钟 + 触发判据 | 对维护任务的调用 | **定时器** | ❌ |
| **Q11 账号探测执行（Probe）** | 对到期/在用账号执行一次官方检测并应用结果 | provider + 账号 + 时钟 | 状态变更 | 网络 IO + 临时起停实例 | ❌ |
| **Q12 服务生命周期（Lifecycle）** | 服务的 start/stop/优雅停/停全部实例，网关标志位 | 运行指令 | 结果对象 | 起停定时器/端点/进程 | ❌ |
| **Q13 状态投影（Projection）** | 把内部状态投影为只读对外视图（status/listProviders/domainSummary/portsView） | 状态 + 用量 + 端口 | 纯数据视图 | 端口 list（读） | 半纯 |

> **覆盖自检**：Q1–Q13 完整覆盖 A.1 表中 ①–⑥ 的全部 763 行，无遗漏、无「为切而切」的多余块。
> **Q13 独立于 Q7 的依据**（§2 第四刀「按角色切」）：CRUD 是**业务决策**（改状态），投影是**观测**（只读）；
> 且投影 137 行 + CRUD 75 行本就不该同文件。
> **Q10/Q12 拆分的依据**（§2 第三刀「按生命周期切」）：定时级（Q10）与请求级（Q9）与服务级（Q12）必须分开，
> 否则 `index.js:222-233` 那种「定时器直接调业务方法」的隐式耦合无法消除。

### B.1 依赖方向（由职责本身决定，不依赖现有文件）

```
Q1 组合根
  ├─→ Q2 状态容器 ──(被所有块持有)──
  ├─→ Q4/Q5/Q6 持久化与写权闸
  ├─→ Q7 注册表 ──→ Q8 激活 ──→ Q9 传输
  ├─→ Q12 生命周期 ──→ Q10 调度 ──→ Q11 探测 ──→ (provider 方法)
  └─→ Q13 投影
Q3 模型映射  ← 只被 Q1/Q4 使用（纯，叶子）
```

**三条从功能导出的硬规则**：
1. **Q13 与 Q9 只读状态，绝不改状态**（观测/传输是叶子方向）。
2. **Q10 只「触发」不「实现」**：定时器不得直接写 provider（现存 `index.js:222-233` 即反例，把
   `refreshProxyUpdateInfo/_probeAccountStatesIfDue/_ensureProxyInstances` 全塞进 tick 闭包）。
3. **Q6 是唯一写权判据**：Q4/Q5 都必须问它（现存 forward-core.js:508 绕过服务级开关，见 A.3-6）。

---

## C. 目标结构（★ 逐文件）

> **R2 采纳**：子目录白名单已放宽为 `providers instances policies model store handlers core jobs`，
> 但**优先扁平文件**。router 域这些块各自唯一（无同类多文件）→ **全部落扁平文件**，
> 保留既有 `providers/`（多实现）与 `instances/`（运行期对象），**不新增任何子目录**。
> **R3 采纳**：`index.js ≤150`、任何单文件 `≤400`（理想 ≤250）。

### C.1 目录树（目标；★ 仅含本文切出的部分）

```
src/domains/router/
├── index.js        门面：组合 + 薄委托（≤150 行，零业务逻辑）        ← 拆自 index.js:22-62 + 758-763
├── model.js        域状态容器 + 模型映射（纯，零 IO）               ← 拆自 index.js:41-51,64-123,530-533
├── store.js        持久化：providers.json + usage-totals.json + 写权闸（扩自现有 53 行）
│                                                                   ← 拆自 index.js:64-154 + forward-core.js:503-539
├── ops.js          供应商注册表 CRUD + 服务生命周期 + 端口释放        ← 拆自 index.js:156-208,682-756
├── endpoint.js     HTTP 端点装配与请求分派                          ← 拆自 index.js:431-450,493-511,515-528,535-542
├── views.js        只读状态投影                                     ← 拆自 index.js:544-680
├── scheduler.js    维护定时器 + 账号探测执行                        ← 拆自 index.js:210-429
├── forward.js      转发（D2 负责；本文只消费其接口）                 ← 拆自 forward-core.js
├── quotasync.js    配额/更新同步（D2 负责；本文只消费其接口）         ← 拆自 router-ops.js:271-512
├── oauth.js        浏览器登录（D2 负责；本文只消费其接口）            ← 拆自 router-ops.js:37-269
├── switch.js / proxy-apps.js / port-segments.js / providers/* / instances/*  （保留）
└── daemon.js       进程入口（R5：文件名不改）
```

### C.2 逐文件表（本文切出/改造的文件）

| 新文件 | 行数估计 | 职责（Q 块） | 从哪来（旧文件:行区间） | 纯? |
|---|---:|---|---|---|
| **index.js** | **≤150** | Q1 组合根 + 薄委托面 | index.js:9-20(require) + 22-62(ctor 骨架) + 756-763(导出) | ❌ |
| **model.js** | ≤180 | Q2 状态容器（含环形日志） + Q3 模型映射 | index.js:41-51(字段)、64-123(`_load`/`_deserializeProvider` 的**映射部分**)、530-533(`log`) | ✅ |
| **store.js**（扩） | ≤170 | Q4/Q5/Q6 持久化 + 写权闸 | store.js:7-51(现有 RouterStore) + index.js:65-66,125-141,144,154 + forward-core.js:503-539 | ❌ |
| **ops.js** | ≤260 | Q7 注册表 + Q12 生命周期 + Q13 端口释放 | index.js:156-208(`running`/`start`/`_stopAll`/`stop`/`stopAndWait`/`stopAllInstances`) + 682-756(CRUD/ports) | ❌ |
| **endpoint.js** | ≤140 | Q8 激活端点 + Q9 传输 | index.js:431-450 + 453-511 + 515-528 + 535-542 | ❌ |
| **views.js** | ≤200 | Q13 状态投影 | index.js:544-680（`status`/`domainSummary`/`portsView`/`listProviders`） | 半纯 |
| **scheduler.js** | ≤290 | Q10 调度 + Q11 探测 | index.js:210-429 | ❌ |

**行数可达性自检**：
- `scheduler.js` 含 274 行（`:156-429` 扣除生命周期 50 行 → 220 行业务 + 定时器管理）→ **≈250**，满足 ≤400。
  若实测 >250，把 Q11 探测（`:276-321` + `:382-415` ≈ 80 行）再拆 `probe.js`（R2 允许，但仅在超限时才建）。
- `ops.js` = CRUD 75 + 生命周期 50 + release 8 ≈ **140 行** → 宽裕。
- `views.js` = 137 行 + 依赖 ⇒ **≈150**，宽裕。
- `endpoint.js` = 110 行 → 宽裕。
- `index.js`：委托面 25 个外部方法 × 1 行 + 6 个字段 getter + ctor 组装 ≈ **110–130 行**（见 C.3 逐行预算）。
- ⚠ **命名取舍**：`views.js` 非 §4 规范名（§4 无 views）。
  备选：并入 `ops.js`（则 ops ≈ 290 行，仍满足 ≤400 但不满足理想 ≤250）。
  **本文取 `views.js`**，理由：§2 第四刀明确要求「业务决策 vs 观测」分开；且 DS-12 禁的是
  `*-view`/`*-mixin`/`*-part` 这类「从哪切出来」的名字，`views` 是**职责主体名**（视图集）。
  **若合并方坚持以 §4 全集为准，可无损并入 `ops.js`——本文标注为可裁决项（G.2-X1）。**

### C.3 index.js 逐行预算（证明 ≤150 可行）

| 段 | 内容 | 行数 |
|---|---|---:|
| require | node 模块 0（门面不应持有 http/fs/https/path）+ 协作者 8 条 | 8 |
| ctor | `constructor(opts)`：`ports.configureFile`（若 opts.portsFile）→ `new RouterState(opts)` → `createStore(...)` → `createForward({state, store, logger})` → `createOps({state, store, endpoint, ...})` → `createViews({state, store})` → `createScheduler({state, ops, store})` → 挂字段 | ~40 |
| 字段 accessor | `providers`(get/set)、`switcher`、`store`、`totals`、`_maintTimer`、`_pricingTimer`（测试与 forward 依赖） | 12 |
| 委托（契约面 25） | ctl 白名单 22 + facade 的 `start/stop` + runtime 的 `setPersistEnabled` | 25 |
| 委托（内部/测试面 10） | `getProvider/getUsage/recordUsage/_save/_ensureProxyInstances/_probeAccountStates/_stopIdleProxyInstances/_startMaintenance/canPersist/proxyFor` | 10 |
| 导出 | `RouterService.presets = ...`、`module.exports = { RouterService }` | 3 |
| **合计** | | **≈ 98–120** ✅ |

> 委托行形如：`status() { return this._views.status(); }`——**一行、纯转发、无业务**。
> 这是 DF-1 允许的「组合」，且**每行都是显式依赖**（`this._views` 由 ctor 装配，不靠 prototype 巧合）。

---

## D. 依赖图（★ 必须 DAG）

### D.1 目标图

```
                          ┌────────────────────────────┐
                          │ index.js  (Q1 门面/组合根)   │
                          └──┬───┬───┬───┬───┬───┬──────┘
              ┌──────────────┘   │   │   │   │   └────────────────┐
              │        ┌─────────┘   │   │   └─────────┐          │
        ┌─────▼─────┐ ┌▼─────────┐ ┌─▼────────┐ ┌──────▼────┐ ┌───▼──────┐
        │ model.js  │ │ store.js │ │ ops.js   │ │views.js   │ │scheduler │
        │ (Q2/Q3)   │ │ (Q4-6)   │ │(Q7/Q12)  │ │ (Q13)     │ │ (Q10/11) │
        └───────────┘ └────┬─────┘ └──┬───┬───┘ └────┬──────┘ └──┬────┬──┘
            ▲   ▲          │          │   │          │           │    │
            │   └──────────┼──────────┘   │          │           │    │
            │              │              │          │           │    │
        ┌───┴────┐    ┌────▼─────┐  ┌─────▼──────┐   │      ┌────▼──┐ │
        │ Q3 映射 │    │ forward.js│  │endpoint.js │◄──┘      │ ops.js│ │
        └────────┘    └───────────┘  └─────┬──────┘          └───────┘ │
                                           │ (转发)                     │
                                     ┌─────▼──────┐              (探测 provider 方法)
                                     │ providers/ │◄────────────────────┘
                                     │ switch.js  │
                                     └────────────┘
              （叶子：只向下 require model / platform / shared）
```

> 图注：`forward.js / quotasync.js / oauth.js` 属 **D2**，本文只声明**接口边**（消费方），不设计其内部。
> `scheduler.js` 对 provider 的探测**不是 require 边**——它经 `state.providers` 拿到对象句柄后调其方法，
> 这是「对运行期对象的方法调用」，不是模块依赖（因此不构成 require 环；见 D.3）。

### D.2 逐边清单与理由（本文新增/变更的边）

| from | → to | 理由 |
|---|---|---|
| index.js | model.js | 建状态容器（Q2） |
| index.js | store.js | 建持久化 + 写权闸（Q4/Q5/Q6） |
| index.js | ops.js | 建注册表/生命周期（Q7/Q12） |
| index.js | views.js | 建投影（Q13） |
| index.js | scheduler.js | 建调度器（Q10/Q11） |
| index.js | endpoint.js | 建端点（Q8/Q9） |
| index.js | forward.js / quotasync.js / oauth.js（D2 产出） | 组合既有能力（接口见 D.4） |
| index.js | providers/{direct,proxy}, switch.js, proxy-apps.js | ctor 工厂与数据（Q1 组合） |
| index.js | **（删除）forward-core.js / router-ops.js 的 `.forwardMethods/.auxMethods`** | **R1/R4/R6：删除 prototype mixin** |
| store.js | model.js（仅类型/形状约定，可无 require） | 快照形状来自 model |
| ops.js | store.js（**经 ctor 注入 `store`，不必 require**） | 手法 B：写盘走闸 |
| ops.js | **（删除）require ./providers/base 取 PRESETS** | 预设表随 Q7 一起迁到 ops 或经注入 |
| ops.js | platform/service/ports（release） | 端口登记释放（L0，合法） |
| views.js | shared/version.js | `semverCompare`（版本徽标，L0） |
| views.js | platform/service/ports（list） | 端口视图（L0） |
| endpoint.js | platform/service/ports（allocate） | 激活时分配 providerApi（L0） |
| endpoint.js | forward.js（**经 ctor 注入 `forward`**） | 转发；**不 require 实现**（手法 B） |
| scheduler.js | ops.js / quotasync.js 的刷新方法（**经 ctor 注入回调**） | Q10 只触发不实现 |
| scheduler.js | platform/util/probe（可选） | 若探测内联探活 |

**跨域边**：仅 `app/assembly/compose.js → domains/router/index.js`（现状既有，合法向下）。
本设计**不新增任何跨域边**；router 域出边全部指向 L0（shared/platform）。

### D.3 DAG 论证（必须无环）

1. **require 图**：全部新边同向 `index → {model,store,ops,views,scheduler,endpoint} → {platform,shared,providers,instances}`。
   `store/ops/views/scheduler/endpoint` 之间**零 require**（协作者经 ctor 注入）⇒ 零环。
2. **this 调用图**：目标形态中，各模块方法**不读 `this`**，而是闭包引用注入的 `deps`
   ⇒ 跨文件 `this.X()` 边**归零**（不再有环）。唯一保留的 `this` 是 `index.js` 门面自身的委托
   （`this._views.status()`），它是**单向、同文件、指向注入对象**，不成环。
3. **prototype 合并图**：`index.js:758-759` 删除 ⇒ **0**（门禁 RG-2 锁死）。

### D.4 与 D2/D5 的接口契约（合并必读）

| 契约 | 本文立场 | 归属 |
|---|---|---|
| `createForward({ state, store, switcher, logger, policies })` 返回 `{ proxyFor, writeThrough, recordUsage, recordError, getUsage }` | 本文**消费**；`_loadTotals/_writeTotals` 迁入 `store.js` | **D2** 设计 forward 内部 |
| `createQuotaSync({ state, store, dist, events })` 返回 `{ refreshProxyUpdateInfo, refreshOfficialUsageAll, refreshOfficialPricingAll, applyProxyUpdate, proxyUpdateStatus, proxyApps }` | 本文**消费**（scheduler 注入其刷新方法） | **D2** |
| `createOAuth({ state, ports, platform })` 返回 `{ commandcodeLoginStart, commandcodeLoginWait }` | 本文**消费**（门面委托） | **D2** |
| `forward-core.js / router-ops.js` 文件本身 | **本文只负责删除 `index.js:758-759` 的合并**；文件内部如何拆是 D2 的设计 | 交界 |
| `index.js:758-759` 的删除 | **本文拥有**（它在本文件内） | **D1（本文）** |
| endpoint 切片（D5 已声明「与 D1 重叠，只做切面不决定归属」） | **本文接管归属**：`endpoint.js` | **D1（本文）** |
| `switch.js / instances / proxy-apps / port-segments` | 本文不动（保留） | D5 |
| `daemon.js`（R5 不改名） | 本文不动 | D2 |

> ⚠ **合并冲突点（需裁决）**：D2 的 C.1 目录树里**没有** `views.js` 与 `endpoint.js`，
> 且把「状态视图 + 端点」并入了 `ops.js`。本文坚持拆出这两个文件（理由见 C.2 命名取舍）。
> 二者**不冲突于导出面**，只冲突于文件粒度；合并时二选一即可（见 G.2-X1）。

---

## E. `this` 隐式耦合消解表（★ 逐条）

> 手法：**A** = 具名导出 + 显式依赖；**B** = 构造注入；**C** = 参数显式化。

### E.1 持久化块（②）—— 消解 `_load/_save/_deserializeProvider/canPersist/setPersistEnabled`

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this._save()` ← router-ops.js | :393,457,509,582,607,618,646（7） | **B** | `ops.js`/`quotasync.js` ctor 收 `{ store }`；调用点改 `store.saveProviders(state.providers)`。**顺带修 A.3-6**：写盘一律过 `store.canPersist()`，不再各查一半 |
| `this.canPersist()` ← forward-core.js | :508 | **B** | `_writeTotals` 迁入 `store.js`，写前问 `store.canPersist()`（唯一闸） |
| `this._load()` ← ctor | :52 | **B/C** | `store.loadProviders()`（IO）→ `model.deserializeProviders(doc, deps)`（纯映射）；facade ctor 显式两步 |
| `this._deserializeProvider(p)` | :67（+定义 :75-123） | **C** | `model.deserializeProvider(p, { createDirect, createProxy, apps, logger, events, dist, onPersist, stateDir, ports })`——**依赖全入参**，纯函数可单测 |
| `this.setPersistEnabled(v)` ← app/daemons/runtime.js:190 | :144 | **B** | 门面薄委托 `store.setWritable(v)`；**写权状态归 store**（单闸） |
| `this._persistEnabled` 字段 | :39 | **B** | 删除；唯一事实源 = `store` 内部门状态 |
| `prov.serialize()`（provider 侧回调 `onPersist`） | index.js:77,694,707 注入 | **B** | `onPersist: () => store.saveProviders(state.providers)`（仍在 ctor 注入，形态不变） |

### E.2 维护定时器块（③）—— 消解 11 个 `_start/_stop/_probe/_refresh/_has/_ensure/_monitor`

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this._startMaintenance()` | 164 | **B** | 门面 `start()` → `scheduler.start({ refreshProxyUpdateInfo, refreshOfficialUsageAll, refreshOfficialPricingAll })`；**定时器回调经入参传入，不 require 实现** |
| `this._stopMaintenance()` | 175 | **B** | `scheduler.stop()` |
| `this._probeAccountStatesIfDue()` | 224,231 | **B** | `scheduler.probeIfDue()`（scheduler 内部方法，同文件） |
| `this._probeAccountStates()` | 376 | **A/B** | `scheduler.probeAccountStates(state.providers, { now })`；**入参显式化**（C）使状态机可测 |
| `this._refreshReadyAccounts()` | 370 | **A/B** | `scheduler.refreshReadyAccounts(state, opts)` |
| `this._hasImminentReset()` / `_hasOverdueReset()` | 372/373 | **C** | **提为纯函数并具名导出**：`hasImminentReset(providers, now)` / `hasOverdueReset(providers, now)`（**最易测**，BRIEF §3 首选手法） |
| `this._stopIdleProxyInstances()` | 378；测试 p2p:183 | **B** | `scheduler.reconcileInstances(state)`；门面保留同名薄委托（测试契约） |
| `this._ensureProxyInstances()` | 220,225；测试 ensure-instance:60,69 | **B** | `scheduler.ensureProxyInstances(state)`；门面保留薄委托 |
| `this._monitorProxyInstancesHealth()` | 229 | **B** | `scheduler.monitorInstanceHealth(state)` |
| `this._ensureProviderInstances(p)` | 268,471,526 | **C** | `scheduler.ensureProviderInstances(state, p)`（显式 provider 入参） |
| `this._maintTimer/_pricingTimer/_lifecycleTimer` 字段 | :48,49 | **B** | 定时器句柄写入 `state.maintTimer/...`；门面 getter 透出（测试 p2p:186,188 契约） |
| `this._probeRunning/_refreshRunning/_lastProbeAt/_lastRefreshAt` | :279,383,368 | **B** | 状态标志移入 `state`（或 scheduler 闭包），不外泄 |

### E.3 端点块（④）—— 消解 `_newServer/handleForProvider/_startProviderServer/_stopProviderServer/readBody/log`

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.proxyFor(prov,req,res)` | 440 | **B** | `endpoint.js` ctor 收 `{ forward }`；调用点 `forward.proxyFor(prov,req,res)`（**不再依赖 prototype 上恰好有**） |
| `this.log(line)` ← forward-core.js | 166…371（9） | **A/B** | `state.log(line)`（环形日志移入 model.js）；forward ctor 收 `{ log }` |
| `this.readBody(req)` | 168 定义、endpoint 使用 | **A** | 提为 `endpoint.js` 的**具名导出纯 IO 工具** `readBody(req, { maxBytes })`；同时被 forward 经注入复用（避免两份） |
| `this._newServer(handler)` | 443-450 → 497 | **A** | `endpoint.newServer(handler)`（同文件） |
| `this.handleForProvider(id,req,res)` | 433 → 497 | **B** | `endpoint.forProvider(id, req, res, { state, forward })` |
| `this._startProviderServer(id)` | 493 → 472,525 | **A** | `endpoint.startProviderServer(state, id)` |
| `this._stopProviderServer(id)` | 506 → 177,485,721 | **A** | `endpoint.stopProviderServer(state, id)` |
| `this._startActivatedProviders()` | 515 → 165 | **B** | `ops.startActivatedProviders(state, { ports, endpoint })`（激活是编排，绑端口是传输） |

### E.4 供应商 CRUD 块（⑥）—— 消解 5 个方法

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.addDirectProvider(opts)` | 683-699 | **B** | `ops.addDirectProvider(state, opts, { createProvider, store, presets })`；门面薄委托 |
| `this.addProxyProvider(opts)` | 701-715 | **B** | `ops.addProxyProvider(state, opts, { createProvider, apps, store })` |
| `this.removeProvider(id)` | 717-737 | **B** | `ops.removeProvider(state, id, { store, endpoint, ports })`（**保留 force 停实例语义**，见 H-RG-9） |
| `this._releaseProviderPorts(p)` | 740-747 | **A** | 就放 `ops.releaseProviderPorts(p, { ports })`（同文件私有），去重当前 `:742` 的**延迟 require** |
| `this.getProvider(id)` ← router-ops.js | :448,517,595,633,651,659（6） | **B** | 提为纯函数 `ops.findProvider(providers, id)`（**A/C**，最易测），或 ctor 注入 `{ findProvider }` |

### E.5 状态查询块（⑤）—— 消解 4 个方法

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.status()` | 545-560 | **C** | `views.status(state, { getUsage })`；`this.totals || (this.totals = this._loadTotals())` 改为 `store.getTotals()` |
| `this.domainSummary()` | 566-589 | **A** | `views.domainSummary(state, { ports })`——**已是纯聚合**，只需显式入参 |
| `this.portsView()` | 594-599 | **A/B** | `views.portsView(state, { ports, probe })`（去 `:595` 延迟 require） |
| `this.listProviders()` | 601-680 | **C** | `views.listProviders(state, { getTotals, proxyUpdateCache })`；`p.selectedKeyId()/usageOf()` 仍是**对 provider 对象的方法调用**（不是模块耦合，合法） |
| `this.modelPriceIndex/proxyUpdateCache` 字段 | 650 | **B** | 移入 `state`；视图经 `state` 读 |

### E.6 R7：facade 写动作与本域的关系（★ 跨层，标注需上层裁决）

> **R7** 裁决：`app/facade/*` 只允许**只读视图**；写动作下沉 `app/domain-actions/`。
> 实测现状：`src/app/facade/router.js:78 async setRouterRunning(on)` **是写动作**（经
> `src/api/domains/router.js:33,36` 的 `/router/{start|stop}` 与 `src/app/control/adapters.js:49,54` 消费），
> 经 `src/api/deps.js:81` 登记 —— 属 **facade→写状态**，R7 的整改对象。

| 项 | 事实 | 与本文关系 | 处置 |
|---|---|---|
| `app/facade/router.js:78 setRouterRunning` | 写动作混在门面（`:9-70` 是只读视图） | 它最终调到**本域**的 `router.start()/stop()`（`src/app/facade/router.js:95,109`） | **超本域范围**（`src/app/`）：标注「**需上层裁决**」，由 app 层设计统一改；本域只需保证 `start()/stop()` 的方法名与语义**不变**（导出面契约，见 G.1） |
| 本域 `ops.js` 的 `start/stop/addDirectProvider/...` | 域自己的 ops（写动作） | **R7 明文豁免**：「各域自己的 ops 不受此约束」 | **不受影响**，按 B/C 正常下沉 |
| `app/domain-actions/` 目录 | **实测不存在**（`ls src/app/` 无此目录） | 由 R7 新建，属 app 层 | **本文不创建、不设计**（BRIEF §6.6：跨层问题只标注，不擅自设计） |

### E.7 消解后的 DF-6 可测性验证

| 目标文件 | 只 require + 假依赖即可断言？ | 方式 |
|---|---|---|
| `model.js` | ✅ | 传入假 `createDirect/createProxy`，断言 JSON→对象的映射；`log()` 环形裁剪 |
| `store.js` | ✅ | **传临时文件路径**（绝不碰生产 `providers.json`/`ports-router.json`）；注入假 logger 断言损坏保护与写权闸 |
| `ops.js` | ✅ | 注入假 `store/endpoint/ports` + 假 provider 工厂，断言 CRUD 结果对象 |
| `views.js` | ✅ | 传入假 `state`（纯数据）+ 假 `ports`，断言视图形状 |
| `endpoint.js` | ✅ | 注入假 `forward`，用真实 http 但只听 `127.0.0.1:0`（临时端口）断言 `/health` 短路与 502 分支 |
| `scheduler.js` | ✅ | 注入假时钟/假回调，断言「到期判据」与调用次数（**不起真实定时器**） |
| **index.js** | ✅（**已实测**） | `require` 后除模块级 `port-segments` 申报外零副作用；可断言导出面快照（H-RG-8） |

---

## F. 迁移步骤（★ 可执行、可分批）

> 原则：**每步后既有测试与门禁仍绿、可独立提交、可回滚**。
> 顺序刻意从「低风险、低耦合」到「高风险」：先持久化与状态容器，后调度与视图，最后削门面。
> **前置**：步骤 5 依赖 D2 的 `forward.js/quotasync.js/oauth.js` 工厂落地（删除 `758-759` 后不能再靠 prototype）。

| 步 | 动作 | 影响文件 | 验证（全部离线，**不启动任何守卫**） |
|---:|---|---|---|
| **1** | 新建 `model.js`：移入状态字段(`:41-51`)、`log()`(`:530-533`)、`_deserializeProvider` 的**纯映射部分**(`:75-123`)；签名 `deserializeProvider(doc, deps)`；index.js 改薄委托 | `index.js`、`model.js` | `node -e "const m=require('./src/domains/router/model'); console.log(typeof m.deserializeProvider)"`；`node test/router-test.js`；`node test/kernel-daemon-contract-test.js`（见 G.1：需同步改 pin） |
| **2** | 新建/扩展 `store.js` 写权闸 + usage 侧：把 `index.js:125-141,144,154` 与 `forward-core.js:503-539` 的 IO 收进 `store.js`；服务级 `_persistEnabled` 与文件级 `loadedOk` 合并为**唯一闸** | `index.js`、`store.js`、`forward-core.js` | `node test/round13-robustness-batch-test.js`（**需同步改 `:152` 的 pin**，见 G.1）；`node test/provider-gateway-gate-test.js`（**需同步改 PG-7 定位**） |
| **3** | 新建 `scheduler.js`：移入 `:210-429`；`hasImminentReset/hasOverdueReset` 提为**具名纯函数导出**；定时器回调改为 ctor 注入 | `index.js`、`scheduler.js` | `node test/p2p-router-test.js`（D1 方法存在 / D2 定时器已挂 / D3 已清）；`node test/ensure-instance-test.js` |
| **4** | 新建 `views.js`：移入 `:544-680`（status/domainSummary/portsView/listProviders），入参显式化 | `index.js`、`views.js` | `node test/router-test.js`（listProviders 视图）；`node test/core-test.js`（status） |
| **5** | **删除 `index.js:758-759` 的 prototype 合并**；改为 ctor 显式组装 `this._forward/this._ops/...`；`forward-core.js/router-ops.js` 改工厂（**接口见 D.4，D2 并行**） | `index.js`、`forward-core.js`、`router-ops.js` | `node test/router-ctl-test.js`（假 target，锁 ctl 契约）；`node test/router-test.js`；`node test/directory-structure-gate-test.js`（RG-2/RG-6） |
| **6** | 新建 `endpoint.js`：移入 `:431-450,493-511,515-528,535-542`；`readBody` 具名导出；activate/deactivate(`:453-491`) 归 `ops.js` | `index.js`、`endpoint.js`、`ops.js` | `node test/core-test.js`（activateProvider + 独立端点 + `/health` 转发）；`node test/router-e2e-test.js` |
| **7** | 新建 `ops.js`：移入 `:156-208`（生命周期）+ `:682-756`（CRUD/release） | `index.js`、`ops.js` | `node test/router-test.js`；`node test/round13-router-relay-gaps-test.js`（**需同步改 `:119-127` 的 pin**，见 G.1） |
| **8** | `index.js` 收敛到 ≤150 行：只留 require/ctor 组装/字段 getter/薄委托/导出 | `index.js` | `wc -l`（read.totalLines ≤150）；`node test/layering-and-dependency-gate-test.js`；全套 H-RG-1..12 |

**每步必须跑的公共门禁**（否则白改）：
```
node test/directory-structure-gate-test.js
node test/layering-and-dependency-gate-test.js
node test/provider-gateway-gate-test.js
node test/router-test.js
node test/router-ctl-test.js
```

**⛔ 本文不做的验证**：不启动 `bin/dsh-supervisor daemon`、不 spawn 任何守卫/daemon 进程、不碰
`/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；不构造会 spawn 反代实例的服务
（`p2p-router-test`/`ensure-instance-test` 会起 mock 实例，**由主代理在受控环境决定是否运行**）。
步骤 1–4、7 的行为断言一律用**临时文件 + 纯函数/假依赖**完成。

**⛔ 步骤顺序的硬约束**：步骤 5（删除 mixin）**必须在步骤 1–4 之后**——若先删 mixin，
门面在 `forward.js` 工厂就绪前无法委托，会破坏 `handleForProvider → proxyFor`（`:440`）。

---

## G. 风险与取舍

### G.1 破坏性改动 → 点名消费方（★ 重点是**内容 pin 型门禁**）

> 与 D2 的「路径 pin」不同，本文发现 4 个门禁**把断言钉在了特定文件的源码内容上**——
> 一旦被断言的方法搬家，门禁**静默失效或误报 FAIL**。这是本轮**最高风险的静默失效面**。

| # | 被断言的内容 | 门禁（文件:行） | 本次改动如何打断 | 处置 |
|---:|---|---|---|---|
| 1 | `router/index.js` 去注释后含 `canPersist()` | `test/round13-robustness-batch-test.js:151-152` | `_save` 迁出 index.js → index.js 不再含该串 | **同步改**：改指向 `store.js` 的 `saveProviders`，**保留反向自检** |
| 2 | `_writeTotals() {...}` 在 **forward-core.js** 内含 `canPersist()` | `test/provider-gateway-gate-test.js:203-211` | usage IO 迁 `store.js` → 正则**定位不到** `_writeTotals`，报「未定位」FAIL | **同步改**：PG-7 断言改为「usage 落盘函数体含 `canPersist()`」并指向 `store.js`；反向样本保留 |
| 3 | `router/index.js` 含 `stateDir: this.config && this.config.stateFile` | `test/kernel-daemon-contract-test.js:78-79` | 反序列化迁 model.js → index.js 不再含 | **同步改**：pin 指向 `model.js`（D-7 的语义不变：注入 stateDir） |
| 4 | `router/index.js` 含 `removed.stopInstance(i, true)` | `test/round13-router-relay-gaps-test.js:119-127` | removeProvider 迁 ops.js → index.js 不再含 | **同步改**：pin 指向 `ops.js`；**force 语义必须逐字保留**（H-RG-9） |

**其余消费方（导出面保持，无需改）**：

| 消费方 | 用到的面 | 保持方式 |
|---|---|---|
| `src/app/assembly/compose.js:20,208` | `new RouterService({config,providerFile,usageTotalsFile,logger,events,dist,tasks})` | ctor 签名不变 |
| `src/domains/router/daemon.js:54,123-132` | 同上 + `portsFile` | ctor 保留 `opts.portsFile → ports.configureFile` |
| `src/domains/router/daemon.js:25-39`（ROUTER_CTL_METHODS） | 22 个公开方法 | 门面**逐个薄委托**，方法名不变 |
| `src/app/daemons/runtime.js:190` | `setPersistEnabled(false)` | 门面薄委托 → `store.setWritable` |
| `src/app/facade/router.js:38` | `this.router.constructor.presets()` | **必须保留 static `RouterService.presets`**（若 ctor 返回对象字面量会丢 `constructor`，故门面**继续用 class**） |
| `src/app/facade/router.js:40,43` | `listProviders()`、`proxyApps()` | 委托 |
| `src/app/facade/router.js:52,70,95,109` | `status()`、`domainSummary()`、`start()`、`stop()` | 委托（**R7**：`:95,109` 的写动作由 app 层整改，本域只保证方法名/语义不变） |
| `src/api/domains/router.js:19` | `routerApi().portsView()` | 委托 |
| `src/platform/ctl/server.js:110` | `target[method].apply(target, args)` | 委托方法**不得依赖 this 为模块**（本设计正是闭包引用 deps） |

**测试可见面（必须保持，否则 5 个测试直接红）**：

| 面 | 使用处 |
|---|---|
| `svc.providers`（**含 `.push()` 原地变更**） | p2p-router-test:80,175-177,193,207；ensure-instance-test:37,48,51；core-test |
| `svc.switcher.pickFor` | router-test:31；p2p-router-test:108,218,223 |
| `svc._save()` | router-test:28,60；ensure-instance-test:35,38 |
| `svc._ensureProxyInstances()` | ensure-instance-test:60,69 |
| `svc._maintTimer` / `svc._pricingTimer` | p2p-router-test:186,188 |
| `svc._startMaintenance` / `_stopIdleProxyInstances` / `_probeAccountStates` | p2p-router-test:183 |
| `svc.getUsage()` / `svc.recordUsage()` | core-test:231-233 |
| `svc.status()` / `svc.listProviders()` | core-test:217；router-test:54,67 |

> **设计约束（由此导出）**：门面 `providers` 必须是**会对同一数组对象生效的 getter**（`return this._state.providers`），
> 各模块必须**每次经 `state.providers` 读取**、不得缓存数组引用；定时器句柄必须写回 `state.maintTimer` 等。

### G.2 不做的部分与理由（不要为了设计而设计）

| # | 不做 | 理由 |
|---|---|---|
| **X1** | 不决定 `views.js`/`endpoint.js` 是否保留（vs 并入 `ops.js`） | 与 D2 的 C.1 目录树冲突，**需上层裁决**；两者导出面等价 |
| **X2** | 不改 `providers/*`、`switch.js`、`forward.js` 内部 | D2/D5 职责 |
| **X3** | 不改 `daemon.js` 的任何行为（R5 不改名） | R5 |
| **X4** | 不把 `port-segments.js` 的「require 即申报」改为显式 `register()` | 见 D2 的 X3：跨 `platform/service/ports` + 5 消费点，**超本域范围** |
| **X5** | 不动 `src/api/domains/router.js`（162 行）与 `api/deps.js` | 越层 SSOT 范畴（接口声明由 api 层负责） |
| **X6** | 不补 `README.md`（§4 ★ 必写） | 应由**合并后的**主设计统一写一份，避免 3 个并行设计各写一份 |
| **X7** | 不引入任何「按行数均分」的切法 | BRIEF §2 反例；本文每块都按**副作用/生命周期/角色**切 |
| **X8** | **不新建 `app/domain-actions/`，也不改 `app/facade/`**（R7） | **跨层**（`src/app/`）；BRIEF §6.6 要求只标注、不擅自设计跨域改动。详见 E.6 |

### G.3 遗留与需裁决

| # | 事项 | 状态 |
|---|---|---|
| **Y1** | `views.js`/`endpoint.js` 命名与粒度（vs D2 并入 ops.js） | 🔶 **需上层裁决**（G.2-X1） |
| **Y2** | 4 个「内容 pin」门禁的改法（G.1） | 🔶 本文给出改法；需与门禁负责人确认 |
| **Y3** | 写权闸合并后，`_persistEnabled` 字段名消失 | 🔶 无外部消费方读取该字段（仅 `setPersistEnabled` 方法被调），安全 |
| **Y4** | `index.js:37` `ports.configureFile(opts.portsFile)` 留在 ctor | 🔶 测试隔离依赖它；若移出会破坏 `ensure-instance-test:30-33` 的隔离前提，**建议保留在门面 ctor**（属装配，非业务） |
| **Y5** | **R7 的 facade 整改与本域的分界** | 🔶 **需上层裁决**（`app/facade/router.js:78` 写动作下沉 `app/domain-actions/`）：属 `src/app/` 层，本文只锁定本域 `start()/stop()` 导出面不变（E.6） |

---

## H. 门禁建议

> 供 `test/domain-structure-gate-test.js`（或并入 `directory-structure-gate-test.js`）。
> **每条都附反向自检**（R4/R6 要求），确保门禁非空转。
> **R6 特别说明**：RG-2 **必须先剥注释**，且**三条组合**——原 R4 正则要求右值是内联 `require`，
> 会漏掉 `Object.assign(X.prototype, mod.methods)`（右值是变量，实测存在于 `src/supervisor.js:160`），
> 同时会误命中 `src/supervisor.js:21` 的**注释**（说明文字）。

| 编号 | 断言 | 反向自检（判据必须能识别旧形态） |
|---|---|---|
| **RG-1** | `domains/router/index.js` ≤150 行（行终止符口径） | 用旧文件内容（762 行）跑判据 ⇒ 必须产出 FAIL |
| **RG-2 ★R6** | **全域（先剥注释）**三条组合：<br>① `MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties\|assign)\(\s*[\w$.]+\.prototype\s*[,)]/`<br>② `METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/`<br>③ ①在域内命中数为 0 且 ②为 0 | **必须**含样本 `Object.assign(X.prototype, mod.methods)`（**右值是变量**）⇒ 判据命中；<br>且用 `src/supervisor.js:160` 的真实原文 ⇒ **必须命中**（R4 原正则会漏）；<br>并用 `src/supervisor.js:21` 的注释原文 ⇒ 剥注释后**不得**命中（否则假阳性） |
| **RG-3** | `index.js` **不得**出现业务/IO 痕迹：`setInterval(`、`http.createServer`、`fs.writeFile`、`JSON.stringify`、`require('node:fs')`、`require('node:http')`、`findIndex` | 取旧 `index.js` 原文（含 `:222 setInterval`、`:444 http.createServer`、`:139 store.save`）⇒ 每条判据都命中 |
| **RG-4** | **DF-6**：`model/store/ops/views/endpoint/scheduler` 各自 `require` 后**不读文件、不监听端口、不起定时器**（子进程内 require 并断言活动句柄/监听器计数不变） | 构造样本 `module.exports = fs.readFileSync(...)` ⇒ 判据命中 |
| **RG-5** | 域内任何 `.js` ≤400 行（R3） | 以 `providers/proxy.js`（1110）/旧 `index.js`（763）为样本 ⇒ FAIL |
| **RG-6** | **DF-5**：域内 require 图**无环**（**先剥注释**，再 Tarjan / 文件粒度） | 构造样本 `a.js → b.js → a.js` ⇒ 判据报环；<br>并用 `daemon.js:184` 的注释 `require('.../router/daemon')` 验证**不会**伪造自环（R1 取证陷阱） |
| **RG-7** | **DF-7 单向依赖**：`index → {ops,views,endpoint,scheduler} → {store,model} → {providers,instances,platform,shared}`；反向边为 0 | 构造 `store.js → ops.js` 样本 ⇒ FAIL |
| **RG-8 ★契约冻结** | **导出面快照**：`module.exports = { RouterService }`；`RouterService.presets` 是 static 函数；实例上存在 `daemon.js:25-39 ROUTER_CTL_METHODS` 的**全部 22 个**公开方法 + `start/stop/stopAndWait/stopAllInstances/setPersistEnabled/getProvider/getUsage/recordUsage`；字段 `providers/switcher/store` 可读 | 用只导出空 class 的样本 ⇒ FAIL；并**反向**断言「删掉任一 ctl 白名单方法」也 FAIL（非空转） |
| **RG-9** | **删除路径 force 语义不回归**：`ops.js` 中 `removeProvider` 必须含 `stopInstance(i, true)`；**且**不得存在裸 `stopInstance(i)` 删除路径 | 沿用 `round13-router-relay-gaps-test.js:119-127` 判据，仅改**定位文件**为 `ops.js` |
| **RG-10** | `endpoint.js` 是域内**唯一** `require('node:http')` 或其 `createServer` 的地方（转发用 `http.request` 属 `forward.js`，可白名单） | 取旧 `index.js:9`（`require('node:http')`）与 `forward-core.js:454`（`http.request`）样本分别验证「命中/放行」 |
| **RG-11** | **写权单闸**：全域只有 `store.js` 定义 `canPersist`（或 `setWritable`）；`index.js`/`forward.js` **不得**再出现 `_persistEnabled` 字段 | 取旧 `index.js:39,154` 与 `forward-core.js:508`（只查服务级）样本 ⇒ 判据报「写权分叉」 |
| **RG-12** | **Q10 只触发不实现**：`scheduler.js` 中不得出现对 provider 的状态写入（不得 `p.accounts =`、`p.activated =`、`a.nextResetAt =`） | 取旧 `index.js:361-363`（`a.nextResetAt = nr.t` 在 tick 内写 provider）样本 ⇒ 命中 |
| **RG-13 ★R7** | `domains/router/**` **不得** require `app/facade/**`；且本域导出面**只暴露**「域自己的 ops 写动作」，不代 app 层做 facade 写动作 | 构造 `require('../../app/facade/router')` 样本 ⇒ 命中（越层）；<br>实测 `src/api/deps.js:81` 登记了 `setRouterRunning`（app 门面写动作）——**此判据用于防本域被卷入 R7 整改** |

**RG-2 的建议实现（可直接落盘）**：

```js
// 先剥注释（R6 强制）——否则 supervisor.js:21 的说明文字会假阳性
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;

const hits = files.filter((f) => MIXIN_INTO_PROTOTYPE.test(strip(read(f))) || METHODS_FRAGMENT.test(strip(read(f))));
check('RG-2 无 prototype 方法集合并（defineProperties/assign，右值不限）', hits.length === 0, hits.join(', '));

// ---- 反向自检（非空转 + 覆盖 R6 指出的假阴性）----
const OLD_INLINE = "Object.assign(RouterService.prototype, require('./forward-core').forwardMethods);";
const OLD_VAR    = 'Object.assign(Supervisor.prototype, mod.methods);';  // ← R4 原正则会漏
const COMMENT_ONLY = '// Object.assign(Supervisor.prototype, mod.methods) 说明文字';
check('RG-2 反向：内联 require 形态被识别', MIXIN_INTO_PROTOTYPE.test(strip(OLD_INLINE)), 'hit');
check('RG-2 反向：变量右值形态被识别（R6 修正）', MIXIN_INTO_PROTOTYPE.test(strip(OLD_VAR)), 'hit');
check('RG-2 反向：纯注释不误报（先剥注释）', !MIXIN_INTO_PROTOTYPE.test(strip(COMMENT_ONLY)), 'clean');
```

---

## 附：本文与 R1–R7 的对应

| 裁决 | 本文落实 |
|---|---|
| **R1** | A.2(a) 明写「require 图 0 环」；A.2(c) 把环定性为 this 图；DF-5 落为 RG-2/RG-6；RG-6 含剥注释的反向自检 |
| **R2** | C 节全扁平文件；**未新增任何子目录**（`views.js/endpoint.js` 是文件不是目录）；备选合并到 ops.js（G.2-X1） |
| **R3** | `index.js ≤150`（C.3 逐行预算证明 ≈98–120）、所有新文件 ≤400（C.2 逐文件估计） |
| **R4** | 由 **R6 取代**；RG-2 采用 R6 的三条组合 + 三个反向样本（内联 require / 变量右值 / 纯注释） |
| **R5** | 全程不改 `daemon.js` 文件名与入口守卫；G.2-X3 明写 |
| **R6** | RG-2 已替换为正则 `Object\.(defineProperties\|assign)\(\s*[\w$.]+\.prototype\s*[,)]` + `METHODS_FRAGMENT`，并**强制先剥注释**；反向自检含 `Object.assign(X.prototype, mod.methods)` |
| **R7** | **E.6** 新增专节：实测 `app/facade/router.js:78 setRouterRunning` 是写动作（消费方 `api/domains/router.js:33,36`、`control/adapters.js:49,54`、`api/deps.js:81`）；`app/domain-actions/` **实测不存在**。裁定：属 `src/app/` 跨层，**本文不改、只标注「需上层裁决」**（G.2-X8、G.3-Y5）；本域只锁定 `start()/stop()` 导出面不变；新增 **RG-13** 防本域被卷入；R7 明文豁免「各域自己的 ops」 |

> **⛔ 复核声明**：本文所有「文件:行号」均来自本轮 `read`/`grep`；未运行任何会 spawn 进程的测试；
> 未改动 `src/`；未 commit；未触碰 `design-notes/` 以外的产物。

