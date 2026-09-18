# P4-A-2 交付：settings 持久化失败如实返回 + instance 映射平行注释

> 范围：P4-A 分区子任务（积压 #6 的 access.js 部分 + #30 的 instance/model.js 部分）。
> 只改 `src/app/settings/access.js`、`src/domains/instance/model.js`；产物 = 本报告。
> 未跑任何测试/门禁；未 `require` 产品模块；未做 git 写；未改 `test/`。所有路径为仓库相对路径。

## 0. 边界、切分与未触碰项

- **文件互斥切分**：本子任务固定为两文件单代理切片 —— `access.js` 只做 #6，`model.js` 只做 #30；两文件无共享符号，无需再派生下级。
- **不动写契约**：`persistConfigPatch` 定义在 `src/app/state/desired.js`（P4-C 域，现无返回值、失败只 warn）。按指令本批**不改它**；`access.js` 以「回读 `this.configPath` 逐 patch 键比对」核验可观测结果，不重实现持久化。
- **不回退 P3-A**：`lanClosed` / `apiHost` 回环逻辑（原 `access.js` :25-33，现 :47-52）逐字保留（见只读 `git diff` 上下文）。
- **DG-15**：新增 `fs` 为**模块顶层** `require('node:fs')`，函数体内零 require。
- **R1**：新增/改写注释切成 CJK ≥4 字与 ASCII ≥6 字符串，在 `test/`（CJK 用 `grep -oP '\p{Han}{4,}'`）反查，见 §1.4。

## 1. #6：密钥 / 关闭行为持久化失败仍回 ok:true → 如实回失败

### 1.1 改动

| 位置 | 改动 |
|---|---|
| `src/app/settings/access.js:3` | 顶层 `const fs = require('node:fs');`（唯一新增 require，DG-15 合规） |
| `src/app/settings/access.js:14-25` | 新增模块级 `verifyPersisted(configPath, patch)`：`fs.readFileSync` + `JSON.parse` 回读，逐 patch 键严格比对；返回 `null`=通过或不适用，返回字符串=失败原因 |
| `src/app/settings/access.js:53-58` | `setAccessKey`：`this.state.persistConfigPatch(patch)` 后回读核验；非 null 即 `return { ok:false, error }` |
| `src/app/settings/access.js:79-84` | `setCloseAction`：同构（patch = `{ closeAction: val }`） |

失败原因两种：`配置读取核验失败: <msg>`（读盘/解析失败）、`配置未落盘: <key>`（该键与文件不一致）。

### 1.2 证据（file:line）

- 改动前原形：两处均为单行 `if (this.configPath) this.state.persistConfigPatch(...);`，随后无条件 `return { ok:true, ... }`（只读 `git diff` 可见）。
- 写实现现状：`src/app/state/desired.js:58-73` catch 内仅 `logger.warn`、**无返回值**（本批未改）。
- 消费端：`src/api/domains/guard.js:111-112`、`src/api/domains/guard.js:126-127` 均 `send(r.ok ? 200 : 500, r)` → 失败现落 500（消费端未改）。
- 测试面：全 `test/` 对 `setAccessKey`/`setCloseAction`/`accessKeyStatus`/`closeActionStatus` **零引用**（grep 证据），无断言钉住「失败仍 ok:true」；唯一 `state.persistConfigPatch` 引用为 `test/app-ctor-injection-test.js:88,90`，直测 state 工厂且**不使用返回值** → 即使将来透传 boolean 亦不受影响。

### 1.3 行为变更声明（必读）

1. **返回契约**：`setAccessKey`/`setCloseAction` 由「恒 `{ok:true,...}`」变为「有 `configPath` 且回读核验不通过 → `{ok:false, error:<原因>}`」。
2. **HTTP 状态**：对应 POST 由 200 变 500（guard.js 既有 `r.ok?200:500`，本批未改 guard）。
3. **事件**：持久化失败时提前返回 → **不再** `append` `access_key_changed`/`close_action_changed`（原先失败也会发）。
4. **内存态**：`this.config` 的内存写入**不回滚**（与既有行为一致；`ok:false` 仅表示未落盘）。
5. **成功路径不变**：无 `configPath`（本层不做持久化）仍 `{ok:true}`；核验通过时 `ok:true` 的字段形状（`configured/lanClosed/host/closeAction`）逐字不变。

### 1.4 R1 反查与 CI 风险点

- R1：最终注释 CJK 串 33 个，`test/` 命中 **0**；strict ASCII（≥10）命中 `configPath`（`test/daemon-path-test.js`）、`TaskRegistry`（2 个测试），二者均已存在于代码/既有注释的通用标识，非注释钉子短语。
- `test/comment-pin-gate-test.js`：CI 未设 `CP_STRICT=1`，CP-1 全量 report-only；CP-5 硬子集要求「单目标测试」，`access.js` 仅被 `test/kernel-update-single-writer-test.js` 引用且目标为 5 个 settings 文件（≠1）→ 子集不适用。
- `test/kernel-update-single-writer-test.js:34-48` 对 settings 组做 `codeOnly`（剥注释行）：新增为顶层函数与注释，不含 `guardSelfUpdateApply|Restart` 等被禁模式，判据不受影响。
- `test/app-this-ratchet-gate-test.js`：新增零个 `this.\w+( ` 调用点（access.js 实测 `this.X(` 计数 = 0），settings 目录基线 8 不涨。
- `test/domain-structure-gate-test.js` DG-15：require 在模块顶层，函数体内 0 处。
- 可观测回读的**假阴性**（宁可少报）：若 patch 键值与原文件本就相同（重复设同值），即便本次写盘失败，回读也通过——此时「落盘事实」已满足，不误报。

## 2. #30：三份平行 taskState 映射 —— 只加注释

### 2.1 逐条比对（先读三处）

| 实现 | 输入 | 分支语义 |
|---|---|---|
| `src/domains/instance/model.js:14-16` `taskStateToView` | 状态串 | `succeeded\|skipped→done`，`failed\|canceled→failed`，余→`running` |
| `src/domains/plugin/model.js:37-41` `taskStateToJobState` | 状态串 | 与上**逐字符同义**（仅换行不同） |
| `src/domains/router/ops/apps-registry.js:139`（`proxyUpdateStatus` 内联） | `t.state` | 映射表同义；**紧邻 :141 另算 `errors: t.state === 'failed' ? 1 : 0`** → canceled 映射成 `failed` 但 `errors` 计 0 |

- 第三方宿主投影差异：`plugin/jobs.js:61` 产出作业视图 `state` 字段；apps-registry 在 `proxyUpdateStatus` 内联，无导出。
- 全 `src/` grep `'succeeded'` 仅 5 处：上述 3 处映射 + `platform/service/tasks.js:201/221`（状态机，非视图映射）→ 确认三份即全部平行实现，无第四份。

### 2.2 改动

`src/domains/instance/model.js:8-13`：在原 docstring 上补注释（**零行为**）——
声明「有意平行」+ 交叉引用 `plugin/model.js:37`、`router/ops/apps-registry.js:139`、`jobs.js:61`；写清语义一致与仅在宿主投影的差异（`errors` 字段口径）；说明不抽公共函数的理由（三处分属 instance/plugin/router 三域，抽取须三处同批）。

### 2.3 证据

`src/domains/instance/upgrade.js:50`、`:216`（`taskStateToView` 域内消费者）；`src/domains/plugin/jobs.js:9`、`:61`（`taskStateToJobState` 消费者）；apps-registry 内联无导出。三处函数体逐字比对见 §2.1。

### 2.4 行为变更声明与 CI 风险

- **行为变更：无**（纯注释；未新增/删除导出，未抽公共函数）。
- R2：无删除动作，无需 `export-consumers` 核验。
- CP：未引入未登记钉子的硬子集命中（`test/` 无单目标测试直接引用 `src/domains/instance/model.js`；唯一含 `src/domains/instance` 目录引用的是 `test/layering-and-dependency-gate-test.js:91`，多目标 → CP-5 不适用）。
- 语义注释未来可能与三处之一漂移 → 属文档债，非本批行为风险。

## 3. 未决 / 移交上级（不在本批改动范围）

1. **写契约归属**：将 `persistConfigPatch` 改为返回成败并从 state 链路透传，属跨域契约变更（`src/app/state/desired.js`，P4-C owns），按指令本批不动。当前 access.js 不读其返回值，仅回读核验；将来上级改为返回 boolean 也兼容。
2. **同类残留**：`src/app/settings/lan-panel.js:54`（catch 仅 `logger.error`）与 `:59`（仍 `return {ok:true}`）存在同型「持久化失败仍报成功」（对应 AUDIT D8 的另一半），本批作业单 #6 仅点名 access.js，未越界修改，移交上级裁决。

## 4. 自检清单

| 项 | 结果 |
|---|---|
| `node --check src/app/settings/access.js` | 通过（exit 0） |
| `node --check src/domains/instance/model.js` | 通过（exit 0） |
| 只改两文件（只读 `git diff` 复核） | 通过，无越界 |
| P3-A `lanClosed`/apiHost 未回退 | 通过（diff 上下文逐字保留） |
| 函数体内 require | 0 处 |
| 测试/门禁执行 | 0 次 |
