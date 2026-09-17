# AUDIT r5 - app 编排与 api 边界业务逻辑正确性

轮次：第五轮（重发）。分组：J 组（对 src/ 只报告，不改 src/；本文件为文档改动）。
范围（独占只读）：src/app/**、src/api/**。
题目：app 编排与 api 边界业务逻辑正确性（会话与生命周期、受管注册与心跳、聚合投影、daemon 启停与端口再推导、安全边界 Origin/Host/CSP/身份、API 契约）。

约束遵守（已核对）：
- 未运行任何测试或门禁（未执行 npm test / node test/*.js / bash 门禁脚本）。
- 只做只读静态检查：read / grep / glob / node --check（未对本次范围做 node --check 之外的执行）/ wc / git status。
- 未 commit / push；未改 package.json；未加依赖；未启动任何守卫或 daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh。
- 未修改任何 src/ 文件；本轮唯一写入是本报告（design-notes/）。

重要说明（行号）：审计进行期间，并行 K 组对 src/app、src/api 的部分文件做了注释精简（git status 显示 app/api 多文件 M）。
本报告行号以审计当时快照为准；内容判据不受注释精简影响。已复核的关键定位在工作区的当前值：
- 4.2#1 frp 两类绕过：src/app/domain-actions/main.js:20（赋值）与 :32（安全闸）；token 变更路径同前。
- 4.2b D1 非布尔开启：同上 :20/:32。
- 4.2b D2 api-rebind 未定义 ports：src/app/assembly/api-rebind.js:3（portsShared）、:41、:77（错误的 ports.register）、:72（正确的 release）。
- 4.2#8 upgradeHold 恢复：src/app/state/store.js:61-62；src/app/state/upgrade-hold.js:72（只导出 enter/enterAsync/exit）。
- 4.2b D3 controller 忽略 applyPort：src/app/main/controller.js:55/:57；port-rederive.js:55（register 失败告警后 return false）。
- 4.2b D4/D5 native 并发：src/app/native/ops.js:77、:104、:163、:178。
- 4.2#12 projection BACKOFF：src/app/control/projection.js:44。
- 4.2#10 关停沙箱：src/app/session/shutdown.js:120-126（该文件未在并行改动列表中）。
- 4.2b D12 停止落空：src/app/main/process.js:241/:244。
- 4.2b D11 假死重启：src/app/main/health-gate.js:40。
其余行号若与当前工作区不符，以"文件+代码内容"定位即可。

## 零、结论摘要（按严重度）

已确认项（详见 4.2 / 4.2b；均静态推理，未运行测试）：

1. frp 公网暴露安全闸存在两类绕过：先合法开启后再清空 remoteToken / 改端口（4.2#1），以及非布尔 frpEnabled（4.2b D1）。
   可致公网流量零认证触达 DSH 特权 API。
2. src/app/assembly/api-rebind.js 的 ports 未定义（4.2b D2）：端口偏斜时 supervisor-api 登记消失，
   违反 KERNEL-DAEMON-CONTRACT D3 的壳就绪判据。
3. bootstrap 在 router daemon 路径提前 return，整体跳过更新检查定时器与壳看护（4.2#2）。
4. native 并发互斥缺口：uninstall 的锁在 await 之后才置位（4.2b D4）、startInstall 缺升级互斥闸（4.2b D5）。
5. 升级 hold 跨守卫重启恢复调用了不存在的方法、异常被吞（4.2#8），hold 丢失可能拉起半替换的二进制。
6. controller 忽略 applyPort 返回值并强制改 config.targetPort（4.2b D3），且端口再推导后同拍未重探（4.2#5）。
7. 心跳并发：stall 兜底 + finally 无归属判断可致两拍重叠（4.2b D7 / 4.2#11）；心跳遍历中注销会跳过下一对象（4.2#3）。
8. 受管目录单条损坏即静默截断整份加载（4.2#9）；关停沙箱不校验 stopUnit 结果而谎报 STOPPED（4.2#10）。
9. 安全边界：开启面板局域网访问不要求访问密钥（4.2#6）。

## 一、改动清单

无 src/ 改动。本组按契约对 src/ 只报告；以下第二节列出可删除/可精简的候选，供 K 组或主代理裁定后执行。
本报告为唯一新增文件：design-notes/AUDIT-r5-app-orchestration-api-boundary.md。

## 二、死代码 / 不可达分支候选（仅报告，未删除）

删除前均已全仓（含 test/、字符串形态）grep 确认引用面。

1. 不可达重复分支：src/app/control/manager.js:79-91
   LifecycleManager.restart() 先判 `if (typeof lc.restart === 'function')`（:79）并委托 lc.restart()。
   但 lc 在 register() 处被强制要求为 ManagedLifecycle 实例（manager.js:28），而 ManagedLifecycle.prototype.restart
   恒存在（entry.js:218）。故 :83-90 的 wasRunning/stop-start 回退实现**永不可达**（已被 entry.js 内部同逻辑覆盖）。
   证据：grep "typeof lc.restart" 全仓仅 manager.js:79 一处；ManagedLifecycle 的 restart 为原型方法。
   处置建议：删除 :83-90 死分支，只保留委托（行为等价）。

2. 注释声称但代码没有：src/app/main/controller.js:56-62
   注释写"更正后本 tick 重探一次，让状态机立即看到新端口在线"，但代码只执行
   `this.main.applyPort(found.port, found.pid)` 与冗余的 `this.config.targetPort = found.port`
   （applyMainPort 内部已写 targetPort，见 port-rederive.js:72）。probeRes/portUp 在 :30-36 已算出且未重算，
   局部变量 host/port（:45-46）仍是旧值。属"注释声称、代码没有"的失效模式，注释应删或改为如实描述。

3. 死分支/冗余：node --check 无法覆盖，未发现其它确定孤儿文件。
   src/app 与 src/api 下未见无引用文件（api/identity.js 是契约声明的兼容 shim，其头注写明了移除条件：需 api/index.js
   与 api/security.js 改为直接引用真实归属路径，且两个测试改 require；当前两者仍经它取用，故保留）。

## 三、注释符号清理统计（仅报告，未改动 src/）

对 src/app + src/api 全量 grep（PCRE），禁用字符出现次数如下（含少量代码字符串/错误文案，未逐条区分）：

| 字符 | 次数 |
| --- | --- |
| 制表框线 U+2550（双线） | 6612 |
| 箭头 U+2192 | 334 |
| 制表框线 U+2500（单线） | 298 |
| 章节号 U+00A7 | 108 |
| 警示 U+26A0 | 86 |
| 中点 U+00B7 | 65 |
| 省略号 U+2026 | 23 |
| 带圈数字 U+2461 | 14 |
| 带圈数字 U+2460 | 12 |
| 带圈数字 U+2463 | 7 |
| 双向箭头 U+2194 | 5 |
| 乘号 U+00D7 | 5 |
| 带圈数字 U+2462 | 4 |
| 双箭头 U+21D2 | 4 |
| 左箭头 U+2190 | 3 |
| 星 U+2605 | 2 |
| emoji U+1F31F | 1 |
| 重叉 U+2718 | 1 |
| 重勾 U+2714 | 1 |
| 合计 | 约 7586 |

注：U+00D7 多为错误文案字符串（如"不支持的平台组合 ×"），按"代码字符串按需保留"原则应保留；大部分其余字符位于注释，属本轮清理目标。本组不执行。

## 四、四维审计发现

### 4.1 架构设计

- 组装顺序与依赖方向基本自洽：assembly 是唯一 DI 点（compose.js:20-26），installFacets 先装切面并 installCollaborators
  （facets.js:104-122），再 composeCore/Domains/Observers。app 不 require api，createServer 经 root 注入（supervisor.js:26,32）。
- 观察（未改）：生命周期存在两套平面。LifecycleManager 注册 B 平面 id（'router'/'lan'/'dsh'/'instances'/'plugins'，adapters.js），
  受管目录 ManagedRegistry 用 A 平面 kind/id（'router-daemon'/'lan-daemon'/'dsh:main'/'sandbox-instance'，specs.js），
  两者经 _daemonSuperviseOnce('router'|'lan') 与 registerAdapter(kind) 手工映射（compose/domains.js:73-82）。
  映射是显式的，但目前无装配期校验保证两平面不漂移；属可维护性风险，非错误。

### 4.2 业务逻辑（含竞态 / 泄漏 / 未回滚）

已确认错误（高置信）：

1. 【高危 · 安全 · 失败未回滚】frp 公网暴露安全闸可被"先开后改"绕过。
   src/app/domain-actions/main.js:41-52：安全闸仅在本次 patch 含 `p.frpEnabled === true` 时执行。
   若 main 已处于 frpEnabled=true（先前合法开启），再 POST /native/settings（api/domains/native.js:58-71 原样透传 body）
   提交 `{ "remoteToken": "" }`：p.frpEnabled 为 undefined → 跳过 validateFrpExposure → meta.remoteToken 被清空并落盘，
   而 meta.frpEnabled 仍为 true。同路径提交 `{ "frpRemotePort": <任意> }` 也会跳过端口合法性/占用校验并直接写盘。
   后果：relay 侧 tokenGateDecision 对空 token 恒放行（domains/relay/core.js:72-73），frpc 以回环身份连 relay
   （来源闸放行）→ 公网流量零认证触达 DSH 特权 API。这正是该闸注释声称要防的场景。
   证据：validateFrpExposure 对空 token 返回 ok:false（relay/core.js:163-165）；patchDshMain 的调用条件。
   修法建议：按"生效后状态"判定（`p.frpEnabled === true || meta.frpEnabled === true`）并重跑校验；
   remoteToken/frpRemotePort 任一变更且生效 enabled 都要校验；校验必须先于 writeMainMeta。

2. 【高 · 编排 · 定时器整体缺失】bootstrap 在 router daemon 路径提前 return，跳过更新检查与壳看护。
   src/app/assembly/bootstrap.js:112-145：当 config.routerAutostart===true 且 _ensureRouterRuntime 返回 daemon 模式时，
   :135 直接 `return;`。该 return 退出的是整个 _bootstrap，而非仅"内嵌 router 启动"分支。
   于是其后的两段被整体跳过：
   - 更新检查定时器（:146-153，设置 host._initialCheckTimer / host._upgradeTimer）；
   - 壳看护启动（:160-166，host._startShellWatchdog()）。
   证据：grep 显示 _upgradeTimer 仅在 bootstrap.js:150 赋值、_startShellWatchdog 仅在此处调用（:161）。
   触发条件即生产常见组合（用户开启智能路由自启 + 独立 daemon 可用）。属明确逻辑错误。

3. 【中 · 竞态 · 心跳遍历被并发删除破坏】心跳遍历数组时同拍注销会跳过一个条目。
   src/app/control/heartbeat.js:52 `for (const e of registry._objects)`；在单拍内，instance-adapter.js:44
   经 control.unregister → specs.js:78 → registry.unregister → _drop（registry.js:135-139）执行
   `this._objects.splice(i, 1)`。for...of 对数组按下标迭代，删除当前元素会让其后一个元素前移并被跳过：
   该拍漏监督一个沙箱实例（若连续注销则成片跳过）。upsert→register 的 _index 追加发生在尾部，
   for...of 还会在后续迭代访问新元素，进一步扩大非确定性。
   修法建议：遍历快照 `for (const e of registry._objects.slice())`。

4. 【中 · 逻辑不一致 · 失败语义分叉】ManagedLifecycle.start 两种失败路径对 desired 处理不一致。
   src/app/control/entry.js:137-163：显式 `{ok:false}` 分支在 :148 置 `this.desired='stopped'`；
   而 catch（异常）分支 :157-162 不置 desired。LifecycleManager.start 已先 wantRunning()（manager.js:54），
   故"启动被拒"会静默撤销用户意图，"启动抛异常"却保留意图（后续心跳继续重试）。两条路径语义应对齐（建议保留意图，
   或两处都明确记录策略）。

5. 【中 · 端口再推导 · 陈旧读】端口再推导后同拍未重探，局部变量仍旧。
   src/app/main/controller.js:54-64：发现新端口并 applyPort 后，probeRes/portUp 未重算；:45-46 捕获的 host/port
   仍为旧端口，后续 :136/:189/:201 的 monitor.isPortListening(host, port) 判定用的是旧端口。
   后果：用户改端口后，状态机要等到下一拍（默认 5s）才看到新端口；注释却声称本拍已重探（见第二节第 2 条）。

6. 【中 · 安全 · 未鉴权暴露】开启面板局域网访问不要求访问密钥。
   src/app/settings/lan-panel.js:39-56：setLanPanel(true) 直接把 apiHost 改为 0.0.0.0 并重绑，
   不检查 config.apiAccessKey 是否已配置。网关的访问密钥门卫仅在 key 存在时生效（api/transport/server.js:94-98），
   故未配置 key 时，局域网内任意设备可无认证调用全部写端点（settings/access-key、native/upgrade、shell/restart 等）。
   建议：开启前要求/提示设置密钥，或在响应中显式告警。

7. 【中 · 安全 · 绕过 CSRF 信任集】Origin 与 Host 信任集不含 IPv6 私网。
   src/api/security.js:77-86 isLocalOrLanHost 只接受回环字面量与 RFC1918 IPv4；fc00::/7、fe80::/10 的
   Host/Origin 会被拒。方向安全（拒绝而非放行），但纯 IPv6 局域网下所有写操作 403，与注释声称的"局域网可信"不符。
   属功能缺口，低风险。

8. 【高 · 状态恢复 API 错配 · 异常被吞】升级 hold 跨守卫重启恢复整段失效。
   src/app/state/store.js:64-67 在 raw.upgradeHold===true 时调用 upgradeHold.set(true) / upgradeHold.since() /
   upgradeHold.setSince(...)。但这里注入的 upgradeHold 是 createUpgradeHold() 的返回值
   （state/collaborator.js:31-36 传入），而 src/app/state/upgrade-hold.js:77 只返回 { enter, enterAsync, exit }
   —— 根本没有 set/since/setSince。故 :65 必抛 TypeError，被 :68 的 catch{} 静默吞掉。
   触发：升级「先停后装」期间守卫退出/崩溃 → statusSummary（facade/status.js:48）把 upgradeHold:true 写进 state.json
   → 下次 boot loadState 进入该分支。
   后果：host._upgradeHold 不会被恢复为 true，升级 hold 在守卫重启后丢失，可能在二进制替换过程中被自动拉起 DSH；
   头注"升级 hold 跨守卫重启保持"为假。修法：让 createUpgradeHold 暴露 set/since/setSince（或让 store 经 enter/exit 恢复）。

9. 【中高 · 损坏目录被静默截断】_load 单条坏 entry 会中断整份目录加载。
   src/app/control/registry.js:63-86：循环内只对"未知 kind"continue（:68）；:71 的 createEntry 在条目缺 id 时抛错
   （managed-object.js:64），循环体无 per-entry try，抛到 :85 的 catch 后循环中止，其后全部合法条目丢失。
   注：_loaded（:50/:84）只写不读，是死字段，故截断不影响 store 的回灌判据（_loadedFromDisk 在构造期已定）。
   后果：受管目录静默不完整，后续沙箱/daemon 消失。修法：per-entry try/catch + warn，坏条跳过不阻断。

10. 【中 · 关停未校验结果 · 状态谎报】_stopAllSandboxes 无论 stopUnit 成败都把实例持久化为 STOPPED。
   src/app/session/shutdown.js:120-126：platform.service.current().stopUnit(...) 的返回值被丢弃；Linux 实现失败时
   返回 false 不抛（platform/os/service.js:53-57），非 Linux 实现直接抛 CapabilityError（service.js:103）。
   两条路径都会继续执行 :124（inst.state.phase='STOPPED'）与 :126（instances.save()）。
   后果：单元实际仍在跑，实例状态却落盘为 STOPPED（ghost），下次按错误相位决策。修法：仅 ok===true 才置位。

11. 【中 · 心跳重叠 · 互斥契约失效】单对象超时预算之和可超过外层整拍 stall 兜底。
   src/app/control/heartbeat.js:18,77：每对象 withTimeout 上限 = iv*6，循环串行；
   src/app/assembly/bootstrap.js:78-91 的 _heartbeatBusy 兜底释放阈值 = max(30000, iv*12)。
   iv=5000 时每对象 30s、兜底 60s：同拍 >=2 个 adapter 卡死即超过 60s，兜底把 _heartbeatBusy 置 false，
   而第一拍仍在 await，下一个 setInterval 启动第二拍 → 两拍并发监督/收敛（bootstrap.js:59 声称这正是要防的）。
   修法：兜底阈值应大于"最坏单拍上界"（对象数 x 6 x iv），或用一次性 run-once 调度替代 setInterval。

12. 【中 · 视图残留 · 谎报健康】syncDshView 的 BACKOFF 分支漏写 healthy。
   src/app/control/projection.js:47-49：同链其它分支（RUNNING/STARTING/RESTARTING/else/未 desired）都显式写 dsh.healthy，
   唯 BACKOFF 不写。从 RUNNING 掉入 BACKOFF 时 healthy 残留 true → 快照出现 starting + healthy:true。
   修法：BACKOFF 分支显式 dsh.healthy=false。

13. 【中 · desired 未落 · 视图翻转】ManagedLifecycle.stop 对 phase==='stopped' 直接短路。
   src/app/control/entry.js:173 在 this.desired='stopped'（:191）之前 return {ok:true, already:true}；
   LifecycleManager.stop 只置 _monitoring=false（manager.js:66）。projection.js:75 的 wantRunning 仍取
   lc.desired==='running' || lc._monitoring，故对 phase=stopped 但 desired=running 的模块（如 router）调用 stop 后，
   用户意图未落 desired，syncRouterView 可能把相位翻成 starting。

14. 【中低 · 契约陷阱】ManagedRegistry.update 的部分 ownership 补丁会静默清空未提供字段。
   src/app/control/registry.js:184-189 用 normalizeOwnership(p.ownership) 整体替换；normalizeOwnership
   （managed-object.js:101-113）对缺省 rootPath/unit/daemonScript/processMode 一律 null。
   只传 {ports:[...]} 会把其余所有权字段抹成 null 并 _save 持久化。当前仓库调用点均传完整 ownership，未触发。

观察（未改，需主代理裁定）：

- src/app/state/upgrade-hold.js:47-53 enterAsync 的兜底 setTimeout 未 clearTimeout 也未 unref（最多 15s 句柄）。
- src/app/control/registry.js:117-124 persistCrashState 的 50ms 防抖定时器（unref）在 shutdown.js:26-32 未被清理/冲刷，
  退出前 50ms 内的崩溃字段变更可能丢失。
- src/app/state/store.js:57-60 崩溃字段（restartCount/backoffLevel/crashWindow*）从 state.json 回灌时没有
  _loadedFromDisk 守卫，与 registry.js:76 "B2 归一：不再双副本" 的声明不一致（可能用旧值覆盖较新计数）。
- src/app/control/registry.js:50,84 的 _loaded 只写不读，属死字段。
- src/app/state/desired.js:28 setDesired 非法值返回 { error } 缺 ok:false，与同模块 {ok:true,...} 形状不一致。
- 其余低置信项：register 不校验 desired / update 校验（registry.js:156-174）；_syncPortsOwner 仅在端口未登记时
  allocateMark（:234）；session/machine.js:22-28 不校验迁移、:35 未做 typeof 守卫；writeState 早退不恢复 snap.updatedAt（store.js:31-36）。

- src/api/domains/lifecycle.js:38-41：`/lifecycle` 与 `/lifecycle/status` 无方法判断，POST/PUT/DELETE 也返回 200；
  contract.js:40-41 声明 methods 仅 GET。属契约与实现的轻微不一致（读接口，无副作用）。
- src/app/control/manager.js:104-113 stopAll：先置 lc._monitoring=false 再 await lc.stop()；stop 失败被 catch 吞掉后，
  该对象仍在运行却不再纳管/重试，可能成为孤儿直到显式操作。
- src/api/domains/instances.js:22 OPEN_WEB_CODES：仅在 consume 时删除，30s 过期项无清扫；反复 /instances/open-web
  可无界增长该 Map（同时触发打开浏览器）。:89 的 dropOpenWebCode 在 consume 已删后为 no-op。
- src/app/daemons/process.js:145-149 ensureRunning 仅按 `_pidAlive(expectedPid())` 判"接管"，不校验 cmdline/ctl 属主
  （classify() 才校验）。若身份文件里的 pid 被系统复用给无关进程，守卫会误判 daemon 在线而不再拉起，
  stop 时也可能对该 pid 发信号。:162-165 _stopPid 的 SIGKILL 定时器不跟踪，存在同样 PID 复用窗口。中低。
- src/api/domains/instances.js:162-171：remove/update/stop 一律 send(200)，而 add/start 已按 r.ok 映射 400；
  同一域内破坏性操作的 HTTP 状态语义不一致（stopInstance 可能返回 {ok:false} 却被报成功）。
- src/app/native/upgrade.js:214-235 handleUpgradeFailure：rollbackAfterFailure 返回 {ok:false} 时提前 return，
  不清 host._activeTaskId（该路径已由 rollbackAfterFailure 记 fail+resume）。资源/簿记残留，低。
- src/app/daemons/supervise.js:75-78、src/app/assembly/bootstrap.js:127-130 未跟踪的 setTimeout（3000ms）
  在守卫关停时不会被清理，回调仍会触碰宿主状态（幂等、无害，但属未受控定时器）。
- src/api/security.js 与 src/api/transport/server.js 各自实现"壳来源"：security.isShellOrigin 只认 tauri: 协议；
  server.js:59-69 还认 http(s)://*.tauri.localhost 并对其回 CORS。两者信任集不一致（后者更宽），
  且 CORS 白名单宽于 originAllowed 的信任集。当前无实际越权（被 originAllowed 拒），但属"同一事实两份实现"。

### 4.2b 深度扫描补充（子代理复核，去重后）

已复核（本组另行 read / grep 确认，非仅转述）：

D1. 【高危 · 安全】frp 安全闸被"非布尔 frpEnabled"绕过。
   src/app/domain-actions/main.js:26 赋值用 `meta.frpEnabled = !!p.frpEnabled`，:41 安全闸却用 `p.frpEnabled === true`。
   POST /native/settings {"frpEnabled":1}（或 "true"/{}）→ 落盘 frpEnabled=true 但整段 validateFrpExposure 跳过。
   与 4.2#1 同源同函数的两类绕过（先开后改 token / 非布尔开启）。修法：先布尔归一，再按归一后的值判闸。

D2. 【高危 · API 契约 · 静默失败】api-rebind 引用未定义标识符 ports。
   src/app/assembly/api-rebind.js:43 与 :82 调用 `ports.register('supervisor-api', ...)`，但文件内没有 ports 绑定
   （:3 只有 portsShared；:77 正确用 portsShared.release）。两处 ReferenceError 被 try/catch 吞成 warn/静默。
   触发：startApi 因 EADDRINUSE 做端口偏斜（:61-84）时先 release 旧登记（成功）再 register 新端口（抛错）
   → supervisor-api 从 ports.json 整体消失；KERNEL-DAEMON-CONTRACT D3 的壳就绪判据取该登记 → 壳永远等不到就绪。
   修法：两处改为 portsShared.register。

D3. 【高 · 失败未回滚 · 端口/配置分叉】controller 忽略 applyPort 返回值并强制改 config。
   src/app/main/controller.js:57-62：`const found = this.main.findManagedPort(); ... this.main.applyPort(...); this.config.targetPort = found.port;`
   的赋值无条件执行。applyMainPort 在 ports.register 失败时 return false 且不改 config（port-rederive.js:60-65），
   而 pool.register 对固定角色冲突确实抛错（ports/pool.js:82）。失败时注册表/healthUrl 仍旧、config 已改 → 分叉，
   与 applyMainPort 头注声称要防的失效模式相反。对照 process.js:188 调用点检查了返回值。

D4. 【高 · 竞态 TOCTOU · 并发卸载/装卸交叉】uninstall 的互斥锁在 await 之后才置位。
   src/app/native/ops.js:154-178：互斥检查在 :155-158，`host.uninstalling = true` 在 :178，中间隔着
   :163 `await host.hooks.stopForUpgrade()`（upgrade-hold.js:42 确为 async）。两个 POST /native/uninstall 可同时
   通过检查并各自 npm uninstall + 递归删除同一路径；同窗口 POST /native/install 也可进入。
   同文件 :76 注释明确要求"并发锁必须在任何 await 之前置位"，uninstall 自我违背。

D5. 【高 · 互斥缺口】/native/install 缺升级互斥闸。
   src/app/native/ops.js:115-135 startInstall 只查 installing/uninstalling/isValidVersion/checkEnvironment，
   无 policies.busy()、无 tasks.isBusy()；而 src/api/domains/native.js:30 的唯一生产入口就是 startInstall。
   NativeManager.install()/installer.js:98 的 busy 校验是死路径；uninstall（ops.js:141）有 busy 检查，install 没有。
   后果：升级中 POST /native/install 并发 npm 写同一 node_modules，并使进行中的升级版本校验失败触发回滚。

已由子代理静态确认、本组未逐字节复跑（标注为报告项）：

D6. 【中 · 状态单源 · 认领被清空】src/app/native/ops.js:104 非首装显式传 []：
   `host._recordManifest(target, isFirstInstall ? host._claimDataPaths() : [])`。manifest.record（manifest.js:32-36）
   对 Array.isArray([]) 为真 → claim=[] → 落盘 dataPaths:[]，清空既有认领；而契约本意是"未显式传(undefined)才继承"。
   后果：卸载不再清理已认领的 ~/.dsh 数据路径。升级路径传 undefined，故表现不对称。
D7. 【中高 · 心跳重叠（精确根因）】bootstrap.js:79-91：stall 兜底 :79 把 _heartbeatBusy 置 false 后，
   新一拍 hb2 启动置 true；hb1 的 promise 迟到时其 .finally（:91）无条件再置 false，清掉 hb2 的标记 → hb3 与 hb2 并发。
   与 4.2#11 同源：根因是 finally 无代际/归属判断；抬高 stall 阈值只降概率不根治。修法：用自增 beat id 或 token，
   仅当仍属本拍时才复位。
D8. 【中 · 假成功】src/app/settings/lan-panel.js:44-56 绕过 state.persistConfigPatch 直读改写 config.json，
   写失败仅 logger.error 后仍返回 ok:true；src/app/settings/access.js:23-25 经 persistConfigPatch
   （desired.js:76-79 内部吞异常）持久化失败也返回 ok:true（安全相关：密钥/开关重启后失效，用户以为已生效）。
D9. 【中 · 失败未清理】src/app/native/ops.js:72-112 install() 无 try/finally 释放 host.installing
   （uninstall :180-236 有）。_runInstall reject 或 _recordManifest 抛错时 installing 永久 true；
   API 路径由 startInstall 的 .catch（:121-133）兜底，NativeManager.install() 直接调用者无兜底。
D10.【中 · daemon 异主判定不一致】src/app/daemons/runtime.js:146-155 与 bootstrap.js:120 走 _ensureRouterRuntime 的
   "daemonActive && managed" 直判：daemonActive 只看 ctl cmdline（probe.js），managed 只看 lock 文件存在
   （identity.js:25-27）；而 process.js:210 注释声称 classify() 是识别异主的唯一判据，ensure/拉起路径却不使用它。
   lock 残留 + 外部同名 daemon 监听同端口 → 被当自管并 disableRouterPersist。同类：runtime.js:113-114/159-160 停止时
   直接 kill ctl 监听者，无 cmdline/身份二次校验；process.js:145-149 ensureRunning 对 expectedPid 只查存活
   （classify 才查 ctl 属主）；process.js:162-165 的 SIGKILL 定时器不跟踪（PID 复用窗口）。
D11.【中低 · guardian 语义不一致】health-gate.js:43-55 + controller.js:177-180：child/adopted 死亡分支在
   guardian=false 时转 STOPPED 不自愈（:165-173），但 HTTP 假死分支不看 guardian 直接 beginRestart。
   若 guardian=false 表示"不自动自愈"，假死路径越权；若假死必须自愈，应在注释中明确。
D12.【中低 · 停止落空】process.js:246-249 stopProcess 先清 adoptedPid 再 killAdopted；kill 失败被吞
   （signals.js:69-88），状态已 STOPPED 且无 pid 记录，下一拍 desired=stopped + portUp 会转 OBSERVED 重新观测
   → 用户的"停止"落空且无失败事件。
D13.【低 · 死代码/文案/诊断】api-rebind.js:76 `host.lifecycleManager && null;` 无副作用空语句；
   runtime.js:61 `('daemon 未启动: ' + this.name)` 的 this 是 host（无 name，应为 lc.name）→ 文案 "undefined"；
   decide.js:12-40 快照缺 guardian 维度，guardian=false 的 adopted_exit 恒产生 shadow 假 diff；
   signals.js:59-65 _killTimer 单槽被覆盖、无 clearTimeout 且回调反向置 null；
   compose.js:20-25 装配四步无失败回滚（fail-fast 取舍）；api-rebind.js:12-51 并发重绑时可泄漏已监听的旧 server。

### 4.2c API 边界深度扫描补充（第四个子代理 + 本组复核）

本组已逐文件读过 src/api/**，以下为去重后被复核的关键项。

A1. 【中高 · 安全 · 局域网 CSRF】originAllowed 闸②只校验"Origin 主机属 RFC1918 + 端口相等"，不校验 Origin 主机 ==
   实际访问主机。src/api/security.js:114,116（isLocalOrLanHost + port===apiPort）。
   触发：apiHost=0.0.0.0 且未配 apiAccessKey（lan-panel.js 开 LAN 不强制设 key）时，同网段攻击者把恶意页挂在
   http://<私网IP>:<apiPort>，Origin 即被放行；Host 闸①看到的也是私有 IP，一并放行。
   后果：受害者在该 LAN 浏览器打开恶意页即可被驱动 POST /session/stop、/lifecycle/dsh/stop、/native/uninstall、
   /native/upgrade、/instances/*、/settings/*、/shutdown 等全部破坏性写端点（响应读不到但副作用发生）。
   与 4.2#6（开 LAN 不要求密钥）叠加。修法：闸②应比较 Origin 主机与 Host/实际面板主机，而不仅是"私有网段+端口"。

A2. 【中 · 安全 · 任意命令执行】POST /instances/add 原样接受 command 数组。
   src/api/domains/instances.js:146 → src/domains/instance/model.js:41（`command: Array.isArray(payload.command) ? payload.command : []`）
   → src/domains/instance/sandbox.js:33（有 command 即直接返回）→ src/platform/os/service.js startTransient 交给 systemd-run。
   任何能驱动写 API 的客户端可让守卫以自身身份执行任意命令；command 字段未在 contract.js / deps.js 登记。
   修法：白名单化/移除 HTTP 层对该字段的接受。
   注：读命令执行结果需 systemd-run 权限，但该字段确实覆盖沙箱默认命令，破坏沙箱语义。

A3. 【中 · 安全 · 盲 SSRF】/dist/registry/probe 与 /dist/registry/set 的目标 host 由请求体控制。
   src/api/domains/dist.js:38-40 只校验 /^https?:\/\//；distribution/registry.js 的 fetch 默认跟随重定向；
   manualOrigin 连该弱校验都没有。可打到任意内网地址（HTTP 层已 originAllowed + 非回环需 access key）。
   修法：host 白名单 + 禁止重定向。

A4. 【高 · API 契约 · 假成功】/instances 的 remove/update/stop 恒回 200。
   src/api/domains/instances.js:162/:163/:171：底层 removeInstance/updateInstance/stopInstance 有 {ok:false} 分支
   （实例不存在/平台不支持），但 HTTP 一律 200；而 start（:168-170）已按 r.ok 映射 400。
   与 4.2 观察项一致，此处升级为"确认错误"（未验证不得报成功）。

A5. 【中 · 异常边界漏洞】collectBody 的 onDone 不在网关异常边界内。
   src/api/transport/body.js:25 在 `req.on('end')` 回调里调用 onDone(body)；而 src/api/transport/server.js 的
   try/catch 只包住 d.handle(ctx) 的同步调用与其返回 Promise（:137-146）。所有以 collectBody 收尾的域 handler
   在 onDone 内同步抛错时，异常经 stream emit 升级为进程级 uncaughtException，与"请求级错误绝不穿透"
   （server.js:32-33）及 bin 的 3 次自杀重启策略冲突。可能触发的点：guard.js 的 setAutostart/setLanPanel/
   setAccessKey/setCloseAction、native.js 的 startInstall/upgrade/startUninstall、relay.js 的 lanFrpc。
   修法：在 body.js 内包 try/catch 或让 server 传入的边界函数包裹 onDone。

A6. 【中 · 假成功】/router 把失败包成 200。src/api/domains/router.js:19/:23 的 ports/status 在 catch 中
   send(200,{...,error})；:33/:36 的 start/stop 对任何解析结果都 send(200,r)（仅异常 500）。
   前端/CLI 无法用状态码判成败，与同文件其它端点（400/500）不一致。

低危/契约项（本组复核）：
- 【低】/lifecycle 与 /lifecycle/status 不判方法，任意方法 200（lifecycle.js:38-41；contract.js 声明 GET）。
- 【低】/logs/export 未像 /events、/logs/tail 那样兜底 sup.eventHub（lifecycle.js:139），缺失时 TypeError→500。
- 【低】畸形 JSON body 在 instances 域回 500（instances.js:196 catch → 500），其它域回 400。
- 【低】OPEN_WEB_CODES 无过期清扫（见 4.2 观察）。
- 【低】hub tailLog 用 `stream in fixed` 判流，constructor/toString 等原型键会命中（非穿越，通常抛错）。
- 【低】body 限长按 String.length（UTF-16 码元）而非字节（body.js:16-17），多字节输入可略超 maxBytes。
- 【低】CSP 缺 frame-ancestors/base-uri/object-src/form-action 且无 X-Frame-Options（static.js:55）。
- 【低】壳 CORS 反射任意 *.tauri.localhost Origin（server.js:59-73）；依赖浏览器对 .localhost 的解析行为。
- 【低】错误信息回显内部 exception message（server.js safeFail 及各域 500）。
- 【低】无 Origin 时闸② fail-open、无 Host 时闸①跳过（security.js:98-109）——已知权衡。
- 【低 · 跨范围】shared/ip.js 的 isPrivateIpv4 不校验八位组 <=255（10.999.999.999 视为私有）；被 security.js 消费。

子代理核对为"无缺陷"的面：令牌比较为常量时间（safeKeyEqual sha256+timingSafeEqual）；
Host/Origin 畸形输入 fail-closed、大小写归一；静态托管用未解码原始 pathname + path.relative，无路径穿越；
所有 POST 写端点均先经 originAllowed；contract.js/router-table.js/deps.js 未见漏登记或腐化。

### 4.3 规范标准

- 本轮范围内注释符号与 emoji 仍大面积存在（见第三节统计约 7586 处），未清理（J 组不改 src/）。
- 注释复述代码 WHAT、日期/变更叙事、逐行解释在 src/app 与 src/api 中占比很高（例如 api/security.js、
  control/manager.js、control/entry.js、api/transport/server.js、api/domains/*.js 的头注）。
  属 K 组注释精简任务的目标，未执行。
- 观察：src/api/contract.js 的 SURFACE 未单列 `/router/start` 与 `/router/stop`（router.js:32-37 以 action 判定实现），
  仅由 PREFIXES '/router/' 覆盖。按 test/api-surface-test.js 的提取规则（只提取 pathname === '...' 与
  pathname.startsWith('...')）不会失败，但两个真实端点缺少独立的 methods/consumers 声明。

### 4.4 功能设计

- 失败回滚主线基本健全：native/upgrade.js 的 先停→装→验→失败回滚 有明确状态机与回滚路径；
  entry.js 的 start/stop/restart 已尊重 {ok:false}（K4/P1 修复痕迹）。
- 观察：src/app/control/entry.js:173 stop() 对 phase==='stopped' 直接 `{ok:true, already:true}` 而不调用停止回调；
  若目录/视图相位落后于真实进程（如观测陈旧），可能报"已停止"而进程仍在。属相位可信度问题，非本轮可判定错误。
- 观察：api/static.js:55 的 CSP 为 default-src/script-src/style-src/img-src/connect-src，缺 object-src 'none'、
  base-uri 'self'、frame-ancestors 'none'。属纵深防御加固项，低。
- 观察：/open 交换一次性码要求 identity.loopback + originAllowed（instances.js:71-72），Set-Cookie 仅带
  Path=/; HttpOnly（无 SameSite）——回环 HTTP 下无 Secure 可接受，SameSite 依赖浏览器默认 Lax。

## 五、验证方式（静态，未运行测试）

- 所有发现均以 read 逐文件阅读 + grep 交叉验证调用点得出；涉及删除依据的符号均全仓 grep（含 test/）。
- 未运行 npm test / node test/*.js / 门禁；验收由 CI 裁决。
- 本组未改 src/，故无"改动前后等价性"需要验证；K 组若采纳第二节建议进行删除，需自行做 node --check 与等价性核对。

## 六、未执行项 / 交由主代理

- src/ 死代码删除、注释精简、注释符号清理：本组为 J 组，只报告（第二节、第三节）。
- 第 4.2 节"已确认错误"如需直接修复，应由 K 组或主代理在对应范围执行；本报告不改 src/。
