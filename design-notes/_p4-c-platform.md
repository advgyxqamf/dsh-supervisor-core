# P4-C-2 报告：platform 面（65 个 .js）

> 分片：`design-notes/_p4-c-shards.md` §1 P4-C-2（独占 `src/platform/**`）。
> 遵守 `_workorder-phase4.md` §0/§1：未跑测试/门禁、未 require 产品模块、未 git 写、未改 `test/`。
> 改动 5 文件（+19/−33），全部 `node --check` 通过。

## 1. 逐项改动

### #21 `src/platform/os/process.js` — 删 `isAlive` 导出与函数体
- 删除：`function isAlive(pid)`（原 :10-14）与其前的空行；`module.exports` 由
  `{ isAlive, signalProcess, killTree }` 改为 `{ signalProcess, killTree }`。
- **R2 证据**（原始 grep，非仅 EX 工具）：
  - `grep -rn "isAlive" src test bin` → 生产侧 `isAlive` 全部来自 `platform/os/pidlookup`（`pidlook.isAlive`），
    `app/*` 与 `domains/*` 消费点均走 `pidlook.isAlive`；无 `process.isAlive`、无 `require(os/process)` 解构 `isAlive`。
  - `processControl` 仅经 `src/platform/os/index.js:88` 暴露，其消费者 `src/app/main/signals.js:23/37/71` 只用
    `signalProcess`，未用 `isAlive`。
  - §3 四类「不可删」逐条核验：test/ 无引用、无 contract 登记、根级 .md 未列为契约、非注入对的一半 → 干净。
- **保留确认**：`signalProcess`、`killTree` 均在（`killTree` 有直接消费者 `src/app/native/ops.js:8`）。
- 行为变更：无（删除的是零消费者导出）。

### #22 `src/platform/service/tasks.js` — 删 `TaskRegistry.cancel`
- 删除：`/** 任务取消。 */ cancel(taskId, reason) { return this._finish(taskId, 'canceled', reason, null); }`。
- **R2 证据**：`grep -rn "tasks.cancel\|\.cancel(" src test bin` → 唯一命中是
  `src/domains/router/handlers/forward.js:236 body.cancel()`（另一件事：P4-B 的非流式体守卫定时器）；
  `test/task-registry-test.js` 只在 :4 头注提及状态名，**无 `cancel()` 调用**。
  作业单「接入优先」不适用：全仓**不存在表达取消意图的调用点**，故删除而非接入。
- **登记（未改，不在本文件）**：`canceled` 自此**无生产者**；
  `src/domains/plugin/model.js:39` 与 `src/domains/router/ops/apps-registry.js:139` 的
  `canceled -> failed` 映射成为**防御性保留**（按 shard 要求不删）。
- **注释修正**（避免后人据头注恢复 `cancel()`）：文件头状态机行后新增一行，
  说明 `canceled` 现为防御性识别态、生产者已因积压 #22 删除、`_finish` 仍接受该值。
- 行为变更：无（删除零调用方法；`_finish` 的 `canceled` 终态守卫保留）。
- CI 风险：低。已核 `task-registry-test.js` 不读 `tasks.js` 源码（只读写 `tasks.json`），
  其状态机断言不触及本注释。

### #24（persist 侧）`src/platform/service/token/persist.js` — 删令牌恢复文件名注入链
- 删除：`DEFAULT_TOKEN_FILE_NAME`、`_tokenFileName`、`configureTokenFileName()`、`tokenFileName()`
  及 `module.exports` 的两个键（`tokenFileName`、`configureTokenFileName`）。
- **注释按主控裁定「改正」而非删除**：原注释声称「默认名由 app 装配期经 `configureTokenFileName` 注入，
  生产路径始终注入」——**事实错误**（生产从不注入、也从不使用）。改为如实说明：
  恢复文件名的声明处已上移到 `app/settings/token-kinds.js` 的 `TOKEN_FILE_NAME`，
  由 `assembly/compose/core.js` 直接取用拼装 attach 路径；platform 侧不再持有文件名注入链。
- **自证（主控指定的两条，均为 0）**：
  - `grep -rn "configureTokenFileName" --include='*.js' src test bin release | wc -l` → **0**
  - `grep -rn "\btokenFileName\b" --include='*.js' src test bin release | wc -l` → **0**
- **未越界**：`src/app/settings/token-kinds.js` 与 `src/app/assembly/compose/core.js` **零改动**
  （主控独占，其改动已在工作区：core.js 改为 `const { TOKEN_FILE_NAME } = require(...)` + :148 使用该常量）。
- 行为变更：无。注意 platform 侧 `tokenFileName()` 此前**已无用**（`compose/core.js:148` 早已字面量硬编码），
  故删除不影响运行时路径；`path` 的其它用法（`readTailLines` 等）保留。

### #27 `src/platform/service/log/logcore.js` — 解构去掉 `LineBuffer`
- `const { createLogger, Rotator, LineBuffer } = require('./log')` → `{ createLogger, Rotator }`；
  同步把文件头注释里「…createLogger/Rotator/LineBuffer」的措辞去掉 `LineBuffer`（避免留下不实列举）。
- **R2**：`LineBuffer` 的真实消费者不在本文件 —— `src/platform/service/log/log.js:65/109`（类定义与导出）、
  `src/app/main/process.js:7/60/68`、`test/core-test.js:17/34/38`。**`log.js` 的导出与类定义未动**。
- 行为变更：无（纯未使用绑定）。

### 额外项（主控追加，SSRF 闭环另一半）`src/platform/distribution/registry.js` — `probeRegistry` 不跟随重定向
- `fetch(target.url, { signal: ... })` → `{ signal: ..., redirect: 'manual' }`，并把判定改为
  **显式非 2xx 即失败**（`res.status >= 200 && res.status < 300`），返回形状 `{ ok, latencyMs, probe }` 不变。
- 理由写入注释：`fetch` 默认 follow，攻击者控制的公网源可 302 到内网地址，绕过 api 层的 host 策略
  （白名单 / RFC1918 / 云元数据地址 / IPv6 / 单标签主机名）；在 platform 层重实现跳转目标校验会**复制策略**
  并让 platform 反向依赖 api（违反分层），故取「不跟随」这一更简单的安全默认。显式按状态码写意图，
  不依赖 `res.ok` 的隐式语义（不同实现对 `opaqueredirect` 可能给 status=0）。
- **行为变更声明**：依赖 `http -> https` 之类跳转的 registry 源，从此**报不可达**。
  取舍：攻击面 > 便利；registry 源的 probe URL 由契约给出且本应直接可达，可接受为默认。
  「单跳 + 同策略复校」方案未实现（会引入 api→platform 反向依赖），仅在此登记供主控决策。
- 测试面：`test/round13-csp-probe-test.js:82-84` 断言 `probeOrigin` 切片（起始于 `async function probeOrigin(`，
  在改动点**之后**）内含 `probeRegistry(` —— 形状不变，已核该切片仍命中（1 处）。另该测试 :73 钉 `/^https?:/`
  的 api 层字面量，未受影响。

## 2. #29 全表（platform 面重新枚举；未照抄旧 63 条清单）

**枚举方法**（对 65 个 `.js` 逐个做 `module.exports` 区域解析，含多行块与单行对象）：
得到 **145 个导出键**。对每个键计算**排除定义文件后**的消费者数：
`grep -rn "\b<sym>\b" src test bin release`（排除该键的定义文件行），并**额外**核验 §3 四类「不可删」。

**结果：145 个键中，143 个有外部消费者（或在四类中受保护）；仅 2 个为零外部消费者候选：**

| 符号 | 文件:行 | 外部消费者 | 同文件内消费者 | §3 四类 | 判定 |
|---|---|---|---|---|---|
| `macLoaded` | `src/platform/os/autostart/darwin.js:25`（导出 :138） | 0 | **有**（`setAutostart`/`setGuiAutostart`/`status` 内 6 处） | 干净 | **保留** |
| `linuxListeningInodes` | `src/platform/os/pidlookup/probe.js:19`（导出 :164） | 0 | **有**（`linuxFind` :31） | 干净 | **保留** |

**为什么保留（安全优先，作业单 §3.4「宁可保留」+ 主控追加纪律）**：
1. 二者**同文件内均有真实调用点**（非死代码），删导出键只能省一个键名，收益 ≈ 0；
2. 主控明确提示「EX 工具两个方向都不可单独采信」，并授权「只交付候选清单 + 原始证据而不删导出」；
3. 本仓已因「删导出漏看消费者」**红过一次 CI**（`contract/runtime.js` 的 `file`）；
4. P2 已就同一对符号作出「零外部消费者但同文件内有真实调用点 → 宁可保留」的裁定
   （`design-notes/_p2-ws1a-shardB.md:87`），本分片与之一致。
5. 另注：`darwin.js` 的导出面（12 键）与 `win32.js`（3 键）、`linux.js`（5 键）**本已不对称**，
   无「三端同形」约定可依，故也不存在「为对称而删」的理由。

**结论**：本分片不删任何导出键。若主控仍要清理这两个键，实施点为上述两行的导出清单；
**函数体必须保留**（同文件仍调用）。

## 3. 登记项（不改；不属本分片或不在授权面）

1. **平行重定向跟随路径（主控要求登记）**：`src/domains/plugin/market-net.js:14-24`（`getJson`）与
   `:50-61`（`getText`）、`src/domains/relay/frp-install.js:40-43` 各自实现「跳数上限」式重定向跟随
   （raw http，无 api 层 host 策略）——与本分片修掉的 `probeRegistry` 是**另一条**待评估路径。
   注：`test/round8-fixes-test.js:208` 以源码形态钉 `redirectsLeft <= 0`（市场侧防环），改动需留意。
2. **`src/api/domains/dist.js:24-25` 注释已过期**：其文自称 `probeRegistry` 仍跟随重定向、
   「需在 platform 层改 `redirect:'manual'`」——本分片已改，该句需更新（文件属 P4-B，我不越界）。
3. **`test/task-registry-test.js:4` 头注**仍把 `canceled` 列为状态机成员；纯头注、非断言，属 `test/`（P4-D 面）。
4. **`src/app/assembly/compose/core.js:148`** 现用 `TOKEN_FILE_NAME` 常量（主控已改），
   `token-kinds.js` 保留 `TOKEN_FILE_NAME` 并导出——二者构成 #24 的新「声明处→消费方」链，已核无悬空引用。

## 4. 边界与纪律

- 未碰：`src/app/settings/token-kinds.js`、`src/app/assembly/compose/core.js`、`test/**`、
  以及本分片清单外的任何文件。
- 未跑测试/门禁；未 `require` 产品模块（本分片全程仅 `node --check`/`grep`/`read`/`sed -n`/`awk`/只读 git）。
- R1：本分片新增/改写的每一处注释都按 CJK（`grep -oP '\p{Han}{4,}'`）与 ASCII(≥6) token 回扫 `test/`；
  命中的 token（`判失败`、`不可达`、`绕过`、`cancel`、`redirect`、`step 级进度`、`统一状态机`）逐条确认
  均为**测试自身的注释或与本文无关的断言**，不构成注释钉子。
- X-2：本报告只含仓内相对路径，无操作者绝对路径。

## 5. CI 风险点

1. **低**：4 项删除均为「零消费者导出/方法」，且已原始 grep 双向复核。
2. **中低（安全方向的行为变更）**：`probeRegistry` 不再跟随重定向 → 依赖跳转的 registry 源报不可达。
   既有测试中未见对「跟随重定向」的断言；`round13-csp-probe-test` 的两处形态断言已逐一核对仍成立。
3. `#24` 为**跨分片同批**：persist.js（本分片）与 token-kinds.js/compose/core.js（主控）必须同批提交，
   当前工作区二者均已就位、两条自证 grep 为 0；若单独提交 persist.js 而遗漏另两处，才会留下问题。
4. `#22` 的 `canceled` 关注册：未删任何下游映射，故无行为变更。
