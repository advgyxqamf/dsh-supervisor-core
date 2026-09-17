# P3-B-2：删导出前消费者检查工具（EX / export-consumer）

> 交付物：`release/scripts/export-consumers.sh`（新建，755）。
> 独占范围：本任务只新建该文件；未改 `package.json`、未改 `scripts.test`、未改任何测试或其它文件。

## 1. 用法

```
release/scripts/export-consumers.sh <符号名> [--defs]
bash release/scripts/export-consumers.sh <符号名> [--defs]   # 等价
```

- `<符号名>`：待检查的导出 / 函数 / 常量名。用 `grep -F`（固定串）匹配，`$`、`.`、`/` 等正则特殊字符不会出错。
- `--defs`：除消费者清单外，另打印定义行（前缀 `[def]`）。默认只列消费者 + 汇总。
- 输出：消费者逐行 `file:line:text`（超过 160 字符截断）；随后是定义文件、汇总与一行 `R2 结论：可删 / 不可删`。
- **退出码恒 0**（找到定义外消费者、只有定义、零命中都是 0）——它是报告工具，不判生死；用法错误为 2。

## 2. 动机（已写进脚本头部注释）

`f410a3a` 的根因不是「判断错了」，而是**删导出前靠人记消费者**：`src/platform/contract/runtime.js` 的
`file` 导出被当成「仅 read() 内部使用」删除，却漏掉 `test/native-dsh-binding-test.js:123` 的 `rc.file()`
消费，CI 报 `rc.file is not a function`。人的记忆不是可靠接口；把消费者盘点固化成一条可重复命令，才是结构解。

**刻意不入 `scripts.test` 链**：它不是门禁（不判生死），塞进 CI 只会多一道永不失败的假绿门禁
（P3-B 设计原则：假绿门禁比没有更坏）。

## 3. 实现要点

1. **扫描面**：仓根全部文本文件，剪除 `node_modules/.git/dist/ui-react/.dsh/.memory/target/coverage/tmp-iso/screenshots`；
   用 `find ... -prune -o -type f -print | LC_ALL=C sort` 建文件表，**含 `test/` 与 `bin/`**（正是事故盲区）。
   `grep -HnFw -I`：`-H` 保证单文件时也带文件名，`-I` 跳过二进制文件。
2. **固定串 + 词边界**：`grep -Fw`，符号含 `$ . /` 也不会被当正则；实测 `$PKG_DEFAULT`、`runtime.file`
   均正常返回（无报错），`contract/runtime` 亦按词边界命中。
3. **定义行判据**（高精度，宁漏不误）：注释行永不是定义（否则注释里的示例会**掩盖**真实消费者）。
   接受形态：`function|const|let|var|class` 后紧跟符号；`exports.SYM`；`module.exports =` 且同行含符号；
   对象方法简写（`SYM(...) {` / `SYM()`）；以及 `SYM: function` / `SYM: () =>`（methods 面）。
   **刻意不认裸 `SYM:`**：`{ SYM: <值> }` 更可能是别处的登记表（消费者），误判成定义会把真实消费者
   藏进「定义文件」并给出错误的「可删」。
4. **R2 判定核心 = 文件归属**：定义行所在文件为定义文件；其余文件里的命中即「定义文件之外的消费者」。
   只要定义文件之外还有消费者，即判**不可删**。未定位到定义行时，所有命中都算外部，保守判不可删。
5. **过程文档分离**：`design-notes/`、`HANDOFF.md`、`CHANGELOG.md` 的命中共照实列出但**不计入**判据
   （它们是过程记录，不是契约声明）；分布行把 `过程文档=N` 单独标出，避免「只在报告里被提到」被误当消费者。
6. **保守性**：注释提及、文档提及都算命中并全列，宁可多报不可漏报（漏报正是事故的形态）。
7. **bash 3.2 兼容**（macOS 自带）：不用 `mapfile`、不用关联数组、不用 ANSI-C 引用的换行字面量；
   改用数组加分隔串做成员判定，并把 `$VAR` 一律写作 `${VAR}`，避免本仓 S-1 门禁的「`$VAR` 紧跟非 ASCII」致命形态。
8. **`./` 前缀归一化**（自查时发现并修掉的一个真 bug）：`find .` 产出 `./src/...`，
   若不剥前缀，`bucket_of` 的 `src/*` 等模式永不匹配，全部落进「其它」而误判「不可删」。

## 4. `bash -n` 与门禁合规

| 检查 | 结果 |
|---|---|
| `bash -n release/scripts/export-consumers.sh` | exit 0（新增 `./` 归一化、定义判据微调后各复跑一次，均 0） |
| S-1（`release/scripts/*.sh` 不得有 `$VAR` 紧跟非 ASCII） | 按 `test/shell-portability-test.js` 同款 grep 等价命令自查，非注释行**零命中** |
| X-1（代码/脚本无操作者绝对路径，剥注释后判） | **零命中** |
| dev-runtime-safety R-G1/R-G2 | 脚本内**无任何 `rm`/`rmSync`/`mv`**，不触碰 `/tmp` 与运行时路径 |
| destructive-op-safety W-5 | 不涉及凭据隔离调用 |
| shell-portability S-2 | 脚本**不含 `node -e`**，不适用 |
| 未入 `scripts.test` 链 | 是（链长仍 7774 < 8000；`package.json` 零改动） |
| 文件权限 | `-rwxr-xr-x`（与 `release/scripts/` 既有脚本一致） |

## 5. 与 R2 的关系（工具在流程中的位置）

- R2 原文要求删任何导出/函数/常量前全仓 grep（`src test bin release ui *.md .github app`，排除 `node_modules/.git`）。
  本工具把这条**从口头规则变成一条命令加一行结论**，并显式补齐事故的两个盲区：`test/` 与 `bin/`。
- 它**只给事实与提示行**，不做删改、不进 CI、不阻断任何流程；真正的裁决仍在人与 CI。
- 建议流程：`export-consumers.sh <符号> --defs`；若结论「不可删」先处理外部消费者；
  若「可删」，也只删**导出键**并保留文件内定义（结论行已写明）。

## 6. 用真实符号自测（未执行脚本；等价 grep 手工比对）

方法：按脚本同款文件表跑 `grep -HnFw -I`，再逐行套用 `is_definition_line` 判据（含注释行豁免）逐一核对。
> 注：`扫描文件数` 是动态值（并行工作流正在新增报告，观测期间从 608 涨到 614）；
> 下表两个符号的命中数在同一棵树上稳定复算一致。

### 6.1 `PKG_DEFAULT`

命中 11 行 = `src` 4 + `design-notes` 7。

- 定义行 **1**：`src/app/native/ops.js:12`（`const PKG_DEFAULT = ...`），定义文件 `src/app/native/ops.js`。
- 定义文件内消费者 **3**：`ops.js:89` / `:179` / `:181`（同文件内部使用，非外部消费者）。
- `design-notes` **7**（过程文档，不计入）：`_r5-app-api-P3.md:50`；`_p2-ws1c-B.md:57,87,88`；`_p2-ws1c-app.md:100,129,166`。
- **定义文件之外（计入 R2）= 0**。分布：`src=0 test=0 bin=0 release=0 ui=0 docs=0 过程文档=7 其它=0`。
- 预期结论行：**`R2 结论：可删（仅定义文件内出现，无外部消费者；若只删导出键，请保留文件内定义）`**。

与事实一致：P2 删掉 `src/app/native/upgrade.js` 的 `PKG_DEFAULT` 导出是安全的（该名在 ops.js 另有同名局部常量，
`test/`、`bin/` 零消费者）。注意工具回答的是「这个名字在定义文件之外还有没有出现」，不是「哪一份定义」。

### 6.2 `registerAll`

命中 23 行 = `src` 5 + `test` 5 + `design-notes` 13。

- 定义行 **2**：`src/app/control/adapters.js:25`（`function registerAll(mgr, deps) {`）与 `:155`（`module.exports = { registerAll };`），
  定义文件 `src/app/control/adapters.js`；该文件内非定义行 **0**。
- **定义文件之外（计入 R2）= 8**：
  `src/app/assembly/bootstrap.js:11`、`src/app/assembly/compose/observers.js:8`、`:41`、
  `test/lifecycle-mirror-test.js:8,21,38`、`test/session-lifecycle-test.js:204,206`。
  （其中 `test/lifecycle-mirror-test.js:8` 是测试头注里的提及，按「保守全列」计入。）
- `design-notes` **13**（过程文档，不计入）。分布：`src=3 test=5 bin=0 release=0 ui=0 docs=0 过程文档=13 其它=0`。
- 预期结论行：**`R2 结论：不可删（定义文件之外有 8 处消费者）`**。

这正是 `f410a3a` 那一类：消费者在 **`test/`** 里（`session-lifecycle-test.js:204/206` 解构并调用 `registerAll`）。
若当初有本工具，删任何导出前都会看到 `test` 计数非零。

## 7. 已知边界（诚实登记）

1. **定义识别是启发式**：`module.exports = Object.assign(...)`、计算属性键、重命名再导出等形态可能识别不到。
   漏识别的方向是**保守**（该文件不进定义文件集，命中都算外部，更可能判「不可删」），安全。
   唯一反向风险（把消费者误判为定义）已用「注释行永不是定义」加「不认裸 `SYM:`」压缩；
   若 `--defs` 打印出的定义行不在你预期位置，请当作**可疑**信号复核。
2. **文件名含冒号**会让 `file:line:text` 解析歧义；本仓无此形态（脚本注释已登记该边界）。
3. **注释与文档提及按命中计**（保守）。若结论为「不可删」但外部命中只是注释或过程文档，
   分布行会显示 `过程文档=N` 与各目录计数，据此可自行判断。
4. **不做语义分析**：同名不同物无法区分（`ops.js` 与已删的 `upgrade.js` 各有 `PKG_DEFAULT`），
   只回答「这个名字在定义文件之外还有没有出现」。

## 8. CI 风险

- **无功能风险**：新文件不进 `scripts.test`、不被任何门禁读取、运行时自身不执行任何外部命令。
- 已自查的静态门禁（S-1 / X-1 / dev-runtime-safety / destructive-op-safety）均不受影响，理由见 §4。
- 唯一「风险」是风格分歧：若 reviewer 期望它入链，需另立任务（本任务明确要求不入链）。

## 9. R1 证据（未删未改任何注释或代码）

- 本任务**只新建 1 个文件**，无删除、无改名、无导出变更；`test/`、`package.json`、`scripts.test` 零改动。
- 因此 R1（注释钉子）与 R2（删导出）在本次交付中均无新增风险面。
