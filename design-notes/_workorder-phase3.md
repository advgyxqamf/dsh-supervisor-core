# 作业单：第三阶段（结构性收口）

> 主控生成。**所有 P3 子代理必读**。承接 `_workorder-phase2.md`（其 §7 钉子表与 §7.3b 工具陷阱仍然有效）。
> 主控统一提交推送；子代理只改工作区。

## 0. 硬约束（与 P2 相同，违反即整批作废）

1. **禁本机跑任何测试/门禁**：只可 `node --check` / `grep` / `read` / `wc` / 只读 git。
2. **禁一切 git 写操作**（add/commit/push/stash/checkout/restore）。
3. 不启 daemon；不碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
4. 不给 `package.json#dependencies` 加包。
5. **文件独占**：只改分配给自己的文件；需跨界先报告。
6. 新增/修改 .md 不得含操作者绝对路径（X-2 扫全树 .md）。
7. `scripts.test` 链长上限：**< 8000**（当前 7774，Windows cmd.exe 8191）。改动链必须同步 N-e 判据。

## 1. 两条铁律（P2 已验证，务必遵守）

- **R1（注释）**：删/改注释前，把该行切成 ≥4 字 CJK 与 **≥6 字符 ASCII** 串，逐 token 在 `test/` grep。
  命中即保留并登记。**必须用 `grep -oP '\p{Han}{4,}'`** —— `grep -E '[一-龥]{4,}'` 在 GNU grep 3.11
  静默返回空（假绿）。**不得改 `test/`**（除授权者）。
- **R2（死代码）**：删任何导出/函数/常量前，全仓 grep（`src test bin release ui *.md .github app`，
  排除 node_modules/.git）。`test/` 或 `bin/` 有消费者即**不得删**。宁可保留。
  本仓已因违反此律 CI 转红一次（`contract/runtime.js` 的 `file` 导出）。
- 已有真·注释钉子 5 条（P2 §7.1）：`最小兜底`(config.js:85)、`静默丢弃`(entry.js:18/:95)、
  `不再是 SEA`(deploy.js:4)、`探测失败不阻断创建`(instance/ops.js:41)、`所有者…桌面壳`(autostart/win32.js:5)。

## 2. 独占分区

| 工作流 | 拥有 | 任务 |
|---|---|---|
| P3-A | `src/app/**` 全部 .js | DF-5 六切面工厂化 + app 内死代码（collaborators.js 的 SPEC 别名导出、manager.restart 死分支） |
| P3-B | `test/**`、`package.json#scripts.test` | 四道结构性门禁（见 §3） |
| P3-C | `src/api/**` | N11 残留收口 + `api/identity.js` shim 清理 |
| P3-D | `src/domains/router/instances/proxy-instance.js`、`src/domains/router/ops.js`、`src/domains/router/index.js`、`src/domains/instance/upgrade.js` | 死代码收尾 |
| P3-E | 只读；仅写 `design-notes/_p3-*.md` | FIX-1..8 结构性复审 + AUDIT 积压清点 |

P3-A/B/C/D 各**必须再派生 1-3 个下级**做文件互斥切分，分配表写进报告。

## 3. P3-B：四道结构性门禁（每道都要有反向自检，且不得自锁）

设计原则（HANDOFF §4.3 教训）：**反向自检用合成样本，不依赖真实数据总量**，否则数据一变化门禁就自锁。

1. **CP（comment-pin）门禁**：自动检出「测试断言匹配到源码**注释**文本」这一**类**问题。
   可行判据：对每个含内联正则/字符串字面量的测试断言，把该模式分别作用于目标源码的
   **原文**与**剥注释文本**：命中原文、且不命中剥注释文本 ⇒ 该断言钉在注释上 ⇒ 违规。
   范围可先限于「内联正则字面量」这一可静态提取的子集，并**用合成样本**做反向自检
   （注释命中样本必须被检出；代码命中样本必须不误报）。把当前 5 条真钉子作为**豁免/期望集**显式登记。
2. **DG-12 非空转去自锁**：`test/domain-structure-gate-test.js` 的 DG-12 现在用**真实总量**
   （文件 ≥140 / 字节 ≥500000 / this.X() ≥400）做非空转判据。注释精简与重构会持续压低真实字节数
   （当前 1.24M，余量 2.5x，但趋势向下）—— 改为**合成样本**判据（自建一条最小可判定输入，
   证明抽取函数在给定输入上产出预期），真实总量只作**报告值**不参与判定。
3. **DG-11 形态补全**：现判据 /\binstances\s*(?:\(\s*\))?\s*\.\s*instances\b/ 仍漏
   `instances['instances']`、`const { instances } = mgr` 后直读等形态。按需补**可静态判定**的形态
   （优先括号取值的字符串字面量形态），并为每种新形态补反向自检。**不要**为凑覆盖写会误报的宽判据。
4. **EX（export-consumer）工具**：不是门禁而是**删除前的检查脚本**
   `release/scripts/export-consumers.sh`（或 .js）：输入符号名，输出全仓消费者清单（含 test/bin），
   供「删导出」前执行。理由：`f410a3a` 的根因是「删导出前靠人记消费者」——**工具化**才是结构解。
   脚本自身要能被 `node --check`/`bash -n` 校验，且**不**入 `scripts.test` 链（它是开发者工具）。
   若你判断某道门禁不可靠（误报/漏报都大），**宁可只做工具**并在报告中说明理由 —— 假绿门禁比没有更坏。

## 4. P3-C：N11 残留（主控已确认的真实漏洞）

现状 `commandShapeError` 只白名单 `command[0]` 的 basename，于是
**`["node", "/tmp/evil.js"]` 仍可执行任意脚本**（等价于任意代码执行）。

要求：当 `command[0]` 属 node 族（node/node.exe）时，**`command[1]` 必须存在且是 DSH 入口**
（basename ∈ {dsh, dsh.js, dsh-supervisor, dsh-supervisor.js} 或严格等于 `dshBin`），否则 400；
`command[0]` 为 dsh 族时维持现行为（其后为参数）。错误文案要指明可用的两种形态。
不要引入路径存在性作为放行依据；不要加「任意 *.js 放行」。补注释说明契约。`node --check`。

另：`src/api/identity.js` 是 re-export shim（消费者 `api/security.js:19`、`api/transport/server.js:13`）。
先按 R2 全仓核验；若确认可删，把两处消费者改指 `shared/ip`（`isPrivateIpv4`）与
`platform/security/identity`（`identify`），再删文件。**注意**：`test/lan-access-boundary-test.js:88`
断言 `security.js` 里 `require('./identity')` 的**解构形态**——先读该测试再动手，若会破断言就**只报告不改**。

## 5. P3-A：DF-5 六切面工厂化（最大结构项）

现状：`src/app` 的 `ctl/daemons/main/views/audit/ui` 六个切面仍是**薄委托**（`Object.assign` 风格装配 /
`this` 协作），未按 `DOMAIN-STRUCTURE-DESIGN.md` DF-5 工厂化。目标：改为 ctor/factory 显式注入，
消除薄委托与隐式 `this` 协作，**行为零变更**（对外 API/路由/事件/日志文案一律不动）。

纪律：
- 一次只切一个面，每步保持 `node --check` 通过；**不跨面混改**。
- 不得改对外可观测行为（状态码/返回/事件名/日志文案/路由）。
- 不得删任何被 `test/` 或 `bin/` 引用的导出（R2 全仓核验）。
- 触及 `app/assembly/bootstrap.js` 时注意其 6 条心跳结构钉子（R1）。
- 若某面改造成本远高于收益（例如纯数据面），**登记为首选保留**并说明，不要硬改。
- 目标文件行数上限 ≤300（DG-2）。

## 6. P3-D：死代码收尾（小、外科）

1. `src/domains/router/instances/proxy-instance.js`（2 行过渡 shim）→ 消费者 `domains/router/index.js:12`
   改指 `../model`，然后删文件。R2 核验后再删。
2. `src/domains/router/ops.js` 的 `releaseProviderPorts` 导出：内部有调用（:108），但**导出**是否有外部消费者？
   按 R2 决定：只删导出键（保留函数体）或保留并登记。
3. `src/domains/instance/upgrade.js` 的 `inst.state.version = readInstalledVersion(inst)`（约 :150/:162）——
   赋值后全仓无读取（`viewRow` 版来自别处）。核验后删除该死赋值或改为真正被读取的字段；
   若发现其实有读取（如经序列化），**保留并登记**。

每项都给 R2 证据（grep 输出行）。

## 7. P3-E：两项只读复审（只写报告）

1. **FIX-1..8 结构性复审**：逐项读 `design-notes/FIX-N.md` 与对应源码，判断该修复是
   **结构解**还是**症状补丁**（例：是在边界统一收口，还是每个调用点各打一个补丁）。
   输出：每项「结构解/症状补丁/存疑」判定 + 证据（文件:行）+ 若为症状补丁，给出结构解方案。
   重点核 `FIX-6`（service.js 吞失败根因）与 `FIX-1`（frp 暴露闸）是否**全域**收口（还有无同类调用点未覆盖）。
2. **AUDIT 积压清点**：11 份 `design-notes/AUDIT-*.md` 逐份抽取**未修项**，与已完成的
   FIX-1..8 / N1..N11 / P2 各工作流**对账**，输出一张表：条目、来源、现状（已修/未修/不适用）、
   优先级、最小修法。这是**唯一**的完整积压清单，供主控决策。

## 8. 交付物
每工作流一个报告 `design-notes/_p3-<工作流>.md`：改动文件清单（每行一理由）、R1/R2 证据、
`node --check` 结果、CI 风险点。**不得含操作者绝对路径。**
