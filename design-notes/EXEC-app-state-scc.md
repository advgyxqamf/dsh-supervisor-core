# EXEC · app 状态层 + this 调用图 SCC 消解（SCC①②）

> 执行者：app 状态层子代理（session-18b2006a-2d94-4d81-971b-60fe6e95b0b1）
> 日期：2026-09-17
> 依据：`EXECUTION-CONTRACT.md` §1–§6、`DOMAIN-STRUCTURE-DESIGN.md` §5.6/§9、`design-notes/app-orchestration.md` §A.2b/§B.3/§C/§E/§F
> 范围：`src/app/state/**`、`src/app/control/specs.js`、`src/app/main/{process.js,health-gate.js}`（+ 按任务书第 3/4 条所需的 `main/controller.js` 单点、`control/registry.js` DF-2 切分）

---

## 0. 结论（一句话）

app 的 4 个 `this` 调用图 SCC 中，**①②（本子代理范围）已消解**：基线复现的
`{store,fields,specs}` 与 `{process,health-gate}` 两个 SCC 在改造后不再出现；
`control/registry.js` 443 → **355 行**（DF-2 达标）；
本范围全部相关测试通过，两个既有结构门禁（directory / layering）全绿。

---

## 1. 基线（改造前，可复现）

用**去注释 + 方法定义归属 + `this.X()` 调用点**重建 app 域文件级 this 图（Tarjan），
实测 **4 个 SCC**，与 `app-orchestration.md §A.2b` **逐字一致**：

| SCC | 文件 | 环上的边（实测方法） |
|---|---|---|
| ① | state/store ↔ state/fields ↔ control/specs | store→fields(`_mSet*`)，store→specs(`_dshEntry/_mainFallbackEntry/_persistCrashField`)，fields→store(`_mStore/_mField/_mProcField`)，fields→specs(`_dshEntry`)，specs→fields(`_mDesired`) |
| ② | main/process ↔ main/health-gate | process→health-gate(`_bumpCrashWindow`)，health-gate→process(`_beginRestart`) |
| ③ | daemons/runtime ↔ facade/main | F1 范围 |
| ④ | facade/router ↔ ctl/facades | F1 范围 |

---

## 2. 改动清单（物理结构）

### 2.1 新增文件

| 文件 | 行 | 职责 | 来源 | 纯? |
|---|--:|---|---|---|
| `src/app/state/main-record.js` | 89 | **存储内部口**：entry 解析 + fallback + 崩溃字段落盘 + entry/process 字段读写 | `control/specs.js:132-160`（3 方法）+ `state/store.js:18-47`（3 原语） | 否（经 host 注入的存储） |
| `src/app/state/field-tables.js` | 39 | ENTRY_FIELDS / PROC_FIELDS 字段表 | `state/fields.js:38-64` | **是**（零 require） |
| `src/app/state/phase.js` | 24 | legacy↔canonical 相位纯映射 | `state/fields.js:127-141` | **是**（零 require） |
| `src/app/control/managed-object.js` | 116 | 受管目录**纯模型**：词表 + kindMeta + registerKind + createEntry + normalizeOwnership | `control/registry.js:22-122` | **是**（零 IO） |

### 2.2 修改文件

| 文件 | 前 → 后（行） | 改动 |
|---|---|---|
| `state/store.js` | 124 → 98 | 移除 `_mStore/_mField/_mProcField`（下沉 main-record）；`...recordMethods` 合并，`this._m*` 对外语义不变；保留 `writeState/loadState/_migrateMainRecord` |
| `control/specs.js` | 163 → 115 | 删除 `_dshEntry/_mainFallbackEntry/_persistCrashField`；只保留申报职责（kind 字面量不动，GD-1 判据仍可定位） |
| `state/fields.js` | 206 → 187 | ENTRY/PROC 字段表与相位映射**委托**新纯模块；46 个生成器 helper 与 9 个访问器**形态逐字未改**（仍经 `methods/accessors` 装配） |
| `main/health-gate.js` | 51 → 57 | `_applyHealthCheck` 改为**纯决策返回** `{restart,reason,countCrash}`；`_bumpCrashWindow` 保留（纯记账） |
| `main/controller.js` | 226 → 231 | 单点：消费 `_applyHealthCheck` 的返回并执行 `_beginRestart`（SCC②执行方；**任务书第 3 条指定的必要集成点**） |
| `control/registry.js` | 443 → 355 | 纯模型下沉 managed-object.js；**PHASES 仍定义在本文件**（K3-d 唯一源）；re-export `createEntry/kindMeta/...`，公开导出面逐字不变 |

> `state/` 由 6 文件 → **8 文件**（重切，不合并）：存储（main-record）、文件 IO（store）、
> 字段视图/读写（fields）、纯字段表（field-tables）、纯相位（phase）、意图（intents，保持健康）、
> 升级 hold（保留，已知错位见 §5）。

### 2.3 消解手法

- **①**：把「存储内部口」与「存储原语」物理归位到 `main-record.js`（依赖汇点，无出边），
  并由 `store.js` 合并其 `methods` 保持 `this._m*` / `this._dshEntry()` 可用。
  于是 fields 的存储调用指向 main-record（**不再指回 store**），store 也不再经 this 指回 specs
  → `{store,fields,specs}` 三节点的双向边全部断开。（手法 A/B：具名函数 + 显式依赖）
- **②**：`_applyHealthCheck` 只**返回决策**，由 `main/controller.js` 执行 `_beginRestart`；
  health-gate→process 反向边消失，仅余 `process→health-gate`（D7 保留方向）。

---

## 3. SCC 复现与验证

同一分析器，改造前 / 后：

```
改造前: SCCs (>1): 4
  {state/store.js, state/fields.js, control/specs.js}      ← ①
  {facade/main.js, daemons/runtime.js}                     ← ③（F1）
  {main/health-gate.js, main/process.js}                   ← ②
  {facade/router.js, ctl/facades.js}                       ← ④（F1）

改造后（本子代理收尾时的中间态）: SCCs (>1): 1
  {facade/router.js, ctl/facades.js}                       ← ④（F1 进行中）

最终态（与 F1 并发合并后复跑）: SCCs (>1): 0
```

> ③④ 属 F1 范围，已由 F1 并发消解；本子代理只负责 ①②（均在最终态中消失）。

**分析器口径**（与 `app-orchestration.md §A.2b` 同）：
1. 逐文件 `strip` 注释；
2. 定义集合 = 对象/类方法（`NAME(...) {`，剔关键字；`constructor` 等）+ `fields.js` 的
   46 个生成器 helper（`_m<Field>/_mSet<Field>`，运行时生成，静态登记）；
3. 边 A→B ⇔ A 含 `this.NAME(` 且 NAME 定义在 B（B≠A）；
4. 文件级 Tarjan SCC。

---

## 4. DF 逐条核对（本范围）

| 判据 | 结果 | 证据 |
|---|---|---|
| DF-1 门面 ≤150 | N/A（`state/` 无 index.js 门面；未新建） | — |
| DF-2 单文件 ≤400 | ✅ | 最大 registry 355；state 最大 fields 187；全部 ≤400 |
| DF-3 纯/副作用分离 | ✅ | 新增 field-tables/phase/managed-object 为零 IO 纯模块；fields/registry 委托之 |
| DF-4 零跨文件 this | ⚠ **部分** | 两个 SCC 的环边已断；但 app 仍以 `Object.assign(Supervisor.prototype, mod.methods)` 装配（`src/supervisor.js`，**非本子代理文件**），非环跨文件 this 调用仍存在 → 全域归零属**批 10（级 1 门面化/去 mixin）**，见 §5 |
| DF-5 域内 DAG（禁方法合并同 this） | ✅（SCC①②） | §3：`{store,fields,specs}`、`{process,health-gate}` 消失 |
| DF-6 叶子可独立 require | ✅ | `require('./main-record')` + 假 host 验证 `storeOf/fieldOf/procFieldOf`；`phase`/`field-tables`/`managed-object` 均零依赖可 require |
| DF-7 依赖单向 | ✅（本范围） | store→main-record / store→fields；fields→main-record；specs→fields/main-store；health-gate 出边 0（controller/process→health-gate） |

**DF-6 实测**（`node -e`）：
```
main-record.storeOf fallback id= main desired= running
fieldOf read= 7            procFieldOf read= true
phase STOPPED-> stopped / backoff-> BACKOFF / OBSERVED-> stopped
field-tables ENTRY=5 PROC=14      managed-object kinds=5 desired=["running","stopped"]
```

---

## 5. 偏差与遗留（如实）

1. **`state/fields.js` 未拆成设计 C.1 的 `main-state.js`**：任务书硬约束「46 个生成器 helper 与
   9 个访问器形态不得变（待 AP1 协调）」。故本次只把**纯数据/纯映射**下沉（field-tables/phase），
   fields.js 本体与装配形态保持。→ 设计 C.1 的 `main-state.js` 留待 AP1 对齐后另批。
2. **`main/controller.js` 改了 1 处调用点**：任务书第 3 条明确「由 main/controller.js 执行」，
   但文件归属清单未列 controller.js。已按任务书语义做**最小单点改动**（消费决策并 `_beginRestart`），
   未触及其它逻辑；请主代理知悉（若 controller 已划给 F3/F1，请复核该单点）。
3. **DF-4 全域归零未在本轮完成**：`src/supervisor.js` 的 `Object.assign(Supervisor.prototype, mod.methods)`
   是全域跨文件 this 的载体，属批 10；本任务书亦只要求 SCC①② 消解 + registry DF-2。
   `domain-structure-gate-test.js` DG-8 仍报 `supervisor.js x2`（report-only，已知待办）。
4. **SCC③④ 不在本范围**（F1 负责）；改造后 ④ 仍在。
5. **`state/upgrade-hold.js` 保留在 state/**：语义属升级生命周期（已知错位），
   设计 G「不做的部分」第 4 条已裁定暂留；未动。
6. **`control/specs.js` 仍有 `.instances.instances` 穿透**（`_syncManagedRegistry`）：
   `EXECUTION-CONTRACT §3.3` 本轮**冻结**该接口（DG-10 改端口属后续轮次），故未改。

**并发环境观察（非本子代理引入）**：
- `directory-structure-gate-test.js` 的 `ALLOWED`/DS-G6 现为 R2 白名单，运行期报
  `router/ops`（router 域并发重构产物）；R10/G0 负责该门禁与子目录白名单，本子代理未碰。
- `test-chain-completeness-test.js` 报 `domain-structure-gate-test.js` 未入链（批 0 产物），属他人。

---

## 6. 测试证据（本机实跑，2026-09-17）

| 测试 | 结果 |
|---|---|
| smoke.js | 34 passed, 0 failed |
| session-lifecycle-test.js | 41 passed, 0 failed |
| lifecycle-mirror-test.js | 11 passed, 0 failed |
| heartbeat-selfheal-test.js | 16 passed, 0 failed |
| phase-vocabulary-test.js | 8 passed, 0 failed |
| managed-registry-test.js | 44 passed, 0 failed |
| shadow-decision-test.js | 9 passed, 0 failed |
| guard-domain-model-gate-test.js | 20 passed, 0 failed |
| **directory-structure-gate-test.js** | **0 failed(hard)**（G0 并发改为 R2 白名单后：16 passed, 0 hard, 3 soft/report-only） |
| **layering-and-dependency-gate-test.js** | **10 passed, 0 failed** |
| domain-structure-gate-test.js（report-only，域范围） | 53 passed, 0 hard failed（软红项均非本范围：router 18 处、installer 806 行、contract 未建等） |

另：全部改动文件 `node --check` 通过；`require` 加载通过（含装配后 `smoke` 端到端拉起 DSH）。

---

## 7. 关键文件索引

- 新增：`src/app/state/main-record.js`、`src/app/state/field-tables.js`、`src/app/state/phase.js`、`src/app/control/managed-object.js`
- 修改：`src/app/state/store.js`、`src/app/state/fields.js`、`src/app/control/specs.js`、`src/app/control/registry.js`、`src/app/main/health-gate.js`、`src/app/main/controller.js`
