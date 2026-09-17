# P4-B-1（router 分片）交付报告

> 范围：独占 `src/domains/router/**`（只改本目录；另新增报告文件）。
> 约束遵守：未跑任何测试/门禁、未 require 产品模块、未做内存冒烟；未 git 写；未启 daemon。
> 全部结论以 `node --check` + 静态判据 + 只读 grep/git 为证据，最终以 CI 为准。
> 行号均为本报告写入时的当前树。

## 0. 交付摘要

| 积压# | 结果 | 主要文件 |
|---|---|---|
| #2 非流式响应体无超时 | 已修（结构解：抽新模块 + 总时长上限） | `handlers/forward.js`、新 `handlers/upstream-body.js` |
| #5 更新步骤集创建时快照 | 已修（执行时按 keyId 重取活实例） | `ops/apps-registry.js` |
| #15 credits 维持分支不补 nextResetAt | 已修 | `providers/policies/freeze.js` |
| #16 OAuth 旧 Promise reject 可能 unhandled | 已修（自吞 catch） | `ops/oauth.js` |
| #17 startProviderServer 未 listen 前占位 | 已修（占位 + 身份比较） | `endpoint.js` |
| #20 只读视图内写副作用 | 已修（previewLimit 纯读 + 写回投影路径） | `providers/policies/freeze.js`、`providers/base.js`、`views.js` |
| #23 stateContainer 死导出 | **否决删除**（契约要求保留；见 §7） | `model.js`（净零改动） |
| #30 apps-registry 平行实现 | 加注释（不改行为） | `ops/apps-registry.js` |
| #29 router 零消费者导出 | 重新枚举 + 原始 grep 复核；**旧导出删除数 = 0**；仅删 1 个本轮新增符号的导出键 | 见 §9 |

**行数（DG-2 ≤300）**：`handlers/forward.js` 300→288、`handlers/upstream-body.js` 新增 54、
`providers/policies/freeze.js` 247→254、`providers/base.js` 201→202、`views.js` 146、
`ops/oauth.js` 140、`endpoint.js` 143、`ops/apps-registry.js` 159→186、`model.js` 94。全部 ≤300。

**node --check**：对上述 9 个文件逐一执行，全部 `ALL_CHECKED`（无语法错误）。

---

## 1. #2 非流式响应体收到头后无任何超时（可永久悬挂）

### 改动
1. 新增 `src/domains/router/handlers/upstream-body.js`（54 行）承接上游体读取/透传：
   - 模块级常量 `NONSTREAM_BODY_MAX_MS = 300000`（`upstream-body.js:12`）：注释写明「收到响应头后的体读取原本无任何时限，上游挂起即永久悬挂；300s 远大于正常非流式响应时长，仅作兜底」。
   - `trackUpstreamBody(ur, opts)`（`:34`）：绑定 data/end/aborted/error/close 透传与背压（`onData` 返回 false 即 `ur.pause()`，`res` 的 `drain` 恢复）；**仅非流式**（`!streamRequested`）设总时长定时器，到期 `ur.destroy()` 后走 `onAbort`；`timer.unref()` 防拖住进程；返回 `{ cancel }`。
   - `readUpstreamBody` 由 `forward.js` **原样搬入**（含原 JSDoc 原文）。
2. `handlers/forward.js`：
   - `:4` 改 `require('./upstream-body')`；`module.exports` 仍为 `{ createForwarder, readUpstreamBody }`（对外导出面**不变**）。
   - `:226` `writeThrough` 的上游体绑定 6 行改为 `trackUpstreamBody(...)` 调用；`:236` 客户端断开路径补 `body.cancel()`。
   - 原 `ur.on('data'/'drain'/'end'/'aborted'/'error'/'close')` 6 行整体移入新模块。
3. 行数：forward.js 288 行（DG-2 红线 300），**未为凑行数删任何注释**（结构解腾出 15 行）。

### file:line 证据
- `handlers/upstream-body.js:12`（常量）、`:34-52`（trackUpstreamBody）、`:54`（exports）。
- `handlers/forward.js:4`、`:226-231`（调用）、`:236`（cancel）。

### 行为变更声明
- **新增**非流式上游体总时长上限 300s。到期：`ur.destroy()` → `finishAborted()` → `endInflight(acc, prov)`；日志 `STREAM_ABORTED key=... bytes=...`（沿用既有文案）；`events.append('router_stream_aborted', ...)`；经 `parse.instOf` 取实例后 `prov.markInstanceNetFail(inst)`（**计入熔断**）；`res.destroy()`（头已发出，无状态码，客户端见截断/重置）。
- 流式（`streamRequested`）**不设限**，语义与改前一致。
- `readUpstreamBody` 行为逐字不变（错误响应体有界读取）。

### CI 风险
- 新文件位于 `handlers/`（`test/directory-structure-gate-test.js:202` DS-G6 白名单含 handlers），DG-7 rank(handlers)=1，forward(1)→upstream-body(1) 不越级；DG-6 叶子（有 exports、无顶层副作用）成立。
- R1：搬走的 `readUpstreamBody` JSDoc 原文保留在新模块（非删除）；forward.js:7 头注改为「只 require ./parse 与 ./upstream-body」，保留原行全部命中 token（`require`/`endInflight`/`effects`）。
- 未改熔断实参（#1）；`markInstanceNetFail`/`endInflight`/`markRequestOk`/`_switchBudgetMs`/`prewarmAsync` 仍在 forward.js（静态复跑 `router-circuit-breaker` R-a/R-b/R-e 与 `provider-gateway` PG-4 的正则均命中，见 §10）。

---

## 2. #5 应用更新步骤集是创建时快照（常驻实例静默空转）

### 改动（`ops/apps-registry.js`）
- `:66` 快照改为 `{ providerId, keyId, maskedKey }`（只快照标签；不再持有 `inst` 引用）。
- `:101` 新增 `resolveStep(i)`：`getProviders()` 按 `providerId` 找 provider，再 `(p.instances||[]).find(x => x.keyId === keyId)` 取**活实例**；取不到 →（未记过失败时）`job.errors++` + `setStep(i,'failed','实例已不存在（可能已被移除或重建）')` + `tasks.log` 跳过原因。
- `:114/:123` 两个执行循环均改用 `resolveStep(i)`；stop 失败、start 失败、缺 `inst.key` 均带明确 reason。
- `:129` `proxyRunning` 改为按 `providerId` 重取 provider 后设置（`targets` 同为创建时快照）。
- `:179` `proxyUpdateStatus` 的 job 回退分支 steps 附加 `reason` 字段。

### 行为变更声明
- 执行时按 `keyId` 重取实例：实例在 stop/start 之间被重建时不再操作旧引用（消除静默空转/假成功）。
- 取不到实例：步骤置 `failed` 且 `job.errors` 递增；同一缺失实例在两个循环中**只计一次**（状态守卫）。
- 进度视图新增附加字段 `steps[].reason`（仅无 task 历史的 job 回退分支；task 分支不变）。属**加字段**，不改变既有字段。
- 步骤标签、`tasks.step`/`tasks.stepState` 调用形态不变（`test/probe-gate-and-ownership-test.js` E-e 静态复跑命中）。

### CI 风险
低。E-e 两条源码级判据（`tasks.step(task.id`、`tasks.stepState(task.id`）保持命中（见 §10）。

---

## 3. #15 credits 冻结维持分支不补 nextResetAt（探测风暴）

### 改动
`providers/policies/freeze.js:197`：在 credits 维持冻结分支、算完 `at = acc.nextResetAt || monthlyAt || 0` 后补一行
`acc.nextResetAt = at || Date.now() + CREDITS_RECHECK_MS;`

### file:line 证据
- `freeze.js:195`（`const at = ...`）、`:197`（新增赋值）、`:198`（`setLimit`）。

### 行为变更声明
- `at` 已有精确值时保持原值（不覆写已精确语义）；`at === 0` 时以 10 分钟重探周期兜底，令下拍探测时刻存在。
- 影响：`nextResetAt` 由「0/缺失」变为有限未来时刻，调度层据此排程，消除 frozen 无时刻导致的探测风暴。

### CI 风险
低。`test/monthly-credits-freeze-test.js` / `test/upstream-credits-test.js` 未断言该分支 nextResetAt 必须为 0；`test/probe-gate-and-ownership-test.js` E-a 只断言**失败分支**设置 nextResetAt（该分支未动）。静态复跑 E-a 通过（见 §10）。

---

## 4. #16 OAuth 旧 Promise reject 可能 unhandledRejection

### 改动
`ops/oauth.js:89`：创建 `promise` 后立即 `promise.catch(() => {});`，再 `:90` 赋给 `st._ccLoginPromise`。

### 静态论证（为何不影响 wait）
- `promise.catch(fn)` 只是**派生**一个新 promise 并忽略之；它把原 promise 的 rejection 标记为「已处理」，从而不再触发 `unhandledRejection`；**不改变原 promise 本体的 settle 值与状态**。
- `commandcodeLoginWait` 读的是 `st._ccLoginPromise`（`:113`），即**同一 promise 本体**，其 `await`/`Promise.race` 仍会收到同一 `reject`。因此「自吞」不会把失败吞成成功。
- `_ccLoginResolve = st._ccLoginReject = null` 两处清理（`:117`/`:123`）不变；`test/probe-gate-and-ownership-test.js` E-f 的 `n === 2` 与反向「只清 promise」判据静态复跑仍满足（见 §10）。

### 行为变更声明
无对外可观察行为变化（仅消除未处理 rejection 告警）。

---

## 5. #17 startProviderServer 未在 listen 前占位

### 改动（`endpoint.js`）
- `:63` 在 `server.listen(...)` **之前**写入 `state.providerServers[id] = server;`（占位）。
- `:64-68` error 处理器改为身份比较：`if (state.providerServers[id] === server) delete state.providerServers[id];`。
- listen 回调不再写 map，只发事件/日志。

### 行为变更声明
- 并发两次 `startProviderServer(id)`：第二次被 `:59` 的既有 guard 拦住（占位已在），不再发起第二次同端口 listen。
- 旧 server 的迟到 error 不再误删新 server 的登记。
- `stopProviderServer`（`:76-79`）语义不变；`ops.js:132` 的遍历关闭不变。

### CI 风险
低。无测试以源码形态钉 `startProviderServer`。

---

## 6. #20 只读视图内发生写副作用

### 改动
- `providers/policies/freeze.js:55` 新增**纯** `previewLimit(acc)`：与 `ensureLimit` 逐字段同逻辑、同返回形状，但**不赋值、不写盘**（`:254` 导出）。
- `providers/base.js:140` 新增 `_previewLimit(acc)`；`views.js:83` 改用 `p._previewLimit`。
- `providers/base.js:147` `applyDetection` 改为：`const r = freeze.applyDetection(acc, det, this); freeze.ensureLimit(acc); return r;`（唯一投影入口，覆盖 scheduler/probe/quotasync/instance-lifecycle 等全部调用方——它们都经 `provider.applyDetection`）。写版 `_ensureLimit`（`:138`）保留（`test/upstream-credits-test.js:91` 消费）。

### 视图输出字段不变（逐字段对比）
- 旧 `_ensureLimit` 返回：`acc.limit`（已存在时原对象）；否则按 status 计算 `{ kind, since, reason, recovery }`（banned/window/credits 三分支）。
- 新 `previewLimit` 返回：命中已有 limit → **同一对象**；否则返回**同字段同取值**的 `{ kind, since, reason, recovery }`。故视图字段集合与语义完全一致；差别仅「不再把兜底 limit 写回 acc」。

### 行为变更声明（状态投影写入位置）
- `limit` 兜底写入从「只读视图 `listProviders`（且不 persist）」移到「`ProviderBase.applyDetection` 状态投影完成后（同样不额外 persist，保持旧持久化语义）」。
- 状态机声明形态**逐字不变**：`freeze.js:142` 仍为 `function applyDetection(acc, det, provider) {` 且首行 `acc.lastProbeAt = Date.now();`（为满足 `test/probe-gate-and-ownership-test.js:50` 的非贪婪形态钉，本轮曾误加 wrapper 后已回退，见 §8）。

---

## 7. #23 stateContainer 死导出 —— 经契约为由**否决删除**

核验与结论：
- `release/scripts/export-consumers.sh stateContainer`：**不可删**（定义文件外 1 处消费者：`docs`）。
- `EXECUTION-CONTRACT.md:61` 的「必须导出」表逐字列明 `model.js` 必须导出
  `{ INSTANCE_STATES, isServable, occupiesSlot, stateContainer, serializeInstance, deserializeInstance }`。
- P2 已在 `design-notes/_p2-ws1b-domains.md:161` / `..._domains-router-b.md:60` 裁定「保留（冻结具名导出）」；P3-E 积压亦写「删前需裁决」。
- 原积压「全仓 2 处=定义+导出」的说法**漏了契约文档**，属误判。

处理：本轮一度删除 `stateContainer` 函数体与导出键，**已按主控裁定原样恢复**；`git diff src/domains/router/model.js` 为空（净零改动）。
同一组冻结导出 `isServable/occupiesSlot/serializeInstance/deserializeInstance` **一个未删**。

---

## 8. 本轮两处「形态钉子 / 契约」近失（已回退，供主控登记）

1. **`freeze.js` applyDetection wrapper（已回退）**：曾把原函数改名 `applyDetectionLocked` 并加 wrapper。`test/probe-gate-and-ownership-test.js:50` 用非贪婪正则 `/function applyDetection\(acc, det, provider\) \{[\s\S]*?\n\}/` 取**第一个**匹配，wrapper 会截断抽取、令 E-a 双断言失败。已改为 A 方案：函数名/签名/首行逐字恢复，写版 `ensureLimit` 调用移到 `base.js:147`。
2. **`stateContainer` 删除（已恢复）**：见 §7。

---

## 9. #29 当前树零消费者导出（重新枚举；删除数 = 0 + 1 个本轮新增符号）

### 方法
- 重新枚举当前树：`grep 'module.exports =' src/domains/router` 命中 41 个文件；用括号配平提取**顶层**导出键，去重后约 120 个符号。
- 对每个符号执行 `release/scripts/export-consumers.sh <符号>`（一次性批量，输出汇总）。
- **EX 结论不作依据**：该工具定义行判据含裸子串 `sym( ... ) { `，会把门面转发器 `_foo(inst) { return targets.foo(...) }` 判为「定义行」，系统性**假阴性**（危险方向：误报可删）。故对 EX 判「可删」的 **20 个**候选逐个做原始 `grep -rn`（`src`/`test`/`bin`/`ui`/`release` + 根级 `*.md`），并检查同文件 `this.<名>` 间接消费。

### EX 判「可删」的 20 个候选 —— 复核结论
**A. 假阴性（有真实生产消费者；一律保留）共 16：**

| 符号 | 真实消费者（原始 grep） |
|---|---|
| canStopInstance | `providers/proxy.js:129` `life.canStopInstance(this, acc)` |
| createAgents | `index.js:36` `endpoint.createAgents()` |
| ensureLimit | `providers/base.js:138/147` `freeze.ensureLimit` |
| freezeLimited | `providers/base.js:142` |
| limits | `providers/pool.js:106`（pool 门面返回）+ `providers/proxy.js:250` `this._pool.limits()` |
| newServer | `index.js:102` `this._endpoint.newServer`；`endpoint.js:140` |
| normalizeConsistency | `providers/base.js:148` |
| previewLimit | `providers/base.js:140`（本轮新增） |
| probeAfterResponseFreeze | `providers/proxy.js:233` `probe.probeAfterResponseFreeze` |
| reconcileLock | `providers/base.js:149` |
| runReconcile | `providers/proxy.js:267` `restart.runReconcile` |
| setLimit | `providers/base.js:141` |
| setStatus | `providers/base.js:137` |
| stateCounts | `providers/pool.js:108`（pool 门面返回）+ `providers/proxy.js:252` `this._pool.stateCounts()` |
| stopInstanceIfAny | `providers/proxy.js:215` `life.stopInstanceIfAny` |
| windowExhausted | `providers/base.js:123` `quota.windowExhausted` |

**B. 真实零消费者，但 P2 已裁定「冻结具名导出」→ 保留（不删）共 3：**

| 符号 | 定义/内部使用 | P2 裁定 |
|---|---|---|
| CONFIG_PATH | `config.js:30`（定义）/`:33`（内部）/`:40`（导出） | `_p2-ws1b-domains.md:161` 保留 |
| POOLS | `port-segments.js:14`/`:29`（`registerPools(POOLS)`）/`:32` | `_p2-ws1b-domains-router-b.md:58`「保留（申报数据）」 |
| graphicalEnv | `ops/browser.js:14`/`:53`（`openInBrowser` 内部）/`:83` | `_p2-ws1b-domains.md:159` 保留 |

**C. 本轮新增符号的导出键 → 删除 1：**

| 符号 | 删除键 | 消费者计数（原始 grep） |
|---|---|---|
| NONSTREAM_BODY_MAX_MS | `handlers/upstream-body.js:54` 从 module.exports 去掉（常量仍在 `:12`，函数内部 `:42` 使用） | `src`=2（定义+内部使用，同一文件）；`test`=0；`bin`=0；`ui`/`release`=0；根级 `*.md`=0；design-notes=0 |

**旧导出删除数 = 0；本轮新增符号删除数 = 1。** 全程零依据 EX 结论删除。

备注：`test/_ports.js` 自有同名常量等「同名不同物」碰撞已按「文件+符号+调用形态」排除；`EXECUTION-CONTRACT.md`（根级 docs）对上述候选均无命中（EX `docs=0`），故不涉及 §7 类契约否决，但仍尊重 P2 保留裁定。

---

## 10. 静态复跑（未执行测试，仅读取源码套用其判据正则）

- `probe-gate-and-ownership-test.js` E-a：`located=true`、失败分支切片 509 字符、`hasNextResetAt=true`、`hasGuard=true`。
- `router-circuit-breaker-test.js`：R-a `markRequestOk=true`；R-b 无 `.markNetFail(` 调用、存在 `markInstanceNetFail`、抽到实参 `["inst","inst"]`、无裸 `acc`；R-e `endInflight(acc, prov)` 计数 4（≥2）。
- `probe-gate` E-e：`tasks.step(task.id`=true、`tasks.stepState(task.id`=true。
- `probe-gate` E-f：`_ccLoginResolve = st._ccLoginReject = null` 出现 2 次；反向「只清 promise」模式 = false。
- `provider-gateway-gate-test.js` PG-4：`_switchBudgetMs`/`prewarmAsync` 仍在 forward.js（原始 grep 命中）。

以上为静态判据复跑，不构成测试结论；实测交 CI。

## 11. 未派下级说明
本分片文件独占（`src/domains/router/**`），为避免写冲突未再派生下级；派分表由父代理统管。

## 12. 剩余风险 / 建议
- #2 的 300s 总时长上限为经验值；若判断大响应需更长，改 `upstream-body.js:12` 单点常量即可。
- #29 的 3 个「P2 冻结导出」若要最终收敛，建议单独一批：同时处理 `EXECUTION-CONTRACT.md` 等根级契约文档与 `test/` 消费点。
- `release/scripts/export-consumers.sh` 的裸子串定义行假阴性建议由 P4-D 修（与 #29 证据一致性相关）。
