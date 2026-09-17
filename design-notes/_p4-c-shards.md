# P4-C 分片细则（platform + plugin + shell + app-state/control）

> 主控由 P4-C 负责人生成。**P4-C 的下级子代理必读**，并遵守 `_workorder-phase4.md` §0/§1（硬约束 + R1/R2 铁律）。
> 本文件只做**文件独占切分**与逐项要点，不替代作业单。

## 0. 硬约束（重申，违反即整批作废）
禁跑测试/门禁；**禁 require 产品模块、禁内存冒烟**；禁 git 写；禁改 `test/`；
只可 `node --check` / `bash -n` / `grep` / `read` / `wc` / `sed -n` / 只读 git。
R1：改/删注释前按 CJK(`grep -oP '\p{Han}{4,}'`) 与 ASCII(≥6) token 回扫 `test/`，命中即保留并登记。
R2：删任何导出/函数/常量前跑 `release/scripts/export-consumers.sh <符号>` + 全仓 grep（含 `test/`、`bin/`）。
报告写 `design-notes/_p4-c-<分片>.md`，不得含操作者绝对路径。

## 1. 分片表（互斥，无重叠）

| 分片 | 独占文件 | 积压项 |
|---|---|---|
| **P4-C-1** | `src/domains/plugin/**`（18）+ `src/domains/shell/**`（6） | #3 #13 #14 #30(plugin/model) #29 |
| **P4-C-2** | `src/platform/**`（65） | #21 #22 #24(persist 侧) #27 #29 |
| **P4-C-3** | `src/app/state/**`（10）+ `src/app/control/**`（11）+ `src/app/assembly/bootstrap.js` | #25 #26 #28 #29 |
| **P4-C 负责人（主控）** | `src/app/settings/token-kinds.js`（#24 另一半，见 §4） | #24 #30 汇总 |

## 2. 逐项要点

### P4-C-1
- **#3** `plugin/market.js`：`getIndex` 与 `_refreshIfStale` 的 `this._inFlight = this.buildIndex().finally(...)` 各一处 ——
  后台刷新分支无 `.catch` → buildIndex 抛错时 unhandledRejection（`getIndex` 的 await 分支有调用方接，但 `_refreshIfStale`
  的**后台刷新无人接**）。改法：`buildIndex().catch(warn).finally(...)`；warn 用 `this.logger`（无则静默兜底）。
  ⚠ 不要把 `_inFlight` 变成 rejected promise（`.catch` 后仍返回**已消化**的 promise，语义不变：`_inFlight` 只用于并发去重）。
- **#13** `plugin/updater.js`：仅 `latest !== null` 才写 `ctx._updCache[p.name]` —— 取失败（null）不得负缓存 6h。
  注意 `meta.set(p.name, { latest }) `照旧写（本次返回仍需 latest 值）。
- **#14** `shell/watchdog.js` `expectedAbsence()`：`if (j && j.to && !j.confirmed) return true;` 无时效上限 →
  陈旧未确认账本会让看护**永久**认为「预期缺席」而不介入。加时效：与 `phaseMaxAgeMs` 对称（读该文件里 phaseStale
  的既有判据与常量，复用同一时基），超时后不再据此判 expectedAbsence（并 warn 一次，不静默）。
  ⚠ 先读全文确认 `j.to` 的语义（时间戳字段名/单位）与 `readJournal` 的返回形状，再动手。
- **#30(plugin/model.js)**：`taskStateToJobState` 与 `instance/model.js`、`router/ops/apps-registry.js` 三份平行实现。
  **只加注释**说明「有意平行」并交叉引用另两处（附各自文件:行），**不抽公共函数**（跨域，须三处同批）。
- **#29**：见 §3。

### P4-C-2
- **#21** `platform/os/process.js` 的 `isAlive`：**模块级导出函数**零消费者（全仓其它 `isAlive` 都来自
  `platform/os/pidlookup`，是另一实现；`app/*` 用的都是 `pidlook.get('alive')`）。
  删函数体 + 从 `module.exports` 去掉该键。⚠ **同文件 `signalProcess` 与 `killTree` 必须保留**
  （`killTree` 有直接消费者 `app/native/ops.js:8`，二者另经 `platform.processControl` 消费）。
- **#22** `platform/service/tasks.js` `cancel(taskId, reason)`：全仓零消费者（`tasks.cancel`/`.cancel(` 均无命中）。
  作业单口径「接入优先」——但本仓**不存在真实取消路径**（没有任何调用点表达取消意图），故**删除**，
  并在报告登记：「`canceled` 态自此无生产者；`plugin/model.js` 与 `ops/apps-registry.js` 的状态映射里
  `canceled → failed` 分支成为**防御性保留**」。不要顺手删那两处映射（不在你文件）。
- **#24（persist 侧）** `platform/service/token/persist.js`：删 `DEFAULT_TOKEN_FILE_NAME`、`_tokenFileName`、
  `configureTokenFileName`、`tokenFileName` 及两个导出键 + 相关头注。
  ⚠ **只改 persist.js**：`app/settings/token-kinds.js` 的调用点与 `TOKEN_FILE_NAME` 常量由 P4-C 负责人同批改
  （跨分片边界，见 §4）。你**不要**碰它，否则会留下悬空调用。
- **#27** `platform/service/log/logcore.js`：`const { createLogger, Rotator, LineBuffer } = require('./log')` ——
  `LineBuffer` 在本文件未使用（消费者是 `log.js` 自身、`app/main/process.js`、`test/core-test.js`）。
  **只从解构里去掉 `LineBuffer`**，`log.js` 的导出与类定义不动。
- **#29**：见 §3。

### P4-C-3
- **#25** `app/state/intents.js`：`has(intent)`(:36) 与 `any()`(:41) 全仓零消费者 → 删两方法
  （连带其 JSDoc）。⚠ `consume/clear/_pending` 保留（有消费者）。
- **#26** `app/control/registry.js`：`this._loaded = false`(:49) 与 `this._loaded = true`(:88) **只写不读** → 删该字段与两处赋值。
  ⚠ **`_loadedFromDisk` 是另一个字段且确有读取**（构造函数里写，另处读），**绝不可误删**；
  `platform/service/token/pool.js` 的同名 `_loaded` 是另一个类，也不可动。
  ⚠ 本文件刚被 P3-A 改过 ownership 合并（`normalizeOwnership(Object.assign({}, e.ownership, p.ownership))`），
  **不要回退**。
- **#28** `app/assembly/bootstrap.js:11` `const { registerAll } = require('../../app/control/adapters')` —— 全文件仅此一处，
  真正调用在 `compose/observers.js`。**只删该 require 行**。
  ⚠ 本文件有 **6 条心跳结构钉子**（`heartbeat-selfheal-test.js` 断言 `this._heartbeatBusy = false;`、
  `iv * 12|stallMs`、`_heartbeatStalls++`、`强制释放防停摆`、`guard && typeof guard.unref === 'function'`、
  `clearTimeout(guard)`）。**心跳代码一行都不要动**。
- **#29**：见 §3。

## 3. #29 方法（严格，防误删）

1. 静态枚举你文件里 `module.exports = { ... }` 的**每个键**（含后续 `Object.assign`/`exports.X =` 形态）。
2. 对每个键：跑 `bash release/scripts/export-consumers.sh <符号>`，并**额外**核验四类「不可删」：
   - `test/` 按**字符串或正则**引用该符号（R1：也要查注释钉子，可能断言的是源码形态）；
   - `src/api/contract.js` 的 SURFACE、或域 `*/contract.js` 的 `PUBLIC_API`/`exports`/`classApi` 是否登记；
   - 根级 `*.md` / `design-notes/` 是否把它声明为对外契约；
   - 是否为「**注入对**」的一半（app 侧调用、platform 侧内部读取注入值 —— 此时 app 调用点即消费者）。
3. 只有「排除以上四类后仍零消费者」才删**导出键**；函数体内部仍被使用则**保留函数体**。
4. 报告给全表：符号 / 文件:行 / 消费者数 / 判定（删/保留 + 一行理由）。**宁可保留**。
   ⚠ 不得照抄 `AUDIT-dead-code §四` 的 63 条旧清单 —— P2/P3 已删过一批，必须**重新枚举当前树**。

## 4. 跨分片边界（已经主控裁定，不要跨界）

- `src/app/settings/token-kinds.js`（#24 另一半）由 **P4-C 负责人**改，并**同批**与 persist.js 的删除一起提交 ——
  半删会留下悬空调用 `persist.configureTokenFileName`（TypeError）。该文件在目录上属 P4-A 声明面，主控已单独知会。
- `src/domains/instance/model.js`（#30）属 P4-A；`src/domains/router/ops/apps-registry.js`（#30）属 P4-B。
  你只加**自己文件**里的「有意平行」注释与交叉引用。
- `test/` 全员禁改。
