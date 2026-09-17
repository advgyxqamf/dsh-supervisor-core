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

1. `src/domains/instance/lifecycle.js` 的 `_systemdStart(inst)`：
   `sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst)`（按符号定位；行号随重构漂移，不写死）；
2. `src/domains/instance/sandbox.js` 的 `effectiveCommand()` 三分支：沙箱域且 `command` 为空 →
   `sandboxCommand()` 默认；**`command` 非空 → 原样返回该数组**；否则 `defaultCommand()`；
3. 同文件 `service.startTransient({ unit, cmd: cmdArr, env, props, workingDir })`；
4. `src/platform/os/service.js` 的 `startTransient` 拼 `systemd-run`（仅 Linux + systemd 支持沙箱；
   能力判定见 `src/domains/instance/sandbox.js`）。

即：**非空 `command` 是「原样 argv 覆盖」语义**，守卫不再解释其内容。

### §8.4 守卫当前提供的保证（写时闸 + 启动期执行边界复校）

**(一) 写时闸** —— `src/api/domains/instances.js` 的 `commandShapeError()`（由 `/instances/add` 调用）：

- **结构闸**：必须是字符串数组；单项非空、≤4096 字符；项数 ≤64；拒 NUL/CR/LF；非数组或空项 → 400。
- **入口判定**（形态 A，`command[0]` 为 node 族时）：`command[1]` 必须存在、必须是**绝对路径**，
  且为 DSH 入口之一（官方包内入口、`dsh` 族 basename、或配置的 `dshBin`）；否则 400。
- **形态 B**（`command[0]` 自身为 dsh 族入口）：其后为参数；相对路径（含分隔符）**拒绝**。
- 形态与路径类判定由 `src/platform/os/exec-path.js` 的 `commandEntryViolation()` 统一给出
  （与下述启动期复校**共用同一实现**，不存第二份）；官方包内入口的形态由 `exec-path.dshJsIn()` 推出。
- 写路径另受鉴权保护：`src/api/transport/server.js` 的非回环 fail-closed 闸（无 key 或 key 不匹配 → 401）。

**(二) 启动期执行边界复校** —— `src/domains/instance/lifecycle.js` 的 `_systemdStart()` 内，
在 `effectiveCommand()` 之后、`startTransient()` 之前调用 `commandEntryViolation(cmdArr, ...)`。

**适用范围 = 沙箱实例（`inst.domain === 'sandbox'`）**。理由：本契约的 `command` 覆盖面是沙箱实例，
其值来自 `POST /instances/add` 的请求体（真正的攻击面）；native/main 的命令则来自**操作者配置文件**
（`cfg.command`，如 `['node', <本地 mock 绝对路径>, port]`），不是 API 供给 —— 对配置文件做执行边界
复校既不必要，也会误拒合法入口。**非沙箱一律不进入本复校**（源码即 `inst.domain === 'sandbox' ? ... : null`）。

- **允许位置**（realpath 后判定，两侧都解析软链）：
  ① 位于**该实例 `installDir`** 之下的入口；或
  ② **精确等于** `exec-path.knownDshEntries()` 给出的已知 DSH 入口（其值由 `resolveDsh()`/`dshJsIn()`
     推出 —— 即「DSH 在哪」的单一事实源；解析顺序：`DSH_BIN` → `PATH` → 标准目录 → `npmRoot`）。
- **裸名放行**：不含路径分隔符的入口（如 `dsh`）交给 exec 的 PATH 解析，本层不判 ——
  内核默认命令 `[node, <dshBin>]` 正是此形态（native/main 依赖它，不得误拒）。
- **相对路径**（含分隔符但不绝对）**拒绝**：会按调用方 workingDir 解析，而沙箱实例的 workingDir 是
  **沙箱内可写**的 data 目录 ⇒ 这正是「低权限（沙箱可写）→ 高权限（守卫执行）」方向。
- **ENOENT / 不可解析一律 fail-closed**：否则「先提交、后由外部创建」可绕过。
- 不通过时：**不启动**，写 `inst.state.lastError`、发 `inst_start_refused` 事件、记 warn，返回 `{ok:false}`。

### §8.5 已知未保证（台账，不得据此假设安全）

- **写时闸仍按 basename/形态放行**（`["node","/tmp/evil/dsh.js"]`、形态 B `["/tmp/evil/dsh"]`、
  伪包内路径 `/tmp/node_modules/@deepseek-ai/dsh/lib/bin.js`）：`/instances/add` 时 `inst.id`
  尚未生成、**取不到该实例的安装根**，故写时无法做包含性判定 —— 这是**有意的分层**：
  写时=形态校验，执行时=归属复校。后果是「可提交、不会执行」：这些值能落库，但 §8.4(二) 会在启动时拒绝。
- **裸名形态无法收口**：`[node, dsh]` 一类交给 PATH/PATHEXT 解析，realpath 不可得；
  若 PATH 中含有低权限可写目录，则解析结果不受本契约约束（同用户可写 ⇒ 该威胁模型已超出本契约）。
- **内核已知入口自身被替换**：`knownDshEntries()` 指向的文件若被同权限者改写，本契约不提供完整性保证
  （下载/安装路径的完整性由各自机制负责，不在此处）。
- 上述各项属**纵深防御**范畴：该变更路径位于**已鉴权操作者**信任域内，而该域本就具备代码执行面
  （`/plugins/install` → npm install 后由 DSH 进程加载插件代码）。故**不新增能力**，只是更换执行入口。

### §8.6 定案（原「待决」三项的处置）

- **运行时执行边界是否复校**：**已复校**（§8.4(二)）。原设计草案与三种替代方案见
  `design-notes/_p3-c-api-hardening.md` §8；本轮采用其**方案 A**（已知 DSH 安装位置集合），
  实施记录见 `design-notes/_p6-c-command-boundary.md`。
- **原前置缺口 1（显式 `command` 指向尚不存在路径）**：**取 fail-closed**，即拒绝
  「先提交、后由外部创建」的用法。这是**有意行为变更**：该用法此前会通过写时闸并落库。
- **原前置缺口 2（非 sandbox 域 native/main）**：**已定案 = 整体排除在 §8.4(二) 之外**
  （不按"裸名放行"覆盖，而是**不进入**该复校）。理由：native/main 的命令源是**操作者配置文件**
  `cfg.command`（不是 API 供给），且实测其形态可为 `['node', <本地绝对路径>, …]`（如测试的 mock 目标），
  按沙箱的"安装根包含性"判它必然误拒。其命令由 `app/native/command.js` 从 `config.command` 构建并
  经平台 spawn 拉起，**本来就不经 `_systemdStart`** —— 该排除是纵深防御而非修复某条实路径。
- **原前置缺口 3（`/usr/local/bin/dsh` 是否继续支持）**：**当且仅当**它正是内核解析器
  （`resolveDsh()`）能解析出的入口时继续支持。理由：`resolveDsh()` 是「DSH 在哪」的单一事实源，
  由它定义合法入口才与既有解析链一致（`DSH_BIN` → `PATH` → 标准目录 → `npmRoot`）；
  不在其中的绝对路径入口会在写时（`files=knownDshEntries()` 未命中）或启动时被拒，错误文案给出可用形态。
  ⚠ 注：`standardDirs()` 在 **darwin** 含 `/usr/local/bin`，**linux 不含**，故该路径在 Linux 上
  须经 `PATH` 命中（systemd 用户服务的默认 PATH 通常含 `/usr/local/bin`）。
- **仍未复校（登记，不在本契约承诺内）**：若产品要求「允许指向内核解析器之外的任意 DSH 安装」，
  则需回到方案 B（公开 API 只收附加参数、入口一律由解析器决定，属契约变更、需 UI 协调）或方案 C
  （保留自由 command + 显式确认位 + 事件留痕）。本轮不实施。

