# 横切专题功能设计 —— 域间契约 + 域结构门禁

> 范围：**只做设计**（不改 `src/`，不 commit，不启动任何守卫进程）。
> 依据：`DOMAIN-DESIGN-BRIEF.md`（强制模板 §5、DF-1..7、四把刀 §2、三手法 §3）、
> `DIRECTORY-STRUCTURE-DESIGN.md`（五层 SSOT、DS-1..12、DS-G1..G8）、
> **`design-notes/_RULING.md`（R1–R7）—— 本文件已按裁决补正；裁决优先级高于 BRIEF 与本文件原稿。**
> 所有「文件:行号」均来自本轮实际 `read`/`grep`/静态扫描（扫描脚本均为 `require` + 纯函数，未启动任何进程）。
>
> ⚠ **行号漂移告警**：本设计写作期间，并行子代理正在改动 `src/`。实测 `domains/router/index.js` 的并原型行
> 在快照间从 758-759 变为 723-724 又回到 758-759；`supervisor.js` 从 160 行变为 174 行，并原型行从 160 移到 80 又回到 160。
> **本文件所有行号取自 §A.4 的一次权威快照，合并时必须以 `git diff` 复核** ——
> 这正是 H 节 **DG-13「门禁不得硬编码行号，只按语义/结构匹配」** 的直接动因。

---

## A. 现状审计

### A.1 文件清单与职责（逐文件：行数 / 当前职责 / 问题）

| 域 | 文件 | 行数 | 当前职责 | 问题 |
|---|---|---|---|---|
| instance | `index.js` | 33 | 组合 + 并原型 + 导出 | 门面行数合规；但 `:31` 并原型（DF-4 生产机制） |
| instance | `core.js` | 397 | 构造/持久化/沙箱目录/探测/视图/运行状态机（22 方法 + 1 getter） | **自称「纯状态/算法」却 require IO**（`:25 node:fs`、`:27 node:os`）→ 违 DF-3 |
| instance | `ops.js` | 449 | CRUD / systemd 启停 / 单实例监督拍 / 兜底定时器（9 方法） | 超 400（DF-2）；16 组 this 跨文件私调 |
| instance | `upgrade.js` | 407 | 沙箱 DSH 安装/检测/升级（8 方法） | 超 400；与本域 core/ops 互调 |
| plugin | `index.js` | 35 | 组合 + 并原型 + 导出 | `:33` 并原型 |
| plugin | `store.js` | 353 | PluginManager 类 + 持久化 + profile/补丁层/overlay/inventory（20 方法） | 类定义与持久化同文件；**反向** `this._nativeTarget()`（`:254`、`:319`）打到 ops |
| plugin | `ops.js` | 361 | 目标解析 + CLI 执行 + install/uninstall/setBundleEnabled（12 方法） | 与 jobs **双向** this 私调 |
| plugin | `jobs.js` | 242 | 作业模型/互斥/变更生效/更新（11 方法） | 与 ops 双向；`:149` 一处调 `_nativeTarget`+`_allSandboxTargets` |
| plugin | `market.js` | 427 | 独立类 PluginMarket（市场索引） | 超 400（DF-2）；但**独立类、零 this 交叉**（本域唯一干净块） |
| relay | `index.js` | 502 | `createRelay` HTTP/WS 反代（顶层函数） | **冒充门面**：名为 index 实为最大实现文件（DF-1 违规） |
| relay | `manager.js` | 504 | LanManager 编排（23 方法） | 超 400；`:55` 直取 `this.instances.instances`、`:50` 借 `this.instances.save()`（跨域隐式契约） |
| relay | `frpmgr.js` | 439 | FrpManager（17 方法） | 超 400；独立类、零 this 交叉 |
| relay | `daemon.js` | 214 | 进程入口 + 快照源 `lanSource`（`:86-89`） | 入口与对象图装配混写；**⚠ 文件名不得改（R5）** |
| relay | `port-segments.js` | 22 | 端口段申报（require 即注入） | 合规（纯数据） |
| router | `index.js` | 763 | 门面 + 持久化 + 维护定时器 + 供应商 CRUD + 状态查询 + 端点监听（42 方法） | **DF-1 头号违规**；`:758-759` 并原型 |
| router | `forward-core.js` | 548 | 转发核心（22 方法，经并原型挂到 RouterService） | 超 400；**反向**依赖门面 `this.log/readBody/canPersist`（`:166,168,217,231,247,273,291,299,315,371,508`） |
| router | `router-ops.js` | 665 | 辅助能力（15 方法，并原型） | 超 400；**反向**依赖门面 `this._save/getProvider`（`:393,448,457,509,517,582,595,607,618,633,646,651,659`） |
| router | `providers/base.js` | 776 | ProviderBase + 11 个具名纯函数导出 | 超 400；**12 个抽象占位**（`:222,243-253`） |
| router | `providers/proxy.js` | 1111 | ProxyProvider（43 方法） | **全仓最大** |
| router | `providers/direct.js` | 47 | DirectProvider | 合规 |
| router | `providers/quota-strategies.js` | 163 | 额度策略 | 合规 |
| router | `switch.js` | 117 | SwitchEngine（切换引擎） | 合规，纯 |
| router | `store.js` | 53 | RouterStore | 合规；但 `:43 canPersist` 与 `index.js:154 canPersist` **同名歧义** |
| router | `proxy-apps.js` | 49 | 反代应用表 | 合规，纯数据 |
| router | `instances/proxy-instance.js` | 102 | ProxyInstance 模型 | 合规（**注意：与沙箱实例域同形不同物**） |
| router | `port-segments.js` | 39 | 端口段 | 合规 |
| router | `daemon.js` | 188 | 进程入口 | 合规，无 this；**⚠ 文件名不得改（R5）** |
| shell | `index.js` | 35 | 聚合导出 | 合规（唯一纯门面） |
| shell | `journal.js` | 150 | 账本 + 状态机 + 健康 | 合规（顶层函数）；含 json 读写 → 纯/IO 需分 |
| shell | `restart.js` | 167 | 版本检测/壳重启 | 合规 |
| shell | `watchdog.js` | 282 | 壳看护 | 合规 |
| 编排 | `app/control/registry.js` | 443 | ManagedRegistry（26 方法） | 超 400（门禁需覆盖 app/） |
| 编排 | `app/native/installer.js` | 806 | 原生安装器 | 超 400 |
| 平台 | `platform/service/ports/index.js` | 567 | 端口注册表 | 超 400 |
| 平台 | `platform/service/log/hub.js` | 492 | 事件汇聚 | 超 400 |
| 平台 | `platform/distribution/index.js` | 690 | DistributionManager | 超 400 + index.js 超 150 |

**全仓 >400 行共 16 个文件**（11 个在 `domains/`），251–400 行 11 个。

### A.2 耦合图（require 边 + this 跨文件调用边，逐条列出）

#### A.2.1 域内 require 边（剥注释后静态扫描）

| 域 | 边 |
|---|---|
| instance | `index.js:26 → core.js`、`:27 → ops.js`、`:28 → upgrade.js` |
| plugin | `index.js:28 → store.js`、`:29 → ops.js`、`:30 → jobs.js` |
| relay | `daemon.js:53 → manager.js`、`manager.js:12 → frpmgr.js`、`manager.js:422 → index.js`（函数内惰性 require）、`index.js → port-segments` |
| router | `index.js` 12 处（`:12,13,14,15,16,17,19,82,595,684,758,759,761`）、`providers/base.js:9`、`direct.js:8`、`proxy.js:13,15,16`、`quota-strategies.js:27`、`forward-core.js:10`、`router-ops.js:6,8,11`、`switch.js:10` |
| shell | `index.js:29,31`、`restart.js:15,99` |

**require-only 图环数 = 0**（五域全部 DAG）—— **与 R1 一致**。R1 实测 router 27 条 require 边 0 环；本设计独立复算得五域 0 环。
**不得再沿用 BRIEF §0 / 本文件原稿「循环 require」的说法。**

#### A.2.2 域内 this 跨文件调用边（X 定义在本域**另一个文件**）

口径：正则收集本文件 `this.X(`，排除本文件已定义名（并剔除 `if/for/while/return/constructor` 等语言关键字），
再看同域其他文件是否定义 X。

| 域 | 跨文件方法数 | 调用点 | 与 R1 对照 |
|---|---|---|---|
| instance | 22 | **46** | — |
| plugin | 21 | **34** | — |
| router | 16 | **47** | R1 的「18 方法/48 处」计入了 `{base,proxy}` 同名对 |
| relay | **0** | 0 | ✅ |
| shell | **0** | 0 | ✅ |
| **合计** | **59** | **127** | — |

全部边（文件→文件 #方法 @行）：

- **instance（22 组 / 46 点）**：`core→upgrade` #_readInstalledVersion@239 #_taskStateToView@263；
  `ops→core` #save@130,162,286,293,343,428 #sandboxRoot@205 #effectiveCommand@252 #_probeState@255,360
  #sandboxDataDir@268 #sandboxInstallDir@269,326 #_startLanForInstance@294 #_ensureSandboxDirs@325
  #_stopLanForInstance@344 #_setRunning@373,401 #_restartInstance@376,402,408,421,422 #_failInstance@380,391,395 #_setStopped@409；
  `ops→upgrade` #_installSandbox@328；
  `upgrade→core` #sandboxInstallDir@68,167,235 #_ensureSandboxDirs@69 #save@75,87,104,110,121,146,354,368 #_probeState@243；
  `upgrade→ops` #stopInstance@248 #startInstance@295,309
- **plugin（21 组 / 34 点）**：`jobs→ops` #_nativeTarget@149 #_allSandboxTargets@149 #resolveTargets@186 #_runCli@224,226；
  `jobs→store` #installedOn@152,168,188,216；
  `ops→jobs` #_createJob@179,226 #_finishJob@186,233 #_withScopeLock@195,242 #_targetRunning@205,351,353 #_applyPluginChange@276；
  `ops→store` #isProtected@216,291 #installedOn@221,304 #_removeFromProfileBundles@251 #_scrubPluginLayers@269
  #_enqueueBundleOp@287 #_patchEntryIdsForPlugin@310 #_readHomePatch@311 #_writeHomePatch@329,337 #saveOverlayEntries@345；
  `store→ops` #_nativeTarget@254,319 #_allSandboxTargets@254
- **router（16 组 / 47 点）**：`forward-core→index` #log@166,217,231,247,273,291,299,315,371 #readBody@168 #canPersist@508；
  `index→forward-core` #proxyFor@440 #_loadTotals@546,603 #getUsage@558；
  `index→router-ops` #refreshProxyUpdateInfo@215,223 #refreshOfficialUsageAll@216 #refreshOfficialPricingAll@217,233；
  `proxy→base` #_persist@247,261,277,351,424,451,765,772,779,786 #accountQuotaSummary@791 #applyDetection@795
  #_isCreditsLow@819 #_windowExhausted@823；
  `router-ops→index` #_save@393,457,509,582,607,618,646 #getProvider@448,517,595,633,651,659
- **relay / shell**：0

#### A.2.3 组合图环（require ∪ this）—— DF-5 的真实靶子（R1）

| 域 | require-only 环 | this 图 SCC | 成因 |
|---|---|---|---|
| instance | 0 | **1 个三节点 SCC** {core, ops, upgrade} | `index.js:31` `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods)` |
| plugin | 0 | **1 个三节点 SCC** {store, ops, jobs} | `index.js:33` `Object.assign(PluginManager.prototype, opsMethods, jobsMethods)` |
| router | 0 | **2 个 SCC** | ① {index, forward-core, router-ops} ← `index.js:758-759` 并原型；② {providers/base, providers/proxy} ← **非并原型，见下** |
| relay | 0 | 0 | — |
| shell | 0 | 0 | — |

**SCC ② 的成因必须区分（本设计的实测修正）**：`{base, proxy}` 是 **extends 继承**，不是并原型。
`providers/base.js:243-253` 的 11 个 `startInstance/stopInstance/...` 是**抽象契约占位**
（方法体 throw `must be implemented by process-pool provider`），真实实现在 `providers/proxy.js:76,372,386,456,700,712,1077`。
故 `base.js:307 this.stopInstance(acc.instance)` 是**继承内的多态模板方法调用**（父类调子类覆写）——
**合法的 OO 惯用法，不是隐式耦合**。但它会落入「X 未在本文件定义」的朴素判据 →
判据必须能区分「抽象占位（父类声明、子类实现）」与「私有方法跨模块私调」。**处理见 H.4 DG-4d。**

#### A.2.4 跨域消费边（域间契约现状）

**域间直接 require = 0**（`domains/` 内无任何文件 require 另一个域，与 DS-G1 一致）。

**隐式耦合 7 类**（无接口声明，靠「恰好有这个属性」）—— 本设计的打击目标：

| # | 耦合 | 证据（文件:行） | 应有形态 |
|---|---|---|---|
| ① | plugin 遍历 instance 内部数组 | `plugin/ops.js:74` `((this.instances && this.instances.instances) \|\| []).filter(x => x.domain === 'sandbox')`；`:85` 同式 `.find` | instance 端口 `listTargets()` |
| ② | plugin 调 instance 私有目录算法 | `plugin/ops.js:51` `this.instances.sandboxDataDir(inst)`、`:52` `sandboxInstallDir`；`app/control/specs.js:47` `sandboxRoot` | 端口 `projectTarget(id)` |
| ③ | plugin 调 instance 生命周期 | `plugin/jobs.js:91 probeInstance`、`:104 stopInstance`、`:108 startInstance` | 端口方法（签名进契约） |
| ④ | relay 直取数组 + 借别人 save | `relay/manager.js:55 this.instances.instances`、`:50 this.instances.save()` | 端口 `listSandboxes()` + 显式 `persist()` |
| ⑤ | relay 快照源伪装成 InstanceManager | `relay/daemon.js:86-89` `const lanSource = { instances: [], save(){} }` | 显式端口的适配器 |
| ⑥ | app/api 全域读 instance 数组 | `app/control/specs.js:67`、`app/control/instance-adapter.js:42`、`app/daemons/runtime.js:70`、`app/session/shutdown.js:117`、`app/audit/orphan-scan.js:40`、`app/facade/main.js:73`、`app/assembly/bootstrap.js:108`、`api/domains/instances.js:153`、`app/control/adapters.js:103` | 统一 `list()`/`get()` |
| ⑦ | 域向上依赖编排层具体形状 | `app/assembly/compose.js:272,276,282,287,293,294` 六处裸回调赋值 | `hooks` 端口一次注入 |

**⚠ 纠正任务书所述的一条不存在的耦合**：任务书写「`router` 调 `instances` 的 `sandboxRoot` 等」。
实测 **router 域对 instance 域零依赖**；`sandboxRoot` 全域只有 3 个消费者：`app/control/specs.js:47`、
`domains/instance/core.js:190`（定义）、`domains/instance/ops.js:205`。
router 里的 `this.instances`（`providers/base.js:771`、`providers/proxy.js:60,78,82,85,540,820,954,1054`）是 **ProxyInstance**
（router 自有模型 `instances/proxy-instance.js`）—— **同形不同物**。
按错误前提会设计出伪契约，必须在 E 节澄清并写入 DG-10 的排除规则。

### A.3 病症清单（对照 §0 四类病症 + R1/R6/R7 新增三类）

**① 巨型文件（§0-1 / DF-2）** —— 11 个域内文件 >400：`instance/ops.js` 449、`instance/upgrade.js` 407、`plugin/market.js` 427、
`relay/frpmgr.js` 439、`relay/index.js` 502、`relay/manager.js` 504、`router/forward-core.js` 548、`router/index.js` 763、
`router/providers/base.js` 776、`router/providers/proxy.js` 1111、`router/router-ops.js` 665。

**② this 隐式耦合（§0-2 / DF-4）** —— 127 处跨文件私调（A.2.2 全表）。附加两例：
- **函数值属性被当方法调**：`router/router-ops.js:147,177,182 this._ccLoginReject(...)`、`:184 this._ccLoginResolve(...)` ——
  这两个名字**在任何文件都无方法定义**，是 `:211` `new Promise((resolve,reject) => { this._ccLoginResolve = resolve; ... })` 赋上去的函数值。
  判据若「未定义即报错」会误判 → 必须走契约豁免或改为显式状态对象（见 E.3）。
- **同名歧义**：`router/index.js:154 canPersist` 与 `router/store.js:43 canPersist` 同名，`forward-core.js:508` 消费 → bare `this.X()` 指向不明。

**③ 循环依赖（§0-3 / DF-5）—— ★ 按 R1 重述**
- require-only 图 **0 环**（A.2.1）。BRIEF §0 的「循环 require」表述**错误**；本文件原稿沿用该表述的部分**已作废**。
- 真实病症是 **this 图的 SCC**：3 个并原型 SCC（instance {core,ops,upgrade}、plugin {store,ops,jobs}、router {index,forward-core,router-ops}）
  + 1 个继承 SCC（router {base,proxy}，**合法**）。
- **DF-5 正确含义（R1）**：**禁止把两个文件的方法合并到同一个 `this` 上**（`Object.assign(X.prototype, ...)`），
  而不是「修 require 环」。否则改名后 require 图仍是 DAG，而 DF-4/DF-6 依旧被违反 —— 那正是 BRIEF §2 所斥的「文件搬家」。
- **取证陷阱（R1）**：`daemon.js` 注释里的 require 是说明文字，朴素扫描会伪造「daemon 自环」→ **扫描必须先剥注释**。
  本设计的 `strip` 实现见 H.4；已在 A.4 用「无 strip 命中 `daemon.js:11`、带 strip 不命中」反向验证。

**④ 职责错位（§0-4 / DF-1 / DF-3）**
- `relay/index.js` **名为门面，实为最大实现文件**（502 行，`createRelay`）—— 五域中唯一「index 不是门面」的域。
- `router/index.js` 763 行 = 门面 + 持久化 + 定时器 + CRUD + 视图。
- `plugin/store.js` = 类定义 + 持久化 + profile 补丁 + overlay + inventory。
- `instance/core.js` 自称「纯状态 / 算法」（`:5`）却 require `node:fs`/`node:os`（`:25,27`）并写盘（`:171 save` → `:181 fs.writeFileSync`）—— **DF-3 直接违规且文件名与内容不符**。
- `relay/daemon.js` 进程入口内联对象图装配（`:86-89 lanSource`、`:91 new LanManager`）。

**⑤ 组合手法（R1/R6 新增）—— `Object.assign` 并原型是 127 处隐式 this 的「生产机制」**
实测**剥注释后 6 处**（与 R6 判据一致）：

| 位置 | 形态 | R6 判据① | 右值类型 |
|---|---|---|---|
| `domains/instance/index.js:31` | `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods);` | ✅ HIT | **变量** |
| `domains/plugin/index.js:33` | `Object.assign(PluginManager.prototype, opsMethods, jobsMethods);` | ✅ HIT | **变量** |
| `domains/router/index.js:758` | `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods);` | ✅ HIT | 内联 require |
| `domains/router/index.js:759` | `Object.assign(RouterService.prototype, require('./router-ops').auxMethods);` | ✅ HIT | 内联 require |
| `supervisor.js:160` | `if (mod && mod.methods) Object.assign(Supervisor.prototype, mod.methods);` | ✅ HIT | **变量** |
| `supervisor.js:161` | `if (mod && mod.accessors) Object.defineProperties(Supervisor.prototype, mod.accessors);` | ✅ HIT | **变量** |

（`instance/index.js:20`、`plugin/index.js:22`、`supervisor.js:21` 是**注释**，剥注释后不计 —— R6 已实测这三处为注释假阳性。）

**⑥ facade 混写动作（R7 新增）**

| 文件 | 行数 | 只读视图方法 | **写动作方法（须下沉）** |
|---|---|---|---|
| `app/facade/router.js` | 116 | `routerDaemonActive@9` `routerStatusView@25` `routerProviders@37` `routerStatus@51` `routerDomainSummary@58` | **`setRouterRunning@78`** |
| `app/facade/main.js` | 100 | `dshMainView@14` | **`patchDshMain@41`** |
| `app/facade/lan.js` | 64 | `listLan@14` `frpStatus@49` | **`setLanFrp@44`** **`lanFrpc@54`** **`syncFrpc@59`** |
| `app/facade/ports.js` | 80 | `listPorts@17` `_portActives@65` | 无 |
| `app/facade/status.js` | 59 | （聚合视图） | 无 |

**危害（R7 理由）**：门面可写 → api 经门面直接改状态，**绕过生命周期/目录/事件记账**。
例：`app/facade/lan.js:45 setLanFrp` 直调 `lan.setFrp`（或经 ctl），绕开 `managedObjects` 目录申报与
`lan_frp_changed` 事件（后者在 `relay/manager.js:123` 内，仅当走 LanManager 才发出）；
`app/facade/main.js:41 patchDshMain` 直改 main 元数据，绕开 `_syncDshLifecycleView`。

**⑦ 抽象占位 vs 跨文件私调（本设计实测新增，用于判据防误报）**
`router/providers/base.js` 有 **12 个抽象方法声明**（`:222 detectAccount` + `:243-253` 十一个 process-pool 能力），
其中 11 个由 `providers/proxy.js` 实现（`:76,372,386,456,700,712,1077` 等）。
`base.js:307 this.stopInstance(acc.instance)` 是**继承内的多态调用** —— 合法。判据必须显式识别该形态（DG-4d）。

### A.4 权威行号快照与取证验证（防「凭印象」）

**快照命令与结果**（`node --input-type=commonjs`，只读）：

| 断言 | 实测 |
|---|---|
| `router/index.js` 行数 / 并原型行 | **763** / `758-759`（`761 presets`、`763 module.exports`） |
| `supervisor.js` 行数 / 并原型行 | **174** / `160`（`Object.assign`）、`161`（`defineProperties`）、`166`（`defineProperty` 单项）；`:21` 为注释 |
| `instance/index.js` | 33 行，`:31` 并原型，`:20` 注释 |
| `plugin/index.js` | 35 行，`:33` 并原型，`:22` 注释 |
| `instance/core.js` IO require | `:25 node:fs`、`:27 node:os` |
| `plugin/ops.js` 数组穿透 | `:74`、`:85` |
| `plugin/jobs.js` 生命周期调用 | `:91 probeInstance`、`:104 stopInstance`、`:108 startInstance` |
| `relay/manager.js` | `:50 this.instances.save()`、`:55 this.instances.instances` |
| `router/providers/base.js` 抽象占位 | `:222`、`:243-253`（共 12） |
| `base.js:307` | `try { this.stopInstance(acc.instance); } catch {}` |
| **strip 必要性** | 不带 strip：`6+3=9` 命中（3 处注释假阳性）；带 strip：**6** 命中 —— 与 R6 一致 |
| **R6 判据反向样本** | `Object.assign(X.prototype, mod.methods)` → HIT；`Object.defineProperties(X.prototype, require('./x'))` → HIT；`Object.assign({}, a)` → MISS ✅ |
| **既有门禁基线** | `node --require ./test/_preload.js test/directory-structure-gate-test.js` → **12 passed / 0 failed** |
| **行号漂移实测** | 写作期间观察到 `router/index.js` 并原型行 `758→723→758`、`supervisor.js` `160 行→174 行`、并原型 `160→80→160` → 已记入文件头告警与 DG-13 |


---

## B. 功能切面（★ 设计核心）

> 本专题的「功能」不是一个业务域，而是**三条横切能力**：
> **(B.1) 域间契约** —— 把五域之间「恰好有那个属性」的隐式耦合，变成**具名端口**；
> **(B.2) 结构门禁** —— 把 DF-1..DF-7 与契约本身，变成**可自动校验且经反向自检**的判据；
> **(B.3) facade 只读化门禁（R7）** —— 把「门面只允许只读视图」变成可判定规则。

### B.1 域间契约

#### B.1.0 契约的承载形态

| 方案 | 形态 | 评价 |
|---|---|---|
| **A. 数据声明** | `domains/<域>/contract.js` 导出 `{ domain, exports, classApi, deps, hooks, pure }` 纯数据 | ✅ 与既有先例同构（`api/deps.js:14-19` 明确「只声明，不强制」）；零运行期行为；门禁可静态比对 |
| **B. 具名端口** | 消费方只调「结构上更窄」的端口对象（ctor 注入） | ✅ 消除遍历内部数组；与 §3 手法 B 一致 |
| C. TypeScript interface | 类型系统强制 | ✗ 本仓无 TS 构建链 |

**裁决**：A 立即可落地（门禁先跑），B 是迁移目标（DF-4 终点）。C 不做。

#### B.1.1 契约总表（功能块）

| 功能块 | 职责 | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| instance 端口 | 沙箱实例的**唯一**查询/生命周期入口 | 实例 id / patch | 值对象视图（非内部数组引用） | systemd 启停、instances.json 写 | 否 |
| instance hooks（出站） | 实例变化时反向通知编排层 | 实例 / id | — | 回调 | 否 |
| relay 端口 | 反代/frp 编排 + 对账 | 实例视图清单（来自端口） | 代理列表 / frp 状态 | relay listen、frpc 进程、ports-lan.json | 否 |
| relay 依赖端口 | 只要「实例视图 + 持久化 + 令牌」 | — | `listSandboxes()`/`persist()`/`tokenOf()`/`mainOf()` | — | 否 |
| plugin 端口 | 插件安装/卸载/启停/更新 | target 串 / 包名 | job 视图 | pnpm CLI、profile 写 | 否 |
| plugin 依赖端口 | 只要「沙箱目标投影 + 生命周期」 | id | `TargetView{id,name,installDir,dataDir}` | — | 否 |
| router 端口 | 中转服务生命周期 + 供应商/账号 | provider 定义 | 状态视图 | providerApi 监听、providers.json 写 | 否 |
| shell 端口 | 壳更新安全网（观察/审计） | 壳 identity/账本 | status/evaluate 结论 | 账本 json 读写、npm 查询 | 否 |
| **契约声明（横切）** | 每域 Public API / Dependencies 的数据化 SSOT | — | `contract.js` | 无 | 是 |
| **结构门禁（横切）** | DF-1..7 + 域间契约 → 失败即红 | 源码树 | PASS/FAIL | 无（只读） | 是 |
| **facade 判据（横切，R7）** | `app/facade/*` 只读，写动作在 `app/domain-actions/*` | 源码树 | PASS/FAIL | 无 | 是 |
| **端口形状断言（横切）** | 装配期校验端口实现者具备声明成员 | 端口对象 | throw / ok | 无 | 是 |
| **组合图分析器（横切）** | require ∪ this 图 + SCC + 剥注释 | 源码树 | 边集/环集 | 无 | 是 |

#### B.1.2 Public API 与 Dependencies —— 逐域

> 记法：`⇒` 本域提供（Public API）；`→` 本域依赖。全部条目来自实测（行号见 A.4）。

##### B.1.2.1 `domains/instance`

**Public API**（`index.js:33` 导出 `{ InstanceManager }`）

    class InstanceManager ⇒
      # 查询（值语义，返回派生视图，不返回内部数组引用）
      list(): InstanceView[]                     // core.js:237
      get(id): InstanceView | null               // ★ 新增（现由消费方 .find 冒充，见 A.2.4 ⑥）
      listTargets(opts): TargetView[]            // ★ 新增（替代 plugin/ops.js:74 遍历）
      projectTarget(id): TargetView | null       // ★ 新增 {id,name,installDir,dataDir,rootPath}（替代 ops.js:51-52 + specs.js:47）
      # 生命周期
      addInstance / removeInstance / updateInstance   // ops.js:83,139 / core.js:211
      startInstance(id,opts) / stopInstance(id)        // ops.js:307 / ops.js:337
      supervise(id)                                    // ops.js:355
      probeInstance(id): {running,pid,...}             // core.js:312
      checkUpdate / upgradeInstance / upgradeStatus     // upgrade.js:191/216/384
      save()                                            // core.js:171

**Dependencies**（ctor，现见 `core.js:39-70`）

    → dir                            core.js:40
    → logger / events                core.js:41-42
    → dist                           core.js:43
    → tasks                          core.js:75 附近
    → tokenService                   core.js:76 附近（只登记源，不持令牌）
    → dshBin                         core.js:44
    → service                        core.js:48（平台抽象，禁直接 systemctl）
    → hooks: InstanceHooks           ★ 出站端口，替代 6 个裸回调：
        onRemoteChange(inst) / onRemove(id) / onInstanceStart(inst) /
        onInstanceStop(inst) / onCreate(inst) / onDestroy(id)
        // 现值：core.js:225,322,327 + ops.js:132,215,216
        // 装配处：app/assembly/compose.js:272,276,282,287,293,294

##### B.1.2.2 `domains/relay`

**Public API**（`index.js:502` 导出 `{ createRelay }`；`manager.js` 导出 `{ LanManager }`）

    createRelay(targetHost, targetPort, opts) ⇒ http.Server   // index.js:145（setToken:491 / setDshToken:484 / status:497）
    class LanManager ⇒
      list:65 / setFrp:103 / frpStatus:128 / frpAction:143 / syncFrpc:173
      reconcile:203 / syncProxy:293 / removeProxyForInstance:263
      instanceStart:394 / instanceStop:405 / applyToken:490 / shutdown:478 / localAddresses:36

**Dependencies**

    → logger / events / configPath / stateDir      manager.js:16-19
    → instances: InstanceSource  ← ★ 收窄（manager.js:18 现为整个 InstanceManager）
        { listSandboxes(): InstanceView[], save(): void }
        替代：manager.js:55 this.instances.instances；manager.js:50 this.instances.save()
    → mainOf(): InstanceView      manager.js:20
    → persist(): void             manager.js:21（daemon.js:88 save(){} 的 noop 是本端口的另一实现）
    → tokenOf(id): string         manager.js:32

##### B.1.2.3 `domains/plugin`

**Public API**（`index.js:35` 导出 `{ PluginManager, PROTECTED }`）

    PluginManager ⇒
      resolveTargets:80 / install:175 / uninstall:215 / setBundleEnabled:283   // ops.js
      installStatus:68 / checkUpdates:148 / update:184                          // jobs.js
      inventory:230 / readManifest:248 / listInstalled:252 / installedOn:210 / isProtected:338 / saveOverlayEntries:223  // store.js
    PROTECTED: Set<string>                                                      // store.js:22

**Dependencies**

    → dshBin / profileName / profileDir / overlayFile / dshPort   store.js:26-30
    → targets: InstanceTargetPort   ← ★ 收窄（store.js:31 现为整个 InstanceManager）
        { listSandboxTargets(): TargetView[], projectTarget(id): TargetView|null,
          probeInstance(id): {running:boolean,pid:number|null},
          startInstance(id): Promise<{ok:boolean,installing?:boolean,error?:string}>,
          stopInstance(id): {ok:boolean,error?:string} }
        替代：ops.js:74,85（遍历）、ops.js:51-52（目录）、jobs.js:91,104,108（生命周期）
    → tasks / logger / events / dist                              store.js:33-36
    → onNativeRestart(): Promise|{ok}                             store.js:32（jobs.js:125 消费）

##### B.1.2.4 `domains/router`

**Public API**（`index.js:763` 导出 `{ RouterService }`；静态 `RouterService.presets()` 见 `:761`）

    class RouterService ⇒
      start:159 / stop:182 / stopAndWait:188 / stopAllInstances:201
      status:545 / domainSummary:566 / portsView:594
      listProviders:601 / addDirectProvider:683 / addProxyProvider:701 / removeProvider:717 / getProvider:749
      handleForProvider:433 / activateProvider:453 / deactivateProvider:480
      setPersistEnabled:144 / canPersist:154
      + forwardMethods（并原型 index.js:758）: proxyFor / writeThrough / recordUsage / getUsage
      + auxMethods（并原型 index.js:759）: commandcodeLoginStart/Wait, proxyApps,
          refreshProxyUpdateInfo / applyProxyUpdate / proxyUpdateStatus,
          refreshOfficialUsageAll / refreshProviderQuota / refreshOfficialPricingAll,
          setProviderKeys / setSelectedProxyKey / switchToKey / addProxyKey / removeProxyKey / discardAccount

**Dependencies**

    → config / logger / events / dist / tasks / providerFile / usageTotalsFile   index.js:24-30
    → portsFile（可选，端口注册表隔离）                                          index.js:37
    ⇒（对 instance 域）**零依赖** ← 见 A.2.4 纠正

##### B.1.2.5 `domains/shell`

**Public API**（`index.js:35` 导出 10 项，逐字固定）：
`status / evaluate / health / markPending / identity / readJournal / shellDir`（journal.js）、
`checkUpdate / restartShell / SHELL_RELEASE_PKG`（restart.js）。
**Dependencies**：`→ logger/events/dist`；引 `shared/version`（`restart.js:17`）、`platform/service/state-root`（`journal.js:34`）。无域间依赖。

#### B.1.3 应**消除**的耦合清单（逐条给替代）

| # | 现状 | 为何是病 | 目标替代 |
|---|---|---|---|
| ① | `plugin/ops.js:74,85` | 遍历**别人的内部可变数组** | `targets.listSandboxTargets()` / `projectTarget(id)` |
| ② | `plugin/ops.js:51,52`；`app/control/specs.js:47` | 目录布局是 instance 私有算法，被三方各自重组 | `projectTarget(id) ⇒ {rootPath,dataDir,installDir}` |
| ③ | `plugin/jobs.js:91,104,108` | 方法名可接受但**无接口声明**；返回形状只存在于调用点注释 | 端口 + `contract.js` 签名声明 |
| ④ | `relay/manager.js:55,50` | 同 ①，且借「实例管理器的 save」当自己的持久化 | `listSandboxes()` + 显式 `persist()` |
| ⑤ | `relay/daemon.js:86-89` | **鸭子类型伪装**（形状对、语义错：save 是 noop） | `class RelayInstanceSource implements listSandboxes()` |
| ⑥ | app×9 + api×1（见 A.2.4 ⑥） | 编排/传输层读域内部数组 | 一律 `instances.list()`/`get(id)` |
| ⑦ | `app/assembly/compose.js:272,276,282,287,293,294` | 域**向上**依赖编排层具体形状 | `hooks` 端口一次注入 |
| ⑧ | 6 处 `Object.assign(X.prototype, ...)`（A.3 ⑤） | 抹掉模块边界，是 127 处隐式 this 的**生产机制** | 手法 A/B/C 消解后删除；DG-8 兜底（R6） |
| ⚠ | 「`router` 调 `instances.sandboxRoot`」 | **不存在**（A.2.4 纠正） | **不做**（写入 E.3 澄清 + DG-10 排除规则） |

#### B.1.4 端口检查（判据化）

| 断言 | 时机 | 实现要点 |
|---|---|---|
| `contract.exports` ≡ `index.js` 实际 `module.exports` 键 | 门禁（静态） | 解析三种导出形态（`instance/index.js:33` 单键 / `shell/index.js:35` 跨行 10 键 / `relay/daemon.js` 无导出）；双向一致 |
| `contract.classApi.C` ≡ `C` 实际方法集 | 门禁（静态） | 解析 class 体方法 + `Object.assign(C.prototype, ...)` 的右侧导出键（迁移期容忍）+ `C.prototype.m = ` 赋值 |
| `contract.deps` 的键 ≡ ctor 内 `opts.*` 读取集 | 门禁（静态） | 解析 `constructor(opts)` 体内 `opts.\w+`；双向一致 |
| 消费方访问的成员 ⊆ 目标域 PUBLIC_API | 门禁（静态） | 建「对象名 → 域」映射（`this.instances`/`host.router`/`sup.pluginManager`…），**按文件前缀排除 `domains/router/`**（ProxyInstance 同名） |
| 端口实现者具备声明成员 | 装配期（运行） | `assertPort(name, impl, members)`，缺成员 fail-fast（复用 `api/deps.js:110-116` 的「启用条件 2」纪律） |

### B.2 facade 只读化（R7）

| 功能块 | 职责 | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| facade 只读视图 | 给 api 提供聚合读视图（daemon/内嵌两模式统一） | ctx/id | 视图对象 | 允许既有「读触发对账」的副作用（见下注） | 否 |
| domain-actions 写动作 | 各域写入口，**经生命周期/目录/事件记账** | 动作 + 参数 | 结果 | 状态变更 | 否 |
| **facade 判据（DG-14）** | 检测 `app/facade/*` 是否含写动作 | 源码树 | 违规清单 | 无 | 是 |

**⚠ 判据设计的真实难点（必须显式处理，否则误报）**：`app/facade/lan.js:14 listLan()` 名为只读，却在 `:41` 调
`this.lan.list()`，而 `relay/manager.js:65 list()` 内部第一行就是 `:66 this.reconcile().catch(() => {})` ——
**「读」触发对账副作用**；`app/facade/ports.js:17 listPorts` 亦触发端口激活探测。
故 DG-14 **不能**按「facade 内是否出现动词」判定，必须按**静态可判的形态**：
① 调用名命中动作白名单（`set*`/`patch*`/`install*`/`apply*`/`toggle*`/`sync*`/`start*`/`stop*`/`restart*`）；
② 或调用目标方法在**域契约**里被标注为 `write`。
**例外清单**（必须写明理由，照 `layering-and-dependency-gate-test.js:236-248` 的 L-2b 纪律）：
- `listLan → lan.list()`（读触发 reconcile 对账，域契约标注 `read-with-side-effect`）；
- `listPorts → 端口探测`（同上）。

这样判据既不误报既有只读视图，又能抓住 `setRouterRunning`/`patchDshMain`/`setLanFrp`/`lanFrpc`/`syncFrpc` 五个真写动作。

### B.3 域结构门禁（`test/domain-structure-gate-test.js`）

#### B.3.0 设计原则（从既有门禁的教训来）

现行 `directory-structure-gate-test.js` 的风格：单一 `check(name, cond, evidence)` 收集器（`:34-38`）、
每个判据紧跟一条**反向自检**（`:89-93, 126-128, 146-155`），结尾统一 `process.exit`（`:198-199`）。
**必须继承三条纪律**：
1. **判据本体抽成纯函数**，正向检查与反向自检**共用同一个函数**（现行 DS-G4 的 `domainWordsIn` 即典范，`:136`）；
2. 反向样本必须**真的与匹配器有交集**（`:146-154` 明确记录了旧样本不含任何域名词 → DS-G8 假 PASS 的教训）；
3. 门禁**不可空转**：加「扫描确实产出非空集」的存在性断言（`layering-and-dependency-gate-test.js:282-283` 的 `edges.length >= 30` 是同一手法）。

DG-1..DG-14 覆盖 DF-1..DF-7 + 域间契约 + R7。**每条都给了「实现思路 + 反向自检」。**

| 判据 | 覆盖 | 断言（当前实测值 → 初值预期） |
|---|---|---|
| **DG-1** | DF-1 | 每域 `index.js` ≤150 行（**R3 取严**）且不含业务逻辑关键词 | instance 33 ✓ / plugin 35 ✓ / shell 35 ✓ / **relay 502 ✗** / **router 763 ✗** → 2 FAIL |
| **DG-2** | DF-2 | `src/**/*.js` ≤400 行（**R3 取严**） | 16 个 ✗（11 在 domains） |
| **DG-3** | DF-3 | 声明为纯的文件不得 require IO 模块 | `instance/core.js` ✗ → 1 FAIL |
| **DG-4** | DF-4 | 域内跨文件 `this.X()` = 0（含 DG-4b/c/d 三条子判据） | 127 处 ✗（instance 46 / plugin 34 / router 47） |
| **DG-5** | DF-5 | 域内 this 图无 **mixin 造成**的 SCC；require 图无环 | mixin SCC 3 个 ✗；require 环 0 ✓ |
| **DG-6** | DF-6 | 每个非门面/非入口域文件可 `require` 且零顶层副作用 | 待 M5 实测 |
| **DG-7** | DF-7 | 域内依赖方向单调（`index→ops/scheduler→core/policies→model/store`） | `forward-core/router-ops→index`、`plugin/store→ops` 反向 ✗ |
| **DG-8** | DF-4 机制（**R6**） | 剥注释后无 `Object.(defineProperties\|assign)(<x>.prototype, …)` | **6 处 ✗** |
| **DG-9** | 契约 | `contract.js`（`exports`/`classApi`/`deps`）与实际导出/ctor 读取 **双向一致** | 新文件，初值「未建即 FAIL」 |
| **DG-10** | 契约 | 消费方成员访问 ⊆ 目标域 PUBLIC_API | 初值待迁移，先红后绿 |
| **DG-11** | 契约 | 域外禁止 `.instances.instances` 内部数组穿透 | 多处 ✗ |
| **DG-12** | 全域 | 门禁非空转（存在性下界 + 反向自检完备） | 12+2 条 |
| **DG-13** | 门禁卫生 | 门禁不得硬编码**行号**（只允许语义/结构匹配）；行号仅作证据输出 | N/A |
| **DG-14** | **R7** | `app/facade/*` 无写动作；写动作在 `app/domain-actions/*` | 5 处 ✗（router 1 / main 1 / lan 3） |

#### B.3.1 DG-1 门面纯化（DF-1）

```js
// 判据本体（纯函数）
function facadeViolations(files, maxLines = 150) {
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const src = strip(raw);                       // ★ 必须先剥注释（R1/R6 教训）
    const n = countLines(raw);                    // 口径见 B.3.13
    const banned = ['http.createServer', 'fs.writeFileSync', 'setInterval(']
      .filter((k) => src.includes(k));
    if (n > maxLines || banned.length) out.push({ file: f, n, banned });
  }
  return out;
}
```
- **为何「不含业务逻辑」也要查关键词**：仅行数可被「压缩成一行」规避；`relay/index.js` 502 行里有 `http.createServer`（`index.js:145 createRelay`），`router/index.js` 有 `setInterval`（`:213 _startMaintenance`）。两条一起查才闭环。
- **R3 取严**：阈值 **150/400**（不采纳旧 SSOT 的 200/450）。
- **反向自检**：① 151 行样本命中；② 含 `http.createServer` 的 5 行样本命中；③ 当前合规域（instance/plugin/shell index）返回空 —— **双向证明有分辨力**（非恒真、非恒假）。

#### B.3.2 DG-2 单文件上限（DF-2）

```js
function oversized(files, maxLines = 400) {
  return files.map((f) => ({ f, n: countLines(fs.readFileSync(f, 'utf8')) }))
              .filter((x) => x.n > maxLines);
}
```
- **反向自检**：① 401 行样本命中、400 行样本**不**命中（边界 ±1）；② 真实命中数 ≥ 16（常数表，防判据退化静默变绿）。

#### B.3.3 DG-3 纯/IO 分离（DF-3）

```js
const IO_MODULES = ['node:fs','node:fs/promises','node:net','node:child_process','node:http',
                    'node:https','node:tls','node:dns','platform/os','platform/service/ports'];
const IO_RE = (m) => new RegExp("require\\(['\"]" + m.replace(/[/:]/g, '\\$&') + "['\"]\\)");
function impureUnits(units) {          // units 来自 contract.pure 声明的文件清单
  const out = [];
  for (const [file, mustBePure] of Object.entries(units)) {
    if (!mustBePure) continue;
    const src = strip(fs.readFileSync(path.join(SRC, file), 'utf8'));
    const hits = IO_MODULES.filter((m) => IO_RE(m).test(src));
    if (hits.length) out.push({ file, hits });
  }
  return out;
}
```
- **必须由 `contract.pure` 显式声明，不能按文件名猜**（`instance/core.js:5` 自称纯实则写盘）。门禁只对声明的文件负责，声明本身由 `contract.js` 承载 → 与 DG-9 同源。
- **反向自检**：① `"const fs = require('node:fs');"` 必命中；② `"const x=require('./y');"` 必不命中；③ 断言对真实源码命中 ≥1（`instance/core.js`）。
- **当前违规**：`domains/instance/core.js`（`:25 node:fs`、`:27 node:os`）。它的 `sandboxRoot`/`sandboxDataDir`/`sandboxInstallDir`（`:190,192,194`）是**纯路径计算**，`save()`（`:171`）与 `load()`（`:120`）才是 IO → 切法见 C/E。

#### B.3.4 DG-4 零隐式 `this` 跨文件（DF-4）★ 最难的判据

**识别算法（三步，全部静态，无执行）**

```js
// step1 每个文件「定义了哪些方法名」—— 必须同时认三种定义形态
function definedNames(src) {
  const s = new Set(); let m;
  const reClass = /^\s{2,6}(?:async\s+)?(?:get\s+|set\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;  // ① class 体
  while ((m = reClass.exec(src))) s.add(m[1]);
  const reObj = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;                                // ② 对象字面量方法
  while ((m = reObj.exec(src))) s.add(m[1]);
  const reFn = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;                                               // ③ 顶层 function
  while ((m = reFn.exec(src))) s.add(m[1]);
  for (const n of (CONTRACT_HOOKS[rel] || [])) s.add(n);                                                 // ④ 契约豁免
  for (const n of KEYWORDS) s.delete(n);              // if/for/while/return/constructor…
  return s;
}
const CALL = /this\.([A-Za-z_$][\w$]*)\s*\(/g;        // step2 调用点
// step3 跨文件判定：本文件未定义 且 同域其他文件定义 → 违规；再按 DG-4d 分类
```

**DG-4b 契约豁免表**（否则假阳性）。实测「同域无任何方法定义」的 `this.X()` 如下（全部是**注入回调或函数值属性**）：

    instance: onRemoteChange(core.js:225)  onInstanceStart(core.js:322)  onInstanceStop(core.js:327)
              onCreate(ops.js:132)  onRemove(ops.js:215)  onDestroy(ops.js:216)
    plugin:   onNativeRestart(jobs.js:125)
    relay:    persist(manager.js:49)  mainOf(manager.js:56)  tokenOf(manager.js:88,428)
    router:   onPersist(providers/base.js:685, switch.js:42)
              _ccLoginReject(router-ops.js:147,177,182)  _ccLoginResolve(router-ops.js:184)  ← 函数值属性

**纪律**：豁免表每一条必须在 `contract.js` 有对应端口声明（`deps.hooks`/`deps.onPersist`/`deps.persist`…）；
**DG-4b**：豁免项必须能在 `contract.js` 找到出处，否则 FAIL（防豁免表腐化成垃圾桶 —— 与 `layering-and-dependency-gate-test.js:236-248` 的 **L-2b「登记表无死条目」** 同一纪律）。

**DG-4c 同名歧义**：`canPersist` 同时定义在 `router/index.js:154` 与 `router/store.js:43`，`forward-core.js:508` 消费
→ bare `this.X()` 指向不明。加判据：同级兄弟文件出现同名方法定义 → FAIL（白名单 `constructor` 及语言关键字）。
实测真实冲突：`router`: `canPersist`（`index.js` vs `store.js`）、`constructor`（`index.js`/`store.js`/`switch.js`，类构造器属正常需白名单）。

**DG-4d 抽象占位白名单（本设计实测新增，防误报）**：`router/providers/base.js` 的 12 个抽象声明
（`:222,243-253`，方法体 throw `must be implemented by …`）与 `proxy.js` 的实现构成**继承内多态**，
`base.js:307 this.stopInstance(acc.instance)` 属**合法**。判据须：
① 收集「方法体仅 `throw new Error('… must be implemented …')`」的方法名 → 抽象集合；
② 抽象集合内的 `this.X()` **不计违规**；
③ 但**必须**配套检查「`contract.classApi` 里该抽象方法有 `abstract:true` 标注」且「至少一个子类实现」（否则抽象方法无人实现 = 真实缺陷）。
实测 11/12 有实现；`detectAccount`（`:222`）由 `direct.js:27 proxy.js:73` 实现。

**DG-4 反向自检（三条，缺一不可）**：
1. **能识别**：内联夹具 `fileA` 定义 `save()`、`fileB` 调 `this.save()` → 返回 1 条违规（**纯字符串，不落盘**）；
2. **不误报**：夹具中 `fileB` 自定 `save()` → 返回 0 条；
3. **有分辨力**：对真实源码树断言 `this.X()` 总调用数 ∉ {0}，且跨文件命中 = 常数表（迁移前 **127**，迁移后 0）—— 防「匹配器退化 → 静默全绿」。

#### B.3.5 DG-5 组合图无环 / 禁 mixin（DF-5）★ 按 R1 修正口径

```js
// 顶点 = 域内文件；边 = require 边 ∪ this 跨文件边
function combinedGraph(domainDir) {
  const files = walk(domainDir).filter((f) => f.endsWith('.js'));
  const defs  = new Map(files.map((f) => [f, definedNames(strip(read(f)))]));
  const adj   = new Map(files.map((f) => [f, new Set()]));
  for (const f of files) {
    for (const t of requireTargets(strip(read(f)))) if (t.startsWith(domainDir)) adj.get(f).add(t);  // ① require
    for (const c of thisCalls(strip(read(f)))) {                                                     // ② this
      if (defs.get(f).has(c)) continue;
      const g = files.find((x) => x !== f && defs.get(x).has(c));
      if (g) adj.get(f).add(g);
    }
  }
  return { files, adj };
}
function findCycles({ files, adj }) {            // 三色 DFS，记录环上每条边与其类型
  const state = new Map(), cycles = [];
  const dfs = (u, stack) => {
    state.set(u, 1);
    for (const v of adj.get(u) || []) {
      if (state.get(v) === 1) cycles.push(stack.slice(stack.indexOf(v)).concat(v));
      else if (!state.get(v)) dfs(v, stack.concat(v));
    }
    state.set(u, 2);
  };
  for (const f of files) if (!state.get(f)) dfs(f, [f]);
  return cycles;
}
```
- **判据分两半（R1 的核心）**：
  - **DG-5a（require 图）**：必须 DAG。当前 **0 环 ✓**（五域）—— 断言它，并把「0 环」钉成常数，防退化。
  - **DG-5b（mixin 造成的 this SCC）**：**禁止 `Object.assign(X.prototype, …)` 产生的 SCC**。
    判定法：先把 6 处并原型的目标类与其源方法集建映射（`InstanceManager←opsMethods,upgradeMethods`、
    `PluginManager←opsMethods,jobsMethods`、`RouterService←forwardMethods,auxMethods`、`Supervisor←mod.methods`），
    再断言「这些类的方法集分布在 ≥2 个文件」== false。
  - **DG-5c（继承 SCC 豁免）**：`{base,proxy}` 型 SCC 若是 `extends` + 抽象占位（DG-4d），**不计违规**并显式输出「已知合法 SCC」。
- **为何必须并入 this 边**：A.2.1/A.2.3 已证 require-only 图 0 环；若沿用旧口径，DF-5 会**假绿**。
- **必须处理的两个坑**：
  1. **函数内惰性 require**（`relay/manager.js:422 require('./index')`、`router/index.js:595 require('../../platform/util/probe')`）—— 必须匹配**任意位置**的 `require('.')`，不能只匹配顶层；
  2. **注释里的 require 字符串**（`instance/index.js:13`、`plugin/index.js:16`、`relay/index.js:13`；`router/daemon.js` 与 `relay/daemon.js` 的模块说明）—— 必须 `strip` 后再扫（R1 取证陷阱）。
- **反向自检**：① 夹具 `A require B` + `B this.m()`（m 定义在 A）→ `findCycles` 返回 1；② 真实域环数 = 常数（迁移前 this 图 SCC 数 {instance:1, plugin:1, router:2, relay:0, shell:0}；require 图全 0）；③ 断言 require-only 图 0 环（**记录口径差异，防有人退回旧口径**）。

#### B.3.6 DG-6 可独立单测（DF-6）

```js
const TOP_LEVEL_SIDE_EFFECTS = [
  /^setInterval\s*\(/m, /^setTimeout\s*\(/m,
  /^Object\.(assign|defineProperties)\(\s*\w+\.prototype/m,
  /^new\s+[A-Z]\w*\s*\(/m,
];
// 动态探针：子进程单独 require + 临时状态根 + 超时退出
const probe = (abs, stateRoot) => spawnSync(process.execPath, ['-e', `
  const m = require(\${JSON.stringify(abs)});
  setTimeout(() => process.exit(Object.keys(m).length ? 0 : 2), 50);
`], { timeout: 5000, env: { ...process.env, DSH_SUPERVISOR_HOME: stateRoot } });
```
- **必须用临时状态根**：`test/_preload.js:9-11` 已注入 `DSH_SUPERVISOR_HOME=<mkdtemp>` —— **既有隔离设施，非新引入**。禁止真机状态根。
- **ENTRY_FILES 白名单**：`relay/daemon.js`、`router/daemon.js` 是进程入口，天然不可 require 即测；
  且 R1 提醒须有 `require.main` 守卫（既有 `provider-gateway-gate-test.js:215-231` 的 **PG-9** 已覆盖该点，本判据引用而非重复）。
- **反向自检**：夹具顶层 `setInterval(()=>{},1000)` → 静态判据必命中；夹具 `module.exports={f(){}}` → 必不命中。

#### B.3.7 DG-7 单向依赖（DF-7）

```js
const RANK = {                       // 规范名 → rank；edge 必须 from.rank ≤ to.rank
  'index.js': 0, 'daemon.js': 0,
  'ops.js': 1, 'scheduler.js': 1, 'handlers': 1,
  'core.js': 2, 'policies': 2, 'switch.js': 2, 'jobs': 2,
  'model.js': 3, 'store.js': 3, 'providers': 3, 'instances': 3,
};
```
- **实测反向边**：`forward-core.js → index.js`（1→0）、`router-ops.js → index.js`（1→0）、`plugin/store.js → ops.js`（3→1）。
  同级（如 `providers/proxy.js → providers/base.js` 3→3、`ops.js → jobs.js` 1→1）**允许**。
- **未归类文件必须 FAIL 而非静默跳过**（否则加个 `foo.js` 就能免检）。
- **反向自检**：夹具 `store 调 core`（3→2）命中；夹具 `index 调 store`（0→3）不命中；夹具未归类 `foo.js` → 命中「未归类」。

#### B.3.8 DG-8 禁止原型并接（DF-4 机制，**按 R6 替换原正则**）

```js
// ① 任何把外部方法集挂到原型的手法（右值不限：变量 / 内联 require / 成员表达式）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（辅助识别：方法集的来源文件长什么样）
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
function prototypeMerges(files) {
  return files.filter((f) => MIXIN_INTO_PROTOTYPE.test(strip(read(f))));   // ★ 先剥注释
}
```
- **为何替换 R4 原正则**：R4 的 `/Object\.(defineProperties|assign)\(\s*\w+\.prototype\s*,\s*require\(/` 要求右值是**内联 require**，
  于是 ①漏掉 `instance/index.js:31`、`plugin/index.js:33`、`supervisor.js:160` 三处（右值是变量）；
  ②`supervisor.js` 唯一命中项是**第 21 行注释** → **假阴性 + 假阳性同时发生**。R6 裁决已实测确认。
- **当前实测命中 6 处**（剥注释后，见 A.3 ⑤ 表）：`instance/index.js:31`、`plugin/index.js:33`、`router/index.js:758`、`router/index.js:759`、`supervisor.js:160`、`supervisor.js:161`。
- **与 DS-G3 的关系**：DS-G3（`directory-structure-gate-test.js:122`）只查 `Object.defineProperties(X.prototype, require(...))`（旧形态，已归零）；
  **新形态 `Object.assign` 从未被任何门禁覆盖** —— 本判据即补该缺口（R4/R6）。
- **反向自检（R6 明确要求含变量样本）**：
  ① `Object.assign(X.prototype, mod.methods)` → **HIT**（这正是 R4 漏掉、R6 要求补的样本）；
  ② `Object.defineProperties(X.prototype, require('./x'))` → HIT；
  ③ `Object.assign({}, a)` → **MISS**（证明不是「见 Object.assign 就报」）；
  ④ 注释样本 `// Object.assign(X.prototype, ...) 并入同一原型` → **MISS**（证明先剥注释）；
  ⑤ 断言真实命中 = 6（常数表）。
- **可选加固（R6 的判据②用途）**：`METHODS_FRAGMENT` 实测命中 **28 个文件**（`app/**` 为主）——
  它是 `Object.assign(Supervisor.prototype, mod.methods)` 的**配套形态**，作为「分片导出」的识别锚点；
  若某文件导出 `{methods}` 却无人并原型（或反之），可作一致性检查（不强制 FAIL，仅报告）。

#### B.3.9 DG-9 契约双向一致

```js
function exportMismatch(domain) {
  const declared = require(path.join(SRC, 'domains', domain, 'contract.js')).exports;   // 数组
  const actual   = parseModuleExportsKeys(path.join(SRC, 'domains', domain, 'index.js')); // 见下「解析禁忌」
  return { missing: declared.filter((k) => !actual.includes(k)),
           extra:   actual.filter((k) => !declared.includes(k)) };
}
function ctorDepsMismatch(domain) {   // 声明 vs ctor 内 opts.<k> 实际读取
  const declared = Object.keys(require(contractPath).deps);
  const actual   = [...new Set([...strip(read(impl)).matchAll(/\bopts\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
}
```
- **前置条件**：`contract.js` 需先建（迁移步 M2）。DG-9 **初值是「未建即 FAIL」**，逼出契约文件。
- **解析禁忌**：`module.exports` 形态有 3 种以上（`instance/index.js:33` 单键、`plugin/index.js:35` 双键、`shell/index.js:35` 跨行 10 键、`relay/daemon.js` **无导出**、`supervisor.js:174` `{ Supervisor, normalize }`）。
  解析器必须 ① 支持跨行；② 遇非字面量 → 记 `kind:'dynamic'` 并要求 `contract.exports.kind` 显式声明以便跳过；③ **解析失败必须 FAIL 而非跳过**。
- **反向自检**：夹具 `module.exports={a,b}` + `contract.exports=['a']` → `extra=['b']`；`['a','c']` → `missing=['c']`。

#### B.3.10 DG-10 消费方 ⊆ PUBLIC_API

```js
const CONSUMER_BINDINGS = {
  'this.instances': 'instance', 'host.instances': 'instance', 'sup.instances': 'instance',
  'this.router': 'router', 'host.router': 'router', 'sup.router': 'router',
  'this.lan': 'relay', 'host.lan': 'relay', 'sup.lan': 'relay',
  'this.pluginManager': 'plugin', 'sup.pluginManager': 'plugin', 'sup.pluginMarket': 'plugin',
  'host.shellDomain': 'shell', 'sup.shellDomain': 'shell',
};
// ★ 必须按文件前缀排除 domains/router/ —— 那里的 this.instances 是 ProxyInstance（同形不同物）
```
- **这是把 A.2.4「同名误导」写进门禁的地方** —— 否则门禁会造出假契约（把 ProxyInstance 当沙箱实例域）。
- **反向自检**：夹具 `sup.instances.sandboxRoot(i)`（若该名已不在契约）→ 命中；夹具 `sup.instances.list()` → 不命中。

#### B.3.11 DG-11 禁止内部数组穿透

```js
const ARRAY_PIERCE = /\.instances\s*\.\s*instances\b/;
function piercings(files) {
  return files.filter((f) => ARRAY_PIERCE.test(strip(read(f))))
              .filter((f) => !rel(f).startsWith('domains/instance/'));   // 本域内部先豁免
}
```
- 实测命中（域外）：`app/audit/orphan-scan.js:40`、`app/control/instance-adapter.js:42`、`app/control/specs.js:67`、
  `app/daemons/runtime.js:70`、`app/session/shutdown.js:117`、`app/facade/main.js:73`、`app/assembly/bootstrap.js:108`、
  `plugin/ops.js:74,85`、`relay/manager.js:55`、`api/domains/instances.js:153`。
- **反向自检**：`sup.instances.instances.find(...)` 必命中；`sup.instances.list()` 必不命中。
- **泛化版（可选，终态）**：域外禁止一切 `.instances` 属性访问（只允许 `.list()`/`.get()`）。当前先做窄版，避免一次红 126 处。

#### B.3.12 DG-12 门禁非空转总断言

```js
check('DG-12 扫描确实产出非空集', audit.files.length >= 140 && audit.thisCalls >= 400, ...);
check('DG-12 已读源码字节数下界', audit.bytes >= 500_000, ...);        // 实测 148 文件
check('DG-12 每条判据都有对应反向自检', Object.keys(reverseSelfChecks).length === JUDGE_COUNT, ...);
```

#### B.3.13 DG-13 门禁不得硬编码行号（本设计新增，由实测行号漂移逼出）

- **背景**：本设计写作期间，`router/index.js` 并原型行在快照间 `758→723→758` 抖动；`supervisor.js` `160 行→174 行`、并原型 `160→80→160`（A.4 实测）。
- **判据**：门禁源码中**不得出现以行号为断言目标的常量**（如 `expect line 758`）。
  行号只允许出现在**证据字符串**里（给人读的 FAIL 提示）。
- **实现**：扫描门禁自身源码，禁止形如 `\.line\s*===\s*\d+`、`lineNumber\s*===\s*\d+` 的断言（正则给出 2-3 种形态）。
- **反向自检**：夹具 `assert(x.line === 758)` → 命中；夹具 `'at line ' + x.line` → 不命中。

#### B.3.14 DG-14 facade 只读化（R7）

```js
const WRITE_VERB = /^(set|patch|install|apply|toggle|sync|start|stop|restart|enable|disable|update|remove|delete|reset)/i;
const FACADE_EXCEPTIONS = {                       // 例外必须写明理由（照 L-2b 纪律）
  'app/facade/lan.js':   { listLan: '读触发 reconcile 对账（relay/manager.js:66），域契约标注 read-with-side-effect' },
  'app/facade/ports.js': { listPorts: '读触发端口激活探测，同上' },
};
function facadeWriteViolations(files) {
  const out = [];
  for (const f of files) {                        // files = app/facade/*.js
    const rel = relativeSrc(f);
    const src = strip(read(f));
    // 收集本文件定义的方法名 → 逐个检查「是否写动作」
    for (const name of definedNames(src)) {
      const exempt = FACADE_EXCEPTIONS[rel] && FACADE_EXCEPTIONS[rel][name];
      if (exempt) continue;
      if (WRITE_VERB.test(name)) out.push({ file: rel, method: name, why: 'facade 不得含写动作' });
    }
  }
  return out;
}
```
- **实测 5 处违规**：`app/facade/router.js:78 setRouterRunning`、`app/facade/main.js:41 patchDshMain`、
  `app/facade/lan.js:44 setLanFrp`、`app/facade/lan.js:54 lanFrpc`（动作在参数里，方法名无动词 → 需**第二判据**：调用了 `frpAction`）、
  `app/facade/lan.js:59 syncFrpc`。
- **⚠ 必须处理的两类误报**（B.2 已述）：`listLan`/`listPorts` 的「读触发副作用」走显式例外表；`lanFrpc` 的方法名无写动词但语义是写 → 加「调用目标在契约中标注 `write`」作为第二判据。
- **反向自检**：① 夹具 `setRouterRunning(){}` → 命中；② 夹具 `routerStatusView(){}` → 不命中；
  ③ 夹具 `listLan(){}` 且例外表含它 → 不命中；④ 断言真实命中 = 5（常数表）。

#### B.3.15 综合：判据与「反向自检」的完备性

| 判据 | 正向断言 | 反向自检样本（必须与匹配器有交集） |
|---|---|---|
| DG-1 | index ≤150 且无 banned | 151 行样本 / 含 `http.createServer` 样本 / 合规域返回空 |
| DG-2 | 文件 ≤400 | 401 行命中、400 行不命中 |
| DG-3 | 纯文件零 IO require | `require('node:fs')` 命中 / `require('./y')` 不命中 |
| DG-4 | 跨文件 this = 0 | A 定义 `save`+B 调 → 命中；B 自定 → 不命中；真实常数 127 |
| DG-4b | 豁免项有契约出处 | 假豁免 `__nope__` 命中 / 真豁免 `tokenOf` 不命中 |
| DG-4c | 无同名兄弟方法 | 两文件都定义 `canPersist` 命中 / 只一个不命中 |
| DG-4d | 抽象占位有子类实现 | 抽象 throw 体识别；无实现 → 命中 |
| DG-5 | require DAG + 无 mixin SCC | 夹具 require+this 环命中；真实常数 |
| DG-6 | 非入口文件可 require | 顶层 `setInterval` 命中 / 空导出不命中 |
| DG-7 | rank 单调 | `store→core` 命中 / `index→store` 不命中 / 未归类命中 |
| DG-8 | 无 mixin 并原型 | 变量样本命中 / `Object.assign({},a)` 不命中 / 注释样本不命中 / 真实常数 6 |
| DG-9 | 契约双向一致 | `extra`/`missing` 各一夹具 |
| DG-10 | 消费 ⊆ 契约 | 越权成员命中 / 合法成员不命中 |
| DG-11 | 无数组穿透 | `.instances.instances` 命中 / `.list()` 不命中 |
| DG-12 | 非空转 + 自检完备 | 断言键集合 === 判据集合 |
| DG-13 | 无行号断言 | `line === 758` 命中 / 证据字符串不命中 |
| DG-14 | facade 无写动作 | `setX` 命中 / 只读不命中 / 例外命中表 |


---

## C. 目标结构（★ 逐文件）

> 本专题不改业务文件，只新增**横切文件** + 门禁；域内拆分的逐文件表由各域设计给出。
> 此处给「契约与门禁」侧的目标结构，以及对域内拆分提出的**形状约束**（各域设计必须满足）。

### C.1 新增文件（本专题产出）

| 新文件 | 行数估计 | 职责 | 从哪来 | 纯? |
|---|---|---|---|---|
| `test/domain-structure-gate-test.js` | 400–480 | DF-1..7 + 域间契约 + R7 的 **14 条判据** + 全部反向自检 | 无（新建；风格照 `directory-structure-gate-test.js` + `provider-gateway-gate-test.js`） | 是 |
| `test/_domain-graph.js` | 160–220 | 组合图分析器：`strip`/`countLines`/`definedNames`/`thisCalls`/`requireTargets`/`combinedGraph`/`findCycles`/`rankOf`/`parseModuleExportsKeys` | 从门禁文件抽出，供 DG-4/5/7/9 共用**同一实现** | 是 |
| `domains/instance/contract.js` | 40–60 | `{ domain, exports, classApi, deps, hooks, pure }` 纯数据 | `instance/index.js:33` 导出面 + `core.js:39-70` ctor | 是 |
| `domains/relay/contract.js` | 45–65 | 同上（含 `InstanceSource` 端口形状） | `manager.js:14-34` ctor + `index.js:502` | 是 |
| `domains/plugin/contract.js` | 45–65 | 同上（含 `InstanceTargetPort`） | `store.js:25-42` ctor + `index.js:35` | 是 |
| `domains/router/contract.js` | 60–90 | 同上（含 `forwardMethods`/`auxMethods` 两方法集 + 12 个抽象方法标注） | `index.js:24-41` ctor + `:758-761` | 是 |
| `domains/shell/contract.js` | 30–40 | 同上 | `index.js:35` | 是 |
| `app/domain-actions/*.js`（**R7**） | 每域 40–120 | facade 下沉出的写动作（`setRouterRunning`/`patchDshMain`/`setLanFrp`/`lanFrpc`/`syncFrpc`），经生命周期/目录/事件记账 | `app/facade/router.js:78`、`main.js:41`、`lan.js:44,54,59` | 否 |
| `src/ports/instance-port.js`（可选，终态） | 60–80 | 端口**实现侧**适配器：把 `InstanceManager` 收窄成 `InstanceQueryPort`/`InstanceTargetPort` | 新增；包住 `list/get/projectTarget` | 否（薄包装） |
| `src/ports/assert.js`（可选，装配期） | 40–60 | `assertPort(name, impl, members)` 装配期 fail-fast | 对应 `api/deps.js:110-116` 的「启用条件 2」 | 是 |

**⚠ 文件落点约束（R2 已裁决放宽）**：DS-G6 子目录白名单已放宽为
`providers instances policies model store handlers core jobs`（`directory-structure-gate-test.js:170` 需同步改）。
但 **R2 要求优先扁平文件** —— 故上述契约文件与 domain-actions 均用**扁平命名**（`contract.js`、`<域>-actions.js`），
仅在确有多个同类文件时才建子目录。

### C.2 对各域设计提出的**形状约束**（不是本专题文件，但必须满足）

| 约束 | 理由（判据） | 影响域 |
|---|---|---|
| 域内 `index.js` ≤150 行且只组合+导出 | DF-1 / DG-1 / **R3** | relay（502→≈40）、router（763→≈120） |
| 每个非门面文件 ≤400 行 | DF-2 / DG-2 / **R3** | 11 个域内文件（A.3 ①） |
| 声明为纯的文件零 IO require | DF-3 / DG-3 | instance/core.js（拆出 store.js 承接 `load`/`save`） |
| 禁止 `Object.assign(X.prototype, …)` | DF-4 / DG-8 / **R1/R6** | instance、plugin、router、supervisor（6 处） |
| 同域方法不得拆到多个文件再并同一 this | DF-5 / DG-5b / **R1** | instance、plugin、router |
| 每个非入口文件可独立 `require` | DF-6 / DG-6 | 全域；入口白名单 `relay/daemon.js`、`router/daemon.js`（**R5 文件名不得改**） |
| 依赖方向 `index→ops→core→store` 单调 | DF-7 / DG-7 | plugin（store→ops 反向）、router（forward-core/router-ops→index 反向） |
| 消费 instance 只经端口 | DG-10 / DG-11 | plugin（3 处）、relay（2 处）、app（9 文件）、api（1 文件） |
| facade 只读 | **R7** / DG-14 | `app/facade/router.js`、`main.js`、`lan.js` |

---

## D. 依赖图（★ 必须是 DAG）

### D.1 域间依赖图（目标：五域互不 require，只经端口）

     ┌──────────────────────────────────────┐
     │ 域 Public API（经 index.js）           │◀── app/*（编排 L2）
     └──────────────────────────────────────┘◀── api/domains/*（L3，注入 sup.*）
          ▲
          │ instance.list/get/projectTarget/start/stop/probe/supervise
          │ router.*（status/portsView/domainSummary/providers/…）
          │ relay.list/setFrp/frpStatus/frpAction/syncFrpc
          │ plugin.*（install/uninstall/setBundleEnabled/…）
          │ shell.*（status/evaluate/health/checkUpdate/restartShell）
          │
     domains/{instance,router,relay,plugin,shell}   （域间 0 条 require）
          │
          ▼
     platform/* ──▶ shared/*                        （L0；DS-1/DS-2）

**端口边（新增，虚线＝注入而非 require）**：

     plugin ┈ports┈▶ InstanceTargetPort ┈实现于┈▶ instance/index.js（Public API 子集）
     relay  ┈ports┈▶ InstanceSource     ┈实现于┈▶ instance/index.js + app/assembly（persist/tokenOf/mainOf）
     app    ┈hooks┈▶ InstanceHooks      ┈实现于┈▶ app/assembly/compose.js

**每条边的理由**：

| 边 | 理由 | 合法性 |
|---|---|---|
| `plugin → InstanceTargetPort` | 插件要装进沙箱实例的 DSH；需目标目录 + 启停使变更生效（`jobs.js:104,108`） | ✅ 域→域端口（app 注入，无 require 边） |
| `relay → InstanceSource` | 反代对账需实例清单（`manager.js:55`）；令牌变更需通知（`manager.js:490`） | ✅ 同上 |
| `relay → FrpManager` | 域内，frp 是 relay 子能力（`manager.js:12`） | ✅ 域内 |
| `instance → hooks` | 实例变化需通知编排层（原 6 个裸回调） | ✅ 出站端口（注入方向 app→instance） |
| `router → ✗ instance` | **不存在**（A.2.4 纠正）；router 的 `instances` 是 ProxyInstance | ✅ 不建边 |

### D.2 单域目标依赖图（以 instance 为例，示范 DF-7 单调性）

     index.js  ──▶ ops.js ──▶ store.js（新，IO：load/save/_syncInstancePorts/_ensureSandboxDirs）
         │           │  └──▶ core.js（纯：状态机/视图/路径）
         │           └──▶ upgrade.js ──▶ core.js / store.js
         └──▶ upgrade.js
     core.js ──▶ （零域内依赖；仅纯算法）

- **边必须单向向下**（rank：index 0 → ops 1 → core 2 → store 3）。`ops → upgrade`（1→1）允许；`upgrade → ops`（1→1）允许但**必须 ctor 注入而非 this**。
- **跨域边**：0 条；不合法的跨域边（若出现）在 E 节提出并标注「需上层裁决」。

### D.3 门禁自身依赖图

     test/domain-structure-gate-test.js ──▶ test/_domain-graph.js（纯分析器）
                                        ──▶ node:fs / node:path（只读）
                                        ──▶ require(domains/*/contract.js)（纯数据）
     test/_domain-graph.js ──▶ （零 require，纯函数）

**无环、无 IO 副作用、不启动任何进程**（DF-6 对门禁自身也成立）。

---

## E. `this` 隐式耦合消解表（★ 逐条）

> 手法：**A**=具名导出+显式依赖；**B**=构造注入；**C**=参数显式化（§3）。
> 127 处按「同一处方的组」聚合（逐条列单点会淹没重点；每组给出完整行号）。
> **本专题只对「跨域/跨层」条目提出设计**；域内条目列出处方交由各域设计落地。

### E.1 域间耦合消解（本专题核心）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.instances.instances.filter(...)` | `plugin/ops.js:74` | **B** | `this.targets.listSandboxTargets()`（`store.js:31` 的 `opts.instances` 改名 `opts.targets`） |
| `this.instances.instances.find(...)` | `plugin/ops.js:85` | **B** | `this.targets.projectTarget(str)`，返回 `TargetView` 或 `null` |
| `this.instances.sandboxDataDir(inst)` | `plugin/ops.js:51` | **B** | `TargetView.dataDir`（布局知识不外流） |
| `this.instances.sandboxInstallDir(inst)` | `plugin/ops.js:52` | **B** | `TargetView.installDir` |
| `this.instances.probeInstance(id)` | `plugin/jobs.js:91` | **B** | `this.targets.probeInstance(id)`（签名进 `contract.js`） |
| `this.instances.stopInstance(id)` | `plugin/jobs.js:104` | **B** | `this.targets.stopInstance(id) => {ok,error?}` |
| `this.instances.startInstance(id)` | `plugin/jobs.js:108` | **B** | `this.targets.startInstance(id) => Promise<{ok,installing?,error?}>`（形状**写进契约**） |
| `this.instances.instances` | `relay/manager.js:55` | **B** | `this.source.listSandboxes()`（`opts.instances` → `opts.source`） |
| `this.instances.save()` | `relay/manager.js:50` | **B** | `this.source.save()` 或已有 `persist()`（`:21`）。**二选一**：保留 `persist`、删 `save` 回退分支 |
| `this.instances.sandboxRoot(inst)` | `app/control/specs.js:47` | **B** | `this.instances.projectTarget(inst.id).rootPath`（`sandboxRoot` 从 Public API 降私有） |
| `this.instances.instances` | `app/control/specs.js:67`、`instance-adapter.js:42`、`app/daemons/runtime.js:70`、`app/session/shutdown.js:117`、`app/audit/orphan-scan.js:40`、`app/facade/main.js:73`、`app/assembly/bootstrap.js:108`、`app/control/adapters.js:103`、`api/domains/instances.js:153` | **A** | 一律 `this.instances.list()`；按 id 找用 `this.instances.get(id)`（新增） |
| `host.instances.onRemoteChange = …` 等 6 处 | `app/assembly/compose.js:272,276,282,287,293,294` | **B** | ctor 注入 `hooks: { onRemoteChange, onRemove, onInstanceStart, onInstanceStop, onCreate, onDestroy }`，域内调 `this.hooks.onX(...)` |
| `relay/daemon.js:86-89 lanSource` 鸭子对象 | `relay/daemon.js:86` | **A/B** | 改成显式 `new RelayInstanceSource({ stateFile })`，实现 `listSandboxes()`；`save(){}` noop 变为显式命名方法 |

### E.2 域内 `this` 消解（处方汇总，落地归各域设计）

| 域 | 组 | 旧调用（位置） | 手法 | 新形态 |
|---|---|---|---|---|
| instance | core→upgrade（2 组） | `_readInstalledVersion@core.js:239`、`_taskStateToView@core.js:263` | **C** | 视图构造改**入参**：`list(installedVersionOf)`；或 `_readInstalledVersion` 下沉为 `store.js` 具名导出 `readInstalledVersion(dir, inst)`（纯读，可单测） |
| instance | ops→core（16 组 29 点） | `_probeState/_setRunning/_setStopped/_failInstance/_restartInstance`（状态机）、`sandboxRoot/sandboxDataDir/sandboxInstallDir`（路径）、`save`、`effectiveCommand`、`_ensureSandboxDirs`、`_startLanForInstance/_stopLanForInstance` | **C+A** | 状态机→`core.js` 导出纯函数 `transition(state, event, now)`（**C**）；路径→`core.js` 具名导出 `sandboxPaths(root, id)`（**A**，纯）；`save`→`store.js` 具名 `saveInstances(file, arr)`（**A**）；`_ensureSandboxDirs`→`store.js`（IO） |
| instance | upgrade→core（4 组 14 点） | `save`×8、`sandboxInstallDir`×3、`_probeState`、`_ensureSandboxDirs` | **A** | 同上具名导出 |
| instance | upgrade→ops（2 组 3 点） | `startInstance@:295,309`、`stopInstance@:248` | **B** | `new UpgradeOps({ startInstance, stopInstance })` 或升级流程接受 `lifecycle` 端口 |
| instance | ops→upgrade（1 组） | `_installSandbox@ops.js:328` | **B** | 注入 `installer: { installSandbox(inst, ctx) }` |
| plugin | ops↔jobs（环） | `_createJob@ops.js:179,226`、`_finishJob@:186,233`、`_targetRunning@:205,351,353`、`_withScopeLock@:195,242`、`_applyPluginChange@:276`；反向 `_nativeTarget/_allSandboxTargets/_runCli/resolveTargets@jobs.js:149,186,224,226` | **B** | `JobModel` 独立类（纯状态机 + 作业表）：`new JobModel({ tasks })`；`applyPluginChange` 需要的 `runCli/resolveTargets` 改为 ops ctor 注入 `{ cli, targets }` 给 jobs |
| plugin | ops→store（9 组 12 点） | `_readHomePatch/_writeHomePatch/_patchEntryIdsForPlugin/_removeFromProfileBundles/_scrubPluginLayers/_enqueueBundleOp/saveOverlayEntries/installedOn/isProtected` | **A** | 改为 `store.js` 的**具名导出纯函数/小类方法**（`readHomePatch(profileDir)`、`writeHomePatch(profileDir, data)`…），ops 顶部 `const {…} = require('./profile-io')` |
| plugin | store→ops（反向 2 组 3 点） | `_nativeTarget@store.js:254,319`、`_allSandboxTargets@:254` | **B/C** | `listInstalled(targets)` 改为**入参**：调用方（ops）传 targets 进来；store 不再回查 ops |
| router | forward-core→index（反向） | `log`×9@`:166,217,231,247,273,291,299,315,371`、`readBody@:168`、`canPersist@:508` | **B** | ctor 注入 `{ log, readBody, canPersist }`；或具名导出 `readBody`/`ringLogger`（**A**） |
| router | router-ops→index（反向） | `_save`×7@`:393,457,509,582,607,618,646`、`getProvider`×6@`:448,517,595,633,651,659` | **B** | 方法集改为 `createAuxMethods({ getProvider, save })` 工厂（依赖显式）→ 终态 `AuxService` 类 |
| router | index→forward-core / router-ops | `_loadTotals/getUsage/proxyFor`、`refreshOfficial*/refreshProxyUpdateInfo` | **A/B** | 改 `new ForwardCore({...})` / `new AuxService({...})` 持有的实例方法 |
| router | proxy→base（继承） | `base.js:307 this.stopInstance` 等 12 个抽象占位 | **豁免（DG-4d）** | **合法多态**，不改；但要补 `contract.classApi` 的 `abstract:true` 标注 + 「至少一子类实现」检查 |

### E.3 特殊条目（不可机械消解，必须显式化）

| 条目 | 位置 | 现状 | 处方 |
|---|---|---|---|
| `_ccLoginReject/_ccLoginResolve` | `router/router-ops.js:147,177,182,184`（赋值 `:211`，清理 `:149-150,217-219,226-227,247,259`） | 函数值属性被当方法调，**任何文件都无定义** | **C**：抽出 `class OAuthLoginSession { start()/cancel(reason)/resolve(payload) }`，把 5 处散落的 `= null` 清理收敛为 `session.close()`（注释 `:253-259` 自述「残留 _ccLoginReject」正是同一病根）→ 门禁不再豁免这两个名字 |
| `onPersist` | `providers/base.js:685`、`switch.js:42` | 注入回调 | 进 `router/contract.js` 的 `deps.onPersist`；豁免表登记 |
| `persist/mainOf/tokenOf` | `relay/manager.js:49,56,88,428` | 注入回调 | 进 `relay/contract.js` 的 `deps`；豁免表登记 |
| `onRemoteChange` 等 6 个 | 见 E.1 | 裸回调赋值 | 收敛为 `hooks` 端口；豁免表登记为 `deps.hooks.*` |
| 同名歧义 `canPersist` | `router/index.js:154` vs `router/store.js:43` | 消费点 `forward-core.js:508` 指向不明 | 二者**只保留一个**（store 的为权威持久化闸；index 的改 `_canPersistNow()`），DG-4c 兜底 |
| 「router 调 instances.sandboxRoot」 | 任务书所述 | **实测不存在** | **不做**；写入本节作澄清（防后续 review 按错误前提设计） |
| **facade 写动作（R7）** | `app/facade/router.js:78`、`main.js:41`、`lan.js:44,54,59` | 门面可写 → 绕过生命周期/目录/事件记账 | 下沉 `app/domain-actions/`；facade 只留只读视图；DG-14 兜底 |

### E.4 需上层裁决（跨域/跨层，本专题不擅自设计）

| # | 事项 | 为什么需裁决 | 现状 |
|---|---|---|---|
| ~~R1~~ | ~~DF-5 口径~~ | — | **已裁决**：禁 mixin 到同一 this；门禁须剥注释 |
| ~~R2~~ | ~~子目录白名单~~ | — | **已裁决**：放宽为 `providers instances policies model store handlers core jobs`，优先扁平 |
| ~~R3~~ | ~~阈值~~ | — | **已裁决**：index ≤150 / 文件 ≤400（取严） |
| ~~R4/R6~~ | ~~DS-G3 补判据~~ | — | **已裁决**：正则替换为 `/Object\.(defineProperties\|assign)\(\s*[\w$.]+\.prototype\s*[,)]/`，先剥注释，反向自检须含变量样本 |
| ~~R5~~ | ~~daemon.js 文件名~~ | — | **已裁决**：不得改（5 处 cmdline 匹配） |
| ~~R7~~ | ~~facade 只读化~~ | — | **已裁决**：只读视图留 facade，写动作下沉 `app/domain-actions/` |
| **R8（新）** | `app/domain-actions/` 的**层归属**与注册方式：是 `app/` 平铺子目录（新），还是并入各域 `ops.js`？ | R7 只给了去向名词，未定层与装配；若并入各域，则 api 需改为直接调域对象（不再是 `sup.setRouterRunning`），会**改变 api 契约面**（`api/contract.js` 的 SURFACE 不变，但 `api/deps.js:76-82` 的 router 依赖项要改） | 待裁决 |
| **R9（新）** | `api/deps.js`（`api/deps.js:14-19` 自述「只声明不强制」）是否本轮一起接线运行期校验 | 其「启用条件」与 DG-9/DG-10 高度重合；且它声明的 `sup.*` 成员与 R7 下沉**直接冲突**（如 `api/deps.js:82 setRouterRunning`） | 待裁决 |
| **R10（新）** | 既有门禁 `directory-structure-gate-test.js:170` 的 `ALLOWED` 是否本轮同步改为 R2 白名单 | 不改则新子目录（policies/model/…）会被旧门禁判违规；改则须同步更新其注释与 DS-G6 文档 | 待裁决（建议：本轮改） |
| **R11（新）** | 阈值冲突文档化：R3 取严后 `DIRECTORY-STRUCTURE-DESIGN.md` §D5.1 的 DS-9（≤450/≤200）与 `DOMAIN-DESIGN-BRIEF.md` §1（≤400/≤150）需同步 | 两份 SSOT 不一致会误导后续设计子代理 | 待裁决（建议：合并时统一为严值） |


---

## F. 迁移步骤（★ 可执行、可分批）

> 每步都能**独立提交**；每步后 `test/domain-structure-gate-test.js` 必须能跑出**确定输出**（迁移期允许 FAIL，
> 但 **FAIL 集合必须与常数表一致** —— 防「改完不知道红了什么」）。
> ⚠ 行号随并行改动漂移（A.4）：本表**只用符号名与语义定位**，不用行号（DG-13 同一纪律）。

| 步 | 动作 | 影响文件 | 验证 | 可独立提交 |
|---|---|---|---|---|
| **M0** | 建 `test/_domain-graph.js`（纯分析器：`strip/countLines/definedNames/thisCalls/requireTargets/combinedGraph/findCycles/rankOf/parseModuleExportsKeys`）+ 自测 | 新增 1 文件 | `node test/_domain-graph.js` 打印：require 环 = 五域全 0；this 跨文件 = **127**；mixin SCC = {instance:1, plugin:1, router:2} | ✅ |
| **M1** | 建 `test/domain-structure-gate-test.js`，实现 DG-1/2/3/5/7/8/11/12/13/14（**不含** DG-4/6/9/10 —— 依赖契约文件或探针）；**同时写全反向自检** | 新增 1 文件 + `package.json` scripts.test 追加 | `node --require ./test/_preload.js test/domain-structure-gate-test.js`；预期 FAIL = {DG-1: relay,router; DG-2: 16 文件; DG-3: instance/core.js; DG-5b: 3 SCC; DG-7: 待实测; DG-8: **6 处**; DG-11: 待实测; DG-14: **5 处**} | ✅ |
| **M2** | 同步放宽旧门禁 `directory-structure-gate-test.js:170` 的 `ALLOWED` 为 R2 白名单（`providers instances policies model store handlers core jobs`）+ 更新其文件头注释与 DS-G6 | 旧门禁文件 | `node --require ./test/_preload.js test/directory-structure-gate-test.js` 仍 12/0（当前无新子目录，判据行为不变） | ✅ |
| **M3** | 五域建 `contract.js`（纯数据，先照抄现状导出面 + ctor 依赖，含现状违规项注释；含 `pure` 声明与 `abstract:true` 标注） | 新增 5 文件 | DG-9 从「未建即 FAIL」转为「一致即 PASS」 | ✅ |
| **M4** | 实现 DG-9（exports/classApi/deps 双向一致）+ DG-10（消费方 ⊆ PUBLIC_API，含 `domains/router/` 排除 ProxyInstance） | 门禁文件 | DG-9 全绿；DG-10 输出未登记消费清单（初值非空，逐域收敛） | ✅ |
| **M5** | 实现 DG-4（跨文件 this）+ DG-4b（豁免有契约出处）+ DG-4c（同名歧义）+ DG-4d（抽象占位白名单） | 门禁文件 | DG-4 报 **127** 处；豁免表 = E.3 的 11 个名字；DG-4d 识别 base.js 12 个抽象 | ✅ |
| **M6** | 实现 DG-6（独立 require 探针：子进程 + 临时状态根 + `ENTRY_FILES` 白名单；引用既有 PG-9 的 `require.main` 守卫判据而非重复） | 门禁文件 | 输出不可独立 require 的清单 | ✅ |
| **M7** | **instance 域拆分**：`store.js` 承接 `load/save/_syncInstancePorts/_ensureSandboxDirs/readInstalledVersion`；`core.js` 变纯；`projectTarget/listTargets/get` 进 Public API；`hooks` 端口 | instance 4→6 文件 | DG-3 该域转绿；DG-5b instance SCC 3→0（该域 1 个三节点 SCC 解体）；DG-4 instance 46→0；`node test/instance-state-test.js`、`instance-upgrade-test.js`、`instance-safety-test.js` | ✅ |
| **M8** | **plugin 域消费端口**：`opts.instances`→`opts.targets`；`JobModel` 独立类消除 ops↔jobs 环 | plugin 4→5 文件 | `node test/plugin-change-restart-test.js`（该测试 `:57-63` 注入桩 `instances` 需改名；`:73-81` 的 monkey-patch 需改为注入） | ✅ |
| **M9** | **relay 域消费端口**：`opts.instances`→`opts.source`（`RelayInstanceSource`）；`index.js` 降为门面（`createRelay` 移 `relay-server.js`） | relay 5→6 文件 | `node test/lan-daemon-test.js`、`lan-access-boundary-test.js`、`relay-source-gate-test.js` | ✅ |
| **M10** | **app/api 侧消费收口**：9 个文件 `this.instances.instances` → `list()/get()` | app×8 + api×1 | DG-11 转绿；`node test/session-lifecycle-test.js`、`test/ports-verify.js`、`test/token-boundary-test.js` | ✅ |
| **M11** | **facade 只读化（R7）**：5 个写动作下沉 `app/domain-actions/`；同步 `api/deps.js` 与 api 调用点 | `app/facade/{router,main,lan}.js` + 新增 `app/domain-actions/` | DG-14 转绿；`node test/api-surface-test.js`、`api-contract-test.js`（SURFACE 不变，但依赖项声明要改） | ✅ |
| **M12** | **router 域拆分**（最大工作量，可再分 3 批）：forward-core/router-ops 去反向（ctor 注入）；proxy.js 按副作用切 | router 13→18 文件 | DG-1/DG-2/DG-5/DG-7 该域转绿；`node test/router-ctl-test.js`、`p2p-api-test.js`、`provider-gateway-gate-test.js`（**注意：PG-1/2 已锁定 base.js 的抽象声明，拆分不得破坏 PG-1**） | ✅ 分 3 批 |
| **M13** | 删除 6 处 `Object.assign(X.prototype, …)`（instance/plugin/router/supervisor） | `instance/index.js`、`plugin/index.js`、`router/index.js`、`supervisor.js` | DG-8 转绿 | ✅ |
| **M14** | 门禁常数表归零：DG-4/DG-5b/DG-7/DG-11/DG-14 期望值改为 0；文档同步（DG-1..14 写入 `DIRECTORY-STRUCTURE-DESIGN.md §5.2`） | 门禁 + 文档 | 全绿 `npm test` | ✅ |

**硬编码路径与入链同步提醒**：
- `test/test-chain-completeness-test.js`（**N-a**，`:61-72`）强制 `domain-structure-gate-test.js` 必须入 `package.json` 的 `scripts.test`；
- `test/_domain-graph.js` 因非 `*-test.js` 且非 `_` 前缀外的助手规则（`:84-89`）会被视为「助手」**不误报**（`_` 前缀同样安全）；
- **R5**：`relay/daemon.js`、`router/daemon.js` 文件名**不得改**；M9/M12 只动目录内其他文件与 `basename` 之外的内容。相关 cmdline 匹配：`src/app/daemons/probe.js:27`、`src/app/daemons/process.js:85`、`test/round8-fixes-test.js:88,131,134`。
- 验证命令：`node --require ./test/_preload.js test/test-chain-completeness-test.js`。

---

## G. 风险与取舍

### G.1 破坏性改动（导出面变化 → 点名消费方）

| 改动 | 破坏面 | 缓解 |
|---|---|---|
| `InstanceManager` 删除 `instances` 数组公开访问 | app×8、api×1、plugin×2 文件、relay×1 文件、`test/ports-verify.js:66`、`test/token-boundary-test.js:91`、`test/session-lifecycle-test.js:157`、`test/plugin-change-restart-test.js:57-73` | **分两步**：先加 `list()/get()/projectTarget()`（M7），消费方逐个迁移（M8/M10），**最后**才移除数组访问（M14） |
| `sandboxRoot/sandboxDataDir/sandboxInstallDir` 从 Public API 降私有 | `plugin/ops.js:51-52`、`app/control/specs.js:47`；`instance/ops.js:205` 内部仍可 | `projectTarget` 必须**先于**降级可用（M7 同一提交） |
| `plugin opts.instances` → `opts.targets` | `app/assembly/compose.js:305`；`test/plugin-change-restart-test.js:68,73` | 迁移期支持双键（`opts.targets \|\| opts.instances`），M14 删旧键 |
| `relay opts.instances` → `opts.source` | `app/assembly/compose.js:305`（同一行）、`supervisor.js:107`、`relay/daemon.js:96` | 同上 |
| `router/index.js` 拆出 `ForwardCore`/`AuxService` | `api/domains/router.js` 23 处 `sup.router.*`、`app/facade/router.js:38-44`、`app/control/adapters.js:58` | **门面方法签名逐字保持**（照 `relay/index.js:12-15` 的「导出面逐字一致」契约写法），只换实现位置 |
| **R7 facade 写动作下沉** | `api/deps.js:76-82` 的 router 依赖清单（`api/deps.js:82 setRouterRunning`）、`api/deps.js:67` 的 guard 项、以及 `sup.patchDshMain`/`sup.setLanFrp`/`sup.lanFrpc` 等的调用点 | api 调用点改为调 domain-actions 或域对象；**`api/contract.js` 的 SURFACE（路由清单）不变** —— 只改内部实现路径 |
| 删除 mixin 并原型 | 无外部消费者（`module.exports` 面不变）；但**测试里有 monkey-patch 习惯**（`test/plugin-change-restart-test.js:73-81` 直接覆写 `pm._allSandboxTargets`、`pm.resolveTargets`） | 这些测试改为注入可替换依赖（符合 DF-6 精神） |
| DG-8 判据引入 | `supervisor.js:160-161` 是**编排层**既有关键机制（11 个 `app/*` 模块经它装配到原型） | 该处被 DG-8 判红属**预期**；修复归 `app/` 编排层改造（不属本专题），门禁须在文档里注明这是**已知待办**而非新缺陷 |

### G.2 不做的部分与理由

| 不做 | 理由 |
|---|---|
| **不建 `src/ports/` 顶层目录** | 新顶层目录会动 `DIRECTORY-STRUCTURE-DESIGN §3` 定版树；改为 `domains/<域>/contract.js` 平铺 + 消费方 ctor 注入即可达同样隔离度（R8 待裁决） |
| **不给 router 建「instance 依赖端口」** | 该耦合**不存在**（A.2.4）；建了就是「为设计而设计」 |
| **不改 `platform/`、`api/` 内部结构** | 属其他专题范围；本专题只保证门禁覆盖 `src/**`（DG-2 已含 platform/app） |
| **不重复 PG-9 的 daemon require 守卫判据** | `provider-gateway-gate-test.js:215-231` 已锁定「daemon 入口须有 `require.main` 守卫」；DG-6 只**引用**该判据结论，避免两份实现漂移 |
| **不做运行期强制（装配期 assertPort）** | 与 `api/deps.js:14-19` 同一判断：并行重构期做运行期校验会**双向冲突**（门面方法移动/改名而声明表未同步 → 误报运行故障）。先做静态门禁（DG-9/10），强制留 R9 裁决后 |
| **不把 `{base,proxy}` 继承 SCC 当违规** | 它是**合法多态**（12 个抽象占位 + 子类实现，A.3 ⑦）；而是加 `abstract:true` 声明与「有实现」检查（DG-4d） |
| **不追求一次清零** | 14 步分批；每步 FAIL 集合由常数表锁定，避免「大爆炸重构 + 门禁全红 → 被绕过」 |
| **不在门禁里判定「注释是否过期」** | 无法可靠判定；改为纪律：每个新判据必须写反向自检（DG-12 强制），比注释可靠 |

### G.3 判据自身的风险（门禁最容易腐化的地方）

| 风险 | 实证 | 对策 |
|---|---|---|
| **豁免表变垃圾桶**（DG-4b 的 `CONTRACT_HOOKS`） | `layering-and-dependency-gate-test.js:236-248` 的 L-2b 正是为防「登记表腐化」而设 | DG-4b：豁免项必须能在 `contract.js` 找出来源；且豁免项**必须仍被引用**（照 L-2b 逐字纪律） |
| **反向样本与匹配器无交集 → 假 PASS** | `directory-structure-gate-test.js:146-154` 明确记录旧样本「不含任何词 → DS-G8 假 PASS」 | DG-12：反向自检样本必须**复用判据本体**（照 `:136 domainWordsIn` 典范）并断言命中；再加「样本与词表/正则必有交集」的元断言 |
| **正则要求过窄 → 假阴性**（**R4 已实证**） | R4 原正则漏掉 3 处变量形态 + 误命中注释 | **DG-8 按 R6 替换**：右值不限 + 先剥注释 + 反向自检含变量样本（B.3.8） |
| **解析器只认一种写法** | `module.exports` 有 4 种形态（单键/双键/跨行 10 键/无导出） | DG-9 解析器必须对**当前 148 个文件**全部产出非空结果（存在性断言）；解析失败 **FAIL 而非跳过** |
| **注释里的关键字误报** | `instance/index.js:13,20`、`plugin/index.js:16,22`、`supervisor.js:21`、`router/daemon.js`/`relay/daemon.js` 模块说明 | 所有判据统一走 `strip()`；反向自检断言「注释里的 require/并原型不计入」（B.3.8 ④） |
| **硬编码行号 → 漂移即误报** | 本设计写作期间实测 `758→723→758`、`160→80→160` | **DG-13**：禁止以行号为断言目标；行号只作证据输出 |
| **行数口径不一致** | 现行 DS-G7 用 `split('\\n').length - (endsWith('\\n') ? 1 : 0)`（`directory-structure-gate-test.js:189`），`wc -l` 计尾换行 | 门禁内统一 `countLines`（照 DS-G7 口径并在注释说明）；文档标注与 `wc -l` 的 1 行差 |
| **判据代码与判据声明脱节** | `provider-gateway-gate-test.js:22-23` 如实标注「PG-1/2/3/4/5/7 预期 FAIL，不掩盖」 | 门禁头部按既有风格逐条列出 DG-1..14 与其覆盖；DG-12 断言「反向自检键集合 === 判据集合」 |

---

## H. 门禁建议

### H.0 收口结论

1. **现状可自动判定的硬结论**（全部本轮实测，可复现）：
   - **DF-1**（index ≤150，**R3 取严**）：**2 域 FAIL**（relay 502、router 763）；
   - **DF-2**（≤400，**R3 取严**）：**16 文件 FAIL**（domains 11 / app 2 / platform 3）；
   - **DF-3**：**1 处 FAIL**（`instance/core.js` require `node:fs`/`node:os`）；
   - **DF-4**：**127 处 FAIL**（instance 46 / plugin 34 / router 47；relay、shell 已 0）；
   - **DF-5**（**R1 口径**）：require 图 **0 环 ✓**；**mixin 造成的 this SCC 3 个 FAIL**（instance/plugin/router 各一）+ 1 个**合法**继承 SCC（router {base,proxy}）；
   - **DF-6**：待 M6 实测（`relay/daemon.js`、`router/daemon.js` 属进程入口，白名单 + 引用既有 PG-9）；
   - **DF-7**：至少 `plugin/store.js→ops.js`、`router/forward-core.js→index.js`、`router/router-ops.js→index.js` 三处**反向**；
   - **R6**（mixin 判据）：**6 处 FAIL**（`instance/index.js:31`、`plugin/index.js:33`、`router/index.js:758,759`、`supervisor.js:160,161`）；
   - **R7**（facade 只读）：**5 处 FAIL**（`facade/router.js:78`、`facade/main.js:41`、`facade/lan.js:44,54,59`）。
2. **本设计对既有认知的三处修正**（都影响后续所有域设计的前提）：
   - **DF-5 的 require 图是 DAG；环在「mixin 合并 this」里**（R1 裁决，本设计独立复算确认）——沿用 require-only 门禁会让 DF-5 永久假绿；
   - **router 不依赖 instance 域** —— 任务书所列的这条跨域耦合不存在（router 的 `instances` 是 ProxyInstance）；按错误前提会造出伪契约；
   - **`{base,proxy}` 的 this 边是继承多态（合法），不是隐式耦合** —— 本设计实测补充；朴素判据会误报 12 个抽象占位。
3. **门禁落点**：`test/domain-structure-gate-test.js`（**唯一产出文件**，本任务书指定）；分析器抽 `test/_domain-graph.js`
   以求 DG-4/5/7/9 共用**同一实现**（避免 4 份正则各写各的 → 口径漂移）。

### H.1 判据清单（DG-1..DG-14，逐条：断言 / 覆盖 / 反向自检）

| 判据 | 断言 | 覆盖 | 反向自检（必须能识别违规） |
|---|---|---|---|
| **DG-1** | 每域 `index.js` ≤150 行**且**去注释源码不含 `http.createServer`/`fs.writeFileSync`/`setInterval(` | DF-1 / R3 | ① 151 行样本命中；② 含 `http.createServer` 样本命中；③ 当前合规域（instance/plugin/shell）返回空 |
| **DG-2** | `src/**/*.js` ≤400 行 | DF-2 / R3 | ① 401 行命中、400 行不命中（边界 ±1）；② 真实命中 ≥16（常数表） |
| **DG-3** | `contract.pure` 声明的文件零 IO require | DF-3 | ① `require('node:fs')` 命中、`require('./y')` 不命中；② 真实命中 ≥1（`instance/core.js`） |
| **DG-4** | 域内跨文件 `this.X()` = 0（剔除语言关键字 + 契约豁免 + 抽象占位） | DF-4 | ① 夹具 A`save`+B`this.save()` 命中 1；② B 自定 `save` 命中 0；③ 真实 `this.X()` 总数 ≫0 且跨文件数 = 常数 **127** |
| **DG-4b** | 豁免表每项在 `contract.js` 有出处 | DF-4 | ① 假豁免 `__nope__` 命中；② 真豁免 `tokenOf` 不命中 |
| **DG-4c** | 同级兄弟文件无同名方法定义（白名单 `constructor` 等） | DF-4 | ① 两夹具都定义 `canPersist` 命中；② 只一个定义不命中 |
| **DG-4d** | 抽象占位（throw `must be implemented`）不计违规，但须有子类实现 | DF-4 防误报 | ① 抽象方法无实现 → 命中；② `base/proxy` 12 个抽象 → 不计违规并输出「已知合法」 |
| **DG-5a** | 域内 require 图 = DAG | DF-5 / R1 | 夹具 `A require B` + `B require A` 命中；真实 0 环（常数） |
| **DG-5b** | 无 `Object.assign(X.prototype,…)` 产生的 SCC | DF-5 / R1 | 夹具 `A require B` + `B this.m()`（m 定义在 A）命中 1；真实 mixin SCC = {instance:1,plugin:1,router:2}（常数） |
| **DG-5c** | 继承 SCC 显式豁免并输出 | DF-5 / R1 | `{base,proxy}` 型（extends + 抽象占位）→ 不算违规 |
| **DG-6** | 非 `ENTRY_FILES` 域文件可 `require` 且零顶层副作用 | DF-6 | ① 顶层 `setInterval` 命中；② 空导出模块不命中；③ 探针复用 `DSH_SUPERVISOR_HOME`（≠真机路径）；④ 引用 PG-9（不重复实现） |
| **DG-7** | 域内依赖方向单调（rank 不下降） | DF-7 | ① `store→core` 命中；② `index→store` 不命中；③ 未归类 `foo.js` 命中「未归类」 |
| **DG-8** | 剥注释后无 `Object.(defineProperties\|assign)(<x>.prototype, …)`（**R6 组合判据**） | DF-4 机制 / R4+R6 | ① **`Object.assign(X.prototype, mod.methods)` 命中**（R6 指定）；② `Object.defineProperties(X.prototype, require('./x'))` 命中；③ `Object.assign({}, a)` **不**命中；④ 注释样本不命中；⑤ 真实命中 = **6**（常数） |
| **DG-9** | `contract.exports/classApi/deps` ≡ 实际导出/类方法/ctor `opts.*`（双向） | 域间契约 | ① `exports=['a']` vs `{a,b}` → `extra=['b']`；② `['a','c']` → `missing=['c']`；③ 解析器对全部 `index.js` 非空 |
| **DG-10** | 消费方成员 ⊆ 目标域 PUBLIC_API（排除 `domains/router/`） | 域间契约 | ① 越权成员命中；② `sup.instances.list()` 不命中 |
| **DG-11** | 域外无 `.instances.instances` 穿透 | 域间契约 | ① `sup.instances.instances.find()` 命中；② `sup.instances.list()` 不命中 |
| **DG-12** | 门禁非空转（文件数 ≥140、字节下界、`this.X()` ≥400、反向自检数 = 判据数） | 全部 | 断言反向自检键集合 === 判据名集合（少一条即 FAIL） |
| **DG-13** | 门禁源码不得以行号为断言目标 | 门禁卫生 | ① `x.line === 758` 命中；② 证据字符串不命中 |
| **DG-14** | `app/facade/*` 无写动作（例外表须有理由） | **R7** | ① `setRouterRunning(){}` 命中；② `routerStatusView(){}` 不命中；③ 例外 `listLan` 不命中；④ 真实命中 = 5（常数） |

### H.2 R4/R6 指定判据（原文照录，含反向自检）

**R4 原文**（已被 R6 修正，保留在此以记录裁决链）：

    /Object\.(defineProperties|assign)\(\s*\w+\.prototype\s*,\s*require\(/

**R6 裁决：替换为三条组合，且必须先剥注释**

    // ① 任何把外部方法集挂到原型的手法（右值不限）
    const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
    // ② 分片导出形态
    const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
    // ③ 反向自检必须含 Object.assign(X.prototype, mod.methods) 这个样本

**反向自检实测**（本轮已跑）：

| 样本 | 结果 | 期望 |
|---|---|---|
| `Object.assign(X.prototype, mod.methods)` | **HIT** | HIT ✅（R4 漏掉、R6 要求补） |
| `Object.defineProperties(X.prototype, require('./x'))` | **HIT** | HIT ✅ |
| `Object.assign({}, a)` | MISS | MISS ✅ |
| 注释 `// Object.assign(InstanceManager.prototype, ...) 并入同一原型` | （无 strip 时 HIT，**strip 后 MISS**） | MISS ✅（先剥注释） |
| 真实源码（strip 后） | **6 处** | 见 A.3 ⑤ 表 |

**`METHODS_FRAGMENT` 实测命中 28 个文件**（`app/audit/orphan-scan.js`、`app/control/*`、`app/ctl/*`、`app/daemons/*`、`app/facade/*`、`app/main/*`、`app/settings/*`、`app/state/store.js`、`app/state/main-store.js`）——
它是 `supervisor.js:160 Object.assign(Supervisor.prototype, mod.methods)` 的配套形态；作为**报告项**（非 FAIL），用于一致性检查。

### H.3 落地形态（照既有风格）

    #!/usr/bin/env node
    'use strict';
    // ═══════════════════════════════════════════════════════════════════════════
    // 域结构与域间契约门禁（DOMAIN-DESIGN-BRIEF DF-1..7 + 域间契约 + RULING R1–R7）
    //
    // ## 锁定的不变量
    //   DG-1  门面 ≤150 行且不含业务逻辑          （DF-1 / R3）
    //   DG-2  单文件 ≤400 行                      （DF-2 / R3）
    //   DG-3  声明为纯的文件零 IO require          （DF-3）
    //   DG-4  域内跨文件 this.X() = 0              （DF-4）[+4b 豁免出处 / 4c 同名 / 4d 抽象]
    //   DG-5  require 图 DAG + 无 mixin 造成的 SCC （DF-5 / R1）
    //   DG-6  非入口文件可独立 require             （DF-6）
    //   DG-7  域内依赖方向单调                     （DF-7）
    //   DG-8  无 Object.(defineProperties|assign)(X.prototype, ...) （R4→R6）
    //   DG-9  contract.js ↔ 实际导出/ctor 双向一致
    //   DG-10 消费方成员 ⊆ 目标域 PUBLIC_API
    //   DG-11 域外无 .instances.instances 穿透
    //   DG-12 门禁非空转（存在性下界 + 反向自检完备）
    //   DG-13 门禁不以行号为断言目标（只作证据）
    //   DG-14 app/facade/* 只读，写动作在 app/domain-actions/  （R7）
    //
    // ## 与 directory-structure-gate-test.js 的分工
    //   那份管**层间**（DS-G1..G8，含 DS-G6 子目录白名单=R2 放宽值）；
    //   本份管**域内与域间契约**（DG-1..DG-14）。
    //   两者共用反向自检纪律：判据本体抽纯函数、正反共用；样本必须与匹配器有交集；
    //   并统一 strip()（R1 取证陷阱：注释里的 require 会伪造环）。
    //
    // ## ⚠ 已知待办（如实报告，不掩盖 —— 照 provider-gateway-gate-test.js:22-23 纪律）
    //   DG-8 会命中 supervisor.js:160-161 —— 那是**编排层**既有关键装配机制（11 个 app/* 模块
    //   经它挂到原型），属 app/ 层改造范围，不是本轮域改造新引入的缺陷。
    // ═══════════════════════════════════════════════════════════════════════════
    const fs = require('node:fs');
    const path = require('node:path');
    const G = require('./_domain-graph');            // 纯分析器
    const results = [];
    const check = (n, c, x) => { results.push(!!c); console.log((c?'PASS':'FAIL')+' '+n+(x?'  <- '+x:'')); };
    // …每条判据：const v = judgeX(...); check('DG-x …', v.length===0, evidence);
    // …每条判据紧跟 check('DG-x 反向：…', reverseSelfChecks['DG-x'](), 'hit');
    console.log('\n结果: ' + (results.length - results.filter(x=>!x).length) + ' passed, ' + results.filter(x=>!x).length + ' failed');
    process.exit(results.every(Boolean) ? 0 : 1);

### H.4 关键判据实现要点（`strip` 与 `definedNames` —— 全门禁共用的地基）

    /** 去注释：块注释 + 行注释。R1 取证陷阱：router/daemon.js、relay/daemon.js 的模块说明
     *  里含 require 字符串，不剥注释会伪造「daemon 自环」；instance/index.js:20 等注释含
     *  Object.assign(...prototype...) 会伪造 mixin 命中。 */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    /** 方法名定义识别：class 体 / 对象字面量 / 顶层 function 三种形态，
     *  并剔除语言关键字（if/for/while/return/constructor…）。 */
    const KEYWORDS = new Set(['if','for','while','switch','catch','return','function',
      'constructor','of','in','do','else','new','typeof','await','delete','throw','try']);
    function definedNames(src) {
      const s = new Set(); let m;
      const reClass = /^\s{2,6}(?:async\s+)?(?:get\s+|set\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
      while ((m = reClass.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
      const reObj = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
      while ((m = reObj.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
      const reFn = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
      while ((m = reFn.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
      return s;
    }
    const countLines = (s) => s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;

⚠ **`strip` 的已知缺陷（照实记录，供实现时加固）**：正则 `(^|[^:])\/\/` 用 `[^:]` 兜「协议里的 `//`」，
但遇 `http://x // y` 这类「同行既有 URL 又有注释」仍会误删尾段。当前源码未见该形态；
实现时建议在 DG-12 的元断言里加「`strip` 前后 require 边数差 ≤ 已知注释边数」以防回归。

### H.5 入链与文档同步

| 动作 | 文件 | 验证 |
|---|---|---|
| 门禁入 `scripts.test`（追加到链尾，照 `directory-structure-gate-test.js` 的现有位置） | `package.json` | `node --require ./test/_preload.js test/test-chain-completeness-test.js`（**N-a** 强制） |
| 旧门禁 `ALLOWED` 放宽为 R2 白名单 | `test/directory-structure-gate-test.js:170` | 该门禁仍 12/0 |
| DG-1..DG-14 写入 `DIRECTORY-STRUCTURE-DESIGN.md §5.2`「新增门禁」表（与 DS-G1..G8 并列）；DS-9/DS-6 按 R2/R3 改严 | `DIRECTORY-STRUCTURE-DESIGN.md` | 人工 |
| 域间契约 SSOT 落位 | 各域 `contract.js` + `DOMAIN-STRUCTURE-DESIGN.md`（合并时） | DG-9 绿 |
| 本设计的三处修正（DF-5 口径 / router-instance 不存在 / `{base,proxy}` 是合法继承）与 R1–R7 结论 | 合并进 `DOMAIN-STRUCTURE-DESIGN.md` §「方法论修正」 | 主代理合并时 |

---

## 附录：本轮实测命令与产物（只读，无进程、无状态根写入）

| 用途 | 方式 |
|---|---|
| 行数 | `wc -l` 全仓 + 门禁口径 `countLines` |
| require 边 | Node 脚本静态正则 `require\(\s*['"](\.[^'"]+)['"]\s*\)`（匹配任意位置，含函数内惰性 require），**先 strip** |
| this 跨文件 | `definedNames`（class 体/对象字面量/顶层函数 + 关键字剔除）+ `this\.(\w+)\(` + 同域他文件定义 |
| 组合图环 / SCC | 三色 DFS（`state` 0/1/2），记录环上每条边的类型（require / this.X） |
| 并原型 | R6 判据 `MIXIN_INTO_PROTOTYPE` + `strip`；实测 6 命中、3 注释假阳性 |
| 抽象占位 | 匹配方法体 `throw new Error('… must be implemented …')`；base.js 12 个 |
| facade 方法面 | `definedNames` 扫 `app/facade/*.js` + 动作白名单 |
| 消费面 | 正则统计 `(this\|host\|sup).instances.<member>`、`host.router`、`sup.router` 等 |
| 既有门禁基线 | `node --require ./test/_preload.js test/directory-structure-gate-test.js` → **12 passed / 0 failed** |
| **未使用** | 任何 `spawn`/daemon 启动/端口探测；未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor`、`~/.dsh`、已安装包 |

