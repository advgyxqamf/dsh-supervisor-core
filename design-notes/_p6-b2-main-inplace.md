# P6-B B-2（部分）报告：main 非热路径 4 文件**原地去 this**

> 对应作业单 `_workorder-phase6.md` §3 的 main 分片。按「逐文件、可停可报」推进。
> 未跑测试/门禁、未 require 产品模块；只 `node --check`/grep/read/wc/只读 git。全部仓库相对路径。

## 0. 结论（棘轮真实下降）

| 文件 | 改前 `this.X(` | 改后 | 备注 |
|---|---|---|---|
| `src/app/main/decide.js` | 25 | **0** | `_decideMainAction` 保持**零 this**（见 §2） |
| `src/app/main/health-gate.js` | 12 | **0** | |
| `src/app/main/shadow.js` | 5 | **0** | |
| `src/app/main/signals.js` | 3 | **0** | 同批改 `process-tree-kill-test` 两条形态钉子 |
| `src/app/main/controller.js` | 28 | **0** | 同批改 phase switch 抽取器为形态无关（见 §2.3） |
| `src/app/main/process.js` | 68 | 68 | **未转换**（见 §4） |
| `src/app/main/port-rederive.js` | 0 | 0 | 无需改 |

- `test/app-this-ratchet-gate-test.js` 基线按纪律**下调两次**：先 `main 141->96 / 总量 237->192`（4 文件），
  后 `main 96->68 / 总量 192->164`（controller 落地）。当前剥注释实测 162，松弛量 2。收紧记录已写入常量旁注释。

## 1. 做法

沿用 B-1 的**原地去 this**：方法仍定义在 `module.exports = { methods: {...} }` 中、名字/形参/实现逐字保留，
只把方法体内 `this.X()` / `this.<字段>` 改为经按 host 缓存的 **WeakMap 惰性 deps** `depsOf(this)`。
装配路径 `installMethods(host, mod.methods)` 不变；不新增 host 面。

## 2. 两条必须保住的契约（本批的关键）

1. **`_decideMainAction` 的裸调用契约**（`shadow-decision-test.js:30`）：
   测试以 `const decide = decideMod.methods._decideMainAction; decide(base())` 调用（`this=undefined`）。
   故本方法**不得**出现 `depsOf(this)`；其原先对 `this._decideCrashRestart()` 的 3 处调用改为调用
   **模块内纯函数** `decideCrashRestart(reason)`，方法壳 `_decideCrashRestart(reason)` 也转调它。
   ⇒ 裸调用下不再触碰 `this`，测试契约与行为不变。
2. **`process-tree-kill-test` 的两条 `this.` 形态钉子**（原 `/this\._killTree\(child, 'SIGKILL'\)/` 与
   `/this\._signalChild\(child, 'SIGTERM'\)/`）改为**按符号名**：`/killTree\(child, 'SIGKILL'\)/`、
   `/signalChild\(child, 'SIGTERM'\)/`；同批把 `_killSequence` 函数体内的 `indexOf` 比序样本
   （`_signalChild(child, 'SIGTERM')` / `_killTree(child`）改为符号形态。**判据本意不变**：仍锁
   「SIGKILL 升级路径走 killTree」「优雅期先 SIGTERM 再（超时）整树」「_killAdopted 体内走 killTree(pid」。
3. **`adopt-token-reclaim-test` 的 phase switch 抽取器**（原硬编码 `indexOf('switch (this.state.phase())')`）
   改为**形态无关正则** `/switch\s*\(\s*[A-Za-z_$][\w$]*\.state\(\)\.phase\(\)\s*\)/` —— 同时匹配
   `this.state.phase()` 与 `d.state().phase()`，其合成反例样本（legacySwitch）仍被命中；**判据本意不变**
   （锁「phase switch 内不读令牌池」）。
4. **controller.js 源码零 ASCII `token`**（`adopt-token-reclaim-test.js:127` 含注释判定）：
   新增 deps 成员名与头注**一律不含该标识符**（最终 `grep -c token` = 0）。

## 3. 逐文件 deps 映射（要点）

- `decide.js`：`state/session`；只读字段 `_upgradeHold/manualRestart/_crashHalted`；
  字段 helper `_mLastProbeOk/_mLastProbeHttpOk/_mChild/_mAdoptPid/_mAdopted/_mObservedOnly/
  _mSpawnBlockedUntil/_mStartDeadline/_mRestartAt/_mBackoffUntil/_mCrashWindowStart/_mCrashWindowRestarts/_mBackoffLevel`。
- `health-gate.js`：`config/state/events/logger/ui`；helper `_mCrashWindowStart/_mCrashWindowRestarts/_mBackoffLevel`
  与 `_mSetCrashWindowStart/_mSetCrashWindowRestarts/_mSetBackoffLevel/_mSetBackoffUntil/_mSetFailStreak/_mFailStreak`。
  （`guardian.bumpCrashWindow` 的返回局部量改名 `dec`，避免与 deps 的 `d` 撞名。）
- `shadow.js`：`state/main/logger/events`；只读 `_upgradeHold/_stopping`；兄弟方法 `_mainActualAction/_shadowExcluded`；
  可变字段 `_actWindow/_mainTickActs/_shadowSeq/_shadowLast/_shadowLoggedSeq/_shadowConsistentBeats/_shadowDiffBeats`。
  `++this._shadowSeq` 用 `Number(d.readShadowSeq()) + 1` 保等价（`undefined+1===NaN`、`0+1===1`）；
  `_shadowExcluded` 是纯函数，保持零 this。
- `signals.js`：`config/events/logger`；兄弟方法 `_signalChild/_killTree`；可变字段 `_killTimer/_adoptKillGen/_adoptKillTimer`。
  `(this._adoptKillGen = (this._adoptKillGen || 0) + 1)` → `const gen = (d.readAdoptKillGen() || 0) + 1; d.writeAdoptKillGen(gen)`（等价）。

## 4. 未转换与硬理由（登记，不硬推）

| 文件 | 计数 | 硬理由 |
|---|---|---|
| `src/app/main/process.js` | 68 | 与 controller 同属收敛热路径；且 `process-tree-kill-test` 的 `_killSequence/_killAdopted` 取体判据横跨 `process.js+signals.js`。逐文件转换前须先列全 `this.` 调用并核 `heartbeat-selfheal-test` 的 11 条正则。 |

> process.js 的转换不是不可行，而是**必须先同批处理其源码形态钉子**（含逐方法列全 this. 与
> 核 heartbeat-selfheal-test 的源码断言）；遵循作业单「部分完成优于硬推把热路径改坏」。

## 5. CI 风险

**低-中**。四条转换是机械等价替换（含两处算术等价专项核对），方法名/{ methods }/逐字体保留；
两条 `this.` 钉子改为按符号名且保留反向自检含义；`shadow-decision-test` 的裸调用契约经模块内纯函数保住；
R1 已对删除注释 token 反查 `test/`（唯一命中为测试自身注释，无钉子）。最终由 CI 四平台裁决。
