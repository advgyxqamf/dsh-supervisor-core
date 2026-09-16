# router 域 · 交换机 / 实例 / 端点 功能设计

> **范围（本文负责）**：`switch.js`（117 行）、`instances/proxy-instance.js`（102 行）、`proxy-apps.js`（49 行）、`port-segments.js`（39 行）；
> 以及任务点名的「独立 HTTP 端点」（`index.js:_newServer/handleForProvider/_startProviderServer`）——**该部分与 D1 重叠，本文只做功能切面与归属标注，不擅自决定归属（见 E.4）**。
> **依据**：`DOMAIN-DESIGN-BRIEF.md` §1–§5、`DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）、`design-notes/_RULING.md`（R1–R5，**覆盖 BRIEF 相应表述**）。
> **取证**：本文所有「文件:行号」均来自本轮实际 `read`；行数取 `read.totalLines`（按「行终止符」计（DS-G9 门禁口径）各少 1，例：`index.js` 763 / terminator 762）。require 边为**去注释**静态扫描。
> **只做设计，未改动任何 `src/` 代码，未 commit，未启动任何守卫进程。**

---

## A. 现状审计

### A.1 文件清单与职责（逐文件）

**本文直接负责的 4 个文件**

| 文件 | 行数 | 当前职责 | 问题 |
|---|---:|---|---|
| `switch.js` | 117 | `SwitchEngine`：①`pickFor/_pickIn`（`switch.js:21-79`）供应商池内选号；②`reactToFailure`（`switch.js:87-112`）上游失败信号→处置动作 | **纯决策与副作用同文件**：`:33` 调 `p.isAccountUsable`、`:42` 调 `this.onPersist()`、`:50/62/76` 改 `p.activeAccount` 或调 `p.markInUse`、`:51/63/77` 发事件、`:91` 调 `provider.classifyResponse`、`:99/103` 调 `provider.effect`、`:100` 写日志。**选号决策本身纯，但被 6 类副作用包裹 → 无法只 require + 假依赖单测** |
| `instances/proxy-instance.js` | 102 | `ProxyInstance` 模型：四态词表（`:27-29`）、字段（`:31-56`）、`toJSON`（`:58-70`）、`isServable`（`:74`）、`occupiesSlot`（`:77`）、`fromJSON`（`:79-91`） | **零 require、零 IO、零 this 跨文件调用——已是健康样板**。唯一问题：它是**全域唯一的 `instances/` 成员**（见 A.3-5） |
| `proxy-apps.js` | 49 | `PROXY_APPS` 纯数据注册表（`:8-47`）：命令模板 / `keyEnv` / `healthPath` / `quota` 面 / `registry` | **零 require、纯数据——健康**。仅需确认它是「常变配置」而非协议（见 B 刀 2） |
| `port-segments.js` | 39 | 端口段/独立池申报：`POOLS`（`:21-23`）、`SEGMENTS`（`:27-31`）、`OWNER_PREFIXES`（`:34`）；`:36-37` **模块顶层副作用**完成 register | 已按 `DIRECTORY-STRUCTURE-DESIGN §4.2` 反转法规范化（`test/ports-capacity-test.js:27`、`test/ports-migrate-test.js:22` 消费）。**唯一结构性债务**：靠「require 即申报」的隐式装配（见 A.3-6） |

**任务点名、但归属待裁的端点切片（`index.js`）**

| 文件:行区间 | 行数 | 职责 | 备注 |
|---|---:|---|---|
| `index.js:433-441` `handleForProvider` | 9 | 端点请求分派（`/health` 短路 + 502 兜底 + 交 `this.proxyFor`） | **与 D1 重叠** |
| `index.js:443-450` `_newServer` | 8 | `http.createServer` + 超时/keepalive/noDelay 调参 | **与 D1 重叠** |
| `index.js:493-504` `_startProviderServer` | 12 | 绑定 + `listen(127.0.0.1, apiPort)` + error 清理 | **与 D1 重叠** |
| `index.js:506-511` `_stopProviderServer` | 6 | 关服 + `closeAllConnections` | **与 D1 重叠** |
| `index.js:453-477` `activateProvider` | 25 | 分配 `providerApi` 端口（`:460`）+ 池满显式失败（`:463-470`）+ 起端点 | 半业务（端口/池）半端点 |
| `index.js:480-491` `deactivateProvider` | 12 | 停端点 + 停实例 + 持久化 | 同上 |
| `index.js:515-528` `_startActivatedProviders` | 14 | 启动恢复：补分配端口 + 起端点 + 对账 | 同上 |

**消费方 / 边界文件（他人负责，本文只引用其接口）**

| 文件 | 行数 | 与本文的关系 |
|---|---:|---|
| `index.js` | 763 | 门面 + 持久化 + 维护定时器 + CRUD + 视图（**D1**）；`:758-759` 用 `Object.assign(prototype, require(...))` 注入 forward/ops 方法集（触 R1 真实病症） |
| `providers/base.js` | 776 | `ProviderBase`：账号状态机 + `isAccountUsable`（`:373-378`）+ `markInUse`（`:553-560`）+ `applyDetection`（`:588`）+ 纯函数 `classifyUpstreamLimited`（`:29-37`）/ `headerRetryMs`（`:40-54`）/ `bodyResetMs`（`:57-`）—— **D3-D4** |
| `providers/proxy.js` | 1111 | `ProxyProvider`：实例进程治理 + 实例池决策（`:915-1108`）**D2** |
| `forward-core.js` | 548 | 转发；本文相关调用点：`:192` `this.switcher.pickFor`、`:285` `this.switcher.reactToFailure`、`:198-200` `instOf/markUsed`、`:205-214` 双预算 | D1/D2 |
| `router-ops.js` | 665 | 账号增删锁（`:594-662`）+ OAuth + 更新 + 配额同步 | D1/D3 |
| `store.js` | 53 | providers.json 原子写 + 损坏保护 | D1 |
| `daemon.js` | 188 | 进程入口（**R5：文件名不得改**） | D1 |

### A.2 域内耦合图

#### (a) require 边（去注释）

本文 4 个文件的 require 边（全部）：

| # | from | → to | 行 | 性质 |
|---:|---|---|---:|---|
| 1 | `switch.js` | `providers/base.js` | 10 | 取 2 个纯函数 `headerRetryMs/bodyResetMs`（**仅** `reactToFailure` 用，`:98`；`pickFor` 不用） |
| 2 | `instances/proxy-instance.js` | —（零 require） | — | 叶子 |
| 3 | `proxy-apps.js` | —（零 require） | — | 叶子 |
| 4 | `port-segments.js` | `platform/service/ports` | 18 | 向上（L1→L0，合法） |
| 5 | `index.js` | `switch.js` | 14 | 门面组合 |
| 6 | `index.js` | `instances/proxy-instance.js` | 82 | 反序列化（**方法体内延迟 require**） |
| 7 | `index.js` | `proxy-apps.js` | 17 | 数据 |

**⛔ 与 BRIEF §0 不符的实测事实（依 R1）**：router 域 **require 图 0 环**；`forward-core.js` 全文零处 require `./index`。BRIEF §0 所称 `index.js ↔ forward-core.js` 循环 require **不成立**。
**真实病症是 `this` 调用图的环**，成因正是 `index.js:758-759`：

```js
758: Object.assign(RouterService.prototype, require('./forward-core').forwardMethods);
759: Object.assign(RouterService.prototype, require('./router-ops').auxMethods);
```

⇒ **DF-5 在本域的真实含义 = 禁止把两个文件的方法合并到同一 `this`**（不是修 require 环）。任何「只把 `forward-core.js` 改名 `forward.js`」的切法都不算完成任务（BRIEF §2 所斥的「文件搬家」）。
**取证纪律**：扫描必须先剥注释——`daemon.js:184` 注释里写着 `require('.../router/daemon')`，朴素扫描会伪造出 `daemon.js→daemon.js` 自环。

#### (b) `this.X()` 跨文件调用边

| from 文件 | 被调方法 | 定义在 | 行 | 处数 |
|---|---|---|---:|---:|
| `switch.js` | `onPersist()`（ctor 注入闭包 `() => this._save()`） | `index.js:60` | 42 | 1 |
| `index.js`（端点切片） | `proxyFor()` | `forward-core.js:159` | 440 | 1 |
| `index.js`（端点切片） | `log()` / `readBody()` | `index.js:530/535`（**同文件**） | 498/502 | 0 跨文件 |
| `index.js`（维护切片） | `_loadTotals()/getUsage()/refresh*/_ensureProviderInstances` | `forward-core.js:525/541`、`router-ops.js:290/437/465` | 546/558/603/215/216/217/223/233/259 | 9 |
| `router-ops.js` | `_save()` / `getProvider()` / `providers` | `index.js:125/749/42` | 393,457,509,582,607,618,646 / 448,517,595,633,651,659 / 277,316 | 13+ |

> 全域合计 **18 方法 / 48 处**（D3 实测，本文复核一致）。本文负责的 4 个文件中，**只有 `switch.js:42` 一处**跨文件 `this` 调用；
> `instances/proxy-instance.js`、`proxy-apps.js`、`port-segments.js` **零处**。

#### (c) `this` 环（SCC）

| 环 | 成员 | 载体 | 本文是否波及 |
|---|---|---|---|
| 环 1 | {`index.js`, `forward-core.js`, `router-ops.js`} | `index.js:758-759` prototype 合并 | 否（端点切片属 D1） |
| 环 2 | {`providers/base.js`, `providers/proxy.js`} | `extends` 合并（`base.js:307` 调只在 `proxy.js:412` 定义的 `this.stopInstance()`） | **是**（实例模型 ↔ 状态机的边界，见 E.3） |
| 环 3 | 无 | `switch.js` 不在任何 SCC 内（其唯一跨文件 `this` 调用 `onPersist` 是**闭包**，不成环） | — |

### A.3 病症清单（对照 §0 四类）

| # | 病症 | 证据（文件:行号） | 本文范围 |
|---|---|---|---|
| 1 | **巨型文件** | `providers/proxy.js` 1111、`providers/base.js` 776、`index.js` 763、`router-ops.js` 665、`forward-core.js` 548 —— DF-2（≤400，R3）全部超标。**本文 4 个文件全部 ≤117 行，无一超标** | 部分（端点切片在 `index.js` 内） |
| 2 | **`this` 隐式耦合** | `switch.js:42` `this.onPersist()`；端点切片 `index.js:440` `this.proxyFor()`；`index.js:215/546/603` 调 forward/ops 方法 | **是**（switch 与端点） |
| 3 | **「环」（`this` 图，非 require 图）** | 环 1 `index.js:758-759` + `forward-core.js:166` `this.log()` ↔ `index.js:440` `this.proxyFor()`；环 2 `base.js:307` ↔ `proxy.js:791` | **是**（端点切片属环 1） |
| 4 | **职责错位** | `index.js` 一门面同时是持久化(`:125`)+维护定时器(`:213`)+CRUD(`:683-737`)+视图(`:545-680`)+**端点(`:433-528`)**；`switch.js` 一门内纯决策与副作用混放 | **是** |
| 5 | **「装配目录」只有一个成员** | `instances/` 下**仅 `proxy-instance.js` 1 个文件**（`ls` 实测）——该子目录已不承载「多实现/多文件」语义 | **是**（任务必答项） |
| 6 | **require 即申报（隐式副作用）** | `port-segments.js:36-37` 顶层 register；被 5 处 require（`index.js:19`、`providers/base.js:9`、`providers/proxy.js:16`、`router-ops.js:6`、`daemon.js:91`） | **是** |
| 7 | **prototype 合并（R4/R6）** | `index.js:758-759` `Object.assign(X.prototype, require(...))`；装配契约见 `index.js:758` 与 `supervisor.js:160`（`Object.assign(Supervisor.prototype, mod.methods)`，**变量右值**）；现门禁 `test/directory-structure-gate-test.js:122` **只匹配 `defineProperties` 且要求内联 require** ⇒ 两种形态全漏 | 否（D1/D10），但 H.1 补齐三件套判据 |

---

## B. 功能切面（★ 设计核心）

> **先不看现有文件**，只回答一个问题：router 域里「账号切换 / 实例 / 端点」这几块，功能上由哪几块组成。
> 结论：**13 个功能块**，落在 **3 个功能域**（切换决策 · 实例治理 · 端点/装配）。每块给：职责 / 输入 / 输出 / 副作用 / 是否纯。

### B.1 切换决策域（switch）

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **S1 选号策略** | 在**单个**供应商的账号池内，按「锁定→粘滞→轮换」定序挑出下一个要用的账号 | `state`={accounts(含 `usable`/`running`)、`selectedAccountKeyId`、`activeAccountKeyId`、`cursor`、`kind`}、`opts.excludeKeys` | `{keyId|null, nextCursor, clearSelected, reason}` | **无** | ✅ **纯** |
| **S2 失败反应策略** | 把「上游失败信号」映射为「重试 / 透传」+ 退避时长 + 是否需要施加账号副作用 | `signal`(`credits/window/banned/transient/none`)、`ctx`={`status`,`headers`,`body`,`attempt`,`attempts`} | `{action, transient?, retryMs?, passthrough?, needEffect, log}` | **无** | ✅ **纯** |
| **S3 切换编排** | 调 provider 拿「信号/可用性」，应用 S1/S2 的决策，执行副作用（事件/持久化/日志/provider.effect） | provider 句柄、账号、ctx | 选中的账号 / 动作对象 | 事件、回调持久化、日志、provider.effect | ❌ |

> **功能事实**：S1/S2 是**对数据与信号的纯判定**，S3 是**唯一编排点**。这三块与现有 `switch.js` 的三段在功能上**一一对应**（`:31-79`→S1、`:87-112`→S2、`:21-24/13-17`→S3），但**现状把它们塞进一个类**，导致 S1 无法脱离 provider 单测。

### B.2 实例治理域（instance）

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? | 归属 |
|---|---|---|---|---|---|---|
| **I1 实例模型** | 定义「一个账号=一个实例」的数据形状、四态词表与服务能力判定 | 原始 JSON / ctor opts | 规范化实例对象、态判定布尔 | **无** | ✅ 纯 | **本文** |
| **I2 实例池策略** | 「期望运行几个实例、哪个常驻、是否要备胎、是否超资源闸」的**纯判定** | accounts + 实例实况 + 上限/预算阈值 | 期望集、`{allowSpare, exceedGate}` | **无** | ✅ 纯 | **D2** |
| **I3 进程治理** | spawn / 探活 / kill / 重启 / 在途仲裁的实际进程操作 | app 定义、实例、端口 | 进程、`pid`、四态迁移 | 进程/端口/日志文件 IO | ❌ | **D2** |
| **I4 实例池对账** | 按期望集收敛：幂等拉起缺口 + 回收非期望集（含闲置宽限、在途/在用保护） | 期望集、实例集 | `{started,stopped,desired}` | 调 I3 | ❌（决策部分纯） | **D2** |
| **I5 实例维护调度** | 5min/30s/事件三种触发：对账、健康监视、冻结到点释放 | 定时器/事件 | 调 I4/I3 | 定时器 | ❌ | **D2** |

> **本文与 D2 的关系（任务必答）**：
> - **I1 是 D2 的输入契约**。D2 的 I2/I4 必须消费 I1 的**态词表与服务能力谓词**——现状里 D2 用的是**散落手写判定**（`providers/proxy.js:811,1018` 手写 `status===HOT && !!pid`，未走 `isServable()`；`:543` 用 `INSTANCE_STATES.DEAD`）
>   **本文的模型切面要求**：这些判定一律改为调用 `isServable()/occupiesSlot()`，否则 I1 只是「文件搬家」（DF-6 不达成）。
> - **I2 是 D2 自己的纯决策**，但它当前**物理上住在 D2 的 `providers/proxy.js:915-1008`**（`residentAccount` / `_needSpare` / `desiredRunningAccounts`），
>   且**直接读 `this.accounts/this.config/this.instanceOf`**——按本文切面，它应参数显式化（手法 C）后与 I3/I4 分文件。落点由 D2 定，本文只锁**边界**：I2 不得持有 provider `this`。

### B.3 端点 / 装配域（endpoint & wiring）

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? | 归属 |
|---|---|---|---|---|---|---|
| **H1 端点绑定** | 为「已激活供应商」在 `127.0.0.1:apiPort` 上建/拆 `http.Server`，端口来自端口池 | providerId、`apiPort` | `http.Server` 句柄 | **监听端口（网络 IO）** | ❌ | **D1（与本文重叠）** |
| **H2 端点请求分派** | `/health` 短路 / 未知供应商 502 / 其余交给转发 | `(providerId, req, res)` | HTTP 响应 | 网络 IO | ❌ | **D1（与本文重叠）** |
| **C1 应用注册表** | 「反代产品=第三方应用」的**常变配置**：命令模板、env 契约、探活路径、配额面 | — | 纯数据 | 无 | ✅ 纯 | **本文** |
| **C2 端口段申报** | 本域端口段/独立池的**域知识申报** + owner 前缀（迁移/清理判据） | — | 注册副作用 | 注册表写入 | ❌ | **本文** |
| **C3 持久化** | providers.json / usage-totals 的原子读写与损坏保护 | 内存态 | 文件 | 文件 IO | ❌ | D1 |
| **C4 域配置** | 路径派生（`stateFile→stateDir`）、ctl 白名单、实例上限/预算阈值 | config、env | 常量/路径 | 读环境 | 半纯 | D1（`daemon.js:24-51`） |

> **任务必答（端点是否与 D1 重叠）**：**是，且重叠面不止 3 个方法。** 功能上 H 是**独立的一块**（B.3），
> 但 `index.js:433-528` 这一整段同时含 H1/H2 **与**「端口池分配 + 池满显式失败 + `activated` 状态位 + 持久化」——
> 后者是 **C2/C3（端口/持久化）**，不是端点。⇒ **E.4 标注「与 D1 重叠，需裁决」，本文不擅自决定归属**。

### B.4 依赖方向（由职责本身导出，与现有文件无关）

```
H1/H2 端点 ──→ S3 切换编排 ──→ S1 选号策略(纯) ──→ I1 实例模型(纯)
                    │             └─→ S2 失败反应策略(纯)
                    └──→ I2 实例池策略(纯) ──→ I1
I3 进程治理 ──→ I1        I4 对账 ──→ I2 + I3        I5 调度 ──→ I4
C1 应用注册表(纯叶子)   C2 端口申报(叶子)   C3 持久化   C4 配置
```

**三条从功能导出的硬规则**：
1. **S1/S2/I1/I2/C1 是叶子，绝不回调上层**（当前违反：`switch.js:91,99,103` 的 provider 调用在 S1/S2 里）。
2. **I1 不得依赖 I3**：模型只描述「进程在不在」，不 spawn（现状正确，`proxy-instance.js` 零 require）。
3. **H1/H2 不得持有供应商语义**：端点只做运输与分派（现状 `index.js:438-440` 正确）。

### B.5 四把刀落点（§2）

| 刀 | 对本文 4 文件的结论 |
|---|---|
| **刀 1 按副作用** | 把 `switch.js:31-79`（S1）与 `:87-112`（S2）的**纯判定**剥出 → `policies/`；provider 调用/事件/持久化留 S3。**这是本文最强的一刀** |
| **刀 2 按变更频率** | `proxy-apps.js` 是**常变配置**（命令模板/版本检查周期/env 名，`:14/27/23`），`proxy-instance.js` 的四态是**稳定协议**——**不得合并**；阈值（`maxHot/maxWarm/switchBudgetMs`，现居 `providers/proxy.js:43-49`）属 D2 |
| **刀 3 按生命周期** | 进程级=`daemon.js`（R5 不改名）；定时级=`scheduler.js`（现混在 `index.js:213-429`，D1/D2）；请求级=H2（`index.js:433`，D1） |
| **刀 4 按角色** | 协议/传输=H1/H2；业务决策=S1/S2/I2；持久化=C3；观测=I3 的健康计数器（`inst._monitorFails/_lastProblem`，`proxy-instance.js:53-55`） |

### B.6 覆盖自检

S1/S2/S3 + I1–I5 + H1/H2 + C1–C4 = 13 块，完整覆盖本文范围 + 任务点名的端点切片，
无遗漏、无「为切而切」的第 14 块。`proxy-apps.js`/`port-segments.js` 各自可独立成块（C1/C2），**不强行合并**。

---

## C. 目标结构（★ 逐文件）

> **R2 生效**：子目录白名单放宽为 `providers instances policies model store handlers core jobs`，但**优先扁平文件**。
> **R3 生效**：`index.js` ≤150；任何单文件 ≤400。
> **R5 生效**：`daemon.js` 文件名不变。
> 下表「归属」列：**本文** = 本文负责落地；**D1/D2/D3-D4** = 他人负责，本文只给接口约束。

### C.1 逐文件表

| 新/改文件 | 行数估计 | 职责（B 块） | 从哪来（旧文件:行区间） | 纯? | 归属 |
|---|---:|---|---|---|---|
| `policies/switch.js` | ≤90 | **S1 选号策略**（`pickAccount(state, opts)`） | `switch.js:31-79` 纯判定部分 | ✅ | **本文** |
| `policies/failure.js` | ≤60 | **S2 失败反应策略**（`decideFailure(signal, ctx)`） | `switch.js:87-112` 纯判定部分 | ✅ | **本文** |
| `switch.js` | ≤110 | **S3 切换编排**：provider 取信号/可用性 → 调 S1/S2 → 施加副作用 | `switch.js:1-117`（保留类与导出面） | ❌ | **本文** |
| `model.js` | ≤120 | **I1 实例模型** + 四态词表 + `isServable/occupiesSlot` | `instances/proxy-instance.js:27-99`（+ 供 D3/D4 追加账号形状） | ✅ | **本文（I1 部分）** |
| `instances/proxy-instance.js` | ≤12 | 兼容 shim：`module.exports = require('../model')` | 同上 | ✅ | **本文（过渡）** |
| `proxy-apps.js` | 49 | **C1 应用注册表** | 不动 | ✅ | **本文（保留）** |
| `port-segments.js` | 39 | **C2 端口申报** | 不动（仅 G.2 记一笔债务） | ❌ | **本文（保留）** |
| `index.js` | ≤150 | 门面：组合 + 委托 | `index.js` 整体 | ❌ | **D1** |
| `endpoints.js` | ≤120 | **H1+H2** 端点绑定与分派 | `index.js:433-450, 493-528` | ❌ | **D1（与本文重叠，需裁决）** |
| `scheduler.js` | ≤250 | **I5** 实例维护调度 | `index.js:213-429` | ❌ | **D1/D2** |
| `providers/process-pool.js` | ≤380 | **I2+I3+I4** 实例池治理 | `providers/proxy.js:81-215, 372-1108` | ❌ | **D2** |
| `store.js` | ≤120 | **C3** | `store.js:1-53` + `forward-core.js:503-539` | ❌ | D1 |
| `config.js` | ≤80 | **C4** | `daemon.js:24-51` + `index.js:46-49` | 半纯 | D1 |

### C.2 目录树（目标）

```
src/domains/router/
├── index.js                门面（≤150，零业务逻辑）                 [D1]
├── daemon.js               进程入口（★ R5：文件名不得改）            [D1]
├── config.js               域配置/路径/白名单/阈值                   [D1]
├── model.js                I1 实例模型 + 四态词表（纯）              [本文]
├── policies/
│   ├── switch.js           S1 选号策略（纯，零 require）             [本文]
│   └── failure.js          S2 失败反应策略（纯）                     [本文]
├── switch.js               S3 切换编排（IO 边界）                    [本文]
├── proxy-apps.js           C1 反代应用注册表（纯数据）               [本文·保留]
├── port-segments.js        C2 端口段申报                             [本文·保留]
├── endpoints.js            H1+H2 HTTP 端点                          [D1·重叠]
├── scheduler.js            I5 维护调度                              [D2]
├── store.js                C3 持久化                                [D1]
├── providers/
│   ├── base.js             ProviderBase（纯策略下沉 policies）       [D3-D4]
│   ├── direct.js           直连 provider                             [D3-D4]
│   ├── proxy.js            反代 provider（仅覆写/运输）              [D2-D3]
│   ├── process-pool.js     I2+I3+I4 实例池治理                      [D2]
│   └── quota-strategies.js 配额策略                                  [D3-D4]
└── instances/
    └── proxy-instance.js   兼容 shim（≤12 行，见 C.3 决策）          [本文·过渡]
```

### C.3 ★ 必答：`instances/` 子目录是否该拆

**决策：撤出 `instances/`，模型上移为域根 `model.js`；`instances/` 暂留 1 个 re-export shim 作为过渡，随后删除。**

依据（四条，均可核验）：
1. **目录语义已不成立**：`instances/` 只有 1 个文件（`ls src/domains/router/instances/` 实测唯一成员 `proxy-instance.js`）。BRIEF §4 对子目录的用途是「多实现/多文件」，**单成员目录是纯碎片**。
2. **R2 明确「优先扁平文件」**：本次裁决把白名单放宽到 8 个名字，目的是「确有多个同类文件才建子目录」。实例模型只有 1 个文件 → 用扁平 `model.js`（BRIEF §4 规范名）。
3. **`model.js` 是全域已规划的落点**：D3 的 `providers/base.js` 拆分也想把「序列化形状」下沉到 `model.js`（`design-notes/router-daemon-and-depgraph.md:239` 把 `base.js:732-773` serialize 形状列给 `model.js`）。两侧同址 ⇒ **一次落位，避免「实例模型在 instances/、账号形状在 model.js」的双址分裂**。
4. **成本可控**：全仓只有 2 处硬引用该路径——`test/router-test.js:86`、`test/provider-gateway-gate-test.js:132`，均已定位，随迁移步更新即可（F 节步 4）。

**反面选项（不采纳）**：若保留 `instances/`，则 `model.js` 与 `instances/proxy-instance.js` 必然二选一空置，要么留一个空壳目录（违反 DS-8 的「不得为空壳」精神），要么让 D3 的账号形状无处安放 ⇒ **不采纳**。

---

## D. 依赖图（★ 必须 DAG）

### D.1 目标图（本文负责部分）

```
        switch.js (S3 编排)
          ├─ require → policies/switch.js   (S1，纯，零 require)
          ├─ require → policies/failure.js  (S2，纯)
          │                └─ require → policies/quota.js (纯：headerRetryMs/bodyResetMs)   ← 见 D.3-③
          └─ 入参(injected) → provider 句柄（base/proxy）          ← 不是 require

        policies/switch.js   → 零 require（纯叶子）
        policies/failure.js  → policies/quota.js（纯）
        model.js             → 零 require（纯叶子）
        proxy-apps.js        → 零 require（纯叶子）
        port-segments.js     → platform/service/ports（L0）
```

### D.2 逐边清单与理由

| # | from | → to | 理由 | 性质 |
|---:|---|---|---|---|
| 1 | `switch.js` | `policies/switch.js` | S3 需要 S1 的决策输出；**A 手法**（具名导出） | 域内下行 |
| 2 | `switch.js` | `policies/failure.js` | S3 需要 S2 的动作映射；**A 手法** | 域内下行 |
| 3 | `policies/failure.js` | `policies/quota.js`（或 D3-D4 指定的纯函数落点） | S2 的 `retryMs` 由 `headerRetryMs/bodyResetMs`（现 `providers/base.js:40,57`）算出；**必须**是纯模块 | 域内下行 |
| 4 | `switch.js` | provider 句柄 | 取 `classifyResponse/effect/isAccountUsable/markInUse`；**B 手法（ctor/入参注入）**，不 require 具体实现 | 注入，非 require |
| 5 | `model.js` | （无） | 纯叶子（现状 `proxy-instance.js` 已零 require） | — |
| 6 | `port-segments.js` | `platform/service/ports` | 域申报，L1→L0 合法向下 | 跨层合法 |

**禁止的边（须在门禁里断言为 0）**：
- `policies/*.js` → `providers/*`、`policies/*.js` → `index.js`/`switch.js`、`model.js` → 任何域内文件、`policies/*`/`model.js` → `node:fs|node:http|node:https|node:child_process`。
- `switch.js` ✗ `index.js`：**现状不存在 require 边，但存在 this 边（`switch.js:42`）**——D.3-① 说明其消解。

### D.3 关键消解说明（本文三条）

**① `switch.js:42 this.onPersist()` —— 本文唯一的跨文件 this 调用。**
不改注入方式（它已是 ctor 注入的闭包，不是 require），而把**决策**改成「纯函数返回 `clearSelected:true`」，
由 S3 在应用决策时调注入回调。⇒ this 调用点从「决策内部」移到「编排层顶部」，语义显式。

**② 端点切片的 `index.js:440` `this.proxyFor()`（属环 1）。**
端点文件必须由 ctor **注入转发对象**（`{ forward }`），调用 `forward.proxyFor(...)`，
**不得**再依赖 prototype 上恰好有该方法。⇒ 环 1 在端点侧的这条边消失（手法 B）。
⚠ **该改动的归属在 D1（端点设计），本文只登记这条边为「必须消解」，不越权设计 D1 的文件。**

**③ `policies/failure.js` 对 `headerRetryMs/bodyResetMs` 的依赖是本文的硬边界。**
这两个函数当前在 `providers/base.js:40/57`（含类文件）。若 D3-D4 把它们留在 `providers/base.js`，
则 `policies/failure.js → providers/base.js` 会形成**纯策略反向依赖 providers** —— 违反 DF-7 与刀 1。
⇒ **本文立场（供裁决）**：纯时延解析函数（`classifyUpstreamLimited` `base.js:29`、`headerRetryMs` `:40`、`bodyResetMs` `:57`、`normalizeResetTs`）应随 S2 一同下沉纯策略层；
**若 D3-D4 另有落点，以 D3-D4 为准，但必须满足「不反向依赖有状态 provider 文件」这一条**。

### D.4 环清单（R1 口径）

| 粒度 | 现状 | 目标 |
|---|---|---|
| **require 图（文件）** | **0 环**（去注释实算；BRIEF §0 的 2 处循环 require 不成立） | 0 环 |
| **`this` 调用图（文件）** | 3 个 SCC（A.2(c)） | 0 环 |
| **prototype 合并** | 有（`index.js:758-759`） | **无**：`policies/*`/`model.js` 是具名模块；`switch.js` 保持**独立类**，绝不被 `Object.assign` 进 `RouterService.prototype` |

**本文可独立达成的部分**：`switch.js` 从来不在 `Object.assign` 里（`index.js:14` 是普通 require），
所以 **switch/model 的拆分天然满足 DF-5**，不依赖 D1 的 prototype 解体。

### D.5 跨域/跨层边

| 边 | 现状 | 本文处置 |
|---|---|---|
| `port-segments.js → platform/service/ports` | 合法（L1→L0） | 保留 |
| `app/assembly/compose.js → domains/router/index.js` | 合法（L2→L1） | 不涉 |
| **本文不新增任何跨域边** | `domains→domains` 实测 0 | 保持 0 |

---

## E. `this` 隐式耦合消解表（★ 逐条）

> 手法：**A** = 具名导出 + 显式依赖；**B** = 构造注入；**C** = 参数显式化（纯函数化）。
> **判定标准**：拆完后能否 `require` 该文件 + 给假依赖 + 断言行为？

### E.1 `switch.js`（全文 8 条跨文件/隐式依赖）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `p.isAccountUsable(a)`（在纯判定内部） | `switch.js:33` | **C** | `pickAccount(state, opts)`，`state.accounts[i].usable` 由 S3 预算后传入 —— 策略**不再持有 provider** |
| `p.kind === 'proxy'` + `a.instance && a.instance.pid`（就绪过滤） | `switch.js:69-70` | **C** | `state.accounts[i].running` 入参；策略只读布尔 |
| `p.selectedAccountKeyId` 死锁清理 → `this.onPersist()` | `switch.js:37-44`（调用点 42） | **C+B** | 纯函数返回 `{clearSelected:true}`；S3 应用时调注入的 `deps.persist()`（**this 调用移出决策**） |
| `p.markInUse(sel.keyId)` / `p.activeAccount = sel` 回退 | `switch.js:50,62,76` | **C+B** | 策略只返回 `keyId`；S3 调 `provider.markInUse(keyId)`（B） |
| `this.events.append('router_pick', …)` | `switch.js:51,63,77` | **C+B** | 策略返回 `reason`；S3 用注入 `events` 追加（事件名与载荷**逐字不变**） |
| `p.cursor` 读写 | `switch.js:73-75` | **C** | `{nextCursor}` 作为返回值；S3 写回 `provider.cursor` |
| `provider.classifyResponse(status, headers, text)` | `switch.js:91-93` | — | **保留在 S3**（provider 契约调用，不是纯判定）；其返回值 `signal` 作为 S2 入参 |
| `provider.effect(sig, acc, c)` | `switch.js:99,103` | — | **保留在 S3**；S2 只返回 `needEffect:boolean`，由 S3 执行 |
| `this.logger.info('CREDITS-EXHAUSTED …')` | `switch.js:100` | **C+B** | S2 返回 `{log:'CREDITS-EXHAUSTED key=…'}`；S3 输出 |

**必须保持的行为不变量（迁移时逐条断言）**：
1. **顺序**：`window` 信号下，`retryMs` 必须在 `provider.effect` **之前**算好并写入 `ctx.retryMs`（现状 `switch.js:98→99`）——否则 `markQuotaExhausted(acc, cooldownMs)` 拿到 `undefined`。
2. **动作映射**：`credits|window` → `retry`；`banned` → `passthrough`（带 `status/headers/body`）；`transient` → `retry+transient:true`（**不施加 effect**）；`none/unknown` → `passthrough`（**绝不误切**，INV-1）。
3. **事件名**：`router_pick` 载荷 `{provider, key: maskedKey}` 不变。
4. **绝不跨供应商 failover**：S1 只在**传入的单个 provider** 池内选（现状 `:19-24` 注释契约）。

**单测可达性（DF-6 验收）**：
```js
const { pickAccount } = require('./policies/switch');       // 零 require，零 provider
pickAccount({ accounts:[{keyId:'k1',usable:true},{keyId:'k2',usable:false}], kind:'direct', cursor:0 }, {})
// → { keyId:'k1', nextCursor:1, reason:'rotate', clearSelected:false }
const { decideFailure } = require('./policies/failure');
decideFailure('window', { status:429, headers:{'retry-after':'60'} }) // → { action:'retry', retryMs:60000, needEffect:true }
```

### E.2 `instances/proxy-instance.js`（0 条）

零 require、零 IO、零 `this.X()` 跨文件调用。迁移到 `model.js` **只需移动文件**（+ 补 `module.exports` 兼容 shim）。
**这就是「健康样板」的含义**：它已经满足 DF-3/DF-4/DF-6，本文对它**不做任何语义改动**，只解决「单成员子目录」（C.3）。

### E.3 实例模型 ↔ 状态机边界（与 D2/D3 的接口，本文只锁约束）

| 旧调用 | 位置 | 问题 | 本文要求的新形态 |
|---|---|---|---|
| `this.stopInstance()`（在 base 的账号方法里） | `providers/base.js:307`（定义在 `providers/proxy.js:412`） | 纯模型/状态机**反向调进程治理**（DF-7 违例） | `discardAccount` 只做「移除账号 + 释放端口记录 + 持久化」；**停进程由调用方（S3/ops）在删除后执行**（现状 `router-ops.js:639` 已有 `stopInstance(inst,true)` 先例，可对齐） |
| 手写 `inst.status === HOT && !!inst.pid` 判定 | `providers/proxy.js:811,1018`；`:543` DEAD；`:1018` HOT||WARM | 模型能力谓词**被绕过**，同一语义多处手写 | 一律改为 `inst.isServable()` / `inst.occupiesSlot()`（I1 的谓词是**唯一事实源**） |
| `INSTANCE_STATES` 直接比较 | `providers/proxy.js:15, 244, 277, 334-350, 420-450, 518-527, 543-585, 666, 689, 811, 1018` | 合法（词表来自模型） | 保留；但语义判定优先走谓词 |

### E.4 ★ 端点切片：**与 D1 重叠，需裁决**（本文不擅自决定归属）

**功能事实（B.3）**：`index.js:433-528` 这一段含**三类不同职责**：

| 职责 | 具体成员 | B 块 |
|---|---|---|
| 纯端点（运输） | `handleForProvider` `:433-441`、`_newServer` `:443-450`、`_startProviderServer` `:493-504`、`_stopProviderServer` `:506-511` | **H1/H2** |
| 端口/资源治理 | `activateProvider` `:453-477`（`:460` allocate、`:463-470` 池满显式失败）、`_startActivatedProviders` `:515-528`、`_releaseProviderPorts` `:740-747` | **C2 + I 侧** |
| 视图/生命周期 | `deactivateProvider` `:480-491`（含停实例） | D1 |

**§7 合并约定要求的显式标注**：

> ⚠ **归属冲突登记**：本文认为「H1/H2 = HTTP 端点」在功能上**独立于门面**（应独立文件，建议 `endpoints.js`），
> 但 `index.js` 的门面/持久化/维护定时器拆分**属 D1 范围**，且 `handleForProvider` 与 `proxyFor` 的调用边属环 1（D1 的 prototype 解体）。
> ⇒ **与 D1 重叠，需裁决**：端点文件由谁落、`activateProvider` 的「端口分配 + 池满失败」归 C2 还是 H1。
> **本文不擅自决定归属**，也不设计 D1 的文件布局；仅在 H 节给出可自动校验的**边界断言**。

### E.5 与 D2 的边界（实例池管理）

| 项 | 本文（I1） | D2（I2/I3/I4/I5） |
|---|---|---|
| 四态词表 `INSTANCE_STATES` | **唯一所有者**，导出冻结对象 | 消费者 |
| `isServable()/occupiesSlot()` | **唯一所有者**（服务能力谓词） | 必须调用，不得手写 |
| `toJSON/fromJSON`（落盘形状、pid 不落盘、port 持久化） | **唯一所有者** | 消费者 |
| 期望集 / 常驻 / 备胎 / maxHot/maxWarm / switchBudget | — | **D2 所有** |
| spawn/kill/探活/watchdog/对账/定时 | — | **D2 所有**（本文建议落 `providers/process-pool.js`，最终由 D2 定） |
| 共享契约 | 「一账号一实例」（`keyId` 映射）由 I1 定义，D2 实现 `instanceOf/accountOf` | 实现方 |

---

## F. 迁移步骤（★ 可执行、可分批）

> 约定：每步**独立可提交**、可单独回滚；验证命令全部是**离线测试**（无任何守护进程启动，符合硬约束）。

| 步 | 动作 | 影响文件 | 验证 | 可独立提交 |
|---:|---|---|---|---|
| **1** | 新增纯策略 `policies/switch.js`（S1）——把 `switch.js:31-79` 的判定改写为 `pickAccount(state,opts)`；`switch.js` 改为「预算 usable/running → 调 pickAccount → 应用副作用」。**导出面 `{SwitchEngine}` 与 `pickFor()` 方法名/返回值保持逐字不变** | `switch.js`、新增 `policies/switch.js` | `node test/router-test.js`（`:33` `svc.switcher.pickFor(dp)`）、`node test/freeze-recovery-test.js` | ✅ |
| **2** | 新增纯策略 `policies/failure.js`（S2）——`decideFailure(signal,ctx)`；`reactToFailure` 改为「取 signal → decideFailure → 施加 effect/log」。**保持 E.1 的 4 条行为不变量** | `switch.js`、新增 `policies/failure.js` | `node test/upstream-credits-test.js`（`:153-198` 五条 reactToFailure 断言，含「取证旁路已删除」源码断言） | ✅ |
| **3** | 新增**纯策略单测**（新 `test/switch-policies-test.js`）：只 `require('.../policies/switch')` 与 `policies/failure`，给假 state / 假 ctx，断言选择序与动作映射（含 `clearSelected`、`window→Retry-After=60000`、`none→passthrough`、`transient→retry 无 effect`） | 新增 test | `node test/switch-policies-test.js` | ✅ |
| **4** | 把 I1 移到 `model.js`；`instances/proxy-instance.js` 改写为 re-export shim；更新 `test/router-test.js:86` 与 `test/provider-gateway-gate-test.js:132` 的读取路径 | `instances/proxy-instance.js`、新增 `model.js`、2 个 test | `node test/router-test.js`（`:84-87` 四态 + `isServable`）、`node test/provider-gateway-gate-test.js`（PG-3） | ✅ |
| **5** | 把 D2 的手写态判定改为谓词：`providers/proxy.js:811,1018` → `inst.isServable()`；核对 `:543` 的 DEAD 分支语义 | `providers/proxy.js`（**D2 文件，需 D2 同意**） | `node test/reconcile-instance-test.js`、`node test/instance-state-test.js`、`node test/ensure-instance-test.js` | ⚠ 需 D2 排期 |
| **6** | 删除 `instances/` 目录（shim 已无消费方）+ 更新 DS-G6 白名单与「不得空壳」判据 | 目录、`test/directory-structure-gate-test.js` | `node test/directory-structure-gate-test.js`（DS-G6） | ✅ |
| **7** | （D1 排期）端点切片落 `endpoints.js` + 环 1 消解（注入 `forward` 对象）+ prototype 合并删除 | `index.js`、新增 `endpoints.js` | `node test/p2p-router-test.js`、`node test/router-e2e-test.js`、`node test/p2p-api-test.js` | ⚠ **需 D1 裁决（E.4）** |

**端口/申报相关回归（每一步后都应跑）**：
`node test/ports-capacity-test.js`（`:27-28` require 本域 `port-segments`）、`node test/ports-migrate-test.js`（`:22` `OWNER_PREFIXES`）、`node test/directory-structure-gate-test.js`、`node test/layering-and-dependency-gate-test.js`。

---

## G. 风险与取舍

### G.1 破坏性改动（点名消费方）

| 改动 | 破坏面 | 缓解 |
|---|---|---|
| `instances/proxy-instance.js` 路径改变 | `test/router-test.js:86`、`test/provider-gateway-gate-test.js:132`（**仅这 2 处**，全仓 grep 实测） | F 步 4 用 re-export shim；步 6 再删 |
| `switch.js` 内部结构改变 | `test/upstream-credits-test.js:153-154` 直接 `new SwitchEngine`；`test/router-test.js:33` 经 `svc.switcher.pickFor`；**还有源码串断言**：`upstream-credits-test.js` 断言 `switch.js` 无 `_capture|onEvidence` | **保持 `{SwitchEngine}` 导出 + `pickFor/reactToFailure` 方法签名与返回形状不变**；不引入新禁用词 |
| `policies/*.js` 新增 require 依赖 | 若 D3-D4 把纯时延函数留在 `providers/base.js` ⇒ 纯策略反向依赖有状态文件（DF-7 违例） | **E.1 ③ 硬边界**：以 D3-D4 落点为准，但必须满足「不反向依赖」 |
| `port-segments.js` 保持「require 即申报」 | 与「require 应纯」的仓内取向相左（`daemon.js:183-187` 明确在意隐式副作用） | **不采纳改造**：改造会牵动 `platform/service/ports` 的 `registerPools/registerSegment` 契约与 5 个消费点（`index.js:19`、`base.js:9`、`proxy.js:16`、`router-ops.js:6`、`daemon.js:91`）→ **跨域改动，需上层裁决**（记 G.2） |

### G.2 不做的部分与理由（不为设计而设计）

1. **不做 `port-segments.js` 的显式装配化**：收益（require 纯）< 成本（跨 platform 契约 + 5 消费点），且当前 5 处 require 是**幂等**的；仅登记为债务。
2. **不把 `proxy-apps.js` 拆成「命令模板 / 配额面 / 更新策略」三文件**：它 49 行、纯数据、**常变配置**（刀 2 的意义是别和稳定模型混，而不是碎裂）。
3. **不设计实例池的定时器/对账切法**（I2/I3/I4/I5）：属 D2；本文只给 I1 契约与「手写判定→谓词」的验收点（E.3、F 步 5）。
4. **不设计 `endpoints.js` 的文件内容与 `activateProvider` 的归属**：与 D1 重叠，**需裁决**（E.4）。
5. **不为 `switch.js` 引入 `ProviderPort` 抽象接口类**：现状 `pickFor(provider, opts)` 的 duck-typing 已被 `supports()` 能力声明覆盖（`providers/base.js:240`、`providers/proxy.js:69`），再加一层会过度反转。

### G.3 取舍记录

| # | 取舍 | 结论 |
|---|---|---|
| T1 | S1/S2 拆到 `policies/` vs 留 `switch.js` 但参数显式化 | **拆**：任务点名 `policies/switch.js`，且 R2 白名单含 `policies`；拆后单测可从「构造整个域」降为「require 一个文件」 |
| T2 | `instances/` 保留 vs 撤出 | **撤出**（C.3 四条依据） |
| T3 | `model.js` 是否合并 `proxy-apps.js` | **不合并**：一个是稳定协议（四态），一个是常变配置（命令/env），违反刀 2 |
| T4 | `switch.js` 是否也变成瘦门面 shim | **不**：它是 S3 编排（有 provider 协作），保留类；但**绝不进 `Object.assign`** |

---

## H. 门禁建议（供 `test/domain-structure-gate-test.js`）

> 判据必须**机器可判**且**能区分旧形态**（DS-G8 反向自检精神）。

### H.1 ★ R4 + **R6**：禁止「把外部方法集挂到原型上」（右值不限）

**R6 修正说明（原 R4 判据有假阴性）**：R4 的正则要求右值是**内联 require**，
但仓内存在两种形态，且更危险的那种是**变量右值**：

| 形态 | 样本 | 出处 |
|---|---|---|
| 内联 require | `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` | `src/domains/router/index.js:758`（本文范围） |
| **变量右值** | `Object.assign(Supervisor.prototype, mod.methods)` | `src/supervisor.js:160`（**R4 漏掉**） |

`src/supervisor.js` 装配契约（`src/supervisor.js:19-22` 注释、`:139`）正是 `module.exports = { methods, accessors }` + 循环 assign：

```js
// src/supervisor.js:159-161（实读；assign 在 :160，defineProperties 在 :161）
for (const mod of APP_MODULES) {
  if (mod && mod.methods) Object.assign(Supervisor.prototype, mod.methods);
  if (mod && mod.accessors) Object.defineProperties(Supervisor.prototype, mod.accessors);
```

⇒ 判据替换为**三条组合**（**必须先剥注释**，否则 `supervisor.js:21` 的说明文字会造成假阳性）：

```js
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ① 任何把外部方法集挂到原型的手法（右值不限：require(...) 或 mod.methods 或任意表达式）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（方法的来源侧；与 ① 成对即坐实「方法分片 + prototype 合并」）
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:} ]/;

// 反向自检（判据非空转）——★ ②③ 两例必须同时覆盖「内联 require」与「变量右值」：
check('H-1 ① 命中内联 require 形态',
  MIXIN_INTO_PROTOTYPE.test("Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)") === true);
check('H-1 ① 命中变量右值形态（R6 关键）',
  MIXIN_INTO_PROTOTYPE.test('Object.assign(Supervisor.prototype, mod.methods)') === true);
check('H-1 ① 命中 defineProperties 形态',
  MIXIN_INTO_PROTOTYPE.test("Object.defineProperties(S.prototype, require('./x'))") === true);
check('H-1 ① 不得误报普通对象合并',
  MIXIN_INTO_PROTOTYPE.test("const m = Object.assign({}, require('./x'))") === false);
check('H-1 ② 命中分片导出形态',
  METHODS_FRAGMENT.test('module.exports = { methods: {') === true);
check('H-1 剥注释后不得命中说明文字（R6 假阳性回归）',
  strip('// Object.assign(X.prototype, mod.methods) 是说明') .includes('Object.assign') === false);
```

> ⚠ 现 `test/directory-structure-gate-test.js:122` 只匹配 `defineProperties` **且要求内联 require** ⇒
> 既漏 `index.js:758`/`index.js:759` 的真实形态（部分），又漏 `supervisor.js:160` 的**变量右值**形态。**必须按 R6 三件套替换。**

> **实测命中面（本文用 R6 正则对全仓 `src/**/*.js` 实跑，结果见下）**——
> 修正后的判据 ① 远不止命中 `router/index.js`，而是**同时命中 4 个文件 / 7 处**，其中 **3 处不在本文范围**：

| 文件:行 | 形态 | 归属域 |
|---|---|---|
| `src/domains/router/index.js:758` | `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` | **本文（D1 步 7）** |
| `src/domains/router/index.js:759` | `Object.assign(RouterService.prototype, require('./router-ops').auxMethods)` | **本文（D1 步 7）** |
| `src/supervisor.js:160` | `Object.assign(Supervisor.prototype, mod.methods)` | D10（`app/` + 入口） |
| `src/supervisor.js:161` | `Object.defineProperties(Supervisor.prototype, mod.accessors)` | D10 |
| `src/domains/instance/index.js:31` | `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods)` | **instance 域（非本文）** |
| `src/domains/plugin/index.js:33` | `Object.assign(PluginManager.prototype, opsMethods, jobsMethods)` | **plugin 域（非本文）** |

> ⇒ **这是跨域发现，需上层裁决**：`instance/plugin` 两个域的**主拆分手段**就是 `Object.assign` 方法集合并
> （`instance/index.js:20` 与 `plugin/index.js:22` 的注释直书「故经 Object.assign(...) 并入同一原型」）；
> 若按 R1/R6 的 DF-5 口径禁绝此形态，**这两个域的目标结构必须另设计**（本文不越权设计，仅登记）。

**剥注释的必要性（门禁假阳性实测）**：简单 grep 全仓会额外命中 3 行**纯注释**——
`src/supervisor.js:21`、`src/app/state/fields.js:24`、`src/domains/instance/index.js:20`、`src/domains/plugin/index.js:22`；
其中 `supervisor.js:21` 正是 R6 指出的那处**说明文字**（讲「这取代了旧的 defineProperties 注入」）。
⇒ 门禁**必须**先 `strip()` 再匹配，否则 D10 落地后仍会有永久假阳性。

**本文范围内的落点**：判据 ① 先在 `src/domains/router/index.js:758-759` 上**变红**（现状命中），
在本文 F 步 7（D1 排期）删除 prototype 合并后**转绿**；`supervisor.js:160-161` 属 D10、`instance/plugin` 属他域，
**本文不动它们**，但判据必须一次覆盖全部形态，否则门禁会在其他域落地后仍然漏检。

### H.2 纯模块不得持有 `this`（DF-4/DF-6 的直接判据）

```js
// policies/** 与 model.js：不得出现 this 关键字（剥注释后）
const thisHits = (strip(src).match(/\bthis\b/g) || []).length;      // 断言 === 0
// 反向自检：strip('// this.x') 必须为 0；strip('this.x') 必须为 1
```

### H.3 纯模块不得 require IO / 有状态同级文件（DF-3/DF-7）

```js
const BANNED = /require\(\s*['"](?:node:)?(?:fs|http|https|child_process|net|worker_threads|timers)['"]\s*\)/;
// 对 policies/**、model.js 断言 0 命中；另断言不 require '../switch' / '../providers/*' / '../index'
```

### H.4 行数与门面（R3）

| # | 断言 |
|---|---|
| H-4a | `src/domains/router/index.js` 行终止符数 ≤ 150 |
| H-4b | `src/domains/**/*.js` 任何文件 ≤ 400 |
| H-4c | `src/domains/router/switch.js` ≤ 150（拆分后应显著下降，防回涨） |

### H.5 子目录纪律（R2 + DS-8 补强）

```js
const ALLOWED = new Set(['providers','instances','policies','model','store','handlers','core','jobs']);
// ① 子目录必须在白名单内（替换 test/directory-structure-gate-test.js:170 的 {providers,instances}）
// ② 新增：子目录不得为「单文件空壳」——除非该文件是显式过渡 shim（文件首行含 shim 标记）
```

### H.6 端点边界（E.4，D1 裁决后生效）

| # | 断言 |
|---|---|
| H-6a | 端点文件（`endpoints.js` 或 D1 指定名）**不得** `require('node:fs')`、不得出现 `providers.json`、不得出现 `selectedAccountKeyId`/`isAccountUsable`（不得持有供应商语义分支） |
| H-6b | 端点文件**不得** `this.proxyFor(`：必须经注入对象调用（`forward.proxyFor(`） |

### H.7 实例模型唯一事实源（E.3）

| # | 断言 |
|---|---|
| H-7a | `providers/*.js` 不得手写 `status === INSTANCE_STATES.HOT &&` + `!!.*\\.pid` 组合（应调 `isServable()`） |
| H-7b | `INSTANCE_STATES` 只在 `model.js` 定义（其他文件必须 require 取用） |

### H.9 ★ **R7**：facade 只允许只读视图（写动作下沉 `app/domain-actions/`）

**R7 对 router 的落点（实测证据）**：`src/app/facade/router.js` 里混着一个**写动作**
`setRouterRunning`（定义在 `:78`，方法体 `:78-115`）——它做的是**改状态**，不是视图：

| 该写动作触碰的状态 | 行 | 性质 |
|---|---:|---|
| `this._ensureRouterRuntime(true/false)` | `:83`, `:105` | 拉起/停止独立 daemon |
| `this._disableRouterPersist()` | `:89` | **写权闸**（让守卫侧不写 providers.json） |
| `this.config.routerAutostart = true/false` | `:90`, `:98`, `:107`, `:113` | 配置态 |
| `this.persistConfigPatch({ routerAutostart })` | `:91`, `:99`, `:108`, `:114` | **落盘** |
| `rlc.wantRunning()/_setPhase('starting'/'stopped')/_monitoring` | `:92`, `:100`, `:109`, `:115` | 生命周期视图镜像 |

**旁路证据**：仓内**本应**经生命周期适配器启停 router —— `src/app/control/adapters.js:49` / `:54`
（`start: async () => sup.setRouterRunning(true)` / 同式 false）—— 而 api 侧另有直连路径：
`src/api/domains/router.js:32-37` 直接 `sup.setRouterRunning(...)`。
⇒ 同一条写动作存在**两条入口**（适配器 / api），**绕过生命周期与目录记账**，正是 R7 要消除的形态。

**本文据此对 router 域侧的要求**（与 C/E 一致，**不新增任何跨域改动**）：

| # | 要求 |
|---|---|
| H-9a | `app/facade/router.js` 只保留只读方法：`routerDaemonActive:9`、`routerStatusView:25`、`routerProviders:37`、`routerStatus:51`、`routerDomainSummary:58`；`setRouterRunning` **移出**（→ `app/domain-actions/router.js`） |
| H-9b | 写动作经 **域 ops** 触达 router 域：`router.start()` / `router.stop()` / `router.stopAndWait(timeoutMs)`（`index.js:159-196`）与写权闸 `setPersistEnabled`（`index.js:144`，域侧已有，**无需 facade 转手**） |
| H-9c | 启停的唯一编排入口是 `app/control/adapters.js:49,54`（生命周期适配器）；api **不得**直连写动作（`src/api/domains/router.js:32-37` 应改为经 domain-action/适配器） |
| H-9d | `src/api/deps.js:81` 的 `setRouterRunning` 依赖登记随之下移到 domain-action 面 |

**实测裁定（本文用 H-9 五个 deny 模式对 `src/app/facade/*.js` 实跑）**：

| 文件 | deny 命中数 | 结论 |
|---|---:|---|
| `src/app/facade/router.js` | **15** | 唯一含写动作的门面 → 须把 `setRouterRunning:78-115` 移出 |
| `src/app/facade/{lan,main,ports,status}.js` | 0 / 0 / 0 / 0 | **未命中 deny 模式** |

> ⚠ **重要限定**：`lan.js:44 setLanFrp` 与 `main.js:41 patchDshMain` 按 R7 名称属**写动作**，但其方法体**未命中这 5 个 deny 模式**（它们不写 `config`/不调 `persistConfigPatch`、改的是各域自身状态）。
> 即：**deny 模式只覆盖「直接改守卫 config / 生命周期镜像 / 持久化」这一类写动作**，
> 不足以判定 `setLanFrp`/`patchDshMain` 的归属 ⇒ **其下沉需 D10 按 R7 语义裁决，本文不代为判定**（避免判据假阴性被当成结论）。

**本文 4 个文件（`switch.js` / 实例模型 / `proxy-apps.js` / `port-segments.js`）不含任何 facade 或写动作**，
故 **R7 不改变本文 C/E 的文件清单**；仅新增 H-9 边界断言，供 D1（门面拆分）与 D10（`app/`）协同落地。

```js
// H-9 判据（剥注释后；对 src/app/facade/*.js）
const FACADE_DENY = [
  /persistConfigPatch\s*\(/, /_disableRouterPersist\s*\(/, /_ensureRouterRuntime\s*\(
 , /this\.config\.\w+\s*=/, /\.wantRunning\s*\(/, /\._setPhase\s*\(/
];
// 反向自检：以下样本必须被任一模式命中
check('H-9 反向：setRouterRunning 体可被判据识别',
  FACADE_DENY.some((re) => re.test('this.persistConfigPatch({ routerAutostart: true });')) === true);
check('H-9 反向：只读视图不得误报',
  FACADE_DENY.some((re) => re.test('routerStatus() { const st = this.router.status(); return st; }')) === false);
```

---

## 附：本文与 `_RULING.md` R1–R7 的逐条对齐

| 裁决 | 本文落点 |
|---|---|
| **R1** require 图 0 环 / 真实病症是 this 图 + `Object.assign` | A.2(a)(b)(c)、D.4、H.1；本文 4 文件中只有 `switch.js:42` 一处跨文件 this 调用 |
| **R2** 白名单放宽、**优先扁平文件** | C.2 只新增 `policies/`（白名单内）；`instances/` 撤出（C.3）；无 `ops/` 等新目录 |
| **R3** `index.js` ≤150、单文件 ≤400 | C.1 全部估计 ≤400；H.4 |
| **R4+R6** 必须禁 `Object.assign(X.prototype, <任意右值>)` | H.1（三件套判据：右值不限的正则 + `module.exports={methods}` 分片形态 + 剥注释；反向自检**含 `Object.assign(Supervisor.prototype, mod.methods)` 样本**） |
| **R5** `daemon.js` 文件名不改 | C.1/C.2 保留；F 节无任何改名步 |
| **R7** facade 只允许只读视图，写动作 → `app/domain-actions/` | H.9：`app/facade/router.js:78` 的 `setRouterRunning` 是写动作（`:89` 写权闸、`:91/:99/:108/:114` 落盘、`:92/:100/:109/:115` 生命周期镜像），应移出；启停唯一入口 = `app/control/adapters.js:49,54`。**本文 4 文件不含 facade/写动作，C/E 文件清单不变** |
