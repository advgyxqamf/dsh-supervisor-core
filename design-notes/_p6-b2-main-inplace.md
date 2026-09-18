# P6-B B-2 报告：main 全目录**原地去 this**（141 -> 0）

> 对应作业单 `_workorder-phase6.md` §3 的 main 分片（逐文件推进，全部落地）。
> 未跑测试/门禁、未 require 产品模块；只 `node --check`/grep/read/wc/只读 git。全部仓库相对路径。

## 0. 结论（棘轮真实下降：main 全目录归零）

| 文件 | 改前 `this.X(` | 改后 | 同批处理的源码形态约束 |
|---|---|---|---|
| `src/app/main/decide.js` | 25 | **0** | `_decideMainAction` 保持**零 this**（裸调用契约） |
| `src/app/main/health-gate.js` | 12 | **0** | — |
| `src/app/main/shadow.js` | 5 | **0** | 源码不得含令牌回收 reason 字面量 |
| `src/app/main/signals.js` | 3 | **0** | `process-tree-kill-test` 两条 `this.` 钉子改符号形态 |
| `src/app/main/controller.js` | 28 | **0** | phase switch 抽取器改形态无关 + 源码零 ASCII `token` |
| `src/app/main/process.js` | 68 | **0** | `applyMainPort(this, ...)` 仍显式传宿主 |
| `src/app/main/port-rederive.js` | 0 | 0 | 无需改 |

- `test/app-this-ratchet-gate-test.js` 基线按纪律**分次下调**：
  `main 141->96->68->0`、`BASELINE_TOTAL 237->192->164->96`（剥注释实测 94，松弛量 2）。
  逐次收紧记录已写入常量旁注释。

## 1. 做法

沿用 B-1 的**原地去 this**：方法仍定义在 `module.exports = { methods: {...} }` 中、名字/形参/实现逐字保留，
只把方法体内 `this.X()` / `this.<字段>` 改为经按 host 缓存的 **WeakMap 惰性 deps** `depsOf(this)`。
装配路径 `installMethods(host, mod.methods)` 不变；不新增 host 面。

## 2. 四条必须保住的契约（本批的关键，全部同批处理）

1. **`_decideMainAction` 的裸调用契约**（`shadow-decision-test.js:30`）：
   测试以 `const decide = decideMod.methods._decideMainAction; decide(base())` 调用（`this=undefined`）。
   故该方法**不得**出现 `depsOf(this)`；其原先对 `this._decideCrashRestart()` 的 3 处调用改为调用
   **模块内纯函数** `decideCrashRestart(reason)`，方法壳 `_decideCrashRestart` 也转调它。
2. **`process-tree-kill-test` 的两条 `this.` 形态钉子**改为**按符号名**：
   `/killTree\(child, 'SIGKILL'\)/`、`/signalChild\(child, 'SIGTERM'\)/`；
   同批把 `_killSequence` 函数体内的 `indexOf` 比序样本改为 `signalChild(child, 'SIGTERM')` /
   `killTree(child`。**判据本意不变**：锁「SIGKILL 升级走 killTree」「优雅期先 SIGTERM 再整树」
   「_killAdopted 体内走 killTree(pid」。
3. **`adopt-token-reclaim-test` 的 phase switch 抽取器**由硬编码
   `indexOf('switch (this.state.phase())')` 改为**形态无关正则**
   `/switch\s*\(\s*[A-Za-z_$][\w$]*\.state\(\)\.phase\(\)\s*\)/` —— 同时匹配
   `this.state.phase()` 与 `d.state().phase()`，其合成反例样本（legacySwitch）仍被命中。
4. **controller.js 源码零 ASCII `token`**（`adopt-token-reclaim-test.js:127` 含注释判定）：
   新增 deps 成员名与头注一律不含该标识符（`grep -c token` = 0）。shadow.js 头注亦不得出现
   被删的令牌回收 reason 字面量（首次 CI 红点即此，已修）。

## 3. 逐文件 deps 要点

- `decide.js`：`state/session`；只读 `_upgradeHold/manualRestart/_crashHalted`；13 个 `_m*` helper。
- `health-gate.js`：`config/state/events/logger/ui`；9 个崩溃窗口/退避 helper（局部量改名 `dec` 避与 `d` 撞名）。
- `shadow.js`：`state/main/logger/events`；`_upgradeHold/_stopping`；`_mainActualAction/_shadowExcluded`；
  7 个影子字段（`++seq` 用 `Number(...)+1` 保等价；`_shadowExcluded` 保持纯函数）。
- `signals.js`：`config/events/logger`；`_signalChild/_killTree`；`_killTimer/_adoptKillGen/_adoptKillTimer`。
- `controller.js`：11 个对象成员 + `_ticking/_stopping/_actWindow/_mainTickActs/_lastMainPortRederive/
  _upgradeHold/_upgradeHoldSince/manualRestart/_crashHalted/_sessionState` + 16 个 `_m*` helper。
- `process.js`：11 个对象成员 + `_stopping/_crashHalted` + `spawnCommand/_beginRestart` 兄弟转发 + 19 个 `_m*` helper；
  `applyMainPort(this, ...)` 的两处**保留显式 this**（函数签名要求真实 host）。

## 4. 验证（主控独立核对）

- 全 7 文件 `node --check` 通过；逐文件 `grep -oE 'this\.[A-Za-z_$][A-Za-z0-9_$]*[ \t]*\('` 均为 0；
  `src/app/main` 目录合计 0。
- 相关钉子的合成反例仍命中：`extractPhaseSwitch` 对 `this.state.phase()` 样本命中；
  `process-tree-kill` 的符号判据对 `this._killTree` 与 `d._killTree` 两形态均命中。
- R1 已对删除/改写注释逐 token 反查 `test/`（命中均为测试自身注释，无钉子）。
- 行为等价专项：`Number(seq)+1`、`(readAdoptKillGen()||0)+1` 与 `++` 语义逐条核对。

## 5. 残余

- main 目录已**无未转换文件**。app 其余目录计数：`control 54 / daemons 29 / settings 8 / native 3 / self 1 /
  assembly 1`（`daemons 的 29` 是 `DaemonLifecycle` 类自身实例方法，不属本棘轮面；其余为下一批候选）。
- `host.main`/`host.daemons` 仍为 `installThin` 薄转发器（本批只做实现体去 this；未新建真 ctor 覆盖，无门禁要求）。

## 6. CI 风险

**低-中**。六文件转换是机械等价替换（含 3 处算术等价专项、1 处显式宿主传参保留）；
方法名/{ methods }/逐字体保留；四条源码形态约束均同批处理且保留反向自检含义。最终由 CI 四平台裁决。
