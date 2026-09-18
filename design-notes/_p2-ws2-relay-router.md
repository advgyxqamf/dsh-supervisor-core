# Phase 2 WS2-a 修复报告（relay / router 分片）

作业单：`design-notes/_workorder-phase2.md` §4 WS2（N6/N7/N8/N9/N10）。
分区：独占以下 5 文件，未改其它 `src/`、未改 `test/`、未改 `bin/`、未改 `package.json`、未改 `ui/`。
本轮只做修复，未运行任何测试/门禁；仅 `node --check`、`grep`、`read`、`wc`、`git status/diff/log`（只读）。

## 1. 改动文件清单

| # | 文件 | 缺陷 | 一行理由 |
|---|---|---|---|
| 1 | `src/domains/relay/session.js` | N6 | 给换取加令牌换代序号（epoch）与统一单飞入口，令 `refreshDshSession` 后旧代在途结果无法覆盖新 cookie。 |
| 2 | `src/domains/router/providers/probe.js` | N7 | **未改动**：装饰符号（含 Unicode 箭头）扫描 0 命中，确认上一轮符号清理已覆盖。 |
| 3 | `src/domains/relay/frp-install.js` | N8 | 取校验表失败（网络错误）不再把 `null` 写进生命周期级 `_sumCache`，避免一次离线后永久跳过 sha256。 |
| 4 | `src/domains/router/providers/quota-strategies.js` | N9 | `derivedMonthly` 增加 `hasCredits` 守卫，credits 缺席时不再伪造月窗口 100%。 |
| 5 | `src/domains/router/handlers/forward.js` | N10 | client-abort 时 `destroy` 上游 req（内外两条早退路径），杜绝 keep-alive socket 泄漏。 |

行数（`wc -l`）：session.js 147、probe.js 277（未变）、frp-install.js 161、quota-strategies.js 144、forward.js 294。

## 2. 逐项最小改动（diff 级）与行为变更声明

### N6 `src/domains/relay/session.js`
改动（+23/-15）：
- 新增 `let bootstrapEpoch = 0;`（换代序号）。
- 抽出 `startBootstrap(dshToken, via)`：捕获发起时的 `myEpoch`，仅当 `myEpoch === bootstrapEpoch` 时才写 `dshCookie`/`recordReady`；用 `bootstrapping === pr` 判身份后再清 `bootstrapping`（防止旧代 promise 清掉新代在飞引用）。
- `refreshDshSession()`：先 `bootstrapEpoch += 1`，再 `bootstrapping = null`，若仍有令牌则 `startBootstrap(..., 'refresh')`（新代 promise 进入 `bootstrapping`）。
- `ensureDshCookie()`：`return bootstrapping || startBootstrap(dshToken, 'lazy')`（单飞语义保留）。

行为变更（对外可观测面）：
- 资源/并发：`refreshDshSession` 期间若 `ensureDshCookie` 被调用，复用同一在途 Promise，不再重复发起换取（旧实现会并发两次换取）。
- 正确性：令牌换代后，旧代在途换取即便后到也不会写 `dshCookie`，也不会清掉新代 `bootstrapping`。
- 事件/日志：`lan_cookie_exchanged`（via=`refresh`/`lazy`）、`lan_cookie_failed`、`[relay] DSH 浏览器会话 cookie 已换取` 文案与触发条件不变；唯一差别是被换代作废的旧代换取不再产生 `lan_cookie_exchanged`。
- 返回值：`ensureDshCookie` 在换代竞态下可能返回 `null`（旧代 Promise 作废），由后续请求重新换取；`mergeDshCookie`/`mergedCookieHeaders` 形态不变。
- 不改公开 API（返回对象键集合不变）。

### N7 `src/domains/router/providers/probe.js`
**确认无箭头注释残留，未改动。**
证据：
- `grep -P` 扫描 Unicode 箭头 `U+2190..U+21FF`、带圈数字 `U+2460..U+24FF`、框线 `U+2500..U+257F`、几何/杂项符号 `U+25A0..U+27BF`、emoji `U+1F000..U+1FAFF`：**0 命中**。
- 仅存 3 行 ASCII `->` 流程箭头（第 17、48、213 行）。这是上一轮符号清理提交 `b2f3d3d` 把 Unicode `→` 改写成的**受认可 ASCII 形态**（`git show b2f3d3d -- .../probe.js` 可见 `→` → `->` 的逐处替换），非未覆盖残留；按 §2「不确定就保留」不动，且改写它是无价值的语义重写（事故 A 风险）。
- R1：对上述注释特征串在 `test/` 全量 grep（`认领/弃用幸存者`、`端口分配/等待`、`byOwner 复用`、`端口分配唯一入口`、`段内最小空闲`、`幸存者`、`claimSlot`）无任何测试匹配这些注释行形态（`ports-claim-test.js:32` 的 `byOwner 复用` 是无关 console.log 文案）。故无形式钉子，也无需改动。

### N8 `src/domains/relay/frp-install.js`
改动（+1/-1）：`catch (e) { c[asset] = null; ... }` → `catch (e) { /* 不缓存失败 */ ... }`（删除唯一一行赋值，改为说明性注释）。

行为变更：
- 取官方校验表失败（离线/官方不可达）时**不再写 `_sumCache`**；下一次安装/重试会重新直连官方取得校验表，只要在线即恢复 sha256 强制校验。
- 单次 `installFrpc` 内部行为不变：`expected` 只在镜像循环前取一次，成败语义、`report` 进度文案、`[frp] 取官方校验和失败…` warn、`frpc_install_failed` 事件均不变。
- 「表已成功取到但 asset 缺失」的 `null` 仍按 asset 缓存（权威答案，保留）。
- 资源面：离线场景下每次安装多一次官方校验表请求（有界，联网即恢复；换取成功或表缺失后仍缓存）。

### N9 `src/domains/router/providers/quota-strategies.js`
改动（+1/-1）：第 106 行条件加 `hasCredits &&`：
`const derivedMonthly = (hasCredits && monthlyCap !== null && ... ) ? ... : mapW(wm.monthly);`

行为变更：
- credits 字段缺席时，`monthlyRemaining` 的 reduce 初值 0 不再被当作「月池已用尽」→ 不再伪造 `monthly.percent = 100 / status = rate-limited`；`monthly` 回退到真实 `windowMap.monthly`（通常为 `null`）。
- 下游：`quotaOverallStatus` 的 `monthlyEx` 不再因缺数据命中 → 不再出现假 `用尽`，从而消除「误冻账号」输入；`monthlyRemaining` 仍为 `null`（`hasCredits ? ... : null` 未变）。
- 无状态码/日志/事件变更；credits 正常时（含 monthlyCredits=0）派生逻辑与数值完全不变（CC9/CC11/CC13 路径不受影响）。

### N10 `src/domains/router/handlers/forward.js`
改动（+2/-2）：
- `forwardOnce` 内 `onClientClose`：`settle(...)` 前增加 `try { req.destroy(); } catch {}`。
- `proxyFor` 第 127 行外层 client-abort 早退：在 `endInflight` 后 `try { if (out.res) out.res.destroy(); if (out.upstreamReq) out.upstreamReq.destroy(); } catch {}`（覆盖「响应已到达、内层 close 监听已被 `req.on('response')` 移除」这一窄窗口）。

行为变更：
- 资源面：客户端中断时上游请求/响应 socket 立即 `destroy`，不再留 keep-alive 空闲连接等待；重试循环与 `EXHAUSTED` 路径不再复用被中断的 socket。
- 日志/事件：无新增/修改（`CLIENT-ABORT`、`STREAM_ABORTED`、`router_stream_aborted` 文案与触发点不变；`writeThrough` 原有 `destroyUpstream` 路径不变）。
- 状态码：不新增响应（客户端已断开）；`net-error`/`client-abort` 分支判定顺序不变。

## 3. 形式钉子保留项
- 本分片 **无**测试匹配到需改动的注释行，因此无形式钉子；未保留任何违规注释，也未改 `test/`。
- R1 逐条核验见 N7 段；另外对新增注释特征串 `令牌换代序号`、`startBootstrap`、`bootstrapEpoch`、`不缓存失败`、`生命周期级 _sumCache` 在 `test/`、`bin/` 全量 grep：**0 命中**。
- 运行期 error/log 文案未做任何改动。

## 4. 导出/函数/常量增删（R2 全仓核验）
- **模块导出零变化**：`session.js` 仍是 `{ createSession }`；`frp-install.js` 仍导出 `frpPlatformTag/downloadUrls/download/installFrpc`；`probe.js` 未动；`quota-strategies.js` 仍是 `{ getQuotaStrategy }`；`forward.js` 仍是 `{ createForwarder, readUpstreamBody }`。
- 新增 `startBootstrap`：`createSession` 内部私有函数（未导出）。全仓 grep（`src test bin release ui *.md design-notes .github app`，排除 node_modules/.git）仅 `src/domains/relay/session.js` 命中，无外部消费者/无命名冲突。
- 未删除任何导出/函数/常量；`expectedSha256`、`derivedMonthly` 等既有内部符号保留（`expectedSha256` 非导出、仅本文件调用，但按「宁可保留」未动签名）。

## 5. `node --check` 结果
```
src/domains/relay/session.js                    OK
src/domains/router/providers/probe.js           OK
src/domains/relay/frp-install.js                OK
src/domains/router/providers/quota-strategies.js OK
src/domains/router/handlers/forward.js          OK
```
（对 5 个文件全部执行，exit=0。probe.js 虽未改动也一并复核。）

## 6. CI 风险点
1. **N8 / round13-frpc-integrity-test**：用例 A/B/C 每组都新建 `mgr` 并重设 `mgr._sumCache = {}`、`install` 只跑一次 → 删除失败缓存不影响 A/B/C（C 仍走 catch、仍记 warn）。用例 D 读源码：新增注释行以 `//` 开头会被其 `split/filter` 剔除；`const url = 'https://github.com/fatedier.../_checksums.txt'` 与 `crypto.createHash('sha256').update(tgz).digest('hex')` 行原样保留。
2. **N9 / commandcode-quota-test**：CC7 只断言 `monthlyRemaining === null`，未断言 `monthly`；该用例 `windowMap.monthly=null`，故 `monthly` 由「派生的 {ok,0}」变为 `null` 不会触发断言。`upstream-credits-test`/`monthly-credits-freeze-test` 全部手工构造 quota，不经过本函数。若未来有断言「credits 缺席时 monthly 必须非空」的测试，需注意这是**有意的语义变更**（未知 ≠ 用尽）。
3. **N10 / router-circuit-breaker-test 与 provider-gateway-gate-test（静态门禁）**：已逐条复核——`markRequestOk(\w+)` 仍在；剥离注释后无 `.markNetFail(` 调用、`markInstanceNetFail` 仍在；`endInflight(acc, prov)` 出现 4 次（≥2）；`prov.flushRestartPending(` 仍在；PG-2 无新增 `typeof (rt.prov|activeProv|prov|this.prov) === 'function'`；PG-4 的 `_switchBudgetMs`/`prewarmAsync` 仍在。
4. **行数门禁**：session.js 由 139 → 147 行，远低于 `DS-9` 单文件 400 / `DG-2` 300 阈值，且二者对非 `index.js` 非门面；`DG-1` 门面 ≤150 不涉及本文件。其余文件行数未增（probe 未动）。
5. **N6 事件面**：被换代作废的旧代换取不再发 `lan_cookie_exchanged`；`test/loghub-test.js` 是直接 `ge.append(...)` 构造事件，不经 `relay/session.js`，无影响。`test/` 对 `refreshDshSession`/`ensureDshCookie`/`bootstrapEpoch` 零消费。
6. 未改 `scripts.test`、未加依赖、未做任何 git 写操作；工作区其它文件的改动来自其它 WS 分片，与本分片无关。

## 7. 需主控裁决
- **无**。本轮未发现任何既有 `test/` 断言会因上述改动转红；也未触碰 `test/`。

## 8. 复现命令（只读）
```bash
node --check src/domains/relay/session.js
node --check src/domains/router/providers/probe.js
node --check src/domains/relay/frp-install.js
node --check src/domains/router/providers/quota-strategies.js
node --check src/domains/router/handlers/forward.js
git diff -- src/domains/relay/session.js src/domains/relay/frp-install.js \
  src/domains/router/providers/quota-strategies.js src/domains/router/handlers/forward.js
```
