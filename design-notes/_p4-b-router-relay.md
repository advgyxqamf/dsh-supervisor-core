# P4-B 交付报告：router + relay + api/dist（积压 12 项）

> 工作流 P4-B（负责人 + 2 个下级分片）。只改工作区，未 commit/push。
> 未运行任何测试/门禁；只使用 `node --check` / `bash -n` / `grep` / `read` / `wc` / 只读 `git`。
> **未 require 任何产品模块、未做内存冒烟**；实测交 CI 裁决。本报告不构成验收结论。

## 0. 概览

**范围**：`src/domains/router/**`、`src/domains/relay/**`、`src/api/domains/dist.js`。
**分片**：P4-B-1（router）与 P4-B-2（relay）文件互斥，主控自做 #12；主控对两者交付逐项独立复核。

| # | 条目 | 状态 | 结果 |
|---|---|---|---|
| 2 | 非流式响应体收到头后无超时（可永久悬挂） | 已修 | 抽 `handlers/upstream-body.js`（新增 54 行），forward.js 300→288 |
| 5 | 应用更新步骤集是创建时快照（常驻实例静默空转） | 已修 | 执行时按 providerId+keyId 重取活实例；取不到如实 failed |
| 12 | `/dist/registry/probe` 目标 host 由请求体控制（盲 SSRF） | 已修 | 两层策略：已配置镜像源白名单 + 其余仅公网 |
| 15 | credits 冻结维持分支不补 `nextResetAt`（探测风暴） | 已修 | 维持分支补 `acc.nextResetAt = at \|\| now + CREDITS_RECHECK_MS` |
| 16 | OAuth 重新发起对上一 Promise reject 可能 unhandledRejection | 已修 | 创建后即 `promise.catch(() => {})` 自吞 |
| 17 | `startProviderServer` 未在 listen 前占位 | 已修 | listen 前占位 + error 处理器身份比较 |
| 18 | frp 启用但 `serverAddr` 为空仍 start frpc | 已修 | 新增纯函数 `validateFrpServerSettings`，写入口 + 执行边界双闸 |
| 19 | 受管清单 main 优先级与注释不符 | 已核实**非缺陷** | 只修注释（id 空间不相交，见 §1.8） |
| 20 | 只读视图内发生写副作用 | 已修 | 新增纯 `previewLimit`；写入移到 `base.applyDetection` 状态投影处 |
| 23 | `router/model.js` 的 `stateContainer` 导出零消费者 | **不执行（否决删除）** | 系 `EXECUTION-CONTRACT.md:61` 必须导出；下级先删后已回退，见 §1.10 |
| 29 | 零消费者导出 | 已核验；**删除数 = 3**（全在 relay） | router 旧导出删除 **0**；EX 的 20+9 条「可删」多为假阴性，见 §4.2 |
| 30 | `taskStateToView` 三份平行实现 | 已按口径处理 | apps-registry 加「有意平行」交叉引用注释；未抽公共函数 |

**导出删除**：`src/domains/relay/ports.js#list`、`src/domains/relay/port-segments.js#SEGMENTS`、
`src/domains/relay/session.js#hasCookie`。**无新增导出**（除新模块 `upstream-body.js` 的 2 个）。

**node --check**：本域改动 16 个 `.js` 全部通过（`checked=16 fail=0`）。
**DG-2（≤300，判据 `>`）**：本域最大 = `handlers/forward.js` **288**；其余见 §5 余量清单。

---

## 1. 逐项

### 1.1 #2 非流式响应体无超时（router 分片）

**根因**：`forwardOnce` 在 `req.on('response')` 回调里 `settle()`，而 `settle` 会把
`connectGuard(15s)` 与 `responseGuard(180s)` 一并 `clearTimeout` —— 即两个守卫只覆盖「到收到
响应头为止」。此后 `writeThrough` 的体读取**无任何时限**：上游发完头后挂起，客户端连接与在途计数
（`endInflight`）一起永久泄漏。

**修法（结构解）**：把上游体读取/透传抽成 `src/domains/router/handlers/upstream-body.js`（54 行）：
- `NONSTREAM_BODY_MAX_MS = 300000`：**仅非流式**设总时长上限（流式长流不限）；到期 `ur.destroy()`
  后走 `onAbort`；`timer.unref()` 防拖住进程退出。
- `trackUpstreamBody(ur, opts)` 承接 data/end/aborted/error/close 透传与背压（`onData` 返回 false
  即 `ur.pause()`，`res` 的 `drain` 恢复）；返回 `{ cancel }` 供其它结束路径清定时器。
- `readUpstreamBody` 由 `forward.js` **原样搬入**（含原 JSDoc 原文）。
- `forward.js`：改 `require('./upstream-body')`；`module.exports` 仍为
  `{ createForwarder, readUpstreamBody }`（**对外导出面不变**）；`res.on('close')` 路径补
  `body.cancel()`。

**行为变更声明**：非流式上游体在**收到头后 300s 内无进展**时，由「永久悬挂」变为
`ur.destroy()` → `finishAborted()`（记 `STREAM_ABORTED` 日志 + `router_stream_aborted` 事件 +
按实例计熔断，与既有中断路径同义）。正常非流式响应时长远小于 300s，不触发。

**为什么抽模块而非压行**：`forward.js` 原**恰好 300 行**、仅剩 14 行注释，DG-2 是 `>300` 即红。
主控明确禁止「为迁就行数砍注释」（属为门禁变绿做美容）。抽出的新模块在 DS-G6 白名单目录内，
**新增文件**不受子目录白名单限制。

### 1.2 #5 应用更新步骤集是创建时快照（router 分片）

**根因**：`ops/apps-registry.js` 在创建 job 时 `targets.flatMap(...)` 快照 `{provider, inst}`，
stop/start 两个循环直接用 `insts[i].inst`。常驻实例在两步之间被重建（keyId 变化）后仍操作旧引用 →
静默空转或报假成功。

**修法**：步骤集只快照**标签** `{providerId, keyId, maskedKey}`；新增 `resolveStep(i)` 在执行时
按 `providerId` 取 provider、按 `keyId` 取活实例；取不到即 `job.errors++` + `setStep(i,'failed',reason)`
+ task 日志，**不静默**。末尾 `proxyRunning` 也改为按 providerId 重取（`targets` 同为创建时快照）。

**行为变更声明**：`job.steps[*]` 与 `proxyUpdateStatus().steps[*]` **新增 `reason` 字段**（加性，
失败时给出原因文案；成功为 `null`）；实例在执行期消失时由「用旧引用继续」变为如实 `failed` +
计入 `errors`。`resolveStep` 有 `state !== 'failed'` 守卫，故 stop 循环已标记的失败不会在 start
循环被重复计入 `errors`。

### 1.3 #12 盲 SSRF（主控亲办）

**根因**：`src/api/domains/dist.js` 只校验 `origin` 以 `http(s)://` 开头即交
`sup.dist.probeOrigin()` 服务端 fetch —— **请求体可指定任意主机**，守卫被当作内网可达性/延迟探针。

**修法（两层，保守但保留既有能力）**：
1. **已配置镜像源的 hostname 白名单**：取 `sup.dist._registryOrigins()`
   （= `platform/distribution/policies.effectiveOrigins`，distribution 的唯一事实源）→ 直接放行。
   操作者有意配置的内网镜像仍可测试。
2. **其余只允许公网主机**：拒绝回环 / RFC1918（复用 `shared/ip` 的 `isLoopbackAddress`、
   `isPrivateIpv4`，不重写第二份判定）/ 169.254/16（含云元数据）/ CGNAT 100.64/10 / 0/8 与 224+ /
   `localhost` `.local` `.internal` `.home.arpa`；**拒绝全部 IPv6 字面量**与**单标签主机名**。

保留 `^https?:` 字面校验作协议层第一道闸（`test/round13-csp-probe-test.js:72` 以源码形态钉住它）。

**两条有意保留的保守取舍（非遗漏）**：
- **拒绝全部 IPv6 字面量**：URL 会把 `::ffff:127.0.0.1` 归一成 `::ffff:7f00:1` 这类十六进制形态，
  逐段枚举前缀有绕过面；镜像源应写域名或 IPv4，且已配置源已在①放行。
- **拒绝单标签主机名**（无点）：内网 DNS 短名（`intranet`/`metadata` 等）会经搜索域解析到内网。

**为什么不用严格白名单**：`ui/.../RegistryCard.tsx:173` 的「测试」按钮对**用户自由文本 URL** 调
`registryProbe`（「添加自定义镜像前先测活」）；严格白名单会破坏该既有 UX。

**行为变更声明**：`POST /dist/registry/probe` 对「非法 URL / 回环 / 私网 / IPv6 / 单标签主机名」
由「尝试探测（并可能返回 200）」变为 **400 `{ok:false,error}`**；已配置镜像源与公网地址不受影响。
另新增 `api → shared` 的 `require('../../shared/ip')`（该跨层边已在
`layering-and-dependency-gate-test.js` 的 `CROSS_LAYER['api -> shared']` 登记，无需改门禁）。

### 1.4 #15 credits 冻结维持分支不补 nextResetAt（router 分片）

**根因**：`providers/policies/freeze.js` 的 `applyDetection` 「credits 冻结维持」分支算出
`at = acc.nextResetAt || monthlyAt || 0`，`at=0` 时只写了 poll recovery 而**不写
`acc.nextResetAt`** → 下一拍探测时刻缺失（frozen+无时刻 → 每 5min 探测风暴）。

**修法**：该分支补 `acc.nextResetAt = at || Date.now() + CREDITS_RECHECK_MS`（已有精确值时保持原值，
**不覆写**已精确语义；`at=0` 时以重探周期兜底）。
**行为变更声明**：仅新增字段赋值，无状态码/返回/日志变化。

### 1.5 #16 OAuth 旧 Promise reject 可能 unhandledRejection（router 分片）

**根因**：`ops/oauth.js` 多处调 `st._ccLoginReject(...)`；UI 只 `commandcodeLoginStart` 而**不**
`commandcodeLoginWait`，故该 reject 落在无人 await 的 promise 上 → unhandledRejection。

**修法**：创建 `promise` 后立即 `promise.catch(() => {})`。**静态论证不改变语义**：
`commandcodeLoginWait` 用的仍是**同一 promise 本体**（`st._ccLoginPromise`），其
`await`/`Promise.race` 依旧收到同一 reject —— `.catch()` 只标记该 rejection 为「已处理」。
**行为变更声明**：无对外行为变化（仅消除进程级 unhandledRejection）。

### 1.6 #17 startProviderServer 未在 listen 前占位（router 分片）

**根因**：`endpoint.js` 只在 `listen` 回调里写 `state.providerServers[id]` → 并发两次调用都通过
顶部 `if (state.providerServers[id]) return;`，第二次 listen 同端口失败；且旧 `error` 处理器按 id
删除，会把**第一个**的登记删掉（登记与进程脱节，`stopProviderServer` 漏 close）。

**修法**：`listen` **前**占位写入；`error` 处理器改为
`if (state.providerServers[id] === server) delete ...`（**身份比较**，防误删后来者登记）。
**行为变更声明**：并发调用由「启动两次 + 泄漏」变为「第二次早退」；错误路径不再误删他人登记。

### 1.7 #20 只读视图内写副作用（router 分片）

**根因**：`views.js` 调 `p._ensureLimit(a)`，而 `base.js:138` → `freeze.ensureLimit` 会
**赋值 `acc.limit`**（写）—— 只读视图产生写副作用。

**修法**：`freeze.js` 新增**纯** `previewLimit(acc)`（与 `ensureLimit` 逐字段同逻辑、同返回形状，
但**不赋值、不 persist**）；`base.js` 新增 `_previewLimit`；`views.js` 改用它。写版
`ensureLimit` 的调用从视图路径移到**状态投影完成处**：`base.js` 的
`applyDetection(acc, det)` 在 `freeze.applyDetection` 之后调 `freeze.ensureLimit(acc)`。
**行为变更声明（状态投影写入位置）**：视图输出字段**逐字段不变**（previewLimit 同逻辑）；
`acc.limit` 的补齐时机从「首次渲染视图时」提前到「每次状态检测后」—— 后者本就是唯一真正的状态投影点，
且不额外 persist（与旧视图路径的持久化语义一致）。

**合成应用审计（本方案的导入项）**：下级最初把 `freeze.applyDetection` 改名为
`applyDetectionLocked` + 4 行 wrapper，**这会让 CI 转红**：`test/probe-gate-and-ownership-test.js:50`
以**非贪婪**正则 `/function applyDetection\(acc, det, provider\) \{[\s\S]*?\n\}/` 钉住该形态，
`match` 取首个匹配 → 命中的 wrapper 体内 `indexOf('acc.lastProbeError = null;')` = -1 →
`body.slice(0,0)` 空串 → E-a 两条断言双双 FAIL。已要求并已**恢复原函数名与签名**（堡垒保留
`applyDetection` 为唯一入口、内联 `acc.lastProbeAt = Date.now();`），改为在 `base.js` 收口。
主控复核：抽取到的函数体含 `acc.lastProbeError = null;`（1 次）与失败分支 `!acc.nextResetAt` 守卫 ✓。

### 1.8 #18 frp 启用但 serverAddr 为空仍 start frpc（relay 分片）

**根因**：`frp.js#loadSettings` 把 `serverAddr` 归一为 `String(s.serverAddr || '')`，空值被静默接受；
`frp.start()` 仍会 spawn frpc（连到空地址、永不建隧道）。

**修法（写入口 + 执行边界双闸，与 FIX-1 同型）**：
- `core.js` 新增纯函数 `validateFrpServerSettings(settings)`（未启用恒放行，关闭方向不受闸）。
- 写入口 `ops.js#frpAction('settings')`：`next.enabled` 时写前拒启（`{ok:false,error}`，**不落盘、
  不 syncFrpc**）。
- 执行边界 `frp.js#start()`：任何 spawn 前无条件复校，失败返回
  `{ ok:false, error, needServerAddr:true }`。覆盖 `restart`/`_scheduleRestart`/
  `syncFromInstances`/`frpAction('toggle')` 全部 spawn 路径（含旧 `frp.json enabled:true` 与
  停用态手动 toggle）。
**未回退 P3-F 的 FIX-1**：`ops.js#syncFrpc` 的 `validateFrpExposure` 复校**逐字保留**，本批只新增。

**行为变更声明**：`frpAction('settings')` 在 `enabled:true` 且 `serverAddr` 空时由恒 `{ok:true}`
变为 `{ok:false,error}` 且不持久化；`FrpManager.start()` 新增失败返回。

**CI 风险核验**：`frp-resilience-test` / `round13-frpc-integrity-test` 的 `saveSettings` 全部使用
**非空** `serverAddr`（`1.2.3.4` / `127.0.0.1`），不受影响；全仓无 `frpAction('settings')` 行为断言。

### 1.9 #19 受管清单 main 优先级（relay 分片）—— 核实为**非缺陷**，只修注释

**核实**（主控独立复核）：
- 沙箱 id 恒为 `inst-*`：`instance/ops.js:34` `const id = 'inst-' + Date.now() + '-' + rand`；
  `model.js#createRecord` 恒 `domain:'sandbox'`。
- 历史 `id==='main'` 记录在装配期被 `app/assembly/compose/domains.js:54` →
  `app/state/store.js#migrateMainRecord`（`:64-92`）`splice` 出 `instances.json`。
- daemon 模式（`app/daemons/runtime.js:66-69` 合成 `lan-state.json`）下 main 经 `all()` 进数组，
  但 `daemon.js` **不注入 `mainOf`** —— 两模式互斥（`supervisor.js:27-28` vs `:39-47`）。
⇒ 同一次 `allManaged()` **不可能出现同 id 项**，「main 被沙箱抢先命中」不成立。
**改动**：`managed.js` 与 `ops.js:56` 注释改为实际语义（沙箱在前、main 在尾、无同 id 项）+ 依据。
**行为变更声明**：**零行为变更**（函数体与 `instances.all()` 接口未动）。
**消费方影响**：`_allManaged()` 的消费方（`ops.js` list/setFrp(peers)/frpStatus/`_findManaged`、
`ops/reconcile.js`）不依赖顺序/条数。

### 1.10 #23 `stateContainer` —— **否决删除**（本轮不执行）

下级按积压原文执行了删除，主控**裁定驳回并要求回退**，已恢复。依据（三条独立证据）：
1. `EXECUTION-CONTRACT.md:61` 是「**必须导出**」表，逐字列明 `model.js` 必须导出
   `{ INSTANCE_STATES, isServable, occupiesSlot, stateContainer, serializeInstance, deserializeInstance }`；
2. `release/scripts/export-consumers.sh` 对上述**每一个**符号均判「**不可删**」
   （`stateContainer`/`isServable`/`occupiesSlot`/`serializeInstance` 各 1 处 docs 消费者，
   `deserializeInstance` 另有 1 处 src 消费者）；
3. P2 的 `_p2-ws1b-domains.md:161` 早已就这组符号裁决「保留（冻结具名导出）」；积压 P3-E 亦写
   「删前**需裁决**」。
⇒ 积压 #23 的描述「全仓 2 处=定义+导出」**漏了契约文档**，属误判。

**流程教训（已由主控采纳并写入作业单 §1 R2 条目）**：R2 的扫描面不完整 —— 除「全仓 grep 含
test/bin」外**还必须比对 `EXECUTION-CONTRACT.md` 的「必须导出」表**；表内符号即使代码零调用也不得删，
要删必须**同批修订契约表**（属根级 .md 分区），不得 src 侧单方删。这与 `f410a3a`
（`contract/runtime.js` 的 `file` 导出）同类。

### 1.11 #30 三份平行实现（apps-registry 部分）

`ops/apps-registry.js#proxyUpdateStatus` 的 taskState→job.state 映射与 `instance/model.js`、
`plugin/model.js` 平行。按作业单口径加注释说明「**三份有意平行**」并交叉引用（写清各自状态词表不同、
跨域抽公共函数需三处同批并回归各自门禁）。**零行为变更**。

---

## 2. 行为变更汇总（状态码 / 返回 / 日志 / 持久化）

| 项 | 变更 |
|---|---|
| #2 | 非流式体 300s 无进展 → destroy 上游 + `STREAM_ABORTED` 日志 + `router_stream_aborted` 事件 + 计熔断（原永久悬挂） |
| #5 | `steps[*]` 新增加性字段 `reason`；执行期实例消失 → 如实 `failed` + 计入 `errors` |
| #12 | `/dist/registry/probe` 非法/内网/IPv6/单标签目标 → **400**（原有 200 探测） |
| #17 | 并发 `startProviderServer` 第二次早退；错误路径不再误删他人登记 |
| #18 | `frpAction('settings')` 启用且地址空 → `{ok:false,error}` 且不持久化；`FrpManager.start()` 新增失败返回 |
| #20 | `acc.limit` 补齐时机从「首次渲染视图」提前到「每次状态检测后」；视图输出字段不变 |
| #15/#16/#19/#30 | 无对外行为变化（#19 零变更；#16 仅消除进程级 unhandledRejection） |

---

## 3. 主控独立复核（未采信下级自证）

| 复核 | 方法 | 结果 |
|---|---|---|
| E-a 形态钉子 | 用测试同款非贪婪正则**逐字模拟抽取** `freeze.js` 的 `applyDetection` | 函数体含 `acc.lastProbeError = null;`（1）+ 失败分支 `!acc.nextResetAt` **✓ 不再空串** |
| R-b 熔断实参 | `grep -vE '^\s*//'` 剥行注释后按行抽取实参 | **2 处，均为 `inst`**（`BARE_ACC` 不命中）✓ 与 P3-F 的 #1 修复一致 |
| PG-4 符号 | `provider-gateway-gate-test.js` 读 `FORWARD + forward.js`，断言 `_switchBudgetMs`/`DEFAULT_SWITCH_BUDGET_MS`/`prewarmAsync` | 两符号在 `forward.js` 各 1 次 **✓ 仍在** |
| 导出面 | `forward.js` 尾行 | `{ createForwarder, readUpstreamBody }` **✓ 未变**（抽取后仍可 re-export） |
| #19 前提 | `instance/ops.js:34` id 生成 + `createRecord` 恒 sandbox + `migrateMainRecord` 语义 + `runtime.js:65` 合成注释 | **✓ 声称成立**（id 空间不相交、两模式互斥） |
| #18 测试风险 | 三个 frp 测试的 `saveSettings` 实参 | 全部**非空** `serverAddr` **✓ 不受影响** |
| `ports.list` 删除 | 原始 `grep` relay 域内成员访问 | relay 只用 `rangeOf/claim/releaseOwner/purgeDuplicates/ensureMarked`，**无 `.list()`** ✓（其余 `ports.list()` 调用点均指 `platform/service/ports`） |
| `SEGMENTS` 删除 | 追查 EX 报的 test=2 | 系 `test/_ports.js` 自有同名常量与 `router/port-segments.js` 的**同名碰撞** ✓ |
| `hasCookie` 删除 | 全仓 `grep -rnw` | 代码命中 0（仅过程文档）✓ |
| 结构门禁 | `node --check` 16/16；DG-2 最大 288；DG-11 命中 0；DG-15 函数体 require 0；X-1 操作者路径 0 | **全部通过** |

---

## 4. R1 / R2 证据

### 4.1 R1（注释钉子）
把本域**全部新增行**（178 行）切成 CJK ≥4 字（143 个去重 token）与 ASCII ≥6 字符，逐个在 `test/` 全量匹配
（CJK 用 `grep -oP '\p{Han}{4,}'`，不用会静默返回空的 `grep -E` 区间写法）。CJK 有 12 个 token 在 `test/`
有命中，经**决定性过滤**（该命中行是否含 `.test(`/`includes(`/`indexOf(`/`match(`/`new RegExp`）后只剩 2 个：

`test/lifecycle-restart-failure-test.js:54`（`/停止失败/`）与 `:67`（`/启动失败/`）——
**二者断言的是运行期 `r.error` 值**（`ManagedLifecycle.restart` 的返回），**不是源码文本**；且该测试钉的
是 `entry.js`（P3-F 已核），本批未改 `entry.js`。故 **本域新增文本无源码形态钉子**。

另逐条核验了被测试以源码形态钉住、且落在本域改动文件上的判据，**全部仍在位**：
`function validateFrpExposure`(1)、`无效的公网端口`(1)、`已被实例「`(1)、`function isTrustedSource`(1)、
`markInstanceNetFail`(4)、`endInflight`(11)、`_switchBudgetMs`(1)、`prewarmAsync`(1)、
`'/dist/registry/probe'`(1)、`^https?:`(2)。

### 4.2 R2（死代码）—— **EX 结论不作依据，已全部原始 grep 复核；删除数 = 3**

**工具假阴性（重要）**：`release/scripts/export-consumers.sh` 的定义行判据含**裸子串**匹配
`sym( ... ) { `，不校验词边界 → 门面转发器 `_foo(inst) { return targets.foo(this, inst); }` 被判为「定义行」，
把该文件里**真实的生产消费点藏进「定义文件」** → 误报「可删」（危险方向）。主控与 P4-C 均已复现；
P4-D 已受命修复（词边界 + 保守即不可删）。**本批一律不用 EX 结论作为删除依据。**

- **router 分片**：重新枚举当前树（41 个 `module.exports` 文件、约 120 个符号）；EX 判「可删」的 20 个候选
  逐个原始 `grep -rn` 复核 → **16 个是假阴性**（有真实生产消费者，如 `canStopInstance`←`proxy.js:129`、
  `createAgents`←`index.js:36`、`ensureLimit/freezeLimited/normalizeConsistency`←`base.js`、
  `limits`←`pool.js:106`、`newServer`←`index.js:102` 等），**一律保留**。
  **旧导出删除数 = 0**。
- **relay 分片**：EX 判可删 9 项，其中 **6 项是假阴性**（`allManaged`/`findManaged`/`syncProxyQueued`/
  `reconcileOnce`/`startLanServer`/`stopLanServer` 均为 `ops.js:55/57/188/192/271/272` 的**真实跨文件消费者**，
  被 `_allManaged(){...managed.allManaged(...)}` 之类下划线包装触发误判），保留。实际删 **3**：见 §0。
- **契约表比对**：#23 的 `stateContainer` 因 `EXECUTION-CONTRACT.md:61` 被否决（§1.10）。

---

## 5. 余量清单（供后续排期；行数实测于本批收尾时）

| 文件 | 行数 | DG-2 余量 |
|---|---|---|
| `router/handlers/forward.js` | **288** | 12（**本批从 300 降下来**） |
| `relay/ops.js` | 283 | 17 |
| `router/providers/proxy.js` | 279 | 21（未改，列出供排期） |
| `router/providers/policies/freeze.js` | 254 | 46 |
| `relay/frp.js` | 251 | 49 |
| `router/providers/base.js` | 202 | 98 |
| `router/ops/apps-registry.js` | 186 | 114 |
| `router/views.js` | 146 | 154 |
| `router/ops/oauth.js` | 140 | 160 |
| `router/endpoint.js` | 143 | 157 |
| `api/domains/dist.js` | 110 | 190 |
| `router/model.js` | 94 | 206 |
| `router/handlers/upstream-body.js`（新增） | 54 | 246 |
| `relay/managed.js` | 37 | 263 |
| `relay/port-segments.js` | 19 | 281 |
| `relay/ports.js` | 51 | 249 |
| `relay/session.js` | 145 | 155 |

**接线**：`scripts.test` **未改**（链长仍 7899/8000），本批未新增测试文件。

---

## 6. 跨分区缺口（known-uncovered，需另派）

**#12 的闭环缺一半（重定向绕过）**：`platform/distribution/registry.js:99` 的探测用
`fetch(target.url, { signal })` —— **默认跟随重定向**。故即使目标 host 为公网，攻击者控制的公网主机
仍可 `302` 到内网地址，绕过本批在 **api 层**实施的 host 判据。
**结构解需在 platform 层**（`redirect: 'manual'` 或校验跳转目标），属 P4-C 分区（主控已转）。
本批只做 api 层闸，**不构成完整闭环**，如实登记。

---

## 7. CI 风险与自证边界

**已静态自证不红**（本机禁跑测试，实测交 CI）：
- E-a 形态钉子（§3 已用测试同款正则模拟）；R-b 熔断实参 2 处皆 `inst`；PG-4 符号仍在；
  `forward.js` 导出面未变；relay 三处删除经原始 grep + 消费方核验；#18 的 frp 测试地址非空；
- `node --check` 16/16；DG-2/6/11/15 与 X-1 全通过；`scripts.test` 未改。

**残余风险（无法静态排除，需 CI 裁决）**：
1. #5 的 `reason` 为**加性**字段，但若某测试对 `steps` 做**深比较**（`deepStrictEqual`）会因新键失败；
   已 grep 未发现此类断言，但不能排除运行期形态。
2. #2 的 300s 非流式上限在 CI 上**不会被触发**（正常响应远快于此），故其正确性只能靠代码审阅 + 反向推理，
   CI **不会**给出正向证据。
3. #12 的目标判据对「域名解析到私网」（DNS rebinding）**不覆盖** —— 只判字面 host；需运行期解析期校验
   （属 platform 层，与 §6 的重定向缺口同批更合理）。
4. `previewLimit` 与 `ensureLimit` 的同逻辑**靠人工保持同步**，无门禁约束二者等价（登记项，非缺陷）。

**方法边界**：全程未执行产品代码（无 `require`、无内存冒烟）；未跑任何测试/门禁；未做 git 写操作。
