# 死代码/废弃逻辑完整复检审计报告（round5）

> 审计时间：2026-09-05 · 范围：/home/bowen/develop/plus（dsh-supervisor 内核 + skiff-original React 面板 + Rust Tauri 壳 + bin/scripts/模板 + 仓库级）
> 方法：6 路并行子系统审计 + 逐项源码级交叉验证（全仓引用计数/import 链/API 面/构建产物反证/ctl-facade 动态转发语义）。
> 基准：AUDIT_REPORT_2026-09-03_round4.md 遗留项逐条复核 + 全量扫描当前树新引入死代码。
> 全程只读，未修改任何源文件。
> **⚠️ 2026-09-06 更名/布局补注**：本文写作时的前端源码目录 `skiff-original/` 已于 2026-09-06 迁至 `dsh-supervisor/ui/`（`git mv`，历史 100% 保留）。文内所有 "skiff-original" 均指该前端源码目录，现路径为 `dsh-supervisor/ui/`；`ui-react/` 仍为构建产物镜像（release.sh 从 `ui/` 构建）。

---

## 0. 执行摘要

| 区域 | 死代码/废弃条目 | 可安全删除 | 需人工确认 |
|---|---|---|---|
| src/supervisor.js | 10 | 9 | 1 |
| src/presentation/api.js | 3 | 3 | 0 |
| infra 层 | 12 | 8 | 4 |
| domain 层 | 10 | 8 | 2 |
| router 子系统 | 13 | 10 | 3 |
| skiff-original 前端 | 13 | 12 | 1 |
| Rust 壳 / bin / scripts | 6 | 3 | 3 |
| 仓库/文档级 | 3 | 1 | 2 |

round4 遗留 9 项复核：7 项已修复/收敛（lastPicked 已删、maskKey 双份已收敛、零字节杂物已清等），2 项仍存在（api.js 死三元移址未修、instance 死三元未修），另有 resetCapabilityProbes/cancel() 确认仍无调用方（见 §7）。

---

## 1. 守卫核心（src/supervisor.js）

| # | 条目 | 位置 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | `_lanCtl(port)` | L754 | 全仓唯一命中=定义行；功能已被 `_lanCtlCall`(L755) 取代 | 删 |
| 2 | `lanDaemonMode()` | L748 | 唯一代码引用=自身；L758 注释自证被 lanDaemonEnabled() 取代 | 删 |
| 3 | `_lanActiveFast()` | L752 | 仅被死方法 lanDaemonMode 调用（传递性死） | 删 |
| 4 | `lanApi()` | L762 | src+test+bin 仅定义处命中（146/758 为注释）；门面已改判 lanDaemonEnabled() | 删 |
| 5 | `routerCtlCall()` | L584 | 仅定义+test 注释提及；被 _makeCtlFacade(Proxy) 取代 | 删 |
| 6 | `upgradeWriter` 字段 | L93 | 仅构造赋值 new Rotator，全仓 0 读取 | 删字段+构造 |
| 7 | `lanHook` 变量 + `void lanHook;` | L151/L169 | 定义后仅被 void 吞掉，其余 hook 已内联 | 删两行 |
| 8 | `guiAutostartFile/isGuiAutostartOn/setGuiAutostart` | L509/513/517 | supervisor 层纯透传，api.js/CLI 零消费（bin gui-autostart 走另一自实现路径） | 删（连带 host-service 同名方法核后方删） |
| 9 | 死三元 `targetPort===3080?43011:43011` | L1582 | 恒 43011 且 `|| findListeningPid(43011)` 重复探测 | 改 findListeningPid(43011) |

## 2. HTTP API（src/presentation/api.js）

| # | 条目 | 位置 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | 死三元 `send(r.ok ? 200 : 200, r)` | L674 | /env/node-lts 分支；round4 报 L639 未修，现移至 L674 | 改 send(200, r) |
| 2 | `ALLOWED = null` 死常量 | L29 | serveStatic 只用 MIME/CSP，从不读 ALLOWED | 删 |
| 3 | 头注释端点清单漂移 | L144-155 | 注释宣称 /version、/upgrade、/upgrade/status、/version/check；正文全无（旧托管时代存档） | 更新注释 |

## 3. infra 层

| # | 条目 | 位置 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | `resetCapabilityProbes` 导出 | platform/index.js:34/120 | 全仓 src+test 零引用（round4 点名未修） | 撤导出 |
| 2 | `servicehost` 导出 + servicehost.js 空壳 | platform/index.js:127 | servicehost.js 全文纯注释空 module.exports（P2 占位未实现）；导出零消费 | 标 deprecated 或 P2 实现 |
| 3 | `killGroupKill(pid)` | platform/process.js:45/49 | 仅定义+导出，零调用 | 删 |
| 4 | `isAllocated()` | ports.js:352 | 全仓仅 relay/manager.js:173 注释提及（复用现由 claimSlot byOwner 承担） | 删方法+注释 |
| 5 | `whichVersion` 导出 | env-catalog.js:83 | 无外部调用（cachedWhichVersion 内部用） | 撤导出 |
| 6 | `dataDir/supervisorDir` 导出 | platform/index.js:39-46/120 | 生产+测试零引用 | 撤导出 |
| 7 | daemon-lifecycle 导出 `waitProcessExit/waitPortFree/portFree` | proc/daemon-lifecycle.js:266 | 仅内部调用，外部零消费 | 撤导出收私有 |
| 8 | `DaemonLifecycle.superviseOnce/isRunning/status` | daemon-lifecycle.js:206/120/251 | supervisor 只调 ensureRunning/_clearIdentity/_spawnWindowUntil；superviseOnce 仅测试用 | 删或标测试专用 |
| 9 | `TASK_STATES/STEP_STATES` 常量 | task-registry.js:14/15 | 未导出未用（与 cancel() 同为保留 API 面） | 待确认 |
| 10 | `task-registry.cancel()` | task-registry.js:222 | src 0 调用；round4 已知；AUDIT_REPORT.md:252 注明有意保留 | 待确认（倾向删） |
| 11 | platform.capabilities/capabilityProfile | platform/index.js | **活代码**（instance/index.js:36 消费判 sandboxSupported） | — 修正误报 |

## 4. domain 层

| # | 条目 | 位置 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | `dist.fetchNodeLts()` | dist/index.js:248 | 全仓零调用；/env/node-lts 走 supervisor.nodeLtsStatus（本地启发式）——两套 LTS 探测重复 | 删或收敛 |
| 2 | `dist.guardSelfUpdateStatus/Apply` | dist/index.js:396/408 | supervisor.js:1061/1073 同名方法自实现（直接 require self-update 执行器），刻意绕过 dist 类 | 删 |
| 3 | `dist.fetchGithubLatest()` | dist/index.js:222 | 零外部调用；fetchLatestVersion 的 github 分支因 config 无 releaseChannel 键恒不可达 | 删（半死） |
| 4 | `dist` 导出 `REGISTRY_PRESETS` | dist/index.js:428 | 仅内部用（L169），外部零消费 | 撤导出 |
| 5 | `lifecycle.byKind()/statusOf()` | lifecycle/index.js:43/87 | 全仓仅定义；API 用 lm.get(id).snapshot() | 删 |
| 6 | `managed.wantStopped()` | lifecycle/managed.js:93 | 仅 test/lifecycle-mirror-test.js:47 | 删或标测试 |
| 7 | `monitor.isPortInUse()` | monitor/index.js:17 | 仅定义+导出，全仓零调用 | 删 |
| 8 | 死三元 `installing: !res.ok ? false : true` | instance/index.js:213 | 等价 res.ok（round4 点名未修） | 简化 |
| 9 | instance 写后不读字段 lastRunAt(L853)/installPid(L624)/state.version(L476/515) | instance/index.js | 均无读取方 | 删 |
| 10 | `native/index.js` 重复 module.exports | native/index.js:59 | 首份被 L67 覆盖 | 删首份 |
| 11 | pluginmarket getJson/getText | pluginmarket.js:44/330 | ~25 行重复实现（redirect/超时/上限骨架同构） | 收敛抽公共 |
| 12 | monitor/guardian/token 本体 | — | **均活**（修正"空壳转发"误报） | — |

## 5. router 子系统

| # | 条目 | 位置 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | `switchToAccount()/_providerOf()` | switch.js:82/95 | 全仓 0 调用；显式切换走 aux.switchToKey | 删 |
| 2 | `accountState()` | providers/base.js:491 | 全仓仅定义 | 删 |
| 3 | `confirmAccount` review 分支恒假 | base.js:246-255 | 全仓无 status=review 写入方（review 闸门已取消）→ 退化 no-op | 收敛/标注 |
| 4 | base.js L577 不可达守卫 | base.js:576-577 | L575 已 return，L577 永不命中 | 删 |
| 5 | index.js `ring/ringMax` 只写无读 | index.js:43/44/496/497 | log() push/splice 后无任何读取点 | 接线或删 |
| 6 | `evidenceTail()/evidenceStats()` | index.js:666/669 | 全仓 0 引用；文档称 ctl 开放但无 API 路由 | 接线或删 |
| 7 | `proxy.js _restartPending` 死字段 | proxy.js:528/531 | 只写不读 | 删 |
| 8 | `proxy.js _lastProblem` 死字段 | proxy.js:570 | 只写不读 | 删 |
| 9 | `proxy.js` L677-679 孤立旧 JSDoc | proxy.js:677-679 | markQuotaExhausted 旧描述残留 | 删 |
| 10 | forward-core 流中断自愈未接线 | forward-core.js:288-293 | 注释声称断流→restartInstance；实际调 markNetFail（base.js:343 no-op）且 Proxy 无覆写 | 待确认：补接线或删注释 |
| 11 | `decInflight` 与 `_endInflight` 重复 | forward-core.js:247/322 | 逻辑逐行相同 | 收敛 |
| 12 | `aux.removeProxyKey` 与 `base.discardAccount` 重复 | aux.js:567/base.js:257 | 同构 | 收敛 |
| 13 | forward-core 导出面冗余（maskKey 等） | forward-core.js:448 | maskKey 自 base 引入后原样再导出 | 收敛 |
| 14 | `EVIDENCE_HEADERS`/`STRATEGIES` 等再导出 | evidence.js:105 / quota-strategies.js:160 | 全仓零外部 import | 撤导出 |
| 15 | `proxyRunning` 从不置 false | proxy.js:30/644 | 只置 true；语义退化为"曾启用"粘滞位 | 待确认 |
| 16 | switch.js pickFor/reactToFailure 等 | — | **活**（forward-core 消费） | — |

## 6. skiff-original 前端

| # | 条目 | 证据 | 建议 |
|---|---|---|---|
| 1 | **整文件死** framework/ui/empty.tsx | 仅 ui/index.ts:40-46 导出；全 src 无消费 | 删文件+barrel |
| 2 | **整文件死** framework/ui/field.tsx | 仅 ui/index.ts:47-58 导出 | 删（连带 separator 若仅被其用） |
| 3 | **整文件死** framework/ui/input-group.tsx | 仅 ui/index.ts:60-66 导出 | 删（连带 textarea） |
| 4 | **整文件死** framework/ui/badge.tsx | 仅 ui/index.ts:24 导出；widgets Pill 已取代 | 删 |
| 5 | **整文件死** framework/ui/alert-dialog.tsx | 仅 ui/index.ts:12-23 导出 + 注释；FRAMEWORK.md 自述"备件" | 确认后删或标备件 |
| 6 | **整文件死** framework/layout/Page.tsx | layout/index.ts:14 导出；业务层仅注释"对齐" | 删（业务用 widgets Card） |
| 7 | **整目录死** framework/hooks/（useAsync） | hooks/index.ts:4 re-export；全 src 0 消费 | 删 |
| 8 | utils.ts: `waitForNextFrame`/`formatDateTime` | utils.ts:13/22 零消费 | 删（cn 保留） |
| 9 | format.ts: `formatTime`/`formatDate`/`formatCount` | format.ts:29/36/25；仅 formatSize 被用；formatCount 与 features 版撞名 | 保留 formatSize，删其余 |
| 10 | widgets.tsx: `DetailRow`/`QuotaBar` | widgets.tsx:87/97 零消费 | 删两导出 |
| 11 | client.ts 7 零消费方法（nativeStatus/lifecycleStatus/lifecycleRestart/instanceUpgradeStatus/proxyUpdateStatus/pluginInstallStatus/envDsh） | 仅定义无调用 | 删+关联类型 |
| 12 | polling.ts 快照死字段 snap.tasks/lastSyncAt/error | polling.ts:25-37；TasksPage 自拉 /tasks | 删 |
| 13 | package.json 未用依赖 typescript6/@typescript-eslint/parser/typescript-eslint/jsdom/@babel/plugin-syntax-jsx | 无 import/脚本引用 | 删 |
| 14 | checkbox/select/switch/progress | **活**（PluginsPage/LanPage/SettingsPage/Toolbar 真 import）；修正误报 | — |

## 7. round4 遗留项复核

| round4 条目 | round5 现状 |
|---|---|
| proxy.js lastPicked 死字段 | ✅ 已删除 |
| api.js send(r.ok?200:200) 死三元 | ⚠️ 仍存在（L639→L674 移址未修） |
| instance installing:!res.ok?false:true | ⚠️ 仍存在（L213） |
| maskKey ×2 重复 | ✅ 已收敛（forward-core require base） |
| pluginmarket getJson/getText | ⚠️ 重复仍存 |
| resetCapabilityProbes 导出 | ⚠️ 仍死 |
| task-registry cancel() | ⚠️ 仍无调用（有意保留） |
| 工作区根零字节杂物 | ✅ 已清理（现 0） |

## 8. Rust 壳 / bin / scripts / 仓库级

| # | 条目 | 证据 | 建议 |
|---|---|---|---|
| 1 | src-tauri Rust | env.rs 7 pub fn 全有调用；main.rs 4 command 全注册且被 invoke；RunState 字段全消费 | 干净无死代码 |
| 2 | bin/dsh-supervisor | 14 case 全覆盖、require/模板路径全部存在 | 无死分支 |
| 3 | scripts/release.sh 语法门禁失效 | L39-43 find(换行)+read -d ""(NUL) 不匹配 → 循环 0 次，门禁静默通过 | 改 -print0 |
| 4 | bump.sh 头注释含已废 manifest | L4 提 manifest（D1 已废） | 更新注释 |
| 5 | bin install vs desktop 模板产物不一致（功能） | cmdInstall 只链内核却写 Exec=dsh-supervisor-gui；publish-core 仅含 bin/ → npm 形态 install exit 1 | npm 形态跳过 systemd/desktop 或检测 Exec |
| 6 | 顶层 config.json 死双源 | git 跟踪、拷入 release tar，运行期零读取；含机器绝对路径 | 移除或标 dev-only |
| 7 | 双份 HANDOFF（顶层 vs docs/） | 顶层 08-27 / docs 09-04 | 核对后移除 |
| 8 | src-tauri/gen/schemas 双 schema 字节相同 | tauri 再生成物被提交 | 删出 git |

## 9. 高风险发现（非死代码但建议关注）

**SEA 打包与独立 daemon 动态 spawn 缺口**：build-sea.sh 用 esbuild 打包 bin/dsh-supervisor；supervisor `_daemonLifecycle`(L711) 运行时 path.join 动态拼 router-daemon/lan-daemon.js，esbuild 无法静态跟随 → SEA 形态 daemon 脚本缺失 → `_daemonLifecycle` 返回 null → L3 独立 daemon 在 SEA 发行态静默退化为内嵌模式（有回退不崩溃，但 daemon 特性失效）。cmdDaemon 注释(L205)自述此权衡。

## 10. 清理建议顺序

P0 低风险直接删：supervisor 死方法/字段、api.js 死三元/死常量、infra 死导出、domain 死方法、router 死方法/死字段、skiff 整模块/死函数
P1 需确认后删：servicehost 空壳、cancel()/TASK_STATES 保留口径、ring 接线 or 删、流中断自愈补接线、AlertDialog 备件
P2 功能修复：release.sh 门禁、bin install 产物不一致、SEA daemon 打包缺口
P3 整洁：bump.sh 注释、顶层 config.json、双份 HANDOFF、schema 提交、文档收敛

---
*本报告为只读审计产出，未修改任何文件。删除类建议执行前建议先跑对应测试套件（npm test / vitest）回归。*