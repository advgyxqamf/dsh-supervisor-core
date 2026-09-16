# EXEC3-app-root-downpull —— 批 9 续：app 根部 4 个 >300 行文件下拉拆解

> 范围（R3-E 续）：`src/app/` 剩余 4 个 >300 行文件
>   `assembly/compose.js(376)`、`control/registry.js(355)`、`daemons/process.js(354)`、`main/process.js(311)`。
> 依据：`EXECUTION-CONTRACT.md` §1/§4/§5、`DOMAIN-STRUCTURE-DESIGN.md` §5.6 / §6、`design-notes/EXEC3-app-this-flattening.md`。
> 纪律：未启动任何守卫/daemon；未 commit；未碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`、已安装包；
>   `package.json` 未新增任何依赖（T6-a：内核零运行时依赖）。

## 1. 结果概览（拆后行数）

| 原文件 | 拆后 | 行数 | 职责 |
|---|---|---|---|
| `app/assembly/compose.js` 376 | `compose.js` | **28** | 门面：installFacets + 按序调三步（仅组合） |
| | `compose/core.js` | 181 | 宿主字段/数据目录保护/LogCore/令牌/分发/任务 |
| | `compose/domains.js` | 149 | 端口池 → 各域构造（router/instances/managed/plugin/lifecycle/native）→ 固定端口登记 |
| | `compose/observers.js` | 55 | 实例事件接线 + LifecycleManager 注册/视图同步 |
| `app/control/registry.js` 355 | `registry.js` | **280** | 目录 CRUD + 持久化 + 查询（纯模型已在 `managed-object.js`） |
| | `heartbeat.js` | 99 | 心跳/调度/单对象超时隔离（IO） |
| `app/daemons/process.js` 354 | `process.js` | **297** | DaemonLifecycle：spawn/停/杀/接管编排 |
| | `process-wait.js` | 47 | 等待原语（pid 消失轮询 / 端口 bind 探测，IO） |
| | `process-marks.js` | 49 | cmdline 标记派生（**纯**，无 IO） |
| `app/main/process.js` 311 | `process.js` | **253** | 进程启停编排（spawn/接管/重启/停止） |
| | `port-rederive.js` | 91 | 端口运行时再推导 + 注册表更正（独立切面） |

全部 ≤300（R3 严值 DF-2）；门面 `compose.js` 28 ≤150。

## 2. DF-1..DF-9 证据（自建同口径扫描）

- **DF-2 单文件 ≤300**：上表全部满足（最大 297）。
- **DF-3 纯/IO 分文件**：`process-marks.js`（纯派生）与 `process-wait.js`（net/pidlook IO）分离；
  `heartbeat.js`（调度/IO）与 `registry.js`（CRUD/持久化）、`managed-object.js`（纯模型）三层分离；
  `port-rederive.js` 独立承载端口 IO。
- **DF-4 零跨文件 this**：自建扫描（复刻 `domain-structure-gate-test.js` 的 `strip` + `definedNames`
  + `thisCallNames` 口径，扫 `src/app/**`）结果 **0 边**。
  手法：拆出的都是**自由函数**（`deriveCmdMarks`/`waitProcessExit`/`runHeartbeat(registry,…)`/
  `findManagedDshPort(config)`/`applyMainPort(host,…)`）+ compose 三步均为 `(host, …)` 显式入参；
  `{ methods }` 兼容外壳仍在原切面文件（`port-rederive.js`）内，内部自调用同文件。
- **DF-5 DAG / 禁方法集合并**：require 图单向无环
  （`compose.js → {core,domains,observers}`；`registry → heartbeat`；`process → {wait,marks}`；
  `main/process → port-rederive`），无 `Object.assign(X.prototype, …)`。
- **DF-6 可独立 require**：`process-wait/process-marks/heartbeat/managed-object/port-rederive` 与
  `compose/{core,domains,observers}` 均单独 `require()` 通过（不构造 Supervisor）。
- **DF-7 依赖单向**：无反向 require（拆出模块不回 require 宿主文件）。
- **DF-8 顶层 require**：全仓扫描内联 require = **0**（`src/supervisor.js` 的 `get lan()` 为既定唯一豁免）。
- **DF-9 嵌套 ≤6**：全仓 >6 = **0**。

## 3. 冻结面与兼容

- **公共面逐字不变**：`composeSystem` 导出不变；`DaemonLifecycle` 全部方法名/语义不变；
  `ManagedRegistry` 公开方法（含 `heartbeat`、`_releasePort`）不变；`_findManagedDshPort`/`_applyMainPort`
  仍以同名 host 成员安装（改由 `main/port-rederive` 切面提供），协作方接口表 `THIN_SPEC.main` 无需改。
- **`assembly/collaborators.js` 未被破坏**：只新增了一个切面 `main/port-rederive`（`facets.js` 的 FACETS），
  协作方装配序（40 切面装毕 → installCollaborators）不变。
- **`package.json` dependencies 未新增**。

## 4. 同步改指向的源码内容门禁（仅指向，行为断言不动）

| 测试 | 改动 |
|---|---|
| `test/native-dsh-binding-test.js` | 「绑定 → InstanceManager」调用序改读 `app/assembly/compose/domains.js` |
| `test/guard-domain-model-gate-test.js` | `registerAdapter('lan-daemon' → _daemonSuperviseOnce('lan'))` 改读 `app/assembly/compose/domains.js` |

`test/session-lifecycle-test.js`（读 `daemons/process.js` 的 `/dsh-supervisor/` 禁串）、
`test/round8-fixes-test.js`（读 `daemons/process.js` 的 `_spawn`/`stop`/`_cmdMarks`）、
`test/probe-gate-and-ownership-test.js`（读 `registry.js` 的 `_releasePort`）、
`test/phase-vocabulary-test.js`（`^const PHASES = [` 唯一源在 `registry.js`）**均无需改**：
被拆走的部分未触及这些断言所锚定的方法/字面量，实跑全绿。

## 5. 验证（本轮实跑）

必跑全部 EXIT:0：
`smoke` / `session-lifecycle` / `lifecycle-mirror` / `heartbeat-selfheal` / `managed-registry` /
`daemon-path` / `probe-gate-and-ownership` / `api-surface` / `api-contract` / `core-test`。

三结构门禁（不退化）：
- `directory-structure-gate`：16 passed / 0 hard（1 soft DS-9 既有：api/index.js、platform/os/index.js）。
- `layering-and-dependency-gate`：10 passed / 0。
- `domain-structure-gate`：**55 passed / 0 hard**（9 项 report-only RED 均既有、非本轮引入）。

附加：`round8-fixes` 0 / `phase-vocabulary` 0 / `guard-domain-model-gate` 20/0 /
`native-dsh-binding` 12/0 / `main-port-rederive` 6/0 / `precheck` 0 /
`token-contract-gate` 0 / `loghub` 0 /
`test-chain-completeness` 10/0 / `all-platforms` 34/0（T6-a 零运行时依赖 PASS）/
`test-safety-gate` 5/0 / `standards-uniqueness` 8/0。

每个新/改文件：`node --check` + `require()` 加载通过。

## 6. 并发环境下的遗留（★ 非本轮引入，如实上报）

- `adopt-token-reclaim-test` 场景 D 失败（26/1）：该场景用 `sup._mGuardian = () => true` 覆盖守护开关，
  但**级 2 真 ctor 注入**（另一子代理正在落地的 `state/collaborator.createStateStore` +
  `assembly/collaborators.installState`）已把 `controller.js` 的 `this.state.guardian()` 指向工厂内部实现，
  不再读 host 上的 `_mGuardian` 外壳，故测试的覆盖手段失效。
  证据：运行日志 `shadow=restart:adopted_exit actual=none:unclassified`；本轮的 4 个文件未触及
  `guardian`/`_dshConverge`/`_beginRestart` 决策，判定为**并发重构的测试同步遗留**，应由级 2 ctor 注入
  的负责方把该测试改为覆盖 `sup.state`（而非 `sup._mGuardian`）。本代理未越界改。
- **smoke 在 04:45 后转红（并发时序证据）**：本代理 04:40 的必跑批次 smoke EXIT:0；另一子代理 04:45:47 连续改写了 `app/assembly/bootstrap.js`、`app/session/shutdown.js`、`app/daemons/runtime.js`、`app/control/instance-adapter.js`、`app/facade/main.js`、`app/audit/orphan-scan.js`（04:46:55 再改 `app/state/collaborator.js`）之后，smoke 在 SIGCONT/stop/start 段级联失败（`Cannot read properties of null (reading 'restartCount')`）。这些文件均不在本代理范围，且本轮的 4 个文件未触及 SIGCONT/启停/退避路径；判定为并发重构集成态所致，待其落地收敛后复跑。
- 本轮期间观察到另一子代理在写 `state/fields.js`、`session/machine.js`、`state/store.js`、
  `control/projection.js`、`facets.js`、`collaborators.js`；本代理仅在 `facets.js` 追加 1 行切面，
  且并发写入后仍保留（已复核）。

## 7. 涉及文件清单

**新增**: `src/app/assembly/compose/{core,domains,observers}.js`、`src/app/daemons/process-wait.js`、
`src/app/daemons/process-marks.js`、`src/app/control/heartbeat.js`、`src/app/main/port-rederive.js`。

**修改（源码）**: `src/app/assembly/compose.js`、`src/app/assembly/facets.js`、
`src/app/control/registry.js`、`src/app/daemons/process.js`、`src/app/main/process.js`。

**修改（测试指向）**: `test/native-dsh-binding-test.js`、`test/guard-domain-model-gate-test.js`。
