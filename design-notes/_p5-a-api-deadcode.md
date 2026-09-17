# P5-A 报告：API 假成功部分修 + 死代码残余

> 工作流 P5-A。独占文件：`src/api/domains/router.js`（主代理自做）、
> `src/domains/instance/upgrade.js`、`src/domains/shell/watchdog.js`（下级 P5-A-1）。
> 遵守 `_workorder-phase5.md` §0 与 `_workorder-phase4.md` §0/§1（硬约束 + R1/R2 四条补强）。
> 未跑测试/门禁、未 `require` 产品模块、无 git 写、未改 `test/`。

## 0. 分配表（文件互斥，覆盖 P5-A 全部三个独占文件）

| 执行者 | 文件 | 任务 |
|---|---|---|
| P5-A（主代理） | `src/api/domains/router.js` | A6 部分修：两处 `.catch` 200→500 |
| P5-A-1（下级） | `src/domains/instance/upgrade.js` | `inst.state.version` 死赋值判定与落地 |
| P5-A-1（下级） | `src/domains/shell/watchdog.js` | `_reset()` 零消费者导出判定与落地 |

无重叠、无遗漏（3 文件 = 1 + 2）。

---

## 1. A6 部分修：两处 API 假成功（`src/api/domains/router.js`）

### 改动

| 端点 | 行 | 改前 | 改后 |
|---|---|---|---|
| `GET /router/ports` | :19 | `send(200, { records: [], error: e && e.message })` | `send(500, { ok: false, records: [], error: (e && e.message) \|\| String(e) })` |
| `GET /router/status` | :24 | `send(200, { running: false, error: e.message })` | `send(500, { ok: false, running: false, error: (e && e.message) \|\| String(e) })` |

### 一处**有意偏离字面规格**（请主控知悉，可一键回退）

作业单写的目标形态是 `{ ok:false, error: e && e.message }`。我落地为**保留原有域字段**（`records: []` / `running: false`）**并新增 `ok:false`**。理由：
1. **最小契约变更**：只改状态码 + **新增**一个字段；若按字面形态会把 `records`/`running` 从响应里**删掉**，那是比"改状态码"更大的契约变更，可能影响非 UI 消费者（它们可能不检查状态码就读 `body.records`）。
2. 与同文件其它 500 分支（:42/:50/:53/:59…）的 `{ ok:false, error }` 口径**一致**（它们本就无域字段）。
3. 消除假成功的关键是**状态码**，`ok:false` 已足以让"只检查 ok"的客户端正确失败。
若主控要求严格逐字，删掉两个域字段即可（2 处一行）。

附带修掉一处**潜在二次抛错**：`/router/status` 原为 `e.message`（`e` 为 null 时抛 TypeError，逃出 catch，使 500 变不可控），统一为 `(e && e.message) || String(e)`。

### 行为变更声明（**可观测**）

- `GET /router/ports` 查询失败：**200 → 500**；响应体**新增** `ok:false`；`records`/`running` 字段保留。
- `GET /router/status` 查询失败：**200 → 500**；响应体**新增** `ok:false`；`running:false` 保留。
- **成功路径逐字不变**（仍 200 + 原样透传）。
- 同文件 :33/:36 起的 POST 分支（`r.ok === false → 400`）**未动**（作业单明令）。

### 既有断言为何不破（改前已读 `test/`）

- `test/p2p-api-test.js`：P1 / P8 断言 `GET /router/status` **成功**路径 `code === 200` 且 `body.running === false`；P29b / P30 / P31 断言 `GET /router/ports` **成功**路径 `code === 200` 且 `records` 含自治段。均走成功路径。
- **无任何测试使 `routerStatusView()`/`portsView()` 抛错**（已 grep `src test ui`），故两条 catch 分支在 CI 中**不被触发** → 改状态码不会红。
- `test/api-contract-test.js` **不调用**这两个端点（只调 `POST /router/providers/key/use`）；其 stub `routerApi` 只提供 `switchToKey`。
- 全 `test/` 对这两个端点的 500 断言数 = **0**。

### UI 侧影响（已核，方向正确）

- `ui/src/services/supervisor/client.ts:62-65`：`!res.ok` 即抛错并用 `body.error` 作消息。
- `ui/src/services/supervisor/polling.ts:60`：`supervisorApi.routerStatus().catch(() => null)` —— **抛错被捕获**，不会产生 unhandledRejection。
- 效果：改前拿 200 带 error，轮询把 `router` 当"已停止"渲染（**误导**）；改后为 `null`，UI 走其"未知/离线"分支（**更诚实**），且错误消息可经 `body.error` 呈现。
- `ui/src/services/supervisor/polling.test.ts:31` 用的是对该端点的**成功** mock，不受影响。

### 门禁影响

- `src/api/contract.js:68/:70` 仍登记这两个端点（路径/方法未变）→ api-surface 双向一致不受影响。
- `src/api/domains/router.js` = **163 行** ≤300（DG-2）。
- R1：本批新增注释的 ≥4 字 CJK token（`查询失败须如实报`/`客户端只改状态码`/`仍带原有字段`/`未删字段`/`失败同上报`/`时旧写法`/`会二次抛错`/`故统一`）在 `test/` **全部 0 命中** → 无注释钉子。

---

## 2. 两项死代码（`upgrade.js` / `watchdog.js`，由下级 P5-A-1 落地）

主代理已完成的**前置核验**（供下级直接采信）：

### 2.1 `inst.state.version`（`upgrade.js` :156 / :168）

- 赋值两处（回滚路径 :156、成功路径 :168）；**内核仓零读取**（全仓 `state.version` 仅这两处；`ui/node_modules/js-yaml` 的同名字段是第三方 YAML 解析器自有，无关）。
- `instance/model.js` 的 `createRecord` state 形状 = `{ phase, restartCount, backoffLevel, lastProbeOk }`，**不含 version** → 它是升级后才出现的**未声明额外字段**。
- **壳仓核验（本次新做，作业单要求的第一步）**：`../dsh-supervisor-launcher` 存在（10,180 文件）。对其全仓（排除 `node_modules/.git/target`）grep `instances` 与 `state\.version` → **均零命中**；其 `src-tauri` 只读 `config.json`/`runtime.json`/`core.json`。⇒ **壳仓不依赖该字段，可证伪"壳可能读"。**
- 视图/UI 显示的实例 version 走**实时读盘**（`ops.js` viewRow → versionInfo → readInstalledVersion），与本字段无关。

⇒ 满足作业单「确认纯内部死值则删除赋值 + 注释说明」的前提。

### 2.2 `watchdog._reset()`（`watchdog.js` :193 定义 / :195 导出键）

- **原始 grep 全仓**（排除 `.git/node_modules/ui-react`，已滤掉 `_resetCache`/`_resetForTest` 等**不同符号**）：仅 watchdog.js:193/:195，其余为 design-notes/HANDOFF 散文 → **零代码消费者**（`test/` 亦 0）。
- **契约表比对（R2 第三条）**：`EXECUTION-CONTRACT.md` 无 `_reset`；`src/domains/shell/contract.js` 的 `exports`/`PUBLIC_API` 是"逐字冻结 10 项"且不含它；且它是 **`createShellWatchdog()` 返回对象的属性**、不是 `module.exports` 键 → **DG-9 不受影响**。
- 其 JSDoc 自称「仅供测试」，但无任何测试使用 → 属误导性"测试钩子"。

### 2.3 落地结果（下级完成，主代理逐项复核）

| 文件 | 改动 | 复核 |
|---|---|---|
| `upgrade.js` | 删两处 `inst.state.version = readInstalledVersion(inst);`；首次出现处加 2 行注释说明为何不落该字段 | `state.version` 全仓仅剩该说明注释；`node --check` OK |
| `watchdog.js` | 删 JSDoc + 函数体 + 返回对象导出键（`return { tick, status, intervalMs }`） | `_reset` 在 `src/test/bin` **零命中**（无悬挂引用）；`node --check` OK |

**下级选择"全删函数体"而非只删导出键**，理由成立：删键后闭包内已无引用，保留即闭包内死代码。

**主代理在复核中修掉一处由本改动引入的"注释漂移"**（`upgrade.js:167`）：该处原注释为
「3) **读新版本**，拉回实例并验证可启动」，而"读新版本"那一步正是被删掉的赋值 → 删赋值后该注释**变成假信息**。
这是本仓一直在清的"docs-comment-staleness"同类债，故改为「3) 拉回实例并验证可启动」。
（R1 已核：`读新版本` 在 `test/` 零命中，可安全改写。）

---

## 3. CI 风险与遗留

**风险：低。** A6 的两条分支在 CI 中不被触发（无测试让它们抛错）；成功路径与既有断言逐字不变。

**遗留/待决**：
1. A6 的形态偏离（保留域字段）待主控确认；若要求逐字 `{ok:false,error}`，删两处字段即可。
2. `records: []` 在 500 响应里语义上略"像成功"（空端口表），但同响应有 `ok:false` + 状态码 500；如主控偏好彻底不返回域字段，见上。
3. `_reset` 若被后续周期重新需要（例如新增看护状态复位测试），应按需重加——本批按"零消费者即删"处理。
