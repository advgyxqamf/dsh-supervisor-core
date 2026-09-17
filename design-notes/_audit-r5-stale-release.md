# R5 陈旧信息审计 — release/ 与其它子目录文档

> 范围 C：release/README.md、release/runbooks/publish-and-verify.md、ui/FRAMEWORK.md、.github/pull_request_template.md、CROSS-PLATFORM-BUILD-AND-UPDATE.md、RELEASE-AND-UPDATE-MECHANISM.md、PLATFORM-CAPABILITY-MATRIX.md
> 方法：只读静态核对（glob/read/grep/wc/node --check 未运行任何测试，未改任何文件）
> 格式：`相对路径:行号 | 原文摘录(≤80字) | 类别1-4 | 证据/现状 | 建议`

## findings

release/README.md:4 | 「不再重复流程细节（此前同一事实散落 5–8 处 → 已多次漂移）」 | 1 | 元叙事/漂移史 | 精简
release/README.md:7 | 「本目录是 dsh-supervisor 内核发布自动化的唯一事实源」 | 4 | 与根 README 索引（RELEASE-STANDARD.md 为发布/构建流程唯一事实源）冲突；release/ 子目录不受 standards-uniqueness U-3 扫描 | 更新为「入口/索引」，勿自称 SSOT
release/README.md:10-14 | 「（2026-09-11：内核仓由 wasi7mglns 迁至 advgyxqamf…2026-09-13：内核仓转为公开…）」 | 1 | 迁移/转公开日期叙事 | 精简，细节移 CHANGELOG
release/README.md:79 | 「业务域（domains/、guard/、api/ …）」 | 2 | src/guard/ glob=0，已并入 src/app/（DIRECTORY-STRUCTURE-DESIGN §2.1） | 删除 guard/ 或改 app/
release/README.md:89-90 | 「曾散落 5 份（frpmgr.js / dist/index.js / settings-view.js / plugins.js / platform/os/*）」 | 1 | 所列文件均已不存在（历史形态） | 精简
release/README.md:166 | 「产线现状（2026-09-14，硬标准）」 | 1 | 日期叙事 | 精简
release/README.md:179 | 「本地：只允许门禁（S0–S4）与 --dry-run」 | 4 | ACCEPTANCE-STANDARD §0「所有测试一律不得在本机执行」；S4=npm test | 更新（与验收标准冲突）
release/README.md:215 | 「ci-core.sh…单源：CI 的 test job 与四平台 build 矩阵都跑它」 | 4 | build.yml test job 实际直接 build-ui.sh + build:launcher:all + xvfb-run npm test，不调用 ci-core.sh | 更正
release/README.md:240 | 「内核侧…（src/domains/shell/、src/api/shell.js）」 | 2 | src/api/shell.js 不存在，实际 src/api/domains/shell.js | 更新路径
release/README.md:243-258 | 「内核构建模式（2026-09-13 硬标准改版）…历史动因与消解」 | 1 | 日期叙事+消解史 | 精简
release/README.md:252 | 「本地允许做什么 门禁（S0-S4）npm test / verify:versions / build-ui.sh」 | 4 | 与 ACCEPTANCE-STANDARD §0 冲突 | 更新
release/README.md:264 | 「npm dist-tag（2026-09-16 发布通道契约…）」 | 1 | 日期叙事（内容正确） | 精简
release/README.md:276-277 | 「见 RELEASE-STANDARD.md（本地只做 S2–S4，S5 起在 CI）」 | 4 | 与 ACCEPTANCE-STANDARD §0 冲突 | 更新
release/README.md:286-301 | 「平台分工（2026-09 定案…）…✅ 2026-09-13 已执行…⚠ 2026-09-16 更正」 | 1 | 日期/更正叙事 | 精简
release/README.md:298-299 | 「v0.1.5-BETA.2 的 tag run 实证：…全绿」 | 4 | 现状 package.json=0.1.5-BETA.7，旧 run 实证过时 | 删除/精简
release/README.md:327 | 「全量回归：npm test（mock 目标，不触碰真实 DSH/npm）」 | 4 | 与 ACCEPTANCE-STANDARD §0 冲突 | 更新
release/README.md:330 | 「推送通道（固定标准，2026-09-10 定案）」 | 1 | 日期叙事 | 精简
release/README.md:336 | 「凭据与令牌（认证单源，2026-09-10 标准化）」 | 1 | 日期叙事 | 精简

release/runbooks/publish-and-verify.md:1 | 「发布与验收：内核操作指南（2026-09-11 重写）」 | 1 | 日期叙事 | 精简
release/runbooks/publish-and-verify.md:3-4 | 「本文件已于 2026-09-11 重写…export-shell.sh 已删」 | 1 | 重写叙事（SEA/export-shell 已正确标废） | 精简日期，保留已标注结论
release/runbooks/publish-and-verify.md:10 | 「内核 advgyxqamf/dsh-supervisor-core | 🔒 私有」 | 4 | 内核仓已于 2026-09-13 转公开（release/README L12、CROSS L193、RELEASE-AND-UPDATE L52） | 更新为公开
release/runbooks/publish-and-verify.md:14 | 「内核仓只保留对接代码（src/domains/shell/、src/api/shell.js）」 | 2 | src/api/shell.js 不存在（实为 src/api/domains/shell.js） | 更新路径
release/runbooks/publish-and-verify.md:16 | 「内核发布：四平台全由 CI 产出（2026-09-13 硬标准）」 | 1 | 日期叙事 | 精简
release/runbooks/publish-and-verify.md:23-29 | 「为什么一台 Linux 就能产出四平台…额度曾是历史动因」 | 1 | 历史论证 | 精简
release/runbooks/publish-and-verify.md:39-40 | 「# 2) 本地：门禁 + dry-run / npm test / bash release/scripts/ci-core.sh」 | 4 | ACCEPTANCE-STANDARD §0 禁止本机测试；ci-core.sh 含 npm test | 更新
release/runbooks/publish-and-verify.md:96 | 「Node | 多镜像并行测速…最低门槛 v22.12 生效」 | 4 | 内核 engines.node>=18；Node 安装已归壳仓，此门槛在内核 runbook 悬空 | 更新/移出
release/runbooks/publish-and-verify.md:100-117 | 「状态追踪（2026-09-11）…已发布 @…@0.1.4-BETA.1…v0.1.4-BETA.1 的 CI 红叉…2026-09-15」 | 1 | 版本早已至 0.1.5-BETA.7，状态清单过时 | 精简/更新

.github/pull_request_template.md:8 | 「业务逻辑（src/domains/**、src/guard/**、src/api/**）」 | 2 | src/guard/** 不存在（已并入 src/app/） | 改为 src/app/**
.github/pull_request_template.md:10 | 「跨仓契约（registry.json / identity.json / update-guard.json / update-journal.json）」 | 2 | update-guard.json 全仓仅此一处；README §0.1 已删该行，CHANGELOG 记载其被删 | 删除 update-guard.json
.github/pull_request_template.md:22 | 「本机全量通过：npm test 绿」 | 4 | 与 ACCEPTANCE-STANDARD §0 冲突 | 更新为「待 CI 裁决」
.github/pull_request_template.md:23 | 「CI 等价预演通过：bash release/scripts/ci-core.sh 绿」 | 4 | 本机执行 ci-core.sh（含 npm test/构建）违反 §0 | 更新/删除

ui/FRAMEWORK.md:3 | 「历史名 skiff-original 已废弃…2026-09-02…2026-09-06 更名迁入 dsh-supervisor/ui/」 | 1 | 更名/日期叙事 | 精简
ui/FRAMEWORK.md:5,9 | 「（2026-09 Phase 3）/（2026-09 Phase 3b）」 | 1 | 阶段叙事 | 精简
ui/FRAMEWORK.md:13-41 | 「目录结构（全部源文件）」 | 4 | 实际新增未列：framework/ui/{collapsible,radio-group,textarea}.tsx、features/supervisor/{useSupervisorAction.ts,PortPanel.tsx,settings/*.tsx}、services/supervisor/{jobs.ts,kernelUpdateBridge.ts} 及 *.test.ts | 改为「主要文件」或补全
ui/FRAMEWORK.md:21 | 「Radix+CVA 基件（Button/…/Sonner Toaster，barrel index.ts）」 | 4 | 漏 collapsible/radio-group/textarea（ui/src/framework/ui/*） | 补全或改「示例」
ui/FRAMEWORK.md:59 | 「工程治理（2026-09-05 追加）」 | 1 | 日期叙事 | 精简
ui/FRAMEWORK.md:63 | 「各页面独立 chunk（RouterPage~7.5K/LanPage~11K gzip）」 | 4 | 硬编码体积；ui-react 资产已多次重建 | 删除具体数字
ui/FRAMEWORK.md:66 | 「PluginsPage / RouterPage 的 4 处裸 <select> 已迁移」 | 1 | 历史修复叙事 | 精简
ui/FRAMEWORK.md:71 | 「原因（2026-09 定案）：项目 TypeScript 7.0…」 | 1 | 日期叙事 | 精简
ui/FRAMEWORK.md:76 | 「（2026-09-05 commit 3f87482 以 skiff-original/ 纳入；2026-09-06 迁至 dsh-supervisor/ui/）」 | 1 | commit/路径叙事 | 精简

PLATFORM-CAPABILITY-MATRIX.md:3 | 「生成日期：2026-09-11 范围：内核仓 src/platform/os/」 | 1 | 日期叙事 | 精简
PLATFORM-CAPABILITY-MATRIX.md:4,206 | 「配套测试 platform-capability-audit-test.js（42 项断言）」 | 4 | 静态 check() 计数=53（含循环，无法确证）；文档自称的断言数需复核 | 复核或删除数字
PLATFORM-CAPABILITY-MATRIX.md:12,27 | 「奠基提交（8867942, 2026-09-01）…macPlist 逐字节未变（16 行）」 | 1 | commit/行数叙事 | 精简
PLATFORM-CAPABILITY-MATRIX.md:22,71 | 「原 AUDIT-CROSS-PLATFORM.md §五 的矩阵…」 | 2 | AUDIT-CROSS-PLATFORM.md glob=0（已不存在），仅以「原」标注 | 改述或标注文件已删
PLATFORM-CAPABILITY-MATRIX.md:52-53 | 「实现位置 platform/os/pidlookup.js」 | 2 | 实际为 platform/os/pidlookup/index.js（目录） | 更正路径
PLATFORM-CAPABILITY-MATRIX.md:86,115,156 | 「本次修复清单（2026-09-11）/壳自愈：已实现（2026-09-11）/矩阵（2026-09-11 定案）」 | 1 | 日期叙事 | 精简
PLATFORM-CAPABILITY-MATRIX.md:95 | 「悬空路径（src/infra/platform/…）」 | 2 | src/infra glob=0；以「已修」标注 | 保留标注或精简
PLATFORM-CAPABILITY-MATRIX.md:153-154,206-208 | 「shell-watchdog-test.js（36 项）/ e2e（6 项）/ 42/8/39 项」 | 4 | 多项静态计数与文档不符（含循环，无法确证） | 复核后更新数字
PLATFORM-CAPABILITY-MATRIX.md:96 | 「guard-update-test.js …已于 2026-09-15 83228d1 删除」 | 3-已标注 | test/glob=0，已正确标废 | 保留

CROSS-PLATFORM-BUILD-AND-UPDATE.md:4 | 「本文件只讲跨平台方案论证…（此前同一事实散落 5–8 处 → 已多次漂移）」 | 1 | 元叙事 | 精简
CROSS-PLATFORM-BUILD-AND-UPDATE.md:7-10 | 「起因（用户批评，成立）…本文全部结论基于实测与源码证据」 | 1 | 过程叙事 | 精简
CROSS-PLATFORM-BUILD-AND-UPDATE.md:82,88-104 | 「二·补 本地实证（2026-09-11，Rust 工具链就绪后的真实验证）…证据…」 | 1 | 本机构建过程叙事，且与「本地不得构建」硬标准相悖 | 精简（移 CHANGELOG）
CROSS-PLATFORM-BUILD-AND-UPDATE.md:154-156 | 「export-shell.sh 已随双仓隔离删除…各自维护」 | 3-已标注 | 已正确标废 | 保留
CROSS-PLATFORM-BUILD-AND-UPDATE.md:184-186 | 「实测表显示 macos-15-intel 存在…注意：macOS 14 镜像已进入弃用流程，不要用 macos-14」 | 4 | build.yml 实际用 macos-14 出 darwin-x64；acceptance-standard-gate A-3 亦锁定 macos-14 | 更新为「当前仍用 macos-14；切换须同步 A-3」【受门禁保护，勿单删】
CROSS-PLATFORM-BUILD-AND-UPDATE.md:193-195 | 「内核仓…已转为公开…~~原文（已作废）~~」 | 3-已标注 | 已正确标废 | 保留
CROSS-PLATFORM-BUILD-AND-UPDATE.md:277-286 | 「【内核发布】linux : CI（ubuntu-22.04 基座）… mac/win: tag → GitHub Actions」 | 4 | 四平台现由同一 build 矩阵 CI 产出；此段仍按旧「linux CI/mac-win tag」分工表述 | 更正为四平台同一矩阵
CROSS-PLATFORM-BUILD-AND-UPDATE.md:314-319 | 「③…identity.json(attempt 自增)…回退：未确认 且 attempts>2 → 判坏 → pinnedVersions += v → 用缓存重装 previous」 | 3 | attempts/pinnedVersions/预取/重装 previous 均已整体移除（RELEASE-AND-UPDATE §5.3） | 更新为 pending→confirmed，无自动回退
CROSS-PLATFORM-BUILD-AND-UPDATE.md:345 | 「ci/check-glibc.sh 单源导出到壳仓」 | 3 | 与本文 L154 及现状矛盾（export-shell.sh 已删，两仓各自维护） | 更新为「两仓各自维护」
CROSS-PLATFORM-BUILD-AND-UPDATE.md:347-348 | 「F3/F4 ⏸ 暂缓（用户定案 2026-09-11：暂无证书）」 | 1 | 旧决策快照 | 更新/移历史
CROSS-PLATFORM-BUILD-AND-UPDATE.md:349 | 「F5 ✅ 已修：改为仅 tags: ['v*'] + workflow_dispatch」 | 4 | 与 RELEASE-AND-UPDATE L281「推 main 也跑完整矩阵」矛盾 | 两文对齐
CROSS-PLATFORM-BUILD-AND-UPDATE.md:351 | 「F7 | 壳零落盘日志、无版本上报 | P0.1 / P0.2（执行方案）」 | 2 | P0.1/P0.2 在本文件无定义，悬空引用 | 更新/删除
CROSS-PLATFORM-BUILD-AND-UPDATE.md:360 | 「V2 …仍需 CI 实跑一次确认端到端」 | 4 | CI 已多轮全绿，该待确认项过时 | 标记完成/删除
CROSS-PLATFORM-BUILD-AND-UPDATE.md:376 | 「安全网：内核预取 + 备份 + 健康确认 + 有界回退」 | 3 | 与 RELEASE-AND-UPDATE §5.3「无预取、无自动回退」矛盾 | 更新

RELEASE-AND-UPDATE-MECHANISM.md:4 | 「本文件只讲机制原理…（此前同一事实散落 5–8 处 → 已多次漂移）」 | 1 | 元叙事 | 精简
RELEASE-AND-UPDATE-MECHANISM.md:7 | 「本文是唯一权威」 | 4 | 与根 README 索引「RELEASE-STANDARD.md 为发布/构建流程唯一事实源」冲突；standards-uniqueness U-3 扫描根级 .md 前 80 行的「唯一事实源/唯一规范」 | 改为「机制说明」；勿改成「唯一事实源」【受门禁保护】
RELEASE-AND-UPDATE-MECHANISM.md:12-21 | 「决策记录（累计）D1..D6」 | 1 | 决策史 | 精简
RELEASE-AND-UPDATE-MECHANISM.md:23-41 | 「D4 的影响与契合度…你的决定实际上让分发回归了生产现状…已取证」 | 1 | 过程叙事 | 精简
RELEASE-AND-UPDATE-MECHANISM.md:52 | 「（2026-09-13 起转为公开）」 | 1 | 日期叙事（事实正确） | 精简
RELEASE-AND-UPDATE-MECHANISM.md:77 | 「构建与推送（平台分工，2026-09-10 定案）」 | 1 | 日期叙事 | 精简
RELEASE-AND-UPDATE-MECHANISM.md:108,115-118 | 「由 [deb,appimage,…] 改为 […]…实测（2026-09-11）…原 release-core.sh 只 git push --tags 正是踩了这个坑」 | 1 | 历史叙事（release-core.sh 已标废） | 精简
RELEASE-AND-UPDATE-MECHANISM.md:210 | 「内核据此清 journal / 打 .ok；未确认且 attempts>2 → 回退」 | 3 | 与本文 L219/L255「attempts/pinnedVersions/回退已整体移除」自相矛盾 | 删除该半句
RELEASE-AND-UPDATE-MECHANISM.md:226 | 「（单一写入者，2026-09-15 修订）」 | 1 | 日期叙事 | 精简
RELEASE-AND-UPDATE-MECHANISM.md:266 | 「通过元数据声明兼容区间协商（kernelMin / shellMin）」 | 2 | 全仓仅此一处；src/**/*.js 无 kernelMin/shellMin 实现 | 更新/删除
RELEASE-AND-UPDATE-MECHANISM.md:277 | 「K11 | …**更新前强制备份** + 内核缓存」 | 3 | 内核预取/缓存已整体移除；备份归属壳仓 | 更新
RELEASE-AND-UPDATE-MECHANISM.md:278 | 「K13 | …**内核本地缓存**兜底」 | 3 | 内核预取/缓存已整体移除 | 更新
RELEASE-AND-UPDATE-MECHANISM.md:281 | 「K16 | 壳仓 CI 推 main 即四平台完整构建（…push main 也跑完整矩阵）」 | 4 | 与 CROSS L349「改为仅 tags」矛盾 | 两文对齐
RELEASE-AND-UPDATE-MECHANISM.md:289 | 「V1 Tauri 是否为 deb/rpm 自动生成 .sig …需 Rust 环境验证」 | 4 | 可能已解决，但属壳仓无法在本仓验证 | 复核/移出
RELEASE-AND-UPDATE-MECHANISM.md:138,293 | 「pub_date": "2026-09-11T00:00:00Z"」 | 1 | 示例日期 | 低（可保留）

### 已正确标注「已删除/已废除」（无需处理，仅记录）
release/README.md:193-196 | 「test/_shell-repo.js / DSH_SHELL_REPO / 壳仓 checkout 已整体删除」 | 3-已标注 | glob 无 _shell-repo | 保留
release/README.md:218 | 「release-core.sh 已于 2026-09-13 删除」 | 3-已标注 | 文件不存在 | 保留
release/README.md:234 | 「已移除：build:sea / verify:shell」 | 3-已标注 | package.json 无 | 保留
release/README.md:236-241 | 「export-shell.sh…均已迁至壳仓」 | 3-已标注 | 不存在 | 保留
release/runbooks/publish-and-verify.md:103-104 | 「含 export-shell.sh、shell-release/…壳 checkout 已移出」 | 3-已标注 | 不存在 | 保留
PLATFORM-CAPABILITY-MATRIX.md:96 | 「guard-update-test.js 已…删除」 | 3-已标注 | 文件不存在 | 保留
CROSS-PLATFORM-BUILD-AND-UPDATE.md:154-156 | 「export-shell.sh 已随双仓隔离删除」 | 3-已标注 | 保留
CROSS-PLATFORM-BUILD-AND-UPDATE.md:193-195 | 「~~原文（已作废）~~」 | 3-已标注 | 保留
CROSS-PLATFORM-BUILD-AND-UPDATE.md:350 | 「外置 desktop/ 目录已删」 | 3-已标注 | 根无 desktop/ | 保留
RELEASE-AND-UPDATE-MECHANISM.md:219,255 | 「预取/attempts/pinnedVersions 已整体移除」 | 3-已标注 | 保留

### 受门禁保护 / 改动会碰门禁（勿轻动）
- RELEASE-AND-UPDATE-MECHANISM.md:7「唯一权威」：根级 .md，standards-uniqueness-test U-3 扫描前 80 行的「唯一事实源/唯一规范」；改为「唯一事实源」会直接 FAIL。建议改述但不引入该词。
- CROSS-PLATFORM-BUILD-AND-UPDATE.md:186「不要用 macos-14」：acceptance-standard-gate-test A-3 强制 build.yml 含 macos-14（darwin-x64）；按此建议改 CI 会破 A-3。
- CROSS-PLATFORM-BUILD-AND-UPDATE.md:349 与 RELEASE-AND-UPDATE-MECHANISM.md:281 的壳仓 CI 触发描述互斥；改动前确认壳仓现状。
- PLATFORM-CAPABILITY-MATRIX.md 的「14 项 × 3 平台」与根 README 索引一致（C1–C14），目录/索引条目属 U-2/U-4 保护面。

## 计数汇总（按类别）
- 类别1（日期叙事与变更历史）：36 条
- 类别2（引用已不存在的文件/路径/符号）：9 条
- 类别3（描述已废止机制却未标注现状）：6 条
- 类别4（与实际代码不符的说明）：24 条
- 合计：75 条（另 10 条已正确标注「已删除」，无需处理）

## 严重度分级
### 高危（错误信息/违反现行硬标准/悬空引用）— 26 条
release/README.md:7,179,215,240,252,276-277,298-299,327；
release/runbooks/publish-and-verify.md:10,14,39-40,96；
.github/pull_request_template.md:8,10,22,23；
CROSS-PLATFORM-BUILD-AND-UPDATE.md:184-186,314-319,345,376；
RELEASE-AND-UPDATE-MECHANISM.md:7,210,266,277,278,281

### 中（过时叙事/已废止机制/内部矛盾）— 40 条
release/README.md:4,10-14,89-90,166,243-258,264,286-301,330,336；
release/runbooks/publish-and-verify.md:1,3-4,16,23-29,100-117；
ui/FRAMEWORK.md:3,5-9,59,66,71,76；
PLATFORM-CAPABILITY-MATRIX.md:3,12,22,27,52-53,71,86,95,115,156；
CROSS-PLATFORM-BUILD-AND-UPDATE.md:4,7-10,82,88-104,277-286,347-348,349,351,360；
RELEASE-AND-UPDATE-MECHANISM.md:4,12-21,23-41,52,77,108,115-118,226,289

### 低（纯风格/示例日期/硬编码数字）— 9 条
release/README.md:79（以历史叙事方式出现的不存在文件名）；
ui/FRAMEWORK.md:13-41,21,63；
PLATFORM-CAPABILITY-MATRIX.md:4,153-154,206-208,95；
CROSS-PLATFORM-BUILD-AND-UPDATE.md:347-348；
RELEASE-AND-UPDATE-MECHANISM.md:138,293

> 注：PLATFORM-CAPABILITY-MATRIX.md 的断言计数与 CROSS-PLATFORM §9 的 ⏸/待确认项无法在只读、禁跑测试条件下确证，均建议人工复核而非直接采信。
