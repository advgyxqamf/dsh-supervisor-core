# EXEC-instance —— instance 域结构改造执行记录

> 范围：`src/domains/instance/**`（4 文件 → 8 文件）+ instance 相关测试。
> 依据：`EXECUTION-CONTRACT.md`、`DOMAIN-STRUCTURE-DESIGN.md §5.3/§8`、`design-notes/instance.md`（E 节消解表）。
> 约束遵守：不启动任何守卫/daemon；不碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；不 git commit。

## §1 结果概览

目标结构（SSOT §5.3）全部落地，行数均在目标内（DF-2 ≤400）：

| 文件 | 目标 | 实际 | 角色 |
|---|---|---|---|
| `index.js` | ≤95 | **91** | 门面 + 组装根（组合/委托，无业务逻辑） |
| `model.js` | ≤140 | **96** | 纯：记录形状/迁移 + 视图行 + 任务词表 |
| `sandbox.js` | ≤85 | **81** | 纯：路径/命令/env/systemd 属性 + 能力判决 |
| `state-machine.js` | ≤85 | **80** | 纯：4 个相位转移（deps 显式入参） |
| `store.js` | ≤100 | **99** | IO：原子读写 + 端口投影 + ensureDirs（持有活数组） |
| `lifecycle.js` | ≤185 | **183** | IO：单元前置/清理 + 启停 + 探测 + 监督拍 |
| `ops.js` | ≤180 | **130** | 编排：CRUD + 兜底定时 + 钩子外发 |
| `upgrade.js` | ≤330 | **327** | 编排：安装/版本/升级 + 作业视图 |

- **DF-1**：`index.js` 91 行（≤150）✅
- **DF-2**：最大文件 `upgrade.js` 327 行（≤400）✅
- **DF-3**：纯（model/sandbox/state-machine）与 IO（store/lifecycle）物理分离 ✅
- **DF-4**：**零跨文件 `this`**——非门面模块全部为「工厂 + 闭包显式 deps」，源码内无 `this`；仅 `store.js` 是 class（§3.1 明示允许），其 `this.X()` 全部指向**同文件**方法 ✅
- **DF-5**：域内 require 图 8 节点、13 边、**8 个单点 SCC（无环）** ✅；已删除 `Object.assign(InstanceManager.prototype, …)`
- **DF-6**：`model/sandbox/state-machine` 零依赖可 require；`store/lifecycle/ops/upgrade` 经工厂注入假 deps 即可单测（instance-state-test 已改为直接 require `state-machine`）✅
- **DF-7**：依赖单向 `index → ops/upgrade → lifecycle → store → model/sandbox/state-machine` ✅

## §2 逐文件职责迁移（旧 → 新，含行区间来源）

| 旧 `core.js`（397） | 新家园 |
|---|---|
| 构造 + 22 字段 | `index.js` 构造 + ctx（6 个回调改为 `_hooks` 活对象 + getter/setter 委托） |
| `get sandboxSupported` / `_setSandboxSupportedForTest` | `sandbox.supported(override)`（纯判决）+ index getter 委托 |
| `load/save/_syncInstancePorts` | `store.js`（load 内迁移调用 `model.normalizeInstance`，令牌源登记留 store） |
| `sandboxRoot/sandboxDataDir/sandboxInstallDir` | `sandbox.root/dataDir/installDir(rootDir, inst)` |
| `_sandboxCommand/_defaultCommand/effectiveCommand` | `sandbox.sandboxCommand/defaultCommand/effectiveCommand` |
| `_ensureSandboxDirs` | `store.ensureDirs(inst)` |
| `updateInstance` | `ops.updateInstance` |
| `list()` 视图拼装 | `model.viewRow`（纯）+ `ops.list`（IO 取值）+ `upgrade.versionInfo/jobView` |
| `_probeState/probeInstance` | `lifecycle.probe/probeInstance` |
| `_startLanForInstance/_stopLanForInstance` | `lifecycle._systemdStart/stop` 内 `hooks.onInstanceStart/Stop` |
| `_setRunning/_setStopped/_failInstance/_restartInstance` | `state-machine.js` 四函数（`deps={events,logger,save,tokens}`） |
| `_timer`（遗留在构造） | `ops` 闭包变量 `timer`（职责归位） |
| `_updCache/_updJobs/_updTTL/_latestDshVer(At)`（遗留在构造） | `upgrade` 闭包状态（职责归位） |

| 旧 `ops.js`（449） | 新家园 |
|---|---|
| `_prepareSystemd/_cleanStaleUnit/_systemdStart/startInstance/stopInstance/supervise` | `lifecycle.js` |
| `addInstance/removeInstance/updateInstance/startTimer` | `ops.js` |
| `_readInstalledVersion/_taskStateToView`（错位） | `upgrade.readInstalledVersion` / `model.taskStateToView` |

| 旧 `upgrade.js`（407） | 新家园 |
|---|---|
| `_installSandbox/_readInstalledVersion/_latestDshVersion/checkUpdate/upgradeInstance/_scheduleJobCleanup/upgradeStatus` | `upgrade.js`（工厂化，命名去下划线；新增 `versionInfo/jobView` 供视图复用） |
| `_taskStateToView` | `model.taskStateToView` |

## §3 46 处跨文件 `this` 的消解（手法映射）

- **ops → upgrade 反向边**（`this._installSandbox`）→ `deps.install(inst)` **注入**；
  index 组装期 `ctx.install = (inst) => upgrade.installSandbox(inst)`，lifecycle **不 require upgrade** → 不成环。
- **core → upgrade 两条反向边**：
  1. `_readInstalledVersion`（视图越层读盘）→ 视图行拆为纯 `model.viewRow`，version 由 `ops.list` 经注入的 `upgrade.versionInfo` 提供；
  2. `_taskStateToView`（纯映射住在 upgrade）→ 下沉 `model.taskStateToView`，ops/upgrade 两侧共用。
  → `core → upgrade` 边**彻底消失**。
- **save（28 处）** → 注入的 `store.save()`（B）。
- **sandbox 路径/命令（A/C）** → 纯 `sandbox.*`。
- **状态转移（C）** → `stateMachine.*(deps, inst, …)`。
- **探测** → `lifecycle.probe`。
- **LAN 回调（B）** → `hooks.onInstanceStart/Stop`。

## §4 活数组身份（R-1）

`store` 为 `instances` 数组**唯一持有者**：

- `index.get instances()` **每次返回** `store.instances`（同一数组对象）；
- `index.set instances(list)` → `store.replace(list)`，**原地改写**（`length=0` + `push`），绝不换对象；
  自赋值（`list === this.instances`）直接短路，防清空丢数据。
- 替代了旧 `ops removeInstance` 的 `this.instances = this.instances.filter(…)` 整体替换；
  `app/state/store.js:117` 的 `splice` 与 20+ 处直读保持同一引用。

## §5 迁移硬前置（先改测试）

1. `test/instance-upgrade-test.js` R1 段：原 `mgr._prepareSystemd/_systemdStart/_ensureSandboxDirs = () => {}`
   **实例 owner 打补丁**——拆分后这些成为组装根闭包委托，补丁不再拦截内部调用 →
   会真跑 `systemctl --user daemon-reload` 与真 mkdir。
   已改为 **构造期注入假 service provider**（`startTransient` 计数）+ `systemdDir` 指向临时目录。
2. `test/instance-systemd-aside-behavior-test.js`：`mgr.systemdDir/systemdTemplatePath/events` 后置赋值
   在 ctx 快照下**落回真实 `~/.config/systemd/user`**——改为构造期注入（行为级断言不变）。
3. `test/round13-discipline-gaps-test.js` ②/②-b：`mgr.tasks = …` 后置赋值不再生效 → 改为构造期注入
   `tasks`/假 `service`（该文件另由他人同步修订，最终一致）。
4. `test/instance-state-test.js`：改为直接 require `state-machine.js` + 假 deps（DF-6 示范）。

## §6 门禁同步改指向（§8 静默失效面）

| 文件 | 改动 |
|---|---|
| `test/cross-platform-test.js:80/165` | 硬编码 `['index.js','core.js','ops.js','upgrade.js']` → `readdirSync` 聚合全目录（否则 core.js 删除后 ENOENT，且新文件丢覆盖面） |
| `test/instance-safety-test.js` L-d | `delete this._updCache[id]` → `delete _updCache[id]`；裸定时器反向判据同步 |
| `test/instance-safety-test.js` L-f | 函数体正则 → 形态无关结构判据（由并行的门禁修订同步落地，与本改造一致） |
| `test/instance-safety-test.js` L-e/L-g/L-h | 不变即通过（getter 纪律、isTaken 顺序、dataPreserved 均保持原形态） |

## §7 与设计的偏差

1. **`list()` 归属**：设计 E.3 的示意把 `list()` 放在 index；实际放在 `ops.list`（编排），
   经注入的 `upgrade.versionInfo/jobView` 取版本/作业视图。理由：index 须 ≤95 行且「无业务逻辑」；
   ops→upgrade 为**值注入**（非 require 边），不引入环。
2. **`store.js` 用 class**：§3.1 明示允许（ctor 注入）。其余模块用「工厂 + 闭包显式 deps」，源码零 `this`。
3. **`model.normalizeInstance` 只做纯迁移**：令牌源登记（`tokens.attach`，IO）留在 `store.load`。
4. **`_prepareSystemd` 暴露名保留**（index 委托 `lifecycle._prepareSystemd`）：兼容行为级测试入口；
   内部命令装配已下沉 `sandbox.js`。
5. **`lifecycle`/`upgrade` 注释压缩**：为满足 SSOT 目标行数，空行被移除、长注释精简；逻辑零改动。

## §8 遗留（下一轮）

- **DG-10 端口化**：`plugin/relay` 仍经注入直读 `instances.instances` 数组与 `probeInstance/stopInstance/startInstance`
  （本轮按 EXECUTION-CONTRACT §3.3 **冻结签名与语义**，不改调用点）。
- **ports 探测未注入**：`store.js`/`ops.js` 仍直接 require `platform/service/ports` 单例（设计 §G.2 明确不做）。
- **README.md 域职责/依赖图**（设计 F 步 10）：留给文档轮次；本域依赖图见本文件 §1/§2。
- **门禁状态**：收口时 `layering-and-dependency-gate-test.js` = 10 passed / 0 failed（`root -> app
  [src/app/domain-actions]` 登记由 app/facade 域补上）；`directory-structure-gate-test.js` = 16 passed / 0 hard failed
  （3 项 report-only 落在 app/platform 文件，**非 instance 域**）。基线未退化。
- **`platform/os/index.js:36` 注释仍写 `domains/instance/core.js`**（纯说明文字，非引用）——属 platform 域文件，
  本轮不改，留待文档清理。
