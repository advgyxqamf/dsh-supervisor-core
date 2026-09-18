# WS1-c 分片 A —— 注释精简 + 死代码普查报告

> 工作流 WS1-c（src/app/**）下级分片 A。独占文件 38 个（assembly/** 除 assembly/bootstrap.js、
> audit/**、control/**、ctl/**、daemons/**、domain-actions/**、facade/** 的全部 .js）。
> 本报告内的路径一律为仓内相对路径。

## 0. 约束遵守

- 未运行任何测试（仅 node --check / grep / read / wc / git status|diff）。
- 未做任何 git 写操作。
- 未改 test/、package.json、CHANGELOG.md、ACCEPTANCE-STANDARD.md、.github/。
- 未触碰 src/app/assembly/bootstrap.js（WS2 所有）及 38 个文件之外的任何文件。

## 1. 改动文件清单（11 个，全部只动注释行；代码零变化）

| 文件 | 改动 | 理由 |
|---|---|---|
| src/app/control/entry.js | 删 1 行 | 删「此前此处自建副本与 canonical 不一致…」变更历史叙事；其上下文契约不变量与「静默丢弃」钉子行保留 |
| src/app/control/entry.js | 改 1 处 | 陈旧跨文件引用 main-process.js 更正为现存路径 app/main/process.js |
| src/app/control/registry.js | 删 1 行 + 改 2 处 | 删文件头空注释行；去掉「（2026-09-06 定稿）」「注意 P3 修复（2026-09-13）：」日期与缺陷编号叙事，保留其后 WHY 正文 |
| src/app/control/adapters.js | 改 1 处 | 去掉「2026-09 收敛定稿：」时间叙事前缀，保留守护语义正文 |
| src/app/control/manager.js | 删 1 行 | 删冗余分区标签 /* 注册 */（紧邻 register 方法自明） |
| src/app/control/instance-adapter.js | 删 1 行 | 删「逐字搬迁自 src/app/daemons/control-view.js（纯搬迁，逻辑零改动）」——搬迁过程记录 + 已不存在的悬空路径 |
| src/app/control/scheduler.js | 删 3 行 + 改 1 处 | 删「逐字搬迁自 …converge-view.js…仅做两件事」搬迁过程记录（含悬空路径）；文件头去掉「§7（步骤 7）拆分：」流程编号 |
| src/app/assembly/compose/core.js | 改 1 处 | 去掉「（行为序与拆分前逐字一致）」历史比对说明，保留「必须在 LogCore.init 之前」的行为序不变量 |
| src/app/assembly/compose/observers.js | 删 3 行 | 删文件头尾部空注释残留两处与 1 处空行（符号清理残留噪声） |
| src/app/assembly/facets.js | 改 1 处 | 去掉「（2026-09-17）」日期，保留「级 2」分组说明 |
| src/app/daemons/process-marks.js | 删 2 行 | JSDoc 首行标题与紧接正文重复（同句出现两次），删重复标题 |
| src/app/daemons/scripts.js | 删 6 行 | 删整段 JSDoc @param/@returns 表——与函数签名重复，且「不存在返回 null（调用方据此降级）」不变量已在文件头第 5 行声明 |

合计：删注释 25 行、改注释 7 处。自动门禁已核：无任何非注释字符变化（见 §4）。

## 2. 形式钉子保留项（R1）

先按要求在 test/ 逐条 grep 特征串（中文短语 / 标识符 / 符号），再动注释。保留未动：

| 位置 | 钉子 | 依据 |
|---|---|---|
| src/app/control/entry.js:19 | 「静默丢弃」 | test/phase-vocabulary-test.js:85 对 entry.js 全文断言 /静默丢弃/ 且 /PHASES.includes/ |
| src/app/control/entry.js:96 | 「静默丢弃」 | 同上（两处均保留，避免仅存一处后被其它改动波及） |
| src/app/control/manager.js:44/46/59/71 | 「不可启停」 | test/session-lifecycle-test.js:223 运行时断言 /不可启停/ 于 r1.error；46/59/71 为代码字符串，一行未动 |
| src/app/control/entry.js（restartCount 契约块） | 域 A/B 计数归属与跨文件指引 | 契约不变量 + 陷阱教训，按 §2 保留 |

### 2.1 一次被自动门禁拦下、经人工核实后维持删除的项

src/app/control/instance-adapter.js:4（「逐字搬迁自 …control-view.js…」）删除后，门禁首版报
「test/guard-domain-model-gate-test.js 的 daemon 字面量失去唯一匹配」。人工核实为夹具误报：

1. 该测试中 daemon 字面量的唯一出现是 :264 / :271 的合成样本 OLD_ENTRY / CLEAN_ENTRY，只喂给
   纯样本判据（hasGuardianField / hasGuardianNotTruePatch 等），不作用于本文件；
2. 该测试对本文件的唯一读取是全仓遍历 + 正则 /entry\s*\.\s*guardian\s*!==\s*true/（:306），
   与被删行无交集；其余按目录聚合处先经 stripComments（:224）；
3. 被删行的特征串（逐字搬迁 / 纯搬迁 / 逻辑零改动）在 test/ 命中数为 0。

据此维持删除（同时消除一个已不存在的悬空路径），并把门禁的字面量判据收紧为「仅统计用于
.includes() / === / .startsWith() / indexOf() 比较的字面量」，消除同类夹具误报。

## 3. 删除的导出：无

R2 全仓核验（git ls-files 全量文本，排除 node_modules 与 .git）：

- 逐文件解析 module.exports = { … } 与 exports.X = 的全部导出名；
- 对每个名字在该文件之外全仓正则精确词界计数；
- 结果：零个「无外部消费者」的导出（脚本输出 exports with zero external refs: 0）。

故本分片不适用「删除导出」交付项，也未删除任何函数/常量。

## 4. 死代码普查结果：未发现可删项

对 38 个文件的静态普查（只读，非测试）：

| 判据 | 结果 |
|---|---|
| 顶层 const/let/var 声明后全文仅出现 1 次（未使用） | 0 |
| const NAME = require(…) 后仅出现 1 次（未使用依赖） | 0 |
| 恒真/恒假分支（if (true|false|1|0)、|| true、&& false） | 0 |
| 被注释掉的代码块 | 0（仅 2 处模块头用法示例：control/projection.js:5、control/specs.js:7，属文档，保留） |
| 同文件重复函数定义 | 0（初版脚本报的 i/r/s/w/u 系跨作用域回调形参，人工复核全为假阳性） |

结论：本分片无死代码可清；所有「看似可疑」项经复核均属契约/注入设计的一部分。

## 5. node --check 结果

全部 38/38 个独占文件执行 node --check，failures=0（其中 11 个改动文件在每次改动后即时校验）。

## 6. CI 风险点

1. 注释删除残余风险（低）：自动门禁已证明不存在「某测试模式原先匹配被删行、删除后在本文件不再匹配」
   的情形（r1_breaks: 0），口径覆盖正则模式与用于比较 API 的字面量。
2. 负向断言只会更宽松：若某门禁断言「本文件不得含 X」而被删行含 X，删除只会使其更易通过。
3. 文档引用类门禁（WS3 计划中）：被删内容含 src/ 路径两处（随行删除），未新增任何路径引用；
   若 docs-reference-gate-test.js 只校验 .md 正文，本分片无影响。
4. 外部解析 src JSDoc 的工具：已确认本仓无构建/门禁读取这些 JSDoc 字段（scripts.js 被删的 @returns 无消费者）。
5. 跨分片重叠：未改 bootstrap.js；与 WS1-b / WS2 无文件交集。

## 7. 改动范围核对

git diff --stat 合计 11 files changed, 7 insertions(+), 25 deletions(-)，且全部落在注释行内。
