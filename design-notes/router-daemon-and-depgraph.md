# router 域 · 进程入口（daemon.js）+ 全域依赖图 功能设计

> 范围：`src/domains/router/daemon.js`（进程入口设计）+ router 域**全部 13 个文件**的 require 边汇总与 current-vs-target 对照图。
> 依据：`DOMAIN-DESIGN-BRIEF.md` §1–§5、`DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）、**`design-notes/_RULING.md`（R1–R5，已覆盖 BRIEF 相应表述）**。
> 本文所有「文件:行号」均来自本轮实际 `read`；所有 require 边由**剥注释源码**静态扫描 + Tarjan SCC 实算。
> **只做设计，未改动任何 `src/` 代码，未 commit。**

> **修订记录 v2（2026-09-17）**：按主代理裁决 R1–R5 补正。要点：
> - **R1** 采纳：require 图 0 环；病症是 this 图。**本文进一步把「18 方法/48 处」精算为按机制分类的 24 对/57 处，
>   其中 **DF-4 违规集（mixin）= 11 对 / 33 处**，另 16 处是 `extends` 的正常上溯、7 处是**已声明**的虚分派占位（见 A.2(b)、D.4 注）。
> - **R2** 采纳：子目录白名单放宽为 `providers instances policies model store handlers core jobs`；本文**仍以扁平文件为主**（本域无同类多文件）。
> - **R3** 采纳：`index.js ≤150`、单文件 `≤400`（已替换原 K3/K4 的"待裁决"表述）。
> - **R4** 采纳（**已被 R6 修正**）：原正则 `Object\.(defineProperties|assign)\(\s*\w+\.prototype\s*,\s*require\(` 存在**假阴性**——
>   它要求右值是内联 `require(...)`，漏掉 `supervisor.js:160` 的 `Object.assign(Supervisor.prototype, mod.methods)`（右值是**变量**）；
>   且 `supervisor.js` 内唯一被它命中的是 **`:21` 的注释**（假阳性）。**RG-8 已按 R6 换成三条组合判据**（见 H 节）。
> - **R5** 采纳：`daemon.js` 文件名不改。
> - **R6** 采纳：RG-8 = ① `MIXIN_INTO_PROTOTYPE`（右值不限）+ ② `METHODS_FRAGMENT` + ③ 反向自检**必须含"右值为变量"样本**；**必须先剥注释**。
> - **R7** 采纳：门面只允许只读视图，写动作下沉 `app/domain-actions/`。**router 域自身不产出 facade**（`app/facade/` 属编排层）；
>   但 `app/facade/router.js:78 setRouterRunning` 是**正在跨 router 域生命周期**的写动作，已在 G.2 新增 **X11** 登记归属。

---

## A. 现状审计

### A.1 文件清单与职责

| 文件 | 行数 | 当前职责 | 问题 |
|---|---:|---|---|
| `daemon.js` | 188 | 独立进程入口：配置加载 + 日志源自注册 + ctl 白名单 + 端口迁移重建 + 装配 + 启动 + 信号 | **混入业务逻辑**（端口迁移/重建 `:85-121`）；入口文件 188 行偏高 |
| `index.js` | 762 | 门面 + 持久化 + 维护定时器 + 供应商 CRUD + 状态查询 + 生命周期 + 实例/端点管理 | **五类职责挤一个文件**；DF-1 严重超标（762 → 目标 ≤150） |
| `forward-core.js` | 547 | 转发核心：代理循环 + 透传 + 用量统计 + 上游体读取 + 网络守卫 | 混杂纯函数（`extractUsage`/`estimateCost`/`joinUpstream`）与 IO/网络（`forwardOnce`/`writeThrough`） |
| `router-ops.js` | 664 | OAuth 一键登录 + 反代更新 + 配额/价格同步 + 账号/Key 管理 | 4 类无关职责同文件；含浏览器指纹与图形环境探测（平台知识） |
| `providers/proxy.js` | 1110 | 反代 provider：spawn/探活/重启/回收/对账/配额/状态机覆写 | **全域最大文件**；进程治理 + 账号状态 + 配额策略三层混叠 |
| `providers/base.js` | 776 | ProviderBase 基类 + 账号状态机 + 纯策略函数 + 预设表 + 词表 | 纯函数与有状态类同文件；776 行 |
| `providers/quota-strategies.js` | 163 | 配额策略注册表（window-usage / commandcode-billing） | 相对健康；依赖 base 仅为 `normalizeResetTs` |
| `providers/direct.js` | 47 | 直连 provider（key-pool） | 健康 |
| `instances/proxy-instance.js` | 102 | 实例生命周期对象 + 四态词表 | 健康（零 require） |
| `switch.js` | 117 | 选号 + 上游失败反应（SwitchEngine） | 健康；仅 require base 取两个纯函数；持久化已用 **ctor 注入**（`index.js:60`） |
| `store.js` | 53 | providers.json 持久化（原子写 + 损坏保护） | 健康 |
| `proxy-apps.js` | 49 | 反代应用注册表（纯数据） | 健康（零 require） |
| `port-segments.js` | 39 | 端口段/池申报（域知识反转法）+ OWNER_PREFIXES | 健康；但被 5 处 require，是隐式装配依赖 |
| **合计** | **4615** | | |

### A.2 域内耦合图

#### (a) require 边（**剥注释**扫描，共 27 条域内边）

| # | from | → to | 行号(首次) | 性质 |
|---:|---|---|---|---|
| 1 | daemon.js | index.js | 54 | 入口装配 |
| 2 | daemon.js | port-segments.js | 91 | 装配期申报 |
| 3 | forward-core.js | providers/base.js | 10 | 纯函数复用（keyFingerprint/maskKey） |
| 4 | index.js | providers/direct.js | 12 | 组合 |
| 5 | index.js | providers/proxy.js | 13 | 组合 |
| 6 | index.js | switch.js | 14 | 组合 |
| 7 | index.js | store.js | 15 | 组合 |
| 8 | index.js | providers/base.js | 16 | 纯函数 quotaOverallStatus |
| 9 | index.js | proxy-apps.js | 17 | 数据 |
| 10 | index.js | port-segments.js | 19 | 装配期申报 |
| 11 | index.js | instances/proxy-instance.js | 82 | 反序列化 |
| 12 | index.js | providers/base.js | 684 | PROVIDER_PRESETS |
| 13 | index.js | forward-core.js | 758 | **mixin 注入（R1/R4 病灶）** |
| 14 | index.js | router-ops.js | 759 | **mixin 注入（R1/R4 病灶）** |
| 15 | index.js | providers/base.js | 761 | PROVIDER_PRESETS（延迟） |
| 16 | providers/base.js | port-segments.js | 9 | 装配期申报 |
| 17 | providers/direct.js | providers/base.js | 8 | 继承 |
| 18 | providers/direct.js | providers/quota-strategies.js | 9 | 策略 |
| 19 | providers/proxy.js | providers/base.js | 13 | 继承 |
| 20 | providers/proxy.js | providers/quota-strategies.js | 14 | 策略 |
| 21 | providers/proxy.js | instances/proxy-instance.js | 15 | 模型 |
| 22 | providers/proxy.js | port-segments.js | 16 | 装配期申报 |
| 23 | providers/quota-strategies.js | providers/base.js | 27 | 纯函数 normalizeResetTs |
| 24 | router-ops.js | port-segments.js | 6 | 装配期申报 |
| 25 | router-ops.js | proxy-apps.js | 8 | 数据 |
| 26 | router-ops.js | providers/base.js | 11 | 纯函数 maskKey |
| 27 | switch.js | providers/base.js | 10 | 纯函数 headerRetryMs/bodyResetMs |

**实测结论（采纳 R1）**：
> 按**剥注释源码**、**文件粒度**、Tarjan SCC 实算：router 域内 **27 条 require 边、0 个环**（13 个节点全覆盖）。
> 全域五域（router/relay/instance/plugin/shell）**实测均 0 环**。
> BRIEF §0 所称 `index.js ↔ forward-core.js` **不成立**——`forward-core.js` 全文**零处** require `./index`
> （其全部 require 为：`node:crypto/fs/path` + `./providers/base` + 动态 `node:https/http`）。

⚠ **取证陷阱（R1 明列）**：`daemon.js:184` 注释 *"此前是 `main()` 直调，导致 `require('.../router/daemon')` …"* 是**说明文字**。
不剥注释的朴素扫描会把它当成真 require 边，伪造出 `daemon.js → daemon.js` 自环。**本设计全部扫描均先剥注释。**

#### (b) `this.X()` 跨文件调用边（★ 真正的隐式耦合；按机制分类）

> 统计口径（可复现）：对 9 个含方法的文件，抽「方法定义表」（类体 / 对象字面量简写方法）与「`this.<name>(` 调用表」，
> 取「定义在 A 文件、却在 B 文件被调用」的对。**按边的成因机制分四类**，因为只有第一类构成 DF-4 违规。

| 机制 | 对 | 处 | 是否 DF-4 违规 | 依据 |
|---|---:|---:|---|---|
| **① mixin 合并同类 this** | **11** | **33** | ✅ **违规** | `index.js:758-759` `Object.assign(RouterService.prototype, require(...).forwardMethods/.auxMethods)` |
| ② `extends` 上溯调用 | 5 | 16 | ❌ 正常 OOP | `providers/proxy.js:51` `class ProxyProvider extends ProviderBase` |
| ③ **已声明**虚分派（子类覆写） | 7 | 7 | ❌ 已声明契约 | 占位声明在 `providers/base.js:240-253`（`supports`/`startInstance`/`stopInstance`/`instanceOf`/… 显式抛"能力不支持"） |
| ④ ctor 注入回调 | 1 | 1 | ❌ 已是手法 B | `switch.js:42` `this.onPersist()` ← `index.js:60` 注入 |
| **合计** | **24** | **57** | **违规集 = ①（11 对 / 33 处）** | |

**① mixin 违规集（逐条，含行号）**：

| from 文件 | 被调方法 | 定义在 | 调用点行号 | 处数 |
|---|---|---|---|---:|
| forward-core.js | `log()` | index.js:530 | 166,217,231,247,273,291,299,315,371 | 9 |
| forward-core.js | `readBody()` | index.js:535 | 168 | 1 |
| forward-core.js | `canPersist()` | index.js:154 | 508 | 1 |
| index.js | `proxyFor()` | forward-core.js:159 | 440 | 1 |
| index.js | `_loadTotals()` | forward-core.js:525 | 546,603 | 2 |
| index.js | `getUsage()` | forward-core.js:541 | 558 | 1 |
| index.js | `refreshProxyUpdateInfo()` | router-ops.js:290 | 215,223 | 2 |
| index.js | `refreshOfficialUsageAll()` | router-ops.js:437 | 216 | 1 |
| index.js | `refreshOfficialPricingAll()` | router-ops.js:465 | 217,233 | 2 |
| router-ops.js | `_save()` | index.js:125 | 393,457,509,582,607,618,646 | 7 |
| router-ops.js | `getProvider()` | index.js:749 | 448,517,595,633,651,659 | 6 |

**② `extends` 上溯（16 处，正常 OOP，不属违规）**：
`providers/proxy.js` → `providers/base.js`：`_persist()`(base.js:684) ×10 @247,261,277,351,424,451,765,772,779,786；
`isAccountUsable()`(base.js:373) ×3 @397,916,1003；`accountQuotaSummary()`(base.js:255) @791；
`applyDetection()`(base.js:588) @795；`_windowExhausted()`(base.js:340) @823。

**③ 已声明虚分派（7 处，不属违规但**可被静态校验**）**：
`providers/base.js` → 子类覆写：`stopInstance()` @307（proxy.js:412）、`supports()` @580（proxy.js:69）、
`instanceOf()` @581（proxy.js:76）、`markCreditsExhausted()` @333（proxy.js:847）、`markQuotaExhausted()` @334（proxy.js:838）、
`markBanned()` @335（proxy.js:1105）、`detectAccount()` @275（direct.js:27）。
> ⚠ 实现细节：proxy 的子类覆写**都先做副作用再 `super.xxx()`**（proxy.js:840/849/1107），
> 故 base 内调 `this.markXxx()` 会**先经子类副作用**——这是**当前有意的行为**，重构时不得悄悄改成直调基类。

**④ ctor 注入（1 处，已是手法 B，作为正例）**：`switch.js:16` `this.onPersist = opts.onPersist || null`，
调用点 `switch.js:42`，注入源 `index.js:60` `onPersist: () => this._save()`。
> 这正说明 §3 手法 B 在本域**已有成功先例**——重构方向是把这个模式推广到 ① 的 11 对。

#### (c) `this` 调用图上的**环**（SCC 实算）

按**全部** 23 条「跨文件 this 边」（①+②+③，④ 为注入不算边）做 SCC：

```
SCC-A（DF-4 违规环）： { index.js, forward-core.js, router-ops.js }
SCC-B（已声明多态环）： { providers/base.js, providers/proxy.js }
```

- **SCC-A 的证据**：
  `forward-core.js:166` 调 `this.log()`（定义 `index.js:530`）、`forward-core.js:508` 调 `this.canPersist()`（定义 `index.js:154`）→ forward-core → index；
  `index.js:440` 调 `this.proxyFor()`（定义 `forward-core.js:159`）、`index.js:546` 调 `this._loadTotals()`（定义 `forward-core.js:525`）→ index → forward-core；
  `router-ops.js:393` 调 `this._save()`（定义 `index.js:125`）→ router-ops → index；
  `index.js:215` 调 `this.refreshProxyUpdateInfo()`（定义 `router-ops.js:290`）→ index → router-ops。
  **成因**：`index.js:758-759` 的 `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` /
  `Object.assign(RouterService.prototype, require('./router-ops').auxMethods)` 把三文件方法集**合并到同一个 this**。
- **SCC-B 的证据与定性**：`providers/base.js:307` 调 `this.stopInstance()`（只在 `proxy.js:412` 定义）→ base → proxy；
  `providers/proxy.js:791` 调 `this.accountQuotaSummary()`（定义 `base.js:255`）→ proxy → base。
  **定性（本文对 R1 的补充）**：SCC-B 的 base→proxy 方向**不是隐式耦合**——占位已在 `base.js:240-253` **显式声明**
  （`stopInstance` 在 `base.js:244` 抛 "must be implemented by process-pool provider"）。
  它是「显式声明的多态」，与 ① 的「靠 prototype 巧合」有本质区别：
  **① 无法被静态校验；③ 已声明、可被单测断言**。
  重构只需把 `base.js:307` 这一处改为**显式钩子**（见 E.2），SCC-B 即降为单向 `extends` 依赖。

> **结论（与 R1 一致，并细化）**：DF-5 对 router 域的真实含义 = **禁止把两个文件的方法合并到同一个 this**
> （`Object.assign(X.prototype, require(...))`）。否则改名后 require 图仍是 DAG，而 DF-4/DF-6 依旧被违反——
> 正是 BRIEF §2 所斥的「文件搬家」。

#### (d) 跨域/跨层边（现状全部合法）

| 入边（外部 → router） | 性质 |
|---|---|
| `src/app/assembly/compose.js:20 → ../../domains/router/index` | 合法向下（app L2 → domains L1） |
| `src/api/domains/router.js`（经注入 facade，零 require domains） | 合法 |

| 出边（router → 外部） | 条数 | 目标层 |
|---|---:|---|
| `daemon.js` → platform/service/{state-root,config,tasks,log/hub,log/logcore,ports}、platform/distribution、platform/ctl/server | 9 | L0 |
| `index.js` → shared/version, platform/service/ports(×2), platform/util/probe | 4 | L0 |
| `router-ops.js` → platform/service/ports, shared/version, platform/os/index | 3 | L0 |
| `providers/proxy.js` → platform/os/{spawn,pidlookup,exec-path}, platform/service/ports, platform/service/state-root | 5 | L0 |
| `providers/base.js`、`port-segments.js` → platform/service/ports | 2 | L0 |

**跨域边 `domains→domains` = 0，非法层边 = 0**（本轮全仓扫描实测）。router 域**没有**跨域/越层问题需 E 节上报。

### A.3 病症清单（对照 §0 四类，按 R1 更正）

| # | 病症 | 证据（文件:行号） |
|---|---|---|
| 1 | **巨型文件** | `providers/proxy.js` 1110；`providers/base.js` 776；`index.js` 762；`router-ops.js` 664；`forward-core.js` 547 —— DF-2（**≤400，R3**）全部超标 |
| 2 | **`this` 隐式耦合** | ① mixin 违规集 **11 对 / 33 处**（A.2(b) 表）；正例：④ ctor 注入 1 处（`switch.js:42`） |
| 3 | **"环"（this 图，非 require 图）** | 2 个 SCC（A.2(c)）：SCC-A {index, forward-core, router-ops}（**违规**）、SCC-B {base, proxy}（已声明多态）。**require 图 0 环（R1）** |
| 4 | **职责错位** | `index.js` 同时是门面+持久化(`_save` 125)+维护定时器(`_startMaintenance` 213)+供应商 CRUD(683-737)+状态视图(545-680)+生命周期(159-208)；`daemon.js` 含端口迁移业务(85-121) |
| 5 | **mixin 式 prototype 拼装** | `index.js:758-759` `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` / `require('./router-ops').auxMethods` —— **R4/R6 认定的 DS-G3 漏网**（现行门禁 `test/directory-structure-gate-test.js:122` 只匹配 `defineProperties`）。<br>**R6 全域实测同族共 5 处**（剥注释后）：`domains/router/index.js:758,759`、`domains/instance/index.js:31`、`domains/plugin/index.js:33`、`supervisor.js:160`（右值**变量** `mod.methods`）、`supervisor.js:161`（`defineProperties`，右值 `mod.accessors`） |
| 6 | **装配置疑（隐式副作用）** | `port-segments.js` 被 5 处 require（`index.js:19`、`base.js:9`、`proxy.js:16`、`router-ops.js:6`、`daemon.js:91`），靠"require 即申报"的模块顶层副作用生效 —— 与 daemon 入口守卫的初衷（require 应纯）方向相反 |
| 7 | **平台知识倒挂** | `daemon.js:41` 顶层就 `require('../../platform/service/state-root')` 只为算 `CONFIG_PATH`；`index.js:37/742`、`proxy.js:317` 在方法体内延迟 require platform —— 依赖方向合法但**时机隐式** |

---

## B. 功能切面（★ 设计核心）

> 先不看现有文件，只回答：**router 域在功能上由哪几块组成。**

Router 域的本质：**为每个"供应商"提供一条独立的、账号池隔离的、可自动换号的 OpenAI 兼容入口**，
并管理这些账号/实例的完整生命周期。据此，功能上由 **10 块**组成：

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **F1 领域模型** | 定义"供应商/账号/实例/额度/受限"的数据形状与状态迁移规则 | 原始 JSON、检测结果 | 规范化对象、状态变更 | 无 | ✅ 纯 |
| **F2 存量持久化** | providers.json / usage-totals.json 的原子读写与损坏保护 | 内存态 | 文件 | 文件 IO | ❌ |
| **F3 配置与路径** | 域级配置派生（stateFile→stateDir、日志/事件/端口文件路径、ctl 白名单） | config 对象、环境变量 | 路径集合、常量 | 读环境 | 半纯 |
| **F4 账号状态机** | 判定"账号是否可用/受限/封禁"，并按恢复证据自动解冻 | 账号 + 探测结果 + 时间 | 新状态 + `limit` + `nextResetAt` | 无（纯决策） | ✅ 纯 |
| **F5 配额策略** | "上游配额面 → 统一 quota 结构"的取数与解析（每策略一个实现） | URL/key/官方响应 | `{ok, quota}` | 网络 IO | ❌ |
| **F6 选号与失败反应** | 在**单个**供应商的池内选号；把上游失败分类为处置动作 | provider + 上游响应 | 账号 / `{action}` | 事件、回调持久化 | 半纯 |
| **F7 转发与计费** | 把请求转到目标端点、透传响应流、统计用量与费用 | HTTP req/res + 账号 | HTTP 响应 + 用量条目 | 网络 + 文件 IO | ❌ |
| **F8 实例进程治理** | 反代实例的 spawn/探活/重启/回收/对账（期望集收敛） | app 定义 + 账号集 | 进程 + 实例态 | 进程/端口/文件 IO | ❌ |
| **F9 域编排面** | 供应商 CRUD、端点启停、ctl 响应、OAuth 登录 —— **对外可操作的一切** | ctl/API 调用 | 统一结果对象 | 贯穿上述 | ❌ |
| **F10 维护调度** | 周期性触发的维护（版本检查/配额探测/实例对账/健康监控） | 时钟 + 触发条件 | 对 F9 的调用 | 定时器 | ❌ |
| **F0 进程入口** | 装配上述所有块 + 启动 + 信号接线，**零业务判断** | 命令行/环境 | 运行中的进程 | 进程级 | ❌ |

覆盖自检：F0–F10 完整覆盖 A.1 全部 4615 行的职责，无遗漏、无"为切而切"的多余块。
（F10 从 F9 独立出来，依据 §2 第三刀「按生命周期切」：定时级与请求级**必须**分开，
否则 `index.js:213-233` 那种"定时器直接调业务方法"的隐式耦合无法消除。）

### B.1 依赖方向（由职责本身决定，不依赖现有文件）

```
F0 进程入口
  └─→ F3 配置与路径
  └─→ F9 域编排面
         ├─→ F6 选号与失败反应
         ├─→ F7 转发与计费
         ├─→ F8 实例进程治理
         └─→ F2 存量持久化
                └─→ F1 领域模型
F10 维护调度 ──→ F9（只"触发"，不"实现"）
F4 账号状态机 ──→ F1 领域模型          （纯，被 F5/F6/F8/F9 复用）
F5 配额策略   ──→ F1 领域模型          （策略实现向下，被 F8/F9 调用）
F6 / F7 / F8 / F9  ──→ F4             （都只"问"状态机，不反向）
```

**三条从功能导出的硬规则**：
1. **F4/F5 是叶子，绝不可回调 F8/F9**。→ 这正对应 A.2(b) ③：`base.js:307` 让状态机调了进程治理
   （虽已声明，但**方向仍是"叶子依赖上层"**，重构必须打断）。
2. **F7 只做运输，不持有供应商语义**。→ `forward-core.js` 里凡 `classifyResponse`/`effect` 分支都应经 F6 转发（M1/M3 已达成的部分保持）。
3. **F0 不得含任何 F1–F10 的判断**。→ `daemon.js:88-118` 的"按 provider 重建端口绑定"是 F8/F9 业务判断，必须移出。

---

## C. 目标结构（逐文件）

> **R2 采纳**：DS-G6 子目录白名单已放宽为 `providers instances policies model store handlers core jobs`。
> **R2 同时要求优先用扁平文件**。router 域经评估：需拆出的块**各自唯一**（无多个同类文件），
> 故**全部落扁平文件**，不新增子目录 —— 保留既有的 `providers/`（多实现）与 `instances/`（运行期对象）。
> **R3 采纳**：`index.js ≤150`、任何单文件 `≤400`（下表所有估计已按严值收敛）。

### C.1 目录树（目标）

```
src/domains/router/
├── index.js              门面：组合 + 委托（≤150 行，零业务逻辑）      ← 拆自 index.js
├── daemon.js             进程入口：仅装配 + 启动（≤120 行；文件名不改/R5）← 收敛自 daemon.js
├── config.js             域配置/路径/ctl 白名单（纯派生 + 常量）        ← 新增，拆自 daemon.js:24-51
├── ports-bootstrap.js    端口迁移与按 providers 重建（幂等，IO）        ← 新增，拆自 daemon.js:85-121
├── port-segments.js      端口段/池申报（域知识，显式导出 OWNER_PREFIXES）← 保留
├── model.js              领域模型（实例四态 / 账号派生 / 序列化形状）    ← 拆自 providers/base.js + instances/proxy-instance.js
├── policies.js           纯策略（状态机判定 / 额度归一 / 恢复证据 / 词表）← 拆自 providers/base.js
├── store.js              持久化（providers.json + usage-totals.json）    ← 扩自 store.js + forward-core.js:503-539
├── forward.js            转发与计费（网络 IO，唯一持有 http 的地方）      ← 拆自 forward-core.js
├── scheduler.js          定时维护（5min/30s/6h/10s 四个定时器）          ← 拆自 index.js:210-429
├── ops.js                域编排面（供应商/账号 CRUD、ctl 视图面）        ← 拆自 index.js:443-747 + router-ops.js
├── quotasync.js          配额/单价/反代更新（外部数据源同步）            ← 拆自 router-ops.js:271-512
├── switch.js             选号 + 失败反应（ctor 注入持久化回调）          ← 保留（微调）
├── proxy-apps.js         反代应用注册表（纯数据）                        ← 保留
├── oauth.js              浏览器登录（平台交互 + 回调服务）               ← 拆自 router-ops.js:37-269
├── providers/
│   ├── base.js           ProviderBase（仅类 + ctor + 显式钩子）          ← 776 → ≤250
│   ├── direct.js         直连 provider（key-pool）                       ← 保留
│   ├── proxy.js          反代 provider（仅生命周期/运输/状态覆写）        ← 1110 → ≤400
│   ├── process-pool.js   实例进程治理（spawn/探活/重启/回收/对账）        ← 新增，拆自 proxy.js
│   └── quota-strategies.js  配额策略注册表                               ← 保留
└── instances/
    └── proxy-instance.js 实例对象 + 四态词表                              ← 保留
```

> **为什么 `forward.js` 不叫 `core.js`**：BRIEF §4 的 `core.js` 语义是"纯核心（无 IO）"，
> 而本块是**网络 IO**（`forwardOnce`/`writeThrough`），按 §2 第一刀（按副作用切）属 IO 侧；
> 命名取**职责主体** `forward`，符合 DS-12（禁止 `*-view`/`*-part` 之类"从哪切出来"的名字）。

### C.2 逐文件表

| 新文件 | 行数估计 | 职责（F 块） | 从哪来（旧文件:行区间） | 纯? |
|---|---:|---|---|---|
| `index.js` | **≤150** | 门面：`new RouterService(deps)` 组合 + 导出 `{RouterService}` | index.js:22-62（ctor）+ 758-763（导出） | ❌ |
| `daemon.js` | **≤120** | F0 装配+启动 | daemon.js:1-83, 123-188 | ❌ |
| `config.js` | ≤80 | F3 配置/路径/白名单 | daemon.js:24-51 | 半纯 |
| `ports-bootstrap.js` | ≤90 | F8/F9 端口迁移+重建 | daemon.js:85-121 | ❌ |
| `model.js` | ≤250 | F1 模型/状态形状 | proxy-instance.js:27-99 + base.js:732-773 | ✅ |
| `policies.js` | **≤380** | F4 纯策略 | base.js:13-185 + 320-458 + 577-682 | ✅ |
| `store.js` | ≤120 | F2 持久化 | store.js:1-53 + forward-core.js:503-539 | ❌ |
| `forward.js` | **≤400** | F7 转发/计费 | forward-core.js:31-155 + 157-474 + 476-546 | ❌ |
| `scheduler.js` | ≤250 | F10 定时维护 | index.js:210-429 + 515-528 | ❌ |
| `ops.js` | **≤400** | F9 CRUD + 视图 | index.js:443-514 + 530-747 | ❌ |
| `quotasync.js` | ≤250 | F5/F9 外部数据源同步 | router-ops.js:271-512 | ❌ |
| `oauth.js` | ≤220 | F9 浏览器登录 | router-ops.js:37-269 | ❌ |
| `switch.js` | ≤120 | F6 选号/失败反应 | switch.js:1-117（保留） | 半纯 |
| `proxy-apps.js` | 49 | 数据 | 保留 | ✅ |
| `port-segments.js` | 39 | 申报 | 保留（处置见 G.2-X3） | ✅ |
| `providers/base.js` | ≤250 | ProviderBase 类壳 | base.js:187-319, 461-576, 684-730 | ❌ |
| `providers/proxy.js` | **≤400** | 反代 provider（生命周期/运输/覆写） | proxy.js（扣除 process-pool 部分） | ❌ |
| `providers/process-pool.js` | ≤380 | F8 实例进程治理 | proxy.js:81-215, 372-730, 915-1110 | ❌ |
| `providers/quota-strategies.js` | 163 | F5 | 保留（改 require `../policies`） | 半纯 |
| `instances/proxy-instance.js` | 102 | F1 | 保留 | ✅ |

> **R7 核对（门面只读）**：router 域**不产出任何 facade**——`app/facade/` 属**编排层（L2）**，不是域内文件。
> 本域对外的只读面是 `ops.js` 的视图方法（`status`/`domainSummary`/`portsView`/`listProviders`/`proxyApps`/`proxyUpdateStatus`），
> 写面是 CRUD/启停（`addXxxProvider`/`removeProvider`/`activateProvider`/`setProviderKeys`/…）。
> **两者同属 `RouterService` 的公开面、且都经 ctl 白名单暴露**（`ROUTER_CTL_METHODS`）——R7 约束的是 **`app/facade/`**，
> 「各域自己的 ops 不受此约束」（R7 原文）。故本域**无需**把写方法拆出 `ops.js`。
> 唯一需注意的是 `app/facade/router.js:78 setRouterRunning`（见 G.2-X11）：它是**编排层**的写动作，不是域内方法。

**行数可达性自检**：
- `ops.js`：现状视图+CRUD（约 305 行）**≤400** ✅（`router-ops.js` 的更新/配额 242 行已移入 `quotasync.js`）
- `forward.js`：`forward-core.js` 547 行，移出用量 IO（`_writeTotals`/`_loadTotals`/`getUsage`/纯工具）约 130 行 → **≈415**，接近临界；
  若超限，把 `extractUsage`/`estimateCost`/`joinUpstream`/`readUpstreamBody`（约 90 行，**纯函数**）再下沉到 `policies.js` 或 `model.js`。
- `proxy.js`：1110 行扣除 process-pool 约 700 行 → **≈410**，同样临界；如超限，把 `_resolveLaunchCommand`/`_cachedPkgBin`/`_ensurePkgCached`（约 90 行，进程侧）下沉 `process-pool.js`。

---

## D. 依赖图（★ 必须 DAG）

### D.1 目标图（DF-5：DAG，且无 prototype 合并）

```
                       ┌──────────────────────────────────────┐
                       │  daemon.js  (F0 进程入口)             │
                       └───┬──────────┬───────────┬───────────┘
                           │          │           │
                  ┌────────▼──┐  ┌────▼─────┐  ┌──▼─────────────┐
                  │ config.js │  │index.js  │  │ports-bootstrap │
                  └────────┬──┘  └┬───┬─────┘  └──┬─────────────┘
                           │      │   │           │(ports)
                           │      │   └───────┐   │
                     ┌─────▼──────▼──┐  ┌─────▼───▼──────┐
                     │  ops.js (F9)  │  │ scheduler.js   │
                     └──┬──┬──┬───┬──┘  └───┬───┬────────┘
                        │  │  │   │         │   │
           ┌────────────┘  │  │   └─────────┘   │
           │    ┌──────────┘  │                 │
    ┌──────▼──┐ │   ┌─────────▼───────────┐ ┌───▼────────────┐
    │oauth.js │ │   │ quotasync.js (F5/F9)│ │ store.js (F2)  │
    └────┬────┘ │   └─────────┬───────────┘ └───┬────────────┘
         │      │             │                 │
         │ ┌────▼─────────────▼──┐           ┌──▼──────────────┐
         │ │  forward.js  (F7)   │           │ model.js        │
         │ └──┬──────────────────┘           │ policies.js (F1/F4 纯)
         │    │                              └──┬──────────────┘
         │ ┌──▼─────────┐                       │
         │ │ switch.js  │                       │
         │ │   (F6)     │                       │
         │ └──┬─────────┘                       │
         │    └────────────┬────────────────────┘
         │                 │
         │        ┌────────▼─────────────────────┐
         └───────►│ providers/{base,direct,proxy}│
                  │   + process-pool + quota     │
                  └──────────────────────────────┘
                    （叶子：只向下 require
                      model/policies/instances/platform）
```

### D.2 逐边清单与理由（目标图）

| from | → to | 理由（为什么这条边必须存在） |
|---|---|---|
| daemon.js | config.js | 入口需要域配置/白名单/路径，装配期一次性取 |
| daemon.js | index.js | 入口需要构造域服务 |
| daemon.js | ports-bootstrap.js | **迁移必须在 RouterService 构造前执行**（`daemon.js:86-87` 的教训：构造后执行会内存空表覆盖历史绑定），故由入口显式排序 |
| index.js | ops.js / scheduler.js / forward.js / oauth.js / quotasync.js / switch.js / store.js | 门面组合 + 委托；**只做 wiring，不含逻辑**；**具名导出，无 prototype 合并** |
| ops.js | store.js | 编排需要持久化 |
| ops.js | providers/*（经 ctor 注入，不 require） | 编排操作供应商实例；**用注入而非 require**（手法 B） |
| scheduler.js | ops.js（经注入回调） | 定时器只"触发"，不"实现"（当前 `index.js:213-233` 直接调 `this.refresh*` 即此缺陷） |
| forward.js | model.js, policies.js, providers/*（经入参） | 转发只需纯模型/策略与一个 provider 句柄 |
| switch.js | policies.js（仅 `headerRetryMs`/`bodyResetMs`） | 纯函数复用 |
| store.js | model.js | 序列化需要模型形状 |
| quotasync.js | store.js, platform/distribution | 数据源同步后需落盘 |
| providers/base.js | policies.js, model.js | 基类调用纯状态机，**不再 `this.stopInstance()`**（改注入钩子） |
| providers/proxy.js | providers/process-pool.js, providers/base.js, model.js | 反代 = 基类状态机 + 进程治理 |
| providers/process-pool.js | model.js, platform/os/* | 纯进程治理，**不 require base**（解 SCC-B 的关键） |
| providers/quota-strategies.js | policies.js（`normalizeResetTs`） | 纯归一 |
| providers/direct.js | providers/base.js, providers/quota-strategies.js | 继承 + 策略 |
| port-segments.js | platform/service/ports | 域申报（唯一 target 是 platform） |
| config.js / ports-bootstrap.js | platform/* | 向下 |

**跨域边**：仅 `app/assembly/compose.js → domains/router/index.js`（现状既有，合法向下）。本设计**不新增**任何跨域边。

### D.3 现状图 → 目标图 对照（★ 关键交付）

| 现状 require 边 | 目标处置 |
|---|---|
| daemon.js→index/port-segments（27 条中的 2 条） | **保留**，但 daemon 不再直接碰 `./port-segments`（由 `ports-bootstrap` 承担） |
| index.js→forward-core.js / router-ops.js（**mixin 注入**） | **删除**，改为 `index.js: ctor 组合`；forward/ops 成为**独立具名模块**，不再是 prototype 碎片 |
| index.js→providers/base.js（3 处，含 2 处延迟 require 取 preset） | **收敛 1 处**：preset 表移到 `model.js`（纯数据），门面无延迟 require |
| index.js→providers/proxy.js、direct.js | **保留**（门面组合） |
| router-ops.js→index.js（this 边） | **删除**，`ops.js` 经 ctor 注入 `{store, findProvider, persist, logger, events}` |
| providers/proxy.js→base.js（this 边，② extends） | **保留 require（extends）**，正常 OOP |
| providers/base.js→proxy.js（this 边，③ 虚分派） | **改为注入钩子**（E.2 第 1 条），SCC-B 降为单向 |
| port-segments 的 5 处 require | **收敛 2 处**（index.js + providers/base.js），其余改经依赖传递 |

### D.4 环清单（★ 按 R1 口径）

| 粒度 | 现状 | 目标 |
|---|---|---|
| **require 图（文件）** | **0 环**（27 边，剥注释 + Tarjan；R1 已裁决 BRIEF §0 表述错误） | 0 环 |
| **this 调用图（文件）** | **2 个 SCC**：SCC-A {index, forward-core, router-ops}（DF-4 **违规**）、SCC-B {base, proxy}（**已声明**多态，见 A.2(c)） | **0 环** |
| **prototype 合并图** | 1 处合并（`index.js:758-759`，3 文件） | **0**（门禁 RG-8 锁死） |

> **R1 精算补充（供合并裁决）**：R1 的「18 方法 / 48 处」来自**单一 prototype 规则的朴素扫描**。按机制精算后为 **24 对 / 57 处**，
> 其中 **DF-4 违规集 = 11 对 / 33 处**（mixin）。差异来源两处：
> ① R1 清单漏了 `forward-core.js:508 this.canPersist()`（定义 `index.js:154`）与 `router-ops.js` 的 6 处 `this.getProvider()`（定义 `index.js:749`）；
> ② R1 的 18 对里混入了 `extends`/虚分派（属正常 OOP，非"私调"）。
> **两者不矛盾**，只是分类口径不同；建议合并文档采用「violation = 11 对 / 33 处」这一更严口径。

### D.5 与 D1–D4 的一致性检查（★ 主代理裁决用）

**前提更新**：`design-notes/` 现有 `_RULING.md`（D1–D4 的域内设计产出在本会话不可见）。
下列契约中 **K1/K3/K4/K7 已由 R2/R3/R5 裁决**，保留作为**合并时的校验清单**：

| # | 契约（本文立场） | 状态 | 冲突性质 |
|---|---|---|---|
| **K1** | 域内子目录限 `providers instances policies model store handlers core jobs`；**优先扁平** | ✅ **R2 已裁决** | 若某设计新增白名单外的子目录 → 违规 |
| **K3** | `index.js` **≤150 行** | ✅ **R3 已裁决** | 与旧 DS-9（≤200）矛盾已被 R3 覆盖；合并时须同步改 DS-9 |
| **K4** | 单文件 **≤400 行** | ✅ **R3 已裁决** | 同上（旧 DS-9 ≤450） |
| **K7** | `daemon.js` **basename 不得改** + 保留 `require.main === module` 守卫 | ✅ **R5 已裁决** | 改名打断 5 处 cmdline 匹配：`app/daemons/probe.js:27`、`process.js:85`、`test/round8-fixes-test.js:88,131,134` |
| **K2** | `providers/base.js` **不得** `this.stopInstance()`（F4 是叶子） | 🔶 待 D3/D4 对齐 | 违反 BRIEF DF-4；本文 E.2 已给手法 |
| **K5** | 转发（F7）与进程治理（F8）必须分文件 | 🔶 待 D3/D4 对齐 | 若二者留在 `providers/proxy.js`，≤400 不可达 |
| **K6** | `port-segments.js` 的"require 即申报"**保留** | 🔶 本文建议（超本域） | 改动跨 `platform/service/ports` + 5 消费点 |
| **K8** | `router-ops.js` 需三分（`ops`/`quotasync`/`oauth`）才满足 ≤400 | 🔶 待 D3/D4 对齐 | 见 C.2 行数自检 |

---

## E. `this` 隐式耦合消解表（★ 逐条）

> 手法：**A** = 具名导出+显式依赖；**B** = 构造注入；**C** = 参数显式化（纯函数化）。
> 下表覆盖 A.2(b) 的**违规集 ①（11 对 / 33 处）** 与**需改造的 ③（1 处）**；②/④ 不改。
> **R7 适用性**：E 节消解的是**域内 this 隐式耦合**，与 R7（`app/facade/` 只读、写动作下沉 `app/domain-actions/`）**不冲突**——
> 域内 ops 的写方法**允许保留**（R7 明确"各域自己的 ops 不受此约束"）。故本节**不新增**任何"把写方法移出 ops"的条目；
> 编排层的 `setRouterRunning` 归属见 G.2-X11。

### E.1 SCC-A：`{index, forward-core, router-ops}` 的 11 对 33 处

| 旧调用 | 位置（处数） | 手法 | 新形态 |
|---|---|---|---|
| `this.log(line)` | forward-core.js:166,217,231,247,273,291,299,315,371（9） | **B** | `createForward({ logger, store, switcher, policies })` 工厂；调用点改 `logger.log(...)` |
| `this.readBody(req)` | forward-core.js:168（1） | **A** | 纯 IO 工具 → 在 `forward.js` **本文件**具名导出；index.js 删掉同名方法 |
| `this.canPersist()` | forward-core.js:508（1） | **B** | 写权闸归 `store.js`（其 `store.js:43` 已有 `canPersist`）；`forward.js` 经注入的 `store` 调用 |
| `this.proxyFor(prov,req,res)` | index.js:440（1） | **A/B** | `handleForProvider` 改调 `this._forward.proxyFor(...)`（注入的 `forward` 对象），不依赖 prototype 上恰好有 |
| `this._loadTotals()` | index.js:546,603（2） | **A** | 用量文件 IO → `store.js` `loadUsage()`；index 只转发 |
| `this.getUsage()` | index.js:558（1） | **A** | 派生视图 → `store.js` `usageView()`（纯派生部分入 `policies.js`） |
| `this.refreshProxyUpdateInfo()` | index.js:215,223（2） | **B** | 移入 `scheduler.js`，ctor 收 `{ refreshProxyUpdateInfo, refreshOfficialUsageAll, refreshOfficialPricingAll }` |
| `this.refreshOfficialUsageAll()` | index.js:216（1） | **B** | 同上 |
| `this.refreshOfficialPricingAll()` | index.js:217,233（2） | **B** | 同上 |
| `this._save()` | router-ops.js:393,457,509,582,607,618,646（7） | **B** | `ops.js` ctor 收 `{ persist }`；**顺带修掉 ops 只读却要写库的越权** |
| `this.getProvider(id)` | router-ops.js:448,517,595,633,651,659（6） | **B** | ctor 注入 `{ findProvider }` |

### E.2 SCC-B：`{providers/base, providers/proxy}` 的 1 处需改造

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.stopInstance(acc.instance)`（**F4 叶子调 F8 上层**） | providers/base.js:307（`discardAccount` 内） | **B** | 二选一：<br>**(a) 钩子注入**：`base.js` ctor 增 `opts.hooks?.onAccountDiscarded`；`discardAccount` 调 `this._hooks.onAccountDiscarded(acc)`（默认 no-op）；`proxy.js` 构造时注入 `(acc) => this.stopInstance(acc.instance)`。<br>**(b) 编排承担**：`base.discardAccount` 只做**纯移除**，由 `ops.js` 调用前后负责停实例。<br>**推荐 (a)**：改动面最小（1 处定义 + 1 处注入），方向正确（上层向下注入能力）。 |

**其余 ②（16 处 extends 上溯）与 ③ 中另 6 处不改** —— ② 是 stdlib 级 OOP；③ 占位已在 `base.js:240-253` 显式声明。
**唯一硬化要求**：proxy 的三个覆写（`markQuotaExhausted` `proxy.js:838`、`markCreditsExhausted` `proxy.js:847`、`markBanned` `proxy.js:1105`）
**必须先做副作用再 `super.xxx()`**（现状如此）。重构时**不得**把 base 内的 `this.markXxx()`（`base.js:333-335`）改成直调基类实现，
否则会**静默丢掉"停实例 + 对账"副作用**。已加门禁 RG-12（见 H 节）。

### E.3 消解后的可测性验证（DF-6）

| 目标文件 | 单测只需 require 它 + 假依赖？ | 方式 |
|---|---|---|
| `policies.js` | ✅ 完全可测 | 纯函数，输入 quota/acc/now |
| `model.js` | ✅ | 纯对象 |
| `config.js` | ✅ | 传 config 对象与 env |
| `store.js` | ✅ | **传临时文件路径**，不碰生产 `ports*.json`/`providers.json` |
| `ports-bootstrap.js` | ✅ | 传临时目录 |
| `forward.js` | ✅ | 注入假 logger/store/switcher；`joinUpstream`/`extractUsage`/`estimateCost`/`readBody` 为具名导出可直接断言 |
| `daemon.js` | ✅（**已实测**） | `require` 后零副作用，`process` 监听器计数不变（H-RG-2） |
| `providers/base.js` | ✅ | 注入假 `{onPersist, hooks}`；状态机判定全在 policies |

---

## F. 迁移步骤（★ 可执行、可分批）

> 原则：**每步后门禁仍绿、可独立提交、可回滚**。步骤 1–3 只解 daemon；4–5 解环；6+ 才动大文件。

| 步 | 动作 | 影响文件 | 验证 |
|---:|---|---|---|
| **1** | 新建 `config.js`：移入 `daemon.js:24` `DEFAULT_CTL_PORT`、`25-39` `ROUTER_CTL_METHODS`、`41` `CONFIG_PATH`、`43-51` `loadConfig` | `daemon.js`、`config.js` | `node -e "require('./src/domains/router/config')"`；`node test/router-ctl-test.js` |
| **2** | 新建 `ports-bootstrap.js`：移入 `daemon.js:85-121`；导出 `ensurePorts({swDir, logger})`（入参显式化） | `daemon.js`、`ports-bootstrap.js` | 传**临时目录**假依赖单测：无文件→0、有记录→计数正确；`node test/round13-router-relay-gaps-test.js` |
| **3** | `daemon.js` 收敛为纯装配：只留 require/装配/ctl/启动/信号；**保留** `require.main===module`（`:188`）与 basename（R5）；≤120 行 | `daemon.js` | H-RG-2（`require` 后监听器计数不变，**已实测**）；`wc -l ≤120`；`node test/provider-gateway-gate-test.js`（`:47`/`:222` pin 了 daemon 路径） |
| **4** | 解 SCC-B：按 E.2(a) 给 `base.discardAccount` 注入 `onAccountDiscarded` 钩子 | `providers/base.js`、`providers/proxy.js` | `node test/router-test.js`、`test/freeze-recovery-test.js`、`test/reconcile-instance-test.js` |
| **5** | 解 SCC-A：**删除 `index.js:758-759` 的 `Object.assign(prototype, ...)`**（**这 2 处即 R6-RG-8 在本域的全部命中，全域另 4 处在 instance/plugin/supervisor，非本域**）；`forward-core.js`/`router-ops.js` 改工厂 `createForward(deps)`/`createOps(deps)`；ctor 组装 `this._forward/this._ops`；替换 E.1 的 33 处调用点 | `index.js`、`forward-core.js`、`router-ops.js`、`switch.js` | `test/router-test.js`、`test/p2p-router-test.js`、`test/router-e2e-test.js`、`test/core-test.js`、`test/ensure-instance-test.js`（5 个都 `new RouterService`，回归主网）；**R6-RG-8 断言本域命中归零** |
| **6** | 抽 `policies.js`（纯函数，A/C 手法）：`normalizeResetTs`/`quotaOverallStatus`/`isQuotaCreditsLow`/`classifyUpstreamLimited`/`headerRetryMs`/`bodyResetMs`/`_windowExhausted`/`_nextResetAt`/`usageOf`/`applyDetection`；配套新单测 | `providers/base.js`、`providers/proxy.js`、`quota-strategies.js`、`switch.js` | 新 `test/router-policies-test.js`（**纯函数，零 IO**）；旧 `test/monthly-credits-freeze-test.js` |
| **7** | 抽 `model.js`；拆 `providers/proxy.js` → `process-pool.js`；`quota-strategies.js:27` 改指 `../policies` | `providers/*`、`instances/*` | `node test/commandcode-quota-test.js`、`test/reconcile-instance-test.js` |
| **8** | 拆 `forward-core.js` → `forward.js`（用量 IO 入 `store.js`）；拆 `router-ops.js` → `ops.js` + `quotasync.js` + `oauth.js`；`index.js` 抽出 `scheduler.js` | index/forward/router-ops/store | 全套 router 测试 + `node test/directory-structure-gate-test.js` |
| **9** | `index.js` 降到 ≤150 行（仅组合+导出）；`port-segments` require 收敛到 2 处 | `index.js` | `wc -l ≤150`；门禁 RG-1/RG-5/RG-8/RG-10 |

**每步必须跑的公共门禁**（否则白改）：
```
node test/directory-structure-gate-test.js
node test/layering-and-dependency-gate-test.js
node test/provider-gateway-gate-test.js
node test/srcpath-gate-test.js
```

**⛔ 本文不做的验证**：不启动 `bin/dsh-supervisor daemon`，不 spawn 任何守卫。步骤 2 的迁移逻辑一律用**临时目录 + 直接 require 纯函数**验证；绝不碰 `~/.local/state/dsh-supervisor/` 与生产 `ports.json`。

---

## G. 风险与取舍

### G.1 破坏性改动 → 点名消费方

| 改动 | 破坏面 | 消费方（点名） |
|---|---|---|
| 删 `index.js:758-759` 的 `Object.assign(RouterService.prototype, ...)` | **外部调用面不变**（方法仍在 RouterService 上），但**直接给 prototype 打补丁**的测试会失效 | `test/reconcile-instance-test.js:50-51`（`ProxyProvider.prototype._doStart = ...`）、`test/router-test.js:75` |
| `daemon.js` 拆 `config.js`/`ports-bootstrap.js` | 路径字面量门禁 | `test/provider-gateway-gate-test.js:47`（`ROUTER_DAEMON = 'src/domains/router/daemon.js'`）、`:222` |
| `providers/base.js` 拆 `policies.js` | 直接 require base 取纯函数的测试 | `test/monthly-credits-freeze-test.js:10` |
| `quota-strategies.js:27` 改 require 目标 | 该文件间接单测 | `test/commandcode-quota-test.js:20`（require proxy → base） |
| `base.discardAccount` 改钩子注入 | 若测试直接调 `discardAccount` 并断言实例被停 | 步 4 全量跑 router 测试捕获 |
| `port-segments.js` require 收敛 | 若测试单独 require proxy/base 期待申报已就位 | **建议保守不动**（K6/X3） |

### G.2 裁决与遗留（★ 已按 R1–R7 更新）

| # | 事项 | 状态 |
|---|---|---|
| **X1** | `index.js` 阈值 150 vs 200 | ✅ **R3 裁决 ≤150**；合并时同步改 DS-9 |
| **X2** | 单文件阈值 400 vs 450 | ✅ **R3 裁决 ≤400**；合并时同步改 DS-9 |
| **X4** | BRIEF §0「循环 require」与实测不符 | ✅ **R1 裁决**；本文补充了 24 对/57 处 与 违规集 11 对/33 处 的分类口径（D.4 注） |
| **X5** | `Object.assign(X.prototype, ...)` 门禁漏网 | ✅ **R4 裁决 → R6 修正**；RG-8 已换成三条组合判据（右值不限 + 分片导出 + 反向自检含变量样本），并修正了 R4 原正则的**假阴性/假阳性** |
| **X6** | `daemon.js` basename | ✅ **R5 裁决不得改** |
| **X7** | 子目录白名单 | ✅ **R2 裁决放宽**；本文仍选扁平（无同类多文件） |
| **X3** | `port-segments.js`"require 即申报"是否为缺陷 | 🔶 本文建议**维持现状**。改显式 `register()` 跨 `platform/service/ports` + 5 消费点，**超本域范围**，需平台侧同步出设计 |
| **X8** | `api/domains/router.js`（162 行）与域界限 | 🔶 越层 SSOT 范畴（`api/deps.js` 负责接口声明）；本文不动 |
| **X9**（新增） | `forward.js`/`providers/proxy.js` 的 ≤400 呈**临界**（≈415/≈410） | 🔶 见 C.2 行数自检；若超限按该处回落方案下沉纯函数 |
| **X10**（新增） | ③ 虚分派"先副作用后 super"无显式契约 | 🔶 建议 RG-12 门禁锁定（E.2 末） |
| **X11**（新增·**R7**） | `app/facade/router.js:78 setRouterRunning(on)` 是**写动作**，却位于「门面」。它跨 router 域做：启停独立 daemon（`_ensureRouterRuntime`）、置 `config.routerAutostart`、`persistConfigPatch`、驱动 `lifecycleManager` 相位（:80-113） | 🔶 **R7 归属**：须下沉 `app/domain-actions/`（当前**该目录不存在**）。<br>**router 域侧需配合**：该写动作最终调用的是**本域** `RouterService.start()/stop()`（`index.js:159/182`）与 `stopAndWait()`（`index.js:188`）。重构本域时**不得改动这三个方法的签名/语义**，否则 `app/domain-actions` 迁移会二次破坏。<br>**消费方点名**（改名/迁移必查）：`src/api/domains/router.js:33,36`（`sup.setRouterRunning`）、`src/app/control/adapters.js:49,54`（`sup.setRouterRunning`）、`src/api/deps.js:81`（声明）、`test/probe-gate-and-ownership-test.js:134`（已断言判据在 `app/facade/router.js`，**迁移后该测试需改指向**）。 |
| **X12**（新增·**R6**） | RG-8 新判据（右值不限）会**扩大命中面** | ✅ **R6 裁决**。本轮剥注释全域实测命中 **6 处**：`domains/router/index.js:758,759`（本域，步 5 消灭）、`domains/instance/index.js:31`、`domains/plugin/index.js:33`、`supervisor.js:160,161`（**非本域**）。<br>⇒ 该门禁**必须全域生效**，由主代理在合并时统一落 `test/domain-structure-gate-test.js`；本域只负责消灭自己那 2 处（迁移步 5）。<br>另注：② `METHODS_FRAGMENT` 当前全域命中 **28 个文件**（`app/**` 为主），若作为硬门禁需**先确认这些分片是否仍经 ① 注入**——否则会大面积误报。建议：② 仅作**告警**，① 作**硬失败**。 |

### G.3 不做的部分与理由

| 不做 | 理由 |
|---|---|
| 重新设计 `providers/proxy.js` 内部（F8 的算法级切分） | 属 D3/D4 供应商设计；本文只锁"F7/F8 必须分文件"的边界（K5） |
| 把 `port-segments.js` 改成显式注册 API | 跨平台层契约，收益 < 风险（X3） |
| 为 `store.js` 引入通用 JSON 原子写库 | 现 `store.js:44-50` 的 `tmp(pid+ts)+rename+0600` 已正确，且专门修过"固定 `.tmp` 并发写"缺陷 |
| 拆 `switch.js`（117 行，健康） | 未超 DF-2；职责单一（F6）；且已是**手法 B 的正例**，改了只增加回归面 |
| 改 `daemon.js` 的 basename / `require.main` 守卫 | **R5 硬约束** |
| 新增 `reconcile.js` 等额外文件 | 若与 D3 的 `process-pool.js` 重叠会造成"两处期望集判定"；**期望集必须只有一个决策者**（`index.js:337-341` 的历史教训） |
| 为 `policies.js` 建 `policies/` 子目录 | **R2**：仅在确有多个同类文件时才建；本域 `policies.js` 唯一 |

---

## H. 门禁建议（供 `test/domain-structure-gate-test.js`）

| 门禁 | 断言 | 判据实现要点 |
|---|---|---|
| **RG-1** | `daemon.js` ≤120 行，且**不含** `migrateByOwnerPrefix` / `Object.assign(w+.prototype` / `refreshOfficial` | 行数 + 关键词黑名单 |
| **RG-2** | `daemon.js` `require` 后**零进程副作用**：`SIGTERM/SIGINT/uncaughtException/unhandledRejection` 监听器计数不变，且不监听端口 | 子进程 `node -e "require(...)"` 后比对 `process.listenerCount`；**本轮已实测可用** |
| **RG-3** | `daemon.js` 保留 `require.main === module` 守卫 且 basename 为 `daemon.js` | 源码含 `if (require.main === module)`；路径基名（**R5**） |
| **RG-4** | `ROUTER_CTL_METHODS` **只含公开方法**（无 `_` 前缀），每项在 router 源码确有定义或为 ctl 内置特例 | `isMethodAllowed(ROUTER_CTL_METHODS, '_save') === false`（**本轮已实测**）；对白名单逐项 grep 定义 |
| **RG-5** | `index.js` **≤150 行**（R3）且不含 `setInterval`/`Object.assign(w+.prototype`/`fs.writeFileSync` | 关键词黑名单 |
| **RG-6** | 域内 require 图为 DAG（Tarjan SCC，节点 = `domains/router/` 下全部 `.js`） | **必须先剥注释**；报告 SCC>1 |
| **RG-7** | 域内 `this` 调用图无环：不存在「方法定义在 A、被 B `this.X()` 调用」的**反向**边 | 静态抽「方法定义表」×「`this.(w+)(` 调用表」做 SCC，**②③④ 须先按机制归类，只对 ① 断言**。这是锁 DF-4 的真正判据 |
| **RG-8** ★R4→**R6** | **禁止任何把外部方法集挂到原型的手法**（DS-G3 原判据的漏网）+ **分片导出形态** | **三条组合**，且**必须先剥注释**：<br>① `const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties\|assign)\(\s*[\w$.]+\.prototype\s*[,)]/` —— **右值不限**（变量/内联 require 都命中）<br>② `const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/` —— 分片导出形态<br>③ **反向自检必须含右值为变量的样本**：`Object.assign(X.prototype, mod.methods)` **必须命中**（正是原 R4 正则的假阴性点） |
| **RG-9** | 每个非门面文件可被**单独 require**：子进程里 require 不抛错、不建监听器 | 对 `policies.js`/`model.js`/`store.js`/`forward.js`/`config.js`/`ports-bootstrap.js` 逐个跑 |
| **RG-10** | `port-segments.js` 的 require 点 ≤2（`index.js` + `providers/base.js`） | 扫描 `port-segments` 的 require 计数 |
| **RG-11** | 域内子目录 ⊆ `providers instances policies model store handlers core jobs`（**R2 放宽后**） | 更新 `test/directory-structure-gate-test.js:170` 的 ALLOWED |
| **RG-12**（新增） | **不得弱化"先副作用后 super"**：base 内 `this.markQuotaExhausted/markCreditsExhausted/markBanned`（`base.js:333-335`）不得被改为直调基类 | 断言这三处仍是 `this.` 调用且位于 `effect()`（`base.js:331-337`）；或断言 proxy 覆写仍 `super.xxx()` |
| **RG-13** ★R7 | **`app/facade/*.js` 不得含写动作**（门面只读）。判据：门面导出方法名不得命中写动词前缀，或方法体内不得出现 `persistConfigPatch`/`config.<x> =`/`lifecycleManager` 相位写入 | 本域**不产出 facade**，故此门禁**不在本域文件上生效**；由主代理落在全域结构门禁。<br>**已知违例（R7 要求下沉）**：`src/app/facade/router.js:78 setRouterRunning`、`src/app/facade/lan.js:44 setLanFrp`、`src/app/facade/main.js:41 patchDshMain` → 目标 `src/app/domain-actions/`（**当前不存在**） |
| **RG-14** ★R7 | router 域侧配合：`RouterService.start()`(`index.js:159`)/`stop()`(`:182`)/`stopAndWait()`(`:188`) 的**签名与语义不得改** | 断言之；这是 `app/domain-actions` 迁移能否成功的前置（见 G.2-X11） |

> **反向自检（DS-G8 精神）**：RG-6/RG-7/RG-8 必须能对**旧形态**报 FAIL。
> - RG-7 样本：`a.js: this.foo()` + `b.js: foo(){}` + `index.js: Object.assign(X.prototype, require('./a').m, require('./b').m)` → **必须 FAIL（有环）**。
> - RG-8 ③ 样本（**R6 强制**）：`Object.assign(X.prototype, mod.methods)` → **必须命中**；`Object.assign(X.prototype, require('./y').methods)` → 必须命中；`Object.defineProperties(X.prototype, mod.accessors)` → 必须命中。
> - **剥注释对照（本轮实测）**：不剥注释时 `supervisor.js:21` 的描述性注释会被误命中（**假阳性**），而真正的 `:160` 被漏掉（**假阴性**）——两者同时发生，正是 R6 换判据的实证。
> - **本轮实测 RG-8 命中集（剥注释后，全域）**：`domains/router/index.js:758`、`domains/router/index.js:759`、`domains/instance/index.js:31`、`domains/plugin/index.js:33`、`supervisor.js:160`、`supervisor.js:161` 共 **6 处**（router 域占 2 处，即本次迁移步骤 5 要消灭的目标）。

---

## 附：本轮实测命令与结论（可复现）

| 检查 | 方法 | 结论 |
|---|---|---|
| 文件/行数 | `wc -l` 13 个 router 文件 | 4615 行；`providers/proxy.js` 最大 1110 |
| require 边（**剥注释**） | 自写扫描 + Tarjan SCC | **27 条域内边，0 环** |
| require 边（不剥注释） | 朴素扫描 | 51 条——含 `daemon.js:184` **注释伪边**（会伪造 self-loop） |
| `this` 跨文件调用（分类） | 「方法定义表」×「`this.(w+)(` 调用表」 | **24 对 / 57 处**；**DF-4 违规集 = ① mixin 11 对 / 33 处** |
| `this` 图层 SCC | Tarjan | **2 个 SCC**：SCC-A（违规）、SCC-B（已声明多态） |
| 全域五域 require 环 | Tarjan | router/relay/instance/plugin/shell **均 0 环** |
| 非法层边（全仓） | 层矩阵 | **0 条**；跨域 `domains→domains` **0 条** |
| daemon `require` 副作用 | 子进程比对 `process.listenerCount` | **无副作用**（入口守卫有效） |
| **R6 判据回归** | 剥注释 + 新 `MIXIN_INTO_PROTOTYPE`（右值不限）全域扫描 | 命中 **6 处**：`domains/router/index.js:758,759`、`domains/instance/index.js:31`、`domains/plugin/index.js:33`、`supervisor.js:160,161` |
| **R6 假阴性实证** | 旧 R4 正则 vs 新正则对 `supervisor.js:160` | 旧：**漏掉**（右值是变量 `mod.methods`）；新：**命中** ✅ |
| **R6 假阳性实证** | 旧 R4 正则对 `supervisor.js:21` | 旧：**误命中注释**（说明文字）；剥注释后消失 ✅ |
| **R6 ② 分片导出面** | `METHODS_FRAGMENT` 全域扫描 | 命中 **28 个文件**（`app/**` 为主）——建议只作告警（X12） |
| **R7 facade 写动作** | `grep -nE "^  (async )?(set|patch|...)[A-Z]" src/app/facade/*.js` | **3 处**：`router.js:78 setRouterRunning`、`lan.js:44 setLanFrp`、`main.js:41 patchDshMain`（`app/domain-actions/` 当前**不存在**） |
| ctl fail-closed | `isMethodAllowed` / `createCtlServer({allowMethods:[]})` | `[]→false`、`_save→false`；空白名单**抛错** ✅ |
