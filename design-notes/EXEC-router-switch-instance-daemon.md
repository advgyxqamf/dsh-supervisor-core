# EXEC · router 域 交换机 / 实例模型 / daemon / 端口段

> 执行者：router 子代理（文件归属：`src/domains/router/{switch.js, instances/**, daemon.js, port-segments.js}`）
> 依据：`EXECUTION-CONTRACT.md` §1–§6（冻结接口）、`DOMAIN-STRUCTURE-DESIGN.md`（SSOT §5.1）、
> `design-notes/router-switch-instance.md`、`design-notes/router-daemon-and-depgraph.md`。
> 约束遵守：未启动任何守卫/daemon；未碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；未 git commit。

---

## A. 实际改动（逐文件 · 行数前 → 后）

| 文件 | 前 | 后 | 改动 |
|---|---:|---:|---|
| `policies/switch.js` | — | **50** | **新增**：S1 纯选号 `pickAccount(state, opts)`（零 require / 零 this） |
| `policies/failure.js` | — | **60** | **新增**：S2 纯失败反应 `decideFailure(signal, ctx)` + `headerRetryMs/bodyResetMs`（自包含） |
| `switch.js` | 117 | **91** | S3 编排：预算是 usable/running → `pickAccount` → 施加副作用；`reactToFailure` 取 signal → `decideFailure` → effect/log |
| `model.js` | — | **103** | **新增**（I1）：`ProxyInstance` + `INSTANCE_STATES` + 冻结具名导出 `isServable/occupiesSlot/stateContainer/serializeInstance/deserializeInstance` |
| `instances/proxy-instance.js` | 102 | **1** | 降为 re-export shim（`module.exports = require('../model')`，final 批删除） |
| `config.js` | — | **40** | **新增**：`DEFAULT_CTL_PORT`/`ROUTER_CTL_METHODS`/`CONFIG_PATH`/`loadConfig`（拆自 daemon.js:24-51） |
| `ports-bootstrap.js` | — | **52** | **新增**：`ensurePorts({swDir,logger})` 端口迁移 + 按 providers 重建（拆自 daemon.js:85-121） |
| `daemon.js` | 188 | **105** | 收敛为纯装配（**文件名/目录未改**，R5）：装配 + 日志源自注册 + ctl 白名单注入 + ctl listen + `router.start()` + 信号/退出 + `require.main` 守卫 |
| `port-segments.js` | 39 | 39 | **不动**（G.2-1/K6：require 即申报保留） |
| `proxy-apps.js` | 49 | 49 | **不动**（T3：常变配置不与稳定模型合并） |

**新增纯策略单测**：`test/switch-policies-test.js`（27 checks，纯 require + 假 state/ctx，零 IO、不构造 RouterService）。

### A.1 行为不变量（E.1 四条，逐条保真）
1. **window 顺序**：`switch.js` 在 `provider.effect` 之前执行 `if (sig === 'window') c.retryMs = d.retryMs` —— cooldownMs 不再 undefined。
2. **动作映射**：credits|window→retry；banned→passthrough(带 status/headers/body)；transient→retry+transient（`needEffect:false`）；none/unknown→passthrough（INV-1 不误切）。
3. **事件名/载荷**：`router_pick` + `{provider, key: maskedKey}` 逐字不变；credits/window 的 `logger.info('CREDITS-EXHAUSTED/QUOTA-EXHAUSTED key=…')` 逐字不变；banned/transient 的 `res.log` 仍在（forward 侧 `act.log` 消费面不变）。
4. **绝不跨供应商 failover**：S1 只在传入的单个 state 池内选。

---

## B. 依赖图收口（Task D）与冲突登记

**router 域 require 图实测（剥注释 + Tarjan，节点 = `src/domains/router/**/*.js`）**：
`28 节点 / 41 条域内边 / **0 环**（DAG 成立）`。mixin 判据（R6 ①，右值不限）命中 **1 个文件：`index.js`**。

>  **冲突（G-1，已裁决 D-3：由 RT1 收口，RT4 不动）**：`index.js:758-759`
> `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` /
> `Object.assign(RouterService.prototype, require('./router-ops').auxMethods)` **仍在**。
> **`index.js` 不在我的文件归属内**（归属 = switch.js / instances\*\* / daemon.js / port-segments.js），
> 按 §2 硬约束「只改你负责的文件（越界即作废）」我**未动**它。
> **改动已成熟**：RT3 已把 `forward-core.js` 改为导出 `createForwardCore(host)`（兼容层 `forwardMethods` 仅剩 index.js:758 这一消费面）、
> `router-ops.js` 已导出 `createAuxCore(deps)`；RT1 只需在门面 ctor 组装 `this._forward = createForwardCore(this)` / `this._ops = createAuxCore({...})`
> 并删两行 assign（同时替换 33 处调用点，见 `router-daemon-and-depgraph.md` E.1）。

**与 RT1/RT2/RT3 产出的一致性核对**：
- 层级方向一致（单向下行）：`index → forward-core/handlers → policies/model/store → providers/base`；
  `router-ops → ops/*`（browser/oauth/apps-registry/quotasync/admin）与 `handlers/forward → handlers/parse` 均为下行；`providers/proxy → instances/proxy-instance（shim→model）` 为模型消费。
- 我负责的子图：`switch → policies/{switch,failure}`（下行、纯叶）；`daemon → config/ports-bootstrap/index`；`model`/`policies/*` 为**零 require 叶**。
- 唯一不一致 = 上条 G-1（index.js mixin 未消灭）。

---

## C. 同步修改的门禁/测试（§4.5「钉在源码上的断言」）

| 文件 | 改动 | 理由 |
|---|---|---|
| `test/directory-structure-gate-test.js:171` | `ALLOWED` → R2 白名单 **+ `ops`**（`providers instances policies model store handlers core jobs ops`） | R10 授权；`policies/`（本域）与 RT2/RT3 的 `handlers/model/store` 需白名单；**R2 清单漏列 `ops`，而 §3.2 / §5.1 目标树含 `ops/*.js`（SSOT 自相矛盾）** ⇒ 补 `ops`，否则 DS-G6 对 `router/ops` 假红 |
| `test/provider-gateway-gate-test.js:133` | PG-3 读取 `instances/proxy-instance.js` → **`model.js`** | shim 仅 1 行，不再含四态词；不改则 PG-3 静默失效 |
| `test/router-test.js:86` | 读取路径 → `model.js` | 设计 F 步 4；shim 保留仅为 RT2 `providers/proxy.js:15` 过渡 |

**未改**（正确）：`providers/proxy.js:15`、`index.js:82` 仍 require shim —— shim 存在的唯一目的；`round8-fixes-test.js:79/88/131/134` 依赖 daemon.js 路径/basename → 未改路径，仍绿。

---

## D. 验证（实跑，全部离线；未启动任何守卫/daemon）

| 测试 | 结果 |
|---|---|
| `test/switch-policies-test.js`（新增，纯策略单测） | **27 passed / 0 failed** |
| `test/router-test.js` | **19 / 0** |
| `test/p2p-router-test.js` | **43 / 0** |
| `test/upstream-credits-test.js`（含 reactToFailure 5 条 + 源码断言） | **75 / 0** |
| `test/daemon-path-test.js` | **7 / 0** |
| `test/kernel-daemon-contract-test.js` | **23 / 0** |
| `test/router-ctl-test.js` | ALL PASS |
| `test/probe-gate-and-ownership-test.js` | **33 / 0** |
| `test/round8-fixes-test.js` | **59 / 0** |
| `test/round13-router-relay-gaps-test.js` | **26 / 0**（该轮） |
| `test/ports-claim-test.js` / `ports-migrate-test.js` / `ports-capacity-test.js` / `ports-verify.js` | 17 / 5 / 20 / 14，**全 0 failed** |
| `test/freeze-recovery-test.js` | **11 / 0** |
| `test/directory-structure-gate-test.js` | **12 / 0**（与基线一致，不退化） |
| `test/layering-and-dependency-gate-test.js` | **10 / 0**（不退化） |
| 我的 8 个文件 | `node --check` + `require()` 全部 OK；`daemon.js` require 后 `SIGTERM` 监听器计数 0→0（**零进程副作用**） |

**RED 基线**：改造前两道结构门禁即为 **全绿**（12/0、10/0）；改造后仍全绿 ⇒ 无退化。

**非我域的遗留失败（如实报告，非本轮 router 改动所致）**：

⚠ **最终汇总 sweep（03:2x）与并发重构重叠**：RT3 于 03:18 改 `forward-core.js`、03:21 改 `router-ops.js`；RT1 于 03:22 改 `index.js`；R1 在改 relay。逐条核对后，失败**全部指向他域文件，无一条命中我的 8 个文件**：

| 测试 | 最终 sweep | 根因 / 归属 |
|---|---|---|
| `provider-gateway-gate` | 23 / 0 ✅ | 期间短暂 PG-4 fail（forward 层预算字面量），RT3 已修 |
| `kernel-daemon-contract` | 22 / 1 | D-7 fail：`index.js` 被 RT1 改写（`stateDir` 注入点迁移中）→ RT1 同步测试指向 |
| `probe-gate-and-ownership` | 21 / 12 | E-d/E-e/E-f/E-g fail：`router-ops.js` 被 RT3 改为 facade，旧源码形态消失 → RT3 同步指向 |
| `round13-router-relay-gaps` | 崩溃 | relay `patchDshMain` 改名中间态（R1） |
| `round13-ports-release` | 8 / 1 | R-c：`relay/ops.js` 的 `portsvc.release(relay:…)` 缺 ownerId（R1） |

**我的域内测试在最终 sweep 中全部 0 failed**：`switch-policies 27/0`、`router-test 19/0`、`upstream-credits 75/0`、`daemon-path 7/0`、`router-ctl ALL PASS`、`ports-claim/migrate/capacity/verify` 全绿、`round8-fixes 59/0`、`directory-structure-gate 12/0` + `layering 10/0`；`p2p-router 43/0`（单独跑）。

---

## E. 与原设计的偏差

1. **`policies/failure.js` 自包含**（内联 `headerRetryMs/bodyResetMs`），未采用 `router-switch-instance.md` D.1 设想的 `failure.js → policies/quota.js` 边。理由：`EXECUTION-CONTRACT.md` §3.2 冻结「`policies/*.js` 可依赖：shared 仅」。
   代价：与 `providers/base.js:40/57` 的时延解析双份；**缓解**：`test/switch-policies-test.js` 新增 6 条 **parity 断言**（与 `base.headerRetryMs/bodyResetMs` 逐字同值），漂移即红。
2. **`model.js` 同时导出 class 与冻结具名函数**：§3.2 要求具名导出，而现有消费者（`providers/proxy.js:84` `new ProxyInstance()`、`index.js:84` `ProxyInstance.fromJSON()`、测试 `i1.isServable()`）要求实例方法。做法：类方法**委托**同名纯函数（唯一事实源），行为零变更。
   - **`stateContainer`** 在契约中只有名字、无语义 → 定义为工厂 `stateContainer(opts) => new ProxyInstance(opts)`；如他域另有约定，需统一（G-7）。
3. **`model.js` 保留 `this`**：设计 note H.2 建议「model.js 不得出现 `this`」与「保留实例方法 + 消费者兼容」冲突。按 DF-4（禁**跨文件** this，同文件类内 this 合法）取 class + 纯函数双导出。若未来把 H.2 硬化为 0-`this` 门禁，前置是 RT2 先让 `providers/proxy.js` 不再用实例方法。
4. **`daemon.js` 不再引用 `CONFIG_PATH`**：该常量随其余三项迁入 `config.js`（仅 config 内部 `loadConfig` 使用）；daemon 只取 `DEFAULT_CTL_PORT/ROUTER_CTL_METHODS/loadConfig`。PG-5 门禁仍绿（daemon 源内含 `ROUTER_CTL_METHODS` 与 `allowMethods: ROUTER_CTL_METHODS`）。
5. **未改 `port-segments.js`** 的「require 即申报」（G.2-1/K6：跨 platform 契约 + 5 消费点，收益<风险，仅记债务）。

---

## F. 遗留（G 节）

| # | 遗留 | 归属 / 下一步 |
|---|---|---|
| **G-1** | `index.js:758-759` mixin **未消灭**（Task D 未完成部分） | ✅ **主代理已裁决 D-3：由 RT1 收口，RT4 不动**；RT3 的 `createForwardCore(this)`/`createAuxCore(deps)` 已就绪 |
| G-2 | `instances/` 目录仅剩 1 行 shim | **final 批**：删目录 + 同步删 `providers/proxy.js:15`/`index.js:82` 的 shim require |
| G-3 | `policies/failure.js` 与 `providers/base.js` 的时延解析函数双份 | 已由 parity 断言锁死；后续若平台抽 `shared/retry.js` 可合并 |
| G-4 | `stateContainer` 语义未冻结 | 主代理统一（当前 = `new ProxyInstance(opts)` 工厂） |
| G-5 | `port-segments.js` require 即申报（隐式装配） | 跨 platform 契约，需平台侧出设计（K6/X3） |
| G-6 | `provider-gateway-gate` PG-4 fail（forward 层预算字面量） | **RT3**（forward-core facade 收口时同步改判据指向） |
| G-7 | `round13-ports-release` R-c fail（relay `ops.js` release ownerId） | **relay 域** |
| G-8 | H.2（model.js 零 `this`）与 消费者兼容冲突 | 待 `test/domain-structure-gate-test.js` 落地时裁定 |
