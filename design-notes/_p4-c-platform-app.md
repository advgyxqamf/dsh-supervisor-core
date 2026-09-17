# P4-C 报告：platform + plugin + shell + app-state/control

> 承接 `_workorder-phase4.md` 与 `_p3-e-audit-backlog.md`；分片细则 `_p4-c-shards.md`。
> 未跑测试/门禁、未 require 产品模块、无 git 写、未改 `test/`。**验收以 CI 为最终裁决。**

## 0. 分片与交付

| 分片 | 独占文件 | 积压项 | 结果 |
|---|---|---|---|
| P4-C-1 | plugin(18) + shell(6) | #3 #13 #14 #30 #29 | 4 文件改动 + F9；#29 = **0 删除**（四例保留） |
| P4-C-2 | platform(65) | #21 #22 #24 #27 #29 + SSRF | 5 文件改动；#29 交付候选清单 |
| P4-C-3 | app/state(10)+app/control(11)+bootstrap.js | #25 #26 #28 #29 | 3 文件改动；#29 = **0 删除** |
| 负责人 | token-kinds.js + compose/core.js + desired.js | #24 + persistConfigPatch | 见 §2 |

本面共 **15 文件改动（+97/−66）**，全部 `node --check` 通过。

## 1. 逐项改动与行为变更

| # | 文件 | 改动 | 行为变更 |
|---|---|---|---|
| 3 | `plugin/market.js` | **只给后台刷新 `_refreshIfStale` 加 `.catch(warn)`**；`getIndex` **不加** | 无（见 §3.1，此点纠正了我的指令） |
| 13 | `plugin/updater.js` | `latest !== null` 才写 `_updCache` | 取失败不再被负缓存 6h；本次返回的 latest 值不变 |
| 14 | `shell/watchdog.js` | 新增 `updateJournalTracking`：按 **`j.startedAt`** 年龄 > `phaseMaxAgeMs` 判账本陈旧；陈旧时不延长宽限 + warn 一次 | 陈旧未确认账本不再永久拖慢自愈 |
| — | `shell/watchdog.js` | **F9**：:62 离开更新相位时补 `phaseStaleWarned = false`，与账本侧 :82 对称 | 陈旧相位 warn 可再次触发（可观测性） |
| 21 | `platform/os/process.js` | 删 `isAlive` 函数体与导出键；**`signalProcess`/`killTree` 保留** | 无（零消费者） |
| 22 | `platform/service/tasks.js` | 删 `cancel()` + 头注改为「`canceled` 现为防御性识别态，生产者为 #22 所删，勿据本行恢复」 | **无取消路径可接入**，故删；`_finish` 仍接受该值、下游 `canceled→failed` 映射保留 |
| 24 | `platform/service/token/persist.js` | 删 `DEFAULT_TOKEN_FILE_NAME`/`_tokenFileName`/`configureTokenFileName`/`tokenFileName` + 2 导出键；**改正原「生产路径始终注入」的不实注释** | 无（全链写而不读） |
| 24 | `app/settings/token-kinds.js` | 删 `persist` require 与注入调用；**保留并导出 `TOKEN_FILE_NAME`** | 无（声明仍在，只是消费方变了） |
| 24 | `app/assembly/compose/core.js` | :22 裸 require → 解构取常量；:148 字面量 → 用常量 | **无路径数学变化**（仍 path.join(path.dirname(stateFile), 同名值)） |
| 25 | `app/state/intents.js` | 删 `has()`/`any()` + JSDoc | 无（零调用；`register/consume/clear` 保留） |
| 26 | `app/control/registry.js` | 删只写不读的 `this._loaded`（两处赋值） | 无；**`_loadedFromDisk` 未动**（确有读取：`state/store.js:48`） |
| 27 | `platform/service/log/logcore.js` | 解构去掉 `LineBuffer` | 无；**`log.js` 的类定义与导出未动**（`app/main/process.js`、`test/core-test.js` 仍在用） |
| 28 | `app/assembly/bootstrap.js` | **只删 :11 的 `registerAll` require 行** | 无；6 条心跳结构钉子一行未动 |
| 30 | `plugin/model.js` | 加「**有意平行**」注释 + 跨域交叉引用（**按符号名，不写行号**） | 无（纯注释） |
| — | `app/state/desired.js` | `persistConfigPatch` **返回落盘成败** | 成功 `true`；**无 configPath 与写失败均 `false`**（见 §2.2） |
| SSRF | `platform/distribution/registry.js` | `redirect: 'manual'` + 显式「仅 2xx 成功」 | **依赖 http→https 跳转的 registry 源将报不可达**（取舍：攻击面 > 便利） |

## 2. 负责人自做部分

### 2.1 #24 按主控「方案 e」落地（不是删除，而是把「声明唯一处」变成真的）
我最初的计划是**删掉整条链**；主控裁定改为**保留 `TOKEN_FILE_NAME` 并让 compose 消费**，我采纳。理由成立：
把「事实契约只存在于硬编码字面量」变成「常量声明 + 单一消费方」，同时消掉 platform 侧的写而不读注入链。
`compose/core.js` 的 require **位置与时机不变**（仍在 `LogCore.init` 与构造 `DshTokenService` 之前）。
**未采用**「compose 改调 `persist.tokenFileName()`」：它走 `path.resolve(stateFile)` 而 compose 走
`path.dirname(host.config.stateFile)`，相对路径下两者不等 = 行为变更。

### 2.2 `persistConfigPatch` 返回成败（主控追加，属 P4-C-3 面但该分片已结束）
改为返回布尔。**选布尔而非 `{ok}` 的理由**：① 全部既有调用方（`domain-actions/router.js` ×4、
`api-rebind.js`、`collaborators.js` 包装、`test/app-ctor-injection-test.js`）都忽略返回值 → 布尔是最小契约、零耦合；
② `{ok}` 会招来「再塞 error 细节」的范围蔓延。已写明「无落点 = 未持久化」，避免 false 被误读为故障。
**未改 `settings/access.js`**（P4-A 的面）。

## 3. 负责人独立复核（不采信下级自证）

1. **`node --check`**：本面全部改动文件 **39/39 通过**。
2. **R2 真实删除清单**：本面只删了 `isAlive`、`TaskRegistry.cancel`、令牌文件名 4 符号、`_loaded`、`has/any`、
   `registerAll` require、`LineBuffer` 解构、`persist` require 与注入调用、`TOKEN_FILE_NAME` 的注入调用。
   逐项核验消费者：`isAlive`（`process.js` 的那个）零消费者；`cancel` 零调用；4 符号全仓 0；
   `_loaded` 零读取；`has/any` 按**可达性**核（唯一实例化 `compose/core.js:73`，唯一入口 `getIntents()`，
   全部调用只有 register/consume/clear）；`registerAll` 真正调用在 `compose/observers.js:41` 且**导出保留**
   （`test/session-lifecycle-test.js:204`、`test/lifecycle-mirror-test.js:21` 按路径 require 它）。
3. **悬挂引用扫描**（逐文件：删了声明但同文件仍引用 = ReferenceError）：**零真实命中**。
   扫描器报 5 处启发式命中，我逐条验证**全部为假阳性**并给出原因：
   `token-kinds.js` 的 persist → 仅 'capture+persist' 数据串；`forward.js` 的 readUpstreamBody → import 解构绑定；
   `base.js` 的 applyDetection → 对象成员方法形态；`ports.js` 的 list → `registry.list()` 是他人方法调用。
4. **R1 权威扫描**（`grep -oP` 的 Han 属性写法）：本面删除 64 行注释 → 31 个 CJK token →
   **零个以断言形态出现在 `test/`**。
5. **心跳 6 钉子**（bootstrap.js）：按 `heartbeat-selfheal-test.js` 的抽取方式（host→this 归一 + 滤 // 行）模拟，
   `_heartbeatBusy = false;`（×2）、`iv*12|stallMs`（×3）、`_heartbeatStalls++`、`强制释放防停摆`、
   `guard.unref`、`clearTimeout(guard)`、`}, heartbeatIv);`、`const iv = heartbeatIv;` **全部在位**。
6. **未回退既有修复**：`registry.js:191` 的 P3-A ownership 合并、P2 的 `relay/managed.js` 的 `all()`、
   WS2 的 `timeoutMs` / `isUnitActive` 三态（其后由 P3-F 完成）均在位。
7. **#14 的在链约束**：`watchdog-phase-freshness-test.js:106-113`（N-d）传 `journal` 为 `{ to: '9.9.9', confirmed: false }`
   **无 `startedAt`** 且断言 `expectedAbsence===true` + `restarts.length===0` —— 实现按「缺/不可解析 ⇒ 未陈旧」保住了该语义。

### 3.1 一处「下级纠正我」的记录（重要）
我在分片细则里写的是「`getIndex` 与 `_refreshIfStale` **各一处** `_inFlight`，改法 `buildIndex().catch(warn).finally(...)`」。
P4-C-1 **没有照做**，并给出证据：`api/domains/plugins.js:13-16` 用
`getIndex(force).then((r)=>send(200,r), (e)=>send(500,...))`，**依赖该 promise 的 rejection** ——
若给 `getIndex` 也加 catch，会把 500 吞成 200（假成功）。它只给真正无消费者的后台刷新加 catch。
**这是我的指令过宽，它的判断正确**，我复核 `plugins.js:13-16` 后确认。
→ 我据此又发现它的修法有一个**窄新洞**（见 §5.2），已回报。

## 4. #29 结论：本面**零删除**

- P4-C-3：枚举当前树 40 键 → 可删 0。两个候选（`INTENTS`、`withTimeout`）经四类核验**保留**：
  `INTENTS` 是意图词表唯一出口；`withTimeout` 受 `FIX-4.md:48` 记载的「对外导出面不变」约束。
  另查明：**全仓无任何文件直接 require `control/managed-object.js`**（纯模型只经 registry 的 re-export 消费，
  而 `registry.js:21` 明文「公开导出面不变」）→ 7 个 re-export 键全保留。
- P4-C-1：**零删除**。它发现 **EX 工具假阴性**（见 §5.1）并用原始 grep 证伪四例，全部保留。
- P4-C-2：按 §5.1 要求交付「候选清单 + 原始 grep 证据」，**不据工具结论删除**。
- 负责人自身两文件：`composeCore` → `compose.js:14`；`KINDS` → `test/token-contract-gate-test.js:504`；
  `TOKEN_FILE_NAME` → `compose/core.js:22`。**均有消费者，无可删。**

## 5. 上报给主控的发现（不静默）

### 5.1 **EX 工具（`release/scripts/export-consumers.sh`）两个方向都不可单独采信**（已上报，请转 P4-A/B/D 并派 P4-D 修）
- **假阴性（系统性、危害最大）**：`is_definition_line()` 末尾的宽形态子串匹配会把**门面转发器**当定义行，
  使该门面文件进入 `DEF_FILES`，其内部**真实消费点被剔除** → 误判「可删」。
  实测：`sandboxTarget --defs` 把
  `plugin/index.js:44: _sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }` 列为 [def] →
  结论「可删」，而它正是消费者。同型四例：sandboxTarget / allSandboxTargets / targetRunning / applyPluginChange。
- **假阳性**：`settings/versions.js` 的 `_vcsRoot()` 被同文件兄弟方法 `this._vcsRoot()` 消费，工具仍报「可删」。
- 建议修法：定义行判据改为「行首/空白后紧跟 function|const|let|var|class + 符号」或「module.exports 键位」，
  **删除**宽形态子串匹配；把 `{methods}` 门面转发显式排除；头注加「结论仅供参考，必须原始 grep 复核」。

### 5.2 #3 修法引入的窄新洞（已回报 P4-C-1，待其处置或登记）
后台刷新失败后，若并发到达 `GET /plugins/market?refresh=1`，`getIndex(true)` 会 return `this._inFlight`
—— 而它已是 **catch 消化过的** promise → 失败时 resolve `undefined` → API `send(200, undefined)`（修复前为 500）。
两项不变量须同时成立：无消费者的后台失败不得 unhandled；被 force 取走时仍须如实失败。
已给出「标记已处理（`raw.catch(()=>{})`）与交给消费者的 rejection 分离」的建议形状，由 P4-C-1 定稿。

### 5.3 只登记、不改（避免越界与范围蔓延）
- `shell/watchdog.js` 的 `_reset()` **全仓零消费者**（EX 复核：定义文件之外 src=0 test=0 bin=0），
  但它经返回对象 `{ tick, status, _reset, intervalMs }` 暴露 → 属**导出面**，删除是另一个决策，**只登记**。
- `plugin/market-net.js`、`relay/frp-install.js` 各自的「跳数上限式重定向跟随」与 registry 风险面不同
  （无 api 层 host 策可绕），按主控裁定登记为**独立积压项**（重定向硬化第二轮），**未纳入本批**。
- `design-notes/_r5-app-api-P4.md:53` 声称 `INTENTS` 被三处引用 —— **实测不成立**，已就地订正（只有 `IntentLedger` 被消费）。

## 6. CI 风险与注意事项
- 本面改动均为「删零消费者符号 / 加注释 / 加 catch / 显式状态码判定 / 常量取值」，**唯一可观测行为变更**是
  §1 表末的 SSRF `redirect:'manual'`（依赖跳转的源会报不可达）与 `persistConfigPatch` 现在**有返回值**
  （无调用方读取，故无影响）。
- 注意 `src/app/control/registry.js` 与 `src/domains/shell/watchdog.js` 分别被 P3-A / P2 改过，我已确认**未回退**。
- 工作区含 P4-A/B/D/E/F 的并发改动；**本报告只对本面 15 个文件负责**。
- 全量结论以 CI 四平台裁决为准；本报告不构成验收结论。
