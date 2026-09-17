# P3-A-2 报告：audit 切面工厂化 + domain-actions 工厂化 + daemons 转换计划（只读）

> 分片：P3-A-2。独占 `src/app/audit/**`；主控追加独占 `src/app/domain-actions/**`。
> 只读产出 `daemons/**` 逐文件转换计划（附录）。
> **不注册**（`src/app/assembly/**` 归 P3-A 负责人）、不改 `test/`、不跑测试/门禁、不做 git 写。

## 0. 交付物与硬约束自检

| 项 | 结果 |
|---|---|
| 新建 `src/app/audit/collaborator.js`（`createOrphanScan(deps)`） | ✅ |
| 改 `src/app/audit/orphan-scan.js`（去隐式 this，公开面逐字保留） | ✅ |
| 新建 `src/app/domain-actions/collaborator.js`（`createDomainActions(deps)`） | ✅ |
| `node --check` 三个文件 | ✅ 全部 OK |
| 不改 `test/` | ✅（`git status` 未涉 test/） |
| 不做 git 写 | ✅（仅 read-only `git status`/`git diff`） |
| 不注册 assembly | ✅（注册片段见 §1.5/§2.5，由负责人执行） |
| `src/app/audit` 的 `this.X(` 计数（stripped） | **0**（基线 0，未增） |
| `src/app/domain-actions` 的 `this.X(` 计数（stripped） | **0**（基线 0，未增） |

改动文件（每行一理由）：

- `src/app/audit/orphan-scan.js` — 把实现主体提为具名 `orphanAudit(deps)`，全部 `this.*` 改经惰性 deps 取值；`module.exports.methods._orphanAudit` 保留为 host 兼容外壳（facets 的 `{ methods }` 安装不变）。
- `src/app/audit/collaborator.js`（新） — `createOrphanScan(deps)`，公开键 `orphan` 与 `THIN_SPEC.audit` 逐字一致。
- `src/app/domain-actions/collaborator.js`（新） — `createDomainActions(deps)`，公开键 = 三文件 methods 键全集（5 个）。

---

## 1. audit 切面工厂化

### 1.1 形态

`createOrphanScan(deps)` 返回 `{ orphan }`，内部调用同切面的 `orphanAudit(deps)`（真实实现，非转发器）。
抑制状态默认用**闭包状态**（工厂对象自持）；若 deps 提供 `get/setLastKey`、`get/setLastAt`，则改用外部状态（用于与 host 上的 `host._orphanAudit()` 共享，可选）。

### 1.2 公开键逐字对照表

| 来源 | 公开键 | 指向实现 | 工厂对象键 |
|---|---|---|---|
| `assembly/collaborators.js` `THIN_SPEC.audit` | `orphan` | `_orphanAudit` | `orphan` ✅ 逐字一致 |
| `assembly/facets.js`（`{ methods }` 安装，§1.2 不动） | `_orphanAudit`（host 方法名） | `hostOrphanAudit` | 保持安装 ✅ |
| 本模块新增命名导出 | `orphanAudit` | 具名实现 | 供工厂复用（additive，R2 无删） |

消费者：`src/app/control/scheduler.js:30` `this.audit.orphan()` —— 工厂对象键名一致，行为不变。

### 1.3 deps 清单（全惰性 getter）

| dep | 取用的宿主事实 | 原 `this` 读点 |
|---|---|---|
| `getStopping` | `_stopping` 早退 | `:17` |
| `getManagedObjects` | `managedObjects`（目录） | `:19` |
| `getCtl` | `ctl.routerPort()` / `ctl.lanPort()` | `:24`-`:25` |
| `getDaemons` | `routerActive/managed/lanActive/lanManaged/enabled` | `:24`-`:25` |
| `getConfig` | `routerAutostart`、`probeIntervalMs` | `:24`、`:44` |
| `getInstances` | `instances.map(i=>i.id)` | `:35` |
| `getEvents` | `events.append('orphan_audit', …)` | `:59` |
| `getLogger` | `logger.warn('[orphan] …')` | `:61`、`:63` |
| `get/setLastKey`、`get/setLastAt`（可选） | 同指纹抑制状态 | `:56`-`:58` |

### 1.4 行为零变更证据

- 事件名 `orphan_audit`、日志文案 `[orphan] 游离对象自检: `、`[orphan] 自检异常: `、issue 文案/字段、10min 抑制、`_stopping` 早退：全部逐字保留（见 `git diff`）。
- 本地 node 冒烟（非测试套件）：A1 键名、A2 事件一次、A3 文案、A4 抑制、A5 `_stopping` 早退、A6 host 外壳写回 `_lastOrphanKey/_lastOrphanAt` —— **6/6 pass**。
- host 路径：`facets.installMethods` 仍把 `_orphanAudit` 装到 host；外壳写抑制状态到 host 字段，与 `compose/core.js:98-99` 的初始化同源，跨拍抑制语义不变。

### 1.5 注册片段（供负责人，不由此分片执行）

```js
// src/app/assembly/collaborators.js
const { createOrphanScan } = require('../audit/collaborator');
// THIN_SPEC 删除：audit: { orphan: '_orphanAudit' },
// installThin 之后（host.ctl/daemons/views 已就绪）：
host.audit = createOrphanScan({
  getConfig: () => host.config, getLogger: () => host.logger, getEvents: () => host.events,
  getInstances: () => host.instances, getManagedObjects: () => host.managedObjects,
  getCtl: () => host.ctl, getDaemons: () => host.daemons, getStopping: () => host._stopping,
});
```

> 若要与 `host._orphanAudit()` 共享抑制状态，再补
> `getLastKey/setLastKey` → `host._lastOrphanKey`、`getLastAt/setLastAt` → `host._lastOrphanAt`。

---

## 2. domain-actions 切面工厂化（主控追加范围）

### 2.1 形态与关键取舍（**请重点复核**）

三文件为本切面 methods 的**唯一实现**，且被测试以**源码原文**钉住形态：

- `test/round13-router-relay-gaps-test.js:64` 字面量 `'this.state.writeMainMeta(meta)'`（闸在落盘之前的顺序判据）；
- `test/probe-gate-and-ownership-test.js:151` 正则 `/this\.(?:daemons\.)?disableRouterPersist\(\);/ `（读 `router.js` 原文）；
- `test/probe-gate-and-ownership-test.js:142` 读 `domain-actions/router.js` 原文。

因此本工厂**不原地把三文件方法体的属性读改写成 deps 形参**（那会同时破坏上述两处形态钉子，而本分片无权改 `test/`）。改用零行为变更且无钉风险的等价形态：

`createDomainActions(deps)` 用 deps 构造一个**宿主视图**（该视图的每个属性都是惰性 getter），再把三文件既有 methods 绑定到该视图调用：

```js
const host = hostView(deps);                       // config/daemons/state/views/... 全为 getter
return {
  setRouterRunning: routerActions.setRouterRunning.bind(host),
  setLanFrp: lanActions.setLanFrp.bind(host), lanFrpc: lanActions.lanFrpc.bind(host),
  syncFrpc: lanActions.syncFrpc.bind(host), patchDshMain: mainActions.patchDshMain.bind(host),
};
```

- **实现只在三文件一处**（无重复、非转发器）；调用路径上的 `this` 已由 deps 视图提供，不再直连 host 实例。
- 因该目录 `this.X()` 调用点为 **0**（全是 `this.config/this.views/this.state/...` 属性读），故 deps 化即「属性读 → getter」。
- 若负责人裁定要**原地去 this**（属性读改 `deps.getX()`），必须先由主控授权改上述两条测试断言 —— 本分片**不擅自做**，登记为「待授权」。

### 2.2 公开键逐字对照表

| 文件 | methods 键 | 工厂对象键 |
|---|---|---|
| `domain-actions/router.js` | `setRouterRunning` | `setRouterRunning` ✅ |
| `domain-actions/lan.js` | `setLanFrp` | `setLanFrp` ✅ |
| `domain-actions/lan.js` | `lanFrpc` | `lanFrpc` ✅ |
| `domain-actions/lan.js` | `syncFrpc` | `syncFrpc` ✅ |
| `domain-actions/main.js` | `patchDshMain` | `patchDshMain` ✅ |

- 与 `THIN_SPEC` 无交集（domain-actions 不经 THIN_SPEC），故无转发器名冲突。
- `facets.js` 的 `{ methods }`（`:46-48`）**不动**，`sup.setRouterRunning/patchDshMain/setLanFrp/lanFrpc/syncFrpc` 五个宿主方法仍在，`api/domains/*`、`control/adapters.js:45,50`、`api/deps.js` 的消费点不变。

### 2.3 deps 清单 → 宿主视图属性

| dep | 视图属性 | 消费方法 |
|---|---|---|
| `getConfig` | `config` | router（`routerAutostart` 读/写）、main |
| `getDaemons` | `daemons` | router（`ensureRouterRuntime/disableRouterPersist`）、lan（`enabled`）、main（`enabled/syncLanState`） |
| `getState` | `state` | router（`persistConfigPatch`）、main（`readMainMeta/writeMainMeta`） |
| `getViews` | `views` | router（`routerStatus`）、main（`exposurePeers/dshMain`） |
| `getLifecycleManager` | `lifecycleManager` | router（`get('router')`）、lan（`get('lan')`） |
| `getRouter` | `router` | router（`start/stop`） |
| `getLan` | `lan` | lan（`lanModule` 回退） |
| `getCtl` | `ctl` | lan（`lanCall`） |
| `getEvents` | `events` | main（`append` 三类开关事件） |
| `getLogger` | `logger` | main（事件异常 warn） |

逐方法属性→dep 映射：

- `setRouterRunning`：`this.lifecycleManager`→`getLifecycleManager`；`this.daemons`→`getDaemons`；`this.config`→`getConfig`；`this.state`→`getState`；`this.views`→`getViews`；`this.router`→`getRouter`。
- `setLanFrp/lanFrpc/syncFrpc`：`this.daemons`→`getDaemons`；`this.ctl`→`getCtl`；`this.lifecycleManager`→`getLifecycleManager`；`this.lan`→`getLan`。
- `patchDshMain`：`this.state`→`getState`；`this.views`→`getViews`；`this.daemons`→`getDaemons`；`this.events`→`getEvents`；`this.logger`→`getLogger`。

### 2.4 FIX-1 frp 公网暴露闸（安全关键）零变更证据

`domain-actions/main.js` **原文未改**；工厂经视图提供同一惰性取值：

| 闸要素 | 原形态 | 工厂路径 |
|---|---|---|
| 判定函数 | `validateFrpExposure({...})`（relay/core 单一事实源） | 原样调用 |
| 冲突清单 | `peers: this.views.exposurePeers()` | `view.views` → `getViews().exposurePeers()`，时机/参数/返回值处理不变 |
| 令牌/端口 | `String(meta.remoteToken||'')`、`meta.frpRemotePort` | `view.state` → `getState().readMainMeta()` |
| 判闸条件 | `if (!!meta.frpEnabled)`（按写入生效后状态） | 不变 |
| 落盘前置 | 闸必须在 `this.state.writeMainMeta(meta)` 之前 | 源码顺序未动 |

本地 node 冒烟（非测试套件）：B2 无令牌开 frp→`ok:false` 且**未落盘**；B3 端口非法→拒且未落盘；B4 令牌+7001→`ok:true` 落盘一次 + `main` 视图；B5 关 frp 不拦；B6 `dsh_frp_changed` 事件名逐字保留 —— 全部 pass。

其余冒烟：B1 公开键=5 键全集；B7 `setRouterRunning(true)` daemon 路径契约翻译 + `disableRouterPersist` 被调；B8 `setRouterRunning(false)` 可调；B9/B10 lan 经 `lifecycleManager.get('lan').module` 唯一入口；B11 `syncFrpc` 不抛。**共 11/11 pass**。

### 2.5 注册片段（供负责人，不由此分片执行）

```js
// src/app/assembly/collaborators.js
const { createDomainActions } = require('../domain-actions/collaborator');
// 在 host.views / host.ctl / host.state / host.daemons 就绪之后（installThin 之后）：
host.domainActions = createDomainActions({
  getConfig: () => host.config, getDaemons: () => host.daemons, getState: () => host.state,
  getViews: () => host.views, getLifecycleManager: () => host.lifecycleManager,
  getRouter: () => host.router, getLan: () => host.lan, getCtl: () => host.ctl,
  getEvents: () => host.events, getLogger: () => host.logger,
});
```

> `host.router`/`host.lan` 是 `compose` 惰性属性；注册处只传 getter，真正取值发生在方法调用时。

---

## 3. CI 风险点与登记

1. **形态钉子（最大风险，已规避）**：`round13-router-relay-gaps-test.js:64` 的 `'this.state.writeMainMeta(meta)'` 与 `probe-gate-and-ownership-test.js:151` 的 `this.daemons.disableRouterPersist();` 读三文件原文。本分片未改三文件，钉子保持原位（已 grep 复核）。原地去 this 需先由主控授权改测试。
2. **this 债务棘轮门禁 `test/app-this-ratchet-gate-test.js`**：`audit` 与 `domain-actions` 基线均 0，实测两目录 stripped 计数均 **0**（见 §0）。文件中出现的 `this.config` 等属性读与 `this._lastOrphanKey = v` 赋值均不匹配 `this\.X\(` 口径。
3. **注释钉子（R1）**：新增注释 token 逐一 grep `test/`：`惰性取值函数/宿主事实/消除隐式/兼容外壳/逐字保留/域写动作协作方工厂/零重复/宿主视图/孤儿审计/createOrphanScan/createDomainActions` 均 **0 命中**；`真 ctor 注入` 仅 2 处测试**注释**（`round13-router-relay-gaps-test.js:75`、`app-ctor-injection-test.js:5`），非正则字面量、非断言目标。
4. **comment-pin 门禁**：其扫描目标是「被测试引用的 src 文件」。`audit/*` 无任何测试引用；`domain-actions/collaborator.js` 无测试引用 → 新注释不进入 CP-1 判定面。
5. **R2（死代码）**：只新增，未删任何导出/函数/常量。`orphan-scan.js` 的 `methods._orphanAudit` 保留；新增 `orphanAudit` 键为 additive；`facets.js:49` 的 require 与 `THIN_SPEC.audit` 仍成立。
6. **layering 门禁**：两个 collaborator 只 require **同目录**模块与（audit）既有 `platform/service/ports` 路径，无新增跨层边，无须 `CROSS_LAYER` 登记。
7. **待授权项**：若要获 DF-5 的「彻底去隐式 this」形态，`domain-actions/{router,lan,main}.js` 方法体需原地 deps 化，并同步改两条测试断言；本分片登记为保留/待裁，不擅动。

---

## 附录 A：`daemons/**` 逐文件转换计划（**只读产出**，未改动）

口径：`this.X(` 计数为剥注释后。全目录 43；其中 host 切面相关 **14**（identity 6 + runtime 8），`process.js` 的 **29** 为类内自调用（非 host 切面）。

### A.0 目标工厂形态

新建 `src/app/daemons/collaborator.js` → `createDaemons(deps)`，公开键 = `THIN_SPEC.daemons` 的 **15 个 pub 名**逐字一致：

`enabled, routerActive, lanActive, lifecycle, disableRouterPersist, ensureLanRuntime, ensureRouterRuntime, syncLanState, warnOccupied, managed, lanManaged, writeLanLock, clearLanLock, writeRouterDaemonLock, clearRouterDaemonLock`

内部建议拆 `createIdentity(deps)`（→ managed/lanManaged/四把锁）、`createProbe(deps)`（→ enabled/routerActive/lanActive）、`createRuntime(deps)`（→ 其余），全部同目录，无新增跨层边。

**特别项 `_daemonSuperviseOnce`**：它**不在 `THIN_SPEC.daemons`**，却由 `compose/domains.js:71-72` 的 `registerAdapter` 经 `host._daemonSuperviseOnce(kind)` 调用，且被 `test/session-lifecycle-test.js:161` 直调、`test/guard-domain-model-gate-test.js:208-250` 以 **supervise.js 原文形态**钉住（GD-2 的 lan 分支判入口 + registerAdapter 映射）。故 `supervise.js` 建议**保留 `{ methods }` 安装 + 附一个 job 工厂函数**（如 `superviseOnce(deps, kind)`）；若强行移入工厂对象，公开面会新增键而偏离 THIN_SPEC，并触发上述两测试改写 —— 登记为「保留首选」。

### A.1 `identity.js`（34 行，`this.X(` = 6）

- **转换**：`createIdentity(deps)`；deps = `{ getConfig }`（仅需 `config.stateFile` 的 dirname）。
- **公开键**：`managed(_daemonManaged)`、`lanManaged(_lanManaged)`、`writeLanLock`、`clearLanLock`、`writeRouterDaemonLock`、`clearRouterDaemonLock`；另含内部 host 方法 `_lanLockPath`、`_routerDaemonLockPath`（非公开）。
- **调用点**：`this.config.stateFile` :11,:19；`this._lanLockPath()` :12,:13,:14；`this._routerDaemonLockPath()` :23,:27,:31。
- **手法**：两个 `*LockPath` 提为**具名局部函数**（去 6 处 `this.X(`，目录计数可 43→37），或保留类内 `this`（§1.3 允许）。行为零风险（纯路径+existsSync/writeFileSync/unlinkSync）。

### A.2 `probe.js`（40 行，`this.X(` = 0）

- **转换**：`createProbe(deps)`；deps = `{ getConfig, getCtl }`。
- **公开键**：`enabled(lanDaemonEnabled)`、`routerActive(_routerDaemonActive)`、`lanActive(_lanDaemonActive)`。
- **调用点**：`this.ctl.routerPort()` :16；`this.ctl.lanPort()` :32；`this.config.lanDaemon` :28。
- **注意**：`pidlook.normCmdline/readCmdline/findListeningPid` 与 daemon 名匹配串（`router-daemon`/`lan-daemon`/`/domains/.../daemon.js`）为对外判据，逐字保留。

### A.3 `runtime.js`（189 行，`this.X(` = 8）

- **转换**：`createRuntime(deps)`；deps = `{ getConfigPath, getConfig, getCtl, getLogger, getEvents, getDaemons, getInstances, getViews, getRouter, getTokenService, getName, getLc, setLc, getLastLanStateJson, setLastLanStateJson, getLastOccupiedWarn, setLastOccupiedWarn }`（后四项为宿主瞬态字段，可用闭包替代）。
- **公开键**：`lifecycle`、`disableRouterPersist`、`ensureLanRuntime`、`ensureRouterRuntime`、`syncLanState`、`warnOccupied`；内部 `_daemonEnsureResult`（不公开）。
- **`this.X(` 调用点（全部同文件自调用，可提具名函数）**：`_daemonLifecycle()` :109,:117,:149,:161；`_daemonEnsureResult()` :119,:163；`_disableRouterPersist()` :135,:165。
- **属性读调用点**：
  - `this.configPath` :19,:22,:157（非守卫直接降级 `embedded/none`，不可动）
  - `this._lc` :20,:21,:22,:31,:42（→ `getLc/setLc`）
  - `this.config.stateFile` :30,:63；`this.config.targetHost/targetPort` :185
  - `this.ctl.lanPort()` :35,:106；`this.ctl.routerPort()` :35,:146
  - `this.logger` :39,:94；`this.events` :40,:185；`this.name` :56
  - `this.daemons.enabled()` :61；`lanActive()` :100；`lanManaged()` :101；`clearLanLock()` :108；`writeLanLock()` :119；`routerActive()` :129；`managed()` :130；`clearRouterDaemonLock()` :148；`writeRouterDaemonLock()` :163
  - `this.instances.all()` :67；`this.dshMainView`/`this.views.dshMain()` :68（既有恒真条件，见 `design-notes/_r5-app-api-P3.md:104`，本分片不改）
  - `this.tokenService.get()` :73；`this._lastLanStateJson` :87,:92；`this.router.setPersistEnabled` :176-177；`this._lastOccupiedWarn` :183,:184
- **风险**：`_disableRouterPersist` 的写权闸是 probe-gate E-h（`test/probe-gate-and-ownership-test.js:143-159`）与 `supervise.js` 注释共同锁定的不变量；三处 daemon 返回路径都必须调用（:135、:165 及顶部注释）——转换须逐字保留调用密度（`sv` 侧 ≥2 处）。

### A.4 `supervise.js`（104 行，`this.X(` = 0）

- **转换（保留首选）**：见 A.0 特别项。若做，deps = `{ getStopping, getSession, getLifecycleManager, getConfig, getDaemons, getLogger, getCtl, getControl, getViews, getManagedObjects, getEvents }`。
- **调用点**：`this._stopping` :22；`this.session.halting()` :24；`this.lifecycleManager.get('router')` :27；`this.config.routerAutostart` :28；`this.daemons.routerActive()` :29,:30,:42；`managed()` :30；`lifecycle('router')` :33；`this.logger.warn` :38,:43,:58,:67,:71,:74,:93,:95,:99；`this.ctl.routerPort()` :38,:52,:70；`this.control.syncRouterView` :43,:71；`this.views.routerDaemonActive()` :46；`this.managedObjects` :46；`this.ctl.call` :52；`this.managedObjects.get('router-daemon')` :53；`this.daemons.ensureRouterRuntime(true)` :64；`this.events.append` :66；`this.daemons.enabled()` :81；`syncLanState()` :82；`lanActive()` :83；`ensureLanRuntime(true)` :91。
- **风险**：`test/guard-domain-model-gate-test.js` GD-2 以原文判 `_daemonSuperviseOnce` 函数体与 lan 分支；`agent` 的 `router_daemon_supervised` 事件与三条 warn 文案为运行期钉子，逐字保留。

### A.5 `process.js`（268 行，`this.X(` = 29）+ `process-marks.js`/`process-wait.js`/`scripts.js`

- `process.js` 是 `class DaemonLifecycle`，`this` 是**类实例**（合法 ctor 语义），非 host 协作；29 处 `this.X(` 全为类内方法调用。**建议保留**（DF-5 不适用于类内部）。消费方 `runtime.js` 已把构造参数（script/args/ctlPort/identityFile/spawnEnv/logger/events）全部显式注入，天然满足「显式注入」。
- `process-marks.js`（`{ deriveCmdMarks }`）、`process-wait.js`（`{ waitProcessExit, waitPortFree }`）、`scripts.js`（`{ daemonScript, DAEMON_REL }`）已是**纯函数模块**（`this.X(` = 0，仅命名导出）→ 无须转换。

### A.6 棘轮影响预估（daemons，若执行 A.1-A.3）

- `identity.js` 6 → 0（提具名函数）；`runtime.js` 8 → 0（提具名函数）；`supervise.js` 保持 0；`process.js` 保持 29。
- 目录 `this.X(` 计数：**43 → 29**（下降）。按门禁纪律「只许下调、禁止为消红上调」，执行时由负责人/P3-B 记入提交说明；`process.js` 的 29 不应被打平为「债务」。
- 若只做「new collaborator + 保留 `{methods}` 外壳」而不动 `identity/runtime` 原文，目录计数维持 43（不越基线，仍是合规的）。

---

## 附录 B：验证命令与结果（可复算）

```bash
# 1) 语法
node --check src/app/audit/orphan-scan.js
node --check src/app/audit/collaborator.js
node --check src/app/domain-actions/collaborator.js     # 均 OK

# 2) 棘轮计数（剥注释后 /this\.X\(/g）
#    audit = 0 ; domain-actions = 0

# 3) 形态钉子仍在位
grep -n "this.state.writeMainMeta(meta)" src/app/domain-actions/main.js   # :48
grep -n "this.daemons.disableRouterPersist();" src/app/domain-actions/router.js  # :21

# 4) R2：orphan-scan 唯一消费者
grep -rn "audit/orphan-scan" src test bin     # 仅 src/app/assembly/facets.js:49
```

冒烟脚本为**临时 stdin node 程序**（非 `test/` 内文件、未落盘、未入链）：audit 6/6 + domain-actions 11/11，exit 0。
