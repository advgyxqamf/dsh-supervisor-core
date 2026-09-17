# 域结构改造 · 执行契约（EXECUTION-CONTRACT）

> **本文件是并行施工的接口冻结书**。所有执行子代理必须严格遵守。
> 权威依据：`DOMAIN-STRUCTURE-DESIGN.md`（SSOT）+ `design-notes/*.md`（逐域详细设计）。

## §0 目标（归一化，非最小代价）

**完整架构归一化**：
1. **物理结构**：每个域的目录/文件按功能职责切分 —— 不抽象、不糊弄，真实分层；
2. **单向依赖**：依赖方向唯一（`index → ops/scheduler → core/policies → model/store`），
   **消除所有旁路 / 胶水 / 补丁 / 双向边**；
3. **零隐式耦合**：跨文件调用必须显式（具名导出 / ctor 注入），**不得靠同一个 this**；
4. **可独立单测**：每个非门面文件能 `require` 后不构造整个域对象即可测。

## §1 判据（DF-1..DF-7，全部硬性）

| 编号 | 判据 | 阈值 |
|---|---|---|
| DF-1 | 门面 `index.js` 只做组合与导出 | **≤150 行** |
| DF-2 | 任何单文件 | **≤300 行** |
| DF-3 | 纯计算与副作用不混同一文件 | — |
| DF-4 | **零 `this` 跨文件调用** | **0 处** |
| DF-5 | 域内依赖图 DAG（且**禁止方法集合并到同一 this**） | 0 环 |
| DF-6 | 非门面文件可独立 require 可测 | — |
| DF-7 | 依赖单向 | 违反即返工 |

## §2 ⛔ 硬约束（违反即作废）

1. **绝对禁止启动任何守卫/daemon 进程**：`guard.lock` 取自**产品状态根**（不是 stateFile），
   临时配置**不能隔离**，会撞生产锁。验证只能 `require()` + 纯函数/假依赖调用。
2. **不碰** `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`、已安装包；
3. **不 git commit/push**；
4. **只改你负责的文件**（见派工单）；越界即返工；
5. **每个改动文件**：`node --check` + `require` 加载；**测试一律由 CI 裁决，本机不得跑测试**（见 `ACCEPTANCE-STANDARD.md` §0）；
6. **公共导出面（对外契约）不得变**：
   - router → `RouterService`（含 static `presets`、`.providers` getter、`switcher`）
   - relay → `LanManager`；instance → `InstanceManager`；plugin → `PluginManager`；
   - shell → `{ ... }`（现 index.js 35 行的键集**逐字保持**）
7. **`daemon.js` 文件名与目录不得改**（`probe.js:27/46` 等 5 处 cmdline 字面量匹配）；
8. **不得引入新的跨层边**（`domains` 不得 require `app`/`api`；`platform` 不得 require 上层）。

## §3 冻结的内部接口契约（★ 并行施工的前提）

### §3.1 通用约定

```js
// 纯模块：具名导出纯函数
module.exports = { somePureFn, SOME_CONST };
// 有状态模块：导出 class 或工厂，依赖经 ctor 注入
class XxxStore { constructor({ logger, events, file }) {...} }
module.exports = { XxxStore };
```

⚠ **禁止**：`module.exports = Object.getOwnPropertyDescriptors(X.prototype)`；
⚠ **禁止**：`Object.assign(X.prototype, require('./yyy').methods)`（把方法集合并到同一 this）。

### §3.2 router 域内部契约（4 个子代理并行时必须遵守）

| 新文件 | 必须导出 | 可依赖（仅此） |
|---|---|---|
| `model.js` | `{ INSTANCE_STATES, isServable, occupiesSlot, stateContainer, serializeInstance, deserializeInstance }` | shared/platform |
| `store.js` | `{ RouterStore }`（class：`load/save/canPersist/setPersistEnabled/readUsage/writeUsage`） | model.js, shared/platform |
| `views.js` | `{ status, listProviders, domainSummary }`（纯读，入参显式） | model.js |
| `scheduler.js` | `{ createScheduler(deps) }`（`deps={store,logger,events,providers,probe}`） | store.js, policies |
| `policies/*.js` | 纯函数具名导出 | shared 仅 |
| `handlers/parse.js` | `{ parseRequest, extractUsage, resolveTarget, joinUpstream }`（**纯**） | — |
| `handlers/forward.js` | `{ createForwarder(deps) }`（`deps={logger,readBody,canPersist,parse}`） | parse.js |
| `store/usage.js` | `{ UsageLedger }`（原子写，`.tmp` 命名**唯一**） | platform/util/fs |
| `model/inflight.js` | `{ createInflight() }`（纯状态，**单一 end() + 显式 effect**） | — |
| `ops/*.js` | 具名导出（`browser/oauth/apps-registry/quotasync/admin`） | providers, policies |
| `providers/model.js` | `{ accountModel, serializeAccount }`（纯） | — |
| `providers/policies/{quota,freeze}.js` | 纯函数 | — |
| `providers/store.js` | `{ AccountStore }`（class） | platform/util/fs |
| `providers/command.js` | `{ buildCommand }`（**纯**） | — |
| `providers/base.js` | `class BaseProvider`（**仅抽象契约 + 账号池 + 检测应用**） | model, store, policies |
| `providers/pool.js` | `{ createPoolPolicy }`（**纯**） | model |
| `providers/proxy.js` | `class ProxyProvider extends BaseProvider` | base, command, pool, restart |
| `providers/restart.js` | `{ createRestartOrchestrator(deps) }` | pool |
| `index.js` | `class RouterService`（**薄门面**：组合 + 委托，≤150） | 上述全部 |

### §3.3 域间契约（**不得改变**）

```js
// plugin 消费 instance 的唯一接口（本次改造保持签名不变）
instances.instances            // 活数组（store 唯一持有；index 的 getter 每次返回当前数组）
instances.probeInstance(id)    // → { ok, state }
instances.stopInstance(id, force)
instances.startInstance(id)
instances.sandboxRoot(inst)    // 纯：路径推导
instances.effectiveCommand(inst)
```

⚠ 该接口**签名与语义逐字保持**（DG-10「改为端口」是**后续轮次**，不在本轮）。

## §4 迁移纪律（每批必须）

1. **先立门禁**（report-only）→ 记录 RED 基线；
2. **一个文件一个文件地搬**：搬完立即 `node --check` + `require` 加载；
3. **纯模块先搬**（零行为变更），**IO/编排后搬**；
4. **行为变更步单独提交**（如 router 的 `inflight.end()` 统一）；
5. **同步改测试**：本仓有 **10+ 处**「把断言钉在源码内容上」的门禁，
   方法一搬家园禁会**静默失效**（清单见 SSOT §8）→ **必须同步改指向**；
6. **测试裁决**：改完推送后，该域全部相关测试 + `directory-structure-gate` + `layering-and-dependency-gate` 一律由 CI 裁决（本机不得跑测试）。

## §5 子代理派生授权

**你可以派生你自己的子代理**（用 subagent 工具）并行处理你范围内的**互不重叠**子块。
要求：
- 每个子代理必须有**明确的文件归属**（互斥）；
- 必须把本契约 §1–§4 完整转达；
- 你自己负责**最终验证**（不能把验证也外包）。

## §6 完成判据（你的任务算完成）

- 你负责的所有文件：DF-1..DF-7 全部满足；
- 该域（或子块）的**全部相关测试**通过；
- `node --check` + `require` 加载无错；
- **`directory-structure-gate-test` / `layering-and-dependency-gate-test` 不退化**；
- 产出 `design-notes/EXEC-<你的主题>.md`：记录实际改动 + 与原设计的偏差 + 遗留。
## §7 越界授权与并发纪律（主代理裁决 D-1..D-6，2026-09-17）

### D-1 relay 改名：授权改 2 行域外文件
`src/app/assembly/compose.js:21` + `src/supervisor.js:100`（**仅此两行**）：
`require('../../domains/relay/manager')` → `require('../../domains/relay')`。

### D-2 facade 纯化：授权改 4 处集成点
① `src/supervisor.js` 的 **APP_MODULES 数组内**新增 3 条 `domain-actions` require；
② `src/app/ctl/facades.js`（SCC④ 谓词注入）；
③ `test/round13-router-relay-gaps-test.js` + `test/probe-gate-and-ownership-test.js:135`（改指向）；
④ `test/layering-and-dependency-gate-test.js` 的 CROSS_LAYER `root -> app` 加 `src/app/domain-actions`。

### D-3 `index.js:758-759` 的 `Object.assign` 由 **RT1** 收口
RT3 已把 `forward-core.js`/`router-ops.js` 改为导出 `createForwardCore(host)`/`createAuxCore(deps)` —— 改动已成熟。
RT1 把 index.js 改为 **ctor 组装 + 删除这两行**。

### D-4 ★ 共享文件并发纪律
`src/supervisor.js` 会被多个子代理碰：**R1 只改第 100 行**；**F1 只改 APP_MODULES 数组内**；**其他一律禁止**。
**编辑前必须重读该行**；若已被改，以最新为基准，不覆盖。

### D-5 relay 改名的连锁测试失败由 **R1 负责修完**，其他代理不得代修。

### D-6 已完成（不再改动）
- **shell 域**（S1）：核心落在 `core.js`；已删除 `restart → watchdog` 反序边；测试 34/52/7/11/66 全绿。
- **文档同步**（D1）：DS-9 取严、README 登记 `EXECUTION-CONTRACT.md`。
  → 交接：`test/directory-structure-gate-test.js` 的 DS-G3 **仍只禁 defineProperties**，由 **G0** 补 `Object.assign`。
