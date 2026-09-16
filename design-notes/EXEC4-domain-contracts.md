# EXEC4 · 五域 contract.js（域契约声明）与 DG-3/4b/9/10 收口

> 主题：为 instance / plugin / relay / router / shell 五域建 `src/domains/<域>/contract.js`，
> 一次解决 4 条同根软红：**DG-3**（contract.pure 未声明）、**DG-4b**（契约豁免无出处）、
> **DG-9**（contract.exports 双向一致）、**DG-10**（消费方成员 ⊆ PUBLIC_API）。
> 纪律：只新建 contract.js（纯数据，零 require）+ 两处必要门禁对齐；不改其它文件逻辑。

## 1. 实际改动

### 1.1 新增 5 个 contract.js（纯数据，零 require、零副作用）

| 文件 | exports（≡ index.js，DG-9） | PUBLIC_API（DG-10） | pure（DG-3） |
|---|---|---|---|
| `src/domains/instance/contract.js` | `InstanceManager` | 25 项（含 `all/forEach/find/map` 查询接口 + 6 hooks + 沙箱路径） | 3 |
| `src/domains/plugin/contract.js` | `PluginManager`, `PluginMarket`, `PROTECTED` | 22 项（PluginManager + PluginMarket.getIndex） | 4 |
| `src/domains/relay/contract.js` | `createRelay`, `LanManager`, `FrpManager`, `frpPlatformTag`, `downloadUrls` | 26 项（LanManager + FrpManager + 导出） | 1 |
| `src/domains/router/contract.js` | `RouterService` | 40 项（生命周期/视图/注册表/转发/运维/静态 presets + providers getter） | 12 |
| `src/domains/shell/contract.js` | 10 键（逐字冻结） | 同 exports | 1 |

每文件结构：`{ domain, exports, PUBLIC_API, classApi, deps(+hooks), hooks, pure, exempt }`；
`deps.hooks` 同时是 **DG-4b 的豁免出处**（instance 6 个出站回调 / plugin onNativeRestart /
relay persist·mainOf·tokenOf / router onPersist·_ccLoginReject·_ccLoginResolve）。

### 1.2 门禁对齐（2 处，必要修正，非逻辑放宽）

1. **DG-10 读错误的面**：判据名与 SSOT（`design-notes/domain-contract-and-gates.md` B.1.4/B.3.10）
   都是「消费方 ⊆ **PUBLIC_API**」，但实现读的是 `c.exports`。而 `exports` 被 DG-9 要求
   **逐字等于 index.js 的 module.exports 键**（类名），与「消费者访问的类方法」是两个不同的面——
   二者在数学上不可能同时满足。修正：DG-10 优先读 `c.PUBLIC_API`，兼容回退
   `c.exports.PUBLIC_API` → `c.exports` 数组（旧形态）。
2. **constructor 噪音**：`app/facade/router.js:44 this.router.constructor.presets()` 会被
   CONSUMER_BINDING 捕获为成员 `constructor`。它是 JS 内建，真正的静态成员 `presets`
   已登记进 router.PUBLIC_API。修正：跳过成员名 `constructor`。

> 门禁文件 `test/domain-structure-gate-test.js` 当前为**未跟踪新文件**，由本轮施工产出。

## 2. 数据来源（全部实测，不照抄设计稿）

- `exports`：直接读各域 `index.js` 的 `module.exports` 字面量键；
- `PUBLIC_API`：扫全仓 `(?:this|host|sup|self).(instances|router|lan|pluginManager|pluginMarket|shellDomain).<member>`
  的消费点汇总（`api/**`、`app/**`、其它域），再补足本域对外类方法面；
- `classApi`：解析各域 class 体的方法集（`InstanceManager/PluginManager/PluginMarket/LanManager/FrpManager/RouterService`）；
- `pure`：逐文件读 `require(...)` 判定零 IO（`node:fs/net/child_process/http/https/tls/dns`）；
- `deps`：读各域 `index.js constructor(opts)` 的 `opts.*` + 注入回调。

## 3. 与设计/模板的偏差（如实记录）

1. **`pure` 用 src 相对全路径**（`domains/<域>/model.js`），而非任务模板的域相对名
   （`model.js`）。原因：门禁 `pureViolations` 以 `ENTRIES.rel`（src 相对）查表，
   域相对名会查不到 → 被 `src === undefined → continue` 静默跳过 → **DG-3 空转**。
   已用反向探针（临时把 `domains/instance/store.js` 加进 pure → DG-3 命中 node:fs）证明判据非空转。
2. **DG-10 使用 top-level `PUBLIC_API`**（任务模板本意），未把 API 面塞进 `exports`。
3. `exempt` 为**文档**（门禁 DG-4 实际豁免表是硬编码 CONTRACT_HOOKS + 抽象占位 + extends SCC），
   登记了 router `providers/base.js` 的抽象占位与 `providers/proxy.js extends BaseProvider`。

## 4. 并行施工竞态（重要）

本轮其它子代理在同时改源码，实测到：
- instance 域**新增了查询接口 `all()/forEach()/find()/map()`**（`instance/index.js:55-61`）
  并把 `app/**`、`api/**` 的 `.instances.instances` 穿透改为这些方法 → 契约已同步登记，
  DG-11 随之转绿；
- `api/domains/instances.js:154` 使用 `sup.instances.find(j.id)`（依赖上述新接口）。
- 契约以**当前实际源码**为准；若并行代理再改 API 面，contract.PUBLIC_API 需同步。

## 5. 验证结果（实跑）

| 命令 | 结果 |
|---|---|
| `node test/domain-structure-gate-test.js` | **64 passed / 0 hard / 0 soft**（DG-3/4b/9/10 全 PASS） |
| `DG_STRICT=1 node test/domain-structure-gate-test.js` | exit 0（严格模式全绿） |
| `node test/directory-structure-gate-test.js` | 16 passed / 0 hard（DS-9 软红与基线一致，未退化） |
| `node test/layering-and-dependency-gate-test.js` | 10 passed / 0 failed（未退化） |
| `node --require ./test/_preload.js test/router-test.js` | exit 0 |
| `node --require ./test/_preload.js test/instance-state-test.js` | exit 0 |
| `node --require ./test/_preload.js test/plugin-change-restart-test.js` | exit 0 |
| `node --require ./test/_preload.js test/relay-source-gate-test.js` | exit 0 |
| `node --require ./test/_preload.js test/shell-safety-net-test.js` | exit 0 |

## 6. 遗留

- `test/domain-structure-gate-test.js` 的 DG-3 未对域相对 `pure` 做前缀（本轮用全路径规避）；
  若后续要恢复模板的域相对写法，需在门禁加 `domains/<d>/<rel>` 前缀解析。
- DG-9 的设计还要求 `classApi`/`deps` 双向一致，门禁尚未实现这两条；契约已预留字段。
- 五域 `deps.instances` 等仍是整个 `InstanceManager`（`EXECUTION-CONTRACT §3.3` 本轮冻结），
  端口化属后续轮次。
