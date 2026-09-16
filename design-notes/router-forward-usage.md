# router 域 · 转发与用量 功能设计（D3，主代理亲撰）

> 依据：`DOMAIN-DESIGN-BRIEF.md` §5 + `design-notes/_RULING.md` R1–R12。行号来自实际 read。**只做设计**。

## A. 现状审计

### A.1 文件清单

| 文件 | 行数 | 当前职责 | 问题 |
|---|---|---|---|
| `forward-core.js` | 548 | HTTP 转发核心 | **5 类职责混放**（解析/传输/账本/计数） |
| `router-ops.js` | 665 | 运维操作 | **7 段互不相关**（browser/OAuth/应用注册表/配额/单价/账号辅助） |

### A.2 forward-core.js 段结构（实测）

```
:31  readUpstreamBody(ur, maxBytes, timeoutMs)   纯（上游响应读取）
:54  joinUpstream(base, reqPath, rawQuery)      纯（URL 拼接）
:63  extractUsage(text)                          纯（用量提取）
:92  sleep(ms)                                   纯
:98  estimateCost(entry)                         纯（费用估算）
:135 instOf(prov, acc)                           纯
:146 resolveTarget(self, acc, prov)              纯（选目标）
:148-290  请求主流程（重试循环、SSE strip、错误分类） IO
:321 writeThrough(req,res,out,acc,prov,meta)      IO（流式透传）
:410 _beginInflight(acc) / :411 _endInflight(...) 内存态
:429 forwardOnce(...)                             IO
:476 recordUsage(entry)                           IO（记账）
:503 _writeTotals()                               IO（原子写）
:519 recordError() / :525 _loadTotals() / :541 getUsage()  IO
```

### A.3 router-ops.js 段结构（实测，7 段）

```
:50  graphicalEnv()              图形环境探测（IO）
:86  openInBrowser(url, onExit)  打开浏览器（IO）
:134 【段】Command Code OAuth 一键登录（OAuth 流程，IO + 状态）
:271 【段】反代应用注册表与更新（PROXY_APPS 管理，IO）
:436 【段】官方配额与价格同步（直连供应商，网络 IO）
:462 【段】官方单价同步 models.dev（网络 IO + 全局定价索引）
:514 【段】账号/供应商管理辅助（纯映射 + CRUD 辅助）
```

### A.4 病症清单

1. **DF-2 违规**：两文件 548 / 665 行，均 > 400。
2. **DF-3 违规**：`forward-core.js` 的 8 个**纯函数**（:31-146）与 IO 混放；
   `router-ops.js` 的 7 段彼此无关，纯映射与网络 IO 混放。
3. **职责错位**：`forward-core.js` 名为「转发核心」，实为「转发 + 用量账本 + 在途计数」。
4. **⚠ 真缺陷（D3 前次实测）**：`writeThrough` 的 `decInflight`（:331-337）只做 `_retryPendingStop`，
   **不做** `flushRestartPending`；而 `_endInflight`（:411-427）两者都做 →
   **2xx 流式成功路径永不补做「在途期间被延后的实例重启」**。
5. **⚠ 数据一致性（D1 实测）**：用量文件读写散在 `:503-539`，`.tmp` 命名与 `store.js:47` **不一致**。

## B. 功能切面（★ 核心）

| 功能块 | 职责 | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **F1 上游响应读取** | 读上游 body（限长/超时） | url | text | 网络 IO | ✗ |
| **F2 URL/请求映射** | 拼上游 URL、提取 model/stream 标记 | req | target | 无 | 纯 |
| **F3 用量解析** | 从响应文本提取 usage | text | usage | 无 | 纯 |
| **F4 费用估算** | 按单价快照估费 | usage | cost | 无 | 纯 |
| **F5 目标解析** | 选 provider/account/instance | self+acc+prov | target | 无 | 纯 |
| **F6 重试编排** | 重试循环、错误分类、strip 注入重试 | req | 结果 | 网络 IO | ✗ |
| **F7 流式透传** | 上游→客户端透传 + 头复制 | upstream | client | 网络 IO | ✗ |
| **F8 在途计数** | inflight 增减 + 延后重启补做 | acc | — | 无 | 纯状态 |
| **F9 用量账本** | 记账 + 原子落盘 + 按 key/model 聚合 | entry | 文件 | IO | ✗ |
| **F10 错误记账** | 错误计数 | err | — | 无 | 纯状态 |
| **F11 图形环境** | 探测图形环境 | — | bool | IO | ✗ |
| **F12 打开浏览器** | 打开 URL | url | — | 进程 IO | ✗ |
| **F13 OAuth 流程** | 一键登录（授权码/回调） | — | token | 网络 IO + 状态 | ✗ |
| **F14 应用注册表** | PROXY_APPS / proxy-apps 管理 | — | 注册表 | IO | ✗ |
| **F15 配额同步** | 拉官方配额 | provider | quota | 网络 IO | ✗ |
| **F16 单价同步** | 拉 models.dev 单价 + 全局定价索引 | — | 定价 | 网络 IO | ✗ |
| **F17 账号辅助** | 账号/供应商映射辅助 | 输入 | 结果 | 无 | 纯 |

## C. 目标结构

### C.1 forward-core.js（548 → 5 文件）

| 新文件 | 行数 | 职责 | 来源 | 纯? |
|---|---|---|---|---|
| `handlers/parse.js` | ≤140 | F2 URL 映射 + F3 用量解析 + F5 目标解析 | :31-146 | ✅ 纯 |
| `handlers/forward.js` | ≤330 | F1 + F6 重试 + F7 流式透传 | :148-290, :321, :429 | ✗ IO |
| `store/usage.js` | ≤160 | F9 用量账本（原子写，**统一 `.tmp` 命名**） | :476-539 | ✗ IO |
| `model/inflight.js` | ≤90 | F8 在途计数 + F10 错误计数 | :410-427, :519 | ✅ 纯状态 |
| `forward-core.js` | ≤120 | 门面：组合上述，导出 `forwardMethods` | 保留 | — |

### C.2 router-ops.js（665 → 6 文件）

| 新文件 | 行数 | 职责 | 来源段 |
|---|---|---|---|
| `ops/browser.js` | ≤140 | F11 图形环境 + F12 打开浏览器 | :50-133 |
| `ops/oauth.js` | ≤190 | F13 OAuth 一键登录 | :134-270 |
| `ops/apps-registry.js` | ≤230 | F14 应用注册表与更新 | :271-435 |
| `ops/quotasync.js` | ≤140 | F15 配额 + F16 单价同步 | :436-513 |
| `ops/admin.js` | ≤200 | F17 账号/供应商管理辅助 | :514-665 |
| `router-ops.js` | ≤100 | 门面：组合导出 `auxMethods` | 保留 |

⚠ **R2 遵守**：`handlers/`、`store/`、`model/`、`ops/` **均在 R2 白名单内**。
⚠ **行数自检**：`handlers/forward.js` 目标 ≤330（若超 400，把 F7 流式透传再拆 `handlers/stream.js`）。

## D. 依赖图（DAG）

```
forward-core.js（门面）→ handlers/forward.js → handlers/parse.js（纯）
                      → store/usage.js   → platform/util/fs
                      → model/inflight.js（纯）

router-ops.js（门面）→ ops/{browser,oauth,apps-registry,quotasync,admin}.js
                       └→ providers/base.js（maskKey 等，向下）
```

⚠ 当前 `forward-core.js` 的 `this.log`/`this.readBody`/`this.canPersist`（指向 `index.js:530/535/154`）
   由 **A/B 手法**消解 → 边界干净。

## E. `this` 隐式耦合消解表

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.log(line)` | forward-core→index | **B（注入）** | `handlers/forward.js` ctor 注入 `logger` |
| `this.readBody(req)` | forward-core→index | **A（具名导出）** | 移入 `handlers/parse.js`（纯，可单测） |
| `this.canPersist()` | forward-core:508 →index | **B（注入）** | 注入 `canPersist` 谓词（**写权闸单源**，D1 的 H-RG-11） |
| `this.getProvider()` | router-ops 6 处 →index | **B（注入）** | 注入 `getProvider` |
| `this._loadTotals()`/`getUsage()` | forward-core 内 | **B** | 改 `store/usage.js` 实例方法 |

## F. 迁移步骤

| 步 | 动作 | 影响 | 验证 |
|---|---|---|---|
| 1 | 建 `handlers/parse.js`（纯，搬迁零改写） | 新文件 | 纯函数单测 |
| 2 | 建 `model/inflight.js`（纯状态） | 新文件 | 单测 |
| 3 | 建 `store/usage.js`（含 `.tmp` 统一） | 新文件 | `round13-robustness-batch-test` |
| 4 | 建 `handlers/forward.js`（IO） | 新文件 | `router-test` |
| 5 | `forward-core.js` 瘦身 ≤120（门面 + 注入） | forward-core.js | 全 router 测试 |
| 6 | 建 `ops/*` 五文件（逐段搬迁） | 新文件 | 各自相关测试 |
| 7 | `router-ops.js` 瘦身 ≤100（门面） | router-ops.js | `p2p-router-test` |
| 8 | **⚠ 行为修正**：统一 inflight 结束为单一 `end()` + 显式 effect（补 `flushRestartPending`） | `model/inflight.js` | **专项回归**（见 G.1） |

⚠ **步 8 必须独立提交**（它是**行为变更**，不与纯结构步混提）—— D3 前次已明确要求。

## G. 风险与取舍

### G.1 步 8 的行为变更（★ 必须回归）
- **缺陷**：流式成功路径不补做被延后的实例重启；
- **修法**：`model/inflight.js` 提供单一 `end(acc, prov, {effects})`，两种路径都执行 `effects`；
- **回归风险**：可能**增加**实例重启次数 → 需 `heartbeat-selfheal-test` + `router-test` 双重验证；
- **若回归不稳**：保留旧行为 + 记 TODO（**不阻塞结构拆分**）。

### G.2 破坏性改动（点名消费方）
- `forwardMethods` / `auxMethods` 是 `index.js:758-759` 的 `Object.assign` 源（**R6 判据命中点**）；
  **拆分后必须删除该 `Object.assign`**（改 ctor 注入）—— 这正是 DF-4/DF-5 的落地；
- 消费方：`router/index.js`（注入）、`api/domains/router.js`（经 RouterService）。

### G.3 考察后不做的部分
- **`router-ops.js` 不按 D5 的「三分」** —— 实测它有 **7 段**，三分会把不相关段硬捆一起；
  本设计按**段边界**切五分（每段一个语义单元），更符合 §2 第四刀（按角色切）；
- **`quota-strategies.js` 保持原位**（已是策略模式，无需再动）。

### G.4 4 个内容 pin 门禁（D1 已点名，**必须同步改**）
- `round13-robustness-batch-test.js:151-152`（断言 index.js 含 `canPersist()`）；
- `provider-gateway-gate-test.js:203-211`（断言 forward-core.js 的 `_writeTotals` 体含 `canPersist()`）；
- `kernel-daemon-contract-test.js:78-79`；
- `round13-router-relay-gaps-test.js:119-127`。

## H. 门禁建议

| 编号 | 判据 | 反向自检 |
|---|---|---|
| PG-D3-1 | `forward-core.js`/`router-ops.js` ≤400（拆后门面 ≤120/≤100） | 401 行样本 FAIL |
| PG-D3-2 | `handlers/parse.js`、`model/inflight.js` **纯**（无 IO require） | 构造 fs require 样本 FAIL |
| PG-D3-3 | 用量文件 `.tmp` 命名**全域唯一**（与 store.js 一致） | 构造两个不同 tmp 名 FAIL |
| PG-D3-4 | inflight 的**两条结束路径 effect 一致** | 构造只做一半的样本 FAIL |
| PG-D3-5（R6） | 无 `Object.(assign|defineProperties)(X.prototype, require(...))`，**先剥注释** | 变量右值样本 |

## I. DF 自检

| 判据 | 现状 | 设计后 |
|---|---|---|
| DF-2 ≤400 | ❌ 548/665 | ✅ 最大 330 |
| DF-3 纯/IO | ❌ | ✅ |
| DF-4 零隐式 this | ❌（9 处指向 index） | ✅ 注入 |
| DF-5 DAG | ✅ | ✅ |
| DF-6 可单测 | ❌ | ✅ parse/inflight 可单测 |
| DF-7 单向 | ✅ | ✅ |
