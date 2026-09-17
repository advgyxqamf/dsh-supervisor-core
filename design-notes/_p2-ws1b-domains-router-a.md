# WS1-b-1 报告：router 内部子目录 + shell 全域（注释精简 + 死代码普查）

> 分片 A / 共 29 个文件。上级作业单：`design-notes/_workorder-phase2.md`；分片分配：`design-notes/_p2-ws1b-allocation.md`。
> 未运行任何测试/门禁，未做任何 git 写操作；仅 `read/grep/glob/git diff --stat/node --check`。

## 1. 结论速览

| 项 | 值 |
|---|---|
| 分配文件数 | 29 |
| 改动文件数 | 14 |
| 形式钉子保留项 | 5 |
| 删除的导出 | 0（2 个零消费者导出候选经核验后按 R2「宁可保留」保留） |
| 非注释字符改动 | 0（`git diff` 逐行断言：14 文件全部改动行均为注释行/注释子句） |
| `node --check` | 29/29 通过，退出码 0 |

## 2. 改动文件清单（每个一行理由）

| 文件 | 理由（§2 口径） |
|---|---|
| `src/domains/router/model/inflight.js` | 删 `begin()` 的纯 WHAT JSDoc「真实转发开始 +1。」 |
| `src/domains/router/ops/browser.js` | 删悬空引用「防风控/防关联策略与已知边界见原注释；」 |
| `src/domains/router/policies/failure.js` | 删变更史「（原 switch.js:87-112 的判定部分下沉）」 |
| `src/domains/router/policies/switch.js` | 删变更史「（原 switch.js:31-79 的纯判定下沉）」 |
| `src/domains/router/providers/instance-lifecycle.js` | 删与 `module.exports` 重复的「覆盖：停止仲裁/停止补刀、健康等待、可用性判定、加账号」清单 |
| `src/domains/router/providers/model.js` | 删与导出面重复的「覆盖 keyFingerprint/maskKey、序列化与供应商预设常量」清单 |
| `src/domains/router/providers/pkg-cache.js` | 删变更史「从 probe.js 抽出；」 |
| `src/domains/router/providers/policies/freeze.js` | 删与 `module.exports` 逐字重复的函数清单（freezeLimited/... 共 10 名） |
| `src/domains/router/providers/pool.js` | 删与导出面重复的「覆盖 HOT/WARM 上限、常驻账号、备胎、期望运行集」清单 |
| `src/domains/router/providers/restart.js` | 删变更史「从 proxy.js 抽出：」；保留其后「被源码门禁钉住」警示 |
| `src/domains/router/providers/store.js` | 删与构造器签名重复的 `@param opts { persist?/canPersist?/logger? }` 参数表 |
| `src/domains/shell/journal.js` | 删变更史「回退功能已整体移除…」行、删「护栏/回退字段已废除」子句、合并多余空行 |
| `src/domains/shell/restart.js` | 删与文件头第 14 行重复的行内注释「版本比较：复用内核同一份 semverCompare…」 |
| `src/domains/shell/watchdog.js` | 删过程记录「P2：相位时效跟踪（由 tick 维护…）」 |

未改动的 15 个文件：`handlers/parse.js`、`instances/proxy-instance.js`、`ops/admin.js`、`ops/apps-registry.js`、`ops/oauth.js`、`ops/quotasync.js`、`providers/base.js`、`providers/command.js`、`providers/direct.js`、`providers/policies/quota.js`、`providers/proxy.js`、`store/usage.js`、`shell/contract.js`、`shell/core.js`、`shell/index.js`。
这些文件的注释经逐行审阅后判定为 **非显然 WHY / 契约不变量 / 陷阱与事故教训 / 跨平台差异 / 对外 API 契约 / 安全语义**（§2 保留项），无冗余可删，故按「不确定就保留」零改动。

## 3. 形式钉子保留项（R1）

R1 普查方法：先按注释中的中文特征串在 `test/` 全量 grep；并对全部 136 个 `test/**/*.js` 抽取「含 CJK 的正则/字符串字面量」与本人 29 文件的原始源码做交集扫描（即事故 A 的形态）。最终确认 **无任何门禁读取本人 29 文件的注释文本**，但仍保留以下 5 项（其中 1 项为 grep 命中后主动回退）：

| # | 文件 | 保留注释（要点） | 证据 |
|---|---|---|---|
| 1 | `src/domains/shell/watchdog.js` | `// action === 'restart'` | `test/shell-watchdog-test.js:36,38` 含同串；grep 命中后已原样回退（未删） |
| 2 | `src/domains/router/providers/proxy.js` | 「方法保留在原型上，测试以 _doStart 打桩替换 spawn。」 | `test/reconcile-instance-test.js:49-51` 消费 `_doStart` |
| 3 | `src/domains/shell/core.js` | 「其它文件引用 core，而 core 无出边，保证单向与无环。」 | `test/directory-structure-gate-test.js:124` 判据名含「无出边」 |
| 4 | `src/domains/router/providers/restart.js` | 「在途延后/退避/停进程（restartInstance 主体）仍留在 proxy.js —— 那部分被源码门禁钉住。」 | `test/round13-router-relay-gaps-test.js` ④ 钉住 proxy.js 重启主体形态 |
| 5 | `src/domains/shell/index.js` | 「导出面与原 index.js 逐字一致（不多不少），是本域拆分的安全契约。」 | `test/domain-structure-gate-test.js` DG-9 契约双向一致（加载 `shell/contract.js` 比对） |

其余 grep 命中（如 `test/standards-uniqueness-test.js` 的「唯一事实源」、`test/upstream-credits-test.js` 的「额度用尽」等）经定位确认命中的是**测试自身的字面量/断言字符串**，而非读取本人文件注释，故未计入钉子。

## 4. 死代码普查（R2）

核验方法：对本人 29 文件导出的每个具名符号，用 `grep -w` 扫全仓（`src test bin release ui *.md design-notes .github app`，排除 `node_modules/.git`），剔除定义文件与 `*.md` 后统计非文档消费者。

**删除的导出：0。**

零非文档消费者的导出候选 2 个，均按 R2「宁可保留」保留：

| 符号 | 定义 | 全仓核验 | 处置 |
|---|---|---|---|
| `graphicalEnv` | `src/domains/router/ops/browser.js:14` | 除定义文件外仅 `design-notes/AUDIT-r5-dead-code-census.md:140` 记载为「内部使用」；无 src/test/bin 消费者 | 保留（同为 `openInBrowser` 内部调用） |
| `serializeAccount` | `src/domains/router/providers/model.js:34` | 除定义文件外无 src/test/bin 消费者；但 `EXECUTION-CONTRACT.md:71` 明列 `{ accountModel, serializeAccount }` 为对外导出契约 | 保留（删除会与规范文档冲突，且属事故 B 形态） |

其它考察后保留项：

- `src/domains/router/instances/proxy-instance.js`（1 行 re-export shim，注释自述「过渡 shim：final 批删除」）：**有消费者** `src/domains/router/index.js:12`（属分片 B，本人不得改），故整文件与注释原样保留。全仓 grep 证据：`require('./instances/proxy-instance')` 仅此 1 处。
- 恒真防御式判断（如 `store/usage.js` 的 `typeof this._canPersist === 'function'`）：非「明显」死分支且属防御写法，保留。
- `policies/failure.js` 与 `providers/policies/quota.js` 的 `headerRetryMs/bodyResetMs` 为**有意重复**（文件头注明「与 providers/base 逐字对齐，纯策略不得反向依赖有状态 provider 文件」），且均为 exported 且有消费者，保留。
- 未发现「被注释掉的代码块」；未发现重复实现需清理；未做结构重构/改名/移动代码。

## 5. `node --check` 结果

对 29 个分配文件逐一执行 `node --check`：**29/29 通过，无语法错误，退出码 0**。

代码零变化自证：对 14 个改动文件执行 `git diff -U0`，断言每条 `+`/`-` 行（排除 `+++`/`---`）去空白后均以 `//`、`/*`、`*`、`*/` 开头或为空行——**非注释改动行 = 0**。

## 6. CI 风险点（静态自查）

| 风险点 | 判据/读取面 | 评估 |
|---|---|---|
| `test/provider-gateway-gate-test.js` PG-4 | 对 provider 组（proxy/command/pool/probe/restart/base/model）**剥离注释后**匹配 `/故障前兆|时间维度|资源允许|_unhealthyCount/` | 安全：`pool.js` 的 `_unhealthyCount` 在 `needSpare` 代码中仍在；pool.js 头部清单删除不影响 |
| `test/provider-gateway-gate-test.js` PG-3 | 读取 `instances/proxy-instance.js` + `src/domains/router/model.js` 的 `COLD|WARM|HOT|DEAD`（剥注释） | 安全：两文件均未改动 |
| `test/provider-gateway-gate-test.js` PG-7 | 剥离注释后读 `store/usage.js` 的 `canPersist()`+ `writeFileSync` | 安全：`store/usage.js` 未改动 |
| `test/platform-capability-audit-test.js` A2/A7 | **不剥注释**读 `shell/watchdog.js` + `shell/core.js`：`function decide(`/`sessionAvailable`/`maxRestarts`/`graceMs`/`updateGraceMs`/`restart_failed`/`process.platform` | 安全：仅删 watch 一条过程注释，未触及以上任何标识符 |
| `test/shell-safety-net-test.js` R4/R5/R10 | 剥整行注释后读 `shell/index.js`、`watchdog.js`、另行聚合 `index/journal/restart` | 安全：`journal.js` 删的是注释文本，`id.phase/id.lastSeenAt` 写入代码未动 |
| `test/round13-router-relay-gaps-test.js` ③④ | 剥整行注释后读 `ops/admin.js`、`ops/apps-registry.js`、`providers/proxy.js` 的 force 停实例/重启形态 | 安全：三文件代码均未改动（admin/apps-registry 整文件未改） |
| `test/kernel-daemon-contract-test.js` D-7 | 聚合 router 域、过滤 `//` 行后匹配 `stateDir…config.stateFile` | 安全：仅删注释行，代码匹配面不变 |
| `test/domain-structure-gate-test.js` DG-9/DG-10 | 加载 `shell/contract.js`，与 shell 域实际导出比对 | 安全：导出面零变化 |
| 事故 B 复发 | 任何导出删除 | 已避免：本分片未删任何导出 |
| 事故 A 复发 | 任何注释形态被硬正则匹配 | 已避免：`action === 'restart'` 按 R1 回退保留 |

## 7. 未决/需上级关注

- 无跨界请求：`instances/proxy-instance.js` 的最终删除需改分片 B 的 `src/domains/router/index.js:12`，按「文件独占」未擅动；已在 §4 记录。
- `serializeAccount` 与 `EXECUTION-CONTRACT.md:71` 的导出契约绑定，若后续批次要删该导出，须同步该规范文档（超出本分片范围）。
