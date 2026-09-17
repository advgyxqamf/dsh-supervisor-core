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

## §8 instance `command` 契约（沙箱启动命令的事实契约）

> 背景：2026-09-17 复核发现 `DOMAIN-STRUCTURE-DESIGN.md` 与本文其余各处出现的 `command` 均指
> router 的 `providers/command.js#buildCommand`（另一件事），**instance 的 `command` 在此之前没有
> 成文定义**，事实契约只存在于下列代码位置。本节把它固化，供后续周期评估改动。
> 本节只记录**有代码证据**的条款；未保证项与待决项单列，不发明更强承诺。

### §8.1 字段形状

- 位置：实例记录（`instances.json` 的一条）的 `command` 字段。
- 取值：**字符串数组**（argv）。`src/domains/instance/model.js:41`：
  `command: Array.isArray(payload.command) ? payload.command : []` —— 非数组一律落为 `[]`，**不做其它规范化**。
- **缺失** 与 **空数组** 等价：都表示「用沙箱默认命令」，不报错。
- 前端来源：`InstancesPage.tsx`（前端）:62 `fCmd.split(/\n/).map((x) => x.trim()).filter(Boolean)`
  —— 文本框按**每行一个参数**切分；:231 标签「启动命令（每项一参数，可留空用默认）」；
  :234 占位符 `node /usr/local/bin/dsh web`（**通用示例**，不指向沙箱安装目录）。

### §8.2 写入者

- 写入路径：`/instances/add` → `src/api/domains/instances.js` → `src/domains/instance/ops.js`
  的 `addInstance(payload)` → `store.instances.push(inst)` + `store.save()`。
- 落盘：`src/domains/instance/store.js:18`（`instancesFile = <dir>/instances.json`）与 `:50 save()`
  （原子写 + `0o600` + 内容未变不写盘）。
- `/instances/update` **不接收** `command`（已核），故创建之后没有 API 能改该字段。

### §8.3 消费点

调用链（启动期，非写时）：

1. `src/domains/instance/lifecycle.js:53` `sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst)`；
2. `src/domains/instance/sandbox.js:31-34` 三分支：沙箱域且 `command` 为空 → `sandboxCommand()` 默认；
   **`command` 非空 → 原样返回该数组**；否则 `defaultCommand()`；
3. `src/domains/instance/lifecycle.js:60` `service.startTransient({ unit, cmd: cmdArr, env, props, workingDir })`；
4. `src/platform/os/service.js` 的 `startTransient` 拼 `systemd-run`（仅 Linux + systemd 支持沙箱；
   能力判定见 `src/domains/instance/sandbox.js`）。

即：**非空 `command` 是「原样 argv 覆盖」语义**，守卫不再解释其内容。

### §8.4 守卫当前提供的保证（写时闸）

`src/api/domains/instances.js` 的 `commandShapeError()`（由 `/instances/add` 调用）：

- **结构闸**：必须是字符串数组；单项非空、≤4096 字符；项数 ≤64；拒 NUL/CR/LF；非数组或空项 → 400。
- **入口白名单**（形态 A，`command[0]` 为 node 族时）：`command[1]` 必须存在、必须是**绝对路径**，
  且为 DSH 入口之一（官方包内入口 `<前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js`、
  `dsh` 族 basename、或配置的 `dshBin`）；否则 400。
- **形态 B**（`command[0]` 自身为 dsh 族入口）：其后为参数。
- 写路径另受鉴权保护：`src/api/transport/server.js` 的非回环 fail-closed 闸（无 key 或 key 不匹配 → 401）。

### §8.5 已知未保证（台账，不得据此假设安全）

- **basename 改名绕过**：`["node", "/tmp/evil/dsh.js"]` 与形态 B `["/tmp/evil/dsh"]` 仍会放行 ——
  白名单本质是 basename / 路径形态判定，不是 realpath 收口。
- **伪包内路径**：`["node", "/tmp/node_modules/@deepseek-ai/dsh/lib/bin.js"]` 可匹配「包内入口」形态。
- 上述两项属**纵深防御**范畴：该变更路径位于**已鉴权操作者**信任域内，而该域本就具备代码执行面
  （`/plugins/install` → npm install 后由 DSH 进程加载插件代码）。故**不新增能力**，只是更换执行入口。

### §8.6 待决（不在本契约承诺内）

- **运行时执行边界是否复校**：**待决**。当前闸只在**写时**校验，启动期直接消费持久化值。
  若做启动期复校，精确挂点是 `src/domains/instance/lifecycle.js:53`（此时 `inst.id` 与
  `sandbox.installDir(instancesRoot, inst)` 均可得，可做 realpath 包含性判定）。
  设计草案、与既有覆盖语义的冲突证据、以及三种替代方案见
  `design-notes/_p3-c-api-hardening.md` §8；本轮**不实施**。
- **前置证据（有利）**：沙箱域进入 `_systemdStart` 之前，`start()` 会用
  `src/domains/instance/lifecycle.js:92-97` 检查默认 DSH 入口是否存在，不存在则先安装并**直接返回**
  （本次不启动）。故挂点处**默认命令**的安装根必然已存在，realpath 判定不会因「尚未安装」而 ENOENT。
- **前置缺口（须决策）**：用户**显式** `command` 指向尚不存在路径时的语义（fail-closed 会拒
  「先提交、后由外部创建」的用法）；非 sandbox 域（native/main）不经过上述 existsSync 前置，须单独定义；
  以及 §8.1 记作「通用示例」的 `/usr/local/bin/dsh` 是否必须继续支持。

