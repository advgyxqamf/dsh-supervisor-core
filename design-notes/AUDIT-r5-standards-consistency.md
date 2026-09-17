# AUDIT-r5：规范一致性（题目：规范一致性）

> 审计对象：仓库根级规范文档、README 文档索引、STANDARDS 注册表（`test/standards-uniqueness-test.js`）、
> 各规范声明的机器门禁与 CI 配置（`.github/workflows/build.yml`）。
> 方法：只读 + 静态检查（read / grep / wc / git diff / node --check）。
> 遵守硬约束：未在本机运行任何测试、未启动任何守卫/daemon、未 commit/push、未改 package.json 版本、
> 未加依赖、未触碰 /tmp/dsh-* 与 ~/.dsh。
>
> 注意：审计期间有**并行代理正在修改同一批根级文档**（git status 显示 README / DEVELOPMENT-TRACK /
> DSH-TOKEN-CONTRACT / NATIVE-DSH-TAKEOVER-CONTRACT / RELEASE-STANDARD / release/* 均被改动）。
> 本报告记录**最终工作树状态**，并把"我改的"与"并行代理改的"分开列明，避免重复或冒领。

---

## 一、改动清单（本代理执行，均已落盘）

| 文件 | 位置 | 改动 | 依据 |
|---|---|---|---|
| `DEVELOPMENT-TRACK.md` | §7「为什么只设 precheck 与 test，不设 build 矩阵」 | 删除"build（4 平台）与 release 是条件 job（`if: needs.precheck.outputs.need_build == 'true'`），版本已全部发布时它们根本不运行"的错误陈述；改为：`build` 自 2026-09-14 起每次 push/PR 都跑（仅 `--publish` 受 need_build 门控），只有 `release` 仍是条件 job，required 只设 `precheck`/`test`。 | 见 §四-D1：与 build.yml 136-142、RELEASE-STANDARD §4、ACCEPTANCE-STANDARD §2 直接冲突 |
| `DEVELOPMENT-TRACK.md` | §7「为什么只设 precheck 与 test（重申）」 | 同上，消除同文两处重复的错误论据。 | 同上 |
| `PLATFORM-CAPABILITY-MATRIX.md` | §二 能力矩阵 C11 / C12 / C13 的「实现位置」列 | `platform/os/autostart.js` 改为实际路径 `platform/os/autostart/index.js`（3 处）。 | 实际目录为 `src/platform/os/autostart/`（index.js），文件不存在 |
| `DSH-TOKEN-CONTRACT.md` | §开头、§1 代码注释 | `src/platform/token` 改为 `src/platform/service/token`（2 处）。 | 实际目录为 `src/platform/service/token/`；本改动与并行代理的同向修改一致，最终以工作树为准 |

未改动的文件：其余根级规范仅报告，不做修改（原因见 §四 A/B/F：多为跨 SSOT 的政策裁决项，
或正被并行代理编辑，改动会互相覆盖）。

## 二、删除依据

本代理**未删除任何文件或代码**。任务一的死代码删除不属于本题目（规范一致性），
故无删除依据可列。

## 三、注释/符号统计

根级 Markdown 的符号（对勾/叉/警示/箭头/实心点/制表框线等）分布（`find . -maxdepth 1 -name '*.md'` 扫描）：

- 根级 22 份 .md 共命中 **2083** 个符号字符；重灾区：`CHANGELOG.md` 388、`DIRECTORY-STRUCTURE-DESIGN.md` 354、
  `DOMAIN-STRUCTURE-DESIGN.md` 301、`ARCHITECTURE-CONTRACT-phase0.md` 121、`PLATFORM-CAPABILITY-MATRIX.md` 105、
  `PROVIDER-GATEWAY-ARCHITECTURE.md` 96、`RELEASE-CHANNEL-CONTRACT.md` 90、`CROSS-PLATFORM-BUILD-AND-UPDATE.md` 91、
  `RELEASE-AND-UPDATE-MECHANISM.md` 91、`KERNEL-DAEMON-CONTRACT.md` 89。
- 本轮我编辑的两份文件行数不变（`DEVELOPMENT-TRACK.md` 383 行、`PLATFORM-CAPABILITY-MATRIX.md` 221 行），
  替换文本未引入任何新增符号/emoji。

注意：任务三"注释中严禁表情与符号"针对**注释**；根级规范正文里的符号属于**文档排版**，
不在本代理改动范围（且大范围重排会与并行代理冲突）。建议由 K 组统一裁决"文档正文是否同样清符号"。

## 四、四维发现

### A. 架构设计 / 规范标准：跨规范冲突

**A1（高）"build 是否为条件 job"三处来源互相矛盾（已修 DEVELOPMENT-TRACK，其余待统一）**
- 实际 CI：`.github/workflows/build.yml` 的 `build:` 只有 `needs: precheck`，**无 `if:`**；
  同文件 136-142 注释明确"四平台完整构建在每次 push / PR 都跑，不得被条件跳过"。
- `RELEASE-STANDARD.md` §4：`build` "总是（不受 need_build 门控）"，只有 `release` 是条件 job；由 P-8 机器校验。
- `ACCEPTANCE-STANDARD.md` §2：build job "每次 push/PR 都跑，不得条件跳过"。
- 错误方：`DEVELOPMENT-TRACK.md` §7（两处，已修）。
- 残留：`RELEASE-STANDARD.md` §4 末句"required 只能设每次都会跑的 job。把条件 job（build/release）设为 required
  会让 PR 永久阻塞"——该论据对 **release** 仍成立，对 **build** 已不成立（build 现在每次都跑）。
  建议把该句限定为 release，避免读者据此误判 build 仍条件化。

**A2（高）"本机能否执行 npm test"在 SSOT 与其它规范之间冲突，且 DEVELOPMENT-TRACK 出现自相矛盾**
- SSOT：`ACCEPTANCE-STANDARD.md` §0/§4/§5 明文"所有测试一律不得在本机执行""本机不得产生任何发布产物"，
  允许事项仅 `node --check` 与只读检查。
- 冲突源（仍在本机执行测试）：
  - `DEVELOPMENT-TRACK.md` §2 第 5 步（`npm test`、`bash release/scripts/ci-core.sh`）、
    §5.1（"新增 / 轮换后必须 npm test"）、§5.3 R-1 表（"跑本仓测试（npm test，自带隔离 tmp）"）；
  - `RELEASE-STANDARD.md` §1 阶段表 S4 `npm test` + "本地只做到 S4"；
  - `CREDENTIALS-STANDARD.md` §4 第 4 步"跑门禁：npm test"。
- 并行代理已把 `DEVELOPMENT-TRACK.md` 开头改为"CI 门禁会失败……不在本机执行"，但其 §2/§5.1/§5.3 仍是本机执行
  → **同一文件内部自相矛盾**；并且 `ci-core.sh` 本机运行即会执行 npm test，也违反硬标准。
- 需顶层裁决：要么维持硬标准并清理三份规范的本机测试指引，要么在 ACCEPTANCE-STANDARD 里显式开一个例外。
  本代理未擅自改，因涉及三份 SSOT 的政策方向。

**A3（高）`_uninstallTests` 政策与实际测试链冲突**
- `package.json` 的 `_uninstallTests` 明文："api-contract-test.js、plugin-change-restart-test.js
  禁止进入自动测试链（npm test）"。
- 实际：两者**都在** `scripts.test` 链中（静态核对为真）。
- 同时 `test/test-chain-completeness-test.js` N-a 要求每个 `*-test.js` 必须入链或写入排除表，
  形成"政策说不许入链、门禁说必须入链或排除"的三方冲突；且**没有任何门禁读取 `_uninstallTests`**，
  该政策字段属于无约束文本。
- 建议：确认是"政策过期"（更新字段）还是"测试误入链"（移出链并加入 N-a 排除表）。

### B. 规范标准：README 索引与 STANDARDS 注册表不一致

**B1（高）DOMAIN-STRUCTURE-DESIGN 被 README 标为"唯一事实源"，却未登记进 STANDARDS，门禁对其完全不生效**
- README 第 21 行：`DOMAIN-STRUCTURE-DESIGN.md` 性质列为"规范（唯一事实源）"。
- `test/standards-uniqueness-test.js` 的 `STANDARDS` 表（第 38-49 行）**没有**该文件；已登记 10 份，唯一缺口就是它。
- 规避路径：U-3 只扫描"未登记文档前 80 行是否含字面量 `唯一事实源`"；而该文档用
  "**定版 SSOT**""**唯一权威**"（第 1、3 行）表述，**不含字面量**，于是 U-3 放行。
- 该规范的域内门禁 `test/domain-structure-gate-test.js` 确实存在且在 `scripts.test` 链中，
  可直接登记进 `STANDARDS`（U-1/U-2 均会通过，README 该行已含"唯一事实源"字面量）。
- 本代理未改 `standards-uniqueness-test.js`（判断"登记"还是"下调 README 用词"属保护策略裁决），仅报告。

**B2（中）README 用"规范"泛称，登记表只保护"唯一事实源"**
- README 把 `ARCHITECTURE-CONTRACT-phase0.md`、`KERNEL-DAEMON-CONTRACT.md`、`NATIVE-DSH-TAKEOVER-CONTRACT.md`、
  `PLATFORM-CAPABILITY-MATRIX.md` 都标为"规范（契约/能力矩阵）"，但它们不在 STANDARDS 保护面内。
- 这不违反 U 系列规则（U-3 只针对"唯一事实源"），但 README 的"规范"与注册表的"唯一事实源"两套语义
  容易让读者误以为所有"规范"都受唯一性门禁保护。建议 README 明确区分两类标签。

### C. 规范标准：过期/悬空引用（引用已删文件或改名模块）

| 编号 | 文件 | 引用 | 实际 | 严重度 |
|---|---|---|---|---|
| C1 | `GUARD-DOMAIN-MODEL.md` §2 | `main-process.js` 崩塌收敛发 `restart_triggered` | 文件不存在；已拆为 `src/app/main/process.js`（内含 `restart_triggered` / `_beginRestart`） | 高（正文事实错） |
| C2 | `GUARD-DOMAIN-MODEL.md` §3 G-2 | 登记"平台内部簿记名单"在 `platform/service/log/hub.js` | `hub.js` 无相关代码；实际在 `platform/service/log/sources.js`（`setInternalTypes` / `isInternalEvent`，且注释就写在 sources.js:58） | 中 |
| C3 | `GUARD-DOMAIN-MODEL.md` §5 GD-2 | "`_guardianEvent` 已从 `control-view.js` 删除" | `control-view.js` 文件已不存在（拆为多模块）；门禁自身注释（`guard-domain-model-gate-test.js:199`）已承认 | 中 |
| C4 | `PLATFORM-CAPABILITY-MATRIX.md` §二 C11/C12/C13 | `platform/os/autostart.js` | `platform/os/autostart/index.js` | 已修（本代理） |
| C5 | `PLATFORM-CAPABILITY-MATRIX.md` §二 C5/C6 | `platform/os/pidlookup.js` | `platform/os/pidlookup/index.js` | 已修（并行代理） |
| C6 | `KERNEL-DAEMON-CONTRACT.md` §3 | 历史审计表引 `src/platform/os/autostart.js` | 目录化后为 `.../autostart/index.js` | 低（标注为"修复前状态"的历史记录） |
| C7 | `KERNEL-DAEMON-CONTRACT.md` §3-§4 | 正文称"各有门禁（D-1..D-8）"，但 §4 门禁表只列 D-1..D-5 | 实际门禁 `test/kernel-daemon-contract-test.js` 覆盖 D-1..D-8 | 中（表缺 3 条） |
| C8 | `DIRECTORY-STRUCTURE-DESIGN.md` §3 目标树 | `app/assembly` 列 `fixed-ports / lifecycle-registration`；`app/state` 列 `config-patch / migrate`；`app/native` 列 `binding` | 实际分别无 `fixed-ports`/`lifecycle-registration`；无 `config-patch`/`migrate`；无 `binding`（有 `manifest/npm/ops/policies/probe/upgrade`） | 中（"定版"树与现状漂移；该文档无机器读正文） |

已由并行代理修复、经核对确认的（记录以免重复报告）：
`DSH-TOKEN-CONTRACT.md` 的 `src/platform/token` → `src/platform/service/token`（含 §3 目标结构、TK-4）；
`DEVELOPMENT-TRACK.md` 的 guard→app 分层、`platform/matrix`→`platform/contract/matrix`；
`NATIVE-DSH-TAKEOVER-CONTRACT.md` 的 `domains/dist`→`platform/distribution`；
`README.md` 的 `src/api/surface.js`→`src/api/contract.js`、`src/api/shell.js`→`src/api/domains/shell.js`；
`test/test-chain-completeness-test.js` 的过期计数注释。

### D. 功能设计 / CI 配置：工作流自身的过期注释

**D1（中）`build.yml` precheck 段注释与同文件 build job 事实矛盾**
- 位置：`.github/workflows/build.yml` 第 93-98 行。原文含
  "副作用即「已知边界」：四平台齐备后**构建矩阵不再运行** —— 想在 CI 重跑完整构建，必须存在一个未发布的新版本"。
- 事实：同文件 136-142 已明确 build 无 `if`、每次都跑；`release/README.md` 第 172 行也写
  "`build` 不受 `need_build` 门控"。该段是本地构建时代的残留叙述。
- 影响：注释级，但会误导排障者以为 build 被跳过；且 `ACCEPTANCE-STANDARD.md` §2 引用的 build.yml 行号
  （143-145）指向的是"原条件"说明，读者若只看 precheck 段会得到相反结论。
- 本代理未改工作流（CI 配置改动风险高，交由裁决）。建议把该段改为"need_build 只作用于 `release` 与各平台的 `--publish` 步骤"。

### E. 机器校验门禁是否真空转

**E1（高）STANDARDS 的 U-1 只断言"门禁文件存在"，不断言"门禁真的校验该规范正文"**
- `standards-uniqueness-test.js` U-1（第 57-64 行）仅 `fs.existsSync` 规范与门禁文件；
  没有任何一条断言"该门禁读取/引用规范内容"。
- 后果实例：登记表给 `开发代码规则 → DEVELOPMENT-TRACK.md` 配的门禁 `test/layering-and-dependency-gate-test.js`
  **完全不提 DEVELOPMENT-TRACK**（grep 确认），于是该 SSOT 可以长期漂移到旧分层（guard/、domains/dist），
  门禁仍全绿。本报告 A1/A2 的冲突正是这样积累的。
- 对照：10 份登记规范中，只有 `release-spec-consistency-test.js` 真正把规范正文当数据读（P-1..P-8）；
  其余多数门禁只在头注释里引用规范名，校验的是硬编码不变量。

**E2（中）U-3 的字面量判据可被近义表述规避**
- U-3（第 81-88 行）用 `head.includes('唯一事实源') || head.includes('唯一规范')` 判"未登记文档自称规范"。
- `DOMAIN-STRUCTURE-DESIGN.md` 用"定版 SSOT / 唯一权威"即绕过（见 B1）。
- 建议 U-3 增加 `唯一权威|定版 SSOT|SSOT` 等词表，或改为"README 标为唯一事实源的文档必须在 STANDARDS 中"。

**E3（中）acceptance-standard-gate 的 A-5 覆盖面不足**
- A-5（第 75-97 行）只扫**根级** `.md`，且只匹配 `验收结论|验收通过|已验收|交付完成|验收状态` 加 `CI` 引用。
- 因此 `release/runbooks/publish-and-verify.md` 之类子目录文档、以及"本机 npm test 通过"这类
  **过程性**本机验收叙述都不会被它拦住 —— 与 A2 的冲突同源。

### F. 规范范围重叠（互查结论）

- **F1 发布域四份文档**（RELEASE-STANDARD 流程 / RELEASE-CHANNEL-CONTRACT 选版 /
  RELEASE-AND-UPDATE-MECHANISM 原理 / CROSS-PLATFORM-BUILD-AND-UPDATE 论证）：
  经抽查，RELEASE-AND-UPDATE-MECHANISM 与 CROSS-PLATFORM-BUILD-AND-UPDATE 均已标注"本地生产作废 / 四平台全由 CI"，
  与硬标准一致；RELEASE-STANDARD §"各文档的分工"已划清边界。**未发现实质冲突**（CROSS-PLATFORM 仍保留
  2026-09-11 的本地实证数据，但明确标为历史依据）。
- **F2 结构域三份文档**（DIRECTORY-STRUCTURE-DESIGN 跨层 / DOMAIN-STRUCTURE-DESIGN 域内 /
  EXECUTION-CONTRACT 并行施工冻结书）：README 已声明互补，阈值已统一为"门面 ≤150 / 单文件 ≤400"
  （DIRECTORY §4.5 与 DOMAIN §2 逐字一致，且与 directory-structure-gate 的 DS-9 一致）。
  唯一问题是 DOMAIN-STRUCTURE-DESIGN 状态"执行中、12+ 子代理并行"，EXECUTION-CONTRACT 是施工期接口冻结，
  收口后需复核（见 C8 同类漂移）。
- **F3 验收/测试规则重叠**：ACCEPTANCE-STANDARD 与 DEVELOPMENT-TRACK、RELEASE-STANDARD、CREDENTIALS-STANDARD
  在"何时跑测试"上重叠且冲突（见 A2）。按唯一事实源原则，应以 ACCEPTANCE-STANDARD 为准收敛其余三份。

---

## 五、结论与建议（按优先级）

1. **顶层裁决 A2**（本机测试禁令 vs 三份规范的本机 npm test 指引）——这是唯一会直接导致"违规操作"的冲突：
   开发者按 DEVELOPMENT-TRACK / RELEASE-STANDARD / CREDENTIALS-STANDARD 操作就会在本机跑测试，违反硬标准。
2. **裁决 A1 残留句 + D1 工作流注释**——均把已废除的"build 条件化"当作现行事实。
3. **裁决 A3**（`_uninstallTests` 政策）——三选一：改政策文本、移出链并进排除表、或给政策加门禁。
4. **补登记 B1 + 加严 U-3/E2**——让 DOMAIN-STRUCTURE-DESIGN 真正受唯一性门禁保护；否则它继续无约束漂移。
5. **修 C1/C2/C3/C7/C8 等悬空引用**——C1/C3 是注册 SSOT 的正文事实错；建议在并行文档整理收口后一次性修，
   避免与并行代理冲突。C4/C5 已修。
6. **E1/E3**：把"门禁必须读取其规范"、"验收判据覆盖子目录与过程性叙述"纳入门禁自身的不变量，防止再次出现
   "有门禁=有保护"的假象。

## 六、未决/未覆盖说明

- 未逐字通读 `CHANGELOG.md`、`ARCHITECTURE-PLAN-session-lifecycle.md`、`ARCHITECTURE-CONTRACT-phase0.md`、
  `PROVIDER-GATEWAY-ARCHITECTURE.md`、`EXECUTION-CONTRACT.md` 全文（体量原因）；其路径引用已做后缀解析扫描，
  未发现额外的"当前路径"悬空（历史叙述类不计）。
- 受并行编辑影响，本报告的行号以审计当时的工作树为准；合并时请以**章节标题与引用文本**为准。
- 全程未运行任何测试；未启动任何后台进程。
