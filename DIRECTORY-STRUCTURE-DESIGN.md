# 目录结构与分层设计（DIRECTORY-STRUCTURE-DESIGN）

> **本文件是「代码如何分层、文件放哪里」的唯一事实源（SSOT）**，2026-09-16 立。
> 由四路审计（platform+api / guard / domains / 跨层耦合）+ 三路设计（顶层+platform / guard重组 / domains+api）
> 交叉验证后**定版**。所有数字与路径均来自实测（require 静态扫描 + grep + wc）。

---

## §1 为什么要重构（审计实证）

| # | 问题 | 实证 |
|---|---|---|
| 1 | **编排层没有层归属** | `src/supervisor.js`（1319 行 / 38 require）在 `src/` 根，其方法体又被拆成 `guard/supervisor/` 下 6 个 mixin（2473 行）——"类在根、方法在 guard"的撕裂 |
| 2 | **6 个 mixin 不是分层，是同一 `this` 的文本切块** | 三个都 `module.exports = _desc`（属性描述符）；**65 处 `this.X()` 跨分片私调**（converge 21 / supervise 16 / main 10 / control 9 / registry 6 / settings 3）并成环 |
| 3 | **guard/ 目录名与职责系统性错位** | `lifecycle/` 实为 registry+调度器+存储；`supervisor/` 实为 root 的分片；`native/` 一半是命令拼装（48 行）一半是安装器（806 行）；`proc/` 与 `lifecycle/` 语义重叠却互不引用；`health.js`/`host-service.js` 是平铺薄壳 |
| 4 | **platform/ 根是"抽象层级混合"的平铺区** | 14 个平铺文件里纯函数 / IO 原语 / 有状态服务混放；而 `net/` 仅 2 个 60 行文件也成目录 |
| 5 | **platform 渗入域知识** | `loghub` 硬编码三源（guard/router-daemon/lan-daemon）；`ports` 硬编码业务角色（relay/proxyInstance/oauthCallback/providerApi）；`srcpath` 固化 domains 路径；`config` 带 `routerCtlPort/routerAutostart` 业务键 |
| 6 | **api/ 职责混杂 + 定义被反向依赖** | `api/index.js`（408 行）同时含安全模型 + 传输 + 静态托管 + UI 目录探测；`api/identity.js` 是平台事实却被 `domains/relay` 反向依赖 |
| 7 | **六域结构极不对称** | 只有 `router` 有子目录；`instance`(1181) / `plugin`(1001) / `dist`(740) 单文件承载 7–8 类职责；`plugin` 无 `index.js` |
| 8 | **跨域依赖集中在两件事** | **9 个文件** require `domains/dist` 只为 `semverCompare`（实测真实消费者 **7** 个）；`relay/daemon` → `router/ctl`（通用 dispatcher 寄居 router 域） |
| 9 | **反向/越层边** | `domains→api`（relay→identity）、`domains→guard`（instance→guardian）、`guard→domains`（native/settings→dist） |
| 10 | **api→domains 完全隐藏** | 13 个 api 文件零 require domains，但经注入的 `sup` 调 40+ 个域方法，**无任何接口声明** |
| 11 | **制度缺口**：跨域依赖从未被检查 | 门禁 `layerOf()` 把整个 `domains/` 视为**一个层** → `domains→domains` 的边被直接跳过（这是 #8 长期存在的制度原因） |

---

## §2 五层定义（定版）

```
L0  src/shared/       纯函数/常量：无状态、无 IO、无平台分支、无域知识
L0  src/platform/     平台事实：OS/进程/网络/HTTP身份/端口/令牌/日志/契约读取/分发
L1  src/domains/      业务域：router relay instance plugin shell
L2  src/app/          编排层：组装根 + 业务主体（原 supervisor.js + guard/**）
L3  src/api/          传输契约面：HTTP 网关 + 每域 handle
L4  src/supervisor.js 进程入口（薄壳：加载配置 → 组装 → 启动 API）
```

### 2.1 关键裁决：**`guard/` → `src/app/`**

**决策**：编排层命名为 **`src/app/`**，原 `guard/` 全部并入。

**理由**：`guard`（守护）是**业务词**，不是**分层词**。当前"类在根、方法在 guard"撕裂的根因，正是**编排层从来没有自己的名字**——它被叫成"守卫(supervisor)"这个业务角色，于是"组装根"与"业务主体"被迫挤在同一个类里。

**裁决依据**：设计2 的 `guard/{assembly,session,state,self,control,main,daemons,ctl,native,settings,facade,audit}/` 与设计1 的 `app/` **内容完全同构**，可零改结构平移——只换顶层目录名。

### 2.2 依赖方向矩阵（硬约束）

| from / to | shared | platform | domains | app | api |
|---|---|---|---|---|---|
| **shared** | ✓ | ✗ | ✗ | ✗ | ✗ |
| **platform** | ✓ | ✓ | ✗ | ✗ | ✗ |
| **domains** | ✓ | ✓ | ✓(同域内) | ✗ | ✗ |
| **app** | ✓ | ✓ | ✓ | ✓ | ✗ |
| **api** | ✓ | ✓ | ✗ | ✗(经注入) | ✓ |

**本次消除的违规边**（逐条）：

| 边 | 消除方式 |
|---|---|
| `domains→api`（relay→identity） | `api/identity.js` 拆：纯 IP 事实 → `shared/ip.js`；HTTP 身份 → `platform/security/identity.js` |
| `domains→guard`（instance→guardian） | guardian 实测**纯函数、零 require**（47 行）→ 上移 `shared/guardian.js` |
| `guard→domains`（native/settings→dist） | 只因 `semverCompare` → 上移 `shared/version.js`；dist 域解体 |
| `relay→router`（ctl dispatcher） | 通用 dispatcher 上移 `platform/ctl/` |
| `platform→root`（deploy→core.cjs） | 仅注释；deploy 只查结构 → 0 边 |
| `domains→domains`（7 条） | 5 条 dist（semver 上移）+ 1 条 ctl + 1 条随 dist 解体，**全部归零** |

---

## §3 完整目录树（定版）

```
src/
├── supervisor.js               进程入口（≤120 行）：config → app.assemble() → api.createServer()
│
├── shared/                     【L0 纯函数】零依赖、零 IO
│   ├── version.js              semverCompare + VERSION_RE   ← domains/dist/index.js:36-116
│   ├── ip.js                   isLoopbackAddress/isPrivateIpv4/normalizeRemoteAddress ← api/identity.js
│   └── guardian.js             shouldGuard/bumpCrashWindow/instanceRestartDecision ← guard/guardian/
│
├── platform/                   【L0 平台事实】
│   ├── util/        无状态纯转换
│   │   ├── exec.js             ← platform/exec.js
│   │   ├── fs.js               ← platform/fs-utils.js
│   │   ├── srcpath.js          ← platform/srcpath.js（只做 resolve(relPath)，去掉域路径常量）
│   │   └── probe.js            ← platform/net/probe.js
│   ├── contract/    外部既定事实（只读）
│   │   ├── matrix.js           ← platform/matrix.js
│   │   ├── deploy.js           ← platform/deploy.js
│   │   ├── registry.js         ← platform/registry-contract.js
│   │   └── runtime.js          ← platform/runtime-contract.js
│   ├── service/     有状态/生命周期/IO 且被多方共享
│   │   ├── config.js           ← platform/config.js（去掉业务键）
│   │   ├── state-root.js       ← platform/state-root.js
│   │   ├── install-id.js       ← platform/install-id.js
│   │   ├── tasks.js            ← platform/tasks.js
│   │   ├── env-catalog.js      ← platform/env-catalog.js
│   │   ├── monitor.js          ← platform/net/monitor.js
│   │   ├── log/                ← log.js / events.js / logcore.js / loghub.js
│   │   ├── ports/              ← platform/ports/index.js
│   │   └── token/              ← platform/token/**
│   ├── os/                     （11 个 .js + autostart/ + pidlookup/）
│   ├── ctl/          ← domains/router/ctl.js（通用 dispatcher，白名单按域注入）
│   ├── distribution/ ← domains/dist/index.js（DistributionManager）
│   └── security/     ← api/identity.js 的 HTTP 身份部分
│
├── domains/                    【L1 业务域】
│   ├── router/                 providers/ handlers/ model/ ops/ store/ policies/ + index/daemon/endpoint/forward-core/switch/views/router-ops/scheduler/proxy-apps/port-segments/ports-bootstrap/config/contract
│   ├── relay/                  ops/ + index/core/daemon/frp/frp-install/managed/ops/proxy/session/tunnel/ports/port-segments/contract
│   ├── instance/               ops/ + index/lifecycle/ops/model/sandbox/state-machine/store/upgrade/contract
│   ├── plugin/                 index/ops/store/market
│   └── shell/                  index/journal/restart/watchdog
│   （dist 域【解体】：semver→shared、DistributionManager→platform/distribution）
│
├── app/                        【L2 编排层】原 guard/** 平移
│   ├── assembly/     api-rebind / bootstrap / collaborators / compose / facets / log-sources
│   ├── session/      machine / shutdown
│   ├── state/        store / fields / field-tables / main-store / main-record / desired / phase / upgrade-hold / intents / collaborator
│   ├── self/         lifecycle / health / notify
│   ├── control/      registry / entry / manager / adapters / scheduler / specs / instance-adapter / projection
│   ├── main/         decide / process / signals / controller / health-gate / shadow
│   ├── daemons/      process / supervise / runtime / identity / probe / scripts
│   ├── ctl/          client / facades
│   ├── native/       command / installer / manifest / npm / ops / policies / probe / upgrade
│   ├── settings/     env / node-lts / versions / autostart / access / lan-panel
│   └── facade/       status / main / router / lan / ports
│
└── api/                        【L3 传输契约】
    ├── index.js                薄网关（≤180）：createServer + 门卫 + 分派 + 异常边界
    ├── router-table.js         ← index.js 的 API_DOMAINS 注册表
    ├── security.js             ← index.js 的 originAllowed/isLocalOrLanHost/isShellOrigin/isLoopbackHost
    ├── static.js               ← index.js 的 UI 目录解析 + MIME + CSP + serveStatic
    ├── contract.js             ← surface.js（API 契约面元数据）
    ├── deps.js                 显式声明每域所需 sup 成员（解决 40+ 方法无接口）
    ├── identity.js             shim（re-export shared/ip + platform/security）
    └── domains/                lifecycle/guard/native/instances/plugins/dist/router/relay/shell/tasks
```

---

## §4 核心设计决策

### 4.1 六个 mixin 如何真正解体（不是改名）

```
现状（病态）：Supervisor.prototype ← Object.defineProperties ← 6 个 _desc（互相 this.X() 私调 65 处）
目标（健康）：每个模块导出 class 或纯函数，ctor 注入具名协作者：
  MainController   ← { StateStore, SessionMachine, MainProcess, Policy, Events, Logger, Clock }
  MainProcess      ← { StateStore, NativeCommand, Signals, Notifier, Events }
  DaemonSupervisor ← { DaemonProcess, Runtime, Identity, Probe, CtlClient, Registry }
```

**关键手法**：`converge-view` 的决策函数提升为**纯函数**（入参 `s` 显式化）→ 无 `this` → 65 处跨分片调用塌缩为普通 `require` 向下，**环自动消失**。

### 4.2 阻止域知识渗入 platform（四处实证泄漏 → 反转法）

| 泄漏 | 反转设计 |
|---|---|
| `loghub` 硬编码三源 | 平台只留 `registerSource(name)`；三源在 `app/assembly` 启动时注入 |
| `ports` 硬编码角色名 | 平台只留 pools + 分配算法；`registerSegment(role,pool)` 由各域装配期申报 |
| `srcpath` 固化域路径 | srcpath 只做 `resolve(relPath)`；router/lan→脚本映射移到 `app/daemons/scripts.js` |
| `config` 带业务键 | 平台只管状态根/日志/端口池；业务键由 `app/settings` 声明 |

### 4.3 version 的归属裁决

| 内容 | 位置 | 理由 |
|---|---|---|
| `semverCompare` + `VERSION_RE` | **`shared/version.js`** | 纯算法（唯一消费者 7 个，跨 3 层）；放 platform 会污染 `*→platform` 的登记语义 |
| 守卫版本自报 | **保留 `platform/service/version.js`** | 实测与 semver **无关**（读 package.json / `__DSH_VERSION__`）；两者必须分开 |
| `pickReleaseVersion` 等选版策略 | `platform/distribution/release.js` | 与 DistributionManager 同生共死，消费者仅 root/router-daemon |

### 4.4 ctl 成对

| 部分 | 位置 | 性质 |
|---|---|---|
| dispatcher（server 端，白名单按域注入） | `platform/ctl/server.js` | 通用基础设施 |
| 调用方（client 端，门面） | `app/ctl/client.js` | 编排层使用 |

### 4.5 域内结构规范（六域统一）

```
domains/<domain>/
├── index.js      门面（组合+导出）≤150 行
├── core.js       纯状态/算法（可选）
├── ops.js        编排/IO 副作用（可选）
├── store.js      持久化（可选）
├── daemon.js     独立进程入口（仅 router/relay）
├── providers/    可替换策略（仅 router）
└── instances/    运行期对象（仅 router）
```

**硬规则**：每域**必须**有 `index.js`；域内子目录**只允许** `providers/`/`instances/`；单文件 **≤300 行**、`index.js` **≤150 行**。

> ⚠ **2026-09-17 取严（R3/R11）**：原值「单文件 ≤450 / `index.js` ≤200」已被主代理裁决**收紧**为
> 「**门面 ≤150 行 / 单文件 ≤300 行**」，与域内 SSOT `DOMAIN-STRUCTURE-DESIGN.md` §2 的
> **DF-1（门面 ≤150）/ DF-2（单文件 ≤300）** 逐字一致。本文件与域内 SSOT 不允许存在两套阈值。

---

## §5 不变量与门禁

### 5.1 不变量

| # | 不变量 |
|---|---|
| **DS-1** | `shared/` 出度 = 0；`platform/` 不得依赖 domains/app/api |
| **DS-2** | **`domains` 之间横向 require = 0**（本次归零 7 条） |
| **DS-3** | `app` 不得 require api；api 不得 require app/domains（只消费注入的 facade） |
| **DS-4** | `process.platform`/`arch` 只允许出现在 `platform/` |
| **DS-5** | platform 源码（去注释）不得出现域名词（router/lan/relay/instance/plugin/frpc/proxyInstance/dsh-main） |
| **DS-6** | 层内 require 图无环（单位 = 路径前 3 段，SCC 检测） |
| **DS-7** | 禁止把外部方法集挂到原型：`Object.defineProperties(X.prototype, ...)` **与** `Object.assign(X.prototype, ...)` 均禁（右值不限；先剥注释，见 R6 与 DS-G3） |
| **DS-8** | 每域必须有 `index.js`；域内子目录仅 `providers/`/`instances/` |
| **DS-9** | 单文件 **≤300 行**、`index.js` **≤150 行**（R11 取严，= DF-1/DF-2） |
| **DS-10** | 硬编码路径归零：daemon 脚本位置唯一来源 `platform/util/srcpath.DAEMON_REL`，cmdline 匹配由它派生 |
| **DS-11** | daemon 入口**保留 basename `daemon.js`**（只改目录）——否则同时打断 5 处 cmdline 匹配 |
| **DS-12** | 命名按职责/主体，禁止 `*-view`/`*-mixin`/`*-part` 等"从哪切出来"的名字 |

### 5.2 门禁升级（**必须**改 `layering-and-dependency-gate-test.js`）

**制度缺口修复（最关键）**：现 `layerOf()` 把 `domains/` 视为一个层 → 跨域边被跳过。

```
现在：layerOf('src/domains/router/index.js') === 'domains'   ← 六域同层，跨域边不检查
改为：layerOf(...) === 'domains/router'                      ← 域粒度，跨域边可见
```

新增门禁：

| 门禁 | 断言 |
|---|---|
| **DS-G1** | `layerOf` 细分到域粒度；`domains→domains`（跨域）必须为 0 |
| **DS-G2** | `shared/` 出度 = 0；platform 无上层入边 |
| **DS-G3** | 无 `Object.defineProperties(X.prototype, ...)` **且**无 `Object.assign(X.prototype, ...)`（右值不限：内联 require / 变量 / 分片 `mod.methods` 一律硬失败；**须先剥注释**，见 R6） |
| **DS-G4** | platform 源码无域名词（白名单：产品身份常量） |
| **DS-G5** | 层内 SCC 无环（单位 = 前 3 段） |
| **DS-G6** | 每域有 index.js；域内子目录白名单 |
| **DS-G7** | `src/supervisor.js` ≤200 行；不含 `setInterval`/`writeState`/`_mSet` |
| **DS-G8** | 反向：判据能识别旧形态（门禁非空转） |

---

## §6 迁移计划（分步可验证，每步后门禁必须仍绿）

| 步 | 内容 | 影响 | 风险 |
|---|---|---|---|
| **1** | 建 `shared/`（version/ip/guardian）+ 门禁加 shared 层 | 8+3+3 require | 低 |
| **2** | `api/identity` 拆 `shared/ip` + `platform/security`；relay 改指向 | 3 require + 2 test | 低 |
| **3** | `DistributionManager` 上移 `platform/distribution`；**dist 域解体** | 4 require + 1 门禁源码串 | **中**（收益最高：同时灭 guard→domains 与 router→dist） |
| **4** | ctl dispatcher 上移 `platform/ctl` | 3 require | 低 |
| **5** | platform 17 平铺文件按 util/contract/service 归位 | **86 个 require / 40 文件** | 中（量大但机械） |
| **6** | guard → `app/` 平移 + 6 mixin 解体 | 约 7000 行移动 / 65 处私调重写 | **高**（核心） |
| **7** | `src/supervisor.js` 降为薄壳（1319 → ≤120） | 63 行路径字面量 / 32 文件 | 中 |
| **8** | 六域内部拆分（逐域一步） | 域内约 12 require | 中 |
| **9** | api/ 拆分 + `api/domains/` + surface→contract | 11 内部 require + 10 新 | 中 |
| **10** | 门禁升级（DS-G1..G8）+ 文档同步 | 66/131 test 需改路径 | 中 |

**必须同步的硬编码路径**（否则静默失效）：
`platform/util/srcpath.DAEMON_REL`、`app/daemons/` 的 cmdline 匹配、`test/{layering,api-surface,provider-gateway,relay-source-gate,srcpath-gate,round8-fixes,platform-capability-audit,arch-validation}` 等 8+ 个门禁。

---

## §7 决策记录

| # | 决策 | 状态 |
|---|---|---|
| D1 | 编排层命名 **`src/app/`**（非"guard 归 L4"） | ✅ 定版 |
| D2 | `semverCompare` → `shared/version.js`；守卫版本自报 → `platform/service/version.js` | ✅ 定版（实测两者无关） |
| D3 | ctl **成对**：dispatcher → `platform/ctl/`；client → `app/ctl/` | ✅ 定版 |
| D4 | `dist` 域**解体**（DistributionManager → platform/distribution） | ✅ 定版 |
| D5 | 新增 `src/shared/` 层（与 platform 并列 L0） | ✅ 定版 |
| D6 | `api/identity` 拆两半（纯 IP → shared；HTTP 身份 → platform/security） | ✅ 定版 |
| D7 | `platform/` 分 `util/ contract/ service/` 三目录（+ os/ctl/distribution/security） | ✅ 定版 |
| D8 | 门禁 `layerOf` **细分到域粒度**（修复跨域边从不检查的制度缺口） | ✅ 定版 |
| D9 | daemon 入口保留 basename `daemon.js` | ✅ 定版 |
| D10 | 六域统一结构（index/core/ops/store + 仅 providers//instances/） | ✅ 定版 |
