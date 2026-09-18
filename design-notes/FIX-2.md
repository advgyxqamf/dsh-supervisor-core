# FIX-2 api-rebind 端口登记未定义 + bootstrap daemon 提前返回 + controller 端口再推导分叉

> 范围（独占）：`src/app/assembly/api-rebind.js`、`src/app/assembly/bootstrap.js`、`src/app/main/controller.js`。
> 纪律：缺陷修复非重构，最小改动，保持对外契约。未运行任何测试，仅用 `node --check` / `grep` / `git diff` 静态核验；未启动 daemon，未 commit/push，未改版本号，未加依赖。

---

## 缺陷 A：api-rebind 引用未定义标识符 ports

- 位置：`src/app/assembly/api-rebind.js:41`、`:77`（修改前行号）。
- 现象：文件顶部只绑定 `portsShared`（`require('.../ports').shared`），但两处调用 `ports.register('supervisor-api', ...)`；`:41` 的 catch 还是空块。
- 后果：调用抛 `ReferenceError`。`startApi` 因 `EADDRINUSE` 顺延端口时，先 `portsShared.release(prev, 'system:supervisor-api')` 成功，再 `ports.register(actual)` 抛错并被吞（`:41` 静默 / `:77` 仅 warn），`supervisor-api` 从 ports.json 整体消失。壳的就绪判据取该登记（KERNEL-DAEMON-CONTRACT D3），因而永远等不到就绪。
- 修法：`:41` 与 `:77` 均改为 `portsShared.register(...)`；`:41` 的空 catch 改为 `host.logger.warn`，不再静默吞错。
- 未改：注册时机（listen 回调内）、登记的端口值（`:41` 用 `host.config.apiPort`，`:77` 用实际 `port`）、`:72` 的释放语义与 owner 字符串均不变。

## 缺陷 B：bootstrap 在 router daemon 分支提前 return

- 位置：`src/app/assembly/bootstrap.js`（修改前约 110 行 `return;`）。
- 现象：`routerAutostart === true` 且 `_ensureRouterRuntime` 返回 `mode === 'daemon'` 时执行 `return;`，整体退出 `_bootstrap`。
- 后果：`return` 之后的更新检查定时器（`_initialCheckTimer` / `_upgradeTimer`）与壳看护（`_startShellWatchdog`）全部被跳过；即 daemon 模式下更新检查与壳看护不启动。
- 修法（最小）：删去 `return;`，把内嵌 router 启动改为 `if (rt.mode !== 'daemon') host.router.start()...` 条件执行。daemon 分支只跳过内嵌启动，其余启动序列继续。
- 未改：daemon 分支内 `_disableRouterPersist()`、就绪短轮询、phase 镜像全部保持；内嵌回退路径的 `.then` 回调逻辑不变。

## 缺陷 C：controller 忽略 applyPort 返回值并强制改 config

- 位置：`src/app/main/controller.js`（修改前约 55-57 行）。
- 现象：`this.main.applyPort(found.port, found.pid)` 的返回值被忽略，紧接无条件 `this.config.targetPort = found.port;`。
- 后果：`applyMainPort` 在 `ports.register('dsh-main', newPort)` 被拒时返回 false 且明确不改 config / healthUrl（见 `src/app/main/port-rederive.js:49-70`）；controller 的强制赋值使 `config.targetPort` 与注册表、`healthUrl` 分叉，恰好触发 `applyMainPort` 头注要防的失效模式。
- 修法（最小）：改为 `if (this.main.applyPort(found.port, found.pid)) { this.config.targetPort = found.port; }`，与 `src/app/main/process.js:183` 的既有调用点形态一致。同时修正该处「更正后本 tick 重探一次」的不实注释（本拍并未重探）。
- 未改：30s 节流、`found` 判定条件、后续状态机分支均不变。

---

## 可观测行为变化（必须记录）

1. 端口顺延（EADDRINUSE）时 `supervisor-api` 现在会真正登记为实际监听端口；此前该登记因 `ReferenceError` 丢失，壳的就绪判据恢复可用。
2. `_rebindApiHost` 重绑成功后的登记失败不再静默，会记 warn（文案 `ports.register(supervisor-api) 失败: ...`）。
3. `routerAutostart === true` 且 router 走独立 daemon 时，守卫现在会继续启动更新检查定时器与壳看护；此前被整体跳过。
4. `applyPort` 失败（dsh-main register 被拒）时不再改 `config.targetPort`：守卫保持在旧端口的观测与收敛，与注册表、`healthUrl` 一致；此前会单方面改成 `found.port` 造成分叉。

以上均为缺陷修复的预期语义。对外导出面、事件名、日志主干文案（除新增一条 warn 与一处注释）未变。

## 测试同步（被断言钉住的字符串）

- `test/kernel-daemon-contract-test.js` 的 D-2 / D-6 以正则 `/ports\.register\('supervisor-api'.../` 钉住实现形态。改名为 `portsShared` 后该正则失配，故同步放宽为 `/ports(?:Shared)?\.register\('supervisor-api'.../`（3 处：D-2、D-6 正/反向 `registersActual`）。
- 不变量未放宽：仍要求「存在对 supervisor-api 的 register 调用」且「登记的实参是实际端口变量 `port`」；反向用例 `ports.register('supervisor-api', this.config.apiPort)` 仍被判为未落实。
- 其余测试未钉住本次改动字符串。
- 说明：test/ 不在本任务独占范围内，此处按任务纪律「若改动了被测试断言钉住的字符串，同步改测试」执行，请主代理确认。

## 静态核验

- `node --check` 通过：`src/app/assembly/api-rebind.js`、`src/app/assembly/bootstrap.js`、`src/app/main/controller.js`、`test/kernel-daemon-contract-test.js`。
- `grep` 确认 `api-rebind.js` 内已无裸 `ports.register(...)` 调用（仅剩两处 `portsShared.register`，以及 warn 字符串文案中的 `ports.register` 字样）。
- 未在本机运行任何测试（硬约束）。
