# 域内结构设计（DOMAIN-STRUCTURE-DESIGN）

> **状态**：**执行中**（v1 定版 2026-09-17；同日进入 12+ 子代理并行施工，批 0–10）。本文件是**域内分层/拆分的唯一事实源（SSOT）**。U-2/U-3 由 test/standards-uniqueness-test.js 机器校验。
> **来源**：12 份设计文档（`design-notes/`，6085 行）+ 主代理裁决 R1–R12。
> **与前一份唯一事实源的关系**：`DIRECTORY-STRUCTURE-DESIGN.md` 管**跨层/跨域**（五层结构）；
> 本文件管**域内**（每个域内部怎么切）。两者互补。

## §1 问题陈述

上一轮（步骤 1–10）解决了跨层问题，但**域内部仍高耦合**：

| 域 | 文件数 | 最大文件 | 实测跨文件 `this` 调用 |
|---|---|---|---|
| router | 13 | **1111 行**（providers/proxy.js） | 47 处 |
| relay | 5 | 505 行 | 0 |
| instance | 4 | 450 行 | 46 处 |
| plugin | 5 | 428 行 | 34 处 |
| shell | 4 | 282 行 | 0 |
| app | 53 | 806 行（native/installer.js） | **222 处** |

**四类病症**：① 巨型文件；② `this` 隐式耦合（编译期不可见、无法独立单测）；
③ `Object.assign(X.prototype, require(...))` 把方法集合并到同一 this；④ 职责错位。

## §2 判据（DF-1..DF-7，**取严值**）

| 编号 | 判据 | 阈值 |
|---|---|---|
| **DF-1** | 门面 `index.js` 只做组合与导出，无业务逻辑 | **≤150 行** |
| **DF-2** | 任何单文件 | **≤300 行**（第三轮取严；由 DG-2 校验） |
| **DF-3** | 纯计算与副作用（IO/定时/进程）不混在同一文件 | — |
| **DF-4** | **零隐式 `this` 跨文件**：跨文件调用必须显式（require 具名导出 / ctor 注入） | 0 处 |
| **DF-5** | 域内依赖图无环（DAG） | 0 环 |
| **DF-6** | 每个非门面文件可 `require` 后**不构造整个域对象**即可测 | — |
| **DF-7** | 依赖单向：`index → ops/scheduler → core/policies → model/store` | 0 条向上边（由 DG-7 校验） |
| **DF-8** | **`require()` 必须在模块顶层**，不得内联在函数体内 | 0 处（唯一豁免：`src/supervisor.js` 的 `get lan()` 惰性 require；由 DG-15 校验） |
| **DF-9** | **函数（回调/闭包）嵌套深度 ≤6 层**，超出的须提为具名函数 | ≤6（由 DG-16 校验） |

### DF-5 的真实含义（★ R1 更正）

⚠ **实测：router/relay/instance/plugin/shell 五域的 require 图全部 0 环**。
病症**不在 require 图**，而在 **`this` 调用图**（成因是 `Object.assign(X.prototype, require(...))`
把多个文件的方法合并到同一个 this）。

⇒ **DF-5 落地为**：禁止把两个文件的方法合并到同一 `this`。
否则文件改名后 require 图仍是 DAG，而 DF-4/DF-6 依旧被违反（即「文件搬家」）。

### 门禁实现必须**先剥注释**（★ R6）

⚠ 实测陷阱：`supervisor.js:21` 的**说明性注释**里含 `Object.defineProperties(X.prototype, require(...))`，
朴素 grep 会**假阳性**；而真实注入 `Object.assign(Supervisor.prototype, mod.methods)`（右值是变量）会被**假阴性**漏掉。

**判据（R6/R12 定稿）**：
```js
// ① 硬失败：任何把外部方法集挂到原型的手法（右值不限）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 仅告警：分片导出形态（全域约 30 个文件命中，含 UMD 简写）
const METHODS_FRAGMENT       = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
const METHODS_FRAGMENT_SHORT = /module\.exports\s*=\s*\{[\s\S]{0,200}?\bmethods\b\s*[,:}]/;
```
反向自检**必须含**：内联 require 形态、变量右值形态（`Object.assign(X.prototype, mod.methods)`）、
纯注释形态（剥注释后不得命中）。

## §3 目录规范（统一，按需使用）

```
domains/<domain>/
├── index.js      门面：组合 + 导出（≤150，无逻辑）
├── daemon.js     进程入口（仅装配 + 启动；**文件名不得改**，见 R5）
├── core.js       纯核心（无 IO）
├── model.js      领域模型（类/数据结构/状态机）
├── policies/     纯策略（阈值/判定/算法），每个 ≤250
├── store.js      持久化（序列化 + 原子写）
├── ops.js        编排（流程）
├── scheduler.js  定时/周期任务
├── providers/    多实现（仅 router/plugin 需要时）
├── handlers/     请求处理器
└── README.md     本域职责边界与依赖图
```

⚠ **优先扁平文件**；仅在确有多个同类文件时才建子目录（避免过度碎片化）。
⚠ 门禁子目录白名单（R2 定稿）：`providers instances policies model store handlers core jobs`。

## §4 消除 `this` 隐式耦合的三种手法

| 手法 | 适用 | 说明 |
|---|---|---|
| **A 具名导出** | 无状态工具/策略 | `module.exports = { computeQuota }` |
| **B 构造注入** | 有状态、需协作 | `new Provider({ store, logger, ports })` |
| **C 参数显式化** | 纯函数化 | `this.x` → 入参 `(state, ctx)`；**决策类优先用这条** |

## §5 各域目标结构（定版）

### §5.0 目标 vs 实测（对照表；**目标是内部设计值，不是门禁**）

> 口径（重要，防「为消红而放宽」的变体）：
> - **目标列**取自下方 §5.1–§5.6 的定版目标（`≤N` 为硬设计目标，`~N` 为近似目标），**不得为了让表变绿而静默抬高**；
> - **实测列**为写入时对当前树 `wc -l` 的实测值；判据是**行数**，硬门禁只 `≤300`（DG-2: `>300` 才红）——
>   故下表**全部满足硬门禁**，超目标项只是**未达设计目标 = 已登记债务**；
> - 标 **超目标** 的条目：**后续任何新增行都会继续加深该债**；标 **贴线** 的条目：再加 1 行即越界。
> - 全表实测于本轮（P4-D），若树继续变动请以重新实测为准。

| 文件 | 目标 | 实测 | 状态 |
|---|---|---|---|
| `router/index.js` | ≤150 | 150 | **贴线**（=150） |
| `router/model.js` | ≤180 | 94 | 达 |
| `router/store.js` | ≤170 | 160 | 达 |
| `router/ops.js` | ≤260 | 162 | 达 |
| `router/endpoint.js` | ≤140 | 143 | **超目标 +3** |
| `router/views.js` | ≤200 | 146 | 达 |
| `router/scheduler.js` | ≤290 | 216 | 达 |
| `router/forward-core.js` | ≤120 | 34 | 达 |
| `router/handlers/parse.js` | ≤140 | 108 | 达 |
| `router/handlers/forward.js` | ≤330 | 300 | 达（**距 DG-2 硬线 300 为 0**，贴硬门禁） |
| `router/store/usage.js` | ≤160 | 101 | 达 |
| `router/model/inflight.js` | ≤90 | 52 | 达 |
| `router/router-ops.js` | ≤100 | 34 | 达 |
| `router/ops/browser.js` | ≤140 | 83 | 达 |
| `router/ops/oauth.js` | ≤190 | 140 | 达 |
| `router/ops/apps-registry.js` | ≤230 | 159 | 达 |
| `router/ops/quotasync.js` | ≤140 | 89 | 达 |
| `router/ops/admin.js` | ≤200 | 130 | 达 |
| `router/policies/switch.js` | ≤90 | 50 | 达 |
| `router/providers/policies/freeze.js` | ≤200 | 254 | **超目标 +54** |
| `relay/index.js` | ≤60 | 12 | 达 |
| `relay/daemon.js` | （不变）214 | 194 | 达（优于原值） |
| `relay/port-segments.js` | （不变）22 | 18 | 达 |
| `instance/index.js` | ≤95 | 95 | **贴线**（=95） |
| `instance/model.js` | ≤140 | 99 | 达 |
| `instance/sandbox.js` | ≤85 | 79 | 达 |
| `instance/state-machine.js` | ≤85 | 74 | 达 |
| `instance/store.js` | ≤100 | 119 | **超目标 +19** |
| `instance/lifecycle.js` | ≤185 | 212 | **超目标 +27** |
| `instance/ops.js` | ≤180 | 139 | 达 |
| `instance/upgrade.js` | ≤330 | 231 | 达 |
| `plugin/index.js` | ≤70 | 80 | **超目标 +10** |
| `plugin/store.js` | ~180 | 193 | **超目标 +13** |
| `plugin/layers.js` | ~170 | 223 | **超目标 +53** |
| `plugin/market.js` | ~260 | 270 | **超目标 +10**（原报仅 +1，实测 +10；后续新增必再加深） |
| `shell/index.js` | 35 | 24 | 达（优于原值） |
| `shell/journal.js` | ~110 | 109 | 达 |
| `shell/restart.js` | ~157 | 121 | 达 |
| `shell/watchdog.js` | ~185 | 198 | **超目标 +13** |
| `shell/core.js` | ~95 | 106 | **超目标 +11** |

**汇总**：超目标 **10** 项（router 2 / instance 2 / plugin 4 / shell 2）、贴线 **3** 项
（`router/index.js` 150、`instance/index.js` 95、`router/handlers/forward.js` 硬线 300）；
其余全部达。**全部满足 `≤300` 硬门禁**。上述 10 项即设计目标债务，**未抬高任何目标值**。

### §5.1 router（13 文件 → 22 文件，最大 330 行）

```
router/
├── index.js             ≤150  门面（组合 + 导出 RouterService）
├── model.js             ≤180  状态容器 + 模型映射 + 实例模型
├── store.js             ≤170  providers.json + usage-totals.json + **写权单闸**
├── ops.js               ≤260  供应商 CRUD + 生命周期 + 端口释放
├── endpoint.js          ≤140  激活 + HTTP 端点启停
├── views.js             ≤200  status / listProviders / domainSummary
├── scheduler.js         ≤290  维护定时器 + 账号探测
├── forward-core.js      ≤120  门面（转发）
├── handlers/parse.js    ≤140  纯：URL/请求映射 + 用量解析 + 目标解析
├── handlers/forward.js  ≤330  IO：上游读取 + 重试 + 流式透传
├── store/usage.js       ≤160  用量账本（原子写，**.tmp 命名统一**）
├── model/inflight.js    ≤90   纯状态：在途计数 + 错误计数
├── router-ops.js        ≤100  门面（运维）
├── ops/browser.js       ≤140  图形环境 + 打开浏览器
├── ops/oauth.js         ≤190  OAuth 一键登录
├── ops/apps-registry.js ≤230  应用注册表与更新
├── ops/quotasync.js     ≤140  配额 + 单价同步
├── ops/admin.js         ≤200  账号/供应商管理辅助
├── policies/switch.js   ≤90   纯：选号策略 + 失败反应策略
├── policies/failure.js  ≤60   纯：失败反应（阈值）
├── switch.js            ≤110  编排
├── providers/base.js    ≤200  抽象契约 + 账号池 + 检测应用
├── providers/model.js   ≤180  账号模型 + 序列化
├── providers/policies/quota.js  ≤250  额度判定 + 响应分类
├── providers/policies/freeze.js ≤200  冻结/恢复策略
├── providers/store.js   ≤150  账号持久化
├── providers/command.js ≤140  命令拼装（纯）
├── providers/proxy.js   ≤330  实例进程治理 + 健康探测
├── providers/pool.js    ≤200  实例池策略（纯）
├── providers/restart.js ≤180  重启编排
├── providers/direct.js  ≤120  直连 provider
├── proxy-apps.js / port-segments.js  保留
└── daemon.js            ≤120  仅装配 + 启动（**文件名不变**）
```

**关键缺陷（设计中发现，须修）**：
1. **写权闸三处各查一半**：`index.js:144`（服务级）+ `store.js:43`（文件级）串起来，
   但 `forward-core.js:508` **只查服务级** → PG-7 反复复发的根因。**收敛为 store 内唯一闸**。
2. **用量文件读写散在 `forward-core.js:503-539`**，`.tmp` 命名与 `store.js:47` 不一致 → 收敛进 store。
3. **流式成功路径不补做延后重启**（真缺陷）：`writeThrough` 的 `decInflight`（`:331-337`）只做
   `_retryPendingStop`，不做 `flushRestartPending`；而 `_endInflight`（`:411-427`）两者都做。
   → 统一为单一 `end()` + 显式 effect。**此步是行为变更，必须独立提交 + 专项回归**。

### §5.2 relay（5 文件 → 12 文件）

```
relay/
├── index.js     ≤60   门面（**入口错位修正**：真入口是 manager.js）
├── core.js            纯（含 validateFrpExposure：消除与 app/facade/main.js 的重复闸）
├── session.js         会话桥
├── proxy.js           服务本体（来源闸/令牌闸/HTTP/WS/热更新面）
├── tunnel.js / managed.js / ports.js
├── ops.js             ← 原 manager.js（n 实例编排 + frp 策略）
├── frp.js / frp-install.js
├── daemon.js          **不变（214 行）**
└── port-segments.js   **不变（22 行）**
```

⚠ **不建 `store.js`**（本域无自有数据模型）。
⚠ **修正 DF-7 方向错误**：现 `manager.js → ./index`（编排依赖门面）；改 `ops.js → ./proxy`。
⚠ `daemon.js` **不得改名，也不得移动目录**（`probe.js:46` 是字面量 `/domains/relay/daemon.js`）。

### §5.3 instance（4 文件 → 8 文件）

```
instance/
├── index.js          ≤95   门面
├── model.js          ≤140  纯：模型 + 视图映射 + 序列化
├── sandbox.js        ≤85   纯：沙箱路径/目录推导
├── state-machine.js  ≤85   纯：4 个状态转移（deps 显式入参）
├── store.js          ≤100  持久化 + ensureDirs
├── lifecycle.js      ≤185  启停/监督（「怎么把单元跑起来」）
├── ops.js            ≤180  编排（「一次操作的顺序」）
└── upgrade.js        ≤330  沙箱 DSH 安装/检测/升级
```

⚠ **`core.js` 是误名**：397 行混 10 类（含 IO + 构造 + 视图），拆解后「剩下那个 class」是组装根，下沉 `index.js`。
⚠ **待修**：`core→upgrade` 两条反向边（`_readInstalledVersion` 越过编排层直接读盘、`_taskStateToView` 纯映射住在 upgrade）。
⚠ **迁移硬前置**：`test/instance-upgrade-test.js:36/41` 是实例 owner 打补丁，改成 index 闭包委托后
  patch 失效会**真跑** `systemctl --user daemon-reload` 与真 `mkdirSync` → 必须先改测试，且不可与结构步分离提交。

### §5.4 plugin（5 文件 → 14 文件）

```
plugin/
├── index.js         ≤70   门面（已是好样板，仅需删 :33 的 Object.assign）
├── model.js               纯：作业形状 + 状态迁移 + PROTECTED
├── policies.js            纯：判定
├── targets.js             目标解析
├── cli.js                 _runCli（无状态函数）
├── store.js         ~180  只读持久化 + 清单视图
├── layers.js        ~170  补丁层写 + 串行队列 + scrub
├── jobs.js                作业服务（对 ops **零出边** → 环物理消失）
├── restart.js / ops.js / updater.js
├── market.js        ~260  市场（**批次循环体不迁走**）
├── market-sources.js / market-net.js
```

⚠ **破环关键**：`ops ↔ jobs` 双向，且 `store → ops` 反向边。
  修法：作业模型进 `model.js`（纯）；互斥队列由 `jobs.js` 注入；`_runCli` 进 `cli.js`；
  `store.listInstalled(targets)` 改**收参**（不再 require targets）。
⚠ **证伪的「假 SSOT」注释**：`index.js:21`/`store.js:12` 声称「store 调 ops.install 作回调 → 拆 class 会循环」，
  但 `grep install store.js` = **0 次**。该论据是 `:33` `Object.assign` 的唯一理由，已证伪。

### §5.5 shell（4 文件 → 5 文件，**最接近达标**）

```
shell/
├── index.js     35   门面（**逐字不动**）
├── journal.js   ~110 账本/状态机/health
├── restart.js   ~157 更新检测 + 重启
├── watchdog.js  ~185 壳看护（纯决策 ↔ 有状态看护，**只有这一刀**）
└── core.js      ~95  **新增**：零 require 汇点（DEFAULTS/isShellProcess/decide/exeFromCmdline）
```

⚠ **不建 `scheduler.js`**：watchdog 是「被外部定时器驱动的可重入状态机」，不是周期任务
  （域内 `setInterval` = 0；定时器在 app 层）。建 scheduler 会造第二驱动源、破坏 busy 门闸。
⚠ **删 `restart.js → watchdog` 边**（下游流程依赖上游谓词，方向反序）→ `isShellProcess` 下沉 `core.js`。

### §5.6 app（53 文件 → **10 个切面** + domain-actions）

| 切面 | 内容 |
|---|---|
| F1 组装 | `assembly/{compose,bootstrap,api-rebind,log-sources}` |
| F2 会话 | `session/{machine,shutdown}` |
| F3 Main 主收敛 | `main/{decide,controller}` |
| F4 MainMeta 元数据 | `main/{process,signals,health-gate,shadow}` |
| F5 Daemon 进程 | `daemons/{process,supervise,runtime,identity,probe}` |
| F6 ManagedObject 目录 | `control/{registry,entry,specs}` |
| F7 ModuleLifecycle 视图 | `control/{manager,adapters,projection}` |
| F8 State 基座 | `state/{store,fields,main-store,desired,upgrade-hold,intents}`（**重切，不合并**） |
| F9 DomainFacade | `facade/*`（**只读**）+ `domain-actions/*`（**写动作**） |
| F10 Settings | `settings/*` |

⚠ **`this` 调用图 4 个 SCC**（须消解）：
  ① `state/store ↔ state/fields ↔ control/specs`（把 `_dshEntry`/`_mainFallbackEntry`/`_persistCrashField`
     从 `specs.js:132-160` 搬回 `state/main-record.js` 即断）；
  ② `main/process ↔ main/health-gate`（health-gate 改**返回决策**，由 controller 执行）；
  ③ `daemons/runtime ↔ facade/main`（`lan-state.sync` 的 mainView 改注入）；
  ④ `facade/router ↔ ctl/facades`（改 ctor 注入谓词）。
⚠ **原型 Object.assign 分两级收口**：
  级 1（必做）= 37 模块改 class/具名函数 + 只留 **1 个 ≤150 行 `app/facade.js` 兼容门面**；
  级 2（按切面）= 对有状态/协作的 5 切面 ctor 注入。
  代价如实：api 42 成员加一层转发、**测试 ~50 处调用点要改**（主要成本）。

## §6 裁决汇总（R1–R12）

| 编号 | 裁决 |
|---|---|
| **R1** | DF-5 真实含义 = 禁把两文件方法合并到同一 this（**不是**修 require 环）；扫描须先剥注释 |
| **R2** | 子目录白名单放宽为：`providers instances policies model store handlers core jobs` |
| **R3** | 阈值取严：门面 **≤150**、单文件 **≤300**（同步改 DS-9） |
| **R4→R6** | mixin 判据替换为 R6 三件套（右值不限 + 分片导出 + 反自检含变量样本），**先剥注释** |
| **R5** | `daemon.js` 文件名**不得改**（5 处 cmdline 匹配依赖） |
| **R7** | `app/facade/**` **只读**；写动作下沉 `app/domain-actions/` |
| **R8** | `domain-actions/` 建为 **app 子目录**（不并入各域 ops，因写动作需跨域编排） |
| **R9** | `api/deps.js` 本轮**只声明不强制**（另起一轮收紧） |
| **R10** | `test/directory-structure-gate-test.js` 的 ALLOWED **本轮同步改** |
| **R11** | `DIRECTORY-STRUCTURE-DESIGN.md` 的 DS-9 更新为严值 |
| **R12** | 门禁 ② 补 UMD 简写分支（`app/state/fields.js` 是 46 个 helper 的载体）；**② 只告警，① 才硬失败** |

## §7 迁移顺序（先门禁后重构）

| 批 | 内容 | 风险 |
|---|---|---|
| **0** | 立 `test/domain-structure-gate-test.js`（**report-only**，记录 RED 基线） | 低 |
| 1 | shell（最接近达标，验证方法论） | 低 |
| 2 | plugin（破环示范：model/cli/jobs 三层断链） | 中 |
| 3 | instance（含迁移硬前置：先改测试） | 中高 |
| 4 | relay（入口错位修正） | 中 |
| 5 | router-ops / router-forward（先纯后 IO） | 中 |
| 6 | router-facade（门面纯化 + 写权闸单源） | 高 |
| 7 | router-providers（最大文件） | 高 |
| 8 | app 级 1（停跨文件挂原型 + 兼容门面） | **最高**（测试 ~50 处改） |
| 9 | app 级 2（按切面 ctor 注入） | 高 |
| 10 | 门禁转硬失败 + 删除兼容门面 | 中 |

⚠ **每批必须**：先 `node --check` → require 加载 → 再提交（推送后相关测试一律由 CI 裁决，本机不得跑测试）。
⚠ **行为变更步**（如 router 的 inflight 统一）**必须独立提交**，不与纯结构步混。

## §8 迁移时必须同步改的既有门禁（★ 静默失效面）

> 这些测试把断言**钉在源码内容上**，方法一搬家园禁就静默失效或误报 FAIL。

| 门禁 | 断言对象 | 迁移后须改指向 |
|---|---|---|
| `round13-robustness-batch-test.js:151-152` | index.js 含 `canPersist()` | store.js |
| `provider-gateway-gate-test.js:203-211` | forward-core.js 的 `_writeTotals` 含 `canPersist()` | store/usage.js |
| `kernel-daemon-contract-test.js:78-79` | index.js 含 `stateDir` | store.js |
| `round13-router-relay-gaps-test.js:119-127` | index.js 含 `removed.stopInstance(i,true)` | ops.js |
| `relay-source-gate-test.js:45-88` | 注释串 `api/identity` | ⚠ 注释一精简即失败 |
| `native-dsh-binding-test.js:110` | `target.runtime` 在 ops.js | targets.js |
| `round13-discipline-gaps-test.js:87,90` | `pm._bundleOpQueue` | layers.js |
| `instance-safety-test.js:92` | `_prepareSystemd(){...}` 函数体正则 | 形态一变即失效 |
| `instance-upgrade-test.js:36,41` | owner 打补丁（**迁移硬前置**） | 必须先改 |
| `platform-capability-audit-test.js:141` | 只读 watchdog.js | — |

## §9 门禁清单（供 `test/domain-structure-gate-test.js`）

| 编号 | 判据 | 来源 |
|---|---|---|
| DG-1 | 门面 ≤150 行 | DF-1 |
| DG-2 | 单文件 ≤300 行 | DF-2 |
| DG-3 | 纯模块不得 require `node:fs`/`node:net`/`node:child_process` | DF-3 |
| DG-4 | 域内跨文件 `this` 调用 = 0（**须排除 extends 与已声明抽象占位**） | DF-4 |
| DG-5 | 域内 require 图无环 | DF-5 |
| DG-6 | 叶子模块可 require 且不构造域对象 | DF-6 |
| DG-7 | 依赖单向（不得 index 被 ops 依赖） | DF-7 |
| DG-8 | 无 `Object.(defineProperties\|assign)(X.prototype, ...)`（**先剥注释**） | R6 |
| DG-9 | `app/facade/**` 无写副作用 | R7 |
| DG-10 | 域间契约：`plugin` 不得直接遍历 `instances.instances` 数组 | §5 契约 |
| DG-11 | 判据**不得硬编码行号** | 实测行号漂移逼出 |
| DG-12 | 子目录仅白名单内 | R2 |
| DG-13 | `daemon.js` basename 存在（5 处 cmdline 匹配） | R5 |
| DG-14 | 写权闸单源（router） | 缺陷 1 |
| DG-15 | 函数体内**无内联 `require()`**（先剥注释；唯一显式白名单 `src/supervisor.js` 的 `get lan()`） | DF-8 |
| DG-16 | **函数（回调/闭包）嵌套深度 ≤6**（按函数体花括号计数，非原始净值） | DF-9 |

**每条必须有反向自检**（构造违规样本验证判据能命中，防空转）。

## §10 域间契约（要点）

- 五域 Public API 与 Dependencies 用**端口**表达（`InstanceTargetPort`/`InstanceSource`/`InstanceHooks`）；
- **`plugin` 遍历 `instances.instances` 数组、调 `probeInstance`/`stopInstance`** → 改为 instances 提供的查询接口；
- ⚠ **伪耦合澄清**：任务书所称「router 调 `instances.sandboxRoot`」**不存在** ——
  `sandboxRoot` 全域仅 3 个消费者（`app/control/specs.js:47`、`instance/core.js:190` 定义、`instance/ops.js:205`）；
  router 里的 `this.instances` 是 **ProxyInstance**（router 自有模型），**同形不同物**。门禁需排除规则。
- ⚠ **合法继承豁免**：`{providers/base, providers/proxy}` 的互相调用**不是隐式耦合** ——
  `base.js:243-253` 的 11 个方法是**抽象契约占位**（抛 'must be implemented by process-pool provider'），
  朴素判据会误报 12 处。
