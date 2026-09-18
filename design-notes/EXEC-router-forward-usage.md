# EXEC · router 域「转发与用量 + 运维」结构改造

> 域：router（内核，纯 JS）｜依据：`EXECUTION-CONTRACT.md` §3.2 + `DOMAIN-STRUCTURE-DESIGN.md` §5.1
> + `design-notes/router-forward-usage.md`。范围文件：`forward-core.js, router-ops.js, handlers/*, ops/*, store/usage.js, model/inflight.js`。

## 1. 实际改动（行数）

### 1.1 forward-core.js（548 → 71 门面）

| 文件 | 行数 | 职责 | 来源 |
|---|---|---|---|
| `handlers/parse.js` | 109 | **纯**：URL/请求映射 `parseRequest`、用量解析 `extractUsage`、费用 `estimateCost`、目标解析 `instOf/resolveTarget`、`joinUpstream`、`readBody` | `:31-146` + index.js:535 |
| `handlers/forward.js` | 294 | **IO**：`readUpstreamBody` + 重试循环 `proxyFor` + 流式透传 `writeThrough` + `forwardOnce` + `endInflight` | `:148-290,:321,:429` |
| `store/usage.js` | 102 | `UsageLedger`：记账 + byKey/byModel 聚合 + 原子落盘 + 汇总 | `:476-539` |
| `model/inflight.js` | 57 | **纯状态**：在途计数 + 错误计数；单一 `end()` 返回显式 effects | `:410-427,:519` |
| `forward-core.js` | 71 | 门面：组合 + `forwardMethods`/`createForwardCore(deps)` | 保留 |

### 1.2 router-ops.js（665 → 73 门面）

| 文件 | 行数 | 职责 | 来源段 |
|---|---|---|---|
| `ops/browser.js` | 82 | `graphicalEnv` + `openInBrowser` | `:50-133` |
| `ops/oauth.js` | 135 | `createOAuthOps`：OAuth 一键登录（状态收敛于闭包） | `:134-270` |
| `ops/apps-registry.js` | 158 | `createAppsRegistryOps`：应用注册表 + 更新 job | `:271-435` |
| `ops/quotasync.js` | 90 | `createQuotaSyncOps`：配额 + 单价同步 | `:436-513` |
| `ops/admin.js` | 131 | `createAdminOps`：账号/供应商辅助 | `:514-665` |
| `router-ops.js` | 73 | 门面：组合 + `auxMethods`/`createAuxCore(deps)` | 保留 |

## 2. ★ 独立行为变更：在途结束 effect 统一（PG-D3-4）

**旧缺陷**：`writeThrough` 的 `decInflight`（forward-core:331-337）只做 `_retryPendingStop`；
`_endInflight`（:411-427）两者都做 → **2xx 流式成功路径永不补做「在途期间被延后的实例重启」**。

**改法**：
- `model/inflight.js#end(acc, {prov, inst, lifecycle})` 为**唯一**递减入口，归零时返回
  `effects = [{kind:'retryPendingStop'}, {kind:'flushRestartPending'}]`（纯描述）；
- `handlers/forward.js#endInflight(acc, prov)` 是**唯一执行器**，对 effects 全部执行；
- `writeThrough` 的 `finishOK`（2xx 成功）、`finishAborted`、`res.close`，以及 `proxyFor` 的
  全部错误/中断/换号路径，统一调用 `endInflight` → **两条路径 effect 一致**。

**回归证据**：
- 纯单测证明：`endInflight` 归零时 `_retryPendingStop` 与 `flushRestartPending` 均被调用；
  未归零时均不调用（已断言）。
- `heartbeat-selfheal-test` 16/0、`router-test` 19/0、`router-e2e-test` 4/0、
  `p2p-router-test` 43/0 —— 未出现重启次数增加导致的不稳。
- `test/router-circuit-breaker-test.js` 新增锁：`R-c 单一 end() 生成 flushRestartPending effect`
  与 `R-e 流式成功与中断路径共用 endInflight`（防回退）。

## 3. `this` 消解（指向 index.js 的 9 处）

| 旧调用 | 手法 | 新形态 |
|---|---|---|
| `this.log`（forward 9 处） | 注入 | `createForwarder({log})`；叶子零 this |
| `this.readBody` | 具名导出 | `handlers/parse.js#readBody`（forward 默认取用） |
| `this.canPersist` | 注入 | `UsageLedger({canPersist})`（由 index 注入 `this.store.canPersist`） |
| `this.getProvider`（ops 6 处） | 注入 | `ops/admin.js#findProvider` |
| `this.switcher/events/modelPriceIndex/_agent*/usageTotalsFile` | 注入 | `createForwardCore(deps)` |
| `this._save/proxyUpdateCache/tasks/dist/modelPriceIndex` | 注入 | `createAuxCore(deps)` |

实测：叶子/ops 文件内**零** `this.<index方法>`（store/usage 的 `this.*` 为类自身实例状态）；
forward-core/router-ops 仅以 `coreFor(this)`/`auxCoreFor` 传 host，未访问 host 业务方法属性。

## 4. 与 RT1 的集成（已实测）

RT1 的 `index.js:51/56` 分别以显式 deps 调用：

```js
this._forward = createForwardCore({ log, logger, canPersist, switcher, events, usageTotalsFile, getPricing, agents });
this._aux     = createAuxCore({ getProviders, findProvider, save, proxyUpdateCache, dist, events, tasks, logger, setPriceIndex });
```

与实现**逐字匹配**；`require('./src/domains/router')` 可加载，`this._forward.usage.getUsage()` /
`this._forward.recordError()` 也被 RT1 直接消费（均已提供）。
`forwardMethods`/`auxMethods` 作为**过渡兼容面**仍导出（RT1 已删除 Object.assign，不再使用）。

## 5. 与设计稿的偏差（如实记录）

1. `handlers/parse.js` 额外导出 `estimateCost/instOf/readBody/parseRequest`（§3.2 只列 4 个必需导出）；
   `createForwarder` 额外注入 `usage/inflight/switcher/events/getPricing/agents/maskKey`
   （§3.2 只列 `logger/readBody/canPersist/parse` 为必需项）——为让叶子不持有 IO/状态。
2. `store/usage.js` 直接 require `node:fs/node:path`：`platform/util/fs` 仅有 `dirSizeBytes`，
   无原子写工具；`keyFingerprint/estimateCost/canPersist` 经注入（依赖倒置），未 require providers/parse。
3. `ops/*` 采用工厂 + 显式 deps（而非裸具名导出），以承载 OAuth/job 等闭包状态；
   `router-ops.js` 额外导出 `createAuxCore(deps)`（RT1 使用）。
4. SSOT R2 白名单原缺 `ops`（与 §5.1 目标树冲突）；`test/directory-structure-gate-test.js`
   的 ALLOWED 已由门禁侧补入 `ops`，本模块据此建 `ops/`。
5. `.tmp` 命名统一为 `<file>.tmp.<pid>.<ts>`，与 RT1 `store.js` 一致。

## 6. 同步改的既有门禁（pin 改指向）

| 门禁 | 改动 |
|---|---|
| `router-circuit-breaker-test.js` | `forward-core.js` → `handlers/forward.js` + `model/inflight.js`；补 2 条行为修复锁 |
| `probe-gate-and-ownership-test.js` | E-d/E-e/E-f/E-g 的 ops 源 → `ops/admin.js`/`ops/apps-registry.js`/`ops/oauth.js`；E-g 正则兼容 `async function` |
| `provider-gateway-gate-test.js` | （已由门禁侧）PG-7 用量落盘指向 `store/usage.js`；PG-4 预算指向 `handlers/forward.js` |
| `round13-router-relay-gaps-test.js` | （已由 F1）删除路径源集合含 `ops/admin.js` |

## 7. DF 自检

| 判据 | 结果 |
|---|---|
| DF-1 门面 ≤150 | forward-core 71 / router-ops 73 ✅ |
| DF-2 单文件 ≤400 | 最大 `handlers/forward.js` 294 ✅ |
| DF-3 纯/IO 不混 | parse/inflight 纯；forward/usage/ops IO ✅ |
| DF-4 零跨文件 this | 叶子/ops 0；门面仅 `coreFor(this)` ✅ |
| DF-5 无方法集合同一 this | 无 prototype mixin（index.js Object.assign 已由 RT1 删除）✅ |
| DF-6 可独立单测 | parse/inflight/usage 已单独 require 验证 ✅ |
| DF-7 单向依赖 | forward-core→handlers→parse / →store/usage / →model/inflight；router-ops→ops/* ✅ |

## 8. 遗留 / 非本范围仍红

1. `probe-gate` E-a 2 条：`providers/base.js` `applyDetection` 体内已无 `acc.lastProbeError = null;`，
   判据抓空 → **router-providers 代理**（非本文件）。
2. `provider-gateway-gate` PG-4（`DEFAULT_MAX_HOT/_switchBudgetMs`）、PG-6：`providers/proxy.js`
   处于并发改造中间态（曾 23/0，现 20/3）→ **router-providers 代理**。
3. `round13-router-relay-gaps` patchDshMain 4 条 → **R1**（D-5）。
4. `directory-structure-gate`：hard 16/0 ✅；soft/report-only 仅 DS-G3b(`supervisor.js` Object.assign)
   与 DS-9（全仓既有大文件），非本模块。
5. `store.js#writeUsage` 与 `UsageLedger` 双写口：index.js 仅用 `UsageLedger` 写、`store.readUsage` 读，
   同一文件同一格式（`.tmp` 一致）暂不冲突；**建议后续收口为单源**（RT1 范围）。

## 9. 验证命令（实跑）

```
node --check <每个新文件>
node test/router-test.js            # 19/0
node test/p2p-router-test.js        # 43/0
node test/router-e2e-test.js        # 4/0
node test/heartbeat-selfheal-test.js# 16/0
node test/token-boundary-test.js    # 12/0
node test/adopt-token-reclaim-test.js # 27/0
node test/round13-robustness-batch-test.js # 22/0
node test/router-circuit-breaker-test.js   # 16/0（含行为修复锁）
node test/directory-structure-gate-test.js # hard 16/0
node test/layering-and-dependency-gate-test.js # 10/0
```
