# FIX-4 目录加载容错 + 心跳归属/快照 + 沙箱停止校验

> 范围（独占）：`src/app/control/registry.js`、`src/app/control/heartbeat.js`、`src/app/session/shutdown.js`。
> 纪律：缺陷修复非重构，最小改动，保持对外契约。未运行任何测试，仅用 `node --check` / `grep` / `git diff` 静态核验；未启动 daemon，未 commit/push，未改版本号，未加依赖。

---

## 缺陷 A：`_load` 单条坏 entry 中断整份目录加载（静默截断）

- 位置：`src/app/control/registry.js` `_load()`（原约 63-86 行）。
- 现象：循环内只对「未知 kind」`continue`；`createEntry` 在条目缺 id 时抛错（`managed-object.js:55`），循环体无 per-entry try，异常抛到外层 `catch {}` 后循环中止，其后全部合法条目丢失。
- 后果：受管目录静默不完整，后续沙箱/daemon 消失。
- 修法（最小）：把循环体包进 per-entry `try/catch`，坏条经 `_log('warn', ...)` 记录（带 kind/id）后跳过，不阻断后续条目；外层 `try` 仍只负责读盘/JSON 解析失败时的空目录兜底。

## 缺陷 B：心跳与 stall 兜底重叠 + 遍历时注销跳过条目

- 位置：`src/app/control/heartbeat.js` `runHeartbeat()`（原约 42-86 行）。
- 现象（审计 D7 / #3 / #11）：
  1. 每对象 `withTimeout` 上限 = `iv*6`，循环串行；外层 `bootstrap.js` 的 stall 兜底阈值 = `max(30000, iv*12)`。同拍 >=2 个 adapter 卡死即可超过兜底，兜底把 `_heartbeatBusy` 置 false 并启动第二拍，而第一拍仍在 await，两拍并发监督/收敛。
  2. `for (const e of registry._objects)` 直接迭代活数组；adapter 在 `await` 期间经 `control.unregister` -> `_drop` splice 当前元素后，其后一个元素前移并被跳过（连续注销成片跳过）。
- 修法（最小，落在本文件）：
  1. 归属判断：`runHeartbeat` 以 registry 为归属载体维护 `_heartbeatInFlight`。在飞时本拍并入上一拍（返回同一 promise），不并发执行；清除时用 `if (registry._heartbeatInFlight === beat)` 保证只有持有者能清标记，迟到的旧拍不会误清新拍的标记。
  2. 快照遍历：`for (const e of registry._objects.slice())` 保证每个 snapshot 条目恰被处理一次。
  3. 条目归属判断：`await` 返回后回写实然前校验 `registry.get(e.id) !== e`（已注销/被同 id 新对象替换则跳过），避免把旧观测写到新对象上。
  4. 单拍逻辑原样搬入 `runBeat`（节流前推、超时、`errors`/`observed` 顺序、warn 文案均不变）。

### 未在范围内、需上层裁定的一点

`iv*6` 串行预算之和仍可能超过 `bootstrap.js` 的 `iv*12` 兜底阈值（审计 #11 建议改为「对象数 x 6 x iv」或以 run-once 调度替代），且 `bootstrap.js` 的 `.finally` 仍无代际判断（审计 D7 建议加自增 beat id/token）。这两处均在 `src/app/assembly/bootstrap.js`，不属本 FIX-4 独占范围，未改动。本文件的 `_heartbeatInFlight` 已使「并发两拍」不可能发生（第二拍并入第一拍），故兜底即使触发也不会造成重复监督/收敛；但兜底的 warn 仍可能被触发（噪声），彻底根治仍需改 bootstrap。

## 缺陷 C：`_stopAllSandboxes` 不校验 `stopUnit` 结果仍持久化 STOPPED

- 位置：`src/app/session/shutdown.js` `_stopAllSandboxes()`（原约 102-115 行）。
- 现象：`platform.service.current().stopUnit(...)` 的返回值被丢弃。Linux 停止失败返回 false 不抛；非 Linux（`makeUnsupported`）直接抛 `CapabilityError`。两条路径都会继续执行 `inst.state.phase = 'STOPPED'` 与 `instances.save()`。
- 后果：单元实际仍在跑，实例状态却落盘为 STOPPED（ghost），下次按错误相位决策。
- 修法（最小）：仅当 `stopUnit(...) === true` 才置 STOPPED；返回 false 或抛错时记 warn + `shutdown_sandbox_stop_incomplete` 事件并 `continue`（保留原 phase）。`instances.save()` 仍按原条件调用。

---

## 可观测行为变化（必须记录）

1. `_load`：坏 entry 不再导致后续条目丢失；每条坏 entry 记一条 warn（此前整份静默截断、无任何日志）。合法目录加载结果、`_loaded`、`_loadedFromDisk` 语义不变。
2. 心跳：同一 registry 上两拍不再并发；被 stall 兜底放行的第二拍与第一拍共用同一 promise/结果。单拍内部仍为串行，adapter 调用顺序、`observed`/`errors` 内容与顺序、超时阈值（`iv*6`）不变。遍历改为快照后，同拍内被注销的条目仍会被该拍处理一次（但回写前经归属校验，不会写到新对象）。
3. `shutdownAll`：沙箱单元未确认停止时不再写 STOPPED，改为 warn + 新增事件 `shutdown_sandbox_stop_incomplete`（`{ id }`）。成功路径不变。新增事件名属新增可观测面，非破坏性。

## 兼容性

- 对外导出面不变：`registry.js` 仍导出 `{ ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership }`；`heartbeat.js` 仍导出 `{ runHeartbeat, withTimeout, ADAPTER_TIMEOUT_TICKS }`（新增内部函数 `runBeat` 不导出）；`shutdown.js` 仍导出 `{ shutdown, shutdownAll, _stopMainDsh, _stopAllSandboxes }`。
- 行数：registry.js 285（DG-2 ≤300、DS-9 ≤400 通过）、heartbeat.js 106、shutdown.js 126。

## 测试影响（未运行，静态核对）

- 未改动被测试断言钉住的字符串。`test/round13-robustness-batch-test.js` ④ 对 `heartbeat.js` 的 `e._nextTickAt = Date.now() + tickEvery * iv;` 与对 `registry.js` 的 `e._nextTickAt = null;` 均保留。
- `test/managed-registry-test.js`：合法文件加载（第 5 节）不受 per-entry try 影响；第 8/9/10 节的心跳观测、节流、derivePhase、逐对象超时断言在串行 + 快照实现下语义不变（第 10 节 hung 300ms 超时后 healthy 仍被观测）。
- `test/graceful-shutdown-test.js` 只调用 `shutdown(host)`，不触 `_stopAllSandboxes`；`test/session-lifecycle-test.js` 的 `shutdownAll` 无沙箱项，不会进入新的失败分支；`test/heartbeat-selfheal-test.js` 读的是 `bootstrap.js`/`supervisor.js`，未受影响。
- 未改任何测试（本次未改被断言钉住的字符串）。

## 静态核验

- `node --check src/app/control/registry.js`、`node --check src/app/control/heartbeat.js`、`node --check src/app/session/shutdown.js` 均通过。
- 按硬约束未在本机运行任何测试。

## 未改范围外观察

- `src/app/assembly/bootstrap.js`：stall 阈值（`max(30000, iv*12)`）与 `.finally` 无条件清 `_heartbeatBusy` 的根因修复（审计 #11 / D7）不属本范围。
- `registry.js` 的 `_loaded` 只写不读（审计 #9 备注）为死字段，本次未删除（非缺陷修复所需，避免扩大改动面）。
- `src/domains/instance/lifecycle.js:99` 的 `stop(id)` 同样忽略 `stopUnit` 返回值即置 STOPPED，属同型缺陷但在范围外，未改动。
