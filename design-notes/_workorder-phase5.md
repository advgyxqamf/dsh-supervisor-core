# 作业单：第五阶段（残余项收口）

> 主控生成。**P5 子代理必读**。硬约束、R1/R2 铁律、形式钉子登记表**全部沿用**
> `_workorder-phase4.md` 的 §0/§1（含 R2 四条补强：契约表 / `{methods}` 门面同文件 `this.<名>` /
> 泛型名不可裸 grep / EX 工具须原始 grep 复核）。此处只列本阶段增量。

## 0. 增量纪律

1. 禁止 `require` 产品模块、禁止内存冒烟；只 `node --check`/`bash -n`/grep/read/wc/只读 git。
2. 禁 git 写；主控统一提交。
3. **链条余量 101 字符**：新增判据必须并入既有门禁文件。
4. **EX 工具已修好**（`sandboxTarget --defs` 只剩 targets.js；`resolveDsh --defs` 只剩 exec-path.js），
   但删除仍须**原始 `grep -rn` 全仓复核** + 查同文件 `this.<名>` + 比对 `EXECUTION-CONTRACT.md` 的必须导出表。
5. 本阶段**不做**：app `daemons`/`main`/`facade` 工厂化（大、热路径、计划已在 `_p3-a-*.md`）、
   `instance command` 执行边界复校（需产品决策）、`domain-actions` 原地去 this（需同批改测试钉子）。

## 1. P5-A：API 假成功 + 死代码残余（owns `src/api/domains/router.js`、`src/domains/instance/upgrade.js`、`src/domains/shell/watchdog.js`）

| 项 | 位置 | 要点 |
|---|---|---|
| **A6 部分修**（积压 §3.1，**FIX-8 同形漏点**） | `src/api/domains/router.js:16`（`/router/ports`）与 `:21`（`/router/status`） | 两处 `.catch((e) => send(200, {..., error: ...}))` —— **API 假成功**：客户端拿到 200 却带着 error，与 FIX-8 把 ok:false→400 的口径矛盾。改为 `.catch((e) => send(500, { ok:false, error: e && e.message }))`。注意同文件 :26 起的 POST 分支已按 `r.ok === false → 400`，**不要动**。UM 行为变更声明（GET 失败由 200→500）。test/ 若钉住该状态码须报告（`api-contract-test.js` 有用例，先读）。 |
| `inst.state.version` 死赋值 | `src/domains/instance/upgrade.js`（约 :156/:168） | 写两处、全仓零读取；但 `store.js` 整对象 JSON.stringify 落盘进 instances.json。P3-D 判「保留并登记」。本阶段要求：**先核验壳仓是否可能读**（本仓不可证伪则保留），若确认纯内部死值则**删除赋值 + 注释说明**；否则保持保留并登记为显式契约项。 |
| `watchdog._reset()` 零消费者 | `src/domains/shell/watchdog.js:193` | 导出但全仓零消费者（`_resetCache`/`_resetForTest` 是不同符号）。**先原始 grep 复核**；确认零消费者则删导出键（函数体可留作内部），否则登记。注意 F9 已让 `phaseStaleWarned` 在离开更新相位时复位，`_reset` 的必要性下降。 |

**必须派 1 个下级**做文件互斥（建议：A6 / 两项死代码），分配表落报告。

## 2. P5-B：注释剥离器顺序排查与修复（owns `test/**`）

**背景（主控实测）**：`standards-uniqueness-test.js` 的 U-1b 曾因 **stripComments 顺序**（先跑块注释正则、后清行注释）
把行注释里的 glob（斜杠加两个星号）当成块注释**开符**，吞掉其后到下一个结束符的**代码**，导致误报。
这是「**门禁自身的文本预处理成为假阴性来源**」类。

**主控已扫描出 2 处同款顺序风险**（块正则行号 < 行注释过滤行号）：
- `test/dev-runtime-safety-gate-test.js`（块@43 < 行@47）
- `test/no-dev-path-test.js`（块@60 < 行@64）

要求：
1. 逐个核验这两处**是否真的会吞代码**：在其扫描面内是否存在「行注释里含斜杠+两星号」的形态。
   给出证据（文件:行）；**不要**凭"风险存在"就改（假警报也要识别）。
2. 若确实会误判 → 按主控在 `standards-uniqueness-test.js` 的修法改为**先去行注释、再去块注释**（并保留既有的星号续行清理）。
3. **顺带把这一类做完**：扫 `test/*.js` 里所有自带注释剥离的函数（`stripComments`/`stripCommentLines`/`strip` 等），
   逐个人工判读**语义是否受影响**（有的只滤 `//` 行、有的先块后行）。产出清单：文件、函数名、顺序、是否风险、结论。
   **不要**为统一风格而大改（`round13-*` 的 `strip` 只滤 `//` 行，对本问题**免疫**，不要动）。
4. 每条修复都要有**合成样本反向自检**或等价论证，且不得削弱原判据语义（假绿比没有更坏）。
5. `scripts.test` 不得新增条目；改完 `node --check`。

## 3. P5-C：重定向硬化第二轮（owns `src/domains/plugin/market-net.js`、`src/domains/relay/frp-install.js`）

**背景**：P4 已把 `platform/distribution/registry.js` 的 `fetch` 改为 `redirect:'manual'`。另两处是**自己实现的跳数上限式跟随**：
- `plugin/market-net.js`：`getJson/getText` 的 `redirectsLeft = 5`，跟随 `location`；
- `relay/frp-install.js`：`get` 对 301/302/303/307/308 跟随 `location`，`redirectsLeft` 递减。

要求：
1. **先做风险定性**（这是本任务的核心，不要直接改）：这两处**是否有 api 层 host 策可绕**？若目标是内核自己配置的
   npm 镜像 / frp 官方地址（非用户可控），则**SSRF 风险面不同**，不应机械照搬 `redirect:'manual'`。
   给出证据（谁决定 url、是否用户可控、可达性）。
2. 若判定**需要**硬化：遵循「不跟随 vs 单跳复校」的取舍 —— 在 platform/domain 层实现**跳转目标复校**
   会复制 host 策略且可能违反分层（DS-G2），故优先「不跟随」；若必须跟随，须把策略**上提为单一事实源**而不是复制。
3. 若判定**不需要**：写明理由并**只登记**，同时把「DNS rebinding 不在 #12 覆盖内」一并写清（那是另一条独立风险）。
4. 行为变更（若改）必须声明：依赖跳转的镜像源将报不可达。
5. 注意 `frp-install.js` 有校验和/sha256 相关测试（`round13-frpc-integrity-test.js` A/B/C），**不要削弱**校验语义。

**必须派 1 个下级**分担（建议：一处一个），分配表落报告。

## 4. 交付物
每工作流一个报告 `design-notes/_p5-<工作流>.md`：逐项 改动/证据/行为变更/CI 风险；**不得含操作者绝对路径**。
