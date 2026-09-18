# FIX-7 修复记录

范围（独占）：`src/domains/relay/daemon.js`、`src/domains/router/providers/probe.js`。
依据：`design-notes/AUDIT-r5-router-relay-logic.md` BL-1（P1）、BL-3（P1）、BL-2（P2）。

## 缺陷 A（BL-1，P1）：relay 优雅停机的 frpc 等待是空操作

- 文件：`src/domains/relay/daemon.js`（原 155-165、173-181）。
- 根因：`waitFrpcExit()` 内部调用 `lan.frpChild()` 现读 `frp.child`；而 `shutdown()` 先调
  `lan.shutdown()` -> `frp.stop()`，后者在发 SIGTERM 后立即 `this.child = null`。等待函数读到 null
  即 resolve，等于没有等待。
- 后果：忽略 SIGTERM 的 frpc 在 `frp.stop()` 的 3s SIGKILL 兜底定时器尚未触发时被 `process.exit`
  终止该定时器，frpc 成孤儿并占用公网隧道端口。
- 修法：`waitFrpcExit` 改为接收 child 句柄（`waitFrpcExit(frpc)`）；`frpc` 仍在 `lan.shutdown()`
  之前由 `lan.frpChild()` 捕获。等待逻辑不变（3.5s 轮询 + 4s resolve 兜底）。

## 缺陷 B（BL-3 P1 / BL-2 P2）：probe 子进程回调与 DEAD 跳过

- 文件：`src/domains/router/providers/probe.js`。
- B1（BL-3，原 112-117）：`child.on('close')` / `child.on('error')` 无条件写 `inst.pid = null`
  及状态，不校验 `inst.pid === child.pid`。重启流程先 force stop（置 `inst.pid = null`），1.2s 后
  respawn 写入新 pid；若旧进程晚退，其 close 在新 pid 写入之后触发，把新 pid 清掉、状态打回 COLD，
  导致新进程失登记（reconcile 再拉一个）与同端口双实例。
  修法：仅当 `inst.pid === child.pid` 时才清 pid/改状态；事件 `proxy_instance_stopped` /
  `proxy_instance_failed` 保持无条件发出（与改动前一致）。采用 `frp.js:144/151` 同款「所有权比对」写法。
- B2（BL-2，原 148）：`monitorLifecycle` 循环首行 `if (inst.status === DEAD) continue;`。
  `healthInstance` 失败时已把状态置 DEAD，于是下一轮被整段跳过，`_monitorFails` 只在同一次调用里
  从 0 变 1，永远到不了 >= 3，`proxy_instance_hang_restart` 与 kill 重拉分支恒不可达。
  修法：删除该 DEAD 跳过。进程存活/端口归属判定与 HTTP 探活解耦，DEAD（进程在但不健康）继续探活，
  连续 3 次（30s 周期，约 90s）后命中原有 kill 重拉分支。

## 行为变更（可观测）

- daemon：有 frpc 子进程时，shutdown 现会真正等待其退出（最多约 3.5s，或 4s resolve 兜底）再
  `process.exit`；无 frpc 或已退出时仍立即 resolve。这是本次修复的目标行为。
- probe B1：`close`/`error` 事件发出时机与载荷不变；仅当该 child 已非当前代时不再改实例状态。
  正常 stop（stopInstance 已置 pid=null）下事件照旧发出，未丢事件。
- probe B2：处于 DEAD 且进程/监听仍存在的实例，现每 30s 被 HTTP 探活并通过 `_monitorFails` 计数；
  连续 3 次失败后发 `proxy_instance_hang_restart` 并 SIGKILL 重拉（此前该事件与分支为死代码）。
  无 healthPath 的 app、以及 pid 已清空的实例不受影响。

## 契约与调用方核查

- `waitFrpcExit` 仅本文件内部调用（1 处），未导出，签名变更为内部接口。
- `monitorLifecycle` 经 `proxy.js:142` 暴露，`scheduler.js:79-80` 每 30s 调用；DEAD 语义见
  `model.js:5`（进程在但不健康，资源 1，待回收），`occupiesSlot` 仍把 DEAD 计为占用，重拉前无重复
  启动风险。
- 未改任何对外导出、事件名或数据形状。

## 验证

- `node --check src/domains/relay/daemon.js`、`node --check src/domains/router/providers/probe.js` 通过。
- 未在本机运行任何测试或门禁（硬约束）。
- 被断言的字符串未改动：`test/graceful-shutdown-test.js:87/90` 仍命中 `waitFrpcExit` 与
  `setTimeout(resolve, 4000)`；`test/provider-gateway-gate-test.js` 对 probe.js 的检查（四态词表、
  maxHot/maxWarm 等）不受影响。全仓无测试断言 `inst.pid = null` 守卫、DEAD 跳过或上述事件名，
  故未改测试。

## 范围外观察（未改）

- `frp.js:145/153` 在旧 child 退出时仍会调用 `_scheduleRestart()`（不受 `this.child === child`
  守卫约束），配置仍应运行时旧代退出可能触发一次多余重启；不在本次范围。
- `monitorLifecycle` 中 DEAD 重拉与请求级 `_unhealthyCount`（markInstanceProblem）仍是两套独立
  计数，未合并。
- 本次新增/改动注释均为纯文本、无表情符号；probe.js 既有的 3 处箭头注释（:17、:48、:213）属
  AUDIT NS-1 的注释符号清理轨道，不在 FIX-7 缺陷范围，未动。
