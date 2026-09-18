# 作业单：第二阶段（剩余未做项并行化）

> 由主控代理生成。**所有子代理必读**。本文件是工作指令，不是规范。
> 主控负责提交与推送；子代理只改工作区。

## 0. 硬约束（违反即整批作废）

1. **绝对禁止在本机运行任何测试**：不得 `npm test`、不得 `node test/*.js`、不得跑任何门禁。
   只允许：`node --check`（语法自检）、`grep`、`read`、`wc`、`git status/diff/log`（只读）。
2. **禁止任何 git 写操作**：不得 `git add/commit/push/stash/checkout/restore`。
   主控统一提交推送。工作区改动保留即可。
3. 绝不启动守卫/daemon；不碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
4. 不得给 `package.json` 的 `dependencies` 加包（内核零运行时依赖）。
5. **文件独占**：只改分配给自己的文件；绝不改他人拥有的文件。若需跨界，先报告，不要动手。
6. **新增/修改的 .md 不得出现操作者绝对路径**（`/home/<name>`、`/Users/<name>`、`C:\Users\<name>`）。
   只可用通用占位（`/home/user`、`/home/me`）。X-2 门禁扫描整个工作树的 .md。
7. 不改 `CHANGELOG.md`、`ACCEPTANCE-STANDARD.md`、`.github/workflows/`（除作业单明确授权者）。
8. **不改 `package.json#scripts.test` 的测试链**，除非作业单明确要求；若要求，必须同步更新
   `test/test-chain-completeness-test.js` 的 N-e 判据（Windows cmd.exe 8191 上限，当前链长 7711）。

## 1. 两类"形式钉子"事故（本仓已两次因此 CI 转红，务必规避）

- 事故 A（提交 245585c）：741 处注释符号清除把 `所有者 = **桌面壳**` 改写成散文，
  而 `test/kernel-daemon-contract-test.js` 的 D-8 用硬正则匹配该形态 → CI 红。
- 事故 B（提交 f410a3a）：死代码普查按"仅 read() 内部使用"删掉 `src/platform/contract/runtime.js`
  的 `file` 导出，但 `test/native-dsh-binding-test.js:123` 消费它 → CI 红 `rc.file is not a function`。

由此得出两条铁律：

**R1（注释）**：改写/删除任何注释前，先用 grep 在 `test/` 搜该注释里的特征串（中文短语、标识符、
特殊符号）。**若被任何测试匹配，该注释行原样保留**，并在报告中记为"形式钉子，未动"。
子代理**不得修改 `test/`**（除作业单授权者）。

**R2（死代码）**：删除任何导出/函数/常量前，用 grep 在**全仓**搜该符号：
`src test bin release ui src/**/*.js *.md design-notes .github app`（排除 `node_modules`、`.git`）。
只要 `test/` 或 `bin/` 有消费者就**不得删除**。宁可保留。

## 2. 注释精简的口径（WS1）

删：复述代码的 WHAT（`// 返回 true`、`// 遍历数组`）、变更历史与日期叙事（`// 2026-09-13 修复…`）、
「本轮/之前/原来/曾」过程记录、逐行解释、与代码重复的 JSDoc 参数表。
保留：非显然的 WHY、契约不变量、陷阱与事故教训、跨平台差异、对外 API 契约、安全/权限语义。
手法：**优先整段删除冗余**，不做同义改写；不确定就保留。**绝不改动任何非注释字符**（代码零变化）。
不得写回 emoji/框线/箭头/带圈数字等装饰符号。

## 3. 独占分区（顶层）

| 工作流 | 拥有 | 必须排除（他人拥有） |
|---|---|---|
| WS1-a | `src/platform/**` 全部 .js | 无 |
| WS1-b | `src/domains/**` 全部 .js | `domains/relay/session.js`、`domains/relay/frp-install.js`、`domains/router/providers/probe.js`、`domains/router/providers/quota-strategies.js`、`domains/router/handlers/forward.js` |
| WS1-c | `src/app/**` 全部 .js | `app/assembly/bootstrap.js` |
| WS1-d | `src/api/**` + `src/shared/**` + `bin/**` 的 .js | `api/domains/instances.js` |
| WS2 | N2/N6..N11 的修复：上列 6 个被排除文件 + `app/assembly/bootstrap.js` | 不碰其它 src 文件（需改调用方先报告） |
| WS3 | 根级 `*.md`、`design-notes/*.md`、`test/directory-structure-gate-test.js`、`test/api-contract-test.js` 与 `test/plugin-change-restart-test.js` 的头注、`package.json` 的非 scripts.test 字段 | 不碰 `src/**` |

WS1-a..d 各自**必须再派生 1-3 个下级**，把文件按数量切分（每个子代理 15-25 个文件为宜），
并在自己的报告中列出「文件 → 子代理」的完整分配表。分区必须互斥、无遗漏。

## 4. 各工作流任务

### WS1（注释精简 + 死代码普查，每文件同时做两件事）
- 对该文件内注释按 §2 口径精简。
- 死代码：清明显无消费者的局部变量、恒真/恒假分支、重复实现、被注释掉的代码块。
  **导出与函数按 R2 全仓核验后才可删**。
- 不做结构重构、不改文件名、不移动代码。

### WS2（第三波缺陷，见 `design-notes/_next-wave-N1-N5.md` 与 HANDOFF §3.5）
| 编号 | 缺陷 | 文件 |
|---|---|---|
| N2 | bootstrap 心跳 stall 阈值 `max(30000, iv*12)` 与 `.finally` 无条件清 `_heartbeatBusy`（两拍重叠根因） | `src/app/assembly/bootstrap.js` |
| N6 | `refreshDshSession` 与在途 bootstrap 竞态，旧 cookie 可能覆盖新值 | `src/domains/relay/session.js` |
| N7 | 确认是否仍有箭头注释残留（符号清理未覆盖） | `src/domains/router/providers/probe.js` |
| N8 | 取校验和失败(null)被缓存进生命周期级 `_sumCache` → 一次离线后永久跳过 sha256 | `src/domains/relay/frp-install.js` |
| N9 | `derivedMonthly` 缺 `hasCredits` 守卫 → credits 缺席时月窗口假 100% → 误冻账号 | `src/domains/router/providers/quota-strategies.js` |
| N10 | client-abort 不 destroy 上游 req → keep-alive socket 泄漏 | `src/domains/router/handlers/forward.js` |
| N11 | `instances/add` 原样接受 `command` 数组 → 可经 systemd-run 任意执行 | `src/api/domains/instances.js` |

要求：每项给出最小改动 + 行为变更声明（状态码/返回/日志面）；新增校验优先 fail-closed；
不改公开 API 形态除非缺陷要求。**不得运行测试**，改动后 `node --check`。

### WS3（规范/文档/门禁收敛与悬空引用）
- A2 残留：`EXECUTION-CONTRACT.md` §2/§4、`DOMAIN-STRUCTURE-DESIGN.md` §7 的「实跑/跑相关测试」字样，
  收敛到 ACCEPTANCE-STANDARD 的硬标准（测试一律 CI 裁决）。
- 阈值：`test/directory-structure-gate-test.js` 的 DS-9 实跑值 400 与文档 300 并存 →
  先确认它是否 report-only；若是，改为 300 并同步头注（**改 test/ 需静态自证不红**）。
- 悬空引用：`GUARD-DOMAIN-MODEL.md`（引 `main-process.js`/`control-view.js`）、
  `KERNEL-DAEMON-CONTRACT.md`（D-1..D-8 vs 表列 D-1..D-5）、`DIRECTORY-STRUCTURE-DESIGN.md` §3 目录树。
- 过期头注：`test/plugin-change-restart-test.js`、`test/api-contract-test.js` 声称"已从 npm test 链排除"
  （实际在链中）→ 更正。
- E1/J6：新增 `test/docs-reference-gate-test.js`（校验 SSOT 文档里引用的 `src/...` 路径真实存在），
  并接进 `scripts.test` 链、同步 N-e 判据。**这是唯一被授权改 scripts.test 的任务**。
- DG-7 rank 归类、DG-11 `instances.instances` 穿透复核（只读分析，必要时小修门禁）。

## 5. 交付物（每个子代理）
只写一个报告：`design-notes/_p2-<工作流>-<分片>.md`，含：
改动的文件清单（每个一行理由）、形式钉子保留项、新增/删除的导出（附全仓核验证据）、
`node --check` 结果、CI 风险点。**报告不得含操作者绝对路径。**

## 6. 形式钉子登记表 v1（**已被 §7 更正，勿再依据本表**）

> 主控 v1 把 9 条**代码字符串**误判为注释钉子。§7 是穷尽核查后的正确版本。

判据：测试对**未剥离注释**的源码文本做正则匹配 → 该注释行**原样保留**。
（测试若先 stripComments，或断言的是运行期 error/log 文案，则不属注释钉子——注释精简本就不得改动
任何非注释字符，故不受影响。）

| # | 受保护字样 | 钉住它的测试 | 必须保护的文件 | 归属 |
|---|---|---|---|---|
| 1 | `强制释放防停摆` | heartbeat-selfheal-test.js:61 | `src/app/assembly/bootstrap.js` | WS2 |
| 2 | `[shell-watchdog] 启动异常（不影响守卫主循环）` | round13-robustness-batch-test.js:107 | `src/app/assembly/bootstrap.js` | WS2 |
| 3 | `初始化失败（不影响守卫）` | shell-watchdog-test.js:144 | `src/app/assembly/bootstrap.js` | WS2 |
| 4 | `静默丢弃` 与 `PHASES.includes` | phase-vocabulary-test.js:85 | `src/app/control/entry.js` | WS1-c |
| 5 | `可重试`（uninstall 区段内） | uninstall-timeout-test.js:61 | `src/app/native/ops.js` | WS1-c |
| 6 | `保留 manifest`（uninstall 区段内） | defects-batch-f-test.js:134 | `src/app/native/ops.js` | WS1-c |
| 7 | `守卫服务定义缺失` | autostart-ownership-test.js:57 | `src/platform/os/autostart/darwin.js` | WS1-a |
| 8 | `不再是 SEA` 或 `弃 SEA` | round8-fixes-test.js:73 | `src/platform/contract/deploy.js` | WS1-a |
| 9 | `最小兜底` 或 `兜底`，且 `契约` 或 `壳` | package-root-test.js:65 | `src/platform/service/config.js` | WS1-a |
| 10 | `所有者` 后 12 字内出现 `桌面壳` | kernel-daemon-contract-test.js:109 | `src/platform/os/autostart/**` | WS1-a |
| 11 | `无效的公网端口`、`已被实例「` | round13-router-relay-gaps-test.js:59 | `src/domains/relay/core.js` | WS1-b |
| 12 | `探测失败不阻断创建` | instance-safety-test.js:155 | `src/domains/instance/ops.js` | WS1-b |
| 13 | `服务定义/开机自启/桌面入口由桌面壳负责` | kernel-daemon-contract-test.js:65 | `bin/dsh-supervisor` | WS1-d |
| 14 | `shutdown 超时（8s）` | graceful-shutdown-test.js:77 | `bin/dsh-supervisor` | WS1-d |

**主控补充规则**：&nbsp;若你在自己文件里发现**新的**注释钉子（测试用中文/符号匹配你正要改的注释），
不要擅自改测试，也不要硬改注释——**保留该行并在报告里登记**（格式同上表），由主控统一处理。

## 7. 形式钉子登记表 v2（穷尽核查版，取代 §6）

核查方式：103 个「读源码」的测试逐条归类，并区分目标是否经 stripComments 剥离。

### 7.1 真·注释钉子（5 条，**原样保留**）

| # | 受保护字样 | 钉住它的测试 | 必须保护的注释位置 | 归属 |
|---|---|---|---|---|
| 1 | `最小兜底`（且同文件有 `契约`/`壳`） | `package-root-test.js:65` | `src/platform/service/config.js:85`（全文件仅此一处） | WS1-a |
| 2 | `静默丢弃` | `phase-vocabulary-test.js:85` | `src/app/control/entry.js:18` 与 `:95`（行注释 + 块注释，两处都算） | WS1-c |
| 3 | `不再是 SEA` / `弃 SEA` | `round8-fixes-test.js:73` | `src/platform/contract/deploy.js:4` | WS1-a |
| 4 | `探测失败不阻断创建` | `instance-safety-test.js:155` | `src/domains/instance/ops.js:41`（catch 内块注释） | WS1-b |
| 5 | `所有者` 后 12 字内 `桌面壳` | `kernel-daemon-contract-test.js:109` | `src/platform/os/autostart/win32.js:5`（**唯一满足者**） | WS1-a |

### 7.2 §6 的 9 条误分类（实为**代码字符串**，注释可正常精简）

`强制释放防停摆`、`[shell-watchdog] 启动异常…`、`初始化失败（不影响守卫）`（bootstrap.js 的 logger.warn）、
`可重试`、`保留 manifest`（app/native/ops.js 结果串）、`守卫服务定义缺失`（darwin.js errors.push）、
`无效的公网端口`、`已被实例「`（relay/core.js error 字段，测试已 strip）、
`服务定义/开机自启/桌面入口由桌面壳负责`、`shutdown 超时（8s）`（bin/dsh-supervisor 的 console.log/error）。

→ 归类仍是 **R2**（改代码会红），但**不必**为它们限制注释编辑。若你曾因 §6 保留了无关注释，现在可正常精简。

### 7.3 通用操作规则（取代逐条登记）

删任何注释行前，把该行切成 ≥4 字的 CJK 短语与 ≥6 字符的 ASCII 串，逐 token 在 `test/` grep 一次；
命中即保留该行并登记。**ASCII 短语同样要写（本次穷尽扫描只覆盖中文，ASCII 未系统枚举）。**

### 7.3b 工具陷阱（WS1-a 实测，主控已复现）

`grep -E '[一-龥]{4,}'` 在本机（GNU grep 3.11 / zh_CN.UTF-8）**静默返回空** —— 区间写法不按码点解释，
会给出**假绿的 R1 结果**。必须用 `grep -oP '\p{Han}{4,}'`（Unicode 属性）复算。

主控按正确方法复算的结果：删除的 444 行注释中抽出 508 个 ≥4 字 CJK token，
其中 44 个在 test/ 有命中；逐条判定**全部是测试自身注释、check() 名称或映射标签**，
无一是对源码文本的断言（对 4 个进入断言行的 token 逐行核对：`兜底释放`/`更新日志`/`生命周期`/`状态目录`
的断言目标分别是代码形态、UI TSX、`_startShellWatchdog`、`supervisor['"]|state\.json`，token 只出现在 check 名称里）。
故本批注释删除不构成 R1 违规。

### 7.4 三个易漏点

- **块注释也参与匹配**：`round13-robustness-batch`、`round13-router-relay-gaps`、`heartbeat-selfheal`、
  `shell-safety-net` 的 strip 只滤 `//` 行，`/** */` 仍会被匹配。
- `守卫服务定义缺失` 有**两个**消费者（`autostart-ownership-test.js:57` 与
  `platform-capability-audit-test.js:244`），同一代码字符串。
- 变量中转的字符串钉子（`round13-router-relay-gaps-test.js:55` 的 `gateMsg`）：单行扫描扫不到，登记防误迁。

### 7.5 明确排除

- **`bin/dsh-supervisor` 不做注释精简**（主控裁定）：628 行 / 90 行注释，但含大量被 D-4/D-5/G-e 断言的
  运行期文案，收益低、风险高；且它无 `.js` 扩展名，本就不落在任何 WS1 分片范围。请勿改它。
- 代码形态钉子（WS1-d 登记的 N-1..N-4 等）不在本表：注释精简本就不动非注释字符。


