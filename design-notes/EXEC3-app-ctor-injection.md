# EXEC3 · app 级 2：真 ctor 注入（state / session / control）

> 范围（本子代理独占）：`src/app/**` 的**协作方工厂化**（除 `app/native/**`）。
> 依据：`EXECUTION-CONTRACT.md` §1–§6、`DOMAIN-STRUCTURE-DESIGN.md` §5.6「级 2」、`design-notes/EXEC3-app-this-flattening.md`。
> 纪律：未启动任何守卫/daemon（仅测试自身的 `require()` + 假依赖 + 既有沙箱测试）；
> 未 commit；未碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`、已安装包；
> 未给 `package.json` 的 `dependencies` 加任何包（仅 scripts.test 链登记 1 个新测试）。

## 0. 完成判据达成

| 判据 | 结果 |
|---|---|
| **≥3 个切面真 ctor 注入** | **3 个**：`state` / `session` / `control` —— 各工厂**自己持有实现** |
| **可用假 deps 直测** | ✔ 新增 `test/app-ctor-injection-test.js`：**26 passed / 0 failed**，只 require 协作方工厂，不构造 Supervisor |
| 公共面保真 | host 旧方法名（`_mPhase`/`_mSetPhase`/`phase`/`_readDshMain`/…）全部保留为**兼容外壳**；`api-surface` 12/0、`api-contract` 14/0 |
| 相关测试全绿 | 见 §5（唯一 RED：smoke 因**其他并发代理同时跑 smoke 抢 3900/3901 固定端口**，见 §5.3） |
| 三结构门禁不退化 | directory 16 passed/0 hard；layering 10/0；domain 55 passed/0 hard（soft 项与基线一致） |
| 产出本文件 | ✔ |

## 1. 级 2「真 ctor」与批 9「薄委托」的区别

批 9（`EXEC3-app-this-flattening.md`）的 `collaborators.js` 是**薄委托**：
```js
host.state.phase = function (...) { return host._mPhase(...); } // 实现仍在 host 上
```
本轮改成**工厂 + deps 入参**，实现落在协作方模块内：
```js
const state = createStateStore({ getConfig, getLogger, getManagedObjects, ... }); // 实现真在 state 里
host.state = state;
host._mPhase = () => state.phase();  // host 只留兼容外壳（公共面不变）
```
判定标准（任务书）：「只 `require` 那个协作方模块、给假 deps、直接断言行为」——
`test/app-ctor-injection-test.js` 正是如此，全程无 `Supervisor`。

## 2. 实际改动

### 2.1 state（F8，优先级最高；被依赖最多）

| 文件 | 新形态 |
|---|---|
| `state/main-record.js` | `createMainRecord(deps)` → `{ entryOf, fallbackEntryOf, persistCrashField, storeOf, fieldOf, procFieldOf }`；**fallback 存储由闭包持有** |
| `state/main-store.js` | `createMainStore(deps)` → `{ dshMainFile, registryFileName, readDshMain, readDshMainFile, writeDshMain }`；live 缓存闭包持有 |
| `state/fields.js` | `createFields(deps)` → phase/desired/guardian/字段读写 + **9 个兼容访问器**（phase/desired/child/…）真身；`_mPhase` 等不再转发 |
| `state/store.js` | `createStore(deps)` → `{ writeState, loadState, migrateMainRecord }`；`_lastStateBody` 闭包持有 |
| `state/desired.js` | `createDesired(deps)` → `{ setDesired, requestRestart, persistConfigPatch }` |
| `state/upgrade-hold.js` | `createUpgradeHold(deps)` → `{ enter, enterAsync, exit }` |
| `state/collaborator.js` | **新增**：`createStateStore(deps)` 按依赖序组合上述工厂，导出 SPEC 公共面 + 宿主兼容面 |

- deps 全为**惰性取值函数**（`getConfig()`/`getLogger()`/…）：因为 `installFacets` 在 compose 业务体**之前**运行，
  `host.config/logger/managedObjects` 彼时尚未就绪；取值函数让工厂在**调用时**读最新值，不硬化装配顺序。
- `state/field-tables.js`（纯数据）与 `state/phase.js`（纯映射）**保持不动**（DF-3）。

### 2.2 session（F2）

- `session/machine.js` 改为 `createSession({ events, desired, crashHalted })`，**自己持有 `_sessionState`**（不再读写 host 字段）。
- host 兼容：`host._sessionState` 改为 **accessor**（get/set → session），`sessionState/_setSessionState/_sessionHalting/_shouldRun` 为薄壳。
- `session/shutdown.js` 未动（它是关停编排，不是协作方；消费 `host.session.halting()` 照常）。

### 2.3 control（F6/F7）

- `control/projection.js` 改为 `createProjection(deps)` → `{ syncDshView, syncRouterView, syncInstancesView }`。
- `control/specs.js` 改为 `createSpecs(deps)` → `{ mainSpec, sandboxSpec, upsert, unregister, syncManagedRegistry }`；
  **保留 `kind: 'lan-daemon'`/`'router-daemon'` 对象字面量文本**（`guard-domain-model-gate-test` GD-1 读源码定位）。
- `control/collaborator.js` **新增**：`createControlPlane(deps)` 组合二者，导出 SPEC 6 方法 + `mainSpec/syncManagedRegistry`。
- host 兼容：`_syncDshLifecycleView`/`_syncRouterLifecycleView`/`_syncInstancesLifecycleView`/`_managedSandboxSpec`/
  `_upsertManaged`/`_unregisterManaged`/`_syncManagedRegistry` 为薄壳。
- `control/scheduler.js`/`control/instance-adapter.js` 未动（非协作方本身；消费 `this.control.*` 照常）。

### 2.4 装配

- `assembly/collaborators.js` 重写：`installCollaborators` 先装三个真 ctor 协作方（state→session→control）与兼容外壳，
  再装其余 6 个**薄委托**协作方（`ctl/daemons/main/views/audit/ui`，接口表改名 `THIN_SPEC`），最后 `validate`。
- `assembly/facets.js`：从 FACETS 移除已工厂化的 8 个切面条目（session/machine、state/{store,fields,desired,upgrade-hold,main-store}、
  control/{projection,specs}）；其余切面（含并发代理新增的 `main/port-rederive`）保持原样。**compose.js 未动**（组装顺序不变）。
- host 字段 helper（`_mXxx/_mSetXxx` 共 38 个）由 `collaborators.js` 依 `field-tables` 生成薄壳（委托 `state.field/procField`）。

## 3. 判据（DF-1..DF-9）自查（新增/改写文件）

| 判据 | 结果 |
|---|---|
| DF-1 门面 ≤150 | 本批无门面文件；`collaborators.js` 201、`facets.js` 124 |
| **DF-2 单文件 ≤300** | 全部满足：最大 `assembly/collaborators.js` 201；state 各文件 39–121；control 37–127；session 44 |
| DF-3 纯/IO 分文件 | `field-tables`/`phase` 纯数据/纯映射；IO 在 `main-store`/`store`/`desired`（fs） |
| **DF-4 零跨文件 this** | 新增/改写模块 **`this` = 0**（grep 实测）；工厂内部一律闭包/显式参数 |
| DF-5 DAG 且禁方法集合并 | require 图单向：collaborator → 子工厂 → 纯模块；无 `Object.assign(X.prototype, …)`；DG-8 hard=0 |
| DF-6 可独立 require | `test/app-ctor-injection-test.js` 只 require 三个协作方模块 + 假 deps |
| DF-7 单向 | 同 DF-5；host 兼容壳是**消费端**，不被工厂反向 require |
| **DF-8 require 顶层** | 所有 require 在模块顶层；无函数体内联 require |
| DF-9 嵌套 ≤6 | 新增模块最大嵌套 ≤3（无回调金字塔） |

## 4. 同步改指向的既有测试（EXECUTION-CONTRACT §4.5）

| 测试 | 改动 | 原因 |
|---|---|---|
| `test/round13-router-relay-gaps-test.js` | `inst._readDshMain/_writeDshMain` → `inst.state.readMainMeta/writeMainMeta` | state 真身已迁入协作方，注入点随之上移 |
| `test/adopt-token-reclaim-test.js` | `sup._mGuardian = …` → `sup.state.guardian = …` | guardian 真身迁入 state |
| `test/srcpath-gate-test.js` | G10-d 判据接受**顶层 require 形态**（原只认内联） | DF-8 上提后原正则恒假（R3-F 已令 runtime 命中；本批同时修 specs 指向） |
| `test/round13-robustness-batch-test.js` | ④ 节流「前推」改读 `control/heartbeat.js`（清除仍在 registry.js） | 并发代理把节流实现迁到 heartbeat.js |
| `package.json` | `scripts.test` 链登记 `test/app-ctor-injection-test.js` | `test-chain-completeness` N-a 要求 `*-test.js` 必须入链（未动 dependencies） |

## 5. 验证

### 5.1 新增直测
`node --require ./test/_preload.js test/app-ctor-injection-test.js` → **26 passed / 0 failed**：
state 12（phase/desired/字段/访问器/main 元数据/配置落盘）、session 5、control 9（三视图/申报/域 B 无 guardian）。

### 5.2 相关回归（逐条实跑，exit 0）
phase-vocabulary 8/0、managed-registry 44/0、session-lifecycle 41/0、shadow-decision 9/0、
lifecycle-mirror 11/0、heartbeat-selfheal 16/0、daemon-path 7/0、api-surface 12/0、api-contract 14/0、
guard-domain-model 20/0、round13-router-relay-gaps 25/0、adopt-token-reclaim 27/0、srcpath-gate 11/0、
round13-robustness-batch 22/0、daemon-lifecycle 14/0、managed-lifecycle-failure 13/0、
probe-gate-and-ownership 33/0、native-dsh-binding 12/0、kernel-daemon-contract 23/0、runtime-contract 12/0、
graceful-shutdown 17/0、round13-lifecycle-stop-phase 9/0、watchdog-phase-freshness 11/0、
main-port-rederive 6/0、provider-gateway-gate 23/0、kernel-update-single-writer 24/0、state-root 15/0、
token-contract-gate 38/0、dev-runtime-safety-gate 6/0、no-console-window-gate 7/0、loghub 19/0、
api-fuzz 9/0、sigterm-desired 4/0、all-platforms 34/0（T6-a 零运行时依赖）、install-id 10/0、
test-chain-completeness 10/0、standards-uniqueness 8/0、test-safety-gate 5/0。

### 5.3 三结构门禁
- `directory-structure-gate`：**16 passed / 0 hard**（1 项 report-only：api/index.js 179、platform/os/index.js 194 门面 >150，非本批）。
- `layering-and-dependency-gate`：**10 / 0**。
- `domain-structure-gate`（report-only）：**55 passed / 0 hard**，9 soft 与基线同（contract.js 未建等，非本批）。

### 5.4 两处环境性/他域 RED（**非本批**，如实报告）
1. **`smoke.js` 33/1 或 31/3（端口冲突）**：实测运行时刻**另有并发代理在跑 smoke**，
   抢用固定端口 3900/3901/3910（`ps`/端口快照见工作记录）。隔离探针（在真实 `Supervisor` 上
   `_mSetBackoffLevel(2)` → 读回 2 → `statusSummary().backoffLevel=2`；`_bumpCrashWindow()` → 目录 `backoffLevel=3`、
   `phase=BACKOFF`）证明 state 路径**无回归**。单独运行若端口空闲应为 34/0（与 R3-E 交接一致：
   「与其他测试同批次连续运行时偶发 FAIL，单跑 34/0」）。
2. `srcpath-gate`/`round13-robustness-batch` 的失败根因分别是 R3-F 的 DF-8 上提与并发代理的 registry→heartbeat 搬迁；
   本批已同步改指向，现均为绿。

## 6. 遗留与后续（诚实标注）

1. **其余 6 个切面仍为薄委托**：`ctl / daemons / main / views / audit / ui`（`THIN_SPEC`）。
   它们的方法仍是 `host` 上的 `{ methods }` 实现，协作方只是转发。后续批按 state/session/control 同一手法逐个工厂化即可，
   `installCollaborators` 的结构已为其预留。
2. **state 的少数宿主瞬态字段仍由 host 持有**且经 deps 注入读写：`_crashHalted`、`manualRestart`、`_upgradeHold`、
   `_upgradeHoldSince`。理由：`main/controller`、`main/decide`、`facade/status` 直接读写它们，属**跨切面瞬态**，
   强行迁入 state 会制造新的反向边；待 main 切面工厂化时一并收编。
3. **`state/fields` 的 46 helper 未逐一改为 `state.xxx()`**：38 个 `_mXxx/_mSetXxx` 仍是 host 薄壳（生成式），
   与公开面/测试兼容；真正单源已是 `state.field/procField`。
4. **`assembly/collaborators.js` 201 行**：DF-2 严值（≤300）满足；若后续继续收敛薄委托，建议按切面拆文件。
5. **api 42 成员 / 测试 ~50 调用点**：未逐个改（宿主兼容壳使其无需改）；这正是级 2 选择
   「host 留兼容外壳」而非「删旧名」的原因。

## 7. 涉及文件清单

**新增（源码）**：`src/app/state/collaborator.js`、`src/app/control/collaborator.js`
**改写（源码）**：`src/app/state/{main-record,main-store,fields,store,desired,upgrade-hold}.js`、
`src/app/session/machine.js`、`src/app/control/{projection,specs}.js`、
`src/app/assembly/collaborators.js`、`src/app/assembly/facets.js`
**新增（测试）**：`test/app-ctor-injection-test.js`
**修改（测试/清单）**：`test/round13-router-relay-gaps-test.js`、`test/adopt-token-reclaim-test.js`、
`test/srcpath-gate-test.js`、`test/round13-robustness-batch-test.js`、`package.json`(scripts.test 链)
