# 第二阶段 WS1-a 分片 C：注释精简 + 死代码普查报告

范围：WS1-a 下级分片 C 独占的 18 个文件（`src/platform/service/ports/**` 7 个、`src/platform/service/token/**` 9 个、`src/platform/service/version.js`、`src/platform/service/monitor.js`）。
本分片未再派生下级（18 个文件在 15-25 的建议区间内）。

## 0. 硬约束遵守声明

- 未运行任何测试或门禁；仅使用 `node --check`、`grep`、`read`、`wc`、`git status/diff/log`（只读）。
- 无任何 git 写操作（未 add/commit/push/stash/checkout/restore）。
- 未启动 daemon/守卫；未触碰 `/tmp/dsh-*`、状态根、`~/.dsh`。
- 未改 `package.json`、未改 `test/`、未改他人文件、未加依赖。
- 本报告与新增内容不含操作者绝对路径。

## 1. 改动文件清单（每文件一行理由）

| 文件 | 处理 | 理由 |
|---|---|---|
| src/platform/service/ports/alloc.js | 未改 | 注释均为锁语义/审计不变量/返回契约，属 §2 保留项，无冗余可删 |
| src/platform/service/ports/core.js | 未改 | 头部为 DS-G4 反转法与设计依据；行内注释标注池角色语义，非纯 WHAT，保留 |
| src/platform/service/ports/index.js | 未改 | 门面契约与单例说明为保留项 |
| src/platform/service/ports/migrate.js | 未改 | 头部为幂等/原子/DS-G4 契约，保留 |
| src/platform/service/ports/pool.js | 改 2 处 | 删 1 条与当前实现不符的过期注释（`os.homedir()...`，实际已走 state-root）；删 1 条复述 WHAT 的 `byOwner` 文档 |
| src/platform/service/ports/probe.js | 未改 | YAMA 免疫、bind 语义等均为保留项 |
| src/platform/service/ports/store.js | 未改 | 归一化/0600/静默失败均为契约与安全语义 |
| src/platform/service/token/capture.js | 未改 | 捕获优先级不可颠倒、journal 查询陷阱、正则字面量为门禁钉子，全部保留 |
| src/platform/service/token/exchange.js | 未改 | 头部含模块归属 WHY（与变更史混排，不可同义改写，按「不确定就保留」） |
| src/platform/service/token/follow.js | 改 1 处 | 删零消费者类方法 `listenerCount()`（R2 全仓核验） |
| src/platform/service/token/index.js | 未改 | 契约4 冻结面与 TK 条款注释全为保留项 |
| src/platform/service/token/infer.js | 未改 | DS-G4 规则注入语义，保留 |
| src/platform/service/token/kinds.js | 改 2 处 | 删零消费者函数 `getKinds()`、`isDshSideKind()`（R2 全仓核验；均未导出，不可达） |
| src/platform/service/token/persist.js | 改 1 处 | 删零消费者函数 `tokenFileBaseName()`（R2 全仓核验；未导出，不可达） |
| src/platform/service/token/pool.js | 未改 | TK-1/4/7/8 契约、退避调度、轮转落盘等均为保留项 |
| src/platform/service/token/snapshot.js | 未改 | TK-5/TK-7 加载过滤语义，保留 |
| src/platform/service/version.js | 未改 | SEA/源码双形态与 `typeof` 安全性 WHY，保留 |
| src/platform/service/monitor.js | 改 1 处 | 删 1 条纯过程/出处注释（`探测原语已上游化...Phase 1`），代码零变化 |

改动统计：5 个文件被修改，其余 13 个核对无冗余；共删 4 个函数本体 + 4 条冗余/过期注释行。所有改动均为整段删除，无同义改写，非注释字符零变化（见 §2 `git diff` 摘要）。

## 2. 注释精简口径与 `git diff` 证据

删（§2）：1 条与当前实现不符的过期注释、1 条复述 WHAT 的文档、1 条纯过程出处注释，以及随死函数一并删除的 4 条文档注释。
保留（§2）：非显然 WHY、契约不变量（TK-1..TK-8、DS-G4）、陷阱与事故教训（TK-6 的 rmSync 清空、P3 的 chmod 收口、release 空值顺序、journal 窗口）、跨平台差异（Windows 无 POSIX mode、USERPROFILE）、安全语义（脱敏、0600、幽灵键门禁）。

`git diff --stat` 本分片仅涉及：
```
src/platform/service/monitor.js       |  2 +-
src/platform/service/ports/pool.js    |  2 --
src/platform/service/token/follow.js  |  5 -----
src/platform/service/token/kinds.js   | 13 -------------
src/platform/service/token/persist.js |  3 ---
```
（工作树中 `env-catalog.js / install-id.js / log/* / state-root.js / tasks.js` 的改动由并行分片产生，非本分片所为，未触碰。）

## 3. 形式钉子保留项（R1，全部原样未动）

对每个拟删注释/符号先用 `grep` 在 `test/` 检索特征串，以下为测试实际锚定的形态，均未改动：

| 位置 | 锚定测试 | 保留内容 |
|---|---|---|
| src/platform/service/ports/pool.js:110 | test/probe-gate-and-ownership-test.js:72 正则 `/release\(port, ownerId\)/`（读原文） | 方法签名 `release(port, ownerId)` |
| src/platform/service/ports/pool.js:113-114 | test/round13-ports-release-test.js:124-126（indexOf） | `if (!rec) return false;` 先于 `rec.owner !== ownerId` |
| src/platform/service/ports/pool.js | test/round13-ports-release-test.js:87-95（只剥 `//`、`*`、`/*` 行） | 无无参 `.release(` 调用；注释未制造假红 |
| src/platform/service/ports/*.js | test/defects-batch-f-test.js:78-93（只剥 `^\s*//` 行） | 无 `process.env.HOME`、无 `'/tmp'`，保留 `state-root` + `supervisorDir()` |
| src/platform/service/token/persist.js:123-125 | test/round13-discipline-gaps-test.js:218-220（读原文） | `appendFileSync(...)` 后 500 字符内存在 `chmodSync(fp, 0o600)` |
| src/platform/service/token/persist.js:79/122 | test/round13-discipline-gaps-test.js:224-228（剥注释） | `rotateByBackup` 存在、代码无 `rmSync` |
| src/platform/service/token/kinds.js | test/token-contract-gate-test.js:520,532,694 | `KINDS`、`GHOST_KEYS`、`registerKind/setKinds` 未动 |
| src/platform/service/contract/runtime.js:123 关联 | test/native-dsh-binding-test.js:123 | 事故 B 的 `file` 导出不在本分片文件列表内，确认未触碰 |

注：`src/platform/service/ports/pool.js` 中 `release` 的空值顺序注释（陷阱教训）原样保留；其行号因上方注释删除而下移 1，测试使用 indexOf 不依赖行号。

## 4. 死代码普查：删除的函数与 R2 全仓核验证据

删除 4 个函数，**全部为未导出（不可从模块外访问）、全仓零消费者**，删除属不可达代码清理，行为零变化：

| 文件 | 删除符号 | 是否导出 | R2 grep 证据（排除 node_modules/.git） | 处置 |
|---|---|---|---|---|
| src/platform/service/token/kinds.js | `getKinds()` | 否（module.exports 无此键） | 改动前全仓仅 3 处：本文件定义、本文件注释、design-notes/AUDIT-r5-dead-code-census.md:22 的普查条目；`test/`、`bin/` 零命中 | 删除 |
| src/platform/service/token/kinds.js | `isDshSideKind()` | 否 | 仅本文件定义/注释 + 同上审计文档:23；`test/`、`bin/` 零命中（`pool/capture/persist` 实际只用 `isCaptured/isPersistent/isUserConfigKind/isKnownKind`） | 删除 |
| src/platform/service/token/persist.js | `tokenFileBaseName()` | 否 | 仅本文件定义 + 审计文档:24,45；`test/`、`bin/` 零命中 | 删除 |
| src/platform/service/token/follow.js | `listenerCount()` | 否（类方法，`FollowBus` 仅被 `token/pool.js` 内部使用） | 仅本文件定义 + 审计文档:27；`test/` 零命中（测试里的 `process.listenerCount` 是无关的 Node API） | 删除 |

删除后复核：`grep -rnI ... "\bgetKinds\b|\bisDshSideKind\b|\btokenFileBaseName\b|listenerCount" src test bin app` 返回零命中。

**未动的导出/候选（按「宁可保留」，仅报告）**：
- `src/platform/service/token/pool.js` 再导出 `kindInference`（`infer.js` 定义）：全仓仅定义/导入/再导出三处，无外部消费者。属导出面收敛（P2/中风险），且需与 `infer.js` 同批，故保留并上报。
- `src/platform/service/token/persist.js` 导出 `tokenFileName()`：仅 `src/app/settings/token-kinds.js:95` 的注释引用；审计文档判定为「写而不读的死链」（真正生效文件名硬编码在 `src/app/assembly/compose/core.js`）。该链的 app 侧由 WS1-c 拥有，需跨模块同批处理，故本分片保留并上报。
- `src/platform/service/token/kinds.js` 的 `kindOf`、`KIND_ORDER`、`persist.js` 的 `stripAnsi/sanitizeTokenLine`、`pool.js` 的 `CAPTURE_RETRY_MS/BACKFILL_THROTTLE_MS/MAX_PENDING_LINES`、`capture.js` 的 `captureFromJournal`、`ports/core.js` 的 `SEGMENT_ANCHOR`、`ports/store.js` 的 `normRecord`：均被本文件内部调用，非死代码，保留。
- 未发现恒真/恒假分支、被注释掉的代码块（`grep` 扫描零命中）；未发现可安全合并的重复实现（`ports/migrate.js`、`ports/store.js`、`token/persist.js` 各自的小型原子写为跨模块有意平行，合并属结构重构，超出 WS1 范围）。

## 5. `node --check` 结果

对全部 18 个独占文件逐一执行 `node --check`：

```
node --check src/platform/service/ports/alloc.js      OK
node --check src/platform/service/ports/core.js       OK
node --check src/platform/service/ports/index.js      OK
node --check src/platform/service/ports/migrate.js    OK
node --check src/platform/service/ports/pool.js       OK
node --check src/platform/service/ports/probe.js      OK
node --check src/platform/service/ports/store.js      OK
node --check src/platform/service/token/capture.js    OK
node --check src/platform/service/token/exchange.js   OK
node --check src/platform/service/token/follow.js     OK
node --check src/platform/service/token/index.js      OK
node --check src/platform/service/token/infer.js      OK
node --check src/platform/service/token/kinds.js      OK
node --check src/platform/service/token/persist.js    OK
node --check src/platform/service/token/pool.js       OK
node --check src/platform/service/token/snapshot.js   OK
node --check src/platform/service/version.js          OK
node --check src/platform/service/monitor.js          OK
整体退出码 0
```

## 6. CI 风险点

1. 本仓大量门禁以**源码字符串正则**锚定（如 `release(port, ownerId)`、`rotateByBackup`、`chmodSync(fp, 0o600)`、`KINDS/GHOST_KEYS`）。本分片全部为整段删除且已逐条比对 §3 钉子，未改写任何被锚定的代码/注释形态。
2. `test/defects-batch-f-test.js` K7 只剥离 `^\s*//` 行；删除的 `os.homedir()` 注释本就是该测试剥离范围，删除后剥离态代码不变，且 `state-root/supervisorDir()` 仍在。风险低。
3. `test/round13-discipline-gaps-test.js` ③-b 在**原文**上做 `appendFileSync...chmodSync(fp, 0o600)` 的 500 字符窗口匹配；本分片在 `persist.js` 的删除位于该窗口之后（文件尾部），窗口内容未动。风险低。
4. `token-contract-gate-test.js` TK-G1/G7 依赖 `kinds.js` 的 `KINDS/GHOST_KEYS` 与 require 结果；只删了未导出函数，登记表不变。风险低。
5. 事故 B 关联面：`src/platform/contract/runtime.js` 的 `file` 导出有 test 消费者，本分片文件列表不含该文件，确认未触碰。
6. 遗留死导出 `kindInference`、`tokenFileName` 未清理（见 §4），如需收敛须与 `infer.js`、`src/app` 侧同批决策，否则会留下半截死链。
7. 工作树中 `src/platform/service` 下其它文件（`env-catalog.js/install-id.js/log/*/state-root.js/tasks.js`）正被并行分片修改；本分片未触碰，提交时请按文件归属分别归属。
8. 全部分片均未运行测试，最终以 CI 裁决；本报告仅为静态自证。

## 7. 结论

本分片完成 18 个文件的注释精简与死代码普查：修改 5 个文件，删除 4 个全仓零消费者函数与 4 条冗余/过期注释，13 个文件核对后无冗余；所有形式钉子按 R1 原样保留，所有导出删除按 R2 全仓核验；18 个文件 `node --check` 全部通过。
