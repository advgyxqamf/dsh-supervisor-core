# instance 域 功能设计

> 范围：`src/domains/instance`（index.js 33 行 / core.js 397 行 / ops.js 449 行 / upgrade.js 407 行，合计 1286 行）。
> 只做设计，不改 `src/`，不 commit，不启动任何守卫进程。
> 本文所有 `文件:行号` 均来自实际 `read`（行号为该文件内 1-based 行号）。方法论：`DOMAIN-DESIGN-BRIEF.md` §2/§3/§5；
> 跨层 SSOT：`DIRECTORY-STRUCTURE-DESIGN.md`；主代理裁决 `design-notes/_RULING.md`（R1–R7）。

---

## §0 结论速览（四个必答问题）

| # | 问题 | 结论 |
|---|---|---|
| 1 | ops.js 调 `this.save()/this.sandboxRoot()/this._probeState()`…（都定义在 core.js）用 §3 哪种手法消解？ | **混合，以 A（具名导出）为主、B（构造注入）用于有状态协作方、C（参数显式化）用于纯计算**。14 个 ops→core 方法对、28 处调用点，**逐条**见 **E 节**（E.1）。核心判定：`save` 属有状态持久化 → **B**；沙箱路径/命令、状态机转移、`taskStateToView` 属纯计算 → **A/C**；`installSandbox` 是**反向**依赖（upgrade 在 lifecycle 之上），必须**注入**不能 require，否则成环。 |
| 2 | core.js 397 行混了什么？按 §2 第一刀怎么切？ | 混了 **10 类**职责（逐类取证见 A.1.2）。对照组：任务点名的六类**全部命中且超额** —— 构造=#1、纯状态/算法=#2#5#10、持久化=#3#4、探测=#8、视图=#7、状态机=#10，另多出 #6（CRUD 更新）、#9（LAN 回调）。**第一刀按副作用切**：纯计算 → `model.js`（记录与视图）、`sandbox.js`（路径/命令/能力）、`state-machine.js`（相位转移）；IO → `store.js`（持久化 + 目录 + 端口投影）；**剩下的 `class InstanceManager` 不是 "core"** —— 它是**组装根 + 门面 + 委托层**，应下沉到 `index.js`（C 节、E.3）。当前 `core.js` 这个名字是**误名**：它既含 IO 又含构造与视图，BRIEF §4 的 "core.js = 纯核心（无 IO）" 不成立。 |
| 3 | upgrade.js 与 ops.js 的「启停清理」边界是否清晰？ | **不清晰，且方向是反的**。`upgradeInstance` 直接调 `this.startInstance/this.stopInstance`（upgrade.js:295/309/248 → ops.js:307/337），而 `startInstance` 的沙箱分支又反向调 `this._installSandbox`（ops.js:328 → upgrade.js:53）—— 这是**双向**依赖。边界判据：**「装什么」归 upgrade、「怎么把单元跑起来」归 lifecycle、「一次操作的编排顺序」归 ops**。升级里的 stop→装→start→验证→回滚是**编排**，应显式依赖 lifecycle（DAG：upgrade → lifecycle）；lifecycle 需要的"首次安装"经 **index.js 注入**（手法 B），环才消失。 |
| 4 | core.js → upgrade.js 的 2 处调用（`_readInstalledVersion` core.js:239 / `_taskStateToView` core.js:263）方向合理吗？ | **方向不合理，且两者性质不同**：① `_readInstalledVersion` 是**读盘 IO**，被 `list()`（视图）调用 = **视图层越过编排层直接读安装目录**，方向是 core→upgrade（上层）；应改为 **手法 C**：`model.viewRow(inst, { version, latest, updateAvailable })`，由 **index.js** 在组装期把 `upgrade.readInstalledVersion` 作为取值器注入。② `_taskStateToView` 是**纯映射**（3 行），却住在 upgrade.js（因"只服务本职责"），被视图与 upgradeStatus 共用 → 应下沉 `model.js`，两侧都 require 它（手法 A）。拆完后 **core→upgrade 这条边彻底消失**。 |

**实测校正（对照 BRIEF §0 的表格）**：BRIEF 记 instance 域"20 条"域内跨文件 `this` 调用；**实测 22 个方法对 / 46 处调用点**（剥注释后静态解析，A.2 逐条列出）。按 R1 的先例，**以实测为准**。

---

## A. 现状审计

### A.1 文件清单与职责

#### A.1.1 逐文件（实测行数来自 `read`）

| 文件 | 行数 | 当前职责（按 read 归纳） | 问题 |
|---|---|---|---|
| `index.js` | 33 | **唯一组装点**：`require('./core')` + `require('./ops')` + `require('./upgrade')`，然后 `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods)`（index.js:26-31）；`module.exports = { InstanceManager }`（index.js:33） | 只有 5 行是代码（26/27/28/31/33），其余 28 行是注释；但**用了 §3 明令禁止的 mixin 手法**（R6 判据），把 ops/upgrade 的方法集挂到 core 的同一 `this` 上 → 22 对隐式耦合正是从此而来 |
| `core.js` | 397 | **8 类混装**（A.1.2）：构造 DI、能力门、持久化、端口投影、沙箱布局、CRUD 更新、视图组装、探测、运行状态机 | 单文件贴 R3 阈值（≤400）；纯/IO 未分离（DF-3✗）；被 ops/upgrade 反向依赖 |
| `ops.js` | 449 | CRUD（add/remove）、systemd 启停与清理、单实例监督拍、兜底定时器；导出 `{ opsMethods }` 对象字面量 | 超 R3 阈值 49 行；**28 处跨文件 `this` 私调**（DF-4✗）；含**无实例的可达栈**（A.4） |
| `upgrade.js` | 407 | 沙箱 DSH 首次安装（作业化 + 10min 看护）、版本检测、升级 + 回滚 + 验证、作业收尾、（错位的）纯映射与版本读盘 | 超 R3 阈值 7 行；`upgradeInstance` 单方法 160 行（code 122）；反向依赖 ops |

#### A.1.2 core.js 到底混了什么 —— 逐段证据（必答问题 2 的取证）

| # | 职责类别 | core.js 行区间 | 内容 | 应归 |
|---|---|---|---|---|
| 1 | **构造 + DI 字段编排** | 39-99 | 10 个 ctor 选项 → 22 个字段（dir/logger/events/dist/dshBin/service/instancesFile/instancesRoot/systemdDir/systemdTemplatePath/instances/_timer/tokens/_updCache/_updJobs/_updTTL/tasks/_sandboxSupportedOverride/6 个回调） | `index.js` 组装根 |
| 2 | **平台能力门** | 100-118 | `get sandboxSupported()`（实时求值 + 60s 负 TTL）、`_setSandboxSupportedForTest()` | `sandbox.js`（纯判决）+ index 委托 |
| 3 | **持久化** | 120-189 | `load()`（120-145，含 dshToken 剔除 129、FAILED→STOPPED 132-135、令牌源登记 140）、`save()`（171-186，`_lastBody` 去重 177、0o600 原子写 181-182） | `store.js` |
| 4 | **端口投影对账** | 152-169 | `_syncInstancePorts()`：instances → `ports.registerUser/unregister` 全量对账 | `store.js`（持久化派生） |
| 5 | **沙箱布局/命令** | 190-210、288-305 | `sandboxRoot/sandboxDataDir/sandboxInstallDir`（190-194）、`_sandboxCommand`（203-208）、`_defaultCommand`（290-293）、`effectiveCommand`（298-304） | `sandbox.js`（纯） |
| 6 | **CRUD 更新** | 211-235 | `updateInstance`：guardian/remoteEnabled/remoteToken/memoryMax/cpuQuota 补丁 + 事件 + 回调 | `ops.js` |
| 7 | **视图组装** | 237-289 | `list()`：53 行里嵌了三处逻辑 —— 版本（239）、更新作业视图（256-271，IIFE 内查 TaskRegistry）、状态视图（272-283 手抄 9 个字段） | `model.js`（纯行组装）+ 注入取值器 |
| 8 | **探测** | 306-319 | `_probeState`（306）、公开 `probeInstance(id)`（312） | `lifecycle.js`（薄壳 `platform/service/monitor`） |
| 9 | **LAN 回调** | 320-330 | `_startLanForInstance/_stopLanForInstance` | `hooks` 注入（B） |
| 10 | **运行状态机** | 331-397 | `_setRunning`（331-354，含 5min 稳定窗归零 338-344 + 令牌 attach/schedule 349-353）、`_setStopped`（357-362）、`_failInstance`（365-372）、`_restartInstance`（375-394，含 20 次上限 378-382 + `shared/guardian.instanceRestartDecision` 387） | `state-machine.js`（纯转移）+ 注入 events/save/tokens |

> 结论：**10 类**（要求"至少 6 类"）。其中 **#1-#8、#10 全在同一个 class 体内**，正是"文件搬家 ≠ 拆分"的取证：
> #6/#7 本该在编排/纯模型，却与 #3 的持久化同处一室；#9 只是转发两个回调字段，却让 class 多出 10 行。

#### A.1.3 消费方（外部契约面，必须冻结）

| 消费方 | 位置 | 消费的方法/字段 |
|---|---|---|
| 组装根 | `src/app/assembly/compose.js:23`（require）、`:224`（`new InstanceManager({...})`）、`:233` load()、`:272` onRemoteChange=、`:276` onRemove=、`:282` onInstanceStart=、`:287` onInstanceStop=、`:293` onCreate=、`:294` onDestroy=、`:305/357`（装进 sup） | constructor + 6 个回调字段 |
| HTTP 域 | `src/api/domains/instances.js:76,127,153,161,162,167,170,179,191,192,193` | list / addInstance / removeInstance / updateInstance / startInstance / stopInstance / checkUpdate / upgradeInstance / upgradeStatus / instances |
| 编排层心跳 | `src/app/control/instance-adapter.js:18-20,27-28,42` | supervise / probeInstance / instances |
| 编排层门面 | `src/app/facade/main.js:73`、`src/app/control/specs.js:47,67`、`src/app/control/adapters.js:103`、`src/app/daemons/runtime.js:70`、`src/app/audit/orphan-scan.js:40`、`src/app/session/shutdown.js:117,126`、`src/app/state/store.js:101-118` | instances（活数组）、sandboxRoot、save |
| 邻域 | `src/domains/plugin/jobs.js:91,104,108`、`src/domains/plugin/ops.js:51,52,74,85`、`src/domains/relay/manager.js:50,55` | probeInstance / stopInstance / startInstance / sandboxDataDir / sandboxInstallDir / instances / save |
| 组装期兜底 | `src/app/assembly/bootstrap.js:103` startTimer(...)、`:108` instances | startTimer / instances |
| 顶层 | `src/supervisor.js:107`（instances: 传给 compose 上下文）、`:120` instances.save() | save |
| **测试** | `test/instance-state-test.js:12`、`test/round13-discipline-gaps-test.js:96,129`、`test/instance-upgrade-test.js:25,34`、`test/instance-systemd-aside-behavior-test.js:55,81`、`test/token-boundary-test.js:90` | _restartInstance/_setRunning/_failInstance/_setStopped、removeInstance、ctor{service}、_setSandboxSupportedForTest/_prepareSystemd/_systemdStart/_ensureSandboxDirs/sandboxInstallDir、load |

### A.2 域内耦合图（逐条）

#### A.2.1 require 边（**先剥注释**，R1 取证要求）

实测（静态解析 + 剥注释）：

    index.js   → ./core, ./ops, ./upgrade
    core.js    → (域内 0 条)
    ops.js     → (域内 0 条)
    upgrade.js → (域内 0 条)

→ **域内 require 图是 DAG**（星形，3 条边）。R1 已验证五域全部 0 环；instance 域**没有**循环 require 问题。真实病症是 **this 调用图的环**（下节）。

#### A.2.2 this 跨文件调用边（**逐条**，按调用方文件分组）

实测 22 个方法对 / 46 处调用点：

**[core.js → upgrade.js] 2 对 / 2 处**

| # | 调用 | 位置 |
|---|---|---|
| 1 | `this._readInstalledVersion(inst)` | core.js:239 |
| 2 | `this._taskStateToView(tt.state)` | core.js:263 |

**[ops.js → core.js] 14 对 / 28 处**

| # | 调用 | 位置（行号） |
|---|---|---|
| 1 | `this.save()` | ops.js:130, 162, 286, 293, 343, 428 |
| 2 | `this.sandboxInstallDir(inst)` | ops.js:269, 326 |
| 3 | `this._restartInstance(inst, …)` | ops.js:376, 402, 408, 421, 422 |
| 4 | `this._failInstance(inst, …)` | ops.js:380, 391, 395 |
| 5 | `this._probeState(inst)` | ops.js:255, 360 |
| 6 | `this._setRunning(inst, st, now)` | ops.js:373, 401 |
| 7 | `this.sandboxRoot(inst)` | ops.js:205 |
| 8 | `this.sandboxDataDir(inst)` | ops.js:268 |
| 9 | `this.effectiveCommand(inst)` | ops.js:252 |
| 10 | `this._ensureSandboxDirs(inst)` | ops.js:325 |
| 11 | `this._setStopped(inst)` | ops.js:409 |
| 12 | `this._startLanForInstance(inst)` | ops.js:294 |
| 13 | `this._stopLanForInstance(inst)` | ops.js:344 |
| 14 | `this._installSandbox(inst)` | ops.js:328（见下方 [ops→upgrade]） |

**[ops.js → upgrade.js] 1 对 / 1 处**：`this._installSandbox(inst)` @ ops.js:328（上表 #14）。

**[upgrade.js → core.js] 4 对 / 13 处**

| # | 调用 | 位置（行号） |
|---|---|---|
| 1 | `this.save()` | upgrade.js:75, 87, 104, 110, 121, 146, 354, 368 |
| 2 | `this.sandboxInstallDir(inst)` | upgrade.js:68, 167, 235 |
| 3 | `this._ensureSandboxDirs(inst)` | upgrade.js:69 |
| 4 | `this._probeState(inst)` | upgrade.js:243 |

**[upgrade.js → ops.js] 2 对 / 3 处**

| # | 调用 | 位置 |
|---|---|---|
| 1 | `this.startInstance(id, { fromUpgrade: true })` | upgrade.js:295, 309 |
| 2 | `this.stopInstance(id)` | upgrade.js:248 |

**[回调字段调用（无域内定义，靠外部赋值）] 6 个字段 / 7 处**

| # | 调用 | 位置 | 赋值点 |
|---|---|---|---|
| 1 | `this.onRemoteChange(inst)` | core.js:225 | compose.js:272 |
| 2 | `this.onInstanceStart(inst)` | core.js:322 | compose.js:282 |
| 3 | `this.onInstanceStop(inst)` | core.js:327 | compose.js:287 |
| 4 | `this.onCreate(inst)` | ops.js:132 | compose.js:293 |
| 5 | `this.onRemove(id, instances)` | ops.js:215 | compose.js:276 |
| 6 | `this.onDestroy(id)` | ops.js:216 | compose.js:294 |

（另 `core.js:78` 是 `onRemove` 的声明处，非调用。）

#### A.2.3 this 调用图的 SCC（实测）

对 {core, ops, upgrade} 做可达性闭包：**1 个 SCC = {core, ops, upgrade}**（三文件互相强连通）。

这**不是** require 环（A.2.1 的 DAG 是证），而是 R1 所说的**真病症**：

> `index.js:31` 的 `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods)`
> 把三个文件的方法集**注入到同一个 this**；方法体于是可以互相 `this.X()` 私调。
> 改名/搬文件后 require 图仍是 DAG，而 DF-4/DF-6 依旧被违反 —— 这正是 **"文件搬家 ≠ 拆分"**。

#### A.2.4 共享可变状态矩阵（DF-4 的真代价）

`this.<字段>` 触碰次数（剥注释）：

| 字段 | core | ops | upgrade | 说明 |
|---|---|---|---|---|
| `instances` | 11 | 12 | 2 | **活数组**（外部 20+ 处直接读，含 splice/赋值替换） |
| `tasks` | 5 | 7 | **50** | TaskRegistry（upgrade 的作业全靠它） |
| `logger` | 10 | 22 | 14 | — |
| `events` | 11 | 14 | 4 | — |
| `dist` | 1 | 0 | 14 | 分发服务（安装/查版） |
| `service` | 1 | 6 | 0 | 平台服务 Provider |
| `tokens` | 6 | 6 | 0 | 令牌服务 |
| `_updCache` / `_updJobs` | 2 / 2 | 0 / 0 | 6 / 6 | 瞬态表（core 声明、upgrade 写、core 视图读） |
| `_sandboxSupportedOverride` | 4 | 0 | 0 | 测试门 |
| `_lastBody` | 2 | 0 | 0 | save 去重态 |
| `_latestDshVer(At)` | 0 | 0 | 3 / 2 | **只在 upgrade 用，却要在 core 构造期存在** |
| `_timer` | 1 | 3 | 0 | **只在 ops 用，却要在 core 构造期存在** |
| `onRemoteChange` | 3 | 0 | 0 | 回调 |
| `onRemove` | 1 | 2 | 0 | 回调 |
| `onCreate/onDestroy` | 1 / 1 | 2 / 2 | 0 / 0 | 回调 |
| `onInstanceStart/Stop` | 3 / 3 | 0 / 0 | 0 / 0 | 回调 |

> `_timer`（ops 专用）与 `_latestDshVer/_latestDshVerAt`（upgrade 专用）**遗留在 core 的构造函数里**，
> 是"文件搬了、状态没搬"的直接证据 —— 它们各自应在 ops / upgrade 自己的状态里。

### A.3 病症清单（对照 §0 四类，逐条给证据）

| 病症 | 判定 | 证据（文件:行号） |
|---|---|---|
| **1 巨型文件** | ✅ 成立 | core.js 397 / ops.js 449 / upgrade.js 407，**三文件全部 ≥397 行**（R3 阈值 400，ops 超 49）；`upgradeInstance` 单方法 upgrade.js:216-375 = **160 行**（其中 code 122 行）；`removeInstance` ops.js:139-239 = 101 行；`_installSandbox` upgrade.js:53-163 = 111 行 |
| **2 this 隐式耦合** | ✅ 成立（**本域主症**） | 22 方法对 / 46 调用点（A.2.2）；SCC={core,ops,upgrade}（A.2.3）；根因 `index.js:31` 的 `Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods)`。**编译期看不出来**：ops.js 里没有任何 `require('./core')`，`this.save()`（ops.js:130）能否解析只取决于 index.js 是否跑过那一行 |
| **3 循环 require** | ❌ **不成立** | 剥注释后域内 require 只有 4 条且全向下（A.2.1）；SCC 只在 **this 图**上（A.2.3）。**R1 裁决据此把 DF-5 重定义为「禁止把两个文件的方法合并到同一 this」** |
| **4 职责错位** | ✅ 成立（四处） | ① `core.js` 名为"纯核心"却含构造/IO/视图（A.1.2 #1#3#5#6#7）；② `upgrade.js` 持有纯映射 `_taskStateToView`（upgrade.js:376-383，3 行，却被 core.js:263 与 upgrade.js:389 两处消费）；③ `upgrade.js` 持有 `_readInstalledVersion`（upgrade.js:164-172，读盘）却被视图 `list()` 当取值器用（core.js:239）；④ `ops.js:41-78` 的 `_prepareSystemd` 是 **systemd 单元前置**（"怎么把单元建起来"），与同文件的 CRUD/监督并列 |

### A.4 需要点名的易失效点（写进 E 节，不擅自改）

- **A.4.1 注释与代码已漂移**：`index.js:17-19` 声称 `ops.addInstance → core.save/ports`、`upgrade.upgradeInstance → ops.startInstance/stopInstance`、`ops.supervise → core._probeState/_setRunning/_restartInstance`。前两条属实；但 `ops.addInstance` 实际调 `this.save()`（ops.js:130）与**直接 require 的 ports**（ops.js:18/104），不是"core.ports"。这正是"注释声称、代码没有"的同一类失效模式。
- **A.4.2 `sandboxSupported` 访问器必须留在 class 内**：`index.js:22-23` 已明确 —— `Object.assign` 取的是 getter 的**当前值**，会把访问器退化为数据属性。**拆完后 index.js 必须以 getter 委托**，并由门禁断言（H-6）。
- **A.4.3 测试的"真实执行"缝**：`test/instance-upgrade-test.js:36` `mgr._prepareSystemd = () => {};` 与 `:41` `mgr._ensureSandboxDirs = () => {};` 是**实例 owner 打补丁**。一旦这两处变成 index.js 闭包内的委托，赋值到实例上**不再拦截内部调用** → 会**真跑** `service.daemonReload()`（`systemctl --user daemon-reload`，`src/platform/os/service.js:52`）与真 `mkdirSync`。**这是迁移的硬前置**，见 F 步 9 与 G 节 R-2。

---

## B. 功能切面（★ 设计核心）

> **不看现有文件**，只回答"这个域在功能上由哪几块组成"。每块给出：输入 / 输出 / 副作用 / 是否纯。

| # | 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|---|
| B1 | **实例记录模型** | 定义实例记录形状，并把磁盘文档**升格**为运行时记录（迁移） | {instances:[…]} 文档 / 创建 payload | 规范化实例记录 | 无 | ✅ 纯 |
| B2 | **实例视图行** | 单个实例 → 前端契约行（id/name/port/state/更新态） | 实例 + 已解析的 version/latest/task | 视图对象 | 无 | ✅ 纯 |
| B3 | **任务状态词表** | TaskRegistry 状态 → 前端 done/failed/running | 'succeeded'… | 'done'… | 无 | ✅ 纯 |
| B4 | **沙箱布局** | 沙箱根/数据目录/依赖目录**路径**与启动命令、env、systemd 属性 | 实例 + 平台事实（process.execPath/PATH） | 路径串 / argv / env / props[] | 无 | ✅ 纯 |
| B5 | **运行状态机** | 相位转移 + 退避决策（RUNNING/STOPPED/FAILED/BACKOFF） | inst.state + now + guardian 开关 | 新 state + {waitMs,nextBackoffLevel} | 无（落盘/发事件由调用方做） | ✅ 纯 |
| B6 | **沙箱能力判决** | 本平台是否支持沙箱实例（Linux+systemd-run），含测试覆写位 | 覆写值 | bool | 平台探测（有 60s 负 TTL 缓存） | ~（域侧纯） |
| B7 | **实例持久化** | instances.json 原子读写 + 内容未变不写盘 | 实例数组 | 文件 | **写文件** | ❌ |
| B8 | **端口登记投影** | 实例端口 ↔ 全局端口注册表**全量对账**（增补/清除 inst:*） | 实例数组 | registry 变更 | **改 registry** | ❌ |
| B9 | **沙箱目录创建** | 建 <root>/data 与 <root>/install | 实例根路径 | 无 | **mkdir** | ❌ |
| B10 | **单元前置** | systemd 模板**改名让位** + daemon-reload | 模板路径 | bool | **改名文件 + 平台调用** | ❌ |
| B11 | **单元清理** | 清残留 transient 单元（stop/reset-failed/删文件/reload） | unit 名 | 无 | **平台调用** | ❌ |
| B12 | **单元启停** | systemd-run 拉起 / stopUnit 停止（含沙箱 env/工作目录装配） | 实例 + 命令 + env + props | {ok,error} | **进程/系统** | ❌ |
| B13 | **在线探测** | 端口+pid+cmdline 判定实例是否在跑 | 实例（或 id） | {pid,running,isDsh,phase} | 探测（网络/进程） | ❌ |
| B14 | **单实例监督拍** | 按相位收敛：探测 → 起/停/退避/判失败 | 实例 id | {ok} + 状态变更 | 经 B10-B13/B7 | ❌ |
| B15 | **集合 CRUD 编排** | 增/删/改实例 + 与在飞作业互斥 + 破坏性动作前置复核 | payload/id | {ok,instance,error} | 文件/端口/目录/回调 | ❌ |
| B16 | **端口可用性探测** | 新增前探测端口是否真的被占（registry ∪ 本机监听） | port | bool | 网络探测 | ❌ |
| B17 | **兜底定时器** | 定时遍历实例调监督拍（心跳不可用时的降级路径） | intervalMs | 无 | **setInterval** | ❌ |
| B18 | **沙箱 DSH 首次安装** | 经 dist 的 npm install -g --prefix 装独立副本（作业化 + 10min 看护） | 实例 | {ok,installing,error} | **npm/文件/任务** | ❌ |
| B19 | **已安装版本读盘** | 读沙箱 install 目录的 package.json.version | 实例 | version/null | **读文件** | ❌（只读） |
| B20 | **最高可用版本查询** | 经 dist 查 @deepseek-ai/dsh 最高版（30s 缓存） | 无 | version/null | **网络** | ❌ |
| B21 | **升级编排** | stop → 装目标版 → start → 等端口就绪 → 失败回滚 → 重启验证 | 实例 id | job 视图 | 经 B12/B18/B20 | ❌ |
| B22 | **升级视图与作业收尾** | current()/list() → 前端契约；完成后 60s 清理 _updJobs/_updCache | 实例 id | 视图对象 | **setTimeout(unref)** | ❌ |
| B23 | **外部钩子外发** | 实例启停/增删/远程开关变化 → 通知 LAN / 控制平面 | 实例/id | 无 | **调用外部** | ❌ |

**块数 = 23**。切分依据（§2 四把刀，按序）：

- **第一刀（副作用）**：B1-B6 纯 → model.js/sandbox.js/state-machine.js；B7-B23 有副作用 → store.js/lifecycle.js/ops.js/upgrade.js。
- **第二刀（变更频率）**：B4（沙箱布局，随 DSH 安装方式变）与 B5（退避阈值，随守护策略变）必须分开 —— 改退避不该触发沙箱布局重测。
- **第三刀（生命周期）**：B23（进程级回调）与 B17（定时级）与 B15（请求级 CRUD）分开。
- **第四刀（角色）**：B10-B13（平台传输/进程）vs B21（业务决策）vs B7（持久化）vs B22（观测）分开。

---

## C. 目标结构（★ 逐文件）

### C.1 目录树

    src/domains/instance/
    ├── index.js          门面 + 组装根：实例化各纯模块/IO 模块，注入协作方，导出 class（≤150，无业务逻辑）
    ├── model.js          纯：记录工厂/迁移(B1) + 视图行(B2) + 任务词表(B3)
    ├── sandbox.js        纯：路径/命令/env/props 装配(B4) + 能力判决(B6)
    ├── state-machine.js  纯：相位转移与退避决策(B5)
    ├── store.js          持久化：原子读写(B7) + 端口投影(B8) + 沙箱目录创建(B9)
    ├── lifecycle.js      IO：单元前置/清理(B10/B11) + 启停(B12) + 探测(B13) + 监督拍(B14)
    ├── ops.js            编排：CRUD(B15/B16) + 兜底定时(B17) + 钩子外发(B23)
    └── upgrade.js        编排：安装(B18) + 版本(B19/B20) + 升级回滚(B21) + 作业视图与收尾(B22)

> **遵循 R2**：全部用**扁平文件**（core/ops/store/model 规范名），**不建子目录** —— 本域没有"多个同类文件"，建 policies/ 只会过度碎片化。
> **命名遵循 DS-12**：**禁止** *-view / *-mixin / *-part。upgrade.js 保留原名（它确实只做沙箱 DSH 版本生命周期）；core.js **改名为 model.js**（C.3）。
> **无 daemon.js**：instance 域没有独立进程入口（R5 不适用）。

### C.2 逐文件（含旧文件:行区间映射）

| 新文件 | 行数估计 | 职责 | 从哪来（旧文件:行区间） | 纯? |
|---|---|---|---|---|
| `index.js` | ~95 | 组装根 + 兼容门面：建 store/sandbox/state-machine/lifecycle/ops/upgrade 的 ctx；组装 install 端口注入；类上只留**委托方法**与**访问器** | index.js:1-33（全部）+ core.js:39-99（构造/DI）+ core.js:100-119（能力门访问器）+ core.js:67-75（instances/_timer/瞬态表归位）+ core.js:190-194、312-319 等公开面的**委托行** | 否（组装） |
| `model.js` | ~140 | B1/B2/B3：createRecord(payload)、normalizeDoc(doc)（含 dshToken 剔除、FAILED→STOPPED、guardian 默认）、viewRow(inst, {version,latest,taskView})、taskStateToView(s)、PHASES 常量 | ops.js:105-128（记录字面量，原内联于 `addInstance`）；core.js:211-235（`updateInstance` 字段补丁）；core.js:120-145 的**纯迁移段**（129/130/132-136）；core.js:238-285（`list` 的行组装；方法体 237-289 含注释）；upgrade.js:376-383（`_taskStateToView`） | ✅ |
| `sandbox.js` | ~85 | B4/B6：root/dataDir/installDir/entryBin、command、effectiveCommand、defaultCommand、env（PATH 用 path.delimiter）、unitProps、supported | core.js:100-108（能力求值）+ 110-118（覆写）+ 190-210 + 288-305；ops.js:257-264（systemd 属性）+ 265-279（沙箱 env/工作目录） | ✅ |
| `state-machine.js` | ~85 | B5：setRunning(deps,inst,st,now)、setStopped(deps,inst)、fail(deps,inst,reason)、restart(deps,inst,reason)（用 shared/guardian.instanceRestartDecision） | core.js:331-394（4 个转移方法；class 体止于 395）；`shouldGuard` 决策来自 shared/guardian（ops.js:367 已在用） | ✅ |
| `store.js` | ~100 | B7/B8/B9：load()（读盘 → 调 model 迁移 → syncPorts）、save()（_lastBody 去重 + 0o600 原子写 + 降级不抛）、syncPorts()、ensureDirs(inst)、list()/add()/replaceAll()/find(id)（**活数组**单一持有者） | core.js:62-66（路径字段派生）+ 120-151（load 的 IO 段）+ 152-169（_syncInstancePorts 全部）+ 171-186（save 全部）+ 197-200（_ensureSandboxDirs） | ❌ |
| `lifecycle.js` | ~185 | B10-B14：prepareSystemd(ctx)、cleanStaleUnit(ctx,unit)、start(ctx,inst)（含 fromUpgrade 直通 + 首次安装经 **ctx.install**）、stop(ctx,id)、probe(ctx,inst)/probeById(ctx,id)、supervise(ctx,id) | ops.js:41-78（_prepareSystemd）+ 240-249（_cleanStaleUnit）+ 250-302（_systemdStart）+ 307-336（startInstance）+ 337-347（stopInstance）+ 355-433（supervise）；core.js:306-319（探测） | ❌ |
| `ops.js` | ~180 | B15/B16/B17/B23：add(payload)、remove(id)、update(id,patch)（原 core.updateInstance）、startTimer(intervalMs)、钩子外发 helper | ops.js:83-135（addInstance）+ 139-231（removeInstance）+ 438-446（startTimer）；core.js:211-235（updateInstance）；core.js:320-330（LAN 钩子 → 改为 ctx.hooks） | ❌ |
| `upgrade.js` | ~330 | B18-B22：install(ctx,inst)、readInstalledVersion(inst)、latestVersion(ctx)、checkUpdate(ctx,id)、upgrade(ctx,id)、status(ctx,id)、scheduleJobCleanup(ctx,id) | upgrade.js:31-44 + 47-159 + 162-210 + 213-372 + 381-404（**除 376-383 归 model**） | ❌ |

**行数验证**：最大 upgrade.js ~330 ≤ **400**（R3）✅；index.js ~95 ≤ **150**（R3）✅；无文件超阈值。
**不做的文件**：policies/、handlers/、scheduler/ —— 本域的策略只有退避与能力判决，体量不足以成目录（BRIEF §4"没有对应职责就不要建空文件"）。

### C.3 关键改名裁决：core.js → model.js，class 下沉 index.js

BRIEF §4 定义 core.js = 纯核心（无 IO）。当前 core.js **不满足**（含 load/save/构造/探测）。若保留 core.js 之名为"装配根 + 委托层"，会把一个**违反 SSOT 定义**的文件名固化成长期约定（DS-12：命名按职责）。

因此：

- 真正的纯核心（B1/B2/B3）→ **model.js**（领域模型：记录/视图/词表）。
- 真实的类（组装根 + 门面 + 委托）→ **index.js**（DIRECTORY-STRUCTURE-DESIGN D10「六域统一结构」的 index.js = 门面）。
- core.js **不保留**（避免与 SSOT 语义冲突，也避免"两个门面"）。

⚠ **消费方零影响**：index.js 仍 `module.exports = { InstanceManager }`，compose.js:23 与 6 处测试的 require 路径不变。

---

## D. 依赖图（★ 必须是 DAG）

### D.1 域内 require 图（目标）

    index.js
      ├─→ model.js           （纯：记录/视图/词表）
      ├─→ sandbox.js         （纯：路径/命令/能力）
      ├─→ state-machine.js   （纯：相位/退避）
      ├─→ store.js           （持久化）
      ├─→ lifecycle.js       （单元/探测/监督）
      ├─→ ops.js             （CRUD/定时/钩子）
      └─→ upgrade.js         （安装/升级/作业）

    ops.js      → store.js, sandbox.js, state-machine.js, model.js, lifecycle.js
    upgrade.js  → store.js, sandbox.js, model.js, lifecycle.js
    lifecycle.js→ store.js, sandbox.js, state-machine.js, model.js
    state-machine.js → model.js
    store.js    → model.js, sandbox.js

**逐边理由**：

| 边 | 理由 | 手法 |
|---|---|---|
| index → 全部 | 门面是唯一组装点：绑定 rootDir/logger/events 等协作方，并注入 install 端口 | — |
| ops → store | CRUD 必须落盘（原 `this.save()`） | B |
| ops → sandbox | removeInstance 要 sandboxRoot 才能删目录（ops.js:205） | A/C |
| ops → state-machine | 监督拍的相位转移 | A/C |
| ops → lifecycle | CRUD 要停单元（removeInstance）、定时器要调监督拍 | A |
| ops → model | 记录构造与视图 | A |
| upgrade → lifecycle | 升级必须 start/stop 实例（upgrade.js:248/295/309） | A |
| upgrade → store | 安装/升级要落盘（8 处 `this.save()`） | B |
| upgrade → sandbox | 安装目录/入口路径（3 处 sandboxInstallDir） | A |
| upgrade → model | taskStateToView | A |
| lifecycle → store | 监督拍落盘、ensureDirs | B |
| lifecycle → sandbox | 命令/env/props 装配 | A/C |
| lifecycle → state-machine | 监督拍的相位转移 | A/C |
| lifecycle → model | 视图/记录（若需要） | A |
| store → model | load 期迁移（dshToken/FAILED→STOPPED） | A |
| store → sandbox | 目录路径派生 | A |

**⚠ 两条被消除的边**：

1. **core → upgrade**（core.js:239/263）—— 原为"视图直连安装实现"；改为 `model.viewRow(inst, {version})` + index 注入取值器 → **消失**。
2. **lifecycle → upgrade**（首次安装，原 ops.js:328 `this._installSandbox`）—— 若写成 require 则与 `upgrade → lifecycle` **成环**；改为 **index.js 注入 ctx.install**（手法 B）→ **不产生 require 边**。

**判据**：上图任意两点间没有回边（`upgrade → lifecycle` 与 `lifecycle → upgrade` 不同时存在）→ **DAG** ✅（DF-5）。且**跨文件 this. 调用 = 0**（DF-4）。

### D.2 跨域 / 跨层边（**标注是否合法，不擅自改**）

| 边 | 方向 | 合法性 | 处置 |
|---|---|---|---|
| instance → `platform/service/monitor`（core.js:28）、`platform/os/service`（core.js:33）、`platform/service/ports`（core.js:30、ops.js:18）、`platform/os/index`（core.js:105） | domains → platform | ✅ 合法（L1→L0） | 保持 |
| instance → `shared/guardian`（core.js:29、ops.js:19）、`shared/version`（core.js:31、upgrade.js:18） | domains → shared | ✅ 合法（L1→L0） | 保持 |
| `plugin/jobs.js:91,104,108` / `plugin/ops.js:74,85` / `relay/manager.js:50,55` → instance 的实例对象 | **domains → domains** | ⚠ **现存跨域耦合**（plugin/relay 经注入的 opts.instances 直调本域方法） | **需上层裁决**：本设计**只承诺冻结这 7 个成员的语义**（probeInstance / stopInstance / startInstance / sandboxDataDir / sandboxInstallDir / instances / save），不改调用点。若 DS-G1 要归零，属 plugin/relay 两域的设计范围 |
| `app/**` 20+ 处 → instances 活数组 / save / sandboxRoot / supervise / probeInstance / startTimer | app → domains | ✅ 合法（L2→L1） | 保持，**冻结语义** |
| `api/domains/instances.js` → `sup.instances.*`（10 个方法） | api → domains（经注入） | ✅ 合法（L3 经注入，`api/deps.js:91-96` 已声明） | 保持 |
| 无 instance → api / instance → app 边 | — | ✅ | 保持 |

> 本域**不存在**需要上层裁决的**新增**跨域改动；唯一的两条域内反向边（core→upgrade、lifecycle⇄upgrade）**在本域内即可消解**（D.1 末）。

---

## E. this 隐式耦合消解表（★ 逐条）

> 手法图例：**A** = 具名导出 + 显式 require；**B** = 构造注入（有状态协作方）；**C** = 参数显式化（纯函数化）。
> 判定标准（§3）：拆完后能否**只 require 那个文件**、给假依赖、断言行为。

### E.1 ops.js → core.js 的 14 个方法对 / 28 处（**必答问题 1**）

| # | 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|---|
| 1 | `this.save()` | ops.js:130, 162, 286, 293, 343, 428 | **B** | `store.save()` —— store 由 index 建好（持 dir/instancesFile/_lastBody），ops 只 `require('./store')` 拿**实例**；"落盘失败降级不抛"的语义逐字保留（core.js:172-174 的注释要求：从 5s tick 调用，抛错会经 setInterval → uncaughtException） |
| 2 | `this.sandboxInstallDir(inst)` | ops.js:269, 326 | **C→A** | `sandbox.installDir(rootDir, inst)` —— rootDir 由 index 在组装期绑成 ctx.instancesRoot，方法体是 `path.join(rootDir, inst.id, 'install')`（纯） |
| 3 | `this._restartInstance(inst, …)` | ops.js:376, 402, 408, 421, 422 | **C** | `stateMachine.restart(deps, inst, reason)`；deps = { events, logger, save, now }（**显式入参**，非 this）。这是 §3 明示"决策类逻辑优先用 C"的情形 |
| 4 | `this._failInstance(inst, …)` | ops.js:380, 391, 395 | **C** | `stateMachine.fail(deps, inst, reason)` |
| 5 | `this._probeState(inst)` | ops.js:255, 360 | **A** | `lifecycle.probe(inst)`（薄壳 `platform/service/monitor.probeInstance`，无状态；require 向下合法） |
| 6 | `this._setRunning(inst, st, now)` | ops.js:373, 401 | **C** | `stateMachine.setRunning(deps, inst, st, now)`；其中 5min 稳定窗（core.js:338-344）与令牌 attach/schedule（core.js:349-353）全部读 deps |
| 7 | `this.sandboxRoot(inst)` | ops.js:205 | **C→A** | `sandbox.root(rootDir, inst)` |
| 8 | `this.sandboxDataDir(inst)` | ops.js:268 | **C→A** | `sandbox.dataDir(rootDir, inst)` |
| 9 | `this.effectiveCommand(inst)` | ops.js:252 | **A/C** | `sandbox.effectiveCommand({ dshBin }, inst)`（纯：domain 分支 + 用户 command + 默认命令） |
| 10 | `this._ensureSandboxDirs(inst)` | ops.js:325 | **A** | `store.ensureDirs(inst)`（IO 归 store；内部调 sandbox.dataDir/installDir） |
| 11 | `this._setStopped(inst)` | ops.js:409 | **C** | `stateMachine.setStopped(deps, inst)` |
| 12 | `this._startLanForInstance(inst)` | ops.js:294 | **B** | `hooks.onInstanceStart(inst)`（hooks 为 index 持有的**活对象**，见 E.4 兼容性） |
| 13 | `this._stopLanForInstance(inst)` | ops.js:344 | **B** | `hooks.onInstanceStop(inst)` |
| 14 | `this._installSandbox(inst)` | ops.js:328 | **B（必须注入，不能 require）** | `ctx.install(inst)` —— index 组装时 `lifecycle.start` 的 `ctx.install = (inst) => upgrade.install(ctx, inst)`。**若写成 require('./upgrade') 则 lifecycle⇄upgrade 成环**（D.1） |

### E.2 upgrade.js → core.js / ops.js（6 个方法对 / 16 处）

| # | 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|---|
| 1 | `this.save()` | upgrade.js:75, 87, 104, 110, 121, 146, 354, 368 | **B** | `store.save()` |
| 2 | `this.sandboxInstallDir(inst)` | upgrade.js:68, 167, 235 | **C→A** | `sandbox.installDir(rootDir, inst)` |
| 3 | `this._ensureSandboxDirs(inst)` | upgrade.js:69 | **A** | `store.ensureDirs(inst)` |
| 4 | `this._probeState(inst)` | upgrade.js:243 | **A** | `lifecycle.probe(inst)` |
| 5 | `this.startInstance(id, {fromUpgrade:true})` | upgrade.js:295, 309 | **A** | `lifecycle.start(ctx, id, { fromUpgrade: true })` —— 向下 require（DAG: upgrade → lifecycle）。fromUpgrade 语义逐字保留（`test/instance-upgrade-test.js:61-63` 断言"两处都带 fromUpgrade: true"且 plainCall === 0） |
| 6 | `this.stopInstance(id)` | upgrade.js:248 | **A** | `lifecycle.stop(ctx, id)` |

### E.3 core.js → upgrade.js 的 2 处（**必答问题 4**）

| # | 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|---|
| 1 | `this._readInstalledVersion(inst)` | core.js:239 | **C（+ index 注入取值器）** | 原为视图直连安装实现（**方向不合理**，core→upgrade 是上层）。新：`model.viewRow(inst, { version, latest, updateAvailable })` 是**纯函数**；version 由 **index.js 在组装期注入**：`list() { return store.list().map((i) => model.viewRow(i, { version: upgrade.readInstalledVersion(i), … })) }`。index 在**顶层**，同时 require model 与 upgrade → 无反向边 |
| 2 | `this._taskStateToView(tt.state)` | core.js:263 | **A** | `model.taskStateToView(s)`（3 行纯映射，upgrade.js:376-383）。core.js:263 与 upgrade.js:389 两处消费方都改为 require `./model` |

### E.4 回调字段（6 个字段 / 7 处，靠外部赋值）

| # | 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|---|
| 1 | `this.onRemoteChange(inst)` | core.js:225 | **B** | `hooks.onRemoteChange(inst)` |
| 2 | `this.onInstanceStart(inst)` | core.js:322 | **B** | `hooks.onInstanceStart(inst)` |
| 3 | `this.onInstanceStop(inst)` | core.js:327 | **B** | `hooks.onInstanceStop(inst)` |
| 4 | `this.onCreate(inst)` | ops.js:132 | **B** | `hooks.onCreate(inst)` |
| 5 | `this.onRemove(id, instances)` | ops.js:215 | **B** | `hooks.onRemove(id, store.list())` |
| 6 | `this.onDestroy(id)` | ops.js:216 | **B** | `hooks.onDestroy(id)` |

**兼容性关键（消费方 compose.js:272-294 直接赋值）**：index.js 的类保留 6 个**访问器**，委托到 `this._hooks`：

    get onRemoteChange() { return this._hooks.onRemoteChange; }
    set onRemoteChange(fn) { this._hooks.onRemoteChange = fn; }
    // …onRemove / onInstanceStart / onInstanceStop / onCreate / onDestroy 同形

→ compose.js:276/282/287/293/294 **逐字不用改**，而模块内部只读 hooks 对象，不再读 `this.<字段>`。

### E.5 访问器与测试缝（不算耦合，但必须显式保留）

| 项 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `get sandboxSupported()` | core.js:100-108 | **A + 委托** | 实现移 `sandbox.supported(override)`（纯判决，require platform/os/index）；index 保留 `get sandboxSupported() { return sandbox.supported(this._sandboxSupportedOverride); }` —— **必须是 class 内 getter**（index.js:22-23 已说明 Object.assign 会把访问器退化成数据属性）；`test/platform-audit-fixes-test.js:121` / `instance-safety-test.js:85` 断言其存在且**无 setter** |
| `_setSandboxSupportedForTest(v)` | core.js:117 | 委托 | index 保留同名方法 → `this._sandboxSupportedOverride = (v === null ? null : v === true)` |
| `_updCache / _updJobs / _updTTL` | core.js:73-75（构造） | **归位** | 声明与生命周期移入 upgrade.js 的 ctx（原本就是 upgrade 专用；core 里只是"顺手声明"） |
| `_timer` | core.js:68 | **归位** | 移入 ops.js（原 startTimer 专用） |

### E.6 消解后自检（DF-6）

| 模块 | 能否"只 require + 假依赖 + 断言" | 怎么测 |
|---|---|---|
| `model.js` | ✅ 纯函数，零依赖 | `model.taskStateToView('succeeded') === 'done'`；normalizeDoc 对含 dshToken 的文档断言剔除 |
| `sandbox.js` | ✅ 纯函数（能力判决只有一个平台 require，平台侧已有 60s 缓存） | `sandbox.dataDir('/r',{id:'x'}) === '/r/x/data'`；effectiveCommand 三分支 |
| `state-machine.js` | ✅ 入参 (deps, inst, …)，deps 传假 {events:{append(){}}, save(){}, logger} | `restart(deps,inst,'x')` 后断言 phase==='BACKOFF'；test/instance-state-test.js 现有 12 条断言可直接改调 |
| `store.js` | ✅ new Store({dir}) + tmpdir | save() 后内容未变不写盘（mtime 不变） |
| `lifecycle.js` | ✅ ctx 注入假 service + 假 install | `start(ctx,id,{fromUpgrade:true})` 断言绕过 busy 闸（现有 instance-upgrade-test.js 的 R1 场景） |
| `ops.js` | ✅ ctx 注入假 store/lifecycle | add 端口被占 → {ok:false}（instance-safety-test.js L-g） |
| `upgrade.js` | ✅ ctx.dist/tasks 用 stub（现有测试正是这么做的） | install 在 dist=null 时返回 {ok:false,error:'dist 分发服务不可用'} |
| `index.js` | — 门面，不要求独立单测 | 门禁只断言它 ≤150 行且无 mixin |

---

## F. 迁移步骤（★ 可执行、可分批）

> 验证命令统一形如 `node --require ./test/_preload.js test/<file>.js`（见 package.json 的 test 脚本）。
> **每步后**：该步列出的测试全绿 + test/directory-structure-gate-test.js 不得**新增** FAIL（该门禁当前已有预期 FAIL，见其文件头 :25）。

| 步 | 动作 | 影响文件 | 验证 | 可独立提交 |
|---|---|---|---|---|
| **1** | **先立门禁**（H-1..H-8 写进 test/directory-structure-gate-test.js 或新建 test/domain-structure-gate-test.js），记录 **RED 基线**：当前 instance 必红 3 项（mixin 形态、域内跨文件 this 边 46 处、ops.js 449 行 > 400） | test/domain-structure-gate-test.js（新） | `node --require ./test/_preload.js test/domain-structure-gate-test.js`（预期 FAIL，且 **FAIL 项恰为上述 3 项**） | ✅（只加测试） |
| **2** | 抽 `model.js`（纯）：createRecord/normalizeDoc/viewRow/taskStateToView；core.js 的 load/list 内联段改为调用它；upgrade.js:376-383 删除并改 require | core.js、upgrade.js、model.js（新） | test/instance-state-test.js、test/instance-upgrade-test.js、test/token-boundary-test.js、test/platform-audit-fixes-test.js | ✅ |
| **3** | 抽 `sandbox.js`（纯）：路径三兄弟 + command/effectiveCommand/defaultCommand/env/unitProps/supported；core.js/ops.js 改为调用 | core.js、ops.js、sandbox.js（新） | test/cross-platform-test.js（断言 path.delimiter 且无 join(':'), :83-84）、test/instance-upgrade-test.js | ✅ |
| **4** | 抽 `state-machine.js`（纯）：4 个转移函数，deps 显式入参；supervise 改调 | core.js、ops.js、state-machine.js（新） | test/instance-state-test.js（12 条断言须**逐字保持通过**）、test/instance-safety-test.js | ✅ |
| **5** | 抽 `store.js`：load/save/syncPorts/ensureDirs + 活数组持有；ops.js 的 `this.save()` 改 `store.save()` | core.js、ops.js、upgrade.js、store.js（新） | test/token-boundary-test.js（load 剔 dshToken）、test/round13-ports-release-test.js | ✅ |
| **6** | 抽 `lifecycle.js`：prepareSystemd/cleanStaleUnit/start/stop/probe/supervise；**首次安装经 ctx.install 注入**（本步先在 index 注入 () => upgrade._installSandbox，暂时保留旧调用点） | ops.js、core.js、lifecycle.js（新） | test/instance-systemd-aside-behavior-test.js（行为级，必须真跑）、test/instance-upgrade-test.js | ✅ |
| **7** | `ops.js` 收口为 CRUD：add/remove/update/startTimer + hooks；core.js 只剩"待解散的 class" | ops.js、core.js | test/round13-discipline-gaps-test.js（removeInstance 互斥 + stopUnit 抛能力异常）、test/instance-safety-test.js | ✅ |
| **8** | **解散 core.js → 组装根下沉 index.js**：8 次 require、_hooks 活对象、6 个访问器、sandboxSupported 委托；**删除** `Object.assign(InstanceManager.prototype, …)` | core.js（删）、index.js | **全部 6 个实例测试** + test/layering-and-dependency-gate-test.js + 门禁 H-1/H-3/H-4 转绿 | ⚠ 建议与下一步合并提交（独立提交易留半态） |
| **9** | **修测试装配缝**（硬前置，见 A.4.3）：test/instance-upgrade-test.js:36/41 的实例 owner patch 改为 **ctor 注入**（new InstanceManager({ dir, logger, tasks, dist, install: () => ({ok:true}), service: fakeProvider })），或改用 require.cache 预置假 platform/os/service（instance-systemd-aside-behavior-test.js:54-79 的既有手法） | test/instance-upgrade-test.js | `node --require ./test/_preload.js test/instance-upgrade-test.js`；**并断言未产生副作用**（假 provider 的 daemonReload 被调用计数） | ✅（本来就是测试改动） |
| **10** | 门槛收口：删掉临时的 ctx.install 注入双轨；跑全量 `npm test` 并更新 README.md（域职责与依赖图，BRIEF §4 要求"★ 必写"） | index.js、README.md | `npm test` 全绿；test/directory-structure-gate-test.js + test/domain-structure-gate-test.js 全绿 | ✅ |

**分批提交建议**：2/3/4 可并行（互不依赖，都是"抽纯函数"）；5 依赖 2（store 要调 model 迁移）；6 依赖 3/4/5；7 依赖 6；8 依赖 7 且**不可与 9 分离**（否则两处 patch 失效会真跑 `systemctl --user daemon-reload`）。

**每步的"不改契约"自检**：`node -e "const {InstanceManager}=require('./src/domains/instance'); console.log(typeof new InstanceManager({dir:'/tmp/x'}).list)"` 应恒为 `function`（A.1.3 的成员名逐一点名）。

---

## G. 风险与取舍

### G.1 破坏性改动（点名消费方）

| 风险 | 说明 | 消费方 | 处置 |
|---|---|---|---|
| **R-1 活数组身份** | store 成为数组唯一持有者；ops.js:160 的 `this.instances = this.instances.filter(…)` 是**整体替换**，若 store 缓存了旧引用则外部看到的列表**永久错位** | compose.js:305/357、api/domains/instances.js:153、app/state/store.js:101-117（splice）、app/control/instance-adapter.js:42、app/control/specs.js:67、relay/manager.js:55、plugin/ops.js:74,85 等 **20+ 处直读 instances.instances** | **不变量**：index 的 `get instances()` 必须**每次返回 store 的当前数组**；替换路径收敛到 `store.replaceAll(arr)`。app/state/store.js:117 的 splice 依赖同一引用 → 必须保持一致 |
| **R-2 测试 patch 失效 → 真跑系统命令** | test/instance-upgrade-test.js:36 `mgr._prepareSystemd = () => {}`、:41 `mgr._ensureSandboxDirs = () => {}` 是**实例 owner 打补丁**；改成 index 闭包委托后**不再拦截内部调用** → 真调 `systemctl --user daemon-reload`（platform/os/service.js:52）与真 mkdirSync | 开发者机器 / CI | **F 步 9 是 F 步 8 的硬前置**；迁移期**必须先改测试**。⚠ 设计阶段**不得**执行该测试去验证（会触发开发机副作用，且与本任务"禁止启动守卫进程"的约束一致） |
| **R-3 回调字段赋值面** | compose.js 6 处 `host.instances.X = fn` | compose.js:272/276/282/287/293/294 | 用 **getter/setter 委托**（E.4）→ **零改动**。若实现者改用 hooks 对象直赋，则必须同步改 compose（点名 6 行） |
| **R-4 sandboxSupported 退化为数据属性** | 若 getter 被 Object.assign 或写成普通字段 | api/domains/instances.js 经 /env/status 对照面；test/instance-safety-test.js:85-88、test/platform-audit-fixes-test.js:121-125 | **禁止**把 getter 混进任何 mixin；H-1 门禁 + 上述两测试锁定 |
| **R-5 行为级测试的锚点位移** | test/instance-safety-test.js:92 用**正则抓 _prepareSystemd() 函数体**（/`_prepareSystemd\(\) \{[\s\S]*?\n  \}/`）—— 若函数改为 `function prepareSystemd(ctx)` 或改变缩进/结尾，该正则**抓不到**（m 为 null → body='' → 4 条断言静默变空/失败） | test/instance-safety-test.js:92-110、test/instance-upgrade-test.js:58-63、test/cross-platform-test.js:80-82/165-167、test/platform-audit-fixes-test.js:118-120 | 后三处已按"**按域聚合读取**"写成（读目录下全部 .js）→ 文件搬家不丢覆盖面 ✅；但 **L-f 的 `/_prepareSystemd\(\) \{/` 正则必须同步更新**为匹配新函数形态。**必须逐条跑，不得假设"聚合读取就没事"** |

### G.2 明确不做的部分（不做设计而设计）

| 不做 | 理由 |
|---|---|
| **不改 index.js 的导出契约**（`{ InstanceManager }`） | 外部契约：compose.js:23 + 6 个测试 require；supervisor.js 经 compose 拿到实例。**逐字保持** |
| **不改 plugin/relay 的跨域调用点** | 7 处 domains→domains 边（D.2）需**上层裁决**；本设计只冻结被调成员的语义 |
| **不消除 instances 活数组这种"暴露模式"** | 20+ 处直读；收紧为访问器是**编排层重构**（app）议题，不属本域。本域只保证"引用身份稳定" |
| **不把 ports 探测改成注入** | ops.js:18 与 core.js:30 直接 require `platform/service/ports`；它是平台的**单例服务**（compose.js:219-221 才配置），域侧注入收益低、改动面大 |
| **不建 policies/ 子目录** | R2：优先扁平；本域策略只有退避（shared/guardian 已提供）与能力判决（sandbox.js），不足成目录 |
| **不动 daemon.js** | 本域**没有** daemon 入口（R5 只约束 router/relay） |
| **不把 upgradeInstance（160 行）继续拆文件** | 它是一条**不可拆散的编排链**（stop→install→start→verify→rollback）。upgrade.js:220-224 注释明确"并发互斥（勿拆散）"：检查与 _updJobs[id]=running 置位之间没有任何 await，拆成阶段函数会**打散"同一实例绝无双 npm install"的同步不变量**。做**函数内提取**（rollback 已是局部闭包）即可 |

---

## H. 门禁建议

> 写进 `test/domain-structure-gate-test.js`（或扩展现有 test/directory-structure-gate-test.js）。
> ⚠ **R1 取证陷阱**：所有源码扫描**必须先剥注释**（strip()），否则 index.js:6-23 的说明文字与 ops.js:12 / core.js:16 的注释会伪造出"命中的 require / mixin"。

    // 与 layering gate 同款的剥注释（R1 要求）
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

| 判据 | 断言 | 反向自检（**证明判据非空转**） |
|---|---|---|
| **H-1（R4+R6）禁 mixin 注入** | 对 `src/domains/**`（strip 后）匹配 `MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/` → **0 处** | 三个样本必须**全部命中**：`Object.assign(X.prototype, mod.methods)`（R6 指出原正则漏掉的**变量右值**形态）、`Object.assign(X.prototype, require('./x').m)`（router/index.js:758 形态）、`Object.defineProperties(X.prototype, mod.accessors)`（supervisor.js:161 形态） |
| **H-2（R6）禁方法分片导出** | `METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/` 且 `/\{\s*(ops|upgrade|jobs|forward|aux)Methods\s*[,}]/` → domains/ 内 **0 处** | 样本 `module.exports = { methods }`、`module.exports = { opsMethods }` 必须命中 |
| **H-3（R1 真义）域内跨文件 this 边 = 0** | 解析每域 .js 的方法定义集与 `this.X(` 调用集（strip 后），**跨文件**边计数 → 每域 **0**；并断言 this 图 SCC 数 == 文件数（即无 >1 的 SCC） | 样本：把当前 index.js:31 的 mixin 复原 → instance 域边数必须 **> 0**（实测 46）→ 判据有分辨力 |
| **H-4（R3）文件行数取严** | 任意 `domains/**/*.js` ≤ **400** 行；每域 index.js ≤ **150** 行 | 样本：401 行文本必须 FAIL |
| **H-5 域内 require 图 = DAG** | 对每域做 SCC（**剥注释**，单位 = 域内文件路径）→ 无环 | 样本：构造 A→B→A 必须被检出 |
| **H-6 访问器纪律** | instance 域的 index.js（或其 class）内存在 `get sandboxSupported()`；且**全仓无** `this\.sandboxSupported\s*=`（test/platform-audit-fixes-test.js:122-123 已有此判据，**合并上来**）；无 `set sandboxSupported` | 样本 `this.sandboxSupported = true` 必须命中 |
| **H-7 外部契约面回归** | `new (require('../src/domains/instance').InstanceManager)({ dir: tmp })` 上必须存在 16 个成员：list / addInstance / removeInstance / updateInstance / startInstance / stopInstance / checkUpdate / upgradeInstance / upgradeStatus / supervise / probeInstance / sandboxRoot / sandboxDataDir / sandboxInstallDir / save / startTimer（+ instances 数组） | 反向：删掉任一个，断言即失败 |
| **H-8 结构白名单（R2）** | 每域有 index.js；域内子目录 ∈ {providers, instances, policies, model, store, handlers, core, jobs} | 样本 `domains/x/foo/` 必须违规 |

**自动化要点（H-3 的实现提示）**：`this.X()` 静态解析要用与本文 A.2 相同的方法（`/^ {2}(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/` 收集定义 + `/this\.(\w+)\s*\(/g` 收集调用），**并剔除 this.onXxx( 这类外部赋值的回调**（它们不是域内定义的方法；否则 H-3 会误报 7 处）。更稳的做法：只把"定义在本域其他文件里的方法名"计入跨文件边。

---

## 附：一句话总结

instance 域的**真实病症不是 require 环**（域内 0 环，A.2.1），而是
**index.js:31 的 Object.assign(InstanceManager.prototype, opsMethods, upgradeMethods) 把三文件方法挂到同一 this**
→ 22 方法对 / 46 处隐式私调 + 1 个三文件 SCC（A.2.3）。
消解路径 = **拆成 8 个扁平文件 + 用 A/B/C 三手法逐条斩断 46 处 this**（E 节），
其中唯一必须"注入而非 require"的是 **install 端口**（否则 lifecycle⇄upgrade 成环，E.1 #14）。
