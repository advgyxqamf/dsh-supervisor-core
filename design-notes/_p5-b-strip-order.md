# P5-B 注释剥离器顺序：排查、修复与影响评估

> 只读 + 编辑 `test/**`（本工作流独占）。未跑测试/门禁、未 require 产品模块、无 git 写。
> 作业单：`_workorder-phase5.md` §2；硬约束与 R1/R2 承 `_workorder-phase4.md` §0/§1。全部路径为仓库相对路径。

## 0. 结论摘要

- 主控点名的 **2 处**顺序风险**均确证**会吞代码（不是假警报），已修。
- 同类缺陷**不止 2 处**：`test/*.js` 共 **6 个门禁**使用「先块注释正则、后行注释」的危险顺序；
  其中 **4 个**在其**实际 strip 面**内存在触发样本且确证吞代码 → 已修；
  **2 个**面内无触发样本 → **只登记不改**（避免无谓改动）。
- 全量扫描：`//` 注释里含斜杠+星号的文件 36 个，其中 **13 个**「同文件后文有块注释结束符且区间内含代码行」
  ⇒ 确证吞代码（最严重的区间达 **174 行代码**）。
- **每道改动门禁的"新可见区间"逐条核对：无新违规暴露**（下 §3 逐门禁给证据）。
- 修法为**顺序调整**（先去行注释→再去块注释→最后清星号续行），**不削弱任何判据语义**；
  每条各加**合成样本自检**；`scripts.test` 未改（链条目 129 未变）；4 文件 `node --check` 通过。
- 残余两类已评估并登记（下 §5）：行尾注释口径不一致（当前**不可达**）、字符串字面量分支（**可达但当前无实际后果**）。

## 1. 主控点名 2 处的核验（确证，非"风险存在即改"）

判据：在该门禁的**扫描面**内，是否存在「行注释含斜杠+星号」且「同文件后文有块注释结束符」且「区间含代码行」。

### 1.1 `test/no-dev-path-test.js`（stripComments，原块@60 < 行@64）

扫描面 = `CODE_DIRS = [src, test, release, bin, .github, ui/src]` × `CODE_EXT`（js/ts/tsx/sh/yml/json…）。

**证据（决定性）**：`test/acceptance-standard-gate-test.js` 在该面内，其第 17 行的行注释写有
  两个 glob（斜杠+两个星号）。块注释正则从该假开符起，到**下一个块注释结束符**为止 ——
  实测下一个结束符在第 36 行 ⇒ **吞掉 17–36 行**，其中 **17 行是代码**，含
  `const STD = 'ACCEPTANCE-STANDARD.md'`、`const stdText = fs.existsSync(...)` 与 `collectMd` 定义。

⇒ 结论：**真会吞代码**。该门禁此前对该文件的 17–36 行**完全失明**（假阴性）。

### 1.2 `test/dev-runtime-safety-gate-test.js`（stripComments，原块@43 < 行@47）

扫描面 = `SCAN_DIRS = [src, test, release, bin, ci, .github]` × `SCAN_EXT`。

**证据**：同一批触发文件均在其面内。最严重者 `test/domain-structure-gate-test.js`
（假开符第 363 行 → 结束符第 567 行，**吞 174 行代码**）、`test/destructive-op-safety-test.js`
(90→175，80 行)、`test/token-contract-gate-test.js`(126→177，47 行)、
`src/domains/router/providers/base.js`(6→36，29 行) 等。

⇒ 结论：**真会吞代码**。

## 2. 同类缺陷的实际范围（6 个门禁，比点名的多）

| 文件 | 剥离函数 | 原顺序 | 面内是否有触发 | 处置 |
|---|---|---|---|---|
| `test/no-dev-path-test.js` | `stripComments` | 先块后行 | **有**（acceptance 17–36 等） | **已修** |
| `test/dev-runtime-safety-gate-test.js` | `stripComments` | 先块后行 | **有**（13 处区间） | **已修** |
| `test/directory-structure-gate-test.js` | `strip` | 先块后行（replace 链） | **有**（src 4 文件：supervisor/base/service/matrix） | **已修** |
| `test/provider-gateway-gate-test.js` | `stripComments` | 先块后行（replace 链） | **有**（`baseSrc` = base.js 6–36） | **已修** |
| `test/platform-capability-audit-test.js` | `stripComments` | 先块后行 | **无** —— 其 strip 只作用于 `src/platform/os/autostart/**` 与 `darwin.js`，二者无触发 | 登记（未改） |
| `test/relay-source-gate-test.js` | `stripAll` | 先块后行 | **无** —— 只作用于 `src/domains/relay/*.js`，无触发 | 登记（未改） |

另：`test/standards-uniqueness-test.js` 的同类顺序错误已于上一阶段修复（先改行注释）；本阶段未再动。

## 3. 逐门禁「新可见区间 vs 判据」核对（本批最大 CI 风险）

方法：对每道改动门禁，用 awk 复算其**扫描面**内所有「假开符→结束符」区间，逐区间 `sed` 取出后
用**该门禁自己的判据正则**静态 grep（不运行门禁）。

### 3.1 `directory-structure-gate-test.js`（判据：MIXIN_INTO_PROTOTYPE / 门面词表 / 行数）

新可见区间共 **4** 个，全在 `src/`：

| 区间 | 代码行 | MIXIN 判据命中 |
|---|---|---|
| `src/supervisor.js` 7–18 | 9 | **none** |
| `src/domains/router/providers/base.js` 6–36 | 29 | **none** |
| `src/platform/os/service.js` 4–12 | 7 | **none** |
| `src/platform/contract/matrix.js` 4–10 | 2 | **none** |

- 判据正则：`/Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/`。
- `supervisor.js` 7–8 的 **注释**里出现「prototype」字样，但该门禁先剥注释 ⇒ 不构成命中；
  且无 `Object.assign(X.prototype` 形态的**代码**。
- 门面词表判据（DG-1）只作用于 `domains/*/index.js`，上述 4 个区间**都不含** index.js ⇒ 不适用。
- 行数判据（DS-G8/DS-9）读**原文**（`countLines(raw)`），不经 strip ⇒ 与本次改动无关。

⇒ **无新违规**。

### 3.2 `provider-gateway-gate-test.js`（判据：PG-1..PG-8）

- 该门禁的 trigger 面**只有** `base.js`（我另行精确核验：`proxy.js` 无行注释假开符 ——
  先前扫描把它列入是"字符串分支"启发式的噪音，**不成立**）。
- 新可见区间 `base.js` 6–36（29 行代码）按 PG 全部正则核对：
  `must be implemented by` / `DEFAULT_MAX_HOT|WARM` / `_switchBudgetMs` / `DEFAULT_SWITCH_BUDGET_MS` /
  `prewarmAsync` / `canPersist()` / `supports(` / `typeof … === 'function'` ⇒ **全部 none**。
  （`base.js` 的 `must be implemented by` 实际在 49–65 行，**不在**被吞区间内，故 PG-2 计数此前也未受影响；
  `canPersist: o.canPersist` 是对象键，不匹配 `canPersist()`。）
- 被吞区间**不含** `Object.assign(X.prototype`（见 3.1）⇒ DS-G3 类判据也不受影响。

⇒ **无新违规**。

### 3.3 `no-dev-path-test.js`（判据：代码/脚本里的操作者绝对路径）

新可见区间 **13** 个（4 个 src + 9 个 test），逐区间 grep `/home/<名>`、`/Users/<名>` ⇒ **全部 none**。
加固论证：对**整个扫描面**（`src test release bin .github ui/src` × CODE_EXT）做全量 grep，
排除通用占位与该门禁自身文件后 **0 命中** ⇒ 即便仍有未识别的误吞，也**不可能**掩盖一处违规。

⇒ **无新违规**。

### 3.4 `dev-runtime-safety-gate-test.js`（判据：R-G1 /tmp 通配·前缀删除；R-G2 系统路径破坏性操作）

新可见区间同为 **13** 个，逐区间与**全量**两种方式核对：
- R-G1 四条正则（`rm … /tmp/…[*?[]`、`rmSync('/tmp/…[*?[]`、`rm … /tmp/dsh-`、`rmSync(…/tmp/dsh-`）⇒ **0 命中**；
- R-G2（`DESTRUCTIVE` 动词 + `~/.local/state/dsh-supervisor` / `~/.dsh` / `node_modules/@dsh-sup/` 同行）⇒ **0 命中**；
- 该门禁自身文件被 `SKIP_FILE` 豁免（其 R-G3 合成样本含 `rm -rf /tmp/…` 形态，属**字符串常量**，不参与实盘扫描）。

⇒ **无新违规**。

### 3.5 结论
**本批修复不新暴露任何违规，不会因"看见更多代码"而红 CI。** 上文每道门禁都写明了核对了哪几个区间与依据。

## 4. 修法（4 处，均为顺序调整）

统一原则（与上一阶段 `standards-uniqueness` 的修法一致）：

1. **先清整行行注释**（`//` 或 `#`）——行注释里的假开符随整行消失；
2. **再跑块注释正则**——此时不会再吞代码；
3. **最后清 JSDoc 续行（星号开头）**——**必须放在块正则之后**：多行块注释的结束行以星号开头，
   若提前清空，块正则找不到结束符反而**漏剥**（父代理指出的这一点已写入代码注释）。

- `test/no-dev-path-test.js`：改为三步式；
- `test/dev-runtime-safety-gate-test.js`：改为三步式；
- `test/directory-structure-gate-test.js`：`strip` 的 replace 链**交换顺序**为「先行后块」
  （其行注释正则 `(^|[^:])\/\/[^\n]*` 原本已覆盖行尾注释；已核 src 内**无** `/*` 先于 `//` 同行的残渣风险）；
- `test/provider-gateway-gate-test.js`：同上交换。

**合成样本自检**（各 2 条，硬判据，不依赖真实数据）：
- `X-4` / `R-G4` / `DS-G9` / `PG-10`：① 行注释里的 glob **不得**吞掉后续代码；
  ② **反向**：真块注释仍被剥离（防"修完漏剥"）。
- glob 形态经 `String.fromCharCode(42, 42)` **拼接**构造 —— 避免源码自身出现该两字符序列而给别的门禁制造假开符
  （这正是上一阶段踩过的坑）。

## 5. 残余（已评估，两类）

### 5.1 行尾注释口径不一致（**当前不可达**，登记）
`no-dev-path` 与 `dev-runtime-safety` 的第 1 步只清**整行**注释，行尾注释（`code; // …glob…`）仍会带 glob
进入块正则；而 `directory-structure`/`provider-gateway` 的行注释正则已覆盖行尾 ⇒ 口径不一致。

**可达性评估**：在两门禁的**全部扫描面**内检索「代码字符紧跟 `//`、且注释部分含斜杠+星号」的行 ⇒
**0 命中**（唯一看似命中的是 `!t.startsWith('//')` 这类**字符串字面量**，不是注释）。
⇒ **当前不可达**，故本轮不改（改动会扩大面且无收益）；**登记**待需要时统一为字符级词法。

### 5.2 字符串字面量分支（**可达，但当前无实际后果**，登记）
即使修好顺序，若**字符串常量**里出现斜杠+星号（如 `'src/**'`、`'/tmp/*.log'`），块注释正则仍可能
从这个位置开始吞到同文件下一个结束符。这是「正则剥注释」的固有缺陷，**只有字符级词法能根除**
（本仓已有 8 个门禁用字符级词法：app-this-ratchet / exec-bounded / guard-domain-model /
no-console-window / domain-structure / release-channel / token-contract / comment-pin）。

**为何本轮不改**：作业单要求「不要为统一风格而大改」；且**实盘无后果** ——
§3.3/§3.4 的**全量** grep 证明两门禁扫描面内 `/home|/Users` 与 `/tmp` 违规**各为 0**，
故任何误吞都不可能掩盖违规。**登记**为后续「剥离器统一为词法」的输入。

## 6. 全 `test/` 注释剥离函数清单（22 项，含判定）

判定口径：**字符级词法**（正确跟踪字符串/行/块状态）与**纯行过滤**（无块正则）⇒ 对此类**免疫**；
**正则链/正则+行过滤**且**先块后行** ⇒ 风险（再按"面内是否有触发"定最终处置）。

| # | 文件 | 函数 | 顺序/形态 | 是否风险 | 结论 |
|---|---|---|---|---|---|
| 1 | `no-dev-path-test.js` | `stripComments` | 原先块后行 → **已改先行后块** | 是（确证） | **已修** + X-4 |
| 2 | `dev-runtime-safety-gate-test.js` | `stripComments` | 同上 | 是（确证） | **已修** + R-G4 |
| 3 | `directory-structure-gate-test.js` | `strip` | 原先块后行 → **已改先行后块** | 是（确证） | **已修** + DS-G9 |
| 4 | `provider-gateway-gate-test.js` | `stripComments` | 原先块后行 → **已改先行后块** | 是（确证） | **已修** + PG-10 |
| 5 | `platform-capability-audit-test.js` | `stripComments` | 先块后行 | 是（形式）但面内无触发 | 登记（未改） |
| 6 | `relay-source-gate-test.js` | `stripAll` | 先块后行 | 是（形式）但面内无触发 | 登记（未改） |
| 7 | `standards-uniqueness-test.js` | `stripComments` | 先行后块（上一阶段已修） | 否 | OK |
| 8 | `app-this-ratchet-gate-test.js` | `stripComments` | 字符级词法 | 否 | 免疫 |
| 9 | `exec-bounded-gate-test.js` | `stripComments` | 字符级词法（含字符串态） | 否 | 免疫 |
| 10 | `guard-domain-model-gate-test.js` | `stripComments` | 字符级词法 | 否 | 免疫 |
| 11 | `no-console-window-gate-test.js` | `stripComments` | 字符级词法 | 否 | 免疫 |
| 12 | `domain-structure-gate-test.js` | `strip` | 字符级词法 | 否 | 免疫 |
| 13 | `release-channel-gate-test.js` | `stripJsComments` | 字符级词法 | 否 | 免疫 |
| 14 | `token-contract-gate-test.js` | `stripSource` | 字符级词法 | 否 | 免疫 |
| 15 | `comment-pin-gate-test.js` | `scanText`（.stripped） | 字符级词法 | 否 | 免疫 |
| 16 | `cross-platform-architecture-gate-test.js` | `stripComments` | 纯行过滤（`//`/`*`/`/*` 前缀） | 否 | 免疫 |
| 17 | `probe-gate-and-ownership-test.js` | `stripComments` | 纯行过滤 | 否 | 免疫 |
| 18 | `round13-robustness-batch-test.js` | `strip` | 纯行过滤（仅 `//`） | 否 | 免疫（作业单点名勿动） |
| 19 | `round13-router-relay-gaps-test.js` | `strip` | 纯行过滤（仅 `//`） | 否 | 免疫（作业单点名勿动） |
| 20 | `router-circuit-breaker-test.js` | `strip` | 纯行过滤（仅 `//`） | 否 | 免疫 |
| 21 | `shell-safety-net-test.js` | `stripCommentLines` | 纯行过滤 | 否 | 免疫 |
| 22 | `_workflow.js` | `stripComments` | 纯行过滤（YAML `#`） | 否 | 免疫（YAML 无块注释） |

## 7. 纪律与验证

- 未跑任何测试/门禁；未 `require` 任何模块；无 git 写；只改 `test/**` 内 **4** 个文件。
- `node --check`：4/4 通过。
- `scripts.test` **未改**（仍 129 条目）；未新增文件 ⇒ 无链条余量消耗。
- 自检探针**不引入**危险序列（拼接构造），且新增注释均避免写出「斜杠+星号」字面。
- 本报告无操作者绝对路径（X-2）。

## 8. 建议主控决策

1. **本批可直接提交**：4 处修复 + 4 条自检；§3 已证明不新暴露违规。
2. 登记两项残余（§5.1 行尾口径、§5.2 字符串分支），后续若做「剥离器统一为字符级词法」再一并处理
   （可复用 `comment-pin` 门禁里已写好的 `scanText` 作为参考实现）。
3. 两处"形式风险但面内无触发"（`platform-capability-audit`、`relay-source-gate`）建议保持不动，
   但若将来它们的扫描面扩大（例如 platform-capability 开始 strip `service.js`），须同步修顺序。
