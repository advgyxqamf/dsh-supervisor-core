# P4-F：存疑项确证为真缺陷的 4 项修复（D9/D10/D11/D12）

> 由 P4-E 只读走查（`design-notes/_p4-e-uncertain.md`）确证、主控指派。快照基线 HEAD `24b2fb7`。
> 未跑测试/门禁、未 `require` 产品模块或内存冒烟、无 git 写、未改 `test/`。
> 全部核验只用 `node --check` / `git diff` / `grep` / `read`。

## 0. 分区与交付

独占 `src/app/daemons/**`、`src/app/main/**`、`src/app/native/**`。**按文件**互斥分片：

| 执行者 | 文件 | 任务 |
|---|---|---|
| P4-F（负责人） | `daemons/runtime.js` | D10 |
| P4-F（负责人） | `main/controller.js` | D11 |
| P4-F-1（下级） | `main/process.js`、`main/signals.js` | D12 |
| P4-F-2（下级） | `native/ops.js` | D9 |

**与指派的偏离（已声明）**：指派建议的分片是「daemons+main 的 D10/D11 / main+signals 的 D12」，但那会让两个执行者**同时改 `src/app/main/**`**；改为按**文件**切分（我取 `controller.js`，下级取 `process.js`+`signals.js`），互斥无重叠。

## 1. 逐项

### D10 daemon 异主判定未用 classify —— 真缺陷（中低，判据不等价）

**改动** `src/app/daemons/runtime.js`（停止路径，原 :145-152）：kill 前先用 `DaemonLifecycle.classify()` 做**动态归属**判定；`mode==='external'` 时 **拒绝停用**（不 kill、不清锁、不清 identity）+ `logger.warn`，返回 `{active:false, mode:'embedded', refused:'external'}`。其余 mode 保持既有行为。

**理由**：`managed` 来自 `identity.js:_daemonManaged()` = **仅 `fs.existsSync(lockPath)`**，是「我声明过管理」的**静态授权**，**不比对锁内 pid**；而 `classify()`（`process.js:189`，`supervise.js:35` 已用同源判据）才是「端口占用者是否为我这一代」的**动态归属**。二者回答不同问题。缺陷形态：陈旧锁 + 本实例 daemon 已死 + 外来同名 daemon 占同 ctl 口 ⇒ 原实现按端口 pid 直接 SIGTERM ⇒ **误杀外来进程**。

**行为变更**：新增一条拒绝路径（external 时不再停用）、一条 warn 日志、返回值多一个 `refused` 字段（仅 external 时出现）。**注意**：external 在 stop 路径下返回 `mode:'embedded'` 而非 `'daemon'`，故 `domain-actions/router.js` 不会走 `rt.stopping` 分支、会回落到内嵌 stop —— 这是**保守**方向（拒绝接管异主 daemon），与 `supervise.js` 既有的 external 隔离口径一致。

**CI 风险**：低。唯一消费者 `domain-actions/router.js:34` 只看 `rt.mode === 'daemon' && rt.stopping`。已核 `test/probe-gate-and-ownership-test.js` 的 E-h 三条源码判据仍成立（`_disableRouterPersist();` 计数 = 2；剥注释后 `setPersistEnabled(false)` = 1；方法体存在）。

### D11 guardian 语义不一致 —— 真缺陷（中低，静态可证）→ **声明式修复**

**改动** `src/app/main/controller.js`（RUNNING 分支 else 支）：**只加注释，不改任何判定逻辑**。

**理由**：`:155` 算出 `guarded`，`:156-163` 两个**死亡**分支（adopted_exit / child_exit）据此判断，而 `:164-171` 的**假死**分支全程不读 `guarded`。P4-E 已证明**裸加 `if (guarded)` 会形成 adopt ↔ 假死空转**：假死不重启 → 落回 STOPPED → STOPPED 分支的 `portUp` 走 `adopt()` 重新接管 → 下一拍又被判假死（每轮还伴随用户可见的相位抖动）。故把「假死自愈不受 guardian 约束」写成**显式契约**，并写明「要改此语义必须先引入稳定态，不能只加 guarded 判断」。

**行为变更**：**无**（纯注释）。
**CI 风险**：极低。`test/shadow-decision-test.js`、`adopt-token-reclaim-test.js` 读该文件但断言的是行为/符号，注释不影响。

### D12 stopProcess「停止落空」—— 真缺陷（中低；落空本身需运行期证据）

**改动** `src/app/main/signals.js` + `src/app/main/process.js`：

1. `signals.js:_killAdopted`：SIGKILL 后新增**复核窗口** `ADOPT_KILL_VERIFY_MS = 2000`，仍 `pidlook.isAlive(pid)` 才判「停止落空」→ 发 **`stop_failed`** 事件 + `logger.warn`。原实现只 `append('sigkill_sent')` 就算完，**kill 失败与成功无法区分**。
2. `signals.js`：`_adoptKillTimer` 加**代际** `_adoptKillGen`（对齐 `bootstrap.js` 的 `_heartbeatBeat` 做法）—— 后一次 kill 会覆盖前一次的句柄，故 timer 只在「本代仍是当前代」时才把槽位置回 null，防旧 timer 清掉新一次的句柄。**代际只保护共享槽位**：每个 timer 仍按自己的 pid 完成升级与复核，不因换代而跳过（否则前一个 pid 的 SIGKILL 升级会被吞）。
3. `process.js:stopProcess`：把 kill 派遣包进 `try/catch` —— 原实现若 `killSequence/killAdopted` 同步抛错，异常会**逃出方法、跳过 `state.write()`**，且无任何失败事件（停止半执行而静默）。现捕获后发 `stop_failed`（带 reason/pid/error）+ warn。

**行为变更声明（必须）**：
- 新增事件名 **`stop_failed`**（2 处；已核全仓为**新名**，与既有 `inst_stop_failed` 无关）；
- 新增 warn 日志 2 条；
- **相位裁定：kill 失败时 `phase` 仍置 `STOPPED`**（不改相位语义）—— 因为 `controller.js` 的 `portUp → adoptObserved` 依赖 STOPPED；失败经事件如实上报，而非把相位停在中间态。此点按 P4-E 口径执行，未擅自改相位。
- `verify` 定时器已 `unref()`：复核窗口纯观测，**不应拖住进程退出**；shutdown 仍会清 `_adoptKillTimer`。

**CI 风险**：低。已核 `test/smoke.js:156` 的**负向事件断言** `!ev.some(e => e.type === 'sigkill_sent')`（挂起进程不得被 SIGKILL）—— D12 **未改 SIGKILL 触发逻辑**，仅在 SIGKILL 之后新增复核，故该断言不受影响。

### D9 `install()` 缺 try/finally 释放 `installing` —— 真缺陷（结构性/潜在）

**改动** `src/app/native/ops.js`：`install()` 函数体包进 `try/finally`，`finally { host.installing = null; }`。原三处显式置 null **保留**（冗余无害；删它们需先证分支覆盖）。

**硬证据（代码零变化）**：`git diff -w -- src/app/native/ops.js` 只显示新增注释 + `try {` + `} finally {…}`，**无其它任何行**。

**行为变更**：正常路径零变更（finally 无 return，不改返回值；三处早退返回对象逐字不变）；异常路径**纯增量改善** —— `installing` 由「滞留」变为「释放」，`startInstall/startUninstall/升级` 的并发闸不再被永久占锁。无状态码/事件名/日志文案变化；导出未增删。
未误伤：`checkUpdate` 的 `:56 finally` 未动；`uninstallOrCleanup` 的 finally 未动；`uninstalling` 语义全部保持。

**下级补充的可达性结论（比原判更 sharp）**：`install()` 两个调用者中**只有一个活路**——`startInstall` 有 `.catch` 释放锁；而 `NativeManager.install()`（`installer.js:89`）**无任何 finally/catch**。它在 `src/` 内**零调用者**（`POST /native/install` 走 `startInstall`；upgrade 走 `upgrade()`），但被 `api/deps.js:46` 列为 nativeManager 的**已声明消费面** ⇒ 当前不可达，但**该入口一旦被使用，锁必然滞留**。故本次修复从「对称性美化」升级为「堵住一条已声明入口的必然后果」。**不建议**改为只给 `NativeManager.install()` 加守卫（复制守卫，仍与 `uninstallOrCleanup` 不对称）。

## 2. 主控移交的一处跨工作流回归（我修）

`src/app/settings/lan-panel.js`（原属 P4-A 面）在 #6 同型修复中新增了一处 `...this.lanPanelStatus()`，使 `this.X(` 计数 **8 → 9**，超出 **AT 棘轮基线 8** ⇒ CI 必红。修法：把两次 `this.lanPanelStatus()` 提为一次局部 `const panel`，两处返回共用 —— 计数回 **8**，且成功/失败返回的是**同一份快照**（原两处各调一次会重新枚举局域网地址，可能不一致）。
复核：全部目录计数与基线**逐一相等**（assembly 1 / control 54 / daemons 43 / facade 13 / main 141 / native 3 / self 1 / settings 8）。

## 3. R1（注释钉子）证据

对本批**全部新增行的 CJK token**（92 个 ≥4 字）逐个 `grep -rlF` 扫 `test/` → 3 个命中，**逐条甄别为非钉子**：

| token | 命中 | 判定 |
|---|---|---|
| `安装完成` | `task-registry-test.js:36` | 测试**自己的夹具字符串**（`reg.log(t.id, '安装完成')`），非对源码的断言 |
| `原实现只` | `instance-safety-test.js:137`、`round8-fixes-test.js:275` | 均为**测试内部注释**的叙述 |
| `归属校验` | `instance-safety-test.js:17` | 测试**内部注释**（叙述 release 的归属校验），非对我文件 |

即：**本批新增注释未被任何测试断言匹配**。ASCII token 的断言形态命中项逐条核对均为「注释提及、断言仍指向代码」的标识符（如 `active`/`logger`/`router`）。

## 4. R2（删除）与纪律

- **本轮删除数 = 0**（四项全是修改，无导出增删）。
- **未使用 `release/scripts/export-consumers.sh` 的结论作任何依据**（主控已发现其系统性假阴性：无左边界的宽形态匹配 + `"sym()"` 分支会把纯调用行判成定义行）。本批未据任何工具结论删过任何符号。

## 5. 自证（`node --check`）

`daemons/runtime.js`、`main/controller.js`、`main/process.js`、`main/signals.js`、`native/ops.js`、`settings/lan-panel.js` —— 全部 exit 0。行数均 < 300（DG-2）。

## 6. 遗留与 CI 风险汇总

| 项 | 遗留 |
|---|---|
| D10 | 「陈旧锁 + 外来同名 daemon」是否真实现场发生**需运行期证据**；判据不等价本身静态已证 |
| D12 | 「停止落空」是否真的发生**需运行期证据**；本批只保证**失败可见** |
| D9 | 可达性未证（已把 `NativeManager.install()` 这条已声明入口列为后果分析） |
| D11 | 属**声明式**，未改逻辑；若要真正统一语义，须先引入稳定态，风险高、独立周期 |
