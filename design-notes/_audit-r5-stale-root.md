# 根级文档「陈旧信息」审计（范围 B：根级 *.md，除 release 与 design-notes）

> 只读审计，未运行任何测试、未启动任何进程、未修改除本报告外的任何文件。
> 快照时间：2026-09-17 ~10:0x（+08）。审计期间父代理正在并发修复 README/DEVELOPMENT-TRACK/DSH-TOKEN-CONTRACT/NATIVE-DSH-TAKEOVER-CONTRACT/RELEASE-STANDARD，已逐条复核并在文末「已修复」区标注，不计入活动计数。
> 行号以写入本报告时的当前文件为准；并发编辑可能使其漂移。

## 发现（格式：相对路径:行号 | 原文摘录 | 类别 | 证据/现状 | 建议）

### 类别 2 —— 引用已不存在的文件/路径/符号
2-1 | NO-CONSOLE-WINDOW-STANDARD.md:27 | 最严重三处：`src/guard/supervisor/main-process.js:46` —— 主 DSH 进程 | 2 | 全仓无 `src/guard/`；主 DSH 进程实为 `src/app/main/process.js` | 更新路径
2-2 | NO-CONSOLE-WINDOW-STANDARD.md:28 | `src/guard/proc/daemon-lifecycle.js:224` —— router/lan daemon | 2 | 无该路径；daemon 监督已重构为 `src/app/daemons/supervise.js` | 更新路径
2-3 | NO-CONSOLE-WINDOW-STANDARD.md:31 | `domains/dist/index.js:522`（npm 安装）、`domains/relay/frpmgr.js:188` | 2 | dist 域已解体→`src/platform/distribution/index.js`；frpmgr 已拆为 `relay/frp.js`+`frp-install.js` | 更新路径
2-4 | NO-CONSOLE-WINDOW-STANDARD.md:32 | `guard/native/manager.js:736`（npm 卸载） | 2 | 无 `src/guard/native/`；native 现为 `src/app/native/*` | 更新路径
2-5 | GUARD-DOMAIN-MODEL.md:45 | `dsh`→`main-process.js` 崩塌收敛发 `restart_triggered` | 2 | 无 `main-process.js`；实为 `src/app/main/process.js` | 更新路径
2-6 | GUARD-DOMAIN-MODEL.md:101 | 且该函数已从 control-view.js 删除 | 2 | `control-view.js` 不存在（步骤 7 后为 `src/app/daemons/runtime.js`） | 更新路径
2-7 | KERNEL-DAEMON-CONTRACT.md:58 | C2 证据 `src/platform/os/autostart.js` 建 watchdog 任务 | 2 | 已拆为目录 `platform/os/autostart/`；段首 :52 已声明"审计记录（修复前状态）" | 精简/更新
2-8 | ARCHITECTURE-PLAN-session-lifecycle.md:9 | 已拆为 6 个 `guard/supervisor/*-view.js` mixin | 2/3 | `*-view.js` 已全部不存在（现 `app/main/*`）；连"失效说明"本身也已失效 | 更新
2-9 | ARCHITECTURE-PLAN-session-lifecycle.md:256,258 | `src/guard/intent.js` / `src/guard/lifecycle/objects.js` | 2 | 无 `src/guard/`；现 `src/app/state/intents.js`、`src/app/control/*` | 更新/删除
2-10 | ARCHITECTURE-PLAN-session-lifecycle.md:336-338 | `src/platform/loghub.js` / `src/platform/logcore.js` | 2 | 已移入 `src/platform/service/log/hub.js`/`logcore.js` | 更新
2-11 | ARCHITECTURE-CONTRACT-phase0.md:11 | supervisor.js 已拆分为 6 个 `*-view.js` mixin | 2/3 | 6 mixin 已再重构消失（见 2-8）；"阅读须知"本身过时 | 更新
2-12 | ARCHITECTURE-CONTRACT-phase0.md:214-215 | 壳删除 spawn 守卫 `.shell-work main.rs:256-262` | 2/3 | 壳已拆到独立仓，本仓无 `.shell-work/` | 更新/删除
2-13 | INCIDENT-2026-09-13-credential-overwrite.md:125 | 其它脚本 `release-core.sh --publish`…尚未过同类审计 | 2/3 | `release-core.sh` 已删除（RELEASE-STANDARD:16 已标注） | 更新
2-14 | DOMAIN-STRUCTURE-DESIGN.md:323 | `instance/core.js:190` 定义、`instance/ops.js:205` | 2 | `instance/core.js` 已在批 3 拆除，不存在 | 更新
2-15 | EXECUTION-CONTRACT.md:123 | `src/app/assembly/compose.js:21` + `src/supervisor.js:100` | 2 | `supervisor.js` 仅 78 行，无第 100 行 | 更新
2-16 | EXECUTION-CONTRACT.md:127 | `src/supervisor.js` 的 APP_MODULES 数组内 | 2 | supervisor.js 无 APP_MODULES；清单已移 `src/app/assembly/facets.js:32` | 更新
2-17 | DIRECTORY-STRUCTURE-DESIGN.md:13 | `src/supervisor.js`（1319 行 / 38 require）… `guard/supervisor/` 6 mixin | 1/2 | §1 为重构前审计基线；guard/、1319 行均已不存在 | 标注"重构前基线"/精简
2-18 | PROVIDER-GATEWAY-ARCHITECTURE.md:281 | P1-1 proxy.js 职责过载（1006 行） | 4 | 现 `providers/proxy.js` = 281 行 | 更新数字

### 类别 3 —— 描述已废止机制却未标注现状
3-1 | DEVELOPMENT-TRACK.md:244 | `build`（4 平台）与 `release` 是条件 job（if need_build==true） | 3/4 | build.yml:136-142 已移除条件，**build 每次 push/PR 都跑**；release 才条件 | 更新（高危）
3-2 | DEVELOPMENT-TRACK.md:289 | build 与 release 是条件 job…（本 PR 即为 skipped） | 3/4 | 同 3-1，build 不再 skipped | 更新
3-3 | ARCHITECTURE-ACCEPTANCE.md:16 | `test`（ubuntu-latest，**127 条**测试链） | 4 | package.json `scripts.test` 现为 **126** 条 | 更新
3-4 | ARCHITECTURE-ACCEPTANCE.md:64 | 测试链条目 — **125** | 4 | 实为 126（与 :16 的 127 亦冲突） | 更新
3-5 | README.md:23 | 全量回归（**125 条**，唯一失败为既存环境项） | 4 | 实为 126；同文档四处 125/126/127 并存 | 更新
3-6 | INCIDENT-2026-09-13-credential-overwrite.md:106 | fakeReal 模拟法：**复制 cred.sh、改写真机常量**为临时路径 | 3/4 | CREDENTIALS-STANDARD.md:178-180 已改为 **DSH_REAL_HOME** 模拟法，明确"不再复制/改写脚本源码"；两文矛盾 | 更新（高危）
3-7 | PROVIDER-GATEWAY-ARCHITECTURE.md:137 | ❌现状：registered/starting/running/unhealthy/stopped/failed（6 态） | 3 | 代码已按设计实现 COLD/WARM/HOT/DEAD（`router/model.js:27`）；"现状"已非现状 | 标注 Phase 4 已落地
3-8 | PROVIDER-GATEWAY-ARCHITECTURE.md:80 | **预热机制已被整体废除** | 3 | `providers/pool.js` 已实现 needSpare/desiredRunningAccounts 等预热策略 | 标注已按 §4.4 恢复
3-9 | GUARD-DOMAIN-MODEL.md:68 | 登记（`platform/service/log/hub.js` 内部簿记名单）同步移除 | 3/4 | `log/sources.js:58` 已删除该名单；正文未同步 | 更新
3-10 | DOMAIN-STRUCTURE-DESIGN.md:14 | router … 最大 **1111 行**（providers/proxy.js） | 1/3 | §1 为重构前基线；proxy.js 现 281 行 | 标注历史/精简
3-11 | KERNEL-DAEMON-CONTRACT.md:49-60 | §3 现状与缺口（C1–C4） | 1/3 | 段首 :51-53 已注明"保留为审计记录（修复前状态）"，可保留 | 精简
3-12 | ARCHITECTURE-PLAN-session-lifecycle.md:206-372 | 阶段 1-4 实施完成记录（npm test 32 文件 618/623/631/638） | 1/3 | 历史计划（README:31 已标"计划（历史）"）；数字为当时快照 | 保留/精简
3-13 | ARCHITECTURE-CONTRACT-phase0.md:52-56 | V1–V5 违规（supervisor.js:1700 / main.rs:256 等） | 1/3 | 行号已失效且机制已修；仅 :7-12 有"行号失效"声明 | 精简为语义条款

### 类别 4 —— 与实际代码不符 / 互相矛盾的重复声明
4-1 | DOMAIN-STRUCTURE-DESIGN.md:29 | DF-2 任何单文件 **≤300 行**（第三轮取严；由 DG-2 校验） | 4 | 门禁 `domain-structure-gate-test.js:579` 确实用 **300**；但同文件 :249 R3、:300 DG-2 仍写 **≤400**，且该测试头注释 :9 也写 400 | 统一为 300 并同步 R3/DG-2
4-2 | DEVELOPMENT-TRACK.md:342 | DF-2 任何单文件 **≤400 行** | 4 | 与 DG-2 实测阈值 300 矛盾 | 统一
4-3 | DEVELOPMENT-TRACK.md:374 | DS-9 已取严为 门面 ≤150 / 单文件 **≤400**，与 DF-1/DF-2 逐字一致 | 4 | 与 :342 引用同一 DF-2，但 DOMAIN-STRUCTURE-DESIGN:29 为 300 | 统一
4-4 | EXECUTION-CONTRACT.md:20 | DF-2 任何单文件 **≤400 行** | 4 | 与 DOMAIN-STRUCTURE-DESIGN §2 DF-2(300) 矛盾 | 统一
4-5 | DIRECTORY-STRUCTURE-DESIGN.md:191,213 | 单文件 **≤400 行**、DS-9 单文件 ≤400 | 4 | 目录门禁确为 400，域门禁为 300 —— 同一仓库两套阈值并存 | 统一或显式说明两域
4-6 | ACCEPTANCE-STANDARD.md:14 | 与 build.yml **文件头第 7 行**同源 | 4 | 硬标准正文在 build.yml **第 6 行**（:7 是"四平台全部由 CI 产出"） | 改为第 6 行
4-7 | ACCEPTANCE-STANDARD.md:19 | 以及同文件 **143-145 行** | 4 | 引文实际在 build.yml **139-142 行** | 改为 139-142
4-8 | CREDENTIALS-STANDARD.md:4 | （`test/credential-hygiene-test.js`，**18 断言**） | 4 | 同文件 :109 明确"断言数以脚本实际输出为准（不在此固化数字）"——自相矛盾 | 删去硬编码数字
4-9 | ACCEPTANCE-STANDARD.md:11 | **所有测试一律不得在本机执行** | 4 | DEVELOPMENT-TRACK.md:88/103/169 与 CREDENTIALS-STANDARD.md:82 仍要求本机 `npm test`——两条 SSOT 直接冲突 | 统一口径
4-10 | DEVELOPMENT-TRACK.md:331, README.md:21 | DG-1..DG-**14** | 4 | 实际门禁含 DG-1..DG-**16**（含 4b/4c/4d/5a/5b/5c）；ARCHITECTURE-ACCEPTANCE:44 的"DG-1..16"才正确 | 更新为 16
4-11 | ARCHITECTURE-ACCEPTANCE.md:38 | 本机回归 **126 条**仅 1 项失败 | 4 | 与 :16（127）、:64/:95（125）、README:23（125）并存，四处不一致；现链 126 | 统一
4-12 | README.md:12 | RELEASE-STANDARD…**8 阶段** | 4 | RELEASE-STANDARD §1 为 S0–S8 共 **9** 个阶段 | 更新
4-13 | README.md:21 | DOMAIN-STRUCTURE-DESIGN「**规范（唯一事实源）**」 | 3/4 | `standards-uniqueness-test.js` 的 STANDARDS 未登记该文件（只登记 DIRECTORY-STRUCTURE-DESIGN 为"目录结构与分层"）；该文件却自称"唯一权威/SSOT" | 登记或修正 README 标注
4-14 | ARCHITECTURE-ACCEPTANCE.md:57-60 | 最大单文件 **298** / `supervisor.js` **79 行** | 4 | 实测 `wc -l`：最大 297（`app/daemons/process.js`）、supervisor.js 78 | 更新
4-15 | DIRECTORY-STRUCTURE-DESIGN.md:100 | `service/token/  ← platform/token/**` | 4 | 若按"现状"读则与 DSH-TOKEN-CONTRACT:63 冲突（后者已改为 service/token）；该箭头是旧→新映射，易误读 | 标注"旧路径"
4-16 | RELEASE-STANDARD.md:31 | `release-core.sh` 内核 7 份文档 | 1/4 | 历史叙事（"曾出现在"），非当前事实；已删"4 处过时声明"句后仍留此表 | 保留或精简

### 类别 1 —— 日期叙事与变更史（建议精简/移除）
1-1 | README.md:35 | 文档可信度不变量（**2026-09-11 确立**） | 1 | 日期标签无信息量 | 精简
1-2 | README.md:72-76 | Node launcher 统一形态（**2026-09 定案**：全平台弃 SEA）… 弃 SEA 原因（铁证） | 1 | 结论有效；大段 SEA 缺陷考据可移入历史 | 精简
1-3 | README.md:83 | 平台生产分工（**2026-09-13 硬标准**）… `release-core.sh` 已删除 | 1 | 结论有效；日期标签可去 | 精简
1-4 | README.md:285-299 | 卸载类测试现状（2026-09-13 起，与 2026-08-31 政策原文已有出入…） | 1 | 大段政策变更史；可压缩为"仅 native-test 在链外" | 精简
1-5 | README.md:311 | 内核更新（单写入者 = 桌面壳；**2026-09-15 A 方案**） | 1 | 日期/方案标签可去 | 精简
1-6 | ACCEPTANCE-STANDARD.md:39-45 | （**2026-09-17 CI 实证**）…8593 字符 → 7711 | 1 | 结论（本机绿红均无证据）已在上文；过程可精简 | 保留结论/精简
1-7 | RELEASE-STANDARD.md:25-38 | 为什么需要这份文件（问题的实质）…**2026-09-13 的清理**… | 1 | 父代理已删一处日期句，余下"曾出现在"表仍属变更史 | 精简
1-8 | RELEASE-STANDARD.md:117,144-147 | （**2026-09-14 修正**）…（**2026-09-14 实测**传播延迟） | 1 | 变更记录 | 精简为规则
1-9 | DEVELOPMENT-TRACK.md:246-257 | 实测结论（**修正我先前的判断**）… | 1 | 个人判断变更史 | 精简为"直推被引擎拒绝，故走 PR"
1-10 | DEVELOPMENT-TRACK.md:323 | §8 域内结构归一化（**2026-09-17 起 · 执行中**） | 1/3 | 状态标签需随完工更新 | 完工后更新
1-11 | ARCHITECTURE-ACCEPTANCE.md:23-34,109-121,125-137 | 取得该结果的过程 / 本轮修复的真实缺陷 / 最根部拆解 | 1 | 变更史与过程记录 | 精简
1-12 | DIRECTORY-STRUCTURE-DESIGN.md:9-23 | §1 为什么要重构（审计实证，1319 行/65 处等） | 1 | 重构前基线 | 标注历史
1-13 | DOMAIN-STRUCTURE-DESIGN.md:8-22 | §1 问题陈述（巨型文件 / this 隐式耦合…） | 1 | 重构前基线 | 标注历史
1-14 | ARCHITECTURE-CONTRACT-phase0.md 全文 / ARCHITECTURE-PLAN-session-lifecycle.md 全文 | 阶段 0 契约 / 根因级计划（已执行） | 1 | 两份均为历史快照；PLAN 已在 README 标"历史"，phase0 未标 | README 标注/精简
1-15 | CHANGELOG.md:1400,1409,1418,1430,1450,1466,1474 | 中段多个 `## [未发布]` | 1 | CHANGELOG 结构问题（历史段遗留占位），非历史内容的当前错误 | 清理占位
1-16 | GUARD-DOMAIN-MODEL.md:4-5 | 解决的问题：此前把两类…塞进同一个"用户意图"抽象 | 1 | 变更前史 | 精简
1-17 | RELEASE-CHANNEL-CONTRACT.md:31-40 | 用户最初提议…经验证不可行（三条硬缺陷） | 1 | 设计论证，有解释价值 | 保留

## 已修复（父代理并发修复，已逐条复核，不计入计数）
F-1 | README.md:89 | `src/api/shell.js` → 现为 `src/api/domains/shell.js` | 2 | 已修复
F-2 | README.md:149,151 | `src/api/surface.js` → 现为 `src/api/contract.js` | 2 | 已修复
F-3 | README.md:317 | 删除重复的"CI（tag 触发）"占位文案 | 1 | 已修复
F-4 | DEVELOPMENT-TRACK.md:25,60,70,134 | `guard/**`→`app/**`、`domains/dist`移除、`platform/matrix.js`→`platform/contract/matrix.js` | 2/3 | 已修复
F-5 | DEVELOPMENT-TRACK.md:4 | "npm test 在本机就会失败"→"按 ACCEPTANCE-STANDARD 测试与验收一律经 CI" | 3/4 | 已修复（但 :88/103/169 仍留本机 npm test，见 4-9）
F-6 | DSH-TOKEN-CONTRACT.md:4,11,63,76,119 | `src/platform/token/`→`src/platform/service/token/` | 2 | 已修复
F-7 | DSH-TOKEN-CONTRACT.md:129,131 | TK-G2/G4 的 `supervise-view.js`/`converge-view.js`/`control-view.js`→`app/daemons/probe.js`/`app/main/controller.js`/`app/daemons/runtime.js` | 2 | 已修复
F-8 | NATIVE-DSH-TAKEOVER-CONTRACT.md:63 | `domains/dist` 安装执行→`platform/distribution` | 2 | 已修复
F-9 | RELEASE-STANDARD.md:36-37 | 删除"2026-09-13 的清理就修掉了 4 处过时声明" | 1 | 已修复

## 受门禁保护（改动前必读，勿删结构）
G-1 | README.md:10-33 | 文档索引表（U-2/U-4 机器校验；登记唯一规范清单） | — | 受门禁保护，勿删
G-2 | RELEASE-STANDARD.md:181-265 | ```json release-pipeline 机器块 + requiredSections（P-1..P-8） | — | 受门禁保护，勿删
G-3 | 各文档首段"唯一事实源"声明 | ACCEPTANCE/RELEASE/CREDENTIALS/DSH-TOKEN/NO-CONSOLE/RELEASE-CHANNEL/GUARD-DOMAIN/PROVIDER-GATEWAY/DIRECTORY 已被 standards-uniqueness STANDARDS 登记 | — | 属 U-1/U-3 保护；未登记的 DOMAIN-STRUCTURE-DESIGN 见 4-13
G-4 | 含"验收结论"的文档 | ARCHITECTURE-ACCEPTANCE.md:10-12、ACCEPTANCE-STANDARD.md 均指向 CI（A-5 满足） | — | 保留 CI 指针

## 计数汇总
| 类别 | 活动发现数 |
|---|---|
| 1 日期叙事/变更史 | 17 |
| 2 引用不存在文件/路径/符号 | 18 |
| 3 描述已废止机制未标注现状 | 13 |
| 4 与代码不符/互相矛盾 | 16 |
| **合计（活动）** | **64** |
| 已修复（父代理，复核通过） | 9 |
| 受门禁保护提示 | 4 |

## 分级
- **高危（错误信息，会导致误操作/误判）18 条**：3-1、3-2、3-3、3-4、3-5、3-6、4-1、4-2、4-3、4-4、4-5、4-6、4-7、4-8、4-9、4-10、4-11、4-13
- **中（过时叙事/失效路径）30 条**：2-1..2-16、3-7..3-11、4-12、4-14、4-15、4-16、1-6、1-9、1-10、1-12、1-13、1-14
- **低（纯风格/日期标签）16 条**：1-1..1-5、1-7、1-8、1-11、1-15、1-16、1-17、2-17、2-18

## Top 10 高危
1. **DF-2 阈值自相矛盾**：DOMAIN-STRUCTURE-DESIGN.md:29 写 ≤300，而 :249 R3 / :300 DG-2、EXECUTION-CONTRACT.md:20、DEVELOPMENT-TRACK.md:342/374、DIRECTORY-STRUCTURE-DESIGN.md:191/213 写 ≤400；门禁 `domain-structure-gate-test.js:579` 实际执行 300（其头注释:9 却写 400）。
2. **DEVELOPMENT-TRACK.md:244/289 称 build 是条件 job**：build.yml:136-142 已移除条件，build 每 push/PR 必跑，仅 release 条件。
3. **ACCEPTANCE-STANDARD.md:11 vs DEVELOPMENT-TRACK.md:88/103/169 + CREDENTIALS-STANDARD.md:82**：一边"所有测试不得在本机执行"，一边要求本机 `npm test`。
4. **INCIDENT:106 的 fakeReal 法已被替换**为 DSH_REAL_HOME 法（CREDENTIALS-STANDARD:178-180），两文对同一实现描述相反。
5. **测试链计数四处不一致**：ARCHITECTURE-ACCEPTANCE 127/126/125、README:23 的 125，实际 126。
6. **NO-CONSOLE-WINDOW-STANDARD §1 三条"最严重"路径全不存在**（src/guard/...），其行号锚点也不再有效。
7. **EXECUTION-CONTRACT:123/127 的并发改动定位失效**：supervisor.js 仅 78 行（无 :100）、无 APP_MODULES（已移 facets.js）。
8. **ACCEPTANCE-STANDARD 引用 build.yml 行号错位**：称"第 7 行"（实为 :6）、"143-145 行"（实为 139-142）。
9. **GUARD-DOMAIN-MODEL 的 main-process.js / control-view.js 均不存在**，门禁描述（GD-2）指向已删文件。
10. **DG 编号过时**：README:21 + DEVELOPMENT-TRACK:331 写 DG-1..14，实际门禁含 DG-1..16。

## 备注：只读约束遵守情况
未运行 npm test / 任何测试 / smoke；未启动任何守卫/daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh；未 commit/push；未改 package.json/版本号/依赖；除本报告外未修改任何文件。
