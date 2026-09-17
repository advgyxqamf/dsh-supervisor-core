# P4-C-1 交付报告（plugin + shell）

> 工作流：P4-C-1（作业单 `_workorder-phase4.md` §3 P4-C；分片 `_p4-c-shards.md` §1/§2/§3）
> 独占范围：`src/domains/plugin/**`（18 个 .js）+ `src/domains/shell/**`（6 个）
> 任务：#3、#13、#14、#30(plugin/model.js)、#29(本区导出) + 主控追加 F9
> 改动：**4 个文件，+52 / −8**；未改 `test/`、未改其它目录、无 `require`/无内存冒烟/无 git 写。

---

## 0. 结论速览

| 积压# | 位置 | 处置 |
|---|---|---|
| #3 | `plugin/market.js` | 后台刷新分支补 `.catch`（消除 unhandledRejection）；`getIndex` 的 reject 契约**刻意保留**（有消费者，见 §1.1） |
| #13 | `plugin/updater.js` | **两处**写入点都改为「仅 `latest !== null` 才写缓存」（原任务只点名 :23，:58 是同类第二处） |
| #14 | `shell/watchdog.js` | 未确认账本加时效（用 `j.startedAt`，与 `phaseMaxAgeMs` 同源）；缺/不可解析时间戳⇒未陈旧（保 N-d） |
| F9（追加） | `shell/watchdog.js:62` | 补 `phaseStaleWarned = false;`，与 journal 侧对称 |
| #30 | `plugin/model.js` | 只加「有意平行」注释 + 交叉引用（不抽公共函数） |
| #29 | 24 个文件的全部导出键 | **零删除**：逐键核验后全部存在真实消费者/契约登记；发现 EX 工具 4 例假阴性（§4） |

---

## 1. 逐项改动

### 1.1 #3 `plugin/market.js` — 后台刷新无 `.catch` → unhandledRejection

**缺陷**：`_refreshIfStale()` 的 `this._inFlight = this.buildIndex().finally(...)` 无人 `await`；
`buildIndex()` 抛错时该 promise 无消费者 = 进程级 unhandledRejection。

**改动（最终形态，`market.js:71-103`）**：抽出 `_startBuild()`，由 `getIndex` 与 `_refreshIfStale` 共用，
并**同时**满足两条不变量：

```
_startBuild() {
  const raw = this.buildIndex();
  raw.catch(() => {});                                    // (a) 标记已处理：无人 await 时否则是 unhandledRejection
  this._inFlight = raw;
  raw.then(() => {}, () => {}).then(() => { if (this._inFlight === raw) this._inFlight = null; });
  return raw;                                             // (b) 交给消费者的是**原始** promise，如实 reject
}
```

- **(a)** 防 unhandledRejection 靠「挂一个 no-op handler 标记已处理」，**不是**把 promise 消化掉；
- **(b)** 消费者拿到 `raw`，失败仍 reject → `api/domains/plugins.js` 的 GET /plugins/market 分支照旧回答 **500**。
- `_refreshIfStale` 额外接一个 `.catch(warn)`（后台失败不静默）；`getIndex` 返回 `raw`。

**⚠ 对 `_shards.md` 规格的一处有意偏离，且主控已复核确认「你对、我的指令过宽」**：shard 原话要求
`getIndex` 也加 `.catch`。但 `getIndex` 的返回值**由调用方消费且依赖其 rejection**
（`api/domains/plugins.js` 的 GET /plugins/market：`getIndex(force).then((r) => send(200, r), (e) => send(500, { ok: false, error: e.message }))`）。
若消化 `getIndex` 的 promise，构建失败会变成 `send(200, undefined)`（空体 200、丢失错误文案），相对 500 是**行为倒退**。

**⚠ 主控随后指出的窄竞态（已修，非登记）**：初版只给 `_refreshIfStale` 加 catch 时，存在
「后台刷新（TTL 到期）与并发 `?refresh=1`」的交错 —— force 请求会在 `if (this._inFlight) return this._inFlight;`
拿到**已消化**的 promise，失败时 resolve 成 `undefined` → **200 + 空体**（假成功）。
最终形态因 `_inFlight` 存的是 `raw`（如实 reject）而**同时消除**该竞态；清引用处用 `if (this._inFlight === raw)` 防误清后来者。

**行为变更**：新增「后台刷新失败」warn 一条（此前是进程级 unhandledRejection）；`getIndex` 的 reject 契约与 500 回答**不变**；
并发 force 请求在后台刷新失败时由「200 空体」纠正为 **500**（假成功→如实失败）。

### 1.2 #13 `plugin/updater.js` — 失败结果被 6h 负缓存

**改动**（两处同口径）：
- `checkUpdates`：`updater.js:23` → `if (latest !== null) ctx._updCache[p.name] = { latest, at: Date.now() };`
- `update`：`updater.js:59` → `if (latest !== null) ctx._updCache[name] = { latest, at: Date.now() };`

:58 是**同类第二处写入点**（原清单只点名 :23）：`update()` 取最新版失败时同样会把 `{latest:null}` 缓存 6h，
使随后 `checkUpdates` 一律显示「无更新」且不再重试 —— 按 P3 教训（同一类缺陷的未覆盖调用点）一并收口。

**行为变更**：取失败不再写缓存（`meta.set` 与本次返回值不变）；效果是失败后**下次会重试**而非负缓存 TTL。

### 1.3 #14 `shell/watchdog.js` — 未确认账本无时效上限

**事实核验（我读源得出，与主控澄清一致）**：
- `j.to` 是**目标版本串**（`journal.js:56` `j.to = to`；测试用 `'9.9.9'`），**不是**时间戳；
- 账本时间戳只有 `startedAt`（ISO 串，`journal.js:58` `markPending` 写入）；
- `lastAttemptAt` 只在 `journal.js:47` 的默认形状里声明，**全仓无写入点**（`grep -rn lastAttemptAt src` 仅该默认行），不可依赖。

**改动**（`watchdog.js:36-40, 72-103, 125, 193`）：
- 新增 `journalStale`/`journalStaleWarned` 两个状态 + `updateJournalTracking(t)`（由 `tick()` 在 `updatePhaseTracking(t)` 之后每拍调用，**与相位侧同构**）；
- `expectedAbsence()` 保持**只读无副作用**（该函数头注既有约束「只读快照」）：读每拍算好的 `journalStale`，
  `if (j && j.to && !j.confirmed) return !journalStale;`
- 判据：`t0 = Date.parse(String(j.startedAt || ''))`；`maxAge = config.shellWatchdogPhaseMaxAgeMs || DEFAULTS.phaseMaxAgeMs`（与 :62 相位侧**同一取值来源**）。
- **缺/不可解析 `startedAt` ⇒ `journalStale = false`（未陈旧）**，保持「未确认账本 → 预期缺席」既有语义
  —— 这是为 `test/watchdog-phase-freshness-test.js:106-113`（N-d）保留的：该测试的账本桩 `{ to: '9.9.9', confirmed: false }` **无 startedAt**，若判为陈旧则 N-d 立即转红。
- 陈旧时按 `phaseStaleWarned` 同模式 warn 一次（不静默）；离开该状态时两标志一并复位（`journalStaleWarned = false`）。

### 1.4 F9（主控追加）`shell/watchdog.js:62`

`if (!inUpdate) { expectedSince = null; phaseStale = false; return; }` → 补 `phaseStaleWarned = false;`。
修前「陈旧相位」warn **一辈子只发一次**，与该文件 :50-54 注释自称「离开即复位」不符。
修后与 journal 侧完全对称（两处 warned 标志都在离开各自状态时复位，`_reset()` :193 亦双双复位）。

**行为变更声明**：修后「陈旧相位」warn 可在每次**离开更新相位后重新触发**（可观测性变好，无功能副作用，不改变 decide 的分支）。

### 1.5 #30 `plugin/model.js` — 平行实现加注释（不抽公共函数）

`taskStateToJobState` 上方补注释：标注**有意平行** + 交叉引用另两处（`domains/instance/model.js:9` `taskStateToView`；`domains/router/ops/apps-registry.js:139` 内联三元），
并写明「改动语义必须三处同批」。**未抽公共函数**（跨域，须三处同批改造）。

---

## 2. R1（形式钉子）证据

- **改前**：逐行读了会读这四个文件的在链测试 —— `market-budget-test.js`（:100-108 钉 `_budgetExhausted()` 在 `slice(` 之前、`finally { this._deadline = 0; }`）、`shell-safety-net-test.js:92`（`!/\.rolledBack/` 于 watchdog.js）、`platform-capability-audit-test.js:150-153`（watchdog.js+core.js 聚合读，钉 `decide`/`sessionAvailable`/`maxRestarts`）、`watchdog-phase-freshness-test.js`（N-a..N-f 行为断言 + N-d 账本语义）。以上**均未被我的改动触碰**。
- **新增注释 token 回扫**：把 diff 的 52 行新增文本切 token ——
  - CJK **≥6 字** 41 个 → `grep -rl` 于 `test/` **命中 0**；
  - ASCII **≥10 字符** 22 个 → 11 个在 `test/` 有命中，逐条核实：`buildIndex/checkUpdates/expectedSince/phaseMaxAgeMs/shellWatchdogPhaseMaxAgeMs/updateGraceMs/readJournal/updatePhaseTracking` 同时也是**代码标识符**（CP 判据是「命中原文且不命中剥注释」，代码命中即不构成注释钉子）；
    `TaskRegistry` 在 `plugin/model.js` 原本就只出现在注释里（我的改动**未新增**该 token 的注释属性）；
    仅两个 token **只出现在我新增注释中**，已单独证伪：
    - `unhandledRejection` → 唯一测试 `round13-dropped-result-test.js` 对 `market` 的引用数 **0**（不读 market.js），且其为 `process.on('unhandledRejection', ...)` 字符串而非作用于源码的正则；
    - `markPending` → 唯一测试 `shell-safety-net-test.js` 是**行为调用**（`shell.markPending(...)` :57/:69）与注释，**无正则字面量**作用于 watchdog.js。
    两者均不落入 CP-1/CP-5（后者要求「原文命中、剥注释不命中」）。
- **未删除任何被测试匹配的注释行**（本批无注释删除，只有新增）。

## 3. R2（#29）证据：本区导出全表 —— 结论：**零删除**

方法：按 `_p4-c-shards.md` §3 —— 静态枚举每个 `module.exports = { ... }` 键（含多行块）+ `release/scripts/export-consumers.sh <符号>` + 四类「不可删」人工核验（test 字符串/正则、`*/contract.js` 登记、根级/design-notes 契约声明、注入对/门面转发）。
消费者数取工具「定义文件之外」计数（`src+test+bin+release+ui+docs`）。

| 文件 | 导出键（消费者数） | 判定 |
|---|---|---|
| `plugin/store/market-cache.js` | loadIndex(1) saveIndex(1) | 保留（market.js:13 命名空间调用） |
| `plugin/contract.js` | 契约声明（domain/exports/PUBLIC_API/…） | **禁改**（DG-9/DG-10 读它的 exports/PUBLIC_API） |
| `plugin/store.js` | readProfile(2) readManifest(2) readHomePatch(3) overlayEntries(2) inventory(5) installedOn(7) listInstalled(6) PluginStore(2) | 保留（index.js:12 / layers.js:11 / ops.js:8） |
| `plugin/index.js` | PluginManager(15) PluginMarket(9) PROTECTED(9) | 保留（contract `exports` 逐字登记） |
| `plugin/cli.js` | registryOrigin(1) runCli(1) | 保留（index.js:68 `cli.runCli`/`cli.registryOrigin`） |
| `plugin/market.js` | PluginMarket(9) | 保留（compose/domains.js:13、index.js:20） |
| `plugin/targets.js` | nativeTarget(2) **sandboxTarget(0\*)** **allSandboxTargets(0\*)** resolveTargets(10) | **全部保留**（\*工具假阴性；实际消费者 index.js:42-45） |
| `plugin/layers.js` | createLayers(2) | 保留（index.js:17） |
| `plugin/restart.js` | **targetRunning(0\*)** **applyPluginChange(0\*)** | **全部保留**（\*假阴性；index.js:70-71） |
| `plugin/policies.js` | isProtectedName(6) assertSafeCliArgs(2) specType(8) isUpdateAvailable(2) isOwnRow(4) isOwnDisabled(4) ownerPackage(4) targetHomePatchPath(6) cliArgv(2) | 保留（cli.js:15 / ops.js:7 / updater.js:7 + 再导出面） |
| `plugin/policies/classify.js` | classify(8) pickAuthor(5) | 保留（market.js:12、market-entry.js:5） |
| `plugin/policies/market-entry.js` | npmEntry(2) githubEntry(2) | 保留（market.js:14） |
| `plugin/model.js` | PROTECTED(9) createJobRecord(3) finishJobRecord(3) planJobCleanup(3) taskStateToJobState(4) isProtectedName(6) isOwnRow(4) isOwnDisabled(4) ownerPackage(4) targetHomePatchPath(6) | 保留（store.js:14 `{PROTECTED, ownerPackage, targetHomePatchPath}`；policies.js:8 再导出 5 个；jobs.js 用 job 三函数） |
| `plugin/ops.js` | install(181) uninstall(69) listInstalled(6) | 保留（index.js:18 命名空间 :51/:73/:74） |
| `plugin/market-net.js` | getJson(8) getText(6) | 保留（market.js:10 `{getJson}`；**market-sources.js:7 `{getJson, getText}`** —— `getText` 有显式解构消费者） |
| `plugin/updater.js` | checkUpdates(3) update(179) | 保留（index.js:19 :76/:77） |
| `plugin/market-sources.js` | rawGet(3) fetchLatest(2) repoPkg(2) | 保留（market.js:11） |
| `plugin/jobs.js` | createJobs(2) | 保留（index.js:16） |
| `shell/core.js` | DEFAULTS(29) isShellProcess(17) decide(18) isUpdatePhase(5) exeFromCmdline(5) deriveState(5) | 保留（watchdog.js:13 / restart.js:13 / journal.js:16 / 在链测试） |
| `shell/contract.js` | 契约声明 | **禁改**（同上） |
| `shell/index.js` | status evaluate health markPending identity readJournal shellDir checkUpdate restartShell SHELL_RELEASE_PKG | 保留（contract `exports`/`PUBLIC_API` **逐字**登记；supervisor/看护消费） |
| `shell/restart.js` | SHELL_RELEASE_PKG(5) checkUpdate(19) restartShell(16) | 保留（index.js:21） |
| `shell/journal.js` | shellDir(8) identity(104) readJournal(7) markPending(12) evaluate(9) health(61) status(475) | 保留（index.js:11-19 逐字解构 7 个全用） |
| `shell/watchdog.js` | createShellWatchdog(7) | 保留（bootstrap.js:11 + 在链测试） |

**高计数符号（status/update/install/health/identity 等）含同名噪音**，但它们同时是门面/契约面（`shell/contract.js` 或 `plugin/contract.js` 登记），按 §3.2 第 2/4 类**保留**。
**登记不删**：`createShellWatchdog()` 返回对象上的 `_reset` —— 唯一消费者是测试，工具复核「定义文件之外 = 0」；它经返回对象暴露（属导出面），按主控裁定**只登记、不删**（`watchdog.js:193`）。

## 4. ⚠ 重要发现：`export-consumers.sh` 对「门面转发」假阴性

工具把**门面里那一行也当成定义行**（方法名 `_xxx` 含 `xxx` 子串，定义行识别是子串匹配），
于是门面文件被列入「定义文件」，**其真实消费点被从外部消费者剔除** ⇒ 误判「可删」。四例（均实际有消费者）：

| 符号 | 工具结论 | 真实消费者（原始 `grep -rn`） |
|---|---|---|
| `sandboxTarget` | 可删 | `plugin/index.js:44` `_sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }` |
| `allSandboxTargets` | 可删 | `index.js:45`；`updater.js:11` `ctx._allSandboxTargets()`；`test/plugin-change-restart-test.js:74` |
| `targetRunning` | 可删 | `index.js:70`；`layers.js:204/206`；`ops.js:41`（均经 `ctx._targetRunning`） |
| `applyPluginChange` | 可删 | `index.js:71`；`ops.js:113`；`updater.js:100`（均经 `ctx._applyPluginChange`） |

⇒ 若照工具结论删键，这四个会立即令 plugin 域运行期 undefined（CI 必红）。**已按 §3「宁可保留」全部保留**，
并已把该工具缺陷上报主控（建议其它分片凡见「可删」再用原始 grep 复核；建议工具把定义行识别改为「行首/空白后紧跟 `function|const|let|class` 声明或 `module.exports` 键位」）。

## 5. CI 风险

1. **低**。4 文件仅 `node --check` 通过、无导出增删、无 `test/` 改动。
2. `market.js` 两处既有源码形态钉子未动（`market-budget-test.js:100-108` 的 `_budgetExhausted()` 先于 `slice(`、`finally { this._deadline = 0; }`）。
3. `watchdog.js` 的 N-a..N-f 与 W1/W3 系列：新增 `updateJournalTracking` 只在**有 `j.to` 且未确认**时影响返回值；N-d 的桩无 `startedAt` ⇒ 仍 true（已按此设计）；默认 `{to:null}`（`shell-watchdog-test.js:65`）走不到该分支。
4. F9 只影响「离开更新相位后再进入」时的 warn 频次，不改变 `decide()` 输入。

## 6. 未做 / 需主控裁决

- §1.1 对 `getIndex` 不加 `.catch` 的**有意偏离**（理由与证据见上）：若主控坚持按 `_shards.md` 字面同时改 `getIndex`，需**同批**接受 `api/domains/plugins.js` 的 500 回答退化为 200/空体，或同批改该 API 的失败分支 —— 我未擅动（`api/` 不属本分片）。
- #29 结论为**零删除**（与旧审计「63 条未用导出」的预期不同）：P2/P3 已删过一批，且本区剩余键全部有真实消费者/契约登记。未照抄旧清单。
