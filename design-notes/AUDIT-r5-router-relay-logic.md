# AUDIT r5 - router 与 relay 域业务逻辑正确性（J 组：只读报告）

轮次：第五轮（死代码清理 / 注释精简 / 注释符号清理 / 四维审计）
范围（独占）：src/domains/router/**、src/domains/relay/**，以及同链路的
  src/api/domains/router.js、src/api/domains/relay.js、src/api/router-table.js、
  src/app/domain-actions/router.js、src/app/domain-actions/lan.js、
  src/app/facade/router.js、src/app/facade/lan.js、src/app/domain-actions/main.js、
  src/platform/service/token/exchange.js（dshauth 换取侧）。
角色：J 组（对 src/ 只报告，不改行为）。本文件是本轮唯一新增/改动产物。

约束遵守：未运行任何测试或门禁（未执行 npm test / node test/*.js）；只做 node --check、grep、wc、git 只读检查。
未 commit / push；未改 package.json；未加依赖；未启动任何守卫或 daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh。

静态自检：对 src/domains/router 与 src/domains/relay 下 57 个 .js 逐个 node --check，全部通过（fail=0）。
本组不改 src，故不产生代码差异。

---

## 一、改动清单

| 文件 | 改动性质 |
| --- | --- |
| design-notes/AUDIT-r5-router-relay-logic.md | 新增（本报告） |

src/** 零改动。以下“删除候选/重复实现/注释符号”均为**报告**，交由 K 组决定与落笔。

---

## 二、删除依据（只报告，未改）

对以下符号在整仓（排除 node_modules/.git，含 test/、design-notes/、字符串形态）grep：

1. **forwardMethods（src/domains/router/forward-core.js:58,71）**
   仅余注释与 design-notes 引用；src 内唯一消费面为 index.js 的
   Object.assign(RouterService.prototype, ...)，而该行已随 RT1 删除（见
   design-notes/EXEC-router-forward-usage.md:74 “RT1 已删除 Object.assign，不再使用”；
   index.js 现直接 ctor 组装 createForwardCore）。test/ 全目录无引用。
   结论：**兼容壳已无消费者**，可删（删除后 forward-core.js 只导出
   createForwardCore/maskKey/joinUpstream）。注意：contract.js 未在 exports 列它，
   删除不影响契约门禁；但 EXECUTION-CONTRACT/design-notes 文本仍提及，需同步文档。

2. **auxMethods（src/domains/router/router-ops.js:55,73）**
   同上：index.js 已用 createAuxCore；src/test 均无消费者，仅 design-notes 引用。
   结论：**兼容壳已无消费者**，可删（保留 createAuxCore）。

3. **releaseProviderPorts（src/domains/router/ops.js:162 的工厂返回项）**
   ops.createOps 返回对象里的 releaseProviderPorts 包装未被 index.js/其它 src 消费
   （removeProvider 内部用模块级同名函数，:111）。test/ 无引用。属**未用导出**，
   可去掉工厂返回项；模块级导出（:165）保留供 ops.js 自身与潜在门禁。

4. **src/domains/router/instances/proxy-instance.js（1 行 shim）**
   内容 module.exports = require('../model')。index.js:12 仍 require 该 shim，
   因此**不是孤儿**；属过渡 shim（注释自述 final 批删除）。若 index.js 改 require
   './model' 则可删。**本组只报告**，不删。

5. 孤儿文件排查：router/** 与 relay/** 无孤儿。router/daemon.js、relay/daemon.js
   为入口（require.main 守卫）；router/contract.js、relay/contract.js 被门禁按源码读取；
   port-segments/ports-bootstrap 由 daemon 链 require。全部有引用。

### 重复实现（同一事实两份）

- **headerRetryMs / bodyResetMs 双份**：
  src/domains/router/providers/policies/quota.js:26/43 与
  src/domains/router/policies/failure.js:8/24。failure.js 注释自述“逐字对齐（纯策略不得
  反向依赖有状态 provider 文件）”，但 quota.js 本身是**纯文件**（零 require），
  因此该理由不成立。现有 test/switch-policies-test.js:79/82 用 **parity 断言**锁住两者相等，
  属“用测试维持两份实现一致”。建议 failure.js 直接 require providers/policies/quota.js
  的纯函数（仍满足 pure），消除双份；删除时需改 switch-policies-test 的 parity 断言。
  （注意：两者 ISO 解析分支有细微差异——quota.js 经 normalizeResetTs，failure.js 用 Date.parse。）

- **用量文件读盘双份**：RouterStore.readUsage（store.js:80）与 UsageLedger.load
  （store/usage.js:39）各自 JSON.parse 同一 usage-totals.json。index.js 的
  _viewDeps.loadTotals 走 store.readUsage（每次读盘），status/listProviders 的
  usage 走 ledger 缓存（load 一次后常驻）。两者可短暂分叉（ledger 缓存 vs 磁盘）。
  建议单源（视图统一走 ledger.getUsage 或统一读盘），或显式注明“读侧双入口”。

- **tokenGateDecision（core.js:75）与 hasValidToken（core.js:53）**：queryToken/Cookie
  解析各写一份（HTTP 与 WS 两条路径）。test/token-contract-gate-test.js:257 已知此形态。
  可把 hasValidToken 实现为 tokenGateDecision(...).ok，保留两个导出名。

---

## 三、注释统计与禁用符号（J 组不改 src，交给 K）

本轮未改 src 注释，故无“改前/改后”行数。对 scope 内注释的**禁用符号**做了扫描
（ripgrep 计命中行数，含代码字符串与注释；K 组清理时只应改注释，保留代码字符串/事件文案/断言）：

| 符号 | router 命中行 | relay 命中行 |
| --- | --- | --- |
| U+26A0 警示 | 14 | 12 |
| U+2605 星号 | 10 | 1 |
| U+2550 框线 | 8 | 6 |
| U+2500 框线 | 12 | 5 |
| U+2192 箭头 | 87 | 37 |
| U+00B7 中点 | 8 | 0 |
| U+00D7 乘号 | 1 | 4 |
| U+2026 省略号 | 1 | 5 |
| U+2460/2461/2462 带圈数字 | 2/2/1 | 0 |
| U+25B6 三角 | 0 | 2 |

要点：**箭头在两域注释里最多**（大量状态迁移叙述，如 COLD 到 WARM）。
另注意 keyFingerprint（providers/model.js:12）返回串里的 U+2026 是**代码字符串**，
涉及指纹格式与 test 断言，**不得**按注释清理误删。
建议 K 组按“整行注释 + 行尾注释”分别清理，避免动到模板串/事件名。

---

## 四、四维审计发现

标注：**确认** = 静态可证、有明确触发路径；**观察** = 不确定或属设计取舍，只报告。
严重度：P1（进程/端口/安全泄漏或账目错误）/ P2（自愈或状态机失效）/ P3（健壮性/一致性）。

### 架构设计

- **AA-1（观察）受管清单 main 优先级与注释不符**：
  src/domains/relay/managed.js:21-25 allManaged 返回 [...sandboxes, main]，
  而 :28 findManaged 用 find 从左到右取首个，注释却写“main 优先守卫视图”。
  若沙箱 id 与 main 的 id 冲突（当前均为独立命名），实际是沙箱先命中。
  建议改为把 main 放在数组头部，或修正注释。

- **AA-2（观察）daemon 装配顺序脆弱但已注释**：
  router/daemon.js:46-48 强制 ensurePorts 先于 RouterService 构造；relay/daemon.js:85
  configureFile 在 LanManager 构造前。属必要不变量（有真实数据丢失教训），保留。

- **AA-3（观察）domain-actions 的写权收敛**：
  app/domain-actions/lan.js 用 lifecycleManager 登记项取 LanManager，未注册即拒绝，
  方向正确；app/domain-actions/router.js:25 的 disableRouterPersist 兜底与 runtime.js:146-179
  三条 daemon 路径的集中处置形成双保险，逻辑自洽。

### 业务逻辑

- **BL-1（确认，P1）relay 优雅停机的 frpc 等待是空操作 —— 守卫修复未生效**
  文件：src/domains/relay/daemon.js:182-192 与 :200-208。
  事实：frp.stop()（relay/frp.js:190-192）在发 SIGTERM 后立即
  this.child = null；而 lan.shutdown()（relay/ops/lan-servers.js:77-79）正是调
  frp.stop()。daemon 的 waitFrpcExit() 内部再调 lan.frpChild() 读
  this.frp.child，此刻已为 null，于是立即 resolve。
  shutdown 里虽在 lan.shutdown() **之前**把 frpc 存到局部变量（:201），但 waitFrpcExit
  并不使用该变量（只用于 :205 的事后 warn）。
  后果：与 G-f 断言要防的完全一致——忽略 SIGTERM 的 frpc 会在 SIGKILL 兜底定时器
  （frp.js:195-201）被 process.exit 打断后成为孤儿，占用公网隧道端口。
  test/graceful-shutdown-test.js:87 只断言源码含 waitFrpcExit 字样，未覆盖行为。
  建议：waitFrpcExit 改为以传入的 child 句柄为准（waitFrpcExit(frpc)），或在
  lan.shutdown() 前捕获并在等待函数里使用该捕获值。

- **BL-2（确认，P2）实例健康看护的“连续 3 次 kill 重拉”分支不可达**
  文件：src/domains/router/providers/probe.js:149 与 :165-177。
  事实：healthInstance 失败时把 inst.status 置为 DEAD（:135-141）；而
  monitorLifecycle 循环首行 if (inst.status === DEAD) continue;（:149）直接跳过。
  于是 _monitorFails 只会在同一次调用里从 0 变 1，下一轮（30s）已跳过，
  永远到不了 >= 3（:171）。hang-restart 与 proxy_instance_hang_restart 事件成为死分支。
  后果：进程活着但 HTTP 卡死的实例，只能靠请求级 markInstanceProblem
  （_unhealthyCount，另一套计数）恢复，看护兜底失效。
  建议：把“进程存活/端口归属”判定与“HTTP 健康”判定解耦——DEAD 不应跳过 HTTP 探活与
  _monitorFails 累加（或另立 hang 专用标记）。

- **BL-3（确认，P1）实例子进程 close/error 回调无条件清空 inst.pid，重启时产生 PID 归属竞态**
  文件：src/domains/router/providers/probe.js:113-118。
  事实：child.on('close', () => { inst.pid = null; ... inst.status = COLD; }) 不校验
  inst.pid === child.pid（共有两个子进程闭包写同一个 inst）。
  restartInstance（proxy.js:148-174）先 force stop（置 inst.pid=null）再经
  respawn 延迟 1200ms 重拉。若旧进程在 1.2s 后才退出（SIGTERM 慢/被忽略），
  旧 child 的 close 会在新 spawn 已写入新 pid **之后**触发，把新 pid 清成 null、
  status 打回 COLD。
  后果：新进程失去登记（reconcile 认为该实例没在跑，再拉一个），同端口双实例/孤儿，
  正是“重启幸存者”类问题的另一种形态。
  建议：回调内加 if (inst.pid === child.pid) 守卫（error 同理），或引入 generation 计数。

- **BL-4（确认，P2）流式中断路径的实例熔断标记传错实参，完全 no-op**
  文件：src/domains/router/handlers/forward.js:231。
  事实：prov.markInstanceNetFail(acc) 传的是**账号**；proxy.js:177-193 的
  markInstanceProblem(instOrAcc) 先做 instOrAcc && instOrAcc.pid ? instOrAcc : null，
  账号对象没有 pid，直接 return。
  后果：上游流式中断（finishAborted，:226-234）不计入请求级熔断（_unhealthyCount）。
  同文件 :134 的 rt.prov.markInstanceNetFail(acc) 同样是 no-op（但该路径后续
  :136-142 会以 inst 再调一次，故 net-error 分支尚能计数）。
  建议：两处都改为 prov.markInstanceNetFail(parse.instOf(prov, acc))。
  注意 test/router-circuit-breaker-test.js:61 只断言字符串存在，未校验实参类型。

- **BL-5（确认，P1）反代“更新并重启”对常驻/在用实例静默空转却报成功**
  文件：src/domains/router/ops/apps-registry.js:98-114。
  事实：更新循环用 provider.stopInstance(inst)（**不带 force**）。对
  ready + 可用 + 被 selected/activeAccount 指向的账号，canStopInstance
  （providers/instance-lifecycle.js:12-19）返回 false，只置 _stopPendingUntilIdle，不 kill；
  600ms 后 startInstance(inst) 因 inst.pid 仍在而返回 {ok:true, already:true}（proxy.js:75），
  于是 job.restarted++、step 置 done，而**旧进程从未重启**（npx 缓存已删也无济于事）。
  后果：用户以为更新完成，实际常驻实例仍跑旧代码；且 pending 标记可能被后续 reconcile 清掉。
  test/round13-router-relay-gaps-test.js:128-142 的“删除路径 force”清单**未覆盖本文件**
  （它被列为删除路径组，但正则只查了 removed/keys 三类形态，未查更新路径）。
  建议：更新路径同样 stopInstance(inst, true)（更新=必须换代）。

- **BL-6（确认，P2）停用供应商的非 force 停实例可能留下无回收路径的进程**
  文件：src/domains/router/endpoint.js:109。
  事实：deactivateProvider 对 proxy 实例调 p.stopInstance(i)（不带 force）。
  被 selected/active 且可用的常驻实例同样只置 _stopPendingUntilIdle。而停用后：
  reconcileInstances/monitorLifecycle 都以 p.activated !== true 提前返回
  （scheduler.js:97、probe.js:146），独立端点已关闭，请求结束补刀 retryPendingStop
  也不会再触发。只能等再次 activate 才有机会回收。
  建议：停用路径用 force（与删除路径 P1 修复同规）。

- **BL-7（确认，P2）Command 月窗口推导把“credits 字段缺席”当成余额 0，误判 100% 用尽**
  文件：src/domains/router/providers/quota-strategies.js:90-98 与 :125-131。
  事实：monthlyRemaining 由 [cr.monthlyCredits, cr.purchasedCredits, cr.freeCredits]
  .reduce(..., 0) 得出，**恒为数字**（缺字段时=0）。而 derivedMonthly 的条件
  只用 Number.isFinite(Number(monthlyRemaining)) && monthlyRemaining >= 0（恒真），
  **没有** hasCredits 守卫。生产 proxy-apps.js:43 配了 monthlyCapUsd: 10，
  因此当 /alpha/billing/credits 返回 windowLimits 而无 credits（或 credits:{}）时：
  used = min(10, max(0, 10 - 0)) = 10，percent=100、status=rate-limited。
  后果：月窗口假 100% 使 windowExhausted 为真，账号被冻结为 window、overall 显示“用尽”，
  实际额度未知。test/commandcode-quota-test.js mock 3（credits 缺席）与 mock 2（credits:{}）
  **恰好命中**，但只断言了 monthlyRemaining===null（CC7）与 rolling（CC5），未断言 monthly。
  建议：derivedMonthly 条件加 hasCredits &&，或在缺 credits 时直接回退 mapW(wm.monthly)。

- **BL-8（确认，P2）客户端提前断开时上游响应无人消费，socket/agent 泄漏**
  文件：src/domains/router/handlers/forward.js:83-84、:149、:286-288。
  事实：forwardOnce 在 clientRes 'close' 时 settle({phase:'client-abort'})，
  但**不 destroy 上游 req**；proxyFor 收到 client-abort 后只 endInflight 并 return（:149）。
  若上游随后才回 200，回调 (ur)=>{...settle(...)} 因已 settled 成为 no-op，
  ur 从不 resume()/destroy()，keep-alive agent（maxSockets=128）里的该 socket 长期占用。
  建议：client-abort 分支 req.destroy()（或给回调加 settled 检查并 ur.resume() 丢弃）。

- **BL-9（确认，P3）非流式响应体一旦收到响应头就再无超时约束**
  文件：src/domains/router/handlers/forward.js:258-265、:283。
  事实：responseGuard（180s）在 settle({phase:'ok'})（响应头到达）时被 clear；
  随后 writeThrough 对 body 的读取没有任何时限（ur 只靠 end/error/close）。
  注释说“长流不限”，但该路径同样覆盖**非流式**大响应；上游发完头后挂起即可让请求永久悬挂。
  建议：非流式（!meta.streamRequested）加 body 总时长上限，或对 ur 设 setTimeout。

- **BL-10（观察，P3）scheduler 两处**：
  (a) scheduler.js:65 启动 10s 兜底探测的 setTimeout 句柄未保存，stop()（:70-74）无法清除；
      停服后该回调仍会跑一次 probeIfDue（受 state.stopped 闸保护，故无害但不干净）。
  (b) scheduler.js:166-169 refreshReadyAccounts（10min）与 probeAccountStates（5min）
      使用**两个独立**的 running 闸，可能对同一实例并发 detectInstanceQuota，产生重复上游探测。
  (c) probeIfDue 第 172 行 due || (时间条件 && overdue) 的优先级符合注释意图，非缺陷。

- **BL-11（观察，P3）OAuth 重新发起时对上一 Promise reject 可能 unhandledRejection**
  文件：src/domains/router/ops/oauth.js:27-30。commandcodeLoginStart 再次调用会对
  上一轮 _ccLoginPromise 调 reject，但该 Promise 通常尚未被 commandcodeLoginWait
  挂上 handler（daemon 有 unhandledRejection 日志，不崩溃，但会污染错误面）。
  建议：reject 前 .catch(()=>{}) 自吞，或把决议期收敛为“仅一处在等”。

- **BL-12（观察，P3）credits 冻结维持分支不补 nextResetAt，极端数据下 5min 探测风暴**
  文件：src/domains/router/providers/policies/freeze.js:170-183。
  该分支保持 frozen 但不写 acc.nextResetAt（只在有 monthlyAt 时写 recovery.at）。
  若持久化数据为 frozen+credits 且 nextResetAt 为空、quota.monthlyResetAt 有值，
  则 scheduler.js:18/31 的 frozen && !nextResetAt 判定恒真，probeAccountStates
  每 5min 触发。首次 freeze 会写 nextResetAt（freezeLimited:73-74），故仅历史/异写数据命中。
  建议：该分支同步 acc.nextResetAt = at || now+CREDITS_RECHECK_MS。

- **BL-13（观察，P3）会话换取的并发竞态**
  文件：src/domains/relay/session.js:61-73 与 :76-90。
  refreshDshSession 会把 bootstrapping 置 null 并另起一次换取；旧的在途 Promise
  迟到时仍会写 dshCookie（无 token 身份校验），可能以旧令牌的 cookie 覆盖新值。
  建议：给每次换取带 generation/token 标识，回调仅在仍为当前代时落 cookie。

- **BL-14（观察，P3）实例探活/端口监听的登记竞态**
  endpoint.js:56-67 startProviderServer 仅在 listen 回调里写入
  state.providerServers[id]，函数首行的“已存在则 return”在 listen 完成前不生效；
  若同 id 在回调前被再次调用（并发 activate / deactivate 穿插），会二次 listen 或漏 close。
  deactivateProvider 在 listen 未完成时 stopProviderServer 也读不到句柄。
  建议：listen 前先在 map 里占位（或加 starting 标记）。

### 规范标准

- **NS-1** 本 scope 注释含大量禁用符号（见第三节），K 组清理范围明确。
- **NS-2（观察）视图函数有写副作用**：views.listProviders:83 调 p._ensureLimit(a)，
  后者（freeze.js:40-53）在缺 limit 时**写** acc.limit。只读视图内发生状态写入，
  与“Q13 状态投影（只读）”的自述不符（虽幂等、无害）。
- **NS-3（观察）hex/时序**：provider 指纹 keyFingerprint 用 U+2026 拼接（代码字符串），
  属对外可读格式，保留；不要随注释清理误改。
- **NS-4（观察）单源安全闸已落地**：app/domain-actions/main.js 与 relay/ops.setFrp 共用
  core.validateFrpExposure（round13 测试已锁），方向正确。但 peers 端口占用校验用
  x.frpRemotePort === port 严格相等（core.js:171）；若某些来源把 frpRemotePort 存成
  字符串，校验会漏判，两实例同公网端口。建议比较前统一 Number()。

### 功能设计

- **FD-1（确认，P2）反代更新 job 的步骤索引与实例集是创建时快照**：
  apps-registry.js:65-70 建 steps 与 insts；异步执行期间若实例增删，
  setStep(i,...) 与 insts[i] 仍按旧下标，可能把状态写到已变化的对象上。
  建议执行时按 keyId 重新定位（或执行前重取实例集）。
- **FD-2（观察）frp 校验和“取不到即永久放行”**：
  frp-install.js:79/86 把失败结果 null 写入 cache[asset]，而 cache 由
  FrpManager 的 _sumCache（frp.js:233）在**整个管理器生命周期**持有。
  首次（离线/官方不可达）取不到后，后续每次 install 都复用 null，永久跳过 sha256。
  注释的“有界失败即放行”意图是单次，但实现是进程级。建议只缓存成功值，或带 TTL。
- **FD-3（观察）frp 启用但 serverAddr 为空**：buildFrpcToml 会写出
  serverAddr = ""，syncFromInstances 仍会 start frpc（loginFailExit=false），无限重连、
  日志噪声。建议 settings 归一时校验 serverAddr 非空，否则拒绝启用。
- **FD-4（观察）extractUsage 的大括号匹配不理解字符串**：
  parse.js:29-30 对 usage 对象做朴素 depth 计数；使用 tail 采样（:235 截到最后 64KB）
  也意味着超大非流式响应的 usage 可能落在被截断部分。属可接受的启发式，报告备案。
- **FD-5（观察）dshauth 换取**：src/platform/service/token/exchange.js:28-63 只接受
  dsh-auth-* cookie、3s 超时、失败 finish(null)，逻辑正确；token 经 query 只发往
  回环 127.0.0.1:<dshPort>，不外泄。未发现逻辑缺陷。

---

## 五、修复建议摘要（给 K 组，按严重度）

P1：
1. relay/daemon.js waitFrpcExit 使用捕获的 child（BL-1）。
2. probe.js close/error 回调加 inst.pid === child.pid 守卫（BL-3）。
3. apps-registry.js applyProxyUpdate 改 stopInstance(inst, true)（BL-5）。

P2：
4. probe.js 解除 DEAD 跳过，恢复 hang 看护（BL-2）。
5. forward.js:231/:134 传 instOf(prov, acc)（BL-4）。
6. endpoint.js deactivateProvider 改 force（BL-6）。
7. quota-strategies.js derivedMonthly 加 hasCredits 守卫（BL-7）。
8. forward.js client-abort 时 destroy 上游 req（BL-8）。

P3 及文档：
9. 非流式 body 超时、session 换代标识、frp 校验和缓存策略、视图只读化、
   forwardMethods/auxMethods 兼容壳删除、headerRetryMs/bodyResetMs 双份收敛、
   注释禁符清理（见第三节）。

---

## 六、未执行项 / 交由主代理

- 本机未运行任何测试与门禁，验收由 CI 裁决。
- 全部 BL/FD 均为**只读推理**结论；涉及运行时竞态的 BL-3/BL-8/BL-13 建议在 CI 与多平台
  复现验证后再定性。
- J 组未改 src；上述修复需 K 组落笔，且改动后必须相应更新
  test/graceful-shutdown-test.js、test/router-circuit-breaker-test.js、
  test/round13-router-relay-gaps-test.js、test/commandcode-quota-test.js 的断言口径
  （尤其把“源码形态断言”升级为行为断言，或显式覆盖新分支），否则同类缺陷会再次漏过。
