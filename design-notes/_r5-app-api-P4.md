## P4 app 编排层：facade / domain-actions / main / state

范围（独占）：`src/app/facade/`、`src/app/domain-actions/`、`src/app/main/`、`src/app/state/`（共 25 个 .js）。
约束遵守：未运行任何测试/门禁/夹具；只做 `node --check`、grep、read、git diff；未启动任何进程；未 commit；未改 package.json。

### 改动清单

| 文件 | 性质 |
| --- | --- |
| src/app/facade/lan.js | 注释精简 |
| src/app/facade/main.js | 注释精简（白名单补 exposurePeers） |
| src/app/facade/ports.js | 注释精简 |
| src/app/facade/router.js | 注释精简 |
| src/app/facade/status.js | 注释精简 |
| src/app/domain-actions/lan.js | 注释精简 |
| src/app/domain-actions/main.js | 注释精简 |
| src/app/domain-actions/router.js | 注释精简 |
| src/app/main/controller.js | 注释精简 + 审计修正（删与代码不符的 systemd 残留注释） |
| src/app/main/decide.js | 注释精简 |
| src/app/main/health-gate.js | 注释精简 |
| src/app/main/port-rederive.js | 注释精简 + 审计修正（删除重复 syncLanState 调用） |
| src/app/main/process.js | 注释精简 + 符号清理（删除未用 require） |
| src/app/main/shadow.js | 注释精简 |
| src/app/main/signals.js | 注释精简 |
| src/app/state/collaborator.js | 注释精简 |
| src/app/state/desired.js | 注释精简 |
| src/app/state/fields.js | 注释精简 |
| src/app/state/field-tables.js | 注释精简 |
| src/app/state/intents.js | 注释精简 |
| src/app/state/main-record.js | 注释精简 |
| src/app/state/main-store.js | 注释精简 |
| src/app/state/phase.js | 注释精简 |
| src/app/state/store.js | 注释精简 |
| src/app/state/upgrade-hold.js | 注释精简 |

代码改动仅 2 处（其余全部为注释行，已用逐行 diff 分类核验）：

1. `src/app/main/process.js` 删除 `const platform = require('../../platform/os/index');`。
   证据：`grep -n '\\bplatform\\b' src/app/main/process.js` 仅命中 4 行 require 路径（spawn/pidlookup/log/index），
   标识符 `platform` 在文件体内 0 次引用（拆分 port-rederive 后的遗留）；同模块 signals.js 已 require 同一门面，加载行为不变。
2. `src/app/main/port-rederive.js#applyMainPort` 删除重复调用
   `try { if (host.daemons.enabled()) host.daemons.syncLanState(); } catch {}`。
   证据：紧邻其后第 70 行已有无条件 `try { host.daemons.syncLanState(); } catch {}`，
   前者是后者的真子集（enabled 时后者必执行），属完全冗余；保留无条件调用，行为等价。

### 死代码与删除依据

未用导出：**无**。25 文件导出面（methods / 工厂函数 / 常量）逐一全仓 grep（含 test/、docs、字符串形态）：

- facade methods：`listLan/frpStatus/dshMainView/exposurePeers/listPorts/routerDaemonActive/routerStatusView/routerProviders/routerStatus/routerDomainSummary/routerApi/statusSummary` —— 均被 `src/api/*`、`app/assembly/collaborators.js`（THIN_SPEC）、`ctl/facades`、`daemons/*` 或 test 引用。
- domain-actions methods：`setLanFrp/lanFrpc/syncFrpc/patchDshMain/setRouterRunning` —— 均被 `src/api/domains/*`、`control/adapters.js` 或 test 引用。
- main methods：`_dshConverge/_mainStateSnapshot/_decideMainAction/_decideCrashRestart/_bumpCrashWindow/_applyHealthCheck/_findManagedDshPort/_applyMainPort/spawnCommand/_startProcess/_enterRunning/_adoptObserved/_adopt/_beginRestart/stopProcess/_actNote/_mainActualAction/_shadowExcluded/_shadowTickNote/_shadowHeartbeatBeat/_isManagedProcess/_signalChild/_killTree/_killSequence/_killAdopted` —— 全部由 `app/assembly/facets.js` 装配，且至少被本文件内部 `this.X()` 或 `collaborators.js` THIN_SPEC 引用。
- state 导出：`createStateStore/createMainRecord/createMainStore/createFields/createStore/createDesired/createUpgradeHold/IntentLedger/legacyToEntryPhase/entryToLegacyPhase/ENTRY_FIELDS/PROC_FIELDS` —— 均被 `state/collaborator.js`、`assembly/collaborators.js`、`assembly/compose/core.js` 引用。
   **订正（P4-C 复核）**：本行原把 `INTENTS` 也列入「均被引用」，**实测不成立** —— `INTENTS` 全仓**零外部消费者**
  （只在 `intents.js` 内部被 register 校验用）；被 `compose/core.js:18/73` 消费的是 `IntentLedger`。
  该导出按「意图词表唯一出口（register 对未知 intent 抛错）」保留，但它**不是**上述三处的引用对象。

未删的误判项（保留并说明）：
- `spawnCommand`：全仓唯一文件 main/process.js，但文件内 `this.spawnCommand()` 有 3 处调用（方法内部使用），不属未用导出。
- `_mainActualAction`、`_decideCrashRestart`、`_portActives`：仅本文件内部调用，是内部实现，保留本体；不对外移除（methods 装配面不变）。
- `_signalChild`、`_killTree`：内部 + `test/process-tree-kill-test.js` 静态引用，保留。
- `facade/ports.js` `_portActives`：listPorts 内部调用，属私有方法（装配后同名），保留。

孤儿文件：**无**。25 文件全部被 `app/assembly/facets.js` FACETS 或 `state/collaborator.js` 依赖闭包覆盖。

死分支/重复实现：
- 已删：port-rederive 重复 syncLanState（见上）。
- 待裁决（未改）：`src/app/main/shadow.js#_shadowExcluded` 正则含 `port_occupied` 备选，
  全仓唯一占端口事件是 `port_occupied_unhealthy`（runtime.js:201），且该路径不触发 restart（只 warnOccupied），
  故 `port_occupied` 分支疑为不可达前缀兜底；因属防御性正则且删除会缩窄未来豁免面，仅报告不改。

### 注释统计

（注释行 = 行首为 //、*、/*、*/ 的行；总量 511 -> 360，减少 151 行）

| 文件 | 注释 改前->改后 | 总行 改前->改后 |
| --- | --- | --- |
| facade/lan.js | 16->12 | 53->49 |
| facade/main.js | 12->8 | 47->43 |
| facade/ports.js | 27->23 | 75->70 |
| facade/router.js | 27->20 | 97->90 |
| facade/status.js | 17->9 | 58->49 |
| domain-actions/lan.js | 15->11 | 51->47 |
| domain-actions/main.js | 25->16 | 71->62 |
| domain-actions/router.js | 15->11 | 51->47 |
| main/controller.js | 58->46 | 231->219 |
| main/decide.js | 22->18 | 113->109 |
| main/health-gate.js | 14->11 | 57->54 |
| main/port-rederive.js | 35->26 | 91->81 |
| main/process.js | 35->31 | 253->248 |
| main/shadow.js | 16->13 | 120->117 |
| main/signals.js | 30->22 | 90->82 |
| state/collaborator.js | 14->9 | 75->70 |
| state/desired.js | 11->7 | 85->81 |
| state/fields.js | 20->14 | 121->115 |
| state/field-tables.js | 10->5 | 39->34 |
| state/intents.js | 31->15 | 67->51 |
| state/main-record.js | 17->9 | 89->81 |
| state/main-store.js | 13->7 | 91->85 |
| state/phase.js | 12->7 | 24->19 |
| state/store.js | 10->6 | 106->102 |
| state/upgrade-hold.js | 9->4 | 80->75 |

符号清除（任务三）：注释内 ⚠/★/①/②/→/═/── 等已清除或改纯文本（`->`、`注意：`、`1)`）。
仅剩两处箭头在**代码字符串（日志文案）**中，按任务要求保留：
- main/shadow.js:74 `'（phase ' + rec.t0phase + '→' + rec.phase + '）'`
- state/store.js:90 `l.info('[main] 概念清分：main 记录已迁出 instances.json → dsh-main.json')`
装饰性 ═ 分隔线整行删除。逐文件 `node --check` 全部通过。

### 四维发现

**确认并已改：**
1. 架构 / 死代码：`main/process.js` 未用 `platform` require（拆分后遗留）——删除。
2. 业务逻辑 / 重复实现：`main/port-rederive.js#applyMainPort` 重复 `syncLanState()`——删除冗余的 guarded 调用。
3. 注释与代码不符：`main/controller.js` `desired=stopped` 分支前残留一段 systemd 时代「必须早于本分支记录 adoptedPid」的注释，
   当前分支前已无任何记录 pid 的代码，属误导性历史注释——删除（保留 `期望状态调和优先于守护开关` 的 WHY）。
4. 注释与代码不符（导出面描述）：`facade/main.js` 头注声称只读白名单仅 `dshMainView`，实际还有 `exposurePeers`（被 THIN_SPEC 与 domain-actions 引用）——已补正。

**不确定 / 待裁决（未改）：**
1. `facade/main.js#dshMainView`：`phase: typeof this._mPhase === 'function' ? this.state.phase() : undefined`
   ——判据对象（`this._mPhase`）与被解引用对象（`this.state`）不一致；正常装配下两者同在，行为无误，
   但防御分支逻辑不严谨（若 `_mPhase` 存在而 `this.state` 缺失会抛错）。改则涉代码语义，留待裁决。
2. `state/store.js#migrateMainRecord`：直读 `im.instances` 内部活数组并 `splice`（跨域内部穿透的旧形态）。
   DG-11 判据正则只匹配 `.instances.instances`（双段），此单段写法不被门禁捕获；因迁移逻辑必须就地删除旧记录
   （需可变数组），改为只读查询接口无法等价，故仅报告。
3. `facade/ports.js#_portActives`：缓存 key 用 `portsList.join(',')`，对端口顺序敏感，顺序变化即缓存失效；
   属可观测性优化非正确性问题，未改。
4. `main/shadow.js#_shadowExcluded` 的 `port_occupied` 前缀备选疑不可达（见上）。
5. `facade/ports.js` 第 40/48/49 行 role 字符串用双引号（其余文件统一单引号），仅风格，未改。

**已核验未破坏的 test 判据（只读 grep 核对，未执行测试）：**
- `test/token-contract-gate-test.js` / `test/adopt-token-reclaim-test.js`：controller.js 仍含 `switch (this.state.phase())` 与 `_dshConverge`，
  且全文件 ASCII `token` 计数 = 0（含注释）；shadow.js 保留 `_shadowExcluded(` 与 `http_unhealthy`，无 `adopt_token_reclaim`。
- `test/process-tree-kill-test.js`：signals.js 仍含 `_killTree(child`、`pc.killTree(`、`this._killTree(child, 'SIGKILL')`、
  `this._signalChild(child, 'SIGTERM')`，`_killAdopted`/`_killSequence` 函数体正则匹配。
- `test/round13-router-relay-gaps-test.js`：domain-actions/main.js 的 `validateFrpExposure` 仍先于 `this.state.writeMainMeta(meta)`。
- `test/probe-gate-and-ownership-test.js`：domain-actions/router.js 仍含 `this.daemons.disableRouterPersist();`。
- `test/domain-structure-gate-test.js` DG-14：facade 方法名未增未减，未引入写动词。
