# INCIDENT 2026-09-18：退出管家后桌面壳被自动重新拉起

状态：已修复（内核 PR #20 / 壳 PR #23）；验收待 CI。

## 症状

任务栏「退出管家」（或 closeAction=exit）后，并非完整退出；很久以后桌面壳又被自动启动。

## 根因（两条，缺一不可）

1. 壳侧（Windows 主根因）：`stop()` 只用 `schtasks /End` 结束运行实例，而 `DSH-Supervisor-Watchdog` 是 `/SC MINUTE /MO 5` 的**计划**；`watchdog.ps1` 在无 GUI 进程时 `Start-Process <壳>`，≤5 分钟后把壳拉回。
2. 内核侧：会话退出意图不持久化。退出时 `_sessionState=stopping/stopped` 只在内存；看护门只判「壳是否缺失」且落在 bootstrap 定时器闭包；`shutdownAll` 未清 `_shellWatchdogTimer`。守卫一旦被外部/登录重新拉起即遗忘退出，看护 90s 后重新拉起壳。

## 修复

内核：
- `host._shellHalted` 持久退出标记（`status.shellHalted`）：`shutdownAll` 立即落盘，boot 经 `loadState` 继承，看护观测到壳在线且非退出中时清除。
- 退出门下沉看护域（`tick` 依赖 `halted`/`onShellAlive`）。
- `POST /shell/restart` 退出中/已退出返回 409。
- `restartShell` 增加 `shouldAbort`，spawn 前复判。
- `shutdownAll` 与 `shutdown()` 对齐，清全部周期定时器。

壳：
- `platform/windows.rs stop()` 对看护任务 `/Delete /F`；下次 `ensure_defined` 幂等重建。
- `ensure_guard` 在「守卫已运行」提前返回分支补一次 Windows-only 幂等 `ensure_defined`，防登录任务先起守卫导致看护任务永不重建。
- `shutdown_all` 停止守卫失败落盘 shell.log。

## 证据与完整清单

壳仓 `docs/audit/2026-09-18/_s3-exit-relaunch.md`（含「谁能在退出后拉起壳」完整清单、残留 R1-R5、两份审计报告索引）。

## 复现与验收

本机不跑测试/守护进程；验收只由 CI。退出路径回归见 `test/shell-watchdog-test.js`、`test/session-lifecycle-test.js`。
