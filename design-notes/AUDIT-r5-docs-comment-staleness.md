# AUDIT-r5 文档与注释陈旧信息

> 轮次：全仓审计第五轮。组别：J（对 src/ 注释只报告，可改文档与测试）。
> 主题：文档与注释中的陈旧信息——日期叙事/变更历史、引用不存在的路径与符号、已废止机制未标现状、与实际代码不符。
> 方法：只读静态审计（read / grep / glob / git status / wc）+ node --check；未运行任何测试、未启动任何守卫进程、未触达 /tmp/dsh-* 与状态根。

## 0. 范围与证据

- 主报告：本文件。
- 只读子审计原始清单（可复查每条的原文与证据）：
  - design-notes/_audit-r5-stale-src.md（范围 A：src/ 与 test/ 的 .js 注释，48 条逐条确认）
  - design-notes/_audit-r5-stale-root.md（范围 B：根级 *.md，64 条活动发现 + 9 条已修复复核）
  - design-notes/_audit-r5-stale-release.md（范围 C：release/ 与其它子目录文档，75 条 + 10 条已正确标废）
- 三类范围互斥，合计逐条发现约 187 条（其间有少量重叠：同一事实在文档与测试注释中各出现一次）。
- 未纳入清理：design-notes/*.md（本轮施工过程档案）、CHANGELOG.md（历史记录，门禁 X-2/A-5 已显式排除）。

---

## 1. 本轮改动清单（全部为文本订正，无逻辑改动）

### 1.1 引用失效路径/符号

| # | 文件 | 改动 | 实证 |
|---|---|---|---|
| 1 | README.md | `src/api/shell.js` -> `src/api/domains/shell.js` | find 实测；原路径不存在 |
| 2 | README.md | 权威清单 `src/api/surface.js` -> `src/api/contract.js`（2 处） | src/api/contract.js 头注释「步骤 9 改名」 |
| 3 | README.md | 「完整字段以 surface.js 为准」-> contract.js | 同上 |
| 4 | DEVELOPMENT-TRACK.md | `src/platform/matrix.js` -> `src/platform/contract/matrix.js` | 矩阵门禁唯一合法位置 |
| 5 | DEVELOPMENT-TRACK.md | 示例 `require('../../platform/matrix')` -> `.../contract/matrix` | 同上 |
| 6 | release/runbooks/publish-and-verify.md | `src/api/shell.js` -> `src/api/domains/shell.js` | 同 1 |
| 7 | release/README.md | `src/api/shell.js` -> `src/api/domains/shell.js` | 同 1 |
| 8 | NATIVE-DSH-TAKEOVER-CONTRACT.md | 共享实现 `domains/dist` -> `platform/distribution` | DIRECTORY-STRUCTURE-DESIGN §2.2 |
| 9 | DSH-TOKEN-CONTRACT.md | `src/platform/token/` -> `src/platform/service/token/`（5 处：§0/§1/§3/§5） | token-contract-gate-test KINDS_REL |
| 10 | DSH-TOKEN-CONTRACT.md | 门禁单元名 `src/platform/token` -> `src/platform/service` | layering 门禁 unitOf 取前 3 段 |
| 11 | DSH-TOKEN-CONTRACT.md | §3 目标结构补 exchange.js / infer.js / snapshot.js | find 实测三文件存在 |
| 12 | DSH-TOKEN-CONTRACT.md | TK-G2 -> app/daemons/probe.js、app/main/controller.js；TK-G4 -> app/daemons/runtime.js#_syncLanState | 门禁实际目标 |
| 13 | GUARD-DOMAIN-MODEL.md | `main-process.js` -> `src/app/main/process.js` | src/app/main/process.js:213 有 restart_triggered |
| 14 | GUARD-DOMAIN-MODEL.md | `control-view.js` -> `src/app/daemons/runtime.js` | 文件存在且为现名 |
| 15 | PLATFORM-CAPABILITY-MATRIX.md | `platform/os/pidlookup.js` -> `platform/os/pidlookup/index.js`（C5/C6） | 目录已拆分 |
| 16 | release/README.md | 业务域列举 `guard/` -> `app/` | guard 已并入 app |
| 17 | .github/pull_request_template.md | 变更类型 `src/guard/**` -> `src/app/**` | 同上 |
| 18 | .github/pull_request_template.md | 跨仓契约去掉 `update-guard.json`（全仓仅此一处） | README §0.1 已删该行 |
| 19 | test/layering-and-dependency-gate-test.js | 分层注释补 shared/app、去 guard/dist；跨层示例与 DistributionManager 归属 | 实际 layerOf/CROSS_LAYER |
| 20 | test/shell-safety-net-test.js | R10-a 注释与断言名 `api/shell.js` -> `api/domains/shell.js` | 代码实际读取该路径 |
| 21 | test/domain-structure-gate-test.js | 头注释 DG-2 `≤400` -> `≤300` | 同文件 :579 实测 300 |

### 1.2 与硬标准/代码不符的说明

| # | 文件 | 改动 | 依据 |
|---|---|---|---|
| 22 | DEVELOPMENT-TRACK.md | 分层图更新为 shared/platform/domains/app/api + root；删 guard 层与 dist 域 | DIRECTORY-STRUCTURE-DESIGN §2 |
| 23 | DEVELOPMENT-TRACK.md | 跨层共享三例更新为 shared/ip、platform/service、platform->shared | layering 门禁 CROSS_LAYER |
| 24 | DEVELOPMENT-TRACK.md | 定位层表 `src/guard/**` -> `src/app/**`；装配 -> app/assembly + supervisor 薄壳 | 同上 |
| 25 | DEVELOPMENT-TRACK.md | 「npm test 在本机就会失败」-> 「CI 门禁会失败（测试经 CI 裁决）」 | ACCEPTANCE-STANDARD §0 |
| 26 | DEVELOPMENT-TRACK.md | 步骤 3/5 与凭据步骤的「跑 npm test」改为「由 CI 门禁核对」 | ACCEPTANCE-STANDARD §0 |
| 27 | CREDENTIALS-STANDARD.md | 轮换步骤「跑门禁 npm test」-> 「由 CI 门禁验证」 | ACCEPTANCE-STANDARD §0 |
| 28 | ACCEPTANCE-STANDARD.md | build.yml「文件头第 7 行」-> 第 6 行；「143-145 行」-> 「139-142 行」 | sed 实测 build.yml |
| 29 | README.md | RELEASE-STANDARD 说明「8 阶段」-> 「9 阶段（S0–S8）」 | RELEASE-STANDARD §1 |
| 30 | README.md / DEVELOPMENT-TRACK.md | `DG-1..DG-14` -> `DG-1..DG-16` | 门禁含 DG-15/16 |
| 31 | README.md | 内核发布残句「推荐一键：CI / CI」重写为单一发布路径 | 与现状不符 |
| 32 | RELEASE-AND-UPDATE-MECHANISM.md | 删自相矛盾的「未确认且 attempts>2 -> 回退」半句 | 同文 §5.3 已述该机制整体移除 |
| 33 | RELEASE-AND-UPDATE-MECHANISM.md | 「本文是唯一权威」-> 「原理说明，流程见 RELEASE-STANDARD.md」 | 与根 README 索引一致（且不引入 U-3 违禁词） |
| 34 | release/runbooks/publish-and-verify.md | 内核仓可见性「私有」-> 「公开」 | 2026-09-13 已转公开 |
| 35 | .github/pull_request_template.md | 本机 npm test / ci-core.sh 预演 -> 「验收状态：待 CI 裁决」 | ACCEPTANCE-STANDARD §0 |

### 1.3 日期叙事精简

| # | 文件 | 删除内容 | 保留 |
|---|---|---|---|
| 36 | RELEASE-STANDARD.md | 「2026-09-13 的清理就修掉了 4 处过时声明（旧仓库名、Linux 本地生产、三平台矩阵、待决策）」 | 「副本必然漂移，故本文件确立两件事」 |
| 37 | release/runbooks/publish-and-verify.md | 标题「（2026-09-11 重写）」与「本文件已于 2026-09-11 重写」叙事 | 旧架构（SEA/export-shell）已废止的提醒 |
| 38 | release/README.md | 「内核构建模式（2026-09-13 硬标准改版）」与「本节原为全平台本地构建，整节废弃」 | 「内核构建模式（硬标准）」+ 指向 RELEASE-STANDARD |
| 39 | NO-CONSOLE-WINDOW-STANDARD.md | 无删除；为 §1 诊断清单加「诊断时位置；guard/ 等目录其后已重构」注记 | 保留审计记录 |

净效果：文档 +约 60/-约 55 行；测试注释 3 文件约 12 行文字。改动均不触及门禁保护结构（README 索引、RELEASE-STANDARD 机器块、唯一事实源声明、A-5 CI 指针）。

---

## 2. 精简/删除依据

- 只删过程叙事、不删事实：RELEASE-STANDARD 的清理举例不改变「单源 + 门禁」结论；publish-and-verify 的重写时间线不改变「旧架构已废」结论；release/README 的历史动因段（含非显然 WHY）完整保留。
- 路径改动均有可执行实证（见上表右列）；涉及契约/分层的改动以 DIRECTORY-STRUCTURE-DESIGN SSOT 与对应门禁的实际目标为准。
- 硬标准冲突以 ACCEPTANCE-STANDARD §0 为最高依据（该文件自述「与本文冲突者一律以本文为准」）。

---

## 3. 注释与符号统计

### 3.1 本轮改动量

- 文档 12 份、测试 3 份、.github 模板 1 份；均在文本层。
- src/ 注释：0 处修改（J 组只报告）。

### 3.2 src/ 注释符号统计（任务三口径，供 K 组清理）

| 符号 | 次数 |
|---|---|
| 警告三角 | 168 |
| 星标 | 30 |
| 带圈数字（①-⑤） | 23 / 21 / 11 / 10 / 2 |
| 对勾 | 4 |
| 叉 | 1 / 1 / 1 |
| 亮星 | 1 |
| 右箭头 / 左箭头 | 663 / 15 |
| 制表框线（U+2500-257F） | 11422 |

src/ 共 256 个 .js，约 149 个含箭头、40 余个含警示/星标。集中在 platform/os、platform/distribution、platform/service、app/main、app/ctl。建议替换：警告 -> 「注意」、对勾 -> 「正确」、叉 -> 「错误」、星 -> 「要点」；箭头与框线横幅按需保留分隔语义但改为纯文本。

---

## 4. 四类陈旧信息清单（已修 / 待办）

### 4.1 日期叙事与变更历史

已精简 3 处（见 1.3）。仍建议精简（未强改，避免破坏契约追溯价值）：

- README.md:285-299 卸载类测试现状（2026-08-31 政策、2026-09-12 P1-F、2026-09-13 ab071f5）：保留「仅 native-test 在链外」与「构造期注入、绝不 patch 模块导出」陷阱，删除日期/commit。
- release/README.md:10-14、100-117、257、264、286-301、330、336。
- PLATFORM-CAPABILITY-MATRIX.md:3、12、27、86-96、115、156（生成日期与「本次修复清单」）。
- CROSS-PLATFORM-BUILD-AND-UPDATE.md:4、7-10、82-104、347-350、360。
- ui/FRAMEWORK.md:3、5-9、59、66、71、76。
- RELEASE-AND-UPDATE-MECHANISM.md:4、12-41、52、77、108、226。
- KERNEL-DAEMON-CONTRACT.md:49-51、ARCHITECTURE-CONTRACT-phase0.md 全文 / ARCHITECTURE-PLAN-session-lifecycle.md 全文（可保留但应标「历史快照」）。
- CHANGELOG.md:1400/1409/1418/1430/1450/1466/1474 多个「## [未发布]」遗留占位。
- src/ 约 117 行、test/ 约 230 行含日期或「此前/旧实现/原先/曾」；其中约 120 条属过程性叙述，建议改为「现状 + 动机」。

### 4.2 引用已不存在的文件/路径/符号

已修 21 处（见 1.1）。仍待办（只报告）：

| 位置 | 引用 | 现状 |
|---|---|---|
| NO-CONSOLE-WINDOW-STANDARD.md:27-33 | src/guard/supervisor/main-process.js、src/guard/proc/daemon-lifecycle.js、domains/dist/index.js:522、domains/relay/frpmgr.js:188、guard/native/manager.js | 均已重构（app/、platform/distribution、relay/frp*.js）；已加「诊断时位置」注记，建议后续改现路径 |
| KERNEL-DAEMON-CONTRACT.md:58 | src/platform/os/autostart.js | 现为目录 autostart/；段首已标「修复前状态」 |
| ARCHITECTURE-CONTRACT-phase0.md:11,210-215 | 6 个 guard/supervisor/*-view.js、src/api/lifecycle.js、.shell-work main.rs | 历史计划，路径已失效 |
| ARCHITECTURE-PLAN-session-lifecycle.md:9,256-258,293,336-338 | *-view.js、src/guard/intent.js、src/platform/loghub.js/logcore.js | README 已标「计划（历史）」 |
| EXECUTION-CONTRACT.md:123,127 | src/app/assembly/compose.js:21、src/supervisor.js:100/APP_MODULES | supervisor.js 仅 78 行；APP_MODULES 已移 app/assembly/facets.js:32 |
| DOMAIN-STRUCTURE-DESIGN.md:323 | instance/core.js:190、instance/ops.js:205 | core.js 已拆除，行号失效 |
| INCIDENT-2026-09-13-credential-overwrite.md:106,125 | fakeReal 复制脚本法、release-core.sh | 方法已被 DSH_REAL_HOME 取代；release-core.sh 已删 |
| PLATFORM-CAPABILITY-MATRIX.md:22,71 | AUDIT-CROSS-PLATFORM.md | 文件已不存在 |
| RELEASE-AND-UPDATE-MECHANISM.md:266 | kernelMin / shellMin | src 全仓无实现 |
| PROVIDER-GATEWAY-ARCHITECTURE.md:281 | proxy.js 1006 行 | 现 281 行 |
| test/daemon-lifecycle-test.js:4 | src/infra/proc/daemon-lifecycle.js | 已迁 app/daemons/process.js |
| test/shell-watchdog-e2e-test.js:106 | test/guard-update-test.js | 已删除 |
| test/round13-dropped-result-test.js:9,13 | self-update.js、guard-update-test.js | 均已删除 |
| test/relay-source-gate-test.js:21、reconcile-single-flight-test.js:11 | relay/manager.js | 实为 relay/managed.js |
| test/round13-contract-reload-test.js:15、round8-fixes-test.js:298 | registry-contract.js | 壳仓文件，本仓不存在 |
| src/app/control/entry.js:19,69 | guard/lifecycle/objects.js、main-process.js | 现 app/control/registry.js、app/main/process.js |
| src/app/assembly/compose/core.js:74,151 | guard/intent.js、单文件 token.js | 现 app/state/intents.js、platform/service/token/ |
| src/app/daemons/process-marks.js:23、controller.js:161、src/platform/service/log/sources.js:59、src/platform/os/pidlookup/norm.js:90、src/app/daemons/process.js:185 | supervise-view.js / control-view.js | 已拆除 |

### 4.3 描述已废止机制却未标现状

- 已修：DEVELOPMENT-TRACK 分层图与定位表、NATIVE-DSH-TAKEOVER-CONTRACT 的 domains/dist、DSH-TOKEN-CONTRACT 的令牌位置。
- 仍待办：CROSS-PLATFORM-BUILD-AND-UPDATE.md:314-319/376 仍描述预取/attempts/pinnedVersions/「重装 previous」自动回退（该机制已整体移除）；RELEASE-AND-UPDATE-MECHANISM.md:277-278（内核更新前强制备份 + 本地缓存兜底）仍按旧机制；RELEASE-AND-UPDATE-MECHANISM.md:210 已修。
- 已正确标注、无需处理：README:72-83（SEA）、README:316（旧 manifest/self-update.js）、RELEASE-STANDARD:16-17（release-core.sh、release:core*、publish:core:all）、CROSS-PLATFORM:154（export-shell.sh）、PLATFORM-CAPABILITY-MATRIX:96（guard-update-test.js）、release/README:193（_shell-repo.js）。

### 4.4 与实际代码不符 / 互相矛盾

| 位置 | 矛盾 | 说明 |
|---|---|---|
| DOMAIN-STRUCTURE-DESIGN.md:29 vs :249/:300，EXECUTION-CONTRACT.md:20，DEVELOPMENT-TRACK.md:343，README.md:21，DIRECTORY-STRUCTURE-DESIGN.md:191/193-195/213 | DF-2/DG-2 阈值 300 vs 400 | 门禁 domain-structure-gate-test.js:579 实测执行 300，且其检查名写 ≤300；:29 写 300，其余写 400 并自称「= DF-2」。**待主代理裁决**：若以 300 为准，需改 :249/:300、EXECUTION-CONTRACT:20、DEVELOPMENT-TRACK:343、README:21、DIRECTORY-STRUCTURE-DESIGN:191/193-195/213 并核对 DS-9 与 DF-2 是否确为同一阈值 |
| ACCEPTANCE-STANDARD.md:11 vs DEVELOPMENT-TRACK.md:88/169、CREDENTIALS-STANDARD.md:82 | 「测试不在本机执行」vs「本机 npm test」 | 已按 ACCEPTANCE-STANDARD 修正 DEVELOPMENT-TRACK:88/169 与 CREDENTIALS:82 |
| ARCHITECTURE-ACCEPTANCE.md:16/38/64/95、README.md:23 | 测试链计数 127/126/125 并存 | package.json#scripts.test 实测 126 段；建议统一为 126（属验收记录，未强改） |
| INCIDENT-2026-09-13-credential-overwrite.md:106 vs CREDENTIALS-STANDARD.md:178-180 | fakeReal 法 vs DSH_REAL_HOME 法 | 同一实现两文描述相反；事故复盘为历史快照，建议加「后来改为」注记 |
| PROVIDER-GATEWAY-ARCHITECTURE.md:80,137 | 「预热机制已被整体废除」「现状 6 态」 | 代码已实现 COLD/WARM/HOT/DEAD（router/model.js:27）与预热池；建议标注 Phase 4 已落地 |
| RELEASE-AND-UPDATE-MECHANISM.md:281 vs CROSS-PLATFORM:349 | 壳仓 CI 触发（推 main 也跑 vs 仅 tags） | 两文互斥，需对齐（涉及壳仓现状） |
| CROSS-PLATFORM:345 vs :154 | check-glibc 单源导出 vs export-shell 已删 | 前者应改为「两仓各自维护」 |
| ARCHITECTURE-CONTRACT-phase0.md:52-56 | V1-V5 违规行号 | 机制已修、行号失效；建议精简为语义条款 |

---

## 5. 四维审计发现

### 5.1 架构设计

- 同一事实多份手写：DIRECTORY-STRUCTURE-DESIGN §2 已是分层 SSOT，但 DEVELOPMENT-TRACK §1 自绘一份分层图并漂移（guard/dist）。建议后者改为「指向 SSOT + 只保留改代码判定表」。
- 目录重构后 SSOT 未同步：令牌组件（platform/token -> platform/service/token）、guard -> app、dist 解体、API 契约面改名（surface -> contract）都在多处文档/注释中残留。
- 双阈值并存需要显式区分域：目录门禁 DS-9（≤400）与域门禁 DG-2（≤300）是两套；文档不应声称「逐字一致」却写同一个数。

### 5.2 业务逻辑

- 令牌契约的路径与门禁单元名双双失真（已修文档；src 注释仍有一处，见 4.2）。
- 跨仓对接代码位置（api/domains/shell.js）在 README/release 三处写成旧位置（已修）。
- 平台知识入口（platform/contract/matrix.js）在改代码 SSOT 中写成 platform/matrix.js（已修）。
- 自动回退/预取机制已整体移除，但更新机制与跨平台论证文档仍在描述（待办）。

### 5.3 规范标准

- 最大制度缺口：SSOT 文档里的源码路径/符号没有机器校验。现有门禁只校验少量字符串（RELEASE-STANDARD 的 npm run、README 索引与唯一事实源标记、A-5 的 CI 指针），不校验文档引用的路径是否存在。本轮约 40 处路径失效正源于此。
- 建议新增一道 docs-reference 门禁：对根级与 release 文档抽取形如 src/...、test/...、release/... 的路径与反引号符号，做存在性校验，并配反向样本。可挂在 release-spec-consistency 或 standards-uniqueness 之下。
- DOMAIN-STRUCTURE-DESIGN.md 在 README:21 自称唯一事实源，但 standards-uniqueness 的 STANDARDS 未登记（只登记 DIRECTORY-STRUCTURE-DESIGN）。建议登记（加一条域 -> {file, gate: domain-structure-gate-test.js}）或把 README 标注降级为「设计（SSOT 存档）」。

### 5.4 功能设计

- README 内核发布节残句「推荐一键：CI / CI」是删除本地发布入口后的拼接碎片（已重写）。
- 迁移中状态导致目标结构文件（app/facade.js）尚不存在；文档以目标结构展示合理，但需与现行结构区分。
- pull_request_template 的自检项要求本机跑测试/预演，与硬标准冲突（已改为「待 CI 裁决」）。

---

## 6. 结论

- 本轮确认并修复 35 类问题（21 处失效路径/符号、9 处硬标准/事实性不符、3 处日期叙事），涉及 16 个文件；全部为文本订正。
- 仍待办的高价值项：DF-2/DG-2 阈值矛盾（需主代理裁决）、CROSS-PLATFORM/RELEASE-AND-UPDATE 的废止机制描述、测试计数统一、INCIDENT 方法学更新、src/ 与 test/ 注释中的失效路径（K 组修复）。
- 最大系统性建议：为「文档中的源码引用」补一道机器门禁，从制度上消除本轮这类漂移。
- 验收仍以 CI 为准；本报告不构成验收结论。

## 7. 只读约束遵守

未运行 npm test / 任何测试 / smoke / 门禁脚本；未启动任何守卫或 daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh；未 commit/push；未改 package.json、版本号或依赖。仅对 3 个测试文件做了注释/断言名文字订正，并已 node --check 通过。
