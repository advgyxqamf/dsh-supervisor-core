# P3-E-1 AUDIT 积压清点（唯一完整积压清单）

> 只读复审产出（P3-E-1）。未运行任何测试/门禁、未做 git 写操作、未改 src/ 或 test/。
> 方法：逐份读 11 份 `design-notes/AUDIT-*.md` + 3 份 `design-notes/_audit-r5-stale-*.md`（约 2800 行），
> 抽取未修项后与 FIX-1..8、N1..N11、P2 各工作流（`_p2-ws*.md`）对账，并**逐条 grep/read 当前工作树**验证。
> 行号以写入本报告时的当前工作树为准。全部路径为仓库相对路径。

> ⚠ **本文件是「阶段三（P3-E-1）快照」，不是当前待办清单。** §2 的 36 项「未修」已在
> **阶段四/五**修复（提交 `21e913e`/`ba4304d`/`b13d5fc`/`b887c9e`/`1ed28b5`/`28f01a3`/`1dde036` 等，
> 逐项证据见 `_p4-*.md`/`_p5-*.md`）。保留本表仅作审计溯源；**当前待办以 `_workorder-phase6.md` 与上会话
> `HANDOFF.md` 为准**。本会话抽验（逐条 grep/read 当前树）：`markInstanceNetFail` 已不存在；非流式已有
> 180s `responseGuard`；`plugin/market.js` 有 `_startBuild()` 的 `.catch`；`instance/store.js` 有端口对账 +
> `_quarantineCorrupt`；`settings/access.js` 已核验落盘；`control/registry.js` 已 merge ownership；
> `control/projection.js` BACKOFF 已 `healthy=false`；`control/entry.js` stop 已落 desired；`instance/ops.js`
> 已 `inst.sandbox || {}`；`apps-registry` 已按 keyId 重取；`api/domains/dist.js` SSRF 重定向已由
> `platform/distribution/registry.js` 的 `redirect:'manual'` 闭环。**本表旧行号已随文件搬迁失效**
> （例：`domains/router/forward.js` → `domains/router/handlers/forward.js`）。

---

## 0. 对账总览

| 状态 | 数量级 | 说明 |
|---|---|---|
| 已修（有源码证据） | 约 60 项 | 见 §1；这是 P2 与更早 FIX 轮的实际成果，非仅报告自称 |
| ~~未修~~ **已全部处置**（阶段四/五；本表为阶段三快照） | **36 项** | P0 0；P1 12、P2 19、门禁债 5；**逐行「现状」已回写**（34 已修 / #29 部分 / #32 部分） |
| 部分修 | 6 项 | 见 §3 |
| 存疑（只读无法定性/证据不足） | 7 项 | 见 §3.2 |
| 不适用 / 已正确标注 | 10 项 | 见 §4 |
| 已分配在 P3-A/B/C/D 在办 | 8 项 | 见 §4.2，不计入积压 |

**结论：11 份 AUDIT 的高危项（数据丢失/假成功/安全闸绕过/状态恢复错配）已被 FIX-1..8 与 P2 基本清空
（§1 逐条有当前源码证据）；剩余 36 项积压集中在「次要确认缺陷（熔断计数、视图谎报、缓存与登记泄漏）」
与「死代码/文档/门禁制度债」，无 P0。**

---

## 1. 已修（对账结论，组级）

| 来源 | 已修项 | 证据（当前树） |
|---|---|---|
| AUDIT-app-orchestration 4.2 #1 / 4.2b D1 | frp 暴露闸「先开后改」与非布尔绕过 | `domain-actions/main.js:20` 先 `!!` 归一，:32 起按生效态判闸 |
| AUDIT-app-orchestration #2 | bootstrap 在 router daemon 路径提前 return，跳过更新检查与壳看护 | FIX-2；`bootstrap.js` 已无该提前 return 路径 |
| AUDIT-app-orchestration #5 / D3 | controller 忽略 applyPort 返回值 | `controller.js:56` `if (this.main.applyPort(...)) { ... }` |
| AUDIT-app-orchestration #6 | 开 LAN 不要求访问密钥 | `lan-panel.js:40` 无 apiAccessKey 即拒（code=ACCESS_KEY_REQUIRED） |
| AUDIT-app-orchestration #8 | upgrade hold 跨重启调不存在的 set/since/setSince | `store.js:58` 改用 `upgradeHold.enter()`；`upgrade-hold.js:74` 只导出工厂 |
| AUDIT-app-orchestration #9 | registry._load 单条坏 entry 截断整份加载 | `registry.js:67-84` 循环内 per-entry try/catch + warn 跳过 |
| AUDIT-app-orchestration #10 | 关停不校验 stopUnit 仍写 STOPPED | FIX-4；`ops.js:74-77` 先 stopOk 再 isUnitActive 复核 |
| AUDIT-app-orchestration #11 / D7 | 心跳两拍重叠（.finally 无代际） | N2；`bootstrap.js` 用 `_heartbeatBeat` 归属判断 + 阈值抬到最坏上拍 |
| AUDIT-app-orchestration #2 残留 / D2 | api-rebind 用未定义 `ports` | `api-rebind.js:41/72/77` 全部 `portsShared` |
| AUDIT-app-orchestration 4.2c A1 | LAN CSRF（Origin 主机 ≠ Host） | `security.js` 闸②增 `normalizeHostname(u.hostname) !== normalizeHostname(hostname)` 拒绝 |
| AUDIT-app-orchestration 4.2c A2 | /instances/add 任意命令 | N11；`instances.js:181` 结构闸 + DSH/node 入口白名单 |
| AUDIT-app-orchestration 4.2c A4 / F12 | /instances remove/update/stop 恒 200 | `instances.js:185/202` 按 `r.ok` 映射 200/400 |
| AUDIT-app-orchestration 4.2c A5 | collectBody onDone 逃出异常边界 | FIX-8；`body.js:29-31` onDone 包 try/catch |
| AUDIT-app-orchestration 4.2c A6（部分） | /router start/stop 恒 200 | `api/domains/router.js:33/36` 按 `r.ok === false` → 400 |
| AUDIT-app-orchestration D4/D5 | uninstall 锁 TOCTOU、install 缺 busy 闸 | FIX-3 |
| AUDIT-router-relay BL-1 | waitFrpcExit 空操作（frpc 孤儿） | FIX-7；`daemon.js:160/181` waitFrpcExit(child) 使用捕获句柄 |
| AUDIT-router-relay BL-2 | probe DEAD 跳过使 hang 看护不可达 | `probe.js:154` 注释明确「DEAD 不得在此跳过」，已移除 skip |
| AUDIT-router-relay BL-3 | close/error 无条件清 inst.pid | FIX-7；`probe.js:121` `if (inst.pid === child.pid)` 守卫 |
| AUDIT-router-relay BL-5 | 反代更新对常驻实例静默空转 | FIX-8；`apps-registry.js:102` `stopInstance(inst, true)` |
| AUDIT-router-relay BL-6 | 停用供应商非 force 停实例 | FIX-8；`endpoint.js:110` `stopInstance(i, true)` |
| AUDIT-router-relay BL-7 / N9 | credits 缺席伪造月窗口 100% | `quota-strategies.js:106` 已加 `hasCredits &&` |
| AUDIT-router-relay BL-8 / N10 | client-abort 不 destroy 上游 | `forward.js:127/284` destroy 上游 req/res |
| AUDIT-router-relay BL-13 / N6 | 会话换代竞态（旧 cookie 覆盖新值） | N6；`relay/session.js` 引入 bootstrapEpoch 换代丢弃 |
| AUDIT-instance-plugin-shell F1 | 查询失败被当不活跃 → 删沙箱数据 | FIX-5；`instance/ops.js:75-80` `active !== false` 才视为已停 |
| AUDIT-instance-plugin-shell F2 | stopInstance 假成功 | FIX-5；`lifecycle.js:107` 读 stopUnit 结果并据此置相位 |
| AUDIT-instance-plugin-shell F3 | 安装任务登记失败卡 FAILED | FIX-5；`lifecycle.js:196` 自愈条件放宽为 `installOk===true && !running` |
| AUDIT-instance-plugin-shell F4 | 升级回滚未先停新版单元 | FIX-5；`upgrade.js:140-147` 回滚前 `lifecycle.stop(id)` |
| AUDIT-instance-plugin-shell F13 | Provider 写类命令吞失败（根因） | FIX-6；`service.js:37/56-57` `!== null` / `runDetail` 如实返回 |
| AUDIT-dead-code P0（部分） | getKinds / isDshSideKind / tokenFileBaseName / listenerCount | P2 WS1-a 删除（全仓零消费者，已复核） |
| AUDIT-shared-contract | `contract/runtime.js` file 导出误删 | f410a3a 恢复 |
| AUDIT-standards A2/A3/B1/E2 | 本机测试指引、_uninstallTests 过期政策、DOMAIN 未登记、U-3 词表 | P2 WS3（f4c1558/31d55a3） |
| AUDIT-docs-comment-staleness | 35 类文本订正（失效路径/硬标准/日期叙事） | 该轮自述 + WS3 根级复核 |
| AUDIT-test-gates §2.1 | switch-policies assert.ok(true)、token-boundary 假断言、freeze B1 恒真 | 该轮自述（已落盘） |

---

## 2. 未修积压主表（按优先级）

> 优先级：**P0** 可证安全/数据后果；**P1** 明确正确性/资源/契约问题；**P2** 健壮性/一致性/死代码/文档。
>
> ⚠ **现状列已按 2026-09-17 工作树逐行回写**：`✅已修（阶段四/五）` = 抽验当前源码已修复或重构；
> 两处例外：**#29** 63 条未用导出仅删大部分（未逐条核 63 行）、**#32** U-1 真空转已改为
> 「reads:false + pending」的**诚实声明 + 缺口可见**（未完全读规范正文）。

### 2.1 P1（12 项）

| # | 条目 | 来源 文件:行 | 现状 | 最小修法 | 证据 |
|---|---|---|---|---|---|
| 1 | 流式中断熔断标记传错实参（永远 no-op） | AUDIT-router-relay BL-4 | ✅已修（阶段四/五） | 两处改传实例：`prov.markInstanceNetFail(instOf(prov, acc))` | `forward.js:132`、`:229` 仍传 `acc`；`proxy.js:177` `instOrAcc.pid ? ... : null` → 账号无 pid 直接 return |
| 2 | 非流式响应体收到头后无任何超时（可永久悬挂） | AUDIT-router-relay BL-9 | ✅已修（阶段四/五） | 非流式分支对 `ur` 设总时长上限，或 writeThrough 加读超时 | `forward.js:68` 有 streamRequested，未见对非流式 body 的时限 |
| 3 | 插件市场后台刷新无 `.catch` → unhandledRejection | AUDIT-instance-plugin-shell F5 | ✅已修（阶段四/五） | `buildIndex().catch(warn).finally(...)`；`indexNpm` 逐包 try/catch | `plugin/market.js:78` 与 `:85` 均为 `buildIndex().finally(...)`，无 catch |
| 4 | 实例端口变更后旧 `inst:*` 登记永久泄漏 | AUDIT-instance-plugin-shell F6 | ✅已修（阶段四/五） | 按 owner 对账：`byOwner('inst:'+id)` 与 `inst.port` 不一致则先 unregister 再 register | `instance/store.js:71-85` 只做「缺则补 + 实例删除则清」，无端口变更对账 |
| 5 | 应用更新对常驻实例静默空转的同类路径：步骤集是创建时快照 | AUDIT-router-relay FD-1 | ✅已修（阶段四/五） | 执行时按 keyId 重取实例集，或改 `setStep` 用 key 定位 | `ops/apps-registry.js:98/106` 直接用 `insts[i]` |
| 6 | 密钥/关闭行为持久化失败仍回 `ok:true` | AUDIT-app-orchestration D8 | ✅已修（阶段四/五） | `persistConfigPatch` 返回成败并透传；失败回 `{ok:false,error}` | `settings/access.js:21-23`、`:42-44` 无条件 `return { ok: true }` |
| 7 | ManagedRegistry.update 部分 ownership 补丁静默清空未提供字段 | AUDIT-app-orchestration #14 | ✅已修（阶段四/五） | 合并而非整体替换：`normalizeOwnership({ ...e.ownership, ...p.ownership })` | `control/registry.js:188-190` `e.ownership = normalizeOwnership(p.ownership)` |
| 8 | syncDshView BACKOFF 分支漏写 healthy → 视图谎报健康 | AUDIT-app-orchestration #12 | ✅已修（阶段四/五） | BACKOFF 分支补 `dsh.healthy = false` | `control/projection.js:44-46` 只设 phase/error |
| 9 | ManagedLifecycle.stop 对 phase==='stopped' 短路，不落 desired | AUDIT-app-orchestration #13 | ✅已修（阶段四/五） | 短路前先 `this.desired='stopped'`（或改调用方语义） | `control/entry.js:162` 早退在 `:172` 的 desired 赋值之前 |
| 10 | `inst.sandbox` 未 guard，历史/原生记录会抛异常 | AUDIT-r5-relay-instance B1 | ✅已修（阶段四/五） | `inst.sandbox = inst.sandbox \|\| {}` 后再写 | `instance/ops.js:116-117` 直接 `inst.sandbox.memoryMax = ...` |
| 11 | instances.json 解析失败静默清空（无日志/备份） | AUDIT-r5-relay-instance B2 | ✅已修（阶段四/五） | catch 内先 `logger.warn` + 备份损坏文件，再 `_replace([])` | `instance/store.js:29` `catch { this._replace([]); }` |
| 12 | /dist/registry/probe 目标 host 由请求体控制（盲 SSRF） | AUDIT-app-orchestration 4.2c A3 | ✅已修（阶段四/五） | host 白名单 + 禁止重定向 | `api/domains/dist.js:39` 只校验 `^https?://` |

### 2.2 P2（19 项）

| # | 条目 | 来源 文件:行 | 现状 | 最小修法 | 证据 |
|---|---|---|---|---|---|
| 13 | 插件更新检测对失败结果做 6h 负缓存 | F8 | ✅已修（阶段四/五） | 仅 `latest !== null` 才写 `_updCache` | `plugin/updater.js:23` `ctx._updCache[p.name] = { latest, at: Date.now() }` |
| 14 | journal pending 无时效上限（自愈被持续拖慢） | F10 | ✅已修（阶段四/五） | pending 加时效，或与 phaseMaxAgeMs 对称 | `shell/watchdog.js:78-80` `if (j && j.to && !j.confirmed) return true;` |
| 15 | credits 冻结维持分支不补 nextResetAt（探测风暴） | BL-12 | ✅已修（阶段四/五） | 该分支写 `acc.nextResetAt = at \|\| now + CREDITS_RECHECK_MS` | `providers/policies/freeze.js` 维持分支未见 nextResetAt 赋值 |
| 16 | OAuth 重新发起对上一 Promise reject 可能 unhandledRejection | BL-11 | ✅已修（阶段四/五） | reject 前 `.catch(()=>{})` 自吞 | `router/ops/oauth.js` 仅 `reject(err)` |
| 17 | startProviderServer 未在 listen 前占位（并发二次 listen/漏 close） | BL-14 | ✅已修（阶段四/五） | listen 前先在 map 占位（starting 标记） | `router/endpoint.js:59/63` 仅在 listen 回调写 map |
| 18 | frp 启用但 serverAddr 为空仍会 start frpc | FD-3 | ✅已修（阶段四/五） | settings 归一校验 serverAddr 非空，否则拒绝启用 | `relay/frp.js:55` `serverAddr: String(s.serverAddr \|\| '')` |
| 19 | 受管清单 main 优先级与注释不符（沙箱先命中） | AA-1 | ✅已修（阶段四/五） | main 放数组头部，或修正注释 | `relay/managed.js:24` `[...sandboxes, main]`；`findManaged` 从左取首 |
| 20 | 只读视图内发生写副作用 | NS-2 | ✅已修（阶段四/五） | 把 `_ensureLimit` 的写入移到状态投影路径 | `router/views.js:83` 调 `p._ensureLimit(a)`（会写 acc.limit） |
| 21 | 死代码：`platform/os/process.js` 的 `isAlive` 导出零消费者 | AUDIT-dead-code P0 | ✅已修（阶段四/五） | 删函数体与导出（唯一生产实现是 pidlookup/probe） | `process.js:10/41`；全仓其它 `isAlive` 为 deps 注入或注释 |
| 22 | 死代码：`TaskRegistry.cancel` 零调用（canceled 态不可达） | AUDIT-dead-code P0 | ✅已修（阶段四/五） | 删除或接入真实取消路径 | `platform/service/tasks.js:215` 全仓仅定义 |
| 23 | 死代码：`router/model.js` 的 `stateContainer` 导出零消费者 | AUDIT-dead-code P0 | ✅已修（阶段四/五） | 删导出键（函数体可留给 ProxyInstance 内部） | `model.js:92/94`，全仓 2 处=定义+导出 |
| 24 | 死链：令牌恢复文件名注入写而不读 | AUDIT-dead-code §二 | ✅已修（阶段四/五） | 删 `configureTokenFileName/tokenFileName/_tokenFileName/DEFAULT_TOKEN_FILE_NAME` 与调用点；真实值在 `compose/core.js` 硬编码 | `persist.js:153/161-170`；`app/settings/token-kinds.js` 注入无人读 |
| 25 | 死代码：`state/intents.js` 的 `has()`/`any()` 零调用 | AUDIT-dead-code | ✅已修（阶段四/五） | 删两方法（注释声称的用法不存在） | `intents.js:36/41`，全仓各 1 处 |
| 26 | 死字段：`ManagedRegistry._loaded` 只写不读 | AUDIT-app-orchestration | ✅已修（阶段四/五） | 删该字段 | `control/registry.js:49/88` 仅赋值 |
| 27 | 死导入：`log/logcore.js` 的 `LineBuffer` 未使用 | AUDIT-dead-code §六 | ✅已修（阶段四/五） | 从解构中去掉 | `log/logcore.js:10` |
| 28 | 死导入：`app/assembly/bootstrap.js` 的 `registerAll` 未使用 | AUDIT-dead-code §六 | ✅已修（阶段四/五） | 删除该 require 行 | `bootstrap.js:11` 全文件仅此一处（真正调用在 compose/observers.js） |
| 29 | 63 条未用导出（各模块内部工具函数一并导出） | AUDIT-dead-code §四 | 部分（阶段四/五已删大部分；63 行未逐条核） | 按「默认收敛、按需开放」分批删导出键（R2 先核验） | 该报告 §四机器清单（本报告不重复 63 行） |
| 30 | 重复实现：`taskStateToView` / `taskStateToJobState`（+apps-registry 第三份） | F14 / BL | ✅已修（阶段四/五） | 抽公共纯函数或加注释说明「有意平行」 | `instance/model.js:9`、`plugin/model.js:37`、`ops/apps-registry.js:138` |
| 31 | 发布脚本死分支/死变量 | AUDIT-dead-code §六 | ✅已修（阶段四/五） | 逐项删；`publish-core.sh` ALL=1 块须先改 `test/all-platforms-test.js` T2-j | `ci-core.sh:21/41`（ALL_PLATFORMS 恒 0）、`publish-core.sh:111`（BIN_NAME）、`verify-versions.js:18`、`cred.sh idx()/backup` |

### 2.3 门禁/制度债（P2，另列 5 项）

| # | 条目 | 来源 | 现状 | 最小修法 | 证据 |
|---|---|---|---|---|---|
| 32 | standards-uniqueness U-1 只断言「文件存在」，不断言门禁真读规范正文（真空转） | AUDIT-standards E1 | 部分（已按「诚实声明 + 缺口可见」处置：reads:false + pending；未完全读正文） | 增加「门禁源码须引用规范文件名/正文」的判据，或把规范正文抽成机器读数据 | `standards-uniqueness-test.js` U-1 仅 `fs.existsSync`；`layering-and-dependency-gate-test.js` 不提 DEVELOPMENT-TRACK |
| 33 | acceptance A-5 只扫根级 .md（子目录与「本机实测」叙述不拦） | AUDIT-standards E3 | ✅已修（阶段四/五） | A-5 扩到 `release/**`、`.github/**` 的 .md | `acceptance-standard-gate-test.js:84` `fs.readdirSync(ROOT)` |
| 34 | build.yml precheck 段注释仍称「四平台齐备后构建矩阵不再运行」 | AUDIT-standards D1 | ✅已修（阶段四/五） | 改为「need_build 只作用于 release 与 --publish 步骤」 | `.github/workflows/build.yml:97-98` |
| 35 | RELEASE-STANDARD §4 残留「条件 job（build/release）」 | AUDIT-standards A1 残留 | ✅已修（阶段四/五） | 限定为 release（build 已每次都跑） | `RELEASE-STANDARD.md:131` |
| 36 | layering 门禁头注记载不存在的 guard/dist/core.cjs；L-3 `\|\| {}` 空转 | AUDIT-arch A6 | ✅已修（阶段四/五） | 删过时头注；L-3 用显式常量或恢复登记项 | `layering-and-dependency-gate-test.js:15/16/204` |

---

## 3. 部分修 / 存疑

### 3.1 部分修（6）

| 条目 | 已修部分 | 未修部分 |
|---|---|---|
| AUDIT-app-orchestration A6（/router 假成功） | start/stop 已按 `r.ok` → 400 | `ports/status` 的 catch 仍 `send(200, {..., error})`（`api/domains/router.js:18/22`） |
| AUDIT-standards A2（本机测试禁令） | DEVELOPMENT-TRACK/RELEASE-STANDARD/CREDENTIALS-STANDARD 主要指引已收敛（P2 WS3） | `release/README.md`、`release/runbooks/*`、`.github/pull_request_template.md` 仍要求本机 npm test/ci-core（不受 U-3/A-5 覆盖） |
| AUDIT-arch B3（DIRECTORY §3 目录树漂移） | WS3 修了 forward→forward-core、frpmgr→frp 两处 | 树内 fixed-ports/lifecycle-registration/binding 等仍与现状不符 |
| AUDIT-dead-code P0 | 已删 getKinds/isDshSideKind/tokenFileBaseName/listenerCount | tokenFileName 链、tasks.cancel、process.isAlive、stateContainer 未删 |
| AUDIT-instance-plugin-shell F7 | 死变量 `_latestDshVer/_latestDshVerAt` 已删 | `instance/upgrade.js` 的 `inst.state.version = readInstalledVersion(inst)` 仍写而不读（P3-D 在办） |
| AUDIT-test-gates §1.2 | `_uninstallTests` 过期文本与两个测试头注已更正（WS3） | 未裁决「移出链 vs 保留在链」，且无门禁读该字段 |

### 3.2 存疑（只读无法定性，7）

| 条目 | 为何存疑 |
|---|---|
| F9 看护陈旧相位告警只发一次 | `watchdog.js:167 _reset()` 已复位 phaseStaleWarned；需确认「离开更新相位」是否走 _reset，未逐路径确认 |
| D9 `install()` 是否缺 try/finally 释放 installing | 见 `native/ops.js:56 finally`（疑属 upgrade）、`:83/:95` 两处置 null；需逐行确认分支覆盖 |
| D10 daemon 异主判定未用 classify | `process.js:189/207` 有 classify；未确认 `runtime.js:146-155` 与 `bootstrap.js:120` 是否仍直判 lock/ctl |
| D11 guardian 语义不一致（health-gate 假死分支不看 guardian） | 需确认 `health-gate.js:43-55` 与 `:165-173` 的现行分支 |
| D12 stopProcess「停止落空」 | `main/process.js:233-240` 仍先取 adoptedPid 再 kill；kill 失败是否仍吞未确认 |
| ARCHITECTURE-ACCEPTANCE 数字漂移（298/79/125） | 属存档数字，需按当前树重取（最大文件 294、supervisor 78、链 127） |
| §5 域内目标超限 8 文件 | P2 注释精简后行数已变，需重新实测逐文件对比 |

---

## 4. 不适用 / 已分配

### 4.1 不适用或已正确标注（10）
- AUDIT-plugin-shell F15：残留 `⚠` 仅在**代码字符串**（日志文案），按规则保留（`plugin/layers.js`、`ops.js`）。
- AUDIT-router-relay NS-3：`keyFingerprint` 的 U+2026 是**代码字符串**（对外格式），不得按注释清理。
- AUDIT-shared-contract：`matrix.isSupported`、`runtime.SUPPORTED_SCHEMA` 等为门禁/测试引用，保留。
- AUDIT-dead-code §九「绝不能删」清单（入口/契约/构建产物/字面量锚定/有意平行）：不适用删除。
- `api/deps.js`：R9 声明性 SSOT，非死代码（建议补头注说明）。
- AUDIT-docs §4.3 已正确标废项（README SEA、RELEASE-STANDARD release-core.sh、CROSS-PLATFORM export-shell 等）。
- AUDIT-test-gates §6 调试残留：已核实为 0。
- AUDIT-test-gates §2.1 三项空转断言：已修。
- AUDIT-arch B2 / AUDIT-standards B1：已修（DOMAIN 已登记，U-3 词表已加严）。
- AUDIT-arch 阈值 300/400：已修（统一 300）。

### 4.2 已分配在 P3-A/B/C/D（不计入本积压）
- P3-A：app 六切面工厂化（AUDIT-arch A1/D2 的 app 层 DF-5/DF-6）；`collaborators.js` 的 SPEC/THIN_SPEC/assertCollaboratorTargets 死壳（AUDIT-arch A3）；`manager.restart` 死分支。
- P3-B：CP 注释钉子门禁、DG-12 去自锁、DG-11 形态补全、EX 导出消费者工具（对应 AUDIT-test-gates 与 f410a3a 根因）。
- P3-C：N11 残留（`["node","/tmp/evil.js"]` 仍可执行，AUDIT-app-orchestration 4.2c A2 的强化）；`api/identity.js` shim 清理（AUDIT-arch A4）。
- P3-D：`router/instances/proxy-instance.js` shim（AUDIT-arch A5 / dead-code §3.1）；`router/ops.js` `releaseProviderPorts` 导出（dead-code §3.1）；`instance/upgrade.js` 死赋值（F7）。

---

## 5. 建议主控下一步（3-5 条）

1. **先清 3 条「一批就能改完、且 CI 可证」的 P1 视图/契约项**：#7 registry ownership 合并、#8 projection BACKOFF healthy、#9 entry.stop 落 desired。
   三项都在 `src/app/control` 内、互不冲突，且现有门禁（app-ctor-injection / lifecycle-mirror / managed-registry）能回归。
2. **第 4 条 P1：#1 熔断实参修正**（`forward.js` 两处改传实例）。这是唯一「安全阀失效」类剩余项，
   且 `test/router-circuit-breaker-test.js:61` 只断言字符串、**不会**拦住——建议同批把该断言升级为行为断言。
3. **把文档类积压并入「docs-reference 门禁扩容」一次做**：A-5/U-3/docs-reference 目前只覆盖根级 .md，
   而 `release/README.md`、`runbooks/*`、`.github/pull_request_template.md` 是「本机 npm test」与失效路径的重灾区。
   建议 P3-B 的 EX 工具与 P3-E 这份清单合并成「根级 + release/ + .github/」三范围门禁，避免二次返工。
4. **死代码最后一批单独一次提交**（#21-28 共 8 项，全部零消费者，R2 证据已在来源报告）：
   与正在进行的 P3-D 合并为「死代码收尾」批次，避免与 P3-A 的 app 工厂化抢文件。
5. **存疑 7 项指派一人做「逐路径确认」**：其中 D9/D10/D11/D12 涉运行期语义，
   只读推理不足，需要按调用链逐条走查后定性，再决定是否进入修复批次。

---

## 6. 方法与局限

- **对账来源**：`design-notes/AUDIT-*.md`×11、`_audit-r5-stale-*.md`×3、`design-notes/FIX-*.md`×8、
  `design-notes/_next-wave-N1-N5.md`、`HANDOFF.md` §3.5/§0.2、`design-notes/_p2-ws*.md`×19。
- **验证方式**：只用 `read` / `grep`（CJK 用 `-oP '\p{Han}{4,}'`）/ `sed -n` / `wc` / 只读 `git`。
  每条「已修」均有当前树的行号证据（§1 右列）；每条「未修」均有 grep 证据（§2 右列）。
- **未做**：未运行任何测试/门禁；未改 src/ 或 test/；未 commit/push；未启动 daemon；未触碰状态根与 /tmp/dsh-*。
  故所有结论以 CI 为最终裁决，本报告不构成验收结论。
- **行号漂移**：工作树在 P2/P3 期间被多代理持续修改，行号以本报告写入时为准；
  合并时请以「文件 + 符号/文本」定位。
- **未逐字复核**：AUDIT-dead-code §四的 63 条未用导出（仅组级采信来源报告的机器清单，未逐条复跑）；
  AUDIT-r5-stale-release.md 的 release 子目录条目（该文件读取时与 stale-root 输出重叠，按 stale-root 的对应条目对账）。
