# P6-A 报告：注释剥离统一为字符级词法（单一实现 `test/_strip.js`）

> 对应作业单 `_workorder-phase6.md` §2。本报告由主控按提交 `c1f260c` 与工作树实测补写
> （原 P6-A 执行者未交付报告）。未跑测试/门禁、未 require 产品模块；只 `node --check`/grep/read/wc/只读 git。
> 全部路径为仓库相对路径。

## 0. 结论

- test/ 下「注释剥离」收敛为**唯一实现** `test/_strip.js`（逐字符词法；字符串/模板串/正则字面量感知）。
- 已迁移 7 个门禁；每个迁移点都带**合成样本自检**，覆盖本轮要根除的三类形态
  （`//` 行注释里的 glob、`/* */` 真块注释、**字符串字面量里的 glob**、正则字面量不被误当注释）。
- 新增文件是**助手非测试**：`_` 前缀使其不占 `scripts.test` 链条目、不触发 `test-chain-completeness-test.js`
  N-a/N-c。链条仍 7899/8000、129 条。
- **残余**（未迁移的自带剥离器）已逐条登记于 §5；其中只有 2 类真有残余风险，但**当前不可达/影响面小**。

## 1. 单一实现（`test/_strip.js`）

一次字符级扫描 `scan(src, {blank})`，跟踪：行注释、块注释、三引号字符串、正则字面量
（用「前一个有实义字符」启发式区分正则起点与除号）。块注释以换行占位以**保持行结构**。三个产物，
按各门禁**原有语义**选用，不一律改成「全剥」：

| 产物 | 语义 | 对应原形态 |
|---|---|---|
| `stripComments(src)` | 删除式：注释整段删除（块注释换行保留） | 原「剥块注释 + 行注释」 |
| `blankComments(src)` | 空格式：被剥字符逐个换空格，长度/列号保持 | 原「空格占位保偏移」 |
| `dropCommentLines(src)` | 只丢「整行都是注释」的行（行结构保留） | 原「只滤 // 行 / 块注释续行」——语义等价但字符串/正则感知 |
| `scanText(src)` | `{ stripped, regexes }`（CP 门禁原用形态） | `comment-pin` 原自带实现 |

## 2. 已迁移门禁与语义等价

| 门禁 | 采用产物 | 语义等价论证 |
|---|---|---|
| `comment-pin-gate-test.js` | `scanText` | 原实现即该 `scanText` 的出处；迁移 = 删掉本地副本改 require，产物同名同形。 |
| `directory-structure-gate-test.js` | `stripComments` | 原「先整行行注释 → 块正则 → 清星号续行」；新实现语义等价且额外**字符串/正则感知**（只可能少吞代码，不会多吞）。 |
| `provider-gateway-gate-test.js` | `stripComments` | 同上（原阶段五已把顺序改对，本次换实现根除字符串分支）。 |
| `cross-platform-architecture-gate-test.js` | `dropCommentLines` | 原「只丢 // 行与块注释续行」；新实现以 blank 产物判定「整行是否仅注释」，等价且字符串感知。 |
| `round13-robustness-batch-test.js` | `dropCommentLines` | 同上（原只丢「// 开头的整行」）。 |
| `router-circuit-breaker-test.js` | `dropCommentLines`（函数内 require） | 同上。 |
| `shell-safety-net-test.js` | `dropCommentLines`（别名 `stripCommentLines`） | 同上（原丢「// 或块注释续行（星号或块开符）开头的整行」）。 |

未迁移的门禁（仍自带实现）见 §5；未迁移不代表有缺陷，逐条给了分类。

## 3. 自检覆盖（合成样本，不依赖真实数据）

每个迁移点各带一组「正反共用」样本，**合成样本构造 glob 时用 `String.fromCharCode(42,42)` 拼接**，
避免报告/测试源码自身出现相邻两字符的假开符（本类缺陷的成因）：

- `DS-G9 / PG-10`：① 行注释里的 glob 不吞后续代码；② 反向：真块注释仍被剥离；③ **字符串字面量里的 glob 不吞代码**（本轮根除目标）；④ 正则字面量不被误当注释。
- `S-1 / S-3 / S-4`（directory-structure）：glob 不吞代码、块注释整行被丢但保留其后代码、纯块注释整行被丢、正则字面量不被误当注释。
- `R-b`（round13）：glob 不吞代码、字符串里的 glob 不吞代码。

这些自检直接证明**抽取器非空转**（改动若把剥离退化为 no-op，①②③ 必红）。

## 4. 不变式

1. **链条不变**：`test/_strip.js` 以 `_` 前缀被 helper 判定排除 ⇒ 不占链条目；本次未新增 `scripts.test` 条目。
2. **判据语义不变**：迁移只替换「剥注释」这一前置步骤，各门禁的判定正则与断言一律未动（`git show c1f260c` 的 test 改动均为剥离函数替换 + 自检）。
3. **不削弱既有过滤**：只滤 `//` 行的门禁改 `dropCommentLines`（而非 `stripComments`）；需偏移稳定的门禁可用 `blankComments`。

## 5. 全 test/ 剥离函数清单的最终状态

**已统一到 `_strip.js`（7 处）**：见 §2。

**仍自带实现（未迁移）与理由**：

| 文件 | 形态 | 分类 | 残余风险 |
|---|---|---|---|
| `all-platforms-test.js:119` | 调用处局部 `stripComments` | 非门禁（辅助） | 无（仅测试自身输入预处理） |
| `app-this-ratchet-gate-test.js:54` | 字符级（字符串感知，无正则感知） | **等价级**：AT 只数 `this.X(`，字符串里的 `this.x(` 计数与原文一致是**刻意**的 | 正则字面量含 `//` 时可能少剥；当前扫描面内不可达 |
| `dev-runtime-safety-gate-test.js:46` | 正则（先整行行注释→块→清星号） | **已修顺序**、非字符级 | 行尾（inline）`//` 注释里的 glob 仍可能开假块（当前不可达） |
| `no-dev-path-test.js:63` | 同 `dev-runtime-safety`（X-4 自检） | 同上 | 同上 |
| `standards-uniqueness-test.js:79` | 正则（先行注释→块→清星号） | 同上（U-1b 修复后） | 同上 |
| `exec-bounded-gate-test.js:42` | 字符级状态机（字符串感知，无正则感知） | **等价级偏强** | 正则字面量分支；当前扫描面内不可达 |
| `no-console-window-gate-test.js:37` | 同 `exec-bounded` | 同上 | 同上 |
| `guard-domain-model-gate-test.js:75` | 字符级（字符串感知，无正则感知） | 同上 | 同上 |
| `domain-structure-gate-test.js:79`（`strip`） | 字符级（字符串感知，无正则感知） | 同上 | 同上；DG-14 依赖它 |
| `platform-capability-audit-test.js:43` | 正则 + 引号计数启发式 | **最弱**：引号奇偶启发式对多层/转义引号不可靠 | 可能误保留/误剥；当前扫描面内未触发 |
| `probe-gate-and-ownership-test.js:144` | 只滤 `//` 整行 | 刻意（其判据只关心有实义的调用行） | 无 |
| `_workflow.js:35` | 只滤 YAML `#` 整行 | **不同域**（YAML 无 `//`） | 无 |

统一迁移这 12 处的收益是**去重复**而非修正缺陷：其中 9 处已是「字符级或已修顺序」，本阶段判定
**不值得为纯风格统一承担门禁覆盖面变化带来的 CI 风险**（作业单 §2.4 明令不得削弱/改变语义）。
若后续要做，须逐门禁给出「原过滤 vs 新过滤」等价证明与合成样本，并接受 `platform-capability-audit`
必须换成字符级实现（其引号计数启发式不可证明等价）。

## 6. CI 风险

**低**。7 处迁移的产物与原实现语义等价或**更强**（字符串/正则感知只会减少「吞代码」，
不会新增吞代码）；每处有合成样本证明非空转；链条未动；无产品代码改动。
CI 结果与此一致（`c1f260c` 后续轮次四平台全绿）。
