# FIX-5 实例删除数据防线 / 停止假成功 / 安装自愈 / 升级回滚停单元

> 范围（独占）：`src/domains/instance/ops.js`、`src/domains/instance/lifecycle.js`、`src/domains/instance/upgrade.js`。
> 纪律：缺陷修复非重构，最小改动，保持对外契约（导出面、事件名、返回字段除下方明确列出的可观测行为变化外不变）。
> 未运行任何测试（硬约束），仅用 `node --check` / `grep` / `git status` 静态核验；未启动 daemon，未 commit/push，未改版本号，未加依赖。

---

## 缺陷 A（高危数据丢失）：删除实例把「单元查询失败」当「不活跃」

位置：`ops.js::removeInstance`。

- 原实现 `stillActive = service.isUnitActive(unit) === true`。`systemd.isUnitActive` 内部 `catch { return false; }`，且统一执行器 `exec.run` 失败/超时返回 null 而不抛。于是「查询失败」与「确实 inactive」都返回 false，外层 `catch { stillActive = true; }` 是不可达分支。dbus / `systemctl --user is-active` 超时时 `stillActive=false`，随后 `fs.rmSync(root, { recursive:true, force:true })` 删除沙箱数据目录，而单元可能仍在运行。
- 同期 FIX-6（另一范围，已落地）让 `service.stopUnit` 失败返回 false、成功返回 true。
- 修法：以「停止确认」为唯一放行条件，活跃性查询退为二次复核。
  - `service.stopUnit(unit) !== false` 即停止确认；抛 CapabilityError（平台无用户单元）= 无单元可停、非失败。
  - 仅停止确认后才查询 `isUnitActive`；只有显式 `false` 视为已停，`true` / `null` / `undefined`（查询失败语义）或抛错一律按「可能仍活跃」处理。
  - 非确知已停：不删目录，记日志与 `inst_remove_data_preserved` 事件，返回 `{ ok:true, dataPreserved:true, preserveReason:'unit-still-active' }`（字段与文案不变）。

## 缺陷 B（高危假成功）：stop 忽略 stopUnit 返回值强制置 STOPPED

位置：`lifecycle.js::stop`。

- 原实现调用 `service.stopUnit(...)` 后无条件 `inst.state.phase='STOPPED'` 并返回 `{ok:true}`。停止失败也报「已停止」，`supervise` 在 STOPPED 相位不再自愈，实例可能仍在监听却长期不自洽。
- 修法：读取 `stopUnit` 返回值。为 `false`（或抛错）时不改相位、不触发 `onInstanceStop`、不发 `inst_stopped`，写 `inst.state.lastError`、发 `inst_stop_failed` 事件、返回 `{ ok:false, error:'停止实例失败（单元 ... 未确认停止）' }`；仅确认成功才置 STOPPED。
- API 侧 `src/api/domains/instances.js:166` 已按 `r.ok` 映射 200/400，能如实给出 400。

## 缺陷 C1：安装任务登记失败导致进行中的安装被永久判死

位置：`lifecycle.js::supervise` 的 `INSTALLING` 分支，并新增 `FAILED` 自愈分支。

- 原实现：`tasks` 存在但 `tasks.current(...)===null` 时立即 `stateMachine.fail(..., '安装中断（无进行中安装任务）')`。而 `dsh-install.installSandbox` 在 `tasks.begin/step` 抛错后 `task=null` 并继续 npm 安装；npm 成功后 `installOk=true`，但自愈条件只认 `/安装超时/`，相位停在 FAILED，INSTALLING -> RUNNING 的拉起永不发生。
- 修法（只在 lifecycle 内，未改 dsh-install.js）：
  - 无作业行时不再立即判死：仅在能确证「最近安装作业 failed/canceled」或 `installAt` 已超 10 分钟时才 fail；否则继续等待安装完成。
  - 新增 `FAILED` 恢复：`installOk===true` 且未在运行时 `_systemdStart`，失败则 `restart` 退避；`lastError` 命中「重试超限」后不再自动拉起，避免无界重试，交用户处理。

## 缺陷 C2：升级回滚未先停新版本单元

位置：`upgrade.js::rollback`。

- 失败路径 3（新版本已启动、健康验证未过）进入回滚，先装回旧版再 `lifecycle.start`；但新版本进程可能仍监听端口，`_systemdStart` 开头 `if (probe(inst).running) return {ok:false,error:'端口 ... 已被占用'}` 直接拒绝，形成磁盘旧版、内存新版且守卫不自愈。
- 修法：回滚开始先 `await lifecycle.stop(id)`（失败/异常只记任务日志，继续回装旧版），再装旧版、再重启。

---

## 可观测行为变化（必须记录）

1. 删除实例：`service.stopUnit` 返回 false 时（停止失败，或单元未加载，例如从未启动、已被 systemd GC），改为保留数据目录并回报 `dataPreserved:true`；此前会删除。停止确认成功且 `isUnitActive` 显式为 false 的常规路径仍删除，行为不变。
2. `isUnitActive` 返回 `null`/`undefined`/`true` 或抛错（查询失败）时按活跃处理，不再删数据。
3. `stopInstance`：`stopUnit` 失败时返回 `{ok:false}` 且相位不再被强制置 STOPPED（新增 `inst_stop_failed` 事件、写 lastError）；此前恒 `{ok:true}`。API 因此返回 400（其映射为既有实现，非本次改动）。对未加载单元的 stop 也会因此返回 ok:false。
4. `supervise` 对「无进行中安装作业」的 INSTALLING 实例不再立即判 FAILED，最长等到 `installAt` 超 10 分钟；`FAILED` 且 `installOk===true` 时自动尝试拉起（新增自愈路径）。
5. 升级失败回滚会先调用一次 `lifecycle.stop`：原本已停/未运行的实例可能多发一次 `inst_stopped` 事件与 `onInstanceStop` 回调，且该次 stop 失败会写一次 lastError（随后 `_systemdStart` 成功时清空）。

## 兼容性

- 导出面不变：`createOps` / `createLifecycle` / `createUpgrade` 返回成员未增删。
- 事件名 `inst_stopped` / `inst_remove_data_preserved` / `inst_removed` 及字段保持；仅新增 `inst_stop_failed`。
- `removeInstance` 返回结构（ok / dataPreserved / preserveReason）不变；`stop` 与 `start` 同规（成功 `{ok:true}`，失败 `{ok:false,error}`）。
- 未改 `src/platform/os/service.js`（FIX-6 范围）、未改 `src/domains/instance/ops/dsh-install.js`、未改 API 层。

## 静态核验

- `node --check` 三个文件均通过。
- 复核 `test/instance-safety-test.js` 的正则断言（L-a / L-b / L-h）改动后仍全部匹配：`isUnitActive(unit)`、`!stillActive`、`inst_remove_data_preserved`、`dataPreserved: true`、`stillActive ? { ok: true, dataPreserved: true`；`await rollback(` 3 处、`version: oldVersion` 1 处、`const rollback = async` 1 处。
- 复核 `test/instance-upgrade-test.js` R1-c：`fromUpgrade: true` 仍 2 处，无裸 `this.startInstance(id)`。
- `test/round13-discipline-gaps-test.js` ② 的假 service（stopUnit:true / isUnitActive:false）与 ②-b（stopUnit 抛 / isUnitActive:false）在新逻辑下仍返回 `ok:true` 且不崩。
- `grep` 全仓测试无 `安装中断` / `无进行中安装任务` 等被删字符串的断言。
- 三个文件无新增禁用符号（表情等）。
