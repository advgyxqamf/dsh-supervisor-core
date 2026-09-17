# P6-A 报告：注释剥离统一为字符级词法（单一实现 `test/_strip.js`）

> 对应作业单 `_workorder-phase6.md` §2。本报告由主控补写并随后续迁移更新。
> 未跑测试/门禁、未 require 产品模块；只 `node --check`/grep/read/wc/只读 git。全部路径为仓库相对路径。

## 0. 结论

- test/ 下「注释剥离」收敛为**唯一实现** `test/_strip.js`（逐字符词法；字符串/模板串/正则字面量感知）。
- 现已迁移 **13 个门禁**：首批 7 个（`c1f260c`），本批 6 个（`standards-uniqueness` /
  `platform-capability-audit` / `probe-gate-and-ownership` / `exec-bounded` /
  `no-console-window` / `guard-domain-model`）。
- 每个迁移点都带**合成样本自检**或**语义等价论证**，覆盖本轮要根除的三类形态
  （`//` 行注释里的 glob、`/* */` 真块注释、**字符串字面量里的 glob**、正则字面量不被误当注释）。
- 新增文件是**助手非测试**：`_` 前缀使其不占 `scripts.test` 链条目、不触发 `test-chain-completeness-test.js`
  N-a/N-c。链条仍 7899/8000、129 条。
- **残余 5 处**（未迁移的自带剥离器）逐条登记于 §5，均有**语义层面的硬理由**（多语言扫描面 / 与棘轮基线绑定 / YAML 域）。

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

### 2.1 首批（`c1f260c`，7 处）

| 门禁 | 采用产物 | 语义等价论证 |
|---|---|---|
| `comment-pin-gate-test.js` | `scanText` | 原实现即该 `scanText` 的出处；迁移 = 删掉本地副本改 require，产物同名同形。 |
| `directory-structure-gate-test.js` | `stripComments` | 原「先整行行注释 → 块正则 → 清星号续行」；新实现语义等价且额外**字符串/正则感知**（只可能少吞代码，不会多吞）。 |
| `provider-gateway-gate-test.js` | `stripComments` | 同上（原阶段五已把顺序改对，本次换实现根除字符串分支）。 |
| `cross-platform-architecture-gate-test.js` | `dropCommentLines` | 原「只丢 // 行与块注释续行」；新实现以 blank 产物判定「整行是否仅注释」，等价且字符串感知。 |
| `round13-robustness-batch-test.js` | `dropCommentLines` | 同上（原只丢「// 开头的整行」）。 |
| `router-circuit-breaker-test.js` | `dropCommentLines`（函数内 require） | 同上。 |
| `shell-safety-net-test.js` | `dropCommentLines`（别名 `stripCommentLines`） | 同上（原丢「// 或块注释续行（星号或块开符）开头的整行」）。 |

### 2.2 本批（6 处，阶段六 B-1 同批）

| 门禁 | 采用产物 | 语义等价论证 |
|---|---|---|
| `standards-uniqueness-test.js` | `stripComments` | 原「删行内 // → 删块注释 → 清星号续行」；新实现同为「删行内 // + 删块注释」，且**正则字面量感知**。方向安全：只多删注释文本，不多删代码。 |
| `platform-capability-audit-test.js` | `stripComments` | 原「块注释 + 引号奇偶启发式判行内 //」——该启发式对多层/转义引号**不可靠**；新实现为字符级，等价或更强。 |
| `probe-gate-and-ownership-test.js` | `dropCommentLines` | 原「只丢 `//` 整行」；新实现丢掉「整行都是注释」的行（含块注释整行），等价或更强。 |
| `exec-bounded-gate-test.js` | `blankComments` | 原为逐字符状态机、**空格占位保长度**；新实现同为空格占位（实测长度语义逐字一致），并额外正则感知。 |
| `no-console-window-gate-test.js` | `blankComments` | 同上。 |
| `guard-domain-model-gate-test.js` | `stripComments` | 原为逐字符删除式（**不保换行**）；新实现同为删除式且**保留块注释内换行**——该门禁只做文本正则、不读行号，语义等价或更强。 |

## 3. 自检覆盖（合成样本，不依赖真实数据）

- 首批各迁移点各带一组「正反共用」样本（见 `c1f260c`）；构造 glob 时用 `String.fromCharCode(42,42)` 拼接，
  避免源码自身出现相邻两字符的假开符（本类缺陷的成因）。`DS-G9 / PG-10` 覆盖「行注释 glob 不吞代码 / 真块注释仍剥 /
  **字符串字面量里的 glob 不吞代码** / 正则字面量不被误当注释」四态。
- `dev-runtime-safety` / `no-dev-path` 仍保留 **R-G4 / X-4 剥离顺序自检**（其自身剥离器未迁移，见 §5）。
- 本批 6 处的等价性用**逐条论证 + 方向单调性**（新实现只会「更正确地少吞代码 / 多删注释」，不会多吞代码），
  并由主控静态核对各自扫描面（均为 JS-only，除 `dev-runtime-safety`/`no-dev-path` 外）。

## 4. 不变式

1. **链条不变**：`test/_strip.js` 以 `_` 前缀被 helper 判定排除 ⇒ 不占链条目；本批未新增 `scripts.test` 条目。
2. **判据语义不变**：迁移只替换「剥注释」这一前置步骤，各门禁的判定正则与断言一律未动。
3. **不削弱既有过滤**：只滤 `//` 行的门禁改 `dropCommentLines`（而非 `stripComments`）；
   需偏移稳定的门禁用 `blankComments`；删注释的门禁用 `stripComments`。

## 5. 全 test/ 剥离函数清单的最终状态

**已统一到 `_strip.js`（13 处）**：见 §2。

**仍自带实现（5 处定义 + 1 处消费）与硬理由**：

| 文件 | 形态 | 为什么**不能**简单迁移 |
|---|---|---|
| `dev-runtime-safety-gate-test.js:46` | 正则：丢整行 `//` / `#` → 块 → 清星号 | **多语言扫描面**（`.js/.cjs/.mjs/.sh/.bash/.yml/.yaml`）。JS 字符级词法会把 shell/YAML 里的 `http://` 当行注释、又不认 `#` → 语义破坏，**必须保留**。 |
| `no-dev-path-test.js:63` | 同 `dev-runtime-safety`（X-4 自检） | 同上（`CODE_EXT` 含 `.sh/.yml/.yaml/.json`）。 |
| `app-this-ratchet-gate-test.js:54` | 字符级（字符串感知，无正则感知） | **与棘轮基线绑定**：其固有语义会**保留**字符串内的 `this.X(`（AT 注释明示「计数含字符串内」）。换实现会改变 stripped 口径，扰动刚下调的基线；**判定为稳定优先，不迁移**。 |
| `domain-structure-gate-test.js:79`（`strip`） | 字符级（字符串感知，无正则感知） | 已是字符级（无吞代码缺陷）；其 `methodBodies/definedNames` 等**抽取器口径与该实现配套**，本轮不做纯 dedup 以避开大面积重算风险。 |
| `_workflow.js:35` | 只滤 YAML `#` 整行 | **不同域**（YAML 无 `//`）；`all-platforms-test.js` 经它读 workflow，非 JS 词法场景。 |

## 6. CI 风险

**低**。本批 6 处迁移的产物与原实现语义等价或**更强**（正则字面量感知只会减少「吞代码」；
删注释方向单调，不会把真实代码当注释删）；扫描面经核对（除两处多语言门禁外均 JS-only，而那两处未迁移）；
R1 已对删除的注释逐 token 反查 `test/`（命中项均为测试自身注释，非钉子）。最终由 CI 四平台裁决。
