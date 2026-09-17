# P3-B 报告：结构性门禁与工具（test/** 与 package.json#scripts.test）

> 负责人：P3-B（含 2 个下级：P3-B-1 门禁实现 / P3-B-2 EX 工具）。全程未跑任何测试/门禁
> （只 node --check / bash -n / grep / read / wc / 只读 git），未做任何 git 写操作。
> 所有"实测"数字均来自**用本文件自身函数在只读脚本里复算**，不是执行门禁本体。

## 0. 交付清单

| # | 交付物 | 文件 | 状态 |
|---|---|---|---|
| 1 | CP 注释钉子门禁 | test/comment-pin-gate-test.js（新建，308 行） | 合成自检硬、实盘 report-only、**高置信子集硬** |
| 2 | DG-12 去自锁 | test/domain-structure-gate-test.js（B-1） | 真实总量降级为 evidence，改合成样本 |
| 3 | DG-11 形态补全 | test/domain-structure-gate-test.js（B-1） | 补括号字符串形态 + 反向引用配对 |
| 4 | EX 消费者检查工具 | release/scripts/export-consumers.sh（B-2，238 行） | bash -n 通过；**刻意不入链** |
| 5 | app this 债务棘轮 | test/app-this-ratchet-gate-test.js（新建，156 行） | 硬棘轮；本轮已首次真实收紧 |
| 附 | 链条目接线 | package.json#scripts.test | 129 条 / **7899 字符**（余量 101） |
| 附 | 链条余量纪律 | test/test-chain-completeness-test.js | 头注 + N-e 打印余量 |
| 附 | F1 fail-closed 断言 | test/api-contract-test.js | 与 P3-C 同批 |
| 附 | 熔断断言升级 | test/router-circuit-breaker-test.js | 与 P3-F 同批 |
| 附 | RANK 空转清理 | test/domain-structure-gate-test.js（B-1） | 删 5 个空转键 |

## 1. CP 门禁（第 1 道）

判据：对每个测试的**内联正则字面量** P 与它静态引用的 src 目标 F，
「P 命中 F 原文、且不命中 F 剥注释文本」=> P 钉在 F 的注释上。

实测（本文件自身函数，当前树）：tests=136 / 含 src 引用=102 / 目标=1380 / 具区分度正则=633；
findings=68（**已登记 5/5** / 未登记 63）。

- **CP-1 全量 = report-only**。那 63 条几乎全是**跨文件误报**：测试引用了多个目标，而 P 只在
  运行时作用于其中之一（例：api-surface 的 /UI|CLI|壳|README/ 命中 19 个 api 文件里根本不该看的注释）。
  纯静态无法证明"P 是否真的作用于 F"，故不假装它是硬的。可用 CP_STRICT=1 转硬（需先人工核对那 63 条）。
- **CP-5 高置信子集 = 硬判据（selfcheck）**。定义：该测试的 src 目标**恰好 1 个** 且 模式更严
  （≥6 连续汉字 或 ≥10 字符 ASCII）。实测该子集**未登记命中 = 0** —— 满足主控「为 0 才转硬」的条件，
  故直接硬执行（不是"看着绿不管用"的门禁）。其余仍 report-only。
- **CP-4 登记表 = 两条硬自检**：① 各条 needle 必须能被 distinctive 放行且 src 形态正确；
  ② 5 条真钉子必须仍能在实盘被找到（缺任一条即硬红，并在证据里点名是哪条）。
  第②条是把"豁免表静默腐化"变成显式失败；若某钉子被**有意**移除，请在同一次改动里更新 REGISTERED。
- 已修的门禁自身缺陷（本轮发现并修）：
  · **distinctive 阈值把 2/5 登记钉子滤掉**（「不再是 SEA」的 SEA 仅 3 字符；「所有者[^…]{0,12}桌面壳」的
    桌面壳仅 3 字）=> 登记表 2 条永不生效。修法：distinctive 追加"包含任一登记 needle"分支。
    （若无此修，主控要求的 CP-4 硬检查会立刻红 —— 这条正是该硬检查的价值证明。）
  · **findings 未去重**：refs 目录与其中单文件同时被引用时同一钉子重复计数（win32.js 曾被算 2 次）。
- 已知盲区（诚实登记，不在覆盖面内）：动态构造 new RegExp(A+B)、字符串 includes()/indexOf() 断言注释、
  变量中转的正则常量；以及"P 只作用于 F 之一"的二义场景（即 CP-1 的 report-only 理由）。

## 2. DG-12 去自锁（第 2 道，B-1）

原判据用**真实总量**（files≥140 / bytes≥500000 / thisCalls≥400）做非空转 —— 注释精简与重构会持续
压低真实值，迟早自锁。现改为合成样本纯函数 synthViolations() 证明 countLines/strip/thisCallNames
的行为；真实总量降级为 evidence 打印、不参与判定。余量实测：files 1.8x、bytes 2.5x、
**thisCalls 仅 1.3x**（正是最先会咬人的一项，现已被移出判定）。

## 3. DG-11 形态补全（第 3 道，B-1）

判据补入括号字符串取值形态，并用反向引用 \1 强制引号成对（防宽判据误报）：
  /\binstances\s*(?:\(\s*\))?\s*(?:\.\s*instances\b|\[\s*(['"])instances\1\s*\])/
逐样本实测 6 命中 / 5 排除（含 instances['list']、obj['instances']、引号不配对、instances[0]）。
扫 src/ 真实命中 0，故未改任何源码。

## 4. EX 工具（第 4 道，B-2）

release/scripts/export-consumers.sh <符号> [--defs]：输出 file:line:text + 定义文件 + 汇总 +
「R2 结论：可删/不可删」；退出码恒 0（用法错 2）。扫描面含 **test/ 与 bin/**（正是 f410a3a 的盲区）；
grep -HnFw -I（固定串 + 词边界，$ . / 安全）；design-notes/HANDOFF/CHANGELOG 单列不计入判定。
bash -n 通过；**不入 scripts.test**（链余量只剩 101 字符，且它不判生死）。
B-2 自查中发现并修掉一个自身真 bug：find . 产出 ./src/... 导致 bucket_of 的 src/* 永配不上。
手工自测：PKG_DEFAULT => 可删（定义外消费者 0）；registerAll => **不可删**（test/ 里 8 处消费者）。

## 5. app this 债务棘轮（主控追加）

src/app 的 this.X() 调用点**不得增长**（app 不在 DG-4/5/6 扫描面内，此前不可测量）。
计数用 [ \t]*（非 \s*）—— 与"逐行 grep 实测基线"口径严格等价，避免跨行匹配导致 stripped > 基线 的假红。
基线：main 141 / control 54 / daemons 43 / facade 13 / settings 8 / native 3 / ctl 0 / self 1 / assembly 1，
总量 **264**（原文口径上界；剥注释实测 262，松弛量恒为 2）。
**棘轮首次真实收紧**：P3-A 完成 ctl 工厂化后 ctl 3->0，故 ctl 基线 3->0、总量 267->264（已自证 0 <= 0）。
更新纪律（按主控裁定）：无意增长 = 硬红；**有意修复需要新增调用 = 允许上调**，但须在常量处注明理由与
归属并在提交信息同步；不得把调用藏进注释/拼接来绕过计数。反向自检用合成样本（含三条分支可达性、
防恒真/恒假），不依赖真实总量。

## 6. 与其它工作流**同批提交**的硬依赖（重要）

| 本报告改动 | 必须同批的他人改动 | 不同批的后果 |
|---|---|---|
| test/router-circuit-breaker-test.js（熔断断言升级，硬） | **P3-F** 修 src/domains/router/handlers/forward.js 的 **:132 与 :229** | 断言红 |
| test/api-contract-test.js（F1 → 401 + 安全属性转移） | **P3-C** 的 src/api/transport/server.js fail-closed | 断言红 |

熔断缺陷根因（已复核）：proxy.js 的 markInstanceProblem 以 instOrAcc.pid 判定实参是否为实例；
forward.js:132 与 :229 传的是**累加器 acc（无 pid）** => 静默早退、完全不计数 => 流式中断不进熔断。
正确形态是 parse.instOf(prov, acc)（同文件 :138/:181 已在用）。**注意是两处，不止 :229**。
升级后的断言：① 行为面在沙箱里执行真实 markInstanceProblem 本体（实例实参计数 / 累加器实参不计数 /
连续 2 次触发重启并清零）；② 实参形态扫描（不得传裸 acc；须为 instOf()/inst/_*.instance 形态）；
③ 三条反向样本。**若 P3-F 只修 :229 不修 :132，CI 必红** —— 请一并修。

## 7. 主控四项裁定的落实

1. **棘轮上调政策**：已改为"无意增长硬红 / 有意修复可上调并注明"，头注与失败信息同步。
2. **链条余量**：已写入 test-chain-completeness-test.js 头注 + N-e 输出（len 后附「余量 N」）；
   纪律"新增判据并入既有门禁文件、不得新增链条目"已写入头注。
   **runner 合并方案（只出方案，本轮不实现）**：可行但非平凡 —— 用一个短条目
   （node -r ./test/_preload.js test/_run-all.js）替代 129 条，argv 长度问题即消失（清单放 manifest，
   子进程各自 argv）；隔离子进程仍带 -r ./test/_preload.js；子进程非零即失败。**代价**：N-a/N-b/N-f 都靠
   解析 scripts.test 取链条目，必须改为读 manifest，并新增"manifest 与 EXCLUDED 一致性"判据（否则
   门禁清单本身会漂移）。建议作为独立后续项（净减 128 条目，余量问题彻底解决）。
3. **熔断断言升级**：已完成，见 §6（与 P3-F 同批）。
4. **"假保护"门禁评估**：见 §8。

## 8. P3-E「假保护」门禁评估（主控第 4 项）

- **U-1 只断言门禁文件存在**：低成本强化（断言门禁文件正文含被校验规范文件名）**可行但属弱代理** ——
  一行注释即可满足，本身就是"看着绿不管用"。**不建议**采用。
  真正的解是逐门禁"读规范正文并断言某条不变量"（release-spec-consistency 已如此做，是正面样本）。
  建议：按域增量补，不做一次性弱代理。
- **layering 门禁根本不提 DEVELOPMENT-TRACK**：已核实该映射是**名义映射**（'改代码规则' -> layering）。
  这是登记表层面的错误，不是"加一行 grep"能修的。最小结构解：要么把该域改指到真正读 DEVELOPMENT-TRACK
  的门禁，要么在 layering 门禁里读 DEVELOPMENT-TRACK.md 并断言其分层纪律与门禁 LAYERS 一致
  （真内容断言）。**本轮只记录，不实施**（改登记表会影响 U-1/U-2/U-4 与 README 索引）。
- **A-5 / U-3 / docs-reference 只扫根级 .md**：评估为**有意的作用域**，不建议扩到 design-notes ——
  design-notes 是**过程记录**（明确非 SSOT），扩扫会把历史叙述当规范判：
  · U-3 扩扫 => 过程报告里讨论"唯一事实源"会误报；
  · A-5 扩扫 => 过程报告引用历史验收结论会误报；
  · docs-reference 扩扫 => 大量历史路径（已按设计标注"已删除/漂移"）会误报。
  机器绑定（X-2）已由 no-dev-path 门禁**递归全树**覆盖（含 design-notes），故唯一树级风险已被管住。
  结论：**保持根级**，把"过程文档不受规范门禁管辖"记为有意设计。
- **DR-1 的已知覆盖缺口（主控本次指出）**：DR-1 只认带 src/ 前缀的路径；DOMAIN-STRUCTURE-DESIGN 目录树里
  的 instances/proxy-instance.js 这类**裸相对路径**不被检出（本轮已手动删除该行）。
  **不建议扩判据**：裸路径是**上下文相对**的（该行本意是 domains/router/ 相对，而非仓根相对），
  静态解析无法确定基准目录 => 必然大量误报/漏报。可行的低成本治理是**文档约定**：
  目录树/清单里的路径一律写 src/ 全前缀（DR-1 即自动覆盖）。已按此删除该行。

## 9. CI 风险

- CP 门禁：实盘全量 report-only（不会红）；CP-4/CP-5/合成自检为硬，已实测全绿（登记 5/5、子集 0）。
- 棘轮门禁：硬，已实测全绿（raw 264 <= 基线 264，逐目录 stripped <= raw = 基线）。
- 熔断断言 / F1 断言：**取决于 P3-F/P3-C 同批落地**，见 §6。
- 链条：7899 < 8000，N-a/N-f 满足。
- 未新增/删除任何 src 导出；未加依赖；未碰 daemon//tmp/状态根。

## 10. docs-reference 误报修复（主控发现，本轮已修）

**缺陷**：DR-1 的 SRC_REF 不分词，会从 `ui/src/features/supervisor/InstancesPage.tsx` **截出**
`src/features/...`，再按 <仓根>/src/... 判不存在 => 误报。此前之所以绿，只因仅有的两处 `ui/src/...`
恰好落在 HISTORICAL 排除集（CHANGELOG / ARCHITECTURE-PLAN）；任何人在 root .md 里正常写前端路径就会红。

**修法**（只改 test/docs-reference-gate-test.js，**不新增测试文件、链长不变 7899/129**）：
- 判据加负向后顾：`/(?<![\w/])src\/.../` —— src/ 只有是**路径根**时才计入；
- `./src/` 在 refsOf 里归一到 `src/`，否则 lookbehind 看到前一个 '.' 会失去覆盖；
- 头注写明该边界（「X/src/... 的子段不算根路径」），防后人重犯。

**自证**（合成样本 6 条全对 + 实盘全扫）：
| 样本 | 期望 | 实测 |
|---|---|---|
| ui/src/features/supervisor/InstancesPage.tsx | 0 | 0 |
| release/scripts/foo.sh 与 web/src/app.js | 0 | 0 |
| 见 ./src/platform/util/exec.js:22 | 1 且可解析 | 1 |
| src/platform/util/exec.js | 1 | 1 |
| 见 src/guard/supervisor/main-process.js:46 | 1（不存在，反向命中） | 1 |
| 任何 src/**/*.js 都不超过 300 行 | 0（glob 不产生引用） | 0 |

root .md 实盘：21 份文档 / 13 份含 src 引用 / **MISS = 0**。
