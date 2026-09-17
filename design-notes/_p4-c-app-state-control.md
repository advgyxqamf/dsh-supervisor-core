# P4-C-3 报告（app/state + app/control + assembly/bootstrap.js）

> 范围：`src/app/state/**`(10) + `src/app/control/**`(11) + `src/app/assembly/bootstrap.js`。
> 积压项：#25 #26 #28 #29。遵守 `_workorder-phase4.md` §0/§1 与 `_p4-c-shards.md`。
> 未跑测试/门禁、未 require 产品模块、未做内存冒烟、无 git 写、未改 `test/`。

## 0. 结论摘要

改动 **3 个文件、共删 6 行 + 2 个 JSDoc 块**（均为纯删除，无新增逻辑）：

| # | 文件 | 改动 |
|---|---|---|
| 25 | `src/app/state/intents.js` | 删 `has()`、`any()` 两方法及其 JSDoc |
| 26 | `src/app/control/registry.js` | 删只写不读的 `this._loaded` 与两处赋值 |
| 28 | `src/app/assembly/bootstrap.js` | 只删 :11 的 `registerAll` require 行 |
| 29 | — | **0 个导出键可删**（2 个候选经四类核验后判定保留，见 §4） |

**行为零变更**：三处均为死代码删除（不可达/无消费者），无状态码、返回、事件、日志、持久化形状变化。

## 1. #25 `state/intents.js`：删 `has()`/`any()`

### R2 可达性核验（关键：`has`/`any` 是泛型名，raw grep 会误报）
`IntentLedger` 全仓唯一实例化点是 `assembly/compose/core.js:73`（`host.intents = new IntentLedger()`），
唯一取用入口是 `getIntents()`（`assembly/collaborators.js:85`）。故只须核验**这些访问路径上的方法调用**：

| 访问路径 | 实测调用 | 结论 |
|---|---|---|
| `sup.intents.*`（`test/session-lifecycle-test.js`） | `register` ×3、`clear` ×3 | 无 has/any |
| `this.intents.*`（`src/app/main/controller.js:136`） | `consume` ×3 | 无 has/any |
| `intents()`/`it.`（`state/desired.js:24,50`、`state/upgrade-hold.js:67`） | `register` | 无 has/any |

`grep -rnE '(sup|host|this|s2)\.intents\.(has|any)|intents\(\)\.(has|any)|\bit\.(has|any)' src test bin ui`
→ **零命中**（含 test/、bin/、ui/）。亦无解构形态（`const { has } = ...intents`）。

⚠ `release/scripts/export-consumers.sh has` 报「97 处消费者」、`any` 报「1 处消费者」，**均为泛型名误报**：
`any` 的命中是 `plugin/ops.js:96` 正则里的 `any kind`；`has` 的命中是 `Map.has`/`Set.has`。
`design-notes/app-orchestration.md:740` 已记载该已知问题（「泛型名会与 Map/registry 自匹配」）。
**本例正是「按可达性核验、不按 raw grep 判定」的样本。**

### R1 注释钉子反查（CJK `grep -oP '\p{Han}{4,}'` + ASCII ≥6）
被删注释的两行文本切出的 ≥4 字 CJK token 与命中：

| token | test/ 命中 | 判定 |
|---|---|---|
| `非破坏性` | `destructive-op-safety-test.js:17` | **非钉子** —— 该处是测试自身注释（「注入验证本身要选\*\*非破坏性\*\*的注入点」），不是对 intents.js 的断言 |
| `收敛循环决策` | 0 | — |
| `显式动作穿透` | 0 | — |

ASCII ≥6 token：无。另 `grep -rn 'state/intents\|IntentLedger' test/` → **零命中**（无门禁/断言引用本文件）。

### 保留项（未动）
`register/consume/clear/_pending` 均有消费者（见上表 `register`/`consume`/`clear`），按要求保留。
`INTENTS` 常量与 `module.exports` 中的 `IntentLedger`、`INTENTS` 键见 §4。

## 2. #26 `control/registry.js`：删只写不读的 `_loaded`

`grep -rnE '_loaded\b' src test` 结果（精确词边界，不会误匹配 `_loadedFromDisk`）：

| 位置 | 形态 |
|---|---|
| `registry.js:49` | `this._loaded = false;`（写） |
| `registry.js:88` | `this._loaded = true;`（写） |
| `platform/service/token/pool.js:38,132,158,168,256,257` | **另一个类的** `_loaded`（有读有写，属 P4-C-2 分区，未动） |

⇒ `registry.js` 的 `_loaded` **全文件零读取**，删除两处赋值后无悬挂引用（`node --check` 通过）。

### 未误删、未回退（重点自证）
- `_loadedFromDisk` **完好**：`registry.js:53`（声明）、`:55`（赋值）；读取点在 `state/store.js:48`
  与 `test/app-ctor-injection-test.js:34`。二者是**不同字段**，原件注释已明确（`:50-53` 解释其语义），未触碰。
- **P3-A 的 ownership 合并未回退**：`registry.js:191` 仍是
  `e.ownership = normalizeOwnership(Object.assign({}, e.ownership, p.ownership));`，且 `old` 端口捕获
  仍在合并前（`:189`），释放逻辑不变。
- 文件头 `registry.js:21` 的「公开导出面不变（本文件 re-export …）」注释未动。

## 3. #28 `assembly/bootstrap.js`：只删 `registerAll` require 行

- `grep -n 'registerAll' src/app/assembly/bootstrap.js` → **仅 :11 一处**（正是被删行）。
- 真正的调用在 `assembly/compose/observers.js:8`（require）+ `:41`（调用）—— 已核验仍完好：
  `observers.js:41 registerAll(host.lifecycleManager, {...})`。
- `control/adapters.js:155` 的 `module.exports = { registerAll }` **保留**（仍有消费者，
  且 `test/session-lifecycle-test.js:204`、`test/lifecycle-mirror-test.js:21` 按路径 require 它）。

### 心跳结构钉子逐条在位（R1，**一行未动**）
`test/heartbeat-selfheal-test.js` 的 6 条硬断言，改后逐条复核：

| 钉子 | 位置 |
|---|---|
| `_heartbeatBusy = false;` | :63、:75（guard 与 .finally 两处，均带代际判断） |
| `iv * 12` 与 `stallMs` | :62 `Math.max(30000, iv * 12, objCount * 6 * iv + iv)` |
| `_heartbeatStalls++` | :66 |
| `强制释放防停摆` | :68（logger.warn 文案） |
| `guard && typeof guard.unref === 'function'` | :72 |
| `clearTimeout(guard)` | :76 |

## 4. #29 零消费者导出普查（重新枚举当前树，未照抄旧 63 条清单）

对 `src/app/state/**` + `src/app/control/**` + `bootstrap.js` 的**全部 `module.exports` 键**（40 个）
逐一核验：EX 工具 + 全仓 grep + `test/` 字符串/正则引用 + 契约登记表 + 根级/design-notes 契约声明 +
注入对。
**消费者数为 0 的候选仅 2 个，经四类核验后均判定保留；可删导出键 = 0。**

| 候选 | 文件:行 | 代码消费者 | test/ | 契约登记 | docs 声明 | 判定与理由 |
|---|---|---|---|---|---|---|
| `INTENTS` | `state/intents.js:39` | 0（`compose/core.js:18` 只解构 `IntentLedger`） | 0 | 未登记 | `_r5-app-api-P4.md:53` 列为 state 导出面 | **保留**：① 它是意图词表的唯一出口，`register()` 对未知 intent 抛错，导出词表有 API 意义；② 删除收益为零（7 字符）；③ 保守原则「宁可保留」。**登记文档漂移**：该 notes 声称 INTENTS「被 state/collaborator.js、assembly/collaborators.js、compose/core.js 引用」，实测 **不成立** |
| `withTimeout` | `control/heartbeat.js:106` | 0（内部 :82 使用 → **函数体保留**） | 0 | 未登记 | `FIX-4.md:48` **明确记载「对外导出面不变：heartbeat.js 仍导出 { runHeartbeat, withTimeout, ADAPTER_TIMEOUT_TICKS }」** | **保留**：删除将**违反 FIX-4 记录的导出面不变量**（属「docs 声明为对外契约」类）。`AUDIT-r5-dead-code-census.md:148` 亦记「内部使用」 |

### 其余导出键均有真实消费者（抽样证据）
- `createStateStore / createDesired / createFields / createMainRecord / createMainStore / createUpgradeHold`
  → `state/collaborator.js` 逐对「import + 调用」（如 `:7`+`:18`、`:9`+`:20`、`:8`+`:19`、`:11`+`:34`、`:12`+`:23`）。
- `createProjection / createSpecs / createControlPlane` → `control/collaborator.js:7/8/12/17`。
- `ManagedLifecycle / LifecycleManager / ManagedRegistry / registerAll` → 域装配与 2 个 test 按路径 require。
- `bootstrap.js` 的 `_bootstrap/_startShellWatchdog/_registerFixedPorts/_bindNativeDshCommand`
  → `compose/domains.js:42`、`facets.js:83`、`supervisor.js` 装配 + `native-dsh-binding-test.js` 断言。

### re-export 面的特别核验（`registry.js:285`）
`registry.js` re-export `{ ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership }`。
**关键事实：全仓无任何文件直接 require `control/managed-object.js`** —— 纯模型只经 `registry.js` 的 re-export 消费。
且 `registry.js:21` 明文记载「公开导出面不变」。实测消费者：

| 键 | 消费者（按 import 源） |
|---|---|
| `ManagedRegistry` | `compose/domains.js:15` |
| `PHASES` | `control/entry.js:20`；`test/managed-registry-test.js:12` |
| `DESIRED`、`MANAGED_KINDS` | `test/managed-registry-test.js:12`（:49/:47 断言） |
| `kindMeta` | `control/adapters.js:8`（`:14` capsOf） |
| `createEntry` | `test/guard-domain-model-gate-test.js:186`（:187/:191 断言） |
| `normalizeOwnership` | `registry.js:191` 内部使用；导出键由 `:21` 不变量保护 |

⇒ re-export 键**全部保留**（删任一都会破坏 test 或已记载的导出面不变量）。

## 5. R1/R2 汇总与 CI 风险

- **R1**：本批删除的注释 token 已按 CJK(`\p{Han}{4,}`) + ASCII(≥6) 双阈值回扫 `test/`；
  唯一命中 `非破坏性` 经逐行核实为测试自身注释，非源码断言。6 条心跳钉子逐条在位（§3）。
- **R2**：无导出键删除（#29 结论 0）；无函数体删除（`withTimeout` 函数体保留）；
  无悬挂引用（`_loaded` 删除后 `node --check` 通过；`registerAll` 删除后调用点在 observers.js）。
- **`node --check`**：`state/intents.js`、`control/registry.js`、`assembly/bootstrap.js` **3/3 通过**。
- **CI 风险：低**。全部为死代码删除；无 test/ 断言引用 `intents.js`、`_loaded`、`bootstrap.js:11`。
  `heartbeat-selfheal-test.js`（链上第 8 个文件，会最早暴露心跳破坏）的 6 条钉子已逐条自证仍在位。

## 6. 交付与遗留

- 改动文件：`src/app/state/intents.js`、`src/app/control/registry.js`、`src/app/assembly/bootstrap.js`（待主控提交）。
- **需主控处理的文档漂移（不在我文件范围）**：
  1. `design-notes/_r5-app-api-P4.md:53` 对 `INTENTS` 消费者声称不成立（§4 候选表）。
  2. `design-notes/AUDIT-r5-dead-code-census.md:148` 记 `withTimeout` 为「内部使用」属实，但未记其导出面不变量（`FIX-4.md:48`）。
- **跨分片依赖提醒**：`control/adapters.js` 的 `registerAll` 导出**必须保留** —— 除 `observers.js:41`
  的生产调用外，`test/session-lifecycle-test.js:204` 与 `test/lifecycle-mirror-test.js:21` 按路径 require 它；
  任何「删未用导出」的后续动作都不得触及它。
