# EXEC3 · 最根部下探（R3-G 六文件拆分）

> 轮次：域结构改造第三轮（DF-1..DF-9，单文件 ≤300）。
> 范围（独占归属 R3-G）：`domains/relay/ops.js`、`domains/router/providers/{proxy,probe}.js`、
> `domains/plugin/market.js`、`domains/instance/upgrade.js`；原派工含
> `platform/service/tasks.js`，后主代理裁决 `platform/service/**` 归 R3-C，已让路（见 §5）。

## §1 结果（全部 ≤300，导出面不变）

| 文件 | 前 | 后 | 新增叶子 |
|---|---|---|---|
| `domains/relay/ops.js` | 396 | **260** | `ops/reconcile.js`(115)、`ops/lan-servers.js`(94) |
| `domains/router/providers/probe.js` | 312 | **271** | `providers/pkg-cache.js`(53) |
| `domains/router/providers/proxy.js` | 389 | **281** | `providers/instance-lifecycle.js`(135) |
| `domains/plugin/market.js` | 332 | **277** | `policies/classify.js`(38)、`policies/market-entry.js`(40)、`store/market-cache.js`(28) |
| `domains/instance/upgrade.js` | 327 | **228** | `ops/dsh-install.js`(143) |

全部新增文件位于白名单子目录（`ops`/`providers`/`policies`/`store`），rank 均已登记，无新增 DG-7 违规。

## §2 切法（四把刀 + 显式依赖）

- **relay/ops.js**：`LanManager` 保留门面方法与 `syncProxy`（测试源码锚点）；对账主体、
  目标探活、实例联动委托 `ops/reconcile.js`；监听服务生命周期委托 `ops/lan-servers.js`。
  被抽方法保留同名 1 行包装（`_reconcileOnce/targetReachable/_syncProxyQueued/removeProxyForInstance/
  instanceStart/instanceStop/_startLanServer/_handleRelayListenFail/_stopLanServer/shutdown/applyToken`），
  使 `this.X()` 仍为「本文件定义」→ DF-4 不新增跨文件 this。
- **probe.js**：npm 缓存定位/预取抽到 `pkg-cache.js`；**两处内联 `require`**（`node:child_process`、
  `state-root`）抬到模块顶层（DF-8）；`probe.js` 重新导出 `cachedPkgBin/ensurePkgCached`，proxy 调用面不变。
- **proxy.js**：停止仲裁/停止补刀、加账号、探活、可用性判定抽到 `instance-lifecycle.js`；
  7 个同名包装保留在类上（外部调用点与测试打桩不变）。`restartInstance/markUsed/markRequestOk/
  markInstanceProblem/markInstanceNetFail/flushRestartPending` 及池方法因源码门禁/能力门禁留在本文件。
- **market.js**：纯分类与作者启发 → `policies/classify.js`；缓存读写 → `store/market-cache.js`；
  条目工厂 → `policies/market-entry.js`。**两个批次循环体（indexNpm/indexCommunity）与
  `buildIndex` 的 `finally { this._deadline = 0; }` 逐字保留**（market-budget-test M-d 按本文件源码断言）。
- **upgrade.js**：安装/版本读查 → `ops/dsh-install.js`（`createDshInstall(deps)`）；upgrade.js 保留
  `createUpgrade` 的编排、作业视图、状态机与回收；返回对象 9 个键逐字不变。

## §3 DF-8 / DF-9（本文件自查，正则 + 括号计数）

- **DF-8**：13 个文件扫描 `require(` 所处花括号深度 >0 者 = 0（原 probe.js 两处已抬顶）。
- **DF-9**：逐行累计 `{}` 净值取最大，全部 ≤6：
  relay/ops 6、reconcile 3、lan-servers 3、proxy 5、probe 6、pkg-cache 5、instance-lifecycle 4、
  market 6、classify 3、market-entry 2、market-cache 3、upgrade 6、dsh-install 6。
  为达此值提名的具名函数：`applyRelayToken`、`onRelayBindingLost`、`addCommunityLink`、
  `npmEntry/githubEntry`、`taskLogger`、`portHealthOpts`、`installTimeoutWatchdog`、`pushInstallLog`。
- 未使用 acorn/espree/任何 AST 库；未改 `package.json` 依赖。

## §4 验证（实跑，全绿）

相关测试（50 个，含三结构门禁）：relay 12（reconcile-single-flight/ports-verify/relay-source-gate/
relay-dshauth/lan-daemon/session-lifecycle/graceful-shutdown/frp-*/lan-access-boundary/round13-frpc）、
router 17（p2p-router/ensure-instance/reconcile-instance/commandcode-quota/upstream-credits/
freeze-recovery/router-circuit-breaker/provider-gateway-gate/kernel-daemon-contract/router-*/monthly-credits/
p2p-api/main-port-rederive/native-dsh-binding/round13-robustness/round13-discipline/platform-capability-audit/
switch-policies/ports-*）、plugin 3（market-budget/round8-fixes/plugin-change-restart）、
instance 4（upgrade/state/safety/systemd-aside-behavior）、smoke/core/api-surface/test-chain-completeness。
**退出码全部 0**。

源码锚点保持：
- `reconcile-single-flight`：`_reconcileInFlight` / `async _reconcileOnce()` 仍在 ops.js（主体委托）。
- `round13-router-relay-gaps` ②：ops.js 仍含 `existing.token !== want` 与 `setToken(want)`（后者在
  `applyRelayToken`）。
- `ports-capacity`：ops.js 仍含 `rangeOf('relay')`（syncProxy 未迁走）。
- `market-budget` M-d：market.js 仍含两个批次循环与 `_budgetExhausted()` 前置检查。
- `instance-safety` L-a：`version: oldVersion` 在 upgrade.js 恰 1 处（回滚参数对象）。
- `provider-gateway/kernel-daemon-contract/router-circuit-breaker` 的 proxy.js 断言全绿。

## §5 偏差与遗留

1. **platform/service/tasks.js 让路 R3-C**：首轮已按「持久化抽 `task-store.js`」拆分并实跑全绿，
   随后主代理裁决 `platform/service/**` 归 R3-C，遂**回退**。R3-C 已独立重建同形态
   （tasks.js 290 / task-store.js 62，`task-registry-test` 全绿），故本轮成果仍在，归属 R3-C。
2. **非我文件的门禁/测试失败（预期，未代修）**：
   - `round13-router-relay-gaps-test.js` 行为段因 `app/domain-actions/main.js` 在途改动而失败（R3-E）；
     其 relay ①② 源码断言 PASS。
   - `adopt-token-reclaim-test.js` 因 `platform/service/token/pool.js` 重复声明 `configureKindInference`
     失败（R3-C 在途）。
3. **★ 门禁自身硬失败（需 R3-J 处理）**：`domain-structure-gate-test.js` 的
   `DG-2 反向：真实超限 ≥1（非空转）` 现报 `count=0` —— 全域已无 >400 行文件（R3-C 拆完 `log/hub.js` 后），
   该自检以「真实超限」为前提 → HARD FAIL。本轮 DF-2 取严到 300 后应把该自检改为合成样本或随阈值更新。
   （report-only 下门禁仍 exit 0，但 `DG_STRICT=1`/转硬后必红。）
4. 本域 `contract.js` 仍未建（DG-3/4b/9/10 软红），属后续轮次。
