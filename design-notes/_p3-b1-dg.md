# P3-B-1 报告：DG-11 形态补全 / DG-12 去自锁 / RANK 空转清理

独占文件：`test/domain-structure-gate-test.js`（**唯一**被我修改的文件；未碰任何其它文件）
diff：+59 / -16。`node --check test/domain-structure-gate-test.js` → **exit 0**。

改动三块，均只动目标块与其紧邻注释，未重排文件、未动其它 DG。

---

## 1. DG-11 形态补全（括号字符串取值）

**判据**（:477）：
```js
const ARRAY_PIERCE = /\binstances\s*(?:\(\s*\))?\s*(?:\.\s*instances\b|\[\s*(['"])instances\1\s*\])/;
```
在原「点号 / 别名 / 调用」三形态之上补入**括号字符串取值**形态，并用**反向引用 `\1`** 强制引号成对。

**为何不发散**（避免误报，作业单 §3.3 明确禁止宽判据）：
- 必须带 `\binstances` 接收者 → 裸 `obj['instances']` 不命中；
- 必须键恰为 `instances` → `instances['list']` 不命中；
- 引号必须成对 → `instances['instances"]` 不命中。

**自证（未跑门禁，用等价判据经 `grep -oP` 逐样本验证）**：

| 样本 | 期望 | 实测 |
|---|---|---|
| `sup.instances.instances.find()` | 命中 | `instances.instances` |
| `(instances && instances.instances)` | 命中 | `instances.instances` |
| `(instances() && instances().instances)` | 命中 | `instances().instances` |
| `instances['instances']` | 命中 | `instances['instances']` |
| `mgr.instances["instances"]` | 命中 | `instances["instances"]` |
| `instances[ 'instances' ]`（空白） | 命中 | `instances[ 'instances' ]` |
| `instances['list']` | 不命中 | NO_MATCH |
| `obj['instances']` | 不命中 | NO_MATCH |
| `instances['instances"]`（引号不配对） | 不命中 | NO_MATCH |
| `instances[0]` | 不命中 | NO_MATCH |
| `sup.instances.list()` | 不命中 | NO_MATCH |

**真实命中**：`grep -rlP` 等价判据扫 `src/` → **0 个文件**（故 DG-11 现状仍绿，本次不改任何源码）。

**新增反向自检 4 条**（:876/:878/:880/:882）：括号单引号命中、双引号命中、非穿透键不命中、裸对象不命中。
每条样本都真与匹配器有交集（命中样本期望 `length === 1`，排除样本期望 `=== 0`），符合头部「纪律 2」。

---

## 2. DG-12 去自锁（真实总量 → 合成样本）

**问题**：原判据 `ENTRIES.length >= 140 && totalBytes >= 500000 && totalThis >= 400` 用**真实总量**做非空转下界。
注释精简（P2 全批）与后续重构会持续压低字节数，趋势向下 → 迟早在不涉及「判据有无分辨力」的地方自锁假红。
实测当前余量：files 256（阈 140，1.8x）、bytes ≈1.24M（阈 0.5M，2.5x）、thisCalls 515（阈 400，1.3x）——
**thisCalls 余量仅 1.3x**，是最先会咬人的那一项。

**改法**（:886–:924）：
- 新增纯函数 `synthViolations(o)`，自建最小可判定输入，验证三个抽取函数的行为：
  - `countLines('a\nb\nc\n')` = 3；
  - `strip()` 剥掉行注释与块注释、**保留**字符串字面量里的 `// 不是注释`、保留代码；
  - `thisCallNames(strip(src))` = `'real,real'`（注释里的 `this.fake()` 必须不计数）。
- `judge` 只吃合成样本结果（失败时打印未达预期项名）。
- 真实总量**改为 evidence 打印**：`DG-12 evidence（仅报告，不参与判定）: files=… bytes=… thisCalls=…`。
- 反向自检 3 条（:918/:920/:922），均为**永久硬失败**：错期望行数必须被报出（证明比较非恒真）、
  错 this 期望必须被报出、`strip` 若退化为 no-op 必须被检出。

**自锁已解除**：判据不再引用任何真实量；无论注释精简到多少字节，DG-12 只在「抽取函数行为被改坏」时才红。

---

## 3. RANK 空转条目清理（父代理追加项）

**R2 自证（`find src/domains` 实测计数）**：

| 名字 | 实测 | 结论 |
|---|---|---|
| `manager.js` | 0 个文件 | 空转（真身在 `src/app/control/`，不属 domains） |
| `frpmgr.js` | 0 个文件 | 空转（已二分为 `frp.js` + `frp-install.js`） |
| `instances`（目录） | 0 个目录 | 空转（该目录已由 P3-D 删除） |
| `core`（目录） | 0 个目录 | 空转 |
| `jobs`（目录） | 0 个目录 | 空转 |

同时确认 `core.js`（2 个文件）与 `jobs.js`（1 个文件）**仍存在** → 其**文件键保留**。
现存子目录仅 `domains/*/{ops,policies,store,model,handlers,providers}`，对应段键全部在表内。

**已删 5 个 key**（只删键、未重排 RANK、未动 `rankOf()`）：
`'manager.js': 1`（:347）、`'frpmgr.js': 2`（:352）、`'instances': 3`（:358）、段键 `'core': 2` 与 `'jobs': 2`（:364）。

**关于可选的两项**：`'core'` / `'jobs'` 我**选择一并删除**，理由是它们与另三个同类——都指向不存在的目录；
而本表的设计语义是「未登记 → rank=null → DG-7 以『未归类』报出」（:363 已就此加注）。
保留它们等于**静默预放行**将来可能出现的同名新目录，反而削弱门禁。若你认为需要为将来预登记，恢复即一行。

**注释同步**：`// 子目录首段` 扩写为两行，写明「只登记当前存在的子目录」及未登记即未归类的语义。
:355 的 `原 frpmgr.js` 说明保留 —— 它解释 `frp-install.js` 为何是 rank 2（provenance/WHY），不是 RANK 键列表。

---

## 4. R1 形式钉子自证

改动涉及的注释串逐个回扫 `test/`（排除本文件自身）：

| 被删/改的注释串 | `test/` 命中 |
|---|---|
| `三种真实写法` | 0 |
| `字面点号前缀` | 0 |
| `长期漏检` | 0 |
| `调用下界` | 0 |
| `反向自检完备` | 0 |
| `扫描产出非空集` | 0 |
| `文件下界判据非恒真` | 0 |
| `数组穿透` | 0 |
| `文件/字节/this` | 0 |
| `子目录首段` | 0 |

另确认：**无任何其它 test 文件读取本门禁源码文本**（唯一引用是 `standards-uniqueness-test.js:50` 的证据字符串
`'test/domain-structure-gate-test.js'` 与 `directory-structure-gate-test.js:50` 的口径注释），故本文件注释改动无钉子风险。

---

## 5. 纪律遵守

- **judge / selfcheck 语义未动**：`judge` 仍 `record(..., STRICT)`（默认 report-only，`DG_STRICT=1` 才硬失败）；
  `selfcheck` 仍 `record(..., true)`（永远硬失败）。行 64–72 原样。
- 未运行任何测试/门禁（只 `node --check` / `grep` / `read` / `wc` / `find` / 只读 git）。
- 未做任何 git 写操作；未启 daemon；未碰 `/tmp/dsh-*` 与状态根；未加依赖。
- 门禁自检计数：`selfcheck(` 由 58 → **64**（DG-11 净 +4、DG-12 净 +2）。

## 6. CI 风险

- **低**。仅改门禁自身；DG-11 真实命中 0 故不新增 RED；DG-12 判定改为合成样本，不再受真实字节数影响。
- 唯一需留意：`ARCHITECTURE-ACCEPTANCE.md` 记载 `DG_STRICT=1` 为 76 passed / 0 hard / 0 soft 的历史基线。
  本次新增 6 条 selfcheck 且改 1 条 judge 名称，**该计数会变大**（76 → 82 左右）。
  该文件是历史验收记录、无门禁读取其计数（已核 `acceptance-standard-gate-test.js` 只读 ACCEPTANCE-STANDARD 正文），
  故不影响 CI；但若后续要把该文档更新为现行基线，应由拥有根级 *.md 的 P3 分片处理，我不越界。
- 最终以 CI 四平台裁决；本报告不作验收结论。
