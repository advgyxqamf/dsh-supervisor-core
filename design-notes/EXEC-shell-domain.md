# EXEC · shell 域结构改造（域内分层归一化）

> 范围：`src/domains/shell/**` + shell 相关测试。
> 依据：`EXECUTION-CONTRACT.md`（冻结书 + 硬约束）、`DOMAIN-STRUCTURE-DESIGN.md` §5.5/§H、`design-notes/shell.md`。
> 结果：4 文件 → 5 文件；DF-1..DF-7 全满足；8 项必跑测试全绿；`shell-watchdog-test` 由 29/5 修正为 **34/0**。

## 1. 目标结构（实际落地）

```
src/domains/shell/
├── index.js     35  门面（**逐字不动**，导出面 10 键逐一保持）
├── core.js     136  **新增**：零 require 汇点（DEFAULTS/isShellProcess/decide/isUpdatePhase/exeFromCmdline/deriveState）
├── journal.js  138  账本 IO + 健康上报 + 汇总（evaluate 降为「读快照 → 委托 core → 按需落盘」）
├── restart.js  158  版本查询 + 壳重启（exeFromCmdline 迁出、依赖改指 core）
└── watchdog.js 228  有状态看护（纯决策迁出，仅剩 B12/B13/B14 共享 8 字段的状态机）
```

## 2. 实际改动（逐文件）

### 2.1 新增 `core.js`（零依赖纯核心 / 汇点）
| 成员 | 来源 | 说明 |
|---|---|---|
| `DEFAULTS` | 原 `watchdog.js` 模块常量 | 纯搬移，键序/取值逐字不变 |
| `isShellProcess` | 原 `watchdog.js:48-53` | 纯谓词（6 flag 排除表） |
| `decide` | 原 `watchdog.js:68-90` | 纯决策，穷举可测；零行为改动 |
| `exeFromCmdline` | 原 `restart.js:54-62` | 纯解析（Windows 引号路径） |
| `isUpdatePhase` | **新增提取** | 消除原 `watchdog.js:154/182` 两处逐字重复相位谓词 |
| `deriveState` | **新增提取** | `evaluate` 的纯内核，入参即 `(id, journal)` 两个快照 → 修 DF-6 |

- `core.js` 内 `require` 计数 = **0**；无 `fs.` / `spawn(` / `process.kill` / `setInterval` / `Date.now` / `Math.random`（注释亦回避上述字面量，防朴素 grep 假阳性）。
- `deriveState` **不修改入参**：确认分支返回新账本对象（`confirmed:true`），旧对象保持只读；落盘由调用方显式执行。

### 2.2 `restart.js` —— 删除反序边（T1/T5）
- 顶部新增 `const { exeFromCmdline, isShellProcess } = require('./core')`（**顶层**，core 零出度 → 无环）。
- **删除** `restart.js` 内 `const { isShellProcess } = require('./watchdog')`（原 :99，函数内 lazy，为避"循环"）→ `restart → watchdog` 边**物理消失**（下游流程不再依赖上游谓词）。
- 删除本地 `exeFromCmdline` 定义；`module.exports` 去掉该键（实测零消费者）。

### 2.3 `watchdog.js` —— 只有一刀：纯决策 ↔ 有状态看护（T2/T4）
- 顶部 `const { DEFAULTS, decide, isShellProcess, isUpdatePhase } = require('./core')`。
- 删除 `DEFAULTS` / `isShellProcess` / `decide` 定义；两处相位谓词替换为 `isUpdatePhase(phase)`。
- `module.exports = { createShellWatchdog }`（`decide/isShellProcess/DEFAULTS` 不再双导出）。
- **未继续切**：B12/B13/B14 共享同一组 8 个模块状态字段，切出即"经 ctor 传 8 字段"的文件搬家反例（设计 §G.2-1）。
- `deps.shell` 宽注入按 T6 **保持**（收窄会破既有测试夹具，无 DF 收益）。

### 2.4 `journal.js` —— evaluate 委托纯内核（T3）
```js
function evaluate() {
  const id = identity();
  const j = readJournal();
  const view = deriveState(id, j);                                   // 纯
  if (view.state === 'confirmed' && j.confirmed !== true) writeJournal(view.journal); // 显式 effect
  return view;
}
```
- 返回对象形状与旧实现**逐字一致**（idle/confirmed/pending 三分支的键集不变）。
- 强制更新、无回退语义逐字保留（`deriveState` 内无 `rollback/pinned/attempt`）。

### 2.5 `index.js`
**逐字未动**（任务令"门面逐字不动"）：仍 35 行，导出面 10 键原序原样，仅 require 两个实现文件。

### 2.6 测试同步（否则判据静默失效）
| 文件 | 改动 |
|---|---|
| `test/shell-watchdog-test.js` | `decide/isShellProcess/DEFAULTS` 改从 `core` 取；`createShellWatchdog` 仍从 `watchdog` 取 |
| `test/shell-watchdog-test.js` W4-a..e | **基线红灯修复**：由 `src/supervisor.js`（已无壳接线）改读真实接线点 `app/assembly/bootstrap.js` + `app/session/shutdown.js` |
| `test/watchdog-phase-freshness-test.js` | `DEFAULTS` 改从 `core.js` 取 |
| `test/platform-capability-audit-test.js` | A2/A7 读取集合**纳入 `core.js`**（按域聚合），否则"决策为纯函数/宽限期"判据假绿 |

## 3. 与原设计的偏差（如实记录）

1. **`index.js` 注释未修（设计 F4 未执行）**：任务令门面"逐字不动"，故 `:12-15` 仍指 `supervisor.js:28`（失真）。按设计 §L1 这属人审不合格项，**遗留待主代理裁决**；本轮不改以满足"逐字不动"与"5 文件"目标。
2. **未新增 `README.md`（设计 F4 未执行）**：任务目标结构明确为 **5 文件**（无 README），加 README 即变 6 文件，故从任务令。
3. **W4-c 读取面比设计 F0 更宽**：设计只说读 `bootstrap.js`，但 `clearInterval` 清理点在 `app/session/shutdown.js:32`（且宿主化后为 `host._shellWatchdogTimer`，原 `this.` 形态已不存在）。故 W4-c 同时读 `bootstrap.js`（启动装配）+ `shutdown.js`（关闭清理），才真实覆盖"随守卫启停"。
4. **`deriveState` 的 effect 形态**：设计只说"降为两行包装"，落地为"纯内核返回 view + `evaluate` 用 `state/confirmed` 判定落盘"，避免在纯函数返回值里塞 `persist` 泄漏键。语义逐字等价。
5. **`core.js` 136 行**（设计估 ~95）：差异来自文件头设计说明与各成员 jsdoc 的完整保留；代码行远低于阈值（≤400），且 ≤150 的"再拆触发条件"未触及。
6. **T7（一拍内 identity 单读）未做**：设计列为可选 F5 且属行为改动；本轮不做（tick 行为零变更）。
7. **未建 `scheduler.js`**：遵任务令与设计 §G.2-2（域内 `setInterval` = 0，定时器在 app 层；自建会造第二驱动源、破坏 `busy` 门闸与 `_reset`）。

## 4. 验证（全部离线，未启动任何守卫/daemon，未碰生产状态根）

### 4.1 必跑测试（全部通过）
```
node --require ./test/_preload.js test/shell-watchdog-test.js          → 34 passed, 0 failed   （基线 29/5，exit 1）
node --require ./test/_preload.js test/watchdog-phase-freshness-test.js → 11 passed, 0 failed
node --require ./test/_preload.js test/shell-safety-net-test.js         → 52 passed, 0 failed
node --require ./test/_preload.js test/shell-portability-test.js        →  7 passed, 0 failed
node --require ./test/_preload.js test/platform-capability-audit-test.js→ 66 passed, 0 failed
node --require ./test/_preload.js test/directory-structure-gate-test.js → 12 passed, 0 failed   （不退化）
node --require ./test/_preload.js test/layering-and-dependency-gate-test.js → 10 passed, 0 failed（不退化）
node --require ./test/_preload.js test/round8-fixes-test.js             → 59 passed, 0 failed   （按域聚合自动纳入 core.js）
```
⚠ `shell-watchdog-e2e-test.js` **未跑**（会真 spawn 假壳并起 Supervisor）—— 遵契约 §2。

### 4.2 傍近 src 全域门禁（回归确认，全绿）
`no-console-window-gate` 7/0、`cross-platform-architecture-gate` 11/0、`srcpath-gate` 11/0、
`platform-layer-portability` 61/0、`guard-domain-model-gate` 20/0、`probe-gate-and-ownership` 33/0。

### 4.3 DF-1..DF-7 自检（脚本实测）
| 判据 | 实测 |
|---|---|
| DF-1 门面 ≤150 且无 IO | `index.js` 35 行 ✅ |
| DF-2 单文件 ≤400 | 最大 `watchdog.js` 228 ✅ |
| DF-3 纯/IO 分离 | `core.js` require 计数 **0**、零禁用字面量 ✅ |
| DF-4 零隐式 this | 域内 `this.` = **0**；mixin 形态 = **0** ✅ |
| DF-5 DAG（禁方法合并） | 边集 `index→{journal,restart}`、`journal→core`、`restart→{journal,core}`、`watchdog→core`，**0 环** ✅ |
| DF-6 可独立单测 | `require('./core')` 后假快照直测：`deriveState({version:'0.2.0',phase:'ready'},{to:'0.2.0',confirmed:false}).state==='confirmed'`、`decide({alive:0,absentForMs:9999,sessionAvailable:false,…}).action==='skip'` ✅（无需构造域对象/文件系统） |
| DF-7 依赖单向 | `core` 零域内出度（汇点）；无文件 `require('./index')`；**`restart` 不再 require `./watchdog`** ✅ |
| D6 语义锁 | 域内零 `distribution` 依赖、零 `runNpmInstall`、零 `rollback/pinnedVersions/should-rollback`；`SHELL_RELEASE_PKG` 仅 `restart.js:45` 传入**注入的** `dist.fetchLatestVersion` ✅ |

## 5. 遗留 / 待主代理裁决

1. **`index.js:12-15` 失真注释**（指 `supervisor.js:28`，实际消费者为 `app/assembly/compose.js:26` + `bootstrap.js:27`）——本轮因"逐字不动"令未修；若主代理要执行设计 F4，只需改注释文本，不动导出面。
2. **域内 `README.md`** 未加（任务目标 5 文件）。若主代理要求 BRIEF §4 的职责边界+依赖图，可后补（不影响 DF 判据）。
3. **`watchdog.js` T7 残留**：一拍内 `shell.identity()` 仍读 3 次（相位/exe 可能来自不同快照），设计列为低风险可选项。
4. **`restart.js` 仍导出 `SHELL_RELEASE_PKG`**（零外部消费者但属导出面契约）；未删，遵设计 §G.2-5"只标注不删除"。
