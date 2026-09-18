## P3 src/app/{daemons,native,self,session,settings}

### 改动清单
| 文件 | 性质 |
| --- | --- |
| src/app/daemons/identity.js | 注释精简 |
| src/app/daemons/probe.js | 注释精简 |
| src/app/daemons/process.js | 注释精简 |
| src/app/daemons/process-marks.js | 注释精简 |
| src/app/daemons/process-wait.js | 注释精简 + 删除导出（portFree） |
| src/app/daemons/runtime.js | 注释精简 |
| src/app/daemons/scripts.js | 注释精简 |
| src/app/daemons/supervise.js | 注释精简 |
| src/app/native/command.js | 注释精简（去对勾/叉号） |
| src/app/native/installer.js | 注释精简 |
| src/app/native/manifest.js | 注释精简 |
| src/app/native/npm.js | 注释精简 |
| src/app/native/ops.js | 注释精简 |
| src/app/native/policies.js | 注释精简 + 删除导出（TERMINAL_STATES） |
| src/app/native/probe.js | 注释精简 |
| src/app/native/upgrade.js | 注释精简 + 删除导出（rollbackNative/handleUpgradeFailure） |
| src/app/self/notify.js | 注释精简（历史依赖说明删除） |
| src/app/session/machine.js | 注释精简 |
| src/app/session/shutdown.js | 注释精简 |
| src/app/settings/access.js | 注释精简 |
| src/app/settings/autostart.js | 注释精简 |
| src/app/settings/domain-config.js | 注释精简 |
| src/app/settings/env.js | 注释精简 + 删除导出（envCatalogSummary） |
| src/app/settings/lan-panel.js | 注释精简（去星号/箭头） |
| src/app/settings/node-lts.js | 注释精简（仅文件头） |
| src/app/settings/token-kinds.js | 注释精简 + 删除导出（KIND_INFERENCE/TOKEN_FILE_NAME） |
| src/app/settings/versions.js | 注释精简 |

未改动（无需改）：src/app/self/health.js、src/app/self/lifecycle.js（无违规符号、注释已简洁、契约信息需保留）。

### 死代码与删除依据
已删除的导出（函数体保留，仍被本文件内部调用）：
- native/policies.js `TERMINAL_STATES` -> 全仓 grep 3 处（定义 / busy() 内部引用 / 导出），test/ 与文档 0 引用 -> 从 module.exports 移除，const 保留（busy 使用）。
- native/upgrade.js `rollbackNative` -> 除本文件外仅 design-notes/EXEC3-native-domain.md 提及（该文档明言"私有编排 … 无外部消费方"）；test/ 0；内部被 rollbackAfterFailedVerify 调用 -> 移除导出，函数保留。
- native/upgrade.js `handleUpgradeFailure` -> 同上，内部被 upgrade 调用 -> 移除导出，函数保留。
- settings/token-kinds.js `KIND_INFERENCE` -> 全仓 3 处全在本文件（定义 / pool.configureKindInference 注入 / 导出），test/ 与文档 0 -> 移除导出，const 保留。
- settings/token-kinds.js `TOKEN_FILE_NAME` -> 同上（定义 / persist.configureTokenFileName / 导出）-> 移除导出。
- settings/env.js `envCatalogSummary` -> 全仓 3 处全在本文件（定义 / envStatus 内调用 / 导出），test/ 0 -> 移除导出，函数保留。
- daemons/process-wait.js `portFree` -> 除本文件外 process.js 命中 4 处均为同名局部变量（await waitPortFree 的返回值），非导入；test/ 与文档 0 -> 移除导出，函数保留（waitPortFree 内部使用）。

保留的误判/不确定项（未删）：
- settings/domain-config.js `defaults`/`aliases`：外部仅经 `extension()` 使用；二者为通用词，存在门禁/文档动态枚举风险 -> 保留并报告，建议后续以门禁确认后再删。
- daemons/scripts.js `DAEMON_REL`：test/directory-structure-gate-test.js 引用 -> 保留。
- daemons 方法中仅 this. 内部调用的 `_lanLockPath`/`_routerDaemonLockPath`/`_daemonEnsureResult`/`_stopMainDsh`/`_stopAllSandboxes`：经 facets.js 装入 host 后以 this. 调用 -> 保留。
- native/upgrade.js `PKG_DEFAULT`（ops.js 使用）、native/npm.js `npmExe`/`npmExeArgs`（ops.js 使用）-> 保留。
- 孤儿文件：无。分区内 .js 均被 facets.js / require 引用。
- 死分支：未发现确定者。`_warnOccupied` 经 collaborators.js THIN_SPEC 暴露为 daemons.warnOccupied，被 main/process.js、main/controller.js 调用 -> 非死代码。

test/ 已确认保留的导出面（改动未触及）：`_routerDaemonActive`/`_lanDaemonActive`/`lanDaemonEnabled`（probe）、`DaemonLifecycle`（process）、`_daemonLifecycle`/`_syncLanState`/`_ensureRouterRuntime`/`_disableRouterPersist`（runtime）、`_daemonSuperviseOnce`（supervise）、`shutdownAll`（session）、`KINDS`（token-kinds）、`guardCorePkg`/`guardSelfUpdateStatus`/`_readBinarySelfVersion`/`guardVersionCheck`（versions）、`NativeManager`、`nativeCommand`。

### 注释统计（注释行数，改前 -> 改后）
| 文件 | 注释行 |
| --- | --- |
| daemons/identity.js | 7 -> 4 |
| daemons/probe.js | 22 -> 12 |
| daemons/process.js | 94 -> 65 |
| daemons/process-marks.js | 33 -> 19 |
| daemons/process-wait.js | 9 -> 4 |
| daemons/runtime.js | 52 -> 36 |
| daemons/scripts.js | 20 -> 10 |
| daemons/supervise.js | 41 -> 34 |
| native/command.js | 14 -> 13 |
| native/installer.js | 20 -> 12 |
| native/manifest.js | 10 -> 10 |
| native/npm.js | 10 -> 10 |
| native/ops.js | 18 -> 18 |
| native/policies.js | 12 -> 12 |
| native/probe.js | 10 -> 10 |
| native/upgrade.js | 12 -> 12 |
| self/notify.js | 10 -> 1 |
| session/machine.js | 15 -> 8 |
| session/shutdown.js | 36 -> 24 |
| settings/access.js | 10 -> 8 |
| settings/autostart.js | 12 -> 6 |
| settings/domain-config.js | 28 -> 13 |
| settings/env.js | 15 -> 10 |
| settings/lan-panel.js | 12 -> 10 |
| settings/node-lts.js | 6 -> 6 |
| settings/token-kinds.js | 34 -> 16 |
| settings/versions.js | 55 -> 40 |
| 合计（含未改文件） | 约 605 -> 约 396 |

任务三：分区内【注释】违规符号清零（⚠ 星号对勾叉箭头带圈数字方块圆点制表框线 emoji 等）。代码字符串/日志文案中的箭头按要求保留（如 upgrade.js 的 `'升级 a 到 b'` 串、lan-panel/access 的 `->` 日志）。装饰性分隔线（═ / ──）整行删除或改纯文本标题。

### 四维发现
架构设计：
- daemons/probe.js 的 `_routerDaemonActive`/`_lanDaemonActive` 与 daemons/process.js 的 `_ctlOwnerPid`/`deriveCmdMarks` 存在重复的 cmdline 匹配实现；历史上正因两处路径不一致出过"认不出 daemon"缺陷（process-marks.js 注释记录的 P0-2）。本轮未合并，建议后续以 process-marks 为唯一真源收敛。

业务逻辑（不确定待裁决，未改）：
1. src/app/native/ops.js:104 `host._recordManifest(target, isFirstInstall ? host._claimDataPaths() : [])`：非首装显式传 `[]`，manifest.record 视其为"显式空认领"并覆盖既有 dataPaths，与 manifest.record 文档"未显式传则继承既有认领、首装认领不因升级丢失"及 upgrade.js 的单参调用（继承）矛盾。后果：重装后 uninstall 不再清理 ~/.dsh 数据路径。建议改为传 undefined/null；因涉及数据删除行为故未擅改。
2. src/app/native/ops.js install()：`host.installing = true` 未置于 try/finally；若 `_runInstall` 抛错（而非返回 ok:false），直接调用 install() 的路径会让 installing 永真、任务卡 running。startInstall 的 .catch 可兜底，直接 API 路径不可。未改。
3. src/app/settings/node-lts.js：`process.versions.node` 为空时 major=0（偶数）-> ltsLine=true 并给出"偶数主版本通常为 LTS"的建议；边界语义不稳。未改。

规范标准：
- 注释与代码不符项已确认并修正：versions.js 的 `[^s]` 正则说明、probe/process 的跨平台分隔符说明、runtime 的 `__dirname` 路径说明，均改写为与现实现一致的契约描述。
- 删除导出后 module.exports 面收窄，均经全仓 grep 确认无消费方；test/、文档、deps 表、字符串形态均已覆盖。

功能设计：
- src/app/daemons/runtime.js 的 lan-state 合成使用 `this.dshMainView ? [this.views.dshMain()] : []`：`dshMainView` 装配后恒为函数，条件恒真；且判断对象（dshMainView）与实际调用对象（views.dshMain）不一致。当前行为正确（main 恒被合成），属恒真条件/可读性问题，未改。
- src/app/settings/versions.js guardVersionLocal()：`let commit = null; commit = ...` 冗余初值赋值（死赋值）。未改（属代码，保守起见）。
- src/app/settings/autostart.js：`this.opts = opts || {}` 赋值后无任何读取，属无用字段。未改（构造期对象形状）。

验证方式：仅 `node --check`（全部改动文件 exit 0）、git show/read 逐行比对代码行（与 HEAD 的代码行序列差异仅为本轮有意的导出删除与两处行内注释改写）、grep 静态引用核查；未运行任何测试/门禁/daemon。
