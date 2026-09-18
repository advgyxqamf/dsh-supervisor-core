# 作业单：第六阶段（剩余项一次做完）

> 主控生成。硬约束、R1/R2 四条补强、形式钉子登记表**全部沿用** `_workorder-phase4.md` §0/§1。
> 本阶段把 `HANDOFF.md` §0.4/§0.5 登记的**剩余 7 项**一次做完。

## 0. 增量纪律

1. 禁 `require` 产品模块/内存冒烟；只 `node --check`/`bash -n`/grep/read/wc/只读 git。禁 git 写（主控提交）。
2. 链条余量 101 字符：新增判据必须并入既有门禁文件。
3. 删除仍须**原始 `grep -rn` 全仓** + 同文件 `this.<名>` 检查 + `EXECUTION-CONTRACT.md` 必须导出表比对。
4. `grep -E '[一-龥]{4,}'` 在本机**静默返回空**（假绿）；CJK 必须 `grep -oP '\p{Han}{4,}'`。
5. **本期最高风险项 = app `main` 工厂化（141 调用点、热路径）**。守护线：逐个文件转换、每步
   `node --check`、**保留 host 上既有 `{methods}` 安装**（这是行为零变更的关键不变量）、
   某文件若无法在不触碰被钉形态的前提下转换就**停止并报告**，不要硬推。

## 1. 独占分区

| 工作流 | 拥有 | 任务 |
|---|---|---|
| **P6-A** | `test/**`，**但排除** `round13-router-relay-gaps-test.js` 与 `probe-gate-and-ownership-test.js`（归 P6-B） | 剥离器字符级统一（§2） |
| **P6-B** | `src/app/**` + 上述 2 个 test 文件 | facade/daemons/main 工厂化（§3）+ domain-actions 原地去 this（§4） |
| **P6-C** | `src/domains/instance/**`、`src/api/domains/instances.js`、`EXECUTION-CONTRACT.md` | command 执行边界（§5）+ 历史 state.version 键清理（§6） |

三者必须各派生 1-3 个下级做文件互斥切分（P6-B 的 main 必须**按文件**再切），分配表落报告。

## 2. P6-A：注释剥离器统一为字符级词法

**背景**：本仓已三次因「正则剥注释」而不准：CP 的 distinctive 阈值滤掉 2/5 登记钉子；U-1b 的顺序错误；
阶段五 4 道门禁因「先块后行」把行注释里的 glob 当块开符、**吞掉代码致门禁失明**（实测吞 174/80/47/29/17 行）。
阶段五已登记两项残余：① 行尾注释口径不一致（当前不可达）；② **字符串字面量分支**（如 `'src/**'`）
仍可能吞代码 —— **只有字符级词法能根除**。

**要求**：
1. 以 `test/comment-pin-gate-test.js` 的 `scanText` 为准（它已是字符级：正确处理 `//`、`/* */`、字符串
   引号、正则字面量 vs 除号），抽出**单一实现**供各门禁复用（可放在 `test/` 下一个共享文件，如
   `test/_strip.js`；该文件不得被判为测试文件而混入链 —— 注意 `test-chain-completeness-test.js` 的
   **helper 识别规则**，必须保持 N-b/N-c 绿）。
2. 逐门禁替换其自带 `stripComments`/`stripCommentLines`/`strip`，**保持各判据语义不变**（有的只滤 `//` 行、
   有的要剥块注释 —— 用 `scanText` 的两种产物分别对应，不要一律改成"全剥"而改变覆盖语义）。
3. **每个替换点都要有合成样本自检**，且至少覆盖：`//` 行注释里的 glob 不吞后续代码、`/* */` 仍被剥、
   **字符串字面量里的 glob 不吞代码**（这是本轮新增要根除的）、正则字面量不被误当注释。
4. **不得削弱**任何既有判据；不得为统一风格而删掉某门禁特有的过滤（如只滤 `//` 行）。
5. 改完报告：**逐门禁语义等价论证**（原过滤 vs 新过滤，给出为什么等价）+ 全 `test/` 剥离函数清单的最终状态。
6. `node --check` 全部改动文件；`scripts.test` 条目数不变。

## 3. P6-B：app 工厂化（含最高风险的 main）

**不变量（必须写进代码注释与报告）**：工厂化**保留 host 上既有 `{methods}` 安装**，只把 `host.<slice>`
从转发器换成真工厂对象 —— 对外面与 `this.X()` 语义不变、可唯一回退。这是 state/control/ctl/audit 的既有做法。

**★ 口径更正（P6-B 实测，主控核实，取代本节原文的"替换转发器"表述）**：
1. **`THIN_SPEC` 无 `facade` 键**（键为 ctl/daemons/main/views/audit/ui）。facade 的 5 个模块由 `facets.js`
   的 `installMethods(host, mod.methods)` **平铺**安装，`host.facade` **全仓零引用** ⇒ 对 facade
   **不得新建 `host.facade`**（那会制造零消费者面 —— 正是 P3-A 撤掉 `host.domainActions` 的原因）。
   facade 的正确落地 = 建 `createXxx(deps)` 工厂，**公开键 = facets.js 当前实际安装的那组名字**，
   并让 `facets.js` 的安装**从工厂产物取**（使工厂真被消费）。
2. **`views`/`ui` 是 THIN_SPEC 键但无对应目录**（P3-A 已证）⇒ 只有转发器、无模块可工厂化，**不在范围**。
3. **`host.daemons`/`host.main` 确有转发器**，按 ctl/audit 范式覆盖为真工厂。
4. **工厂化 = 加工厂 + 实现体去 this + 保留 `{methods}` 外壳**；不是"删一切旧导出"。
   `{methods}` 是本仓既有范式（`audit/orphan-scan.js:97` = `{ methods: {...}, orphanAudit }`），
   由 `facets.js` 安装即**真消费**，删它**无门禁收益**且会强制改测试契约 ⇒ **保留，且不得标成待删债务**
   （`test/daemon-path-test.js:33` 合法依赖该形态，其注释已写明"导出形态从属性描述符改为 { methods }"）。
   仅当"去 this"**强制改变源码形态**时才动对应测试钉子（如 `domain-actions`），且新判据须**按符号名**
   而非行号/私有字段，避免下次重构漂移。

**顺序（由易到难，每步独立 `node --check`）**：
1. `facade`（13 调用点，5 文件）：公开面 = `facets.js` **实际安装到 host 的那组名字**（不要用 views 的 pub 名，
   那是依赖投影）。转换后须用「grep/read 静态提取键集」自证逐字相等（**不要** require 产品模块）。
2. `daemons`（43 调用点，8 文件）：逐个文件转换；注意 `runtime.js`/`supervise.js` 刚被 P4 改过
   （D10 的 `classify()` 归属判定），不要回退；`identity.js` 的 `_daemonManaged()` 语义不要改。
3. `main`（141 调用点，7 文件）：**按文件切分**给下级，每文件一个执行者。`controller.js` 刚加过 D11 的
   声明式注释、`process.js`/`signals.js` 刚加过 D12 的 `stop_failed` + timer 代际 —— **不要回退**。
   若某文件因被测试按**源码形态**钉住而无法转换（先用 R1 + 既有钉子表核），**停止该文件并报告**，
   其余继续 —— 部分完成优于硬推把热路径改坏。
4. **棘轮**：`test/app-this-ratchet-gate-test.js` 的 AT-1 要求各目录 `this.X(` **不得超基线**
   （main 141 / control 54 / daemons 43 / facade 13 / settings 8 / native 3 / ctl 0 / self 1 / assembly 0）。
   工厂化后计数**真实下降**时，**报告下降后的数值**（由主控决定是否下调基线）；**严禁**为消红上调。

## 4. P6-B：domain-actions 原地去 this（含 2 条测试钉子的同批处理）

现状：三个文件仍是 `{methods}` + `this.state.writeMainMeta(...)` 这类间接链（棘轮的 `this.X(` 指标看不见它们）。
**前置条件（主控已裁定必须同批）**：两条**源码形态**钉子
- `round13-router-relay-gaps-test.js:64` 的 `this.state.writeMainMeta(meta)`
- `probe-gate-and-ownership-test.js:151` 的 `this.(daemons.)?disableRouterPersist();`
要求：**要么**把这三文件的实现改为显式 deps 注入（不再用 `this`），**并同批**把上述两条钉子改为
**形态无关**（例如匹配 `writeMainMeta(` 与 `disableRouterPersist(` 的调用存在性，而非 `this.` 前缀）——
改钉子时要保证**判据本意不变**（它们要锁的是"该调用发生且顺序正确"，不是"必须经 this"）；
**要么**判定不可行并**只登记**（写明为什么）。二选一，不许半改。

## 5. P6-C：instance `command` 运行时执行边界（方案 A）

**背景**：`EXECUTION-CONTRACT.md` §8 已把 `command` 契约成文；§8.6 记为「待决：运行时执行边界是否复校」。
P3-C 的 §8 设计给出**方案 A**：启动期在 `domains/instance/lifecycle.js:53`（`effectiveCommand` 调用点，
此处 `inst.id` 与 `instancesRoot` 均可得）用 **realpath 包含性**复校，包含集合 =
{ 该实例 `installDir` } ∪ { `exec-path.resolveDsh()/dshJsIn()` 的解析结果 } —— 既保住
`/usr/local/bin/dsh` 这类合法入口，又拒 `/tmp/evil/dsh.js` 与伪包内路径。

**要求**：
1. 先核 `P3-C` 报告的 §8 与 §10.3（`design-notes/_p3-c-api-hardening.md`）确认前置：`lifecycle.js` 在进入
   `_systemdStart` 前已 `fs.existsSync(dshEntry)`（不存在则先安装并 return），故挂点处安装根**必然已存在**，
   realpath 不会把首次启动误判越界。
2. 抽出**公共纯函数**（api 层 add 时闸 + 启动期复校共用，避免第二份实现）；**ENOENT 必须 fail-closed**。
3. api 层的 add 时闸（`api/domains/instances.js` 的 `commandShapeError`）改为复用该函数；P4 加码的
   「绝对路径要求」「官方包内入口放行」「dshBin 严格相等」语义**不得削弱**。
4. **同批更新 `EXECUTION-CONTRACT.md` §8.4/§8.5/§8.6**：把「运行时执行边界」从**待决**改为**已复校**，
   写明包含集合与 fail-closed 语义；§8.5 的已知未保证项相应收窄（保留 DNS rebinding/其它不在范围内的）。
   注意：该文件受 `docs-reference` DR-1（引用路径须存在）与 `standards-uniqueness` U-3（不得出现
   「唯一事实源/唯一规范/唯一权威/定版 SSOT」）约束，改完自检。
5. 若核验发现方案 A 会**破坏既有契约**（例如 UI 允许指向沙箱安装根之外、且那属**有意**用法），
   则**只登记 + 更新 §8.6 的待决理由**，不要硬改。

## 6. P6-C：历史 `state.version` 键清理

阶段五已停止**新写** `inst.state.version`，但 instances.json 里**历史既存**的该键仍在。要求：**先判定**——
(a) 该键是否会被任何消费者读到（含壳仓，本仓不可证伪则保留）；(b) 清理方式：在 `store.js` 加载时做一次
**归一去键**（不写入、只在内存里删）是否安全。给出证据后再决定：安全则实现（并把该归一写成幂等），
不安全则**登记理由**。**不要**为"干净"而擅自改写持久化形状。

## 7. 交付物
每工作流一个报告 `design-notes/_p6-<工作流>.md`：逐项 改动/证据/行为变更/CI 风险；**不得含操作者绝对路径**。
