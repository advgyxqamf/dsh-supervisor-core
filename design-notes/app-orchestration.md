# app/ 编排层 功能设计（域化）

> 范围：`src/app/**`（12 个子目录 / **53 个 .js** / **6666 行**）——当前内核**最大的一层**。
> 依据：`DOMAIN-DESIGN-BRIEF.md` §1–§7、`DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）、`design-notes/_RULING.md`（**R1–R5 覆盖 BRIEF 相应表述**）。
> **只做设计：未改动任何 `src/` 代码，未 commit，未启动任何守卫进程。**
> 取证方式：`read` 逐文件精读 + **去注释**静态扫描（require / `this.X()` / Tarjan SCC）+ 纯函数统计 + `require('./src/supervisor')`（**只读原型，不 new、不 start、不落盘**）。
> 所有「文件:行号」均来自本轮实际 `read`；行数来自 `wc -l`。

---

## 前置：本文遵循的 7 条裁决

| 裁决 | 对本文的影响 |
|---|---|
| **R1** | app 的 require 图**实测 0 环**（剥注释 + Tarjan，53 文件）。真病症是 **this 调用图 4 个 SCC**。DF-5 在本层的含义 = **禁止把两个文件的方法合并到同一 this**（`Object.assign(Supervisor.prototype, mod.methods)`，`src/supervisor.js:159-172`）。 |
| **R2** | 目标结构**优先扁平文件**；子目录白名单已放宽为 `providers instances policies model store handlers core jobs`，但 app 各切面内**不建子目录**（每切面文件数 ≤10 且职责不同）。 |
| **R3** | 门面 `index.js ≤150 行`；任何单文件 `≤400 行`。§C 的每个新文件都按此校验。 |
| **R4（已被 R6 修正）** | §H 的 DF-G3 **必须同时禁 `Object.assign(X.prototype, ...)`**。本文原指出 R4 的正则**抓不到 app 现状**；R6 已确认该假阴性/假阳性，并把判据固定为**三条组合 + 先剥注释**（见 H.1）。 |
| **R5** | 本文不动 `daemon.js`（不在 app 范围内；§C 的 `app/daemons/*` 只做**内部**拆分，不改任何被 cmdline 匹配的文件名）。 |
| **R6** | DF-G3 判据最终形态 = ①`MIXIN_INTO_PROTOTYPE`（任意右值）②`METHODS_FRAGMENT`（分片导出）③反向自检必须含 `Object.assign(X.prototype, mod.methods)` 样本；**扫描前必须先剥注释**（否则 `src/supervisor.js:21` 的说明性注释会造成假阳性、而 160 行的真实注入被漏掉）。H.1 已按此定稿。 |
| **R7** | **门面只允许只读视图**；写动作下沉 `app/domain-actions/`。本文 §B.2/§C.1 的裁决与此一致，R7 将其**升级为强制不变量**（新增 DF-G13 门禁，H.2/H.5）。 |

---

## A. 现状审计

### A.1 文件清单与职责（逐文件）

> 行数 = 实测 `wc -l`；「this()」= 该文件内 `this.X()` 出现次数；「跨文件」= 其中解析到**别的文件**定义的方法（实测）。

| # | 文件 | 行 | this() | 跨文件 | 当前职责 | 问题 |
|--:|---|--:|--:|--:|---|---|
| 1 | assembly/compose.js | 366 | 0 | 0 | 构造期组装全部子系统并接线 host；数据目录保护；唯一 DI 发生地 | 366 行偏高；**把 40+ 个 host 字段逐个手写初始化**（79-147）；host 就是 Supervisor 实例 |
| 2 | assembly/bootstrap.js | 218 | 0 | 0 | 启动序列：markStarted→首拍→**唯一心跳**→lan/router 拉起→看护定时器 | 单函数 135 行；心跳/定时器/域拉起/看护**四类副作用同文件** |
| 3 | assembly/api-rebind.js | 91 | 0 | 0 | API 监听重绑 + 启动（createServer 注入，避免 app→api） | **健康**（依赖注入正确、无 this） |
| 4 | assembly/log-sources.js | 34 | 0 | 0 | 日志源名单注入（DS-G4 反转法） | **健康**（require 即注入，纯声明） |
| 5 | session/machine.js | 46 | 0 | 0 | 会话态 sessionState/_setSessionState/_sessionHalting/_shouldRun | host-first 自由函数——**已是合法形态**，但导出/装配靠 supervisor.js:143-151 的硬编码 Set |
| 6 | session/shutdown.js | 129 | 0 | 0 | 关停编排：shutdown/shutdownAll/_stopMainDsh/_stopAllSandboxes | host-first；shutdown 清 **7 个定时器字段**（26-32）→ 定时器所有权散落 |
| 7 | state/store.js | 124 | 16 | 7 | _mStore/_mField/_mProcField/writeState/loadState/_migrateMainRecord | 与 fields.js **成环**（A.2b）；loadState 读 state.json 又依赖 managedObjects._loadedFromDisk（75）→ 存储层反向知道 registry |
| 8 | state/fields.js | 206 | 39 | **25** | 字段生成器（38-83）+ 兼容访问器（85-125）+ phase/desired/guardian 读写（127-198） | **域内最大 this 扇出**（扇入 56）；生成器与有状态读写混装；字段表是纯数据却与 IO 同文件 |
| 9 | state/main-store.js | 81 | 5 | 5 | dsh-main.json 读写 + _registryFileName | 与 facade/main.js、control/specs.js 交叉 |
| 10 | state/desired.js | 72 | 0 | 0 | setDesired/requestRestart/persistConfigPatch（host-first） | **意图/配置持久化混装**；persistConfigPatch 是通用配置写却住 state |
| 11 | state/upgrade-hold.js | 70 | 0 | 0 | 升级 hold 进入/退出/超时等待（host-first） | 属**升级生命周期**，与 state 无关（错位） |
| 12 | state/intents.js | 67 | 0 | 0 | IntentLedger（纯类，ctor 只有 Map） | **健康**（唯一零 this、可独立单测的 state 模块） |
| 13 | control/registry.js | 443 | 29 | 12 | ManagedRegistry + 词表 + createEntry + 持久化 + CRUD + 端口联动 + **心跳循环** + 观测/相位 | **文件最大**；6 类职责；443 行超 R3；heartbeat 带 setTimeout/_withTimeout 混入纯目录 CRUD |
| 14 | control/entry.js | 241 | 24 | 0 | ManagedLifecycle（单模块生命周期状态机） | **健康**（class + ctor 注入 + 自我包含） |
| 15 | control/manager.js | 124 | 4 | 0 | LifecycleManager 注册表 + 统一启停 | **健康** |
| 16 | control/adapters.js | 160 | 0 | 0 | 把各模块包装成 ManagedLifecycle（registerAll） | 硬编码 role→kind 映射；无 this，较好 |
| 17 | control/specs.js | 163 | 12 | 5 | 受管对象申报 + **_dshEntry/_mainFallbackEntry/_persistCrashField** | 后三个是**存储/目录内部口**，错住在申报模块 → 制造 fields↔store↔specs 环 |
| 18 | control/projection.js | 118 | 4 | 4 | 把观测投到 lifecycleManager 的 dsh/router/instances 项 | 视图职责尚可；但读 3 个 state 方法 |
| 19 | control/scheduler.js | 46 | 9 | 4 | tick 别名 + _dshSuperviseOnce（心跳拍：收敛+视图+影子+孤儿审计+eventHub.sync） | **一拍编排五件事**；派生态 |
| 20 | control/instance-adapter.js | 55 | 5 | 3 | 沙箱单实例监督拍 + 目录同步 | 尚可；依赖 specs 三方法 |
| 21 | main/controller.js | 226 | 80 | 44 | _dshConverge（主收敛：探测/期望/升级/重启/相位 switch/收尾） | **单方法 208 行**；this 扇出全域第一（19 处 state + 13 处 process） |
| 22 | main/decide.js | 113 | 28 | 2 | _mainStateSnapshot + _decideMainAction（**纯决策**）+ _decideCrashRestart | 决策是纯函数（好），但读 this._mPhase() 等 → 快照与决策同文件 |
| 23 | main/process.js | 311 | 117 | 43 | spawnCommand/_startProcess/_enterRunning/_findManagedDshPort/_applyMainPort/_adoptObserved/_adopt/_beginRestart/stopProcess | 9 个进程治理方法；**this 调用密度全域最高**（117）；含端口再推导（平台知识） |
| 24 | main/signals.js | 90 | 3 | 5 | _isManagedProcess/_signalChild/_killTree/_killSequence/_killAdopted | 属**进程信号**（跨 main/daemon 通用），却挂在 main 状态机（错位） |
| 25 | main/shadow.js | 120 | 9 | 4 | G1 影子记账 | 影子观测是**临时框架**（G3 后应删）；与主循环强耦合 |
| 26 | main/health-gate.js | 51 | 15 | 2 | _bumpCrashWindow（退避）+ _applyHealthCheck（假死） | 双职责同族；调 _beginRestart → **health-gate ↔ process 环** |
| 27 | daemons/process.js | 353 | 29 | 0 | DaemonLifecycle（身份锁/换代/latch/spawn/classify/stop） | **最健康**：class + ctor 注入 + 顶层纯 helper |
| 28 | daemons/runtime.js | 203 | 22 | 14 | 生命周期实例工厂 + ensure 翻译 + lan-state 同步 + _ensureLanRuntime/_ensureRouterRuntime/_disableRouterPersist/_warnOccupied | **4 类职责同文件**；读 dshMainView（跨到 facade） |
| 29 | daemons/supervise.js | 111 | 19 | 18 | _daemonSuperviseOnce(kind) 单方法（router 分支 60 行 + lan 分支 20 行） | 单方法 88 行；扇出 18 处 |
| 30 | daemons/probe.js | 50 | 2 | 22 | _routerDaemonActive/_lanDaemonActive/lanDaemonEnabled | 职责清晰但 **lanDaemonEnabled 扇入 22 处**（隐式全局开关） |
| 31 | daemons/identity.js | 37 | 6 | 10 | 两把管理锁的路径/读写/清除（纯 fs） | **健康**（薄、内聚） |
| 32 | daemons/scripts.js | 38 | 0 | 0 | daemon 脚本位置映射（域名词唯一归属） | **健康** |
| 33 | facade/router.js | 115 | 19 | 7 | routerDaemonActive/routerStatusView/routerProviders/routerStatus/routerDomainSummary/**setRouterRunning** | **不是门面**：setRouterRunning 是**写业务**（改 config + 持久化 + 相位），且与 ctl/facades 成环 |
| 34 | facade/lan.js | 63 | 10 | 10 | listLan/setLanFrp/frpStatus/lanFrpc/syncFrpc | **双模分支（daemon→ctl / 内嵌→LanManager）重复 5 次**；令牌白名单净化住门面 |
| 35 | facade/main.js | 99 | 12 | 6 | dshMainView（只读） + **patchDshMain**（安全闸 + 原子写 + 事件） | 写业务 + 公网暴露安全闸（64-80）住「门面」；与 daemons/runtime 成环 |
| 36 | facade/ports.js | 79 | 1 | 0 | listPorts（聚合 3 份注册表 + 3s TTL 激活探测） | 聚合/缓存可接受；直读另两份注册表文件（绕过 platform 接口） |
| 37 | facade/status.js | 58 | 0 | 0 | statusSummary（host-first 只读视图） | **健康**（纯投影） |
| 38 | ctl/client.js | 29 | 2 | 20 | _ctlCall/_routerCtlPort/_lanCtlPort/_lanCtlCall | **健康**（薄）；但扇入 20 → 端口解析是全局契约 |
| 39 | ctl/facades.js | 40 | 4 | 6 | _makeRouterFacade/_makeCtlFacade（Proxy）+ routerApi | 与 facade/router 成环（routerApi→routerDaemonActive） |
| 40 | audit/orphan-scan.js | 72 | 7 | 7 | _orphanAudit（低频只告警自检） | 读 7 个跨文件方法（probe/identity/ctl） |
| 41 | settings/env.js | 68 | 1 | 1 | envStatus/dshenvStatus（环境探测 + 能力矩阵 + 看护快照） | 单方法 30 行；纯读 |
| 42 | settings/versions.js | 152 | 5 | 0 | 版本检查 + VCS 根 + 磁盘版本 | 5 类职责；execFile/git fetch 是**进程 IO** 住设置层 |
| 43 | settings/access.js | 53 | 2 | 0 | 访问密钥 + 关闭行为（读/写 config） | 两组无关设置同文件 |
| 44 | settings/autostart.js | 50 | 1 | 0 | HostService class + 薄门面 | 同文件两形态（class + methods） |
| 45 | settings/lan-panel.js | 62 | 2 | 0 | 面板局域网开关（读/写 config + API 重绑） | 写 config **自己手写原子写**（46-50），与 persistConfigPatch 重复 |
| 46 | settings/node-lts.js | 40 | 0 | 0 | nodeLtsStatus（本地判定 + 6h 文件缓存） | 缓存文件读写；职责单一 |
| 47 | settings/domain-config.js | 59 | 0 | 0 | 业务配置键声明（反转法） | **健康**（纯数据 + 工厂） |
| 48 | settings/token-kinds.js | 121 | 0 | 0 | 令牌 kind/推断/文件名声明 + 注入 | **健康**（纯声明） |
| 49 | native/command.js | 48 | 0 | 0 | nativeCommand(config, pluginManager) 纯拼装 | **健康**（纯函数，显式入参） |
| 50 | native/installer.js | **806** | 77 | 0 | NativeManager：探测/版本/环境/清单/安装核心/安装/升级/回滚/卸载 | **全域最大**（超 R3 阈值 2 倍）；8 段职责；但**已是 class**（无 this 跨文件耦合） |
| 51 | self/lifecycle.js | 45 | 1 | 0 | 守卫自身生命周期标志 | **健康** |
| 52 | self/health.js | 25 | 0 | 0 | Health（live/ready） | **健康** |
| 53 | self/notify.js | 26 | 0 | 0 | notify(host,title,body) | **健康** |
| | **合计** | **6666** | **~600** | **222** | | 超 400 行：**4 个**（installer 806 / registry 443 / compose 366 / process 353） |

### A.2 域内耦合图

#### (a) require 边（去注释实测；app 内 16 个调用点 / 15 条边）

| # | from | → to | 行号 | 性质 |
|--:|---|---|--:|---|
| 1 | assembly/compose.js | settings/domain-config.js | 31 | 装配期注入声明 |
| 2 | assembly/compose.js | self/lifecycle.js | 34 | 组合 |
| 3 | assembly/compose.js | self/health.js | 35 | 组合 |
| 4 | assembly/compose.js | settings/autostart.js | 36 | 组合（HostService） |
| 5 | assembly/compose.js | native/command.js | 38 | 组合 |
| 6 | assembly/compose.js | native/installer.js | 40 | 组合（NativeManager） |
| 7 | assembly/compose.js | control/manager.js | 41 | 组合（LifecycleManager） |
| 8 | assembly/compose.js | control/registry.js | 42 | 组合（ManagedRegistry） |
| 9 | assembly/compose.js | state/intents.js | 43 | 组合（IntentLedger） |
| 10 | assembly/compose.js | control/adapters.js | 44 | 注册 |
| 11 | assembly/compose.js | settings/token-kinds.js | 52 | require-即注入 |
| 12 | assembly/bootstrap.js | control/adapters.js | 24 | 注册 |
| 13 | session/shutdown.js | control/adapters.js | 6 | **导入即触发**（只为副作用，无消费者，见 G-4） |
| 14 | main/process.js | native/command.js | 12 | 流程 |
| 15 | control/specs.js | daemons/scripts.js | 86, 95 | 装配期申报 |

**app 的 require 图是 DAG（Tarjan：53 文件 0 个 SCC>1）。** 但**这不代表解耦**——真正的耦合在 (b) 与 Supervisor.prototype 的 Object.assign。

#### (b) this.X() 跨文件调用边（★ 真正的隐式耦合）

按「方法在 A 文件定义、却在 B 文件被 this.X() 调用」实测（去注释、排除控制流关键字与泛型歧义）：

| 指标 | 实测值 |
|---|---:|
| 文件→文件 this 边 | **68** |
| (from 文件, to 文件, 方法名) 三元组 | **117** |
| 解析到跨文件定义的 this.X() **调用点** | **222** |
| Supervisor.prototype 自有成员 | **187**（177 函数 + 10 访问器） |
| 其中由 methods 导出注入 | **154**（+ 9 accessors + host-first 包装 + 2 个 api 包装 = 187） |
| 生成器产出的字段 helper | **46**（state/fields.js:68-80） |

**按源文件的 this 边密度（三元组 / 调用点）**：

```
main/process.js        13 / 43      state/fields.js       5 / 25
main/controller.js     18 / 44      state/store.js        7 / 7
daemons/runtime.js     12 / 14      daemons/supervise.js  12 / 18
audit/orphan-scan.js    7 / 7       facade/router.js       5 / 7
facade/main.js          5 / 6       control/specs.js       5 / 5
control/projection.js   4 / 4       control/scheduler.js   4 / 4
control/instance-adapter.js 3 / 3   control/registry.js    3 / 12
main/shadow.js          3 / 4       ctl/facades.js         2 / 2
daemons/probe.js        2 / 2       main/decide.js         2 / 2
main/health-gate.js     2 / 2       facade/lan.js          2 / 10
settings/env.js         1 / 1
```

**扇入排行（该文件定义的方法被别处 this 调用的次数）**：

```
56  state/fields.js      10  control/specs.js      2  facade/router.js
38  state/store.js        8  main/shadow.js        2  main/decide.js
22  daemons/probe.js      8  state/main-store.js   2  main/health-gate.js
20  ctl/client.js         6  ctl/facades.js        1  audit/orphan-scan.js
14  daemons/runtime.js    5  main/signals.js       1  facade/main.js
14  main/process.js       4  control/manager.js
10  daemons/identity.js   4  control/projection.js
```

**★ this 调用图上的环（Tarjan SCC 实测：4 个；去泛型方法后仍 4 个）**：

| 环 | 文件 | 环上的边（实测调用点） |
|---|---|---|
| **环 1（state 基座）** | state/store.js ↔ state/fields.js ↔ control/specs.js | store._dshEntry@19 与 _persistCrashField@27（specs:140/132）、store._mSetPhase@96 与 _mSetDesired@76（fields:153/182）、fields._mField@71,72,114,115…（store:22）、fields._dshEntry@158,187（specs:140）、specs._mDesired@31（fields:177） |
| **环 2（进程控制）** | main/process.js ↔ main/health-gate.js | process._bumpCrashWindow@278（health-gate:12）、health-gate._beginRestart@45（process:267） |
| **环 3（daemon 门面）** | daemons/runtime.js ↔ facade/main.js | runtime.dshMainView@71（facade/main:14）、facade/main._syncLanState@82（runtime:63） |
| **环 4（ctl 门面）** | facade/router.js ↔ ctl/facades.js | facade/router.routerApi@28,42（ctl/facades:33）、ctl/facades.routerDaemonActive@34（facade/router:9） |

> **R1 复现**：环的载体全部是 `src/supervisor.js:159-172` 把 37 个模块的 methods 合并到**同一个 Supervisor.prototype**。
> require 图无环，但 this 图上 4 个 SCC 真实存在 —— 改一个文件会静默破坏另一个（DF-4/DF-6 违反）。

#### (c) 跨层边（app 的合法出边，均向下）

| 目标层 | 目标单元 | 代表行 | 现状 |
|---|---|---|---|
| platform/contract | matrix / deploy | compose:17、versions:10,12、notify:7 | 合法 |
| platform/os | pidlookup / index / spawn / exec-path / process / netinfo | 覆盖 11 个子目录 | 合法 |
| platform/service | ports / tasks / log/{hub,logcore,log} / token/{kinds,pool,persist} / config / monitor / env-catalog / install-id / version | 覆盖 8 个子目录 | 合法 |
| platform/util | exec / srcpath / probe | native、facade、settings、daemons | 合法 |
| platform/distribution | DistributionManager | compose:25 | 合法（装配） |
| shared | version / guardian | installer:33、versions:11、health-gate:8 | 合法（L0） |
| domains | router/relay/instance/plugin/shell/market/watchdog | compose:20-28,295、bootstrap:27 | 合法（app→domains = ✓） |
| **api** | — | **0 处** | **DS-3 满足**（createServer 由 root 注入，api-rebind.js:10,54） |

app→app 无跨子目录的**反向**依赖（assembly 是唯一装配点，单向向下）。

### A.3 病症清单（对照 §0 的 4 类 + 本层特有第 5 类，逐条给证据）

**【病灶 1】巨型文件（4 个超 R3 的 400 行阈值）**
- native/installer.js **806 行**（8 段职责：探测 82-158 / 版本 159-208 / 环境 210-222 / 清单 224-288 / 执行核心 290-368 / 安装 369-447 / 升级 449-663 / 卸载 664-803）；
- control/registry.js **443 行**（词表+entry 22-141、持久化 149-211、CRUD 242-302、端口联动 304-324、心跳 332-414、观测/相位 416-440）；
- assembly/compose.js 366 行；daemons/process.js 353 行（后者已是 class，仅超阈值）；
- main/controller.js 226 行但**单方法 _dshConverge 208 行**（16-224）。

**【病灶 2】this 隐式耦合（DF-4/DF-6 违反）**
- 222 处跨文件 this.X()；4 个 SCC（A.2b）；
- 极端例：state/fields.js:153 的 _mSetPhase 在定义体内调 this._dshEntry()（control/specs.js:140）与 this.managedObjects（registry）—— **state 基座反向依赖 control**；
- state/store.js:76,96 又反向调 fields.js 的 _mSetDesired/_mSetPhase → **双向**；
- daemons/runtime.js:71 调 dshMainView（facade/main.js:14），而 facade/main.js:82 调 _syncLanState（runtime:63）→ **双向**。

**【病灶 3】职责错位**
- facade/* 5 个文件里 **3 个含写业务**：facade/router.js:78-113（setRouterRunning 改配置+持久化+相位）、facade/main.js:41-96（patchDshMain 含公网暴露安全闸）、facade/lan.js:16-39（令牌白名单净化）；
- state/upgrade-hold.js 是**升级生命周期**却住 state；state/desired.js:56-71 是**通用配置持久化**却住意图模块；
- session/shutdown.js:26-32 拥有 7 个**别的模块创建的定时器**（_timer/_heartbeatTimer/_killTimer/_adoptKillTimer/_initialCheckTimer/_upgradeTimer/_shellWatchdogTimer）；
- main/signals.js 是**进程信号**（跨 main/daemon 通用）却挂在 main 状态机；control/scheduler.js:27,31,37 一拍编排影子/审计/eventHub 三件异构事。

**【病灶 4】门面/接口面不可见**
- Supervisor.prototype 187 个成员**全部经 Object.assign 注入**（src/supervisor.js:159-172）；42 个 api 消费者（api/deps.js 声明 54 条 / 实测 42 个唯一成员）与 13 处 new Supervisor(...) 的测试（约 50 个成员）经**巨型 flat this** 取用，无编译期契约；
- api/deps.js:110-116 自己写明「**只声明，不强制**」。

**【病灶 5（本层特有）】state 的 5+1 文件边界不清（题目直接提问）**

| 文件 | 实测职责 | 判定 |
|---|---|---|
| state/store.js | registry main entry 解析（_mStore）+ state.json 原子读写 + 迁移 | **存储层，但反向知道 registry**（75 读 _loadedFromDisk） |
| state/fields.js | 纯字段表 + 生成器 + 10 个访问器 + phase/desired/guardian 读写（内含 registry 调用与事件） | **纯数据 + 有状态读写 + IO 三方混装** |
| state/main-store.js | dsh-main.json 读写 + registry 文件名派生 | **存储层**，但与 facade/router 交叉 |
| state/desired.js | 意图写（start/stop/restart）+ **config 持久化** | **业务编排 + 通用配置 IO 混装** |
| state/upgrade-hold.js | 升级 hold | **错位**（属 main/upgrade 生命周期） |
| state/intents.js | IntentLedger 纯类 | **健康**（唯一可独立单测） |

⇒ **5 文件不构成一个内聚域：是「存储(2) + 视图/字段(1) + 意图(1) + 升级(1)」的集合**，且 fields↔store↔specs 成环。**结论：应重切，不是合并**（详见 B.3）。

---

## B. 功能切面（★ 设计核心）

> 不看现有文件，先回答「app 层在功能上由哪几块组成」。
> 判据：一个切面 = **一组共享同一契约/生命周期/变更频率的功能**，可独立成域。

### B.1 app 的 10 个功能块

| # | 功能块 | 职责一句话 | 输入 | 输出 | 副作用 | 纯? |
|--:|---|---|---|---|---|---|
| **F1** | **Assembly 组装** | 在**唯一装配点**把配置/日志/端口/各域/受管目录/生命周期接成一个对象图 | rawConfig + configPath + 各域/平台 class | 装配完成的编排对象图 | 构造子系统、建状态目录、注册受管对象、写端口注册表 | 否（IO/构造） |
| **F2** | **Session 会话** | 守卫自身会话相位与「是否应运行」判定 + 关停编排 | host 状态 + 被管模块清单 | sessionState + 关停回执 | 停被管对象、清定时器、置相位、写事件 | 否（编排） |
| **F3** | **Main 主收敛** | 原生 DSH（main）的唯一状态机：探测→决策→动作→落相位 | 端口/HTTP 探测、进程句柄、desired/guardian | 相位迁移 + 进程动作 + 状态视图 | spawn/kill/adopt、写 state.json、发事件/通知 | 否（**决策可纯化**） |
| **F4** | **MainMeta 主元数据** | dsh-main.json（guardian/remote/frp/wanPort）的模型 + 原子读写 + 安全闸 | 白名单 patch | 校验后的元数据 | 原子写 0600、改实例表、发事件 | 否（存储） |
| **F5** | **Daemon 受管常驻进程** | router/lan daemon 的**进程生命周期**（身份锁/换代/latch/reclaim/spawn/stop）+ 探活 + 保活单拍 | 脚本路径、ctl 端口、身份文件 | DaemonLifecycle 实例 + {active,mode} | spawn/kill、读写身份锁、写 lan-state.json | 否（进程 IO） |
| **F6** | **ManagedObject 控制平面** | 「管家直接负责的对象」的**应然目录**：注册/更新/注销/申报 + 心跳驱动 + 观测/相位 | 业务申报 spec + adapter | 目录条目（应然+所有权+相位） | 原子写 managed-objects.json、端口 owner 联动、超时计时器 | 否（存储+调度） |
| **F7** | **ModuleLifecycle 模块生命周期** | 每个模块的统一生命周期视图与统一启停入口（ManagedLifecycle + LifecycleManager + adapters） | 模块 start/stop/status 回调 | 生命周期快照 + 启停结果 | 调模块回调、发事件 | 否（编排） |
| **F8** | **State 状态基座** | main 的字段模型 + 唯一读写口 + 两份持久文件 + 意图/升级 hold | 字段名/值 | 字段值 / 原子写 | 文件 IO、registry 联动 | 否（存储；**模型/映射可纯**） |
| **F9** | **DomainFacade 域读写门面** | 对 api 暴露的只读视图 + 双模（daemon ctl / 内嵌）委托 + ctl 客户端 | 域对象 / ctl 端口 | 视图对象（同步或 Promise） | **写路径**（启停/设置）→ 必须外移 | 否（门面；读路径可纯） |
| **F10** | **Settings 设置与诊断** | 配置/环境/版本/密钥/令牌 kind 的读写与投影 | config 文件 + 平台探测 + dist | 设置视图 / 落盘 | 写 config、exec git/npm、缓存文件 | 否（IO；**声明类可纯**） |

### B.2 切面边界裁决（回答「app 不是一个域」）

- **F1 是唯一装配点**（DIRECTORY-STRUCTURE-DESIGN §3 契约）——**不得**从别处构造子系统。
- **F3/F4/F8 三者边界**（关键）：
  - F8 只回答「**值是什么**」（字段模型 + 存取 + 持久化），不问「谁改的」；
  - F4 只回答「**元数据文件是什么形状**」（dsh-main.json 的模型 + 原子写 + 白名单校验）；
  - F3 只回答「**进程该做什么**」（状态机）。
  - 现状违反：F8 的 fields.js 直接调 F6（registry）与 F3 的语义（OBSERVED 合成）。
- **F5/F6/F7 三者边界**：
  - F5 = **进程**（pid/身份/换代/端口释放）；F6 = **目录**（应然/所有权/相位/心跳）；F7 = **视图与统一启停**。
  - 现状违反：F6 的 registry.js **心跳路径**反向调 F7 的 manager.get（12 处 this 边里的 4 处）与 state/fields 的 get（4 处）——域序颠倒（**F6 不该依赖 F7/F8**）。
- **F9 是门面还是业务？**（题目直接提问）—— **已被 R7 升级为强制不变量**
  - **只读视图（dshMainView/routerStatusView/routerProviders/routerDomainSummary/listLan/frpStatus/listPorts/statusSummary）= 门面**（留在 `app/facade/`）；
  - **写动作 = 业务**，必须下沉 `app/domain-actions/`：`setRouterRunning`（facade/router.js:78-113）、`patchDshMain`（facade/main.js:41-96）、`setLanFrp/lanFrpc/syncFrpc`（facade/lan.js:44-62）→ **`domain-actions/{router,lan,main}.js`**；
  - 归位到哪一层由 R7 的理由决定：**门面可写 → api 经门面直接改状态，绕过生命周期/目录/事件记账**。故写侧一律走 `domain-actions`（在那里统一经 lifecycleManager / 目录申报 / 事件），门面只做「读视图 + 双模委托」；
  - 边界：**各域自己的 `ops` 不受 R7 约束**（R7 只约束 `app/facade/`）。
- **facade/* 与 api/domains/* 的关系（是否重复？）**（题目直接提问）
  - **不重复，是相邻的两层**：api/domains/* = HTTP 契约层（解析 body / 鉴权 / 状态码）；app/facade/* = 该契约背后的**被调用面**。
  - **但有 3 处重复/漏层**：① api/domains/router.js:50-156 直接把 routerApi() 的 10+ 方法当 RPC 转发，app/facade/router.js 只是薄包装 → 二者合起来才是「一个域接口」；② facade/ports.js:36-41 直接 fs.readFileSync 另两份注册表，**绕过 platform/service/ports 接口**；③ facade/main.js:73-78 直接读 this.instances.instances 做端口冲突判定（跨域直读）。
  - **裁决建议**：保留两层，但**收紧 app/facade 为纯读 + 委托**，写动作归位；api/domains 的 sup.facadeXxx 调用点由 api/deps.js 继续声明（H.2 的 DF-G12 强制）。

### B.3 对题目五问的直接回答

**问 1：app 的域切面？** → B.1 的 F1–F10（10 块）。**app 不是一个域**：F1/F2 是「编排」、F3/F5 是「进程」、F4/F8 是「持久状态」、F6/F7 是「控制平面」、F9 是「接口面」、F10 是「配置面」。

**问 2：app 内的 this 跨文件耦合？** →
- this._mPhase()/_mDesired()/_mGuardian()/_mSetPhase()/_mSetDesired() **确实是 state 契约**：被 F2/F3/F6/F9/F10 共 5 个切面、**56 处**调用（state/fields.js 扇入第一）。
- 但契约**当前是隐式的**。设计裁决：**显式化为 F8 的 class 接口**（MainState：phase()/desired()/guardian()/setPhase()/setDesired()），ctor 注入 + 只读投影，**禁止**任何切面直接读写 host 上的字段。
- 另有两条**非 state 的隐式契约**同样必须显式化：**lanDaemonEnabled()**（daemons/probe.js:38，扇入 22）与 **_routerCtlPort()/_lanCtlPort()**（ctl/client.js:23,26，扇入 20）——它们是**部署形态**与**端口契约**，应成为注入的 DeploymentMode / CtlPorts 值对象（或纯谓词具名导出）。

**问 3：state/* 5 文件该合并还是重切？** → **重切**（证据 A.3 病灶 5），且**打断 fields↔store↔specs 环**：纯模型（phase.js、field-tables.js）/ 存储（main-record.js、main-meta.js）/ 视图读写口（main-state.js，class）/ 意图（desired.js 薄编排）/ 升级（upgrade-hold.js）。关键：**把 _dshEntry/_mainFallbackEntry/_persistCrashField 三个「存储内部口」从 control/specs.js:132-160 搬回存储层** → 环消失。

**问 4：facade/* 与 api/domains/* 的关系** → B.2 末条：相邻两层、不重复，但需收紧 facade 为纯读 + 委托。

**问 5（★ 核心）：200+ 方法经 Object.assign 挂原型 —— 是否进一步 ctor 注入？代价是什么？**

- **裁决：分两级，不搞「一次性全 ctor」。**
  - **级 1（本次必做，机械且低危）**：**停止把「跨文件的私有方法」挂上原型**。
    - 把 37 个模块的 methods 导出**改为 class 或具名函数**（§C 表）；
    - 只保留 **1 个兼容门面**（app/facade.js，≤150 行）把「**api 的 42 个成员 + 测试的 ~50 个成员**」按需委托到切面对象；
    - Supervisor 类只持有**切面实例**（this.state / this.main / this.daemons / this.hostObjects ...），不再持有 187 个方法。
  - **级 2（按切面推进）**：对**有状态、需协作**的 5 个切面（F3 Main / F5 Daemon / F6 ManagedObject / F7 Lifecycle / F8 State）用**构造注入**：new MainController({ state, record, actuator, signals, probe, healthGate, shadow, events, logger })。决策（decide.js）保持**纯函数（手法 C）**。
- **代价（如实列出）**：
  1. **api 兼容面**：42 个 sup.* 成员必须经门面转发 → 多一层间接 + 一份门面维护成本；由 api/deps.js + DF-G12 双向门禁保证不漏。
  2. **测试面**：13 处 new Supervisor(cfg) 直接调 ~50 个内部方法/访问器。级 1 后它们落在**切面实例**上（如 sup.state.phase()、sup.session.setState()）→ **测试必须改 ~50 处**（可机械 sed + 逐个跑）。**这是主要成本**。
  3. **访问器**：10 个访问器（phase/desired/child/adoptedPid/adopted/observedOnly/restartCount/spawnBlockedUntil/missingNotified/lan）是 get/set 语义，**不能经 Object.assign 复制**；门面需 Object.defineProperties（**不能**用 assign，否则退化为数据属性）。**建议保留在门面上**（supervisor.js:137-172 的 accessors 通路可复用）。
  4. **一次性改造半径 = 53 文件**：必须**分批**（§F 10 批），每批后门禁绿 + 相关测试绿。
  5. **收益**（为什么值得）：DF-4/DF-6 由「不可达」变「可达」——每个切面可**只 require 自己 + 假依赖单测**；4 个 SCC 消失；api/deps.js 从「文档性数据」升级为**可强制的接口面**。
  6. **不做的部分**：不为 187 个方法逐个设计类；**只对有状态/协作的 5 个切面做注入**，其余（声明/纯函数）保持模块级具名导出（手法 A）。

---

## C. 目标结构（★ 逐文件）

### C.1 目录树（保持现有子目录名；不新增子目录）

```
src/app/                                  L2 编排层
├── facade.js                  ≤150   ★ 唯一兼容门面（组合+委托+访问器；无业务）
├── assembly/
│   ├── compose.js             ≤150   构造图（从 366 拆出「装配步骤」）
│   ├── wire.js                ≤150   接线：tokenService.onChange / instances.on* / lifecycle 注册
│   ├── fs-guard.js            ≤80    数据目录保护（compose.js:57-78）
│   ├── bootstrap.js           ≤130   启动序列（骨架）
│   ├── runtime-start.js       ≤120   lan/router daemon 拉起 + 内嵌回退（bootstrap.js:91-143）
│   ├── heartbeat.js           ≤80    唯一心跳定时器 + 失速兜底（bootstrap.js:50-90）
│   ├── ports-register.js      ≤50    _registerFixedPorts/_bindNativeDshCommand（bootstrap.js:192-216）
│   ├── shell-watchdog.js      ≤40    _startShellWatchdog（bootstrap.js:167-189）
│   ├── api-rebind.js           91    不动（已健康）
│   └── log-sources.js          34    不动
├── session/
│   ├── machine.js              46    不动
│   └── shutdown.js            ≤130    不动（清定时器改走 timer registry，见 F 批 5）
├── state/
│   ├── phase.js               ≤50    纯：phase 双向映射（fields.js:127-141）
│   ├── field-tables.js        ≤45    纯：ENTRY_FIELDS/PROC_FIELDS（fields.js:38-64）
│   ├── main-record.js         ≤210   MainRecord：entry 解析 + state.json 读写 + 迁移 + persistCrashField
│   │                                  （store.js 全 + specs.js:132-160）
│   ├── main-state.js          ≤180   MainState：phase/desired/guardian 读写 + 38 helper + accessors
│   ├── main-meta.js            81    dsh-main.json（main-store.js 原样）
│   ├── intents.js              67    不动
│   ├── desired.js             ≤90    意图编排（改用注入服务）；config 写外移
│   └── upgrade-hold.js        ≤75    保留（见 G「不做的部分」）
├── main/
│   ├── controller.js          ≤110   收敛骨架：探测→快照→动作→收尾
│   ├── branches.js            ≤130   分支判定：desired/upgradeHold/manualRestart
│   ├── decide.js               113   不动（已是纯决策）
│   ├── actuator.js            ≤150   _startProcess/_enterRunning/_adopt/_adoptObserved/_beginRestart/stopProcess
│   ├── port-rederive.js       ≤90    _findManagedDshPort/_applyMainPort（平台知识集中）
│   ├── signals.js             ≤90    不动（进程信号）
│   └── shadow.js               120   不动（临时框架；G3 后整体删）
├── daemons/
│   ├── lifecycle.js           ≤300   DaemonLifecycle（process.js:57-350）
│   ├── identity.js             37    不动
│   ├── probe.js               ≤60    不动
│   ├── scripts.js              38    不动
│   ├── factory.js             ≤70    _daemonLifecycle/_daemonEnsureResult（runtime.js:16-61）
│   ├── runtime.js             ≤150   _ensureLanRuntime/_ensureRouterRuntime/_disableRouterPersist/_warnOccupied
│   ├── lan-state.js           ≤60    _syncLanState（runtime.js:62-101）
│   └── supervise.js           ≤130   保活单拍
├── control/
│   ├── managed-object.js      ≤150   词表 + createEntry + normalizeOwnership（registry.js:22-141）
│   ├── registry.js            ≤320   ManagedRegistry：持久化+CRUD+端口联动（-心跳）
│   ├── heartbeat.js           ≤90    心跳节流/超时/观测/相位（registry.js:332-440）
│   ├── managed-lifecycle.js   ≤240   ManagedLifecycle（entry.js 原样）
│   ├── lifecycle-manager.js    124   LifecycleManager（manager.js 原样）
│   ├── adapters.js             160   不动（无 this；已符合 DF-4）
│   ├── main-registry.js       ≤110   受管对象申报（specs.js 去掉 132-160）
│   ├── projection.js           118   不动
│   ├── scheduler.js            ≤50   不动
│   └── instance-adapter.js      55   不动
├── facade/                    ★ R7 强制：**只读视图 + 委托**，零写副作用（DF-G13）
│   ├── router.js              ≤70    只读：routerStatusView/providers/domainSummary/daemonActive（**移出 setRouterRunning**）
│   ├── lan.js                 ≤45    只读：listLan/frpStatus（**移出 setLanFrp/lanFrpc/syncFrpc**）
│   ├── main.js                ≤35    只读：dshMainView（**移出 patchDshMain 及其 _syncLanState 调用**）
│   ├── ports.js                79    不动（改为经 ports API 读另两份）
│   └── status.js               58    不动
├── domain-actions/            ★ 新建（R7）：域写动作 = 原 facade 写业务归位；**唯一允许改状态的编排侧入口**
│   ├── router.js              ≤60    setRouterRunning（→ lifecycleManager / 事件 / 目录申报）
│   ├── lan.js                 ≤60    setLanFrp / lanFrpc / syncFrpc
│   └── main.js                ≤90    patchDshMain（含安全闸）+ _syncLanState 触发
├── ctl/
│   ├── client.js               29    不动
│   └── facades.js             ≤40    不动（去掉对 facade/router 的依赖：谓词改注入）
├── audit/orphan-scan.js         72    不动
├── settings/                  env/node-lts/access/autostart/lan-panel/domain-config/token-kinds 不动
│   └── versions.js            ≤150    不动
└── native/
    ├── command.js               48    不动
    ├── installer.js           ≤150   NativeManager 骨架 + 门面（组合 5 个协作者）
    ├── detection.js           ≤90    detected/binPath/installedVersion/status（installer.js:82-158）
    ├── manifest.js            ≤80    _manifest/_saveManifest/_recordManifest/_claimDataPaths（224-288）
    ├── install-core.js        ≤90    _runInstall/_selectRegistry/_waitNativeHealthy/_rollbackNative/_targetPort/_mainUnit（290-368）
    ├── install.js             ≤90    install/startInstall（369-447）
    ├── upgrade.js            ≤210    upgrade/upgradeBrief/upgradeStatus/_handleUpgradeFailure（449-663）
    └── uninstall.js          ≤130    startUninstall/uninstall（664-803）
```

> **未列出的文件 = 不动**（已满足 DF-1..7 或改动收益低于风险，见 G）。

### C.2 逐文件明细（新文件 / 行数 / 职责 / 来源 / 纯?）

| 新文件 | 行数估计 | 职责 | 从哪来（旧文件:行区间） | 纯? |
|---|--:|---|---|---|
| facade.js | 140 | 组合切面实例 + api/测试兼容委托 + 10 访问器 | src/supervisor.js:33-72,137-172 | 否（组合） |
| assembly/compose.js | ~145 | 构造顺序（config→日志→令牌→dist→tasks→域→目录→生命周期） | compose.js:54-66,150-363 | 否 |
| assembly/wire.js | ~120 | 回调接线（tokenService.onChange 181-184、instances.on* 272-294、registerAll 355-363） | compose.js 同上 | 否 |
| assembly/fs-guard.js | ~35 | 数据目录保护 | compose.js:64-78 | 否（IO） |
| assembly/bootstrap.js | ~120 | 启动骨架 | bootstrap.js:31-53,144-165 | 否 |
| assembly/heartbeat.js | ~60 | 唯一心跳 + 失速兜底 | bootstrap.js:65-90 | 否（定时） |
| assembly/runtime-start.js | ~110 | lan/router 拉起与内嵌回退 | bootstrap.js:91-143 | 否 |
| assembly/ports-register.js | ~40 | 固定端口登记 + 原生命令绑定 | bootstrap.js:192-216 | 否（IO） |
| assembly/shell-watchdog.js | ~35 | 壳看护启动 | bootstrap.js:167-189 | 否（定时） |
| state/phase.js | 45 | 相位词表映射（唯一） | fields.js:127-141 | **是** |
| state/field-tables.js | 40 | ENTRY/PROC 字段表 | fields.js:38-64 | **是** |
| state/main-record.js | ~200 | entry 解析 + state.json 原子读写 + 迁移 + persistCrashField | store.js:13-123 + specs.js:132-160 | 否（存储） |
| state/main-state.js | ~170 | phase/desired/guardian 读写 + 38 helper + accessors（ctor 注入） | fields.js:66-206 | 否（有状态） |
| state/main-meta.js | 81 | dsh-main.json | main-store.js 原样 | 否（存储） |
| state/desired.js | ~85 | 意图编排（改用注入服务） | desired.js:18-54 | 否 |
| main/controller.js | ~105 | 收敛骨架 | controller.js:16-42,113-125,204-224 | 否 |
| main/branches.js | ~120 | desired/upgradeHold/manualRestart 三分支 | controller.js:72-125 | 半纯 |
| main/actuator.js | ~145 | spawn/enterRunning/adopt/beginRestart/stop | process.js:18-146,209-309 | 否（进程） |
| main/port-rederive.js | ~80 | 端口再推导 + 应用 | process.js:148-207 | 否（IO） |
| daemons/lifecycle.js | ~300 | DaemonLifecycle 原样 | process.js:23-351 | 否 |
| daemons/factory.js | ~60 | 生命周期实例工厂 + ensure 结果翻译 | runtime.js:16-61 | 否 |
| daemons/lan-state.js | ~50 | lan-state 合成 | runtime.js:62-101 | 否（IO） |
| daemons/runtime.js | ~130 | ensure lan/router + 写权纪律 + 占用告警 | runtime.js:102-201 | 否 |
| control/managed-object.js | ~140 | 词表/entry/ownership | registry.js:22-141 | **是** |
| control/registry.js | ~300 | ManagedRegistry（持久化+CRUD+端口） | registry.js:125-330 | 否 |
| control/heartbeat.js | ~80 | 心跳节流/超时/观测/相位 | registry.js:332-440 | 否（调度） |
| control/main-registry.js | ~105 | 受管对象申报 | specs.js:24-130 | 否 |
| facade/router.js | ~65 | 只读视图 + 双模委托 | facade/router.js:9-75 | 否 |
| facade/lan.js | ~40 | 只读 listLan/frpStatus（净化） | facade/lan.js:14-52 | 否 |
| facade/main.js | ~30 | 只读 dshMainView | facade/main.js:14-38 | 否 |
| domain-actions/router.js | ~45 | setRouterRunning | facade/router.js:78-113 | 否 |
| domain-actions/lan.js | ~45 | setLanFrp / lanFrpc / syncFrpc | facade/lan.js:44-62 | 否 |
| domain-actions/main.js | ~75 | patchDshMain + 安全闸 + _syncLanState 触发 | facade/main.js:41-96 | 否 |
| native/installer.js | ~140 | 组合 + 状态 + 门面 | installer.js:36-80,137-157,198-208,450-463 | 否 |
| native/detection.js | ~80 | 探测/路径/已装版本 | installer.js:82-135,359-367 | 否 |
| native/manifest.js | ~70 | 清单读写 + 数据认领 | installer.js:224-288 | 否（IO） |
| native/install-core.js | ~85 | npm 安装/镜像/健康/回滚核心 | installer.js:290-356 | 否（IO） |
| native/install.js | ~80 | 安装入口 | installer.js:369-447 | 否 |
| native/upgrade.js | ~200 | 升级状态机 + 失败处理 | installer.js:449-663 | 否 |
| native/uninstall.js | ~120 | 卸载 | installer.js:664-803 | 否 |

**行数合规核验（R3：门面 ≤150、单文件 ≤400）**：
- 唯一「对外门面」是 **app/facade.js（140 ≤150）**；assembly/compose.js（145）是内部装配步骤，不是对外门面；
- 最大单文件：daemons/lifecycle.js 300、control/registry.js 300、native/upgrade.js 200、state/main-record.js 200、state/main-state.js 170 —— **全部 ≤400**（现状 4 个超标文件全部消解）。

---

## D. 依赖图（★ 必须是 DAG）

### D.1 目标 require/注入图（分层示出，箭头只向下）

```
[L2.0 门面]
facade.js ──注入──► assembly/compose.js ──► (全部切面: 构造 DI)
    │                     │
    │                     ├──► assembly/wire.js ──► control/adapters.js ──► control/managed-lifecycle.js
    │                     ├──► assembly/fs-guard.js
    │                     └──► assembly/ports-register.js
    │
[L2.1 会话/启动]
    ├──► session/machine.js        （host-first 自由函数；无 require）
    ├──► session/shutdown.js       （注入 daemons/factory + control/lifecycle-manager）
    ├──► assembly/bootstrap.js ──► assembly/heartbeat.js
    │                           ──► assembly/runtime-start.js ──► daemons/{factory,runtime,probe,scripts}
    │                           ──► assembly/shell-watchdog.js（domains/shell/watchdog）
    │                           ──► control/adapters.js
    │                           ──► assembly/ports-register.js
    │
[L2.2 主收敛 F3/F4]
    ├──► main/controller.js ──► main/branches.js        （半纯：判定）
    │                       ──► main/decide.js          （纯）
    │                       ──► main/actuator.js ──► main/signals.js（进程信号）
    │                       ──► main/port-rederive.js ──► platform/service/config(extractPortFromCommand)
    │                       ──► control/projection.js
    │                       ──► main/shadow.js
    │                       ──► state/main-state.js
    │                       ──► state/main-record.js
    ├──► main/actuator.js  ──► state/main-state.js / state/main-record.js / main/signals.js / main/shadow.js / main/health-gate.js
    ├──► main/branches.js  ──► state/main-state.js（只读）
    ├──► main/shadow.js    ──► main/decide.js（纯）
    └──► main/health-gate.js ──► shared/guardian（纯）
                                  main/actuator.js  ← ★ 唯一反转点（见 D.2/D8）
[L2.3 受管常驻进程 F5]
    ├──► daemons/factory.js ──► daemons/lifecycle.js
    ├──► daemons/runtime.js ──► daemons/factory.js / daemons/identity.js / daemons/probe.js / ctl/client.js
    ├──► daemons/supervise.js ──► daemons/{runtime,probe,identity,factory} / ctl/client.js / control/projection.js
    ├──► daemons/lan-state.js ──► state/main-meta.js（mainView 改为注入的只读投影）
    └──► daemons/lifecycle.js ──► platform/os/{pidlookup,spawn}   （零 app 内依赖）
[L2.4 控制平面 F6/F7]
    ├──► control/heartbeat.js ──► control/registry.js（同一对象；heartbeat 为协作者）
    ├──► control/registry.js  ──► control/managed-object.js（纯模型）   ★ 不再 require manager/entry/fields
    ├──► control/main-registry.js ──► control/managed-object.js / daemons/scripts.js / ctl/client.js / daemons/probe.js
    ├──► control/adapters.js ──► control/managed-lifecycle.js / control/managed-object.js
    ├──► control/lifecycle-manager.js ──► control/managed-lifecycle.js
    ├──► control/projection.js  ──►（注入的 managedObjects + state，不 require）
    └──► control/instance-adapter.js ──► control/main-registry.js（upsert/unregister）
[L2.5 状态基座 F8]
    ├──► state/main-state.js ──► state/main-record.js / state/phase.js / state/field-tables.js
    ├──► state/main-record.js ──►（注入的 registry + logger）；迁移用 state/main-meta.js
    ├──► state/main-meta.js ──► node:fs
    ├──► state/desired.js ──► state/intents.js（+ 注入 state/main-state）
    └──► state/upgrade-hold.js ──► platform/os/pidlookup
[L2.6 门面 F9 / 设置 F10 / native]
    ├──► facade/{router,lan,main}.js ──► 注入的域对象 + ctl/client.js + daemons/probe.js（只读判定）
    ├──► domain-actions/{router,main}.js ──► state/main-meta.js / config 写入 / daemons/runtime.js
    ├──► ctl/client.js ──► platform/service/log/hub.ctlCall
    ├──► native/* ──► platform/{os,util,distribution}
    └──► settings/* ──► platform/{os,service,util,contract} / shared/version
```

### D.2 逐条边与理由（**app 内**；跨层边见 A.2c，全部合法向下）

| # | from → to | 理由 | 旧形态 | 变化 |
|--:|---|---|---|---|
| D1 | facade.js → assembly/compose.js | 组合根 | 原型批量注入 | ★ 由「187 方法合并」改为「持有切面实例」 |
| D2 | assembly/bootstrap.js → assembly/{heartbeat,runtime-start,shell-watchdog,ports-register}.js | 启动序列四类副作用分离 | 同文件 | 拆 |
| D3 | assembly/compose.js → assembly/wire.js | 构造 vs 接线分离 | 同文件 | 拆 |
| D4 | assembly/wire.js → control/adapters.js | 生命周期注册 | compose:44 | 保留 |
| D5 | main/controller.js → main/branches.js | 分支判定与骨架分离 | controller:72-125 | 拆 |
| D6 | main/branches.js → state/main-state.js | 只读相位/期望 | this._mPhase() | ★ 显式注入 |
| D7 | main/actuator.js → main/health-gate.js | 崩溃窗口记账 | process:278 | 保留方向 |
| D8 | main/health-gate.js → main/actuator.js | 假死→重启 | health-gate:45 | ★ **唯一保留的反转**：改为**返回决策**（{action:'restart',reason:'http_unhealthy'}）由 controller 执行 → 环消失 |
| D9 | control/registry.js → control/managed-object.js | 纯模型 | registry 同文件 | 拆（**去掉 registry→manager/fields 的反向 this 边**） |
| D10 | control/heartbeat.js → control/registry.js | 心跳驱动目录 | registry 内联 | 拆 |
| D11 | control/main-registry.js → daemons/scripts.js | 申报 daemon 脚本 | specs:86,95 | 保留 |
| D12 | daemons/runtime.js → daemons/factory.js | 复用生命周期实例 | runtime:18 | 拆 |
| D13 | daemons/supervise.js → control/projection.js | 视图同步 | supervise:44,77 | 保留 |
| D14 | facade/* → ctl/client.js | ctl 通道 | facade/lan:40 | 保留 |
| D15 | domain-actions/main.js → state/main-meta.js | 元数据白名单写 | facade/main:81 | ★ 写动作归位 |
| D16 | state/main-state.js → state/main-record.js | 值读写 | fields→store | ★ 单向（**打断 fields↔store↔specs 环**） |
| D17 | state/desired.js → state/intents.js | 意图登记 | desired:16 | 保留 |

**DAG 验证（4 环逐一消解）**：
1. **环 1**（store↔fields↔specs）：三个「存储内部口」搬入 state/main-record.js；main-state 持有 record（单向）；specs 只保留申报 → 环消失。
2. **环 2**（process↔health-gate）：health-gate 的 _applyHealthCheck 改**返回** restart 决策，由 controller 执行 → 单向 actuator→health-gate。
3. **环 3**（runtime↔facade/main）：lan-state.sync 的 mainView 改**注入**；写动作移 domain-actions/main.js（ctor 注入 lanState）→ 单向。
4. **环 4**（facade/router↔ctl/facades）：routerApi 与 routerDaemonActive 改 **ctor 注入谓词** → 单向。
⇒ **4 个 SCC 全部消失，全图 DAG。**

### D.3 跨域/跨层边（需上层裁决的逐条标注）

| 边 | 现状 | 处置 | 是否需裁决 |
|---|---|---|---|
| app → domains/{router,relay,instance,plugin,shell,market,watchdog} | 合法（装配期实例化），已登记 layering-and-dependency-gate-test.js:87-93 | 拆分后 require 点从 compose 移到 wire/runtime-start，**登记单元不变**（src/app/assembly 前 3 段）→ 门禁仍绿 | 否（知悉） |
| root(src/supervisor.js) → app/*（11 单元） | 门禁登记 layering:125-137 | 级 1 后 root 只 require ./app/facade.js → **11 条登记收敛为 1 条** | **是（需上层裁决）** |
| api/domains/* 读 sup.*（42 成员） | 无接口声明（api/deps.js 只声明不强制） | 门面化后由 api/deps.js + DF-G12 双向门禁强制 | **是（需与 api 域设计对齐）** |
| facade/ports.js:36-41 直读 ports-lan.json/ports-router.json | 绕过 platform 接口 | 设计为经 platform/service/ports 读 —— **是否新增 ports.readAll() 属 platform 域** | **是（与 platform 域重叠）** |
| state/main-record.js 读 registry._loadedFromDisk（现存 store.js:75） | 存储层反知 registry | 改为**注入 {registryHasSource:boolean} 值**（见 E.1） | 否（app 内解决） |

---

## E. this 隐式耦合消解表（★ 逐条）

> 手法：**A** 具名导出+显式依赖 / **B** 构造注入 / **C** 参数显式化（纯函数化）。
> 「位置」= 调用点（实测行号）。表覆盖 68 条文件边的代表项（全部 222 调用点由 §F 的机械步骤 + DF-G1 门禁覆盖）。

### E.1 state 基座（环 1）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| this._mField(name) | state/fields.js:71,72,114,115 | **B** | MainState ctor 注入 record；改 record.field(name) |
| this._mProcField(name) | state/fields.js:75,76,98,99,102,103,106,107,110,111,118,119,122,123 | **B** | record.procField(name) |
| this._mStore() | state/fields.js:145,154,178,184 | **B** | record.get() |
| this._dshEntry() | state/fields.js:158,187；state/store.js:19；control/projection.js:20 | **B/A** | 方法**移入** state/main-record.js；外部改注入 record 或 registry |
| this._mainFallbackEntry() | state/store.js:19 | **B** | 移入 state/main-record.js |
| this._persistCrashField() | state/store.js:27 | **B** | 移入 state/main-record.js（内部调注入的 registry.persistCrashState()） |
| this._mSetDesired / _mSetPhase | state/store.js:76,96 | **A/B** | loadState 改为接受 {state} 参数的**具名函数**（A），或 MainRecord 持有 state（B）——按 D16 取 A（避免反向） |
| this.managedObjects._loadedFromDisk | state/store.js:75 | **C** | loadState(raw, { registryHasSource }) 显式入参 |
| this._mDesired() | control/specs.js:31 | **A** | spec builder 改纯：managedMainSpec({ desired, guardian, targetPort }) |
| this._readDshMain() | control/specs.js:28 | **A** | 同上，元数据作入参 |

### E.2 main 主收敛（环 2）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| this._mPhase() | main/controller.js:77,89,101,117,119,127,149,167 | **B** | this.state.phase() |
| this._mSetPhase() | main/controller.js:78,89,101,149,170,173 | **B** | this.state.setPhase(p) |
| this._applyMainPort() | main/controller.js:59 | **A** | portRedevive.apply(state, config, ports, {port,pid})（由 controller 调） |
| this._mainStateSnapshot() | main/controller.js:42 | **C** | 纯函数 snapshot(state, {pidlookup, child, ...}) |
| this._decideMainAction(t0) | main/shadow.js:59 | **C** | 已是纯函数，改为**具名导出**（已满足） |
| this._beginRestart() | main/health-gate.js:45 | **C** | applyHealthCheck(...) **返回** {restart:'http_unhealthy'}，由 controller 执行 |
| this._bumpCrashWindow() | main/process.js:278 | **B** | this.healthGate.bumpCrashWindow(state, config)（单向 actuator→health-gate） |
| this.writeState() | main/process.js:38,95,123,145,227,257,264,292,308 | **B** | this.record.write()（actuator 注入 record） |
| this._killSequence / _killAdopted | main/process.js:284,306 / 289,307 | **A** | signals.killSequence(child, {config, events, timer}) 具名函数 |
| this._actNote() | main/process.js:24,127,211,231,291,296 | **B** | this.shadow.note(action,reason)（G3 后可删） |

### E.3 daemon / 控制平面 / 门面（环 3、环 4 + 域序修正）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| this.dshMainView() | daemons/runtime.js:71 | **B** | lanState.sync({instances, mainView})——**mainView 由调用方注入**（打断环 3） |
| this._syncLanState() | facade/main.js:82 | **A** | 写动作移 domain-actions/main.js，ctor 注入 lanState（环 3 消失） |
| this.routerApi() | facade/router.js:28,42 | **B** | facade/router.js ctor 注入 routerApi（环 4 消失） |
| this.routerDaemonActive() | ctl/facades.js:34 | **B** | createCtlFacade(port, { isDaemonActive })——谓词注入 |
| registry 心跳里取 lifecycleManager | control/registry.js:364-414（heartbeat） | **B** | heartbeat.js **注入 onObserved 回调**（目录不知道生命周期） |
| this._ensureRouterRuntime() | facade/router.js:83,102 | **B** | 写动作移 domain-actions/router.js，ctor 注入 daemonsRuntime |
| this.lan.setFrp / _lanCtlCall（写） | facade/lan.js:44-47（setLanFrp） | **B** | 移 domain-actions/lan.js；facade/lan.js 只留 listLan/frpStatus 只读 |
| this.lan.frpAction / syncFrpc（写） | facade/lan.js:54-62（lanFrpc/syncFrpc） | **B** | 移 domain-actions/lan.js |
| this._writeDshMain + this.instances.instances（跨域直读） | facade/main.js:73-81（patchDshMain） | **B** | 移 domain-actions/main.js；实例冲突判定改为**注入的只读投影** |
| this._daemonManaged() / _routerDaemonActive() | daemons/supervise.js:24,30,31,43；audit/orphan-scan.js:25 | **A/B** | 改为具名导出 daemonInspect({pidlookup, config, ctlPort})（A），或注入 daemonProbe 对象（B） |
| this.lanDaemonEnabled()（22 处） | 定义 daemons/probe.js:38 | **A** | 纯谓词 isLanDaemonMode(config) 具名导出（**只读 config 一个字段**） |
| this._ctlCall() / _lanCtlCall() | daemons/runtime.js:37,110,155 / supervise.js:50,69,76 / probe.js:20,34 / facade/lan.js:40,45,50,55,60 / audit:25,26 | **A** | ctl/client.js 的 4 个方法改为具名导出 {ctlCall, routerCtlPort, lanCtlPort, lanCtlCall} + 显式 config 入参 |

### E.4 跨域/跨层（**需上层裁决**，不在本层擅自改）

| 旧调用 | 位置 | 手法建议 | 备注 |
|---|---|---|---|
| sup.<42 个成员> | src/api/domains/*.js | **B** | 由 app/facade.js 统一委托；api/deps.js 升为强校验。**需与 api 域设计对齐** |
| new Supervisor(rawConfig, configPath) | 13 处测试 | **B** | 兼容门面保留 → 多数测试可**零改**；仅直调内部方法（~50 成员）需改 sup.<切面>.<方法> |
| host 字段初始化 40 行 | assembly/compose.js:79-147 | **B** | 由 new MainRecord()/new MainState() 的字段默认值承担；compose 只 new |

---

## F. 迁移步骤（★ 可执行、可分批）

> 前置：**每批结束**跑 `node --require ./test/_preload.js test/directory-structure-gate-test.js`、`test/layering-and-dependency-gate-test.js`、`test/test-chain-completeness-test.js`（新门禁入链后），并跑该批涉及的既有测试。
> 每批**可独立提交**；**不改 src/ 之外的路径字面量**（除门禁）。

| 批 | 动作 | 影响文件 | 验证 |
|--:|---|---|---|
| **0** | **建门禁**：test/domain-structure-gate-test.js（§H 的 DF-G1..G12，先 **report-only** 打印红项但仍 exit 0）；加入 scripts.test 链 | 新增 1 + package.json | 该门禁本身；test-chain-completeness-test.js 绿 |
| **1** | **state 拆纯**：state/phase.js（fields.js:127-141）、state/field-tables.js（38-64） | state/fields.js, +2 | phase-vocabulary-test、main-port-rederive-test、adopt-token-reclaim-test、session-lifecycle-test |
| **2** | **state 存储重切**：state/main-record.js ← store.js 全 + specs.js:132-160；state/main-meta.js ← main-store.js；删 store.js/main-store.js；fields 改调 record | state/{store,main-store,fields}, control/specs.js | 同上 + managed-registry-test、heartbeat-selfheal-test |
| **3** | **state 视图 class 化**：state/main-state.js（MainState + helper + accessors）；config/specs/projection/env/main/* 改 state.phase() 等 | ~14 文件 | **全量 npm test**（此批触及面最大） |
| **4** | **main 拆分**：main/{controller,branches,actuator,port-rederive}；环 2 用「health-gate 返回决策」打断 | main/* | shadow-decision-test、main-port-rederive-test、adopt-token-reclaim-test、lifecycle-mirror-test |
| **5** | **定时器所有权**：assembly/heartbeat.js 自持 _heartbeatTimer；shutdown.js 改调 timerRegistry.clearAll() | assembly/bootstrap.js, session/shutdown.js | heartbeat-selfheal-test、graceful-shutdown-test |
| **6** | **daemons 拆分**：lifecycle.js/factory.js/lan-state.js/runtime.js；环 3（mainView 注入） | daemons/* | daemon-lifecycle-test、daemon-path-test、lan-daemon-test、round8-fixes-test |
| **7** | **control 拆 + 域序修正**：managed-object.js、registry.js(-heartbeat)、heartbeat.js、main-registry.js；去掉 registry→manager/fields | control/* | managed-registry-test、phase-vocabulary-test、guard-domain-model-gate-test、session-lifecycle-test |
| **8** | **facade 纯化 + 写动作归位（R7）**：facade/{router,lan,main} 只读（**零写副作用**）；domain-actions/{router,lan,main}（5 个写动作：setRouterRunning / patchDshMain / setLanFrp / lanFrpc / syncFrpc）；环 4（谓词注入） | facade/*, ctl/facades.js, +3 | api-contract-test、p2p-api-test、round13-router-relay-gaps-test、guard-domain-model-gate-test + **DF-G13** |
| **9** | **native 拆 5**：installer → detection/manifest/install-core/install/upgrade/uninstall（**类保持**，ctor 注入协作者） | native/installer.js, +5 | native-test（独立 script）、native-op-mutex-test、upgrade-test、kernel-update-single-writer-test |
| **10** | **级 1 门面化 + 门禁强制**：app/facade.js 组合切面 + 委托 42 api 成员 + 10 访问器；src/supervisor.js 只 new 切面；门禁去 report-only | src/supervisor.js, app/facade.js, 2 门禁, api/deps.js | smoke.js、api-contract-test、api-surface-test、13 处 new Supervisor 测试、directory-structure-gate-test |

**批次间风险控制**：批 0 门禁**先只报告**（不阻塞批 1–9 中间态）；批 10 才切强制。批 3 与批 10 **破坏性最大**，必须独立提交 + 全量测试。

---

## G. 风险与取舍

**破坏性改动（点名消费方）**
1. **Supervisor.prototype 187 → 门面 + 切面**（批 10）：
   - 消费方 A：src/api/domains/*.js 的 **42 个 sup.* 成员**（api/deps.js:36-108 已列全）——门面必须逐条覆盖，否则某端点静默 500。
   - 消费方 B：**13 处 new Supervisor** 测试，触及 ~50 个成员（_mPhase/_mSetPhase/_setSessionState/_daemonSuperviseOnce/_sandboxSuperviseOnce/_syncSandboxRegistryEntry/_startProcess/_beginRestart/_findManagedDshPort/_applyMainPort/_shadowExcluded/_syncLanState/_registerFixedPorts + 10 个访问器）。
   - 消费方 C：bin/dsh-supervisor:57 只 require app/settings/domain-config（**不受影响**）。
   - 消费方 D：api/index.js:172-179 的 originAllowed/isLoopbackHost/isShellOrigin re-export（**不受影响**）。
2. **文件路径迁移**：**9 个测试**断言具体 src/app/** 路径（round8-fixes、guard-domain-model-gate、kernel-daemon-contract、kernel-update-single-writer、native-dsh-binding、platform-capability-audit、round13-router-relay-gaps、token-contract-gate、layering-and-dependency-gate）。**建议把路径断言改动集中到批 10**，中间批次**尽量保留原文件名**或先建新文件再切 consumer。
3. **layering-and-dependency-gate-test.js:125-146 的 root → app 11 条登记**：门面化后收敛为 1 条 —— 属**门禁表更新**（不是放宽），需与目录结构 SSOT 同步（**需上层裁决**）。
4. **session/shutdown.js:6 的 require('../../app/control/adapters') 无消费者**（registerAll 未被使用）——拆批 5 时顺手删除（**低风险**；实测该模块顶层只有 class/函数定义，无副作用，可删）。

**不做的部分与理由（不为设计而设计）**
1. **main/shadow.js 不重构**：G1→G3 的**临时影子框架**，生命周期短；拆它等于为将删代码付迁移成本。**保留 120 行原样**，G3 切换后整体删。
2. **settings/versions.js 不拆**：5 类职责同族（版本/更新），152 行 < 400，消费者仅 3 个端点 + 2 测试；拆开只增装配点。
3. **以下文件不动（实测已满足 DF-1..7）**：settings/{domain-config,token-kinds}.js、native/command.js、assembly/{api-rebind,log-sources}.js、control/{entry,manager,adapters,projection,scheduler,instance-adapter}.js、daemons/{identity,probe,scripts}.js、self/*、state/intents.js、audit/orphan-scan.js、facade/{ports,status}.js、session/machine.js。
4. **state/upgrade-hold.js 暂留 state**：语义属升级生命周期，但迁移牵动 native/upgrade.js 的 hooks（compose.js:340-341）与 4 个测试；收益低。**标注为已知错位**，待批 9 后评估。
5. **不引入 DI 容器/装饰器**：本仓无该基建；构造注入用**字面量对象**即可（new MainController({ state, record, ... })）。
6. **不为 control/adapters.js 建子目录**（R2：优先扁平）：160 行、单一职责、role→kind 映射是装配期数据。

**其他风险**
- **测试时长**：npm test 是 94+ 条硬编码链（package.json:11），批 3/10 必须全跑。
- **host-first 兼容包装**（supervisor.js:143-172）是**过渡态**：保留它意味着「跨文件 this」仍可能复活 —— DF-G3 必须在批 10 后强制。
- **访问器 10 个**：get/set 语义，门面必须 Object.defineProperties（**不能** assign）。

---

## H. 门禁建议（供 `test/domain-structure-gate-test.js`）

> 文件名按 R4/R6 指定；同时把现有 test/directory-structure-gate-test.js:122 的 DS-G3 判据**按 R6 定稿替换**。

### H.1 DF-G3（R6 定稿）：禁原型批量注入 —— 三条组合，且**必须先剥注释**

**R6 的实测依据（本文复现）**：

| 形态 | 位置 | 原 R4 正则 | 说明 |
|---|---|---|---|
| `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` | src/domains/router/index.js:758、759 | **命中** | 右值是内联 require |
| `Object.assign(Supervisor.prototype, mod.methods)` | src/supervisor.js:160 | **漏掉** | 右值是变量（APP_MODULES 在 34-72 行 require、159 行才 assign） |
| ```// 这取代了旧的 `Object.defineProperties(X.prototype, require(...))` 注入。``` | src/supervisor.js:21（**说明性注释**） | **误命中** | 若不剥注释 → 假阳性 |

⇒ 老正则**同时**假阴性（真注入漏掉）与假阳性（注释命中）。R6 裁决：**剥注释 + 三条组合**。

```js
// ── 必须的第一个动作：剥注释（R1/R6 共同要求）──
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')        // 块注释
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');      // 行注释（不误伤 http:// 里的 //）

// ① 任何把外部方法集挂到原型的手法（**右值不限**）—— R6
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（mixin 的载体）—— R6，**本文补强为两条（见下「② 的第二个假阴性」）**
const METHODS_FRAGMENT      = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;          // { methods: {...} } / { methods }
const METHODS_FRAGMENT_SHORT = /module\.exports\s*=\s*\{[\s\S]{0,200}?\bmethods\b\s*[,:}]/; // { methods, accessors }
const isMixinFragment = (s) => METHODS_FRAGMENT.test(s) || METHODS_FRAGMENT_SHORT.test(s);
// ③ 反向自检样本 —— R6 明确要求含 mod.methods 形态
const S_PROTO_INLINE = "Object.assign(RouterService.prototype, require('./forward-core').forwardMethods);";
const S_PROTO_VAR    = 'Object.assign(Supervisor.prototype, mod.methods);';
const S_MIXIN        = 'module.exports = { methods: { log() {} } };';
const S_COMMENT_ONLY = '// 旧形态 Object.defineProperties(X.prototype, require("./x")) 已废除';

check('DF-G8a 反向：判据能命中内联 require 形态', MIXIN_INTO_PROTOTYPE.test(strip(S_PROTO_INLINE)));
check('DF-G8b 反向：判据能命中 mod.methods 变量形态（R4 的假阴性回归位）', MIXIN_INTO_PROTOTYPE.test(strip(S_PROTO_VAR)));
check('DF-G8c 反向：判据能命中 methods 分片导出', METHODS_FRAGMENT.test(strip(S_MIXIN)));
check('DF-G8c-2 反向：判据能命中**简写**分片导出（{ methods, accessors }，state/fields.js:200 形态）',
  isMixinFragment(strip('module.exports = { methods, accessors, buildFieldHelpers };')));
check('DF-G8d 反向：剥注释后**不得**命中纯注释里的旧形态（防假阳性）', !MIXIN_INTO_PROTOTYPE.test(strip(S_COMMENT_ONLY)));
check('DF-G8e 反向：{\'GET\'} 数组形态不得误命中', !isMixinFragment(strip("module.exports = { methods: ['GET'] };")));
```

> 实测排除误报：api/contract.js:45 的 `methods: ['GET']` 是**数组** → 不命中 `METHODS_FRAGMENT`（该正则要求 `methods` 后跟 `{`）。

**★ ② 的第二个假阴性（本文实测发现，R6 的正则本身仍会漏 2 个文件）**

R6 的 `METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/` 只匹配 **`{ methods: ... }` / `{ methods }`**，
**不匹配 UMD 简写 `{ methods, accessors, ... }`**。实测 `src/app/**`：

| 文件 | 导出尾部（实测） | R6 正则 | 后果 |
|---|---|---|---|
| `src/app/state/fields.js:200-206` | `module.exports = { methods, accessors, buildFieldHelpers, ENTRY_FIELDS, PROC_FIELDS };` | **漏** | **最严重**：正是带 **46 个生成器 helper** 的 mixin 载体 |
| `src/app/settings/autostart.js:39-49` | `module.exports = { HostService, methods: {...} }` | 命中 | — |

⇒ 只用 R6 正则：app 内命中 **28 / 53**；补上简写后 **30 / 53**（真实值）。**缺的 2 个里恰好包含 fields.js**——漏它等于漏掉「46 个 helper 被注入同一 this」这一最大单点。
故 `METHODS_FRAGMENT` **必须有简写分支**，且反向自检要加一条简写样本。**此点请上层在 R6 定稿时吸收**（不改 R6 结论，只补判据完备性）。

> 三门禁的**期望终态均为 0 命中**（app 内）；当前 app 命中：① × 1（`src/supervisor.js:160-161` 循环体）+ ② × **30** modules（154 方法 + 状态字段 helper）。
> 另实测：app 内 **`accessors:` 独立导出 0 处**（10 个访问器在 `state/fields.js:200` 以**简写** `accessors` 导出 → 同样只能靠 `METHODS_FRAGMENT_SHORT` 捕获）。

### H.2 全部判据（DF-G1..G13）

| 门禁 | 断言 | 判据要点 |
|---|---|---|
| **DF-G1** | app 内 this.X() **跨文件**调用 = 0 | 去注释 → 收集 `/^\s{2,}(\w+)\(.*\)\s*\{/` 定义表 → 收集 `this.(\w+)\(` → 若 defFile ≠ useFile 即违规。**目标 0**（当前 222） |
| **DF-G2** | 每个非门面文件可 require 而不构造整个域对象 | require 后断言 module.exports 非空且不抛；class 文件断言 `typeof X === 'function'` |
| **DF-G3** | 无原型批量注入 + 无 methods 分片导出（**R6 定稿 + 本文补强**：H.1 三判据 + 5 个反向自检，含 mod.methods 变量形态、**简写分片**、纯注释不误命中、数组形态不误命中） | 见 H.1 |
| **DF-G4** | app 内 require 图 = DAG（SCC=0） | 去注释 + Tarjan |
| **DF-G5** | this 调用图 SCC = 0 | 与 DF-G1 同源；4 个已知 SCC 的目标 |
| **DF-G6** | 门面 ≤150；任何 app 文件 ≤400 | 尾换行不计（同 directory-structure-gate-test.js:189 口径） |
| **DF-G7** | 子层序：assembly → {session,control,main,daemons,state,facade,settings,native} → state → (platform/shared)；无反向边 | 断言 state→control、control→facade、daemons→facade、state→main 均为 0 |
| **DF-G8** | 每条判据都能命中构造样本（非空转） | 每条至少 1 个 check(..., sample) |
| **DF-G9** | 纯文件零 IO：state/phase.js、state/field-tables.js、control/managed-object.js、native/command.js、settings/{domain-config,token-kinds}.js | 去注释后禁 `require('node:*')` / fs. / process. / spawn |
| **DF-G10** | 装配唯一性：只有 assembly/compose.js 可 require ../../domains/* | 其他 app 文件出现 domains require 即违规（daemons/scripts.js 只含**路径字符串**，不计） |
| **DF-G11** | 部署/端口谓词具名化：lanDaemonEnabled / routerCtlPort / lanCtlPort 只定义 1 处，且调用点不得是 this. | 与 DF-G1 联动；当前 22+20 处 this 调用必须归零 |
| **DF-G12** | api 依赖面双向一致：api/deps.js 声明 ≡ 门面实际导出 ∩ 各域 sup.* 实测 | 复用 api-surface-test.js 的「双向一致」纪律 |
| **DF-G13** | **（R7）facade/ 只读**：写副作用正则 0 命中 + 写动作在 domain-actions/ 有归属 + 反向自检 | 见 H.5；当前 5 处违规（setRouterRunning/patchDshMain/setLanFrp/lanFrpc/syncFrpc） |

### H.3 现有门禁需同步的改动

| 现有门禁 | 改动 | 原因 |
|---|---|---|
| directory-structure-gate-test.js:122 | DS-G3 判据换为 **R6 定稿的三条组合**（H.1），并要求**先剥注释**；**分片判据须含简写分支** | R6；现判据同时假阴性（supervisor.js:160 漏）与假阳性（supervisor.js:21 注释命中）。本文实测 R6 正则**仍漏 2 文件**（state/fields.js、settings/autostart.js 的简写导出），故补 `METHODS_FRAGMENT_SHORT` |
| directory-structure-gate-test.js:170 | ALLOWED 加 policies model store handlers core jobs | R2 |
| directory-structure-gate-test.js:190 | 阈值注释与 DS-9 同步为 ≤150/≤400 | R3 |
| layering-and-dependency-gate-test.js:125-137 | root → app 11 条 → 1 条（./app/facade） | 批 10 门面化 |
| test-chain-completeness-test.js | 新门禁进 scripts.test（否则 N-a 判红） | 制度 |

### H.4 判据实现注意（本仓已踩过的坑，必须在门禁里防御）

1. **必须剥注释**（R1 的取证陷阱）：块注释 + 行注释；否则注释里的 require/this.X() 会伪造边。
2. **行号必须相对文件**（layering…:189-191 踩过：绝对路径 join 导致判据恒假、门禁空转）。
3. **生成器产出的方法静态扫描看不到**：state/fields.js 的 46 个 helper 是**生成**的 —— DF-G1 必须对「生成器」文件加白名单，或要求生成器目标改为**显式方法**（本设计取后者：state/field-tables.js 只留数据，helper 由 MainState 显式生成且**不跨文件调用**）。
4. **泛型名**（get/set/has/any/clear/consume/register/update/list/status/snapshot）会与 Map/registry 自匹配 —— DF-G1 取「定义表限定在 app 内 + 排除已知泛型名白名单」（本文的 68/117/222 即此口径）；门禁需把白名单写死并加反向自检。
5. **api/contract.js 的 methods: ['GET']** 不得误命中 `METHODS_FRAGMENT` —— 判据要求 methods 后跟花括号。
6. **注释必须先剥再做 DF-G3 断言**（R6 实证）：src/supervisor.js:21 的说明性注释若参与扫描 → 假阳性；而 160 行的真实注入若因「右值不是内联 require」被跳过 → 假阴性。**同一处文件同时踩两坑**，是 R6 立判据的直接原因。
7. **分片判据必须用「文本包含」而非「键名紧跟冒号」**：`{ methods, accessors }` 是合法简写，R6 正则漏之；而本仓恰好把**最大单点**（state/fields.js:200，46 helper）写成简写。补 `METHODS_FRAGMENT_SHORT` 后 app 命中从 28 → **30**（真值 53 文件中的 30）。同理 `accessors:` 独立导出实测 0 处 —— 10 个访问器也走简写路径，只能靠简写分支捕获。

### H.5 DF-G13（R7 定稿）：门面只读 —— 写动作必须在 `domain-actions/`

**R7 裁决**：`app/facade/*.js` **只允许只读视图**；写动作下沉 `app/domain-actions/`（各域自己的 `ops` 不受此约束）。

**现状违规清单（逐条给实测行号）**：

| 违规方法 | 位置（实测） | 写副作用 | 归位目标 |
|---|---|---|---|
| `setRouterRunning` | app/facade/router.js:78-113 | 改 `config.routerAutostart` + `persistConfigPatch` + 生命周期相位写入 | `domain-actions/router.js` |
| `patchDshMain` | app/facade/main.js:41-96 | `_writeDshMain`（原子写 0600）+ 跨域读 instances + 事件 | `domain-actions/main.js` |
| `setLanFrp` | app/facade/lan.js:44-47 | 经 ctl/内嵌改 relay FRP 开关 | `domain-actions/lan.js` |
| `lanFrpc` / `syncFrpc` | app/facade/lan.js:54-62 | 触发 frpc 动作/同步 | `domain-actions/lan.js` |
| `_syncLanState` 调用点 | app/facade/main.js:82 | 写 `lan-state.json` | 随写动作迁移 |

**只读白名单（可留在 facade/）**：`routerDaemonActive`、`routerStatusView`、`routerProviders`、`routerStatus`、`routerDomainSummary`、`listLan`、`frpStatus`、`dshMainView`、`listPorts`、`statusSummary`。

**门禁判据（DF-G13）**：

```js
// facade/ 下的模块，其导出方法体**不得**出现写副作用（剥注释后扫描）
const WRITE_SIDE_EFFECT = /(writeFileSync|renameSync|unlinkSync|mkdirSync|persistConfigPatch|_writeDshMain|_syncLanState|rmSync|spawn\w*\(|\.start\(\)|\.stop\()/;
const facadeFiles = walk('src/app/facade').filter(f => f.endsWith('.js'));
const dirty = facadeFiles.filter(f => WRITE_SIDE_EFFECT.test(strip(fs.readFileSync(f, 'utf8'))));
check('DF-G13 facade/ 只读：无写副作用', dirty.length === 0, dirty.join(', '));
// 反向自检：样本必须命中
check('DF-G13 反向：判据能识别写动作',
  WRITE_SIDE_EFFECT.test(strip('persistConfigPatch({ routerAutostart: true });')));
// 配对的“有归属”判据：每个被移出的写动作必须能在 domain-actions/ 找到同名实现
const actions = walk('src/app/domain-actions');
check('DF-G13b 写动作已归位 domain-actions/', ['router','main','lan'].every(k =>
  actions.some(f => f.endsWith(k + '.js'))), actions.join(', '));
```

> **理由（R7 原文）**：门面可写 → api 经门面直接改状态，**绕过生命周期/目录/事件记账**。
> 这正是本文 §B.2 判定的 3 处「漏层」之一；R7 将其升级为**强制不变量**，并解释了为什么写侧必须经 `domain-actions`（可统一走 lifecycleManager / 目录申报 / 事件）。

---

## 附：本设计的自我验证（对照 §1 判据）

| 判据 | 目标 | 落点 |
|---|---|---|
| DF-1 门面纯化 | facade.js ≤150 行、无业务 | §C.1（140 行）；写业务移 domain-actions/ |
| DF-2 单文件上限 | ≤400（理想 ≤250） | §C.2 全部达标；最大 lifecycle.js/registry.js 300 |
| DF-3 纯/IO 分离 | 纯计算与副作用的文件分离 | state/phase.js、state/field-tables.js、control/managed-object.js 纯；存储/进程/定时分文件 |
| DF-4 零隐式 this 跨文件 | 222 → **0** | §E 逐条；DF-G1 强制 |
| DF-5 无环 | this 图 4 SCC → **0**；require DAG | §D.2；DF-G4/G5 强制（R1 语义：禁原型合并） |
| DF-6 可独立单测 | 每非门面文件可 require + 假依赖 | DF-G2；class 化后每切面可 new X(fakeDeps) |
| DF-7 单向依赖 | facade → assembly/main/session/control/daemons/state → platform/shared | §D.1；DF-G7 强制 |
| R3 阈值 | 门面 ≤150 / 单文件 ≤400 | §C.2 核验栏 |
| R4（被 R6 修正） | H 含 assign 判据 + 反向自检 | §H.1（已按 R6 定稿） |
| **R6** | DF-G3 = 三条组合（任意右值 / 分片导出 / 反向自检含 mod.methods）+ **先剥注释** | §H.1；并给出假阴性(160)与假阳性(21)双向反向用例 |
| **R7** | 门面只读；写动作下沉 domain-actions/ | §B.2、§C.1/C.2、§E.3、§H.5（DF-G13 + 5 处违规清单 + 只读白名单） |
| R5 | 不改 daemon.js basename | §C.1（daemons/ 只做内部拆分；文件名不变） |

**未启动任何守卫进程**；统计中 `require('./src/supervisor')` 仅用于读取原型成员数（不 new、不 start、不写状态根）。
