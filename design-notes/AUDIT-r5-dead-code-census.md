# AUDIT r5 - 死代码普查（跨全仓，只读清单）

轮次：第五轮（死代码清理 / 注释精简 / 注释符号清理 / 四维审计）
题目：死代码普查（跨全仓，只读出清单）
范围：全仓（src、test、release、bin、ci、app、ui、ui-react），src 只报告不改。
产出性质：可执行删除清单（文件:行号 + 依据 + 置信度），不修改任何 src 文件。

约束遵守：未运行任何测试/门禁/脚本（未执行 npm test / node test/*.js / bash release/scripts/*）；
只做静态读取、grep、wc、git 只读检查与 node -e 纯文本静态扫描（未 require 仓库模块、未执行被测代码）。
未 commit / push；未改 package.json；未加依赖；未启动任何守卫或 daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh。

> 快照警告：普查期间工作树被多个并行代理持续修改（结束时 git status 有 236 条改动）。
> 下列行号为普查时刻值，执行前必须以符号名重新定位，不要按行号盲删。
> 标注「本代理实测」的条目由本代理用全仓 grep 逐条复核；子代理条目已抽检，未逐条复核者标出。

---

## 一、P0 完全死代码（函数/方法全仓零调用，删除本体安全）

| 文件:行号 | 符号 | 依据（唯一引用点） | 置信度 |
| --- | --- | --- | --- |
| src/platform/service/token/kinds.js:63-67 | `getKinds()` | 全仓（含 test/）仅 3 处 = 定义 + 导出(:118) + 注释；无任何调用 | 高（本代理实测） |
| src/platform/service/token/kinds.js:107-110 | `isDshSideKind()` | 仅定义 + 导出(:124) + 注释；pool/capture/persist 实际只用 isCaptured/isPersistent/isUserConfigKind/isKnownKind | 高（本代理实测） |
| src/platform/service/token/persist.js:207-208 | `tokenFileBaseName()` | 仅定义 + 导出(:225) | 高（本代理实测） |
| src/platform/service/token/persist.js:210-214 | `tokenFileName(stateFile)` | 仅定义 + 导出(:223)；唯一外部出现是 token-kinds.js:113 注释 | 高（子代理指出，本代理 grep 复核） |
| src/platform/service/tasks.js:239-241 | `TaskRegistry.cancel(taskId, reason)` | 全仓（含 test/）整词 cancel 仅 1 处 = 定义；无 cancel( 调用点 | 高（本代理实测） |
| src/platform/service/token/follow.js:39-41 | `listenerCount()` | 仅定义；注释自称「仅供自测/诊断」，但无测试引用 | 高（本代理实测） |
| src/platform/os/process.js:11-16 | `isAlive(pid)`（含导出 :45） | 无 processControl.isAlive、无 require(os/process) 解构 isAlive；生产全走 pidlook.isAlive。与 pidlookup/probe.js:89 逐字重复 | 高（本代理实测） |
| src/domains/router/model.js:98 | `stateContainer(opts)`（含导出 :103） | 仅定义 + 导出；注意：设计文档 EXEC-router-switch-instance-daemon.md:17 将其列为「冻结具名导出」，但无门禁枚举 model.js 导出面。删前需裁决（若保留，请在 contract 中注明理由） | 中（本代理实测） |

通用删除依据：以上符号在整仓（排除 node_modules/.git，含 test/ 与 bin/dsh-supervisor 等无扩展名文本）grep 后，
除自身定义/导出/注释外零引用；门禁未以 Object.keys 枚举这些模块的导出面（已核对 token-contract-gate、api-surface、domain-structure-gate 的读取方式）。
删函数本体时须同步删除 module.exports 中的对应键，否则会变成导出 undefined。

---

## 二、P0 死链：写而不读的注入（整链可删，是同一机制）

令牌恢复文件名的注入链整体死亡（本代理实测）：

| 文件:行号 | 符号 | 依据 |
| --- | --- | --- |
| src/platform/service/token/persist.js:199-200 | DEFAULT_TOKEN_FILE_NAME + _tokenFileName | 只服务下面的注入链 |
| src/platform/service/token/persist.js:202-205 | configureTokenFileName(name) | 唯一调用者 app/settings/token-kinds.js:119 |
| src/platform/service/token/persist.js:207-208 | tokenFileBaseName() | 零调用 |
| src/platform/service/token/persist.js:210-214 | tokenFileName(stateFile) | 零调用 |
| src/app/settings/token-kinds.js:113-114 | TOKEN_FILE_NAME = 'dsh-main-token.log' | 只喂给已死的注入 |
| src/app/settings/token-kinds.js:119 | persist.configureTokenFileName(TOKEN_FILE_NAME) | 写入无人读取 |

真正生效的恢复文件名在 src/app/assembly/compose/core.js:152 硬编码（path.join(path.dirname(host.config.stateFile), 'dsh-main-token.log')），
即同一事实两份实现（死副本 + 硬编码）。删除范围跨 platform 与 app 两处，须同批处理；token-contract-gate 未引用这些符号（已核对）。

---

## 三、P1 死兼容外壳 / 过渡层（refactor 残留）

### 3.1 router 域：被移除的 mixin 遗留兼容面（本代理实测）

| 文件:行号 | 片段 | 依据 |
| --- | --- | --- |
| src/domains/router/forward-core.js:38-55 | coreFor(host) | 仅被下方 forwardMethods 调用 |
| src/domains/router/forward-core.js:57-69 | forwardMethods 对象（导出 :71） | 全仓零消费者；index.js 已改用 createForwardCore(index.js:51) 且无 Object.assign（已核对） |
| src/domains/router/router-ops.js:36-52 | coreFor(host) | 仅被下方 auxMethods 调用 |
| src/domains/router/router-ops.js:54-71 | auxMethods 对象（导出 :73） | 全仓零消费者；index.js 已改用 createAuxCore(index.js:56) |
| src/domains/router/instances/proxy-instance.js:1 | 1 行 re-export shim | 文件自述「过渡 shim：final 批删除」；唯一 requirer 是 src/domains/router/index.js:12；改为 require('./model') 后可删文件与空目录 instances/ |

关联同步（删除时必须一起做，否则 CI 变红或语义漂移）：
- router/index.js:12 require('./instances/proxy-instance') 改为 require('./model')。
- test/provider-gateway-gate-test.js PG-3 不读 shim（它读 providers/proxy.js + model.js），无需改；其 :137 注释提到 shim，可顺带更新。
- test/router-test.js:86 已 require model.js（已核对），无需改。
- test/directory-structure-gate-test.js:202 的 DS-G6 白名单含 'instances'；删除目录后该白名单项成冗余（保留无害）。
- forward-core.js 顶层注释 :6-9 与 router-ops.js :5-6、:54 描述的「两条消费路径」需同步精简。

### 3.2 app 协作方死壳（子代理 A，本代理抽检 grep 确认仅赋值/定义行）

以下 host.X = ... 赋值在整仓（含 test/）无任何读取/调用：

- src/app/assembly/collaborators.js:92 host._legacyToEntryPhase
- src/app/assembly/collaborators.js:93 host._entryToLegacyPhase
- src/app/assembly/collaborators.js:96 host._mGuardian
- src/app/assembly/collaborators.js:100 host._dshEntry
- src/app/assembly/collaborators.js:101 host._mainFallbackEntry
- src/app/assembly/collaborators.js:102 host._persistCrashField（唯一他处为 registry.js:116 注释）
- src/app/assembly/collaborators.js:103 host._mStore
- src/app/assembly/collaborators.js:104 host._mField（唯一他处为注释）
- src/app/assembly/collaborators.js:107 host._mProcField
- src/app/assembly/collaborators.js:110 host._dshMainFile
- src/app/assembly/collaborators.js:113 host._readDshMainFile
- src/app/assembly/collaborators.js:121 host._enterUpgradeHold（Async 版 :122 仍在用，保留）
- src/app/assembly/collaborators.js:166 host._managedMainSpec

配套死字段（仅构造期赋 null，零读取）：src/app/assembly/compose/core.js:106-108 _dshMainLive / _fallbackEntry / _lastStateBody。
随壳清理的 state 协作方导出（子代理 A，中置信度）：src/app/state/collaborator.js 的 legacyToEntryPhase/entryToLegacyPhase/readMainMetaFile/fallbackEntry/persistCrashField/enterUpgradeHold。

### 3.3 plugin / relay 死转发（子代理 B，本代理抽检确认零调用）

- src/domains/plugin/index.js:45 _sandboxTarget(inst) — 高
- src/domains/plugin/index.js:65 _readHomePatch(target) — 高
- src/domains/plugin/index.js:66 _writeHomePatch(target, entries) — 高
- src/domains/relay/session.js:122,133 hasCookie()（导出） — 高
- src/domains/plugin/policies.js 的 4 个再导出（isOwnRow/isOwnDisabled/ownerPackage/targetHomePatchPath）零消费者；但整文件不可删（isProtectedName 仍被 ops.js 取） — 中高

---

## 四、P2 未用导出（函数本体内部仍在用，只需收敛 module.exports）

判据：整仓（含 test/、bin/dsh-supervisor）除定义文件外，符号整词仅出现 0 次（或仅出现在注释中）。
风险等级：中（可能是刻意保留的对外面；至少应确认无门禁按 Object.keys 枚举该模块导出）。

核心清单（高价值，本代理实测；行号为声明行）：

| 文件 | 导出符号 | 声明行 | 依据 |
| --- | --- | --- | --- |
| src/platform/service/token/kinds.js | KIND_ORDER, kindOf | 43 / 84 | 仅本文件内部使用 |
| src/platform/service/token/persist.js | stripAnsi, sanitizeTokenLine | 59 / 71 | 仅本文件内部使用 |
| src/platform/service/token/pool.js | CAPTURE_RETRY_MS, BACKFILL_THROTTLE_MS, MAX_PENDING_LINES | 28 / 30 / 32 | 仅本文件内部使用 |
| src/platform/service/token/capture.js | captureFromJournal | 51 | 仅 captureOnce 内部调用 |
| src/platform/service/log/sources.js | normalizeSource, registerSources, getSources, registerInternalType | 11 / 27 / 38 / 49 | 内部调用 + hub 再导出后无消费者 |
| src/platform/service/log/hub.js | tailFile（再导出） | 235 | 全仓零消费者 |
| src/platform/service/ports/core.js | SEGMENT_ANCHOR | 20 | 内部使用 |
| src/platform/service/ports/store.js | normRecord | 10 | 内部使用 |
| src/platform/os/autostart/darwin.js | laFile, macLoaded, macBootstrap, macBootout, xmlEscape, macGuiPlist | 18/25/34/38/53/63 | 内部使用；macSetEnabled 被 test 引用须保留 |
| src/platform/os/autostart/linux.js | GUI_AUTOSTART_TEMPLATE, guiFile | 12 / 24 | 内部使用 |
| src/platform/os/exec-path.js | firstExecutable | 27 | 内部使用 |
| src/platform/os/file-protect.js | currentUser | 26 | 内部使用 |
| src/platform/os/netinfo.js | VIRTUAL_IFACE | 16 | 内部使用 |
| src/platform/os/index.js | ARCH | 19 | 内部使用 |
| src/platform/os/pidlookup/probe.js | linuxListeningInodes | 19 | 内部使用 |
| src/platform/service/install-id.js | ENV_OVERRIDE | 41 | 内部使用 |
| src/api/static.js | MIME, UI_DIR, resolveUiDir, CSP | 42 等 | server.js 只解构 serveStatic |
| src/api/security.js | isLocalOrLanHost, safeKeyEqual | 51 等 | server.js 只取 originAllowed/requestHasAccessKey |
| src/api/domains/instances.js | handleOpen(导出), issueOpenWebCode, consumeOpenWebCode | 54 / 23 等 | 均内部调用；instances.js:205 注释自称「导出供测试」，但 test/ 零引用（注释已过期） |
| src/domains/router/model.js | serializeInstance, deserializeInstance(导出) | 28 / 86 | 被 ProxyInstance.toJSON/fromJSON 内部使用 |
| src/domains/router/config.js | CONFIG_PATH | 30 | 内部使用 |
| src/domains/router/port-segments.js | POOLS | 21 | 内部 registerPools 使用 |
| src/domains/router/providers/model.js | serializeAccount | 35 | 内部使用 |
| src/domains/router/providers/policies/quota.js | CREDIT_KEYWORDS, QUOTA_KEYWORDS, windowFull | 9 等 | 内部使用 |
| src/domains/router/providers/restart.js | IDLE_RECLAIM_GRACE_MS | 等 | 内部使用 |
| src/domains/router/handlers/forward.js | HOP_HEADERS, readUpstreamBody | 19 等 | 内部使用 |
| src/domains/router/ops/browser.js | graphicalEnv | 14 | 内部使用 |
| src/domains/router/ops.js | releaseProviderPorts(导出) | 42 | 内部使用 |
| src/domains/router/scheduler.js | hasImminentReset, hasOverdueReset | 13 等 | 内部使用 |
| src/app/native/policies.js | TERMINAL_STATES | 10 | 内部 busy() 使用 |
| src/app/settings/env.js | envCatalogSummary | 12 | 内部 :38 使用 |
| src/app/assembly/collaborators.js | THIN_SPEC, assertCollaboratorTargets | 17 / 55 | 内部使用（facets 装配） |
| src/app/assembly/facets.js | FACETS | 16 | 内部使用 |
| src/app/assembly/log-sources.js | SOURCES, INTERNAL_TYPES | 等 | 内部使用 |
| src/app/control/heartbeat.js | withTimeout, ADAPTER_TIMEOUT_TICKS | 21 等 | 内部使用 |
| src/app/session/shutdown.js | _stopMainDsh, _stopAllSandboxes(导出) | 104 / 114 | host 方法内部调用 |
| src/app/state/intents.js | has(), any() | 36 / 41 | 方法零调用（host.intents 只用 register/consume/clear） |
| src/domains/instance/sandbox.js | sandboxCommand, defaultCommand(导出) | 19 / 26 | 内部 effectiveCommand 使用 |
| src/domains/instance/upgrade.js | readInstalledVersion, latestDshVersion, _scheduleJobCleanup(返回对象键) | 223 | 无外部消费者 |
| src/domains/relay/port-segments.js | SEGMENTS(导出) | 18 | 唯一 requirer 只作副作用 |
| src/domains/relay/core.js | safeEqual, cookieByName 等 | 35 | 内部使用 |

（子代理 B/C 另报 distribution/index.js:70 fetchGithubLatest、:52 _registryOrigins、darwin.js 6 个、linux.js 2 个等，与本表一致。）
完整机器清单（63 条）可复现：对每个 src 文件用花括号配对解析 module.exports 块，统计符号在整仓的词边界出现次数为 0。

---

## 五、重复实现

真重复（同一事实两份实现）：

1. process.kill(pid, 0) 存活判定三份：src/platform/os/pidlookup/probe.js:89（生产唯一，经 index.js:39 重导出）、
   src/platform/os/process.js:12（死重复，见 P0）、bin/dsh-supervisor:207（内联）。建议删 process.js 版。
2. 令牌恢复文件名两份：src/app/assembly/compose/core.js:152 硬编码 vs persist.tokenFileName（死副本，见第二节）。
3. TaskRegistry 状态到视图映射三份：src/domains/instance/model.js:9 taskStateToView、
   src/domains/plugin/model.js:38 taskStateToJobState、src/domains/router/ops/apps-registry.js:138（第三份）。
   逐字同逻辑。保留性判断：前两份是各域自有的词表映射，属「有意平行」，不建议强合并；建议把第三份也走同一词表或加注释说明。
4. 空闲端口探测 freePort：test/_ports.js:86 导出零导入，而 test/loghub-test.js:33、test/main-port-rederive-test.js:19、
   test/instance-upgrade-test.js:96、test/ports-verify.js:20 各自内联 4 份。建议统一用 _ports.freePort。
5. stripComments 注释剥离器两份：test/exec-bounded-gate-test.js:42 与 test/no-console-window-gate-test.js:37，近乎逐字相同。
6. log/events.js:139/163/186 的 readSince/tailSince/readAll 各含一份近乎相同的 scan 双代 JSONL 合并循环（子代理 C，中）。
7. log/events.js:83 的轮转（原子 rename）vs log/log.js:25 Rotator.write（unlinkSync+renameSync 两步）：
   同一机制两份且安全性不一致（子代理 C，中）。值得收敛。

已排除的伪重复（勿动）：
- src/domains/relay/port-segments.js 与 src/domains/router/port-segments.js 不是两份端口段实现：
  申报集合不相交（relay={relay}；router={proxyInstance,oauthCallback,providerApi 独立池}），
  且 relay 的 anchor:0 有实义（platform/service/ports/core.js 未申报时按同池段序推 1000，非恒等）。
- platform/service/log/hub.js 与 core.js 不是重复：hub 委托 core 的共享读路径（core.js:3 自述「只实现一次」）。
- plugin/policies.js 与 plugin/model.js 不是两份实现：前者是 model 的再导出 shim，谓词体只有一份。
- 全 src 文件级 Jaccard 相似度 >=0.30 仅 1 对（api/domains/dist.js 与 relay.js，12 行共享，系通用 handler 骨架），无大段复制。

---

## 六、残留物

| 位置 | 类别 | 内容 | 处置 |
| --- | --- | --- | --- |
| src/platform/service/log/logcore.js:16 | 死导入 | const { createLogger, Rotator, LineBuffer } = require('./log') 中 LineBuffer 从未使用 | 高置信可删；本代理实测 |
| src/app/assembly/bootstrap.js:26 | 未用 require | const { registerAll } = require('../../app/control/adapters') | 高（本代理实测；真正调用点在 compose/observers.js:45） |
| src/app/session/shutdown.js:6 | 未用 require | 同 registerAll | 高（本代理实测） |
| src/platform/os/index.js:21 | 过期 TODO | TODO(P2)：servicehost/sandbox 的完整 Provider 化 | 报告（设计待办，非可删） |
| app/assembly/（仓根） | 空目录残留 | 0 个文件；文档中的 app/assembly 均指 src/app/assembly | 中；git 不跟踪空目录，可 rmdir |
| test/core-test.js:52、test/main-port-rederive-test.js:18 | 死变量 | sleep 定义后零调用 | 子代理 D，高 |
| test/reconcile-instance-test.js:34-41 | 死函数/空转 | trackProvider/trackSpawn/allProviders（写入后无人读） | 子代理 D，高 |
| test/token-contract-gate-test.js:245、test/provider-gateway-gate-test.js:53,62 | 死函数/变量 | lineIndent；directSrc/idxSrc | 子代理 D，高 |
| test/core-test.js:17 | 未用 import | Rotator | 子代理 D，高 |
| test/freeze-recovery-test.js:24 | 未用 import | keyFingerprint | 子代理 D，高（该文件正被他人修改） |
| test/_ports.js:52 | 无用常量表项 | 'guard-update': 8（无对应测试文件） | 子代理 D，中 |
| package.json:21 | 过期政策文本 | _uninstallTests 禁 api-contract/plugin-change 入链，但二者实际已在 scripts.test 链（各 2 次） | 子代理 D；本代理实测确认冲突。需统一文本或移除成员（不改版本号，仅文本/成员） |
| release/scripts/publish-core.sh:26,54-87,102-107 | 死分支 | ALL=1 块永不可达（--all-platforms 直接 exit 2）；但 test/all-platforms-test.js:99 T2-j 依赖其中 _platforms.sh source 字符串 | 高；须同步改 T2-j 后才可删 |
| release/scripts/ci-core.sh:21,40-41 | 死分支 | ALL_PLATFORMS 恒 0 | 子代理 D，高 |
| release/scripts/verify-versions.js:18 | 废弃分支 | mode === '--all'，无调用传 --all | 子代理 D，高 |
| release/scripts/cred.sh:46,127-151 | 死函数/子命令 | idx()；backup 子命令零调用 | 子代理 D，高/中 |
| release/scripts/publish-core.sh:111 | 死变量 | BIN_NAME | 子代理 D，高 |

未发现：
- src/ 内无 console.log/debugger 调试残留（bin/dsh-supervisor 的 console.log 是 CLI 正常输出）。
- 无大段被注释掉的代码。
- 无恒假条件（if(false)/while(0)）死分支。
- 无 *.bak/*.orig/*.tmp/*~ 临时文件。
- ui-react/ 与 ui/dist 是构建产物（.gitignore，build-ui.sh 生成、static.js 服务、CI/launcher 依赖），不是残留，绝不能删。

---

## 七、孤儿文件判定（本代理 require 图实测）

静态 require 图（解析所有 require('relative') 并把 bin/dsh-supervisor 计入搜索面）显示：
src/ 中「无静态 requirer」的只有 10 个文件，恰好是被任务豁免的入口/契约面，外加 src/api/deps.js：

- src/supervisor.js（bin/dsh-supervisor:252 require；入口）
- src/domains/{relay,router}/daemon.js（独立进程入口）
- src/{api,domains/instance,domains/plugin,domains/relay,domains/router,domains/shell}/contract.js（6 个；门禁以 fs/path.join 读取）
- src/api/deps.js：零静态/动态 require，文件头自述「只声明，不强制，不被 index.js 加载」（R9 裁决：本轮保持只声明）。
  test/api-surface-test.js:30 以 readdirSync 扫描 api/ 顶层（会读到它）、设计文档多处引用为 SSOT。
  裁定：不是可删孤儿（属声明性数据，删除需先关闭 R9）。

无其他孤儿文件；各子代理在 src/app、src/domains/{instance,plugin,relay,shell}、src/platform、test/ 均确认无孤儿。
test/ 中不在 npm test 链的文件全是助手/fixture（_ports、_workflow、_preload、dry-run-proxy、fake-npm、helpers-cleanup、
mock-target、fixtures/*）或被政策豁免的 native-test.js；test/helpers-cleanup.js 曾被误判（它由 p2p-router-test.js:23 以无扩展名 require），实际在用。

---

## 八、四维审计发现

### 架构设计
- R7 facade 写动作下沉已完成，但遗留了两层兼容面：router 的 forwardMethods/auxMethods/coreFor（index.js 已改显式工厂）与
  app/assembly/collaborators.js 的 13 个 host 死壳。这是「迁移完成、兼容层未收尾」的典型残留，建议同批删除。
- 未发现越层依赖或第二份组合实现；assembly 只有一份 composeSystem；facade 全只读（DG-14 盯防）。

### 业务逻辑
- 确认缺陷（应修，非删）：src/app/daemons/probe.js:35 _lanDaemonActive() 引用了未声明的 cmd
  （唯一的 cmd 定义在 _routerDaemonActive() :20）。每次调用抛 ReferenceError 被 catch 吞掉，恒返回 false。
  该函数经 collaborators.js:24 lanActive: '_lanDaemonActive' 装配，被 orphan-scan.js:25、supervise.js:81/83、runtime.js:100 消费
  -> 守卫将永远认不出独立 lan-daemon 在跑（可能重复拉起/漏报残留）。高置信。
- 确认缺陷（语义冗余）：src/app/state/intents.js:36 has() 与 :41 any() 零调用；注释称供「收敛循环决策/守护 gate 判定」，
  但代码无该用法。属「注释声称、代码没有」，与仓库自身警示的失效模式一致。
- 语义死状态：TaskRegistry.cancel 无调用方 -> 'canceled' 状态无法经公开 API 达成（_finish 的 canceled 分支仅作防御）。
- 令牌恢复文件名的注入是写而不读的死链（见第二节），真正生效值是 compose/core.js:152 的硬编码，属行为与文档不符。

### 规范标准
- src/api/deps.js 仍处于 R9「只声明不强制」状态（无运行期校验）；本轮不建议删，但应保持对它的引用说明。
- package.json _uninstallTests 文本与 scripts.test 实际成员冲突（api-contract-test、plugin-change-restart-test 已在链内），
  README 亦有同类旧表述；无门禁读取该字段。属文档/配置不一致。
- test/test-port-discipline-test.js:83 以源码正则 /safePort/ 判定，导致 20 个测试文件必须保留未调用的 safePort import
  （否则 T2 假红）。这是「门禁锚定字面量」的脆弱点，属规范债，本轮只报告。

### 功能设计
- 跨平台：isAlive 的实现三份（probe/process/bin），唯一生产实现是 probe 版；建议统一，避免将来修一处漏两处。
- 死导出面偏多（63 条）：多个模块把内部工具函数一并导出而非导出聚合对象；建议按「默认收敛、按需开放」原则清理，
  但需先确认没有 Object.keys(mod) 型门禁。
- 多平台 autostart：darwin/linux 内部函数被导出但无外部消费者，删除导出即可，函数体须保留。

---

## 九、绝不能删（易误删清单）

- 入口与契约：src/supervisor.js、src/domains/{relay,router}/daemon.js、全部 contract.js（含 api/contract.js、platform/contract/**）；
  src/api/deps.js（R9 声明性 SSOT）。
- 门禁以源码字符串/正则锚定者：token kinds.js 的 KINDS/GHOST_KEYS（TK-G1/G7 枚举与读取）、
  util/exec.js 的 DEFAULT_TIMEOUT_MS（G9-b 防死代码）、20 处未用 safePort import（T2 字面量）、
  publish-core.sh 的 ALL=1 块（T2-j 依赖其中 source 字符串）、darwin.js 的 macSetEnabled（test 引用）。
- 生产唯一实现：pidlookup/probe.js 的 isAlive。
- 有意平行：instance/model 与 plugin/model 的状态映射；router port-segments 与 relay port-segments。
- 构建产物：ui-react/、ui/dist（gitignore 但被服务与发布依赖）。
- hostFirst/装配注入面：bootstrap、api-rebind、session/shutdown、self/notify、facade/status 的导出（经 installHostFirst 绑成 host 方法，不可按未用导出删）。

---

## 十、方法与局限

- 采集方式：require 图（静态 require 解析 + 反向边）；module.exports 花括号配对解析后做整仓词边界计数（含注释）；
  顶层函数/类方法单次出现检测；常量-假条件/return 后语句/大段注释代码正则扫描；文件级 Jaccard 相似度；逐符号 grep 复核。
- 局限：主入口 bin/dsh-supervisor 无 .js 扩展名，首轮扫描曾漏，已补入；动态 require（readdirSync/path.join）不可见于静态图，
  故 api/deps.js 等由目录扫描消费的文件需人工判定；工作树在普查期间被并行修改，行号会漂移；
  「return 后不可达」启发式噪声过大（141 条多为多行 return 的误报），未作为结论，需人工或 AST 复核。
- 未执行项：本机未运行任何测试/门禁，验收由 CI 裁决；本报告仅为删除清单与静态依据，不代表 CI 结论。

### 子代理分工（范围互斥）
- app 全域：f689039a（src/app/**）
- domains instance/plugin/relay/shell：74061d47
- platform + api：d5c54657
- test/ui/ui-react/release/bin/ci/app：b9e5c2a4
- router 兼容层、token 死链、process.js isAlive、tasks.cancel、follow.listenerCount、全仓导出统计：本代理实测
