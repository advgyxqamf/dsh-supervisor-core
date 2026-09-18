# P3-A-3 报告：manager.restart 可达性裁定 + main/**、facade/** 转换计划

> 分片 A-3（独占 `src/app/control/manager.js`）。只读产出转换计划；不注册（`assembly/**` 由负责人独占）。
> 纪律：未改 `test/`、未跑测试/门禁、无 git 写；仅 `node --check` / `grep` / `read` / `wc`。

---

## 1. 任务一：`manager.restart` 内联回退分支可达性

### 1.1 结论

**内联回退分支不可达**（CN-1 证据齐备，无反证），已删除。`manager.js` 118 → 111 行；
恒可达路径的返回形状逐字未变。`node --check` 通过。

### 1.2 改前分支

`src/app/control/manager.js` 原 71-84 行：

```js
// 委托 lc.restart()：ManagedLifecycle 内 _restart 回调优先……
if (typeof lc.restart === 'function') {
  const r = await lc.restart();
  return { ok: r.ok !== false, error: r.error, ...lc.snapshot() };
}
const wasRunning = lc.desired === 'running' || lc.phase === 'running';
const r1 = await lc.stop('restart');
if (wasRunning || lc.desired === 'running') {
  lc._monitoring = true;
  const r2 = await lc.start();
  return { ok: r2.ok !== false, error: r2.error, ...lc.snapshot() };
}
return { ok: r1.ok !== false, ...lc.snapshot() };
```

### 1.3 判定链（逐条证据）

| # | 命题 | 证据 |
|---|---|---|
| E1 | adapter 的 `registerAll` **恒**包 `ManagedLifecycle` | `src/app/control/adapters.js:39/63/83/115/139` 五处注册全部 `new ManagedLifecycle({...})`；生产唯一调用点 `src/app/assembly/compose/observers.js:41`；`registerAll` 无其他调用者（`src` 5 命中，余为 require/定义） |
| E2 | `manager.register` **不可能**收普通对象 | `manager.js:22`：`if (!(lc instanceof ManagedLifecycle)) throw new Error('register 需要 ManagedLifecycle 实例')`。普通对象在入表前即抛 |
| E3 | `restart` 是原型方法，`lc.restart` 恒为函数 | `src/app/control/entry.js:195` `async restart()`；`manager.js:12` 只 import 该类。任何 `instanceof ManagedLifecycle` 的实例都继承该方法 |
| E4 | 无任何影子/绕过载体 | 全仓 grep：`extends ManagedLifecycle` = 0；`Object.create(ManagedLifecycle` = 0；`delete *.restart` = 0；`.restart =` **赋值** = 0（唯一命中 `manager.js:73` 是 `===` 比较，旧行）；`registrations` 仅 `manager.js` 内部 9 处，`test/` = 0；无 `prototype` 改写 |
| E5 | `test/` 无「登记普通对象后调 `mgr.restart`」用例 | 真实 `LifecycleManager` 的 `restart` 调用全仓仅 `test/session-lifecycle-test.js:221` `mgr.restart('plugins')`。`plugins` 在 `MANAGED_KINDS.plugin` 为 `startable:false`（`managed-object.js:18`），故在 `manager.js:70` 能力闸提前返回，**不进** restart 的任一分支。其余 `test/*.register(` 命中均属 `ManagedRegistry`（`registry.js`）或 `intents`，不是 `LifecycleManager` |
| E6 | `lifecycle-restart-failure-test.js` 钉的是 `entry.js`，不是 `manager.js` | 该测试 `test:33` require `entry.js`，P-a..P-e 直接 `new ManagedLifecycle` 并调 `lc.restart()`（`test:52/65/79/94/109`）——锁定 `entry.js:195-215` 的回退；全程不经 `manager` |
| E7 | 无静态形态钉住该分支 | `test/` grep：`typeof lc.restart` = 0、`wasRunning` = 0、针对 manager 的 `r1.ok`/`r2.ok` = 0；读 `app/control/manager.js` 源码的用例仅 `session-lifecycle-test.js:203` 的 `require` 取类（非字符串断言） |
| E8 | 唯一实例化点 | `src/app/assembly/compose/domains.js:112` `new LifecycleManager({...})`；注册路径唯一（即 E1） |

### 1.4 删除内容与返回形状

- 删除原 73-84（`if` 包装 + 内联 fallback），保留恒可达路径：

```js
const r = await lc.restart();
return { ok: r.ok !== false, error: r.error, ...lc.snapshot() };
```

- **返回形状逐字不变**：`{ ok, error, ...snapshot }`，`error` 仍在 `...snapshot()` 之前（与改前 reachable 分支相同；snapshot 亦含 `error`，覆盖序不变）。
- 改前 fallback 与 `entry.js` 的回退**语义已分叉**：manager 副本用 `phase==='running'` 且写 `_monitoring=true`；entry 版本用 `desired`。保留两份副本本身是隐患。现回退唯一归 `entry.js`（被 P-a..P-e 锁定）。
- `node --check src/app/control/manager.js` 通过；行数 118 → 111。

### 1.5 残留边界（诚实披露）

- 理论上唯一能触达分支的路径：外部代码先 `register` 一个 `ManagedLifecycle` 实例，再显式把该实例的 `restart` 覆盖/删除为非函数，然后调 `manager.restart`。全仓无此写法；该写法也违反 `register` 的 `instanceof` 契约。故判 **不可达**，非「证据不足」。
- 若未来引入 subclass 或放开 `register` 接受普通对象，必须同时重新评估此删除。

---

## 2. 任务二：`main/**` + `facade/**` 转换计划（只读）

### 2.0 装配机制回顾

- `src/app/assembly/facets.js` 把 `app/main/*` 与 `app/facade/*` 以 `{ methods }` 装到 host（`facade/status.js` 为 `hostFirst:true`，即 `statusSummary(host)`）。
- `src/app/assembly/collaborators.js` 的 `THIN_SPEC.main` 把 19 个公开名转发到 host 上的既有 `_xxx` 方法；`THIN_SPEC.views` 把 5 个视图名转发到 facade 方法。
- 本阶段目标形态（照 `state/collaborator.js` 的惰性 getter 风格）：`createMain(deps)` / `createFacade(deps)` 自持实现；`facets.js` 的 `{ methods }` 安装**保留**（其他切面仍 `this.X()` 取用）；跨文件 `this.X` 改为经 deps 显式取用。
- `this 调用点` 口径 = 代码行内 `this.X(`（方法调用）；与主控侦察的 `main 141 / facade 13` 完全吻合（下表求和即得）。

### 2.1 `main/**` 逐文件

| 文件 | 行 | 形态 | this 调用点 | 字段读取 | 顶层 require | 主要外部协作者 |
|---|---|---|---|---|---|---|
| `main/decide.js` | 109 | `{methods}` | 25 | 6 | `platform/os/pidlookup` | `state`、`session`、proc/entry 字段、`_crashHalted/_upgradeHold/manualRestart` |
| `main/health-gate.js` | 53 | `{methods}` | 12 | 12 | `shared/guardian` | `config`、`events`、`logger`、`state.setPhase`、`ui.notify`、字段 |
| `main/signals.js` | 82 | `{methods}` | 3 | 12 | `platform/os/pidlookup`、`platform/os/index` | `config`、`events`、自有 `_killTimer/_adoptKillTimer` |
| `main/shadow.js` | 117 | `{methods}` | 5 | 43 | — | `state`、`events`、`logger`、`main.decideAction`、自有 `_shadow*` |
| `main/process.js` | 244 | `{methods}` | 68 | 89 | `os/spawn`、`os/pidlookup`、`log/log`、`app/native/command`、`./port-rederive` | `state`(27)、`events`(13)、`config`(13)、`logger`、`main`(12)、`tokenService`、`ui`、`daemons`、`nativeManager`、`dshWriter`、`pluginManager` |
| `main/port-rederive.js` | 81 | `{methods}` | 0 | 1 | `os/pidlookup`、`service/ports`、`service/config` | `config`、`logger`、`events`、`daemons.syncLanState`、`ports` |
| `main/controller.js` | 220 | `{methods}` | 28 | 97 | `os/pidlookup`、`service/monitor` | `main`(21)、`state`(23)、`config`(10)、`events`(5)、`logger`(5)、`daemons`(4)、`session`(3)、`intents`(3)、`control.syncDshView`、`lan.reconcile`、`ui.notify` |
| **合计** | **906** | | **141** | **260** | | |

逐文件要点：

- **decide.js**：纯决策，唯一自调用 `_decideCrashRestart`（同文件）。deps 需要：`state.phase/desired`、`session.halting`、proc 字段（`lastProbeOk/lastProbeHttpOk/child/adoptedPid/adopted/observedOnly/spawnBlockedUntil/startDeadline/restartAt/backoffUntil/crashWindowStart/crashWindowRestarts/backoffLevel`）、host 字段 `_crashHalted/_upgradeHold/manualRestart`。公开键：`stateSnapshot/_decideMainAction`；`_decideCrashRestart` 为内部。
- **health-gate.js**：deps：`config.crashWindowMs/crashBurst/backoff/failThreshold`、`state.setPhase`、`events.append`、`logger.error`、`ui.notify`、entry 字段 `crashWindowStart/crashWindowRestarts/backoffLevel`、proc 字段 `failStreak`。公开键：`_bumpCrashWindow/_applyHealthCheck`。注意注释锁定的**单向依赖** controller/process → health-gate，转换后须保持。
- **signals.js**：deps：`config.command[1]/stopGraceMs`、`events.append`、自有 `_killTimer/_adoptKillTimer`（建议收为工厂闭包局部量）。内部 `_signalChild/_killTree`；公开 `isManagedProcess/killAdopted/killSequence`。
- **shadow.js**：deps：`state.phase/desired`、`events.append`、`logger`、`main.decideAction`、proc 字段 `adopted`、host 字段 `_actWindow/_mainTickActs/_stopping/_upgradeHold`、自有 `_shadowSeq/_shadowLast/_shadowLoggedSeq/_shadowConsistentBeats/_shadowDiffBeats`（建议闭包局部）。内部 `_mainActualAction/_shadowExcluded`；公开 `actNote/shadowHeartbeat/shadowTickNote`。
- **process.js**：最大。deps：`state.*`、`events`、`config`、`logger`、`tokenService.feedLine/scheduleCapture/clear`、`ui.notify`、`daemons.warnOccupied`、`nativeManager.status`、`dshWriter.write`、`pluginManager`、host 字段 `_stopping/_crashHalted`、proc/entry 字段；内部 `spawnCommand/_beginRestart`；并直接 require `./port-rederive` 的 `findManagedDshPort/applyMainPort`（当前以 `this`/host 传参）——转换后应改为 deps 提供的端口再推导函数或本地导入。公开键：`startProcess/stopProcess/enterRunning/adopt/adoptObserved/beginRestart`。
- **port-rederive.js**：顶层 `findManagedDshPort(config)` 已是纯函数；`applyMainPort(host,...)` 目前吃整个 host（读 `config/logger/events/daemons`）。转换应把第二参收敛为 deps（`getConfig/getLogger/getEvents/getDaemons`），行为不变。公开 `findManagedPort/applyPort`。**测试 `test/main-port-rederive-test.js:44/46` 经 host `_findManagedDshPort/_applyMainPort` 调用，host 安装名必须保留。**
- **controller.js**：deps：19 个 `main.*` 公开方法（经工厂内部引用）、`state`、`config`、`events`、`logger`、`daemons.enabled/warnOccupied`、`session.halting/shouldRun/setState`、`intents.consume`、`control.syncDshView`、`lan.reconcile`、`ui.notify`、`monitor.probe/isPortListening`、host 字段 `_ticking/_stopping/_actWindow/_mainTickActs/_lastMainPortRederive/_sessionState/_crashHalted/_upgradeHold/_upgradeHoldSince/manualRestart`。公开键：`converge`。`_dshConverge` 是 `TK-G2` 门禁的模板目标（见 §2.4）。

**THIN_SPEC.main 公开键 → 实现**（19 键，逐字）：

| pub | 来源 | pub | 来源 |
|---|---|---|---|
| converge | controller.`_dshConverge` | startProcess | process.`_startProcess` |
| decideAction | decide.`_decideMainAction` | stopProcess | process.`stopProcess` |
| stateSnapshot | decide.`_mainStateSnapshot` | isManagedProcess | signals.`_isManagedProcess` |
| applyHealthCheck | health-gate.`_applyHealthCheck` | killAdopted | signals.`_killAdopted` |
| bumpCrashWindow | health-gate.`_bumpCrashWindow` | killSequence | signals.`_killSequence` |
| adopt | process.`_adopt` | actNote | shadow.`_actNote` |
| adoptObserved | process.`_adoptObserved` | shadowHeartbeat | shadow.`_shadowHeartbeatBeat` |
| applyPort | port-rederive.`_applyMainPort` | shadowTickNote | shadow.`_shadowTickNote` |
| beginRestart | process.`_beginRestart` | findManagedPort | port-rederive.`_findManagedDshPort` |
| enterRunning | process.`_enterRunning` | | |

内部（非 THIN，仍装 host 供本切面自用）：`spawnCommand`、`_signalChild`、`_killTree`、`_decideCrashRestart`、`_mainActualAction`、`_shadowExcluded`。

### 2.2 `facade/**` 逐文件

| 文件 | 行 | 形态 | this 调用点 | 字段读取 | 顶层 require | 主要外部协作者 | 对外方法 |
|---|---|---|---|---|---|---|---|
| `facade/lan.js` | 49 | `{methods}` | 0 | 6 | — | `daemons.enabled`、`ctl.lanCall`、`lan.list/frpStatus` | `listLan`、`frpStatus` |
| `facade/main.js` | 43 | `{methods}` | 5 | 8 | — | `state.readMainMeta/phase`、`config.command/targetPort`、`instances.all`、proc 字段 `child/adoptedPid` | `dshMainView`、`exposurePeers` |
| `facade/ports.js` | 70 | `{methods}` | 1 | 8 | `platform/util/probe`、`platform/service/ports` | `logger`、自有 `_portActivesCache` | `listPorts`、`_portActives` |
| `facade/router.js` | 90 | `{methods}` | 7 | 27 | — | `config.routerAutostart`、`daemons.managed/routerActive`、`router.*`、`ctl.routerFacade`、`managedObjects.get`、`logger`、自有 `_routerFacade` | `routerDaemonActive`、`routerStatusView`、`routerProviders`、`routerStatus`、`routerDomainSummary`、`routerApi` |
| `facade/status.js` | 49 | `hostFirst` | 0 | 0 | `platform/service/install-id` | `_m*` 字段、`_sessionState`、`_fileProtectStatus`、`guardVersion`、`config.targetPort`、`tokenService.get`、`tasks.running`、`nativeManager.*`、`_upgradeHold` | `statusSummary` |
| **合计** | **301** | | **13** | **49** | | | |

要点：

- `facade/router.js` 有同切片内调用 `routerApi()/routerDaemonActive()/routerStatus()`（7 个调用点全在此），转换后改为工厂内部具名函数引用，消除隐式 `this`。注意 **`facade.routerDaemonActive` 与 `daemons/probe._routerDaemonActive` 是两个不同方法**：前者读 `config.routerAutostart + daemons.lock + daemons.routerActive()`，后者探 ctl 端口监听者 cmdline。THIN_SPEC.views.routerDaemonActive → 前者；THIN_SPEC.daemons.routerActive → 后者。转换时不可合并。
- `facade/ports.js` 的 `_portActives` 是自调用 + 自有缓存字段，建议收为闭包局部量。
- `facade/status.js` 是 `hostFirst`，当前签名 `statusSummary(host)`。工厂化后应返回 `statusSummary()`（闭包持 deps）；`facets.js` 的 `hostFirst` 安装逻辑需由负责人同步处理（属 assembly，不越界）。

### 2.3 建议工厂形态与 deps 清单

**`src/app/main/collaborator.js` → `createMain(deps)`**
返回恰好 THIN_SPEC.main 的 19 键（§2.1 表）。
deps（惰性 getter，照 `state/collaborator.js` 风格）：

- 外部协作者：`getConfig`、`getLogger`、`getEvents`、`getState`、`getSession`、`getControl`、`getDaemons`、`getIntents`、`getUi`、`getLan`、`getTokenService`、`getNativeManager`、`getDshWriter`、`getPluginManager`
- 字段口二选一：
  - 方案 A（推荐，去除对 host `_m*` 名依赖）：`getState` + 直接复用 `state/field-tables.js` 的 `ENTRY_FIELDS/PROC_FIELDS`，经 `state.procField(name)`/`state.field(name)` 读写；
  - 方案 B（最小改动）：`getField(name)/setField(name,v)`、`getProcField(name)/setProcField(name,v)` 惰性取 host 上的 `_mXxx/_mSetXxx`。
- 自有运行期字段（`_ticking/_stopping/_actWindow/_mainTickActs/_lastMainPortRederive/_sessionState/_shadow*/_killTimer/_adoptKillTimer`）→ 建议工厂闭包局部量；`_crashHalted/manualRestart/_upgradeHold/_upgradeHoldSince` 目前是 host 上的共享字段，需经 `getHostField/setHostField` 保留共享语义（status 视图亦读）。
- 跨文件端口再推导：把 `port-rederive` 的 `findManagedDshPort/applyMainPort` 经 deps 注入，或由工厂内 require 并适配 deps。

**`src/app/facade/collaborator.js` → `createFacade(deps)`**
建议返回 facade 当前的 host 安装面（13 键）：`listLan、frpStatus、dshMainView、exposurePeers、listPorts、_portActives、routerDaemonActive、routerStatusView、routerProviders、routerStatus、routerDomainSummary、routerApi、statusSummary`。
deps：`getConfig`、`getLogger`、`getEvents`、`getState`、`getSession`、`getDaemons`、`getCtl`、`getRouter`、`getInstances`、`getManagedObjects`、`getTokenService`、`getNativeManager`、`getTasks`，以及 §2.2 所列 host 字段口。

> **歧义请负责人裁定**：`collaborators.js` 的 `THIN_SPEC` 没有 `facade` 命名空间；`views` 只覆盖其中 5 名（`dshMain/exposurePeers/routerDaemonActive/routerStatus/status`），其余 8 名（含 `listLan/listPorts/routerStatusView/routerProviders/routerDomainSummary/routerApi`）是直接装在 host 上的方法。故 `createFacade` 的「公开面」到底取「13 个 host 方法名」还是「views 的 5 个 pub 名」，由负责人按注册方案决定；本计划建议取 13（因为工厂须组合本切面全部实现），`views` 命名空间保持转发或改映射。

### 2.4 CI / 门禁风险点（改前必须核）

> 注：下列 `test/` 行号为本次快照时刻；P3-B 正并发改 `test/**`，行号可能漂移，以**符号名/文件路径**为定位依据。

1. **TK-G2 锁定 `controller.js` 的 `_dshConverge` 形态**：`test/token-contract-gate-test.js:547/556-567` 读 `src/app/main/controller.js`，用 `methodBody(structOf(CV2), '_dshConverge')` + `switchBlocks` 定位 phase switch；定位失败会**显式 FAIL**（"结构变化，需人工核对"）。转换必须保留 `controller.js` 中 `{methods}` 导出与 `_dshConverge` 方法体/缩进/大括号形态。**建议 `{methods}` 文件保持为薄壳原样，工厂只转发。**
2. **process-tree-kill 门禁锁定两文件与缩进**：`test/process-tree-kill-test.js:38-40,71,84` 合并读 `src/app/main/process.js` + `signals.js`，正则 `/\n  _killAdopted\(pid\) \{/`、`/\n  _killSequence\(child\) \{/`（**两空格缩进**）。移动文件或改缩进即 FAIL。
3. **`{methods}` 导出面被测试直接消费**：`test/shadow-decision-test.js:29-30` require `main/decide.js` 的 `methods._decideMainAction`；`test/main-port-rederive-test.js:44/46` 调 host `_findManagedDshPort/_applyMainPort`；`test/token-boundary-test.js:52` 调 `sup.listLan()`；`test/round13-router-relay-gaps-test.js:78/81` 覆写 `inst.dshMainView/exposurePeers`；`test/cross-platform-test.js:146` 调 `statusSummary()`。故所有 host 安装名与 `methods` 键逐字保留。
4. **DG-14（facade 只读）会扫新增文件**：`test/domain-structure-gate-test.js:542-561,940-954` 对 `ENTRIES.filter(rel.startsWith('app/facade/'))` 调 `facadeWriteViolations`；例外表按**精确文件路径** `app/facade/lan.js{listLan}`、`app/facade/ports.js{listPorts}` 登记（:546-547）。新增 `app/facade/collaborator.js` 会被一并扫描；若实现迁入其中且被 `methodBodies` 解析出命中写动词/写目标的方法名，即误报。**建议保留 `facade/*` `{methods}` 文件原地不动，工厂只组合。**
5. **DG-2 ≤300 行**：`test/domain-structure-gate-test.js:587-598`。新增 `collaborator.js` 必须只做装配（组合 7/5 个已有文件），不得把实现搬入单文件（`main/process.js` 已 244 行）。
6. **DG-12 阈值联动**：转换会移除约 141(main)+13(facade) 个 `this.X()` 调用；根级 `this.X()` 现约 512，转换后将低于旧硬阈值 400。DG-12 目前已改为**合成样本**判据（`test/domain-structure-gate-test.js:886-922`，P3-B 在办），真实总量仅作证据。**转换前须确认该合成判据已进 `scripts.test` 链**，否则会自锁转红（跨 P3-A/P3-B 协调点）。
7. **DS-G3b/DG-8（无原型注入）**：转换不得改用 `Object.assign(X.prototype, methods)`；`facets.js` 的 host 实例安装形态保持。
8. **`facets.js` 的 `hostFirst` 分支**：`facade/status.js` 是 hostFirst，工厂化后签名变化需负责人同步改 `facets.js`（assembly 独占，本分片不越界）。

### 2.5 建议施工序（一次一面，每步 `node --check`）

1. **装配骨架（零行为变更、最低风险）**：新建 `main/collaborator.js` 只把 19 键转发到现有 `methods` 实现；不改任何实现体。负责人注册后先验证测试面不变。
2. **main 逐文件去 this**：decide → health-gate → signals → shadow → port-rederive → process → controller。每步：跨文件 `this.X` 改 deps，同文件纯局部保持；每步 `node --check`。
3. **facade 同法**：新建 `facade/collaborator.js`（13 键）→ 去 this。注意保留 `facade/*` `{methods}` 文件供 DG-14/测试消费。
4. 全程**不注册**（`assembly/` 由负责人独占）；注册片段与顺序由负责人决定。

---

## 3. 交付与自检

- 改动文件：`src/app/control/manager.js`（1 文件；删除已证不可达的 7 行内联回退，118→111）。
- `node --check src/app/control/manager.js`：通过。
- 未改 `test/`、未跑测试/门禁、无 git 写、未含操作者绝对路径。
- 报告文件：`design-notes/_p3-a-manager-plan.md`。
