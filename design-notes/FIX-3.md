# FIX-3 原生 ops 互斥锁前置 + 升级 hold 跨重启真实 API

> 范围（独占）：`src/app/native/ops.js`、`src/app/state/store.js`。
> 纪律：缺陷修复非重构，最小改动，保持对外契约。未运行任何测试，仅用 `node --check` / `grep` / `git diff` 静态核验；未启动 daemon，未 commit/push，未改版本号，未加依赖。

---

## 缺陷 A：native 操作互斥锁存在 TOCTOU 且安装入口缺升级闸

### A1. `uninstall` 锁在 await 之后置位
- 位置：`src/app/native/ops.js`（原约 163-178 行）。
- 现象：前置检查（`tasks.isBusy` / `installing` / `uninstalling` / `policies.busy`）通过后，先 `await host.hooks.stopForUpgrade()`，再执行 `host.uninstalling = true`。
- 后果：并发两个 `uninstall`（或 `startUninstall`）请求都会在 await 间隙通过检查，各自进入 npm 卸载与 manifest/数据路径清理，形成重复写 npm 全局目录与竞态删路径。
- 修法（最小）：把 `host.uninstalling = true` 移到任何 await 之前（仅需恢复该行位置），并把其后全部流程纳入 `try { ... } finally { host.uninstalling = null; }`，`native_uninstall_started` 事件也移入 try。异常/超时路径均释放锁。
- 未改语义：`tasks.isBusy` 检查、升级 busy 检查、超时看门狗、失败保留 manifest、返回结构均不变。

### A2. `startInstall` 缺 `policies.busy()` 闸
- 位置：`src/app/native/ops.js:115`（原缺口）。
- 现象：`startInstall` 只检查 `installing` / `uninstalling`，然后直接调用文件内的 `install(host, version)`；而 `installer.install` 外层的 busy 检查被绕过，升级进行中仍可发起安装。
- 修法：在 `startInstall` 的 `uninstalling` 检查之后补 `if (policies.busy(host)) return { ok: false, error: '升级进行中，请稍后再装（state=' + host.upgradeState + '）' };`，文案与 `installer.install` 一致。

---

## 缺陷 B：升级 hold 跨重启恢复调用了不存在的 API

- 位置：`src/app/state/store.js`（原约 60-63 行）。
- 现象：`loadState` 恢复 `raw.upgradeHold === true` 时调用 `upgradeHold.set(true)` 与 `upgradeHold.since()/setSince()`；但 `createUpgradeHold` 只导出 `{ enter, enterAsync, exit }`，调用即 `TypeError`，被 `loadState` 外层 `catch {}` 吞掉。
- 后果：升级 hold 不跨守卫重启保持；二进制替换/升级窗口内可能按 `desired=running` 拉起正在被替换的 DSH。
- 修法：使用真实导出 —— `if (raw.upgradeHold === true) upgradeHold.enter();`。

---

## 可观测行为变化（必须记录）

1. `uninstall` 的锁在 stop 钩子 await 之前置位：并发卸载/安装请求会更早被拒，不再有 await 间隙双入。
2. `startInstall` 在 `upgradeState` 非终态时返回 `{ ok: false, error: '升级进行中，请稍后再装（state=...）' }`。此前未安装 `installing` 时会继续走后台安装。
3. 恢复升级 hold 由空操作（被吞的 TypeError）变为真实 `enter()`：除置 hold 外，还会按 `enter` 既有语义在目标存活时 `stopProcess('upgrade')`、在 phase 非 STOPPED 时置 STOPPED 并写状态。属恢复预期语义，非新增契约。

## 兼容性

- 对外导出面不变：`ops.js` 仍导出 `{ status, checkUpdate, install, startInstall, startUninstall, uninstall }`；`store.js` 仍导出 `{ createStore }`，返回 `{ writeState, loadState, migrateMainRecord }`。
- 安装失败/卸载失败的任务注册、事件名、返回字段、超时文案均保持。

## 静态核验

- `node --check src/app/native/ops.js` 与 `node --check src/app/state/store.js` 通过。
- `test/native-op-mutex-test.js` 断言对象是 `installer.js`（未改动），K-a/b/c/d 仍成立；`startInstall` 的 busy 闸不影响该测试注入的 `upgradeState='idle'` 反向用例。
- `test/uninstall-timeout-test.js` 锁定的结构（UNINSTALL_TIMEOUT_MS、setTimeout/clearTimeout、done 幂等、killTree、`} finally {` 内释放锁、timedOut/可重试文案、失败保留 manifest）在重排后仍全部位于 `host.uninstalling = true;` 到 `module.exports` 的区间内。
- `grep` 确认全仓（src/ + test/）无其他引用 `upgradeHold.set/since/setSince` 的调用点；测试未钉住被替换的字符串。
