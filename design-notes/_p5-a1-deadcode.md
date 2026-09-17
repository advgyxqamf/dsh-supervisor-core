# P5-A-1：两项死代码判定与落地报告

> 范围：仅 `src/domains/instance/upgrade.js`、`src/domains/shell/watchdog.js`。
> 遵 P5 作业单 §0 与 P4 作业单 §0/§1（硬约束 + R1/R2 四条补强）。
> **未跑任何测试/门禁；未 `require` 产品模块；未做任何 git 写；未改 `test/`。**

## 0. 文件互斥分配

| 执行者 | 文件面 |
|---|---|
| P5-A-1（本报告） | `src/domains/instance/upgrade.js`、`src/domains/shell/watchdog.js` |
| P5-A（主代理） | `src/api/domains/router.js`（A6） |

本下级未触碰 `router.js`。

---

## 1. 任务 1：`inst.state.version` 死赋值（upgrade.js 原 :156 / :168）

### 1.1 改动
- 删除**回滚路径原 :156** 与**成功路径原 :168** 的
  `inst.state.version = readInstalledVersion(inst);` 两处赋值。
- 在原**首次出现处**（现 :156-157）新增两行注释，说明为何不落该字段，防止后人重新加回。

### 1.2 证据（静态复验）
1. **写入面**：`grep -rn 'state\.version' src test bin` → 改动前仅 upgrade.js 两处赋值；改动后仅剩注释行（`:156`）。
2. **声明形状**：`src/domains/instance/model.js` 的 `createRecord()` 产出
   `state: { phase, restartCount, backoffLevel, lastProbeOk }`，**不含 `version`** ⇒ 该字段是升级后才出现的**未声明额外字段**。
3. **视图层版本是实时读盘**：`upgrade.js` 的 `versionInfo()` → `readInstalledVersion(inst)`；
   `inst.state` 在 src 内仅被 `phase` 消费（`app/control/instance-adapter.js`、`app/control/specs.js`、
   `app/session/shutdown.js`、`domains/instance/state-machine.js`、`domains/instance/ops/dsh-install.js`），
   **无任何 `state.version` 读取**。
4. **跨仓核验**：`../dsh-supervisor-launcher` 存在（含 `src-tauri`）。对其源码
   （`--include=*.rs/ts/tsx/js/jsx/json`，排除 `node_modules`/`target`/`.git`）
   grep `instances` 与 `state\.version` → **均零命中**，壳仓不依赖该字段。
5. **持久化路径**：`instance/store.js` 的 `save()` 用 `JSON.stringify({ instances })` 整对象落盘，
   故此前该赋值会把 `state.version` 写进 instances.json；删除后不再写入（见行为变更）。
6. **反证**：未发现 `Object.keys(inst.state)` 或对 `inst.state` 做展开/通用遍历的消费点。

### 1.3 行为变更
- 升级实例后，持久化的 instances.json 中 `state` **不再新增 `version` 键**；
  旧文件里既存的历史 `version` 键不会被主动清理，仍随对象原样落盘，但下次升级不再刷新它。
- 内存中 `inst.state.version` 不再被写入；对外 API 的版本值仍走
  `versionInfo`/`readInstalledVersion` 实时读盘路径，UI `it.version` 不变。
- **无**状态码/日志/返回契约变化。

### 1.4 R1 注释 token 检查
新增注释拆分为：
- CJK（`grep -oP '\p{Han}{4,}'`）：`全仓无读取`、`实时读盘`、`额外字段只会污染`。
- ASCII（≥6 字符）：`inst.state.version`、`readInstalledVersion`、`versionInfo`、`model.createRecord`、`instances.json`。

逐个在 `test/` grep：
- **零命中**：`全仓无读取`、`实时读盘`、`额外字段只会污染`、`inst.state.version`、`readInstalledVersion`、`model.createRecord`。
- **命中（保留该 token、登记）**：
  - `versionInfo` → `test/api-contract-test.js:26`、`test/core-test.js:99`、`test/upgrade-test.js:187`
    （三处均为 API/装配字段，与注释语义无关；注释保留该 token，不删改）。
  - `instances.json` → `test/ports-verify.js:42`、`test/token-boundary-test.js:86/88`
    （测试按落盘文件名处理，与注释语义无关；注释保留该 token）。

结论：新增注释不删除任何 `test/` 依赖 token；无需改 `test/`。

### 1.5 CI 风险
- 若某测试断言 instances.json 或内存实例存在 `state.version`，删除会转红。已复核：
  `test/` 内 `state.version` / `inst.state.version` grep 命中 **0** ⇒ 风险 0。
- `ports-verify.js`/`token-boundary-test.js` 只按**文件名**处理 instances.json，不校验 `state` 键。

---

## 2. 任务 2：`watchdog._reset()` 零消费者（watchdog.js 原 :193 定义 / :195 导出键）

### 2.1 改动
删除三部分：
1. 原 :192 的 JSDoc `/** 仅供测试：重置内部状态。 */`；
2. 原 :193 的 `function _reset() {...}` 整个函数体；
3. 原 :195 返回对象中的 `_reset` 导出键（现行为 `return { tick, status, intervalMs: ... }`）。

**选择「函数体 + JSDoc + 导出键全删」的理由**：删掉导出键后，该函数在其闭包内已无任何引用，
保留即新增一段闭包内死代码；其 JSDoc 自称「仅供测试」但实测无任何测试使用，留着会继续误导后续读者。
故整体删除比"只删导出键、留函数体"更干净。

### 2.2 证据（原始 grep + 契约表复核，R2 四条补强）
1. **原始全仓 grep**（`--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=ui-react`，
   滤掉**不同符号** `_resetCache`/`_resetForTest`）：
   改动前仅 watchdog.js:193（定义）与 :195（导出键）；其余命中全在 `design-notes/` 与 `HANDOFF.md` 散文。
   **`test/` = 0、`bin/` = 0**。改动后同口径 grep：代码面零命中（仅剩散文引用）。
2. **契约表比对（R2 第三条）**：`EXECUTION-CONTRACT.md` 与 `src/domains/shell/contract.js` 均**无 `_reset`**；
   `contract.js` 的 `exports`/`PUBLIC_API` 是逐字冻结的 10 项
   （status/evaluate/health/markPending/identity/readJournal/shellDir/checkUpdate/restartShell/SHELL_RELEASE_PKG）。
3. **符号层级**：`_reset` 是 `createShellWatchdog()` **返回对象**上的属性，
   **不是** `module.exports` 的键（`module.exports = { createShellWatchdog }`），
   故 DG-9（契约 exports ≡ module.exports 字面键）不受影响。
4. **返回立面其余键不变**：`{ tick, status, intervalMs }`；`tick`/`status`/`intervalMs` 语义未改。
5. **F9 语义不受影响**：`phaseStaleWarned`/`journalStaleWarned` 已在**离开对应相位/状态时**复位
   （`updatePhaseTracking`/`updateJournalTracking`），`_reset` 并非唯一复位点。

### 2.3 行为变更
- `createShellWatchdog()` 的返回对象不再有 `_reset` 成员（属性消失）。
- 无其他运行时行为变化；`tick`/`status` 返回结构与判定逻辑不变。

### 2.4 R1 注释 token 检查
删除的 JSDoc 拆分：
- CJK：`仅供测试`、`重置内部状态`（`grep -oP '\p{Han}{4,}'`）。
- ASCII：无 ≥6 字符 token。

逐个在 `test/` grep → **均零命中** ⇒ 可删，无需保留该注释行。

### 2.5 CI 风险
- 无测试引用 `_reset`（`test/` grep = 0）；
  `test/shell-watchdog-test.js`、`test/watchdog-phase-freshness-test.js` 仅用 `tick`/`status`。
- `design-notes/shell.md`、`design-notes/_p4-c-*.md` 仍有 `_reset` 散文引用，属**文档陈旧**，
  不是门禁判据（`test/` 不读这些文件）。建议主代理在文档收口批处理，不在本文件面。

---

## 3. 验收

- `node --check src/domains/instance/upgrade.js` → **OK**
- `node --check src/domains/shell/watchdog.js` → **OK**
- `git diff --stat`（只读）：upgrade.js `4 +2/-2`、watchdog.js `5 +1/-4`；仅动这两个文件。
- 未跑测试/门禁；未 `require` 产品模块；未 git 写；未改 `test/`；未新增 `scripts.test` 条目。

## 4. 遗留

1. instances.json 中**既存的历史 `state.version` 键不会被清理**（仅停止刷新）。
   若需彻底清除，应另派「state 形状归一化」任务并需产品确认；本报告不做。
2. `src/domains/instance/ops/dsh-install.js` 仍写 `state.installAt`/`installOk`/`installError`/`installLog`
   等未声明额外字段，其中 `installLog` 注释自称「仅作前端镜像」。是否为同类死值**超出本下级文件面**，
   本次未复核，交主代理/后续批次判定。
