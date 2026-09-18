# R1 形式钉子登记表（穷尽版 v2）

> 覆盖 `design-notes/_workorder-phase2.md` §1（R1 铁律）与 §6（v1 表，14 条）。
> 方法：只读（grep / read / wc），未运行任何测试或门禁，未改任何其它文件。
> 路径一律相对仓库根。

## 0. 分类判据

「形式钉子」= 测试对**未剥注释的源码文本**做**正向**匹配，且被匹配字样位于**注释**中。
成立需同时满足三条：

1. 测试读的是源码（`src/**` 或 `bin/**`），且**未**对目标做 `stripComments`；
2. 匹配是**正向**的（`!...test()` 这类"断言不存在"不算——删注释只会让它继续通过）；
3. 被匹配字样确实在**注释**里（行注释 `//`、块注释 `/** */`、或 `catch { /* ... */ }`）。

任一不满足即安全，理由见 §3。

## 1. 真·注释钉子（必须原样保留；共 5 条）

| # | 受保护字样 | 钉住它的测试 | 必须保护的源码位置 | 注释类型 | v1 状态 |
|---|---|---|---|---|---|
| 1 | `最小兜底`（且 `契约` 或 `壳`） | `test/package-root-test.js:65` | `src/platform/service/config.js:85` | 行注释 | v1 #9，✔ 成立 |
| 2 | `静默丢弃` | `test/phase-vocabulary-test.js:85` | `src/app/control/entry.js:18` 与 `:95` | :18 行注释；:95 块注释 | v1 #4，✔ 成立（**两处都要留一处**） |
| 3 | `不再是 SEA` 或 `弃 SEA` | `test/round8-fixes-test.js:73` | `src/platform/contract/deploy.js:4` | 行注释 | v1 #8，✔ 成立 |
| 4 | `探测失败不阻断创建` | `test/instance-safety-test.js:155` | `src/domains/instance/ops.js:41` | `catch { /* ... */ }` 块注释 | v1 #12，✔ 成立 |
| 5 | `所有者` 后 12 字内出现 `桌面壳` | `test/kernel-daemon-contract-test.js:109` | `src/platform/os/autostart/win32.js:5` | 行注释 | v1 #10，✔ 成立（v1 未指明文件，**唯一满足者是 win32.js:5**） |

补充：

- #1 的 `契约`/`壳` 在 config.js 另有他处可满足，但 `最小兜底` 全文件**仅 :85 一处** → 该行不可整段删除。
- #2 测试同时要求 `PHASES.includes`，那是**代码**，与注释精简无关；注释侧只需保住一处 `静默丢弃`。
- #5 的相邻约束由 2026-09-17 的提交 `245585c` 放宽为 `/所有者[^\n]{0,12}桌面壳/`，win32.js:5 现为散文式 `所有者都是桌面壳`。若日后再改这行，必须保持两词相邻。

**结论：穷尽扫描后未发现 v1 之外的新注释钉子。** v1 的问题不是漏项，而是把 9 条**代码字符串**误当成注释钉子（见 §2）。

## 2. v1 的 9 条误分类更正（实为代码字符串，注释精简动不到）

这 9 条被匹配字样位于 `logger.warn(...)` / `console.error(...)` / `errors.push(...)` / `throw new Error(...)` / `{ ok:false, error:'...' }` 等**代码字符串**中。作业单 §2 已规定"绝不改动任何非注释字符"，故**注释精简不会使其转红**。
仍建议保留（属 R2 语义：改代码字符串同样会红），但**不必**为它们限制注释编辑。

| v1 # | 受保护字样 | 测试 | 实际形态 |
|---|---|---|---|
| 1 | `强制释放防停摆` | `heartbeat-selfheal-test.js:61` | `bootstrap.js:69` 的 `logger.warn(...)`；测试 :54 另已滤掉 `//` 行 |
| 2 | `[shell-watchdog] 启动异常（不影响守卫主循环）` | `round13-robustness-batch-test.js:107` | `bootstrap.js:150` 的 `logger.warn(...)`；测试 :103 已 `strip()` |
| 3 | `初始化失败（不影响守卫）` | `shell-watchdog-test.js:144` | `bootstrap.js:175` 的 `logger.warn(...)` |
| 5 | `可重试`（uninstall 区段内） | `uninstall-timeout-test.js:61` | `app/native/ops.js:226` 的结果字符串（同区段 `:222` 是 `保留 manifest`） |
| 6 | `保留 manifest` | `defects-batch-f-test.js:134` | `app/native/ops.js:222` 的 `logger.warn(...)` |
| 7 | `守卫服务定义缺失` | `autostart-ownership-test.js:57` | `platform/os/autostart/darwin.js:91` 的 `errors.push(...)` |
| 11 | `无效的公网端口`、`已被实例「` | `round13-router-relay-gaps-test.js:59` | `domains/relay/core.js:167,169` 的 `error:` 字符串；测试 :54 已 `strip()` |
| 13 | `服务定义/开机自启/桌面入口由桌面壳负责` | `kernel-daemon-contract-test.js:65` | `bin/dsh-supervisor:397` 的 `console.log(...)` |
| 14 | `shutdown 超时（8s）` | `graceful-shutdown-test.js:77` | `bin/dsh-supervisor:269` 的 `console.error(...)` |

## 3. 新发现（v1 未收录）

1. **同一代码字符串有第二个消费者**：`守卫服务定义缺失` 还被
   `test/platform-capability-audit-test.js:244` 通过 `macBranch.includes(...)` 消费。
   v1 只登记了 `autostart-ownership-test.js:57`。二者都指向 darwin.js:91 的同一代码字符串。
2. **变量中转的字符串钉子**（v1 的单行正则扫描扫不到）：`test/round13-router-relay-gaps-test.js:55`
   定义 `const gateMsg = '开启公网暴露前请先为该实例设置远程访问令牌';`，:57 用
   `mgrCore.indexOf(gateMsg) >= 0` 匹配。经核验该字样在 `domains/relay/core.js:164` 为**代码字符串**，
   且 `mgrCore` 已 `strip()`（:54）→ **安全**。列出以防后续把 `gateMsg` 误迁到注释。
3. **块注释的残留可见性**：`round13-robustness-batch-test.js`、`round13-router-relay-gaps-test.js`、
   `heartbeat-selfheal-test.js`、`shell-safety-net-test.js` 的 `strip`/`codeOnly` **只滤 `//` 行**，
   块注释 `/** */` 仍参与匹配。当前没有块注释钉子落在这几个测试上，但**新写块注释时仍有此风险**。

## 4. 看似钉子但安全（分类清单，附理由）

| 类别 | 判据 | 代表条目 |
|---|---|---|
| A. 运行期 error/log 文案 | 目标是 `r.error` / `threw` / `log` / CLI stdout，不是源码文本 | `lifecycle-restart-failure-test.js:54,67,96`；`four-platform-behavior-matrix-test.js:84,162`；`platform-matrix-single-source-test.js:72`；`round13-frpc-integrity-test.js:112,131`；`commandcode-quota-test.js:94`；`native-op-mutex-test.js:104`；`plugin-change-restart-test.js:109,118,203,241`；`task-registry-test.js:41,62`；`upstream-credits-test.js:55,120,138,217`；`shell-watchdog-test.js:112,124` |
| B. 目标已 stripComments | provider-gateway-gate / round13-router-relay-gaps / round13-robustness-batch 等 | `provider-gateway-gate-test.js:165`（`code = stripComments(providerSrc)`，:69）——注意 v1 未列，若漏看会误判 |
| C. 目标为文档（非注释） | .md / .sh 的 `#` | `acceptance-standard-gate-test.js:39,40,41,104`（ACCEPTANCE-STANDARD.md）；`standards-uniqueness-test.js:76,90,114`（README + 根级 .md）；`release-channel-test.js:160,161`（RELEASE-CHANNEL-CONTRACT.md）；`release-channel-gate-test.js:193,198`、`all-platforms-test.js:69,73,75,86,106,107`、`release-auth-test.js:192,194`（`release/**` 脚本的 `#` 注释，**不在 WS1 任何分区**） |
| D. 测试自身数据/合成样本 | 构造字符串，不读源码 | `api-surface-test.js:55,70,73,75`（SURFACE 表）；`acceptance-standard-gate-test.js:91,92`；`round13-lifecycle-stop-phase-test.js:76`；`no-cross-repo-test.js:121`；`shell-portability-test.js:85,87`（`String.fromCharCode`）；`directory-structure-gate-test.js:156` |
| E. 负向断言（断言"不存在"） | 删注释只会让它继续通过 | `platform-capability-audit-test.js:186,187`；`ui-gate-wiring-test.js:92`（先滤掉说明行再断言为空）；`shell-safety-net-test.js:85-92,195-201`；`token-contract-gate-test.js` 各"已删除"断言 |
| F. CLI stdout | 子进程输出 | `credential-hygiene-test.js:111,116,128,135,223`；`glibc-gate-test.js:60`；`destructive-op-safety-test.js:142`；`release-auth-test.js:120` |
| G. 其他源码位置但属代码 | 同 §2 | `arch-validation-test.js:52`（`matrix.js:43` 的 `throw`）；`cross-platform-test.js:185`（`guard.js:24` 文案）；`round8-fixes-test.js:212`（`plugin/cli.js:43` 的 `logger.warn`）；`round8-fixes-test.js:206`（`market-net.js:23,60` 的 `Error`）；`shell-watchdog-test.js:42`（`shell/core.js:50` 的 `reason`）；`kernel-update-single-writer-test.js:83`（`bin/dsh-supervisor:487` 的 `console.error`）；`kernel-daemon-contract-test.js:73`（`bin:236` 的 `console.error`） |

## 5. 搜索覆盖矩阵与残余风险

已执行的检索形态（均在 `test/**/*.js` 内）：

| 形态 | 结果 |
|---|---|
| `/…中文…/.test(` 同行 | 77 行，逐条归类（§1–§4） |
| `includes('…中文…')` / `indexOf('…中文…')` | 15 / 1 |
| `match(/…中文…/)` / `matchAll` | 1 / 0 |
| 正则先赋值：`= /…中文…/` | 3（2 条文档、1 条已 stripComments） |
| 字符串常量中转：`const X = '…中文…'` | 4（1 条代码字符串、3 条合成/文档） |
| `replace/split/search/new RegExp` 含中文 | 0 |
| 模板字符串参与匹配 | 0 |
| `.test('…中文…')`（字符串实参） | 0 |
| 跨行正则字面量（3 个探针） | 0（命中均为 Markdown 表格/布尔续行，非正则） |

**残余风险（建议主控用 CI 之外的机械手段补强）**：

1. 本次是**中文导向**的扫描。纯 ASCII 的注释钉子（如注释里写 `shutdown timeout` 之类）未被系统枚举——
   若 WS1 要删的注释行含英文短语，仍建议对该短语单独 grep `test/`。
2. 跨行正则字面量无法用逐行 grep 完全排除；已用"行尾 `|`/`[`"、"行首 `|`/`)`"等探针未发现实例。
3. 结构性根因（HANDOFF §3.4 E1）仍在：门禁读源码却不断言"只在代码上判"。本次只登记，不改任何 `test/`。

## 6. 给 WS1/WS2 的落地建议

- §1 的 5 条：**该注释行原样保留**，报告里记为"形式钉子，未动"。
- §2 的 9 条：注释可正常精简；但**不得**顺手改动其所在的代码字符串（属非注释字符）。
- 新增块注释时，避免与 §1 的受保护字样重复或冲突；不要把 `静默丢弃`/`最小兜底` 等词从注释搬到代码或反向搬。
