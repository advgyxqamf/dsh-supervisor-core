# EXEC-app-unmix —— AP1 · 装配收口（批 8/10，原型挂载全域消除）

> 范围：`src/supervisor.js`、新增 `src/app/assembly/facets.js`、`src/app/assembly/compose.js` 装配入口、
> `src/platform/service/ports/index.js` + `src/app/facade/ports.js`（跨层只读聚合）、两处门禁自检、
> 一处测试改址。
> 依据：`EXECUTION-CONTRACT.md`（§7 D-1..D-6）、`DOMAIN-STRUCTURE-DESIGN.md` §5.6 + §6 R7/R8、
> `design-notes/app-orchestration.md` §C/§D.3。
> 纪律：未启动任何守卫/daemon；未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；未 commit。

## 1. 完成判据达成

| 判据 | 结果 |
|---|---|
| ① 剥注释后 `Object.(assign|defineProperties)(X.prototype, ...)` = 0 | **0 处**（`grep -rnE` 实跑为空） |
| ② `wc -l src/supervisor.js` ≤200（力争 ≤150） | **75 行**（原 181） |
| ③ 全量回归 | 124 条链测试逐条独立实跑，无新增失败（见 §5；`core-test` 2 项 UI 未构建为既存环境项） |
| ④ `directory-structure-gate` DS-G3b 硬失败转 PASS | **PASS**（0 failed hard）；DS-G7 PASS（75 行） |
| ⑤ `domain-structure-gate` DG-8 转 PASS | **PASS**（0 failed hard，real=0） |
| ⑥ 产出本文件 | ✔ |

## 2. 实际改动

### 2.1 新增 `src/app/assembly/facets.js`（唯一兼容门面清单 + 装配器）
旧 `supervisor.js` 末尾的 APP_MODULES 循环被删除，改为**具名切面清单** `FACETS`（40 条）——
每个编排层模块是一个具名切面，声明其导出形态（`{methods}` / `{accessors}` / host-first 自由函数 /
api-rebind 注入）。`installFacets(host, deps)` 把各切面成员装到 **host 实例**：

- `{methods}` → 逐个装到实例（`this` = host，跨文件 `this.X()` 语义不变）；
- `{accessors}` → `Object.defineProperty` 装到实例（get/set 无法经赋值复制）；
- host-first 自由函数（bootstrap/machine/shutdown/desired/upgrade-hold/notify/facade-status）→
  `function(...args){ return fn(this, ...args) }` 首参绑定；
- `api/re-bind` → `_apiStart/_apiRebind`，`createServer` 由 root 注入（app 不得 require api，DS-3）；
- `state/fields` → 显式 `buildFieldHelpers(host)` 把 46 个字段 helper 生成到实例。

切面顺序与旧 APP_MODULES **逐字一致**，保证同名成员覆盖序不变。

### 2.2 `src/supervisor.js` 降为真薄壳（181 → 75 行）
- 删除 `APP_MODULES`（40 条 require）、`HOST_FIRST_MODULES`、`Object.assign(Supervisor.prototype, …)`、
  `Object.defineProperties(Supervisor.prototype, …)`、api-rebind 的两处原型赋值。
- 类只留：`constructor`（调 `composeSystem(this, …, { createServer })`）、`get/set lan`、`start`。
- 保留 `normalize` 兼容导出（语义不变）。

### 2.3 `src/app/assembly/compose.js`
- 新增 `require('./facets')`；`composeSystem(host, rawConfig, configPath, deps)` 签名新增可选 `deps`；
- **业务体第一行** `installFacets(host, deps)` —— 构造期即需 `host._mSetX()/_bindNativeDshCommand()/loadState()`，
  必须早于 compose 业务体。装配点仍收敛在 assembly（唯一 DI 发生地）。

### 2.4 跨层只读聚合：`platform/service/ports` 新增 `readAll(extraFiles)`（裁决项 1）
- `facade/ports.js` 原直接 `fs.readFileSync` 另两份注册表（`ports-lan.json`/`ports-router.json`），
  绕过 platform 接口。现改为 `platform/service/ports.shared.readAll([...])`。
- **接口设计**：`readAll(extraFiles)` 接受**文件名单作为入参**——platform 不硬编码任何域名词
  （否则触发 DS-G4「platform 源码无域名词」硬失败）。文件名属域知识，由 `app/facade/ports.js` 侧提供。
- 语义：本表记录（按 port 排序）在前，随后并入各姊妹文件的未重复记录（去重，本表优先）——
  与原「`ports.list()` + 两文件循环 adopt」等价。
- platform 可被上层依赖，新增只读聚合接口是合法的向下能力，不引入反向边。

### 2.5 门禁自检同步（不变量不变）
- `test/domain-structure-gate-test.js` DG-8：原反向自检要求「src 真实命中 ≥1」，收口后真实命中恒 0，
  该自检会硬失败。改为在**合成样本**上验证判据命中 + 断言扫描集非空（`sample=1 files=203 real=0`）。
  判据本体（`MIXIN_INTO_PROTOTYPE`）与其余反向自检一字未改。
- `test/layering-and-dependency-gate-test.js` `CROSS_LAYER['root -> app']`：root 不再逐个 require 各 app 子目录，
  旧 12 条登记中 10 条变**死条目**（L-2b 会 FAIL）。收敛为实际存在的 2 条：
  `src/app/assembly`（组装 + 切面装配入口）、`src/app/settings`（root 兼容门面注入域配置键声明）。

### 2.6 注释同步（无语义变更）
`state/main-record.js`（2 处）、`domain-actions/router.js`（1 处）把「装配到 Supervisor.prototype」
改为「装配到 host 实例（app/assembly/facets.js）」。

## 3. 公共面保真核对表

**总量核对**：收口前 `Supervisor.prototype` 自有成员 **188**（177 方法 + 9 访问器 + `lan` + `start`）；
收口后 = 实例 186 自有成员（177 方法 + 9 访问器）+ 原型 `{lan, start}`（+`constructor`）→ **188，逐一同名**。
`_mPhase`/`_mSetPhase`/`phase` 访问器/`_apiStart`/`_apiRebind` 实跑类型校验通过。

### 3.1 api 消费面（`api/deps.js` 声明，R9「只声明不强制」保持）
数据字段/访问器（`config`/`tasks`/`events`/`eventHub`/`health`/`lifecycleManager`/`nativeManager`/
`pluginManager`/`pluginMarket`/`dist`/`instances`/`shellDomain`/`tokenService`/`desired`/`phase`）
仍由 compose 构造/fields 访问器提供；`autostartStatus`/`setAutostart` 与本轮无关（本就非 Supervisor 方法，
由 hostService 生命周期注册提供）。方法成员全部在实例上，签名/语义不变：
`statusSummary` `shutdownAll` `sessionState` `patchDshMain` `routerApi` `routerDomainSummary`
`routerProviders` `routerStatusView` `setRouterRunning` `listLan` `frpStatus` `lanFrpc` `setLanFrp`
`dshMainView` `listPorts` `guardVersionLocal` `guardVersionCheck` `guardSelfUpdateStatus` `dshenvStatus`
`envStatus` `nodeLtsStatus` `accessKeyStatus` `setAccessKey` `closeActionStatus` `setCloseAction`
`lanPanelStatus` `setLanPanel` `setDesired` `notify` 等。

### 3.2 逐切面成员（facet → 成员）
| 切面 | 成员 |
|---|---|
| assembly/bootstrap | `_bootstrap` `_startShellWatchdog` `_registerFixedPorts` `_bindNativeDshCommand` |
| assembly/api-rebind | `_apiStart` `_apiRebind` |
| session/machine | `sessionState` `_setSessionState` `_sessionHalting` `_shouldRun` |
| session/shutdown | `shutdown` `shutdownAll` `_stopMainDsh` `_stopAllSandboxes` |
| state/store | `_dshEntry` `_mainFallbackEntry` `_persistCrashField` `_mStore` `_mField` `_mProcField` `writeState` `loadState` `_migrateMainRecord` |
| state/fields | 相位/期望/守护读写 + 46 生成 helper（`_mXxx`/`_mSetXxx`）+ 9 访问器（见 §3.3） |
| state/desired | `setDesired` `requestRestart` `persistConfigPatch` |
| state/upgrade-hold | `_enterUpgradeHold` `_enterUpgradeHoldAsync` `_exitUpgradeHold` |
| state/main-store | `_dshMainFile` `_registryFileName` `_readDshMain` `_readDshMainFile` `_writeDshMain` |
| self/notify | `notify` |
| control/projection | `_syncDshLifecycleView` `_syncRouterLifecycleView` `_syncInstancesLifecycleView` |
| control/scheduler | `tick` `_dshSuperviseOnce` |
| control/specs | `_managedMainSpec` `_managedSandboxSpec` `_syncManagedRegistry` `_upsertManaged` `_unregisterManaged` |
| control/instance-adapter | `_sandboxSuperviseOnce` `_syncSandboxRegistryEntry` |
| main/decide | `_mainStateSnapshot` `_decideMainAction` `_decideCrashRestart` |
| main/controller | `_dshConverge` |
| main/shadow | `_actNote` `_mainActualAction` `_shadowExcluded` `_shadowTickNote` `_shadowHeartbeatBeat` |
| main/process | `spawnCommand` `_startProcess` `_enterRunning` `_findManagedDshPort` `_applyMainPort` `_adoptObserved` `_adopt` `_beginRestart` `stopProcess` |
| main/signals | `_isManagedProcess` `_signalChild` `_killTree` `_killSequence` `_killAdopted` |
| main/health-gate | `_bumpCrashWindow` `_applyHealthCheck` |
| daemons/supervise | `_daemonSuperviseOnce` |
| daemons/runtime | `_daemonLifecycle` `_daemonEnsureResult` `_syncLanState` `_ensureLanRuntime` `_ensureRouterRuntime` `_disableRouterPersist` `_warnOccupied` |
| daemons/identity | `_lanLockPath` `_lanManaged` `_writeLanLock` `_clearLanLock` `_routerDaemonLockPath` `_daemonManaged` `_writeRouterDaemonLock` `_clearRouterDaemonLock` |
| daemons/probe | `_routerDaemonActive` `lanDaemonEnabled` `_lanDaemonActive` |
| ctl/client | `_ctlCall` `_routerCtlPort` `_lanCtlPort` `_lanCtlCall` |
| ctl/facades | `_makeRouterFacade` `_makeCtlFacade` |
| facade/router | `routerDaemonActive` `routerStatusView` `routerProviders` `routerStatus` `routerDomainSummary` `routerApi` |
| facade/lan | `listLan` `frpStatus` |
| facade/ports | `listPorts` `_portActives` |
| facade/main | `dshMainView` `exposurePeers` |
| facade/status | `statusSummary` |
| domain-actions/router | `setRouterRunning` |
| domain-actions/lan | `setLanFrp` `lanFrpc` `syncFrpc` |
| domain-actions/main | `patchDshMain` |
| audit/orphan-scan | `_orphanAudit` |
| settings/env | `envStatus` `dshenvStatus` |
| settings/node-lts | `nodeLtsStatus` |
| settings/versions | `guardCorePkg` `guardSelfUpdateStatus` `_readBinarySelfVersion` `_vcsRoot` `guardVersionLocal` `guardVersionCheck` |
| settings/access | `accessKeyStatus` `setAccessKey` `closeActionStatus` `setCloseAction` |
| settings/lan-panel | `lanPanelStatus` `setLanPanel` |

### 3.3 特例：`state/fields` 的 46 helper + 9 访问器（任务书点名）
不再经 `Object.assign(prototype, require(...).methods)`；由 `facets.installFacets` 对 fields 切面显式
`buildFieldHelpers(host)` 生成到 **host 实例**，`accessors` 以 `Object.defineProperty(host, …)` 落到实例。
访问器：`phase` `desired` `child` `adoptedPid` `adopted` `observedOnly` `restartCount`
`spawnBlockedUntil` `missingNotified`。

## 4. 测试改动清单

| 文件 | 改动 | 理由（真解耦） |
|---|---|---|
| `test/graceful-shutdown-test.js:100-116` | `Object.create(Supervisor.prototype)` + `proto.shutdown.call(fake)` → `require('src/app/session/shutdown')` + `shutdown(fake)` | 唯一直接调 `Supervisor.prototype.X` 的测试；改为直取家园模块（host 首参形态）。断言语义不变。 |
| `test/domain-structure-gate-test.js` DG-8 | 反向自检由「真实命中 ≥1」改为「合成样本命中 + 扫描集非空」 | 收口后真实命中恒 0，旧自检会误报门禁空转。 |
| `test/layering-and-dependency-gate-test.js` `root -> app` | 登记从 12 单元素收敛为 `assembly` + `settings` 2 条 | root 不再逐个 require 各子目录；不删即 L-2b 死条目。 |

其余 123 条链测试**零改动**。api 侧零改动（`routerApi` 仍由 `sup.routerApi()` 取用，
`api/domains/router.js` 消费面经 `p2p-api-test` 35 项全绿验证未断）。

## 5. 回归实测

- `node --check` + `require` 加载：`supervisor.js` / `facets.js` / `compose.js` / `ports` / `facade/ports` 全通过。
- 两个门禁：`directory-structure-gate` **16 passed / 0 failed(hard)**；`domain-structure-gate`
  **54 passed / 0 failed(hard)**（DG-8 已 PASS，real=0）。
- 定向：`graceful-shutdown`(17) `layering-and-dependency-gate`(10) `session-lifecycle`(41)
  `precheck`(exit0) `main-port-rederive`(6) `adopt-token-reclaim`(27) `token-boundary`(12)
  `lifecycle-mirror`(11) `api-contract`(14) `ports-verify`(14) `cross-platform`(39)
  `token-contract-gate`(38) `p2p-api`(35) `heartbeat-selfheal`(16) `kernel-update-single-writer`(24)
  `native-dsh-binding`(12) `platform-capability-audit`(66) 全绿。
- `xvfb-run -a npm test`：`&&` 链在第 4 条 `core-test` 因 **UI 未构建（既存环境项）** 退出 1 而截止；
  该 2 项失败为任务书明示的既存项（`面板带 CSP 头`/`nosniff 头存在`）。
- 为覆盖链截断之后的测试，已把 `scripts.test` 的 **124 条**逐条独立实跑（`/tmp/ap1-run-all.sh`）：
  **120 pass / 3 fail**，失败全部为**既存环境项，与本轮改动无关**：
  `core-test`（2 项 UI 未构建）、`release-auth-test` 的 `R4-c 无 token 时不误报成功`（沙箱 `$HOME\.npmrc`）、
  `all-platforms-test` 的 `T6-a 内核零运行时依赖`（`dependencies.acorn` 既存）。
  三者分别只读 UI 产物 / `~/.npmrc` / `package.json.dependencies`，均不在本轮改动面内；无新增失败。

## 6. 与设计/任务书的偏差（如实）

1. **「类内薄委托方法」的落地形态**：任务书 item 3 建议「类内写一行转发方法 / 字段用 get」。
   本轮把兼容门面**在构造期经显式具名切面清单装到实例**（`facets.js`），类体只留
   `constructor/start/lan`。原因：app 层仍有 **222 处跨文件 `this.X()`**，其方法体依赖扁平
   上下文 `this`；若拆成「字段各自 getter + 类内转发到独立协作方」，必须同步改写全部 222 处调用点——
   那正是 SSOT §5.6「级 2（按切面 ctor 注入）」与 `app-orchestration.md` §D.2 的批 9 范围。
   本轮（级 1）先**彻底移除原型挂载**并给出唯一、具名、可审计的装配清单，为级 2 提供收口点。
2. **装配器放 `facets.js` 而非 `compose.js` 本体**：compose.js 已 366 行（DF-2 报告项），
   把 40 条清单 + 装配逻辑内联会进一步逼近/突破 400；故拆为同目录 `facets.js`，由 compose 首行调用。
   装配点仍在 assembly（唯一 DI 发生地），未新增跨层边。
3. **DG-8 自检修改**：任务书未点名，但收口后不改该自检则门禁硬失败；改动只针对「非空转」的
   real-hit 依赖，判据本体与全部合成样本自检保持不变。
4. **layering 登记收敛**：对应 `app-orchestration.md` §D.3「root→app 11 条收敛为 1 条（需上层裁决）」——
   本轮按实际边收敛为 2 条（含 root 兼容门面 `normalize` 的 `app/settings`）。属收口授权范围内的登记同步。

## 7. 遗留（明确不在本轮）

- **级 2：按切面 ctor 注入**——把 177 个方法从扁平 host 拆到具名协作方（`host._state`/`host._forward` 式），
  改写 222 处跨文件 `this.X()`。`facets.js` 的 `FACETS` 表即其切入点。
- **DF-5 的 app 层真正达成**：本轮只消除「原型」这一合并形态；实例级扁平上下文仍在（DG-4/DG-5
  `domain-structure-gate` 目前**不扫描 app**，故未触发硬失败）。
- **`api/deps.js` 强制校验**（R9 收紧）仍留待「两路重构汇合后单独立项」；本轮保持只声明不强制，
  指向已核对无断（`routerApi` → `app/facade/router.js:90`，`setRouterRunning` → `app/domain-actions/router.js`）。
- 单文件阈值报告项（`platform/service/ports/index.js` 592 行）因 `readAll` 增加约 25 行；DF-2 仍为
  report-only 的既存 RED，不在本轮范围。
