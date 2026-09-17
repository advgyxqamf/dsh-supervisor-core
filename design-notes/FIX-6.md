# FIX-6 修复记录

## 缺陷

- 文件: `src/platform/os/service.js`
- 根因: 统一执行器 `exec.run()` 在命令失败或超时时返回 null 而不抛（`src/platform/util/exec.js:35-55`）。
  systemd Provider 的 `daemonReload` / `stopUnit` / `startTransient` 忽略该返回值，无条件 `return true`，
  其 try/catch 永不触发。
- 后果: `_systemdStart` 对 `service.startTransient(...)` 的 catch 永不进入；systemd-run 真实失败仍被当作成功，
  继续置 STARTING 并发 `inst_started`，直到 30s 后 STARTING 超时才转 BACKOFF。这是 FIX-5 两条缺陷的共同根因。

## 改动（仅本文件，3 处）

1. `daemonReload()`: 以 `run(...) !== null` 作为返回值；失败/超时返回 false，不再在失败时误报 true。
2. `stopUnit(unit, opts)`: 同上，失败返回 false（仍不抛，保持 best-effort 契约）。
3. `startTransient(o)`: 由 `exec.run` 改为 `exec.runDetail`，`!r.ok` 时抛 Error（附 error/stderr），成功返回 true。
   抛出是让 `_systemdStart` 的 catch 生效所必需。

## 行为变更（可观测）

- systemd-run 失败现在同步抛错：`_systemdStart` 捕获后写 `inst.state.lastError`、落盘、发 `inst_start_failed`，
  返回 `{ok:false,error}`；不再发 `inst_started`，不再空等 30s。
- daemon-reload 失败时 `_prepareSystemd` 现在会 warn（此前恒 true，无任何提示）。
- stop 失败现在如实返回 false（此前恒 true）。

## 调用方核查

- `startTransient` 唯一真实调用方 `src/domains/instance/lifecycle.js:54` 已在 try/catch 中，能处理抛出，无需改动。
- `daemonReload` 唯一调用方 `lifecycle.js:31` 已判 `=== false` 并 warn，能处理。
- `stopUnit` 调用方均不读返回值或已另行兜底，不会被破坏：
  - `lifecycle.js:99` 忽略返回值，仍置 STOPPED/发 inst_stopped；失败语义未被消费，属既有缺口，lifecycle.js 不在 FIX-6 范围。
  - `src/domains/instance/ops.js:73` 用 `isUnitActive` 二次复核决定是否删数据目录，有保护。
  - `src/app/session/shutdown.js:110` 忽略返回值，仅在抛出时 log；stopUnit 按契约不抛。

## 验证

- `node --check src/platform/os/service.js` 通过。
- 未在本机跑任何测试（硬约束）。
- 未发现被断言钉住本次改动字符串的测试：相关测试（cross-platform-test.js、platform-layer-portability-test.js、
  instance-*-test.js）只检查接口/能力或注入返回 true 的假 Provider，不调用真实 systemd。未改任何测试。

## 范围外观察（未改）

- `resetFailed` / `cleanTransient` 同样忽略 `run()` 的 null，存在同类隐患；`resetFailed` 在 src 中无调用方，
  故未纳入本次最小改动。
- `daemonReload`/`stopUnit`/`resetFailed`/`cleanTransient` 传给 `run` 的是 `{ timeout: ... }`，
  但 `exec.options` 读取的是 `timeoutMs`（`src/platform/util/exec.js:22`），故这些超时值实际未生效、回落默认 15000；
  例如 `stopUnit({timeoutMs:20000})` 实际用 15s。属独立缺陷，未在 FIX-6 内改动。
