# WS1-c 报告：src/app 注释精简 + 死代码普查 + DG-11

> 工作流 WS1-c（负责人+主控）。范围：`src/app/**` 全部 .js，**排除 `src/app/assembly/bootstrap.js`（WS2）**。
> 依据：`design-notes/_workorder-phase2.md`（§0 硬约束 / §1 R1+R2 / §2 口径 / §5 交付物 / §7 更正）。
> 本次未运行任何测试、未做任何 git 写操作、未改 `test/` 与 `package.json`。

---

## 0. 互斥分配表（76 个文件 → 2 个下级，无重叠、无遗漏）

下级 A = `src/app/{assembly(除 bootstrap.js),audit,control,ctl,daemons,domain-actions,facade}/**/*.js`（38 个）
下级 B = `src/app/{main,native,self,session,settings,state}/**/*.js`（38 个）

| 文件 | 子代理 | 文件 | 子代理 |
|---|---|---|---|
| assembly/api-rebind.js | A | main/controller.js | B |
| assembly/collaborators.js | A | main/decide.js | B |
| assembly/compose.js | A | main/health-gate.js | B |
| assembly/compose/core.js | A | main/port-rederive.js | B |
| assembly/compose/domains.js | A | main/process.js | B |
| assembly/compose/observers.js | A | main/shadow.js | B |
| assembly/facets.js | A | main/signals.js | B |
| assembly/log-sources.js | A | native/command.js | B |
| audit/orphan-scan.js | A | native/installer.js | B |
| control/adapters.js | A | native/manifest.js | B |
| control/collaborator.js | A | native/npm.js | B |
| control/entry.js | A | native/ops.js | B |
| control/heartbeat.js | A | native/policies.js | B |
| control/instance-adapter.js | A | native/probe.js | B |
| control/managed-object.js | A | native/upgrade.js | B |
| control/manager.js | A | self/health.js | B |
| control/projection.js | A | self/lifecycle.js | B |
| control/registry.js | A | self/notify.js | B |
| control/scheduler.js | A | session/machine.js | B |
| control/specs.js | A | session/shutdown.js | B |
| ctl/client.js | A | settings/access.js | B |
| ctl/facades.js | A | settings/autostart.js | B |
| daemons/identity.js | A | settings/domain-config.js | B |
| daemons/probe.js | A | settings/env.js | B |
| daemons/process.js | A | settings/lan-panel.js | B |
| daemons/process-marks.js | A | settings/node-lts.js | B |
| daemons/process-wait.js | A | settings/token-kinds.js | B |
| daemons/runtime.js | A | settings/versions.js | B |
| daemons/scripts.js | A | state/collaborator.js | B |
| daemons/supervise.js | A | state/desired.js | B |
| domain-actions/lan.js | A | state/fields.js | B |
| domain-actions/main.js | A | state/field-tables.js | B |
| domain-actions/router.js | A | state/intents.js | B |
| facade/lan.js | A | state/main-record.js | B |
| facade/main.js | A | state/main-store.js | B |
| facade/ports.js | A | state/phase.js | B |
| facade/router.js | A | state/store.js | B |
| facade/status.js | A | state/upgrade-hold.js | B |

计数核对：A=38，B=38，合计 76；`src/app` 下无顶层 .js；排除项仅 `assembly/bootstrap.js`。

---

## 1. 改动汇总

- WS1-c 改动 **49 个文件**（A 组 13，B 组 36），净 **+102 / −171** 行。
- 其中 **47 个文件仅注释变化**；**2 个文件含经 R2 全仓核验的死代码删除**（见 §3）。
- 另有 `src/app/assembly/bootstrap.js` 出现在 `git diff` 中，属 **WS2 的 N2 心跳修复**，不在本工作流范围。
- 新增装饰符号 0；被注释掉的代码块 0；新增/删除非注释字符仅 §3 与 §4 声明项。

## 2. 改动文件清单（逐文件理由）

### A 组（13）
| 文件 | 理由 |
|---|---|
| assembly/compose/core.js | 删「（行为序与拆分前逐字一致）」过程性括注 |
| assembly/compose/observers.js | 删文件头 2 行空注释残留 |
| assembly/facets.js | 删「级 2（2026-09-17）」日期标记 |
| control/adapters.js | 删「2026-09 收敛定稿：」日期叙事；DG-11 见 §4 |
| control/entry.js | 删「此前此处自建副本与 canonical 不一致…」变更史；陈旧引用 `main-process.js` 更正为 `app/main/process.js` |
| control/instance-adapter.js | 删「逐字搬迁自 …control-view.js（纯搬迁，逻辑零改动）」过程记录（含悬空路径） |
| control/manager.js | 删冗余 `/* 注册 */` 标签 |
| control/registry.js | 删 1 行空注释；删「（2026-09-06 定稿）」「注意 P3 修复（2026-09-13）：」日期/编号 |
| control/scheduler.js | 删「§7（步骤 7）拆分：…」与「逐字搬迁自 …converge-view.js…仅做两件事」共 4 行过程记录 |
| control/specs.js | DG-11 见 §4（含去掉重复调用 `instances()`） |
| daemons/process-marks.js | 删与标题重复的 JSDoc 摘要 2 行 |
| daemons/scripts.js | 删与签名重复的 JSDoc `@param/@returns` 6 行（不变量已在文件头） |
| domain-actions/main.js | 注释去除字面量穿透写法（兼容 DG-11 判据），语义不变 |

### B 组（36）
| 文件 | 理由 |
|---|---|
| main/controller.js | 删「systemd 托管已废弃」重复叙述与 `// 收敛窗口关闭` 尾注 |
| main/health-gate.js | 删单向依赖叙述与重复 `@returns` |
| main/port-rederive.js | 删「复用 config.extractPortFromCommand…」与「切面装配…」过程记录 |
| main/process.js | 删 DF-2/DF-3 拆分叙述；删 6 处「影子 actual 记账」重复尾注与 1 处分隔线 |
| main/shadow.js | 删 `// 已记账` 冗余尾注 |
| native/command.js | 删与模块名重复的职责罗列 |
| native/installer.js | 删「职责拆分：…」文件清单叙述 |
| native/manifest.js | 删依赖行与重复 `@param` |
| native/npm.js | 删依赖行与重复 JSDoc 摘要 |
| native/ops.js | 删依赖行；删 2 处重复的「并发锁…」注释中的 1 处（另 1 处保留，见 §5） |
| native/policies.js | 删依赖行与 4 处复述签名的 JSDoc 摘要 |
| native/probe.js | 删依赖行与 4 处复述签名的 JSDoc 摘要（`恒为 null` 语义在 :70 保留） |
| native/upgrade.js | 删依赖行、3 处复述 JSDoc；删死导出 `PKG_DEFAULT`（见 §3） |
| self/health.js | 删 2 处复述函数的 JSDoc 摘要 |
| self/lifecycle.js | 删 1 处复述函数的 JSDoc 摘要 |
| self/notify.js | 删与模块名重复的文件头 |
| session/machine.js | 删文件头与 `deps` 逐项罗列（复述构造签名） |
| session/shutdown.js | 删未使用导入 `registerAll`（见 §3）；删 3 处复述步骤的注释（`glob 不经 shell` 陷阱句仍在，见 §5） |
| settings/access.js | 删文件头与 2 处复述方法的 JSDoc 摘要 |
| settings/autostart.js | 删与实现重复的接口说明 2 行 |
| settings/domain-config.js | 删逐字搬迁移述与 2 处换名史注释 |
| settings/env.js | 删文件头与 4 处复述视图来源的注释 |
| settings/lan-panel.js | 跨平台差异说明由 4 行压成 2 行（保留「Linux 专有 / macOS-Windows 抛异常被吞 / netinfo 三平台」要点） |
| settings/node-lts.js | 删文件头与重复 JSDoc 摘要（「避免守卫启动依赖网络」保留） |
| settings/token-kinds.js | 删 3 处「逐字未改」搬迁移述 |
| settings/versions.js | 删文件头、拆分携带注释与 2026-09-13 日期标记；A3 语义注释保留 |
| state/collaborator.js | 删文件头与 `deps` 逐项罗列 |
| state/desired.js | 删文件头与 3 处复述方法的 JSDoc 摘要 |
| state/field-tables.js | 删文件头与 re-export 叙述 |
| state/fields.js | 删 3 处复述映射方向的 JSDoc 摘要 |
| state/intents.js | 删文件头与 5 处复述方法的 JSDoc 摘要 |
| state/main-record.js | 删文件头与 3 处复述读写语义的 JSDoc 摘要 |
| state/main-store.js | 删文件头、`deps` 罗列与 2 处复述路径的 JSDoc 摘要 |
| state/phase.js | 删 2 处复述映射的 JSDoc 摘要 |
| state/store.js | 删文件头与 2 处复述实现史/行为的注释（`内容未变不写盘` 语义由代码自明） |
| state/upgrade-hold.js | 删文件头与 `deps` 罗列 |

## 3. 死代码与导出变更（R2 全仓核验）

| 变更 | 文件 | 全仓核验证据 | 结论 |
|---|---|---|---|
| 删 `const PKG_DEFAULT` 及其导出，`module.exports` 由 `{ upgrade, PKG_DEFAULT }` 改为 `{ upgrade }` | native/upgrade.js | `git grep PKG_DEFAULT` 仅命中：(a) `native/ops.js:12,89,179,181` 的**自有同名局部常量**（与 upgrade.js 无 import 关系）；(b) `design-notes/_r5-app-api-P3.md:50`「ops.js 使用」——该保留理由的事实前提不成立。`test/`、`bin/` 零消费者 | 删除安全（独立复核） |
| 删未使用导入 `const { registerAll } = require('../../app/control/adapters')` | session/shutdown.js | `adapters` 另由 `assembly/bootstrap.js:11`、`assembly/compose/observers.js:8` require（`observers.js:41` 使用）；`adapters.js` 无顶层副作用；`test/` 各自直接从 adapters require | 删除安全（独立复核） |

除此之外**无**导出/函数/常量删除。R2 逐符号核验后「零外部消费者导出」= 0。

## 4. DG-11 追加任务（主控亲办）

| 位置 | 改动 | 依据 |
|---|---|---|
| control/adapters.js:98 | `(instances && instances.instances) || []` → `(instances && typeof instances.all === 'function' && instances.all()) || []` | 改用 instance 域契约 `all()` |
| control/specs.js:90 | 先取 `const _m = instances();`，再 `(_m && typeof _m.all === 'function' && _m.all()) || []`（原式重复调用 `instances()`） | 同上；`:46` 的 `const im` 在另一函数，未混用 |
| domain-actions/main.js:6,42 | 注释中的字面量穿透写法改为「实例域的内部数组」，语义不变 | 规避 WS3 收紧后的判据形态 |

核验：`all()` 实存于 `src/domains/instance/index.js:51`（`all() { return this._store.instances; }`，与旧 getter 同返回活数组）。改后 `grep -rnE '\binstances\s*(\(\s*\))?\s*\.\s*instances\b' src/app` = **零命中**。

## 5. 形式钉子保留项（R1）

**被测试硬匹配、原样保留**：
- `control/entry.js:19` 与 `:96` 的「静默丢弃」——`test/phase-vocabulary-test.js:85` 对 entry.js 全文断言 `/静默丢弃/`（行注释与块注释两处都在）。
- `control/manager.js` 的「模块不可启停」代码字符串（:46/:59/:71）一行未动——`test/session-lifecycle-test.js:223` 运行时断言 `/不可启停/`。
- `native/ops.js` 的 `if (exitCode === 0) {\n rm(host.manifestFile)` 结构、`保留 manifest`（:222）、`可重试`（:226）——三者均为**代码字符串**，本就不属注释精简范围（§7 更正确认）。
- `native/probe.js:70`「恒为 null」整句保留。
- `state/fields.js` 含 `_mPhase` 的整句保留（token-contract-gate / adopt-token-reclaim 引用该标识符）。
- `main/port-rederive.js`「切面装配」、`main/controller.js`「接管既有实例」、`session/machine.js`「INV-S1」/「契约 §6」、`native/ops.js`「glob 不经 shell 不展开」等短语保留。

**主控独立复核（R1 全域扫描，非仅抽样）**：将 49 个文件 diff 中**全部被删注释行**拆成 224 个「≥4 字 CJK」与 91 个「≥10 字符 ASCII」候选串，逐个 grep `test/`；仅 2 个候选落在**断言型**行（`不拖住进程退出`、`兜底释放`），二者均只出现在 `heartbeat-selfheal-test.js` 的 check **名称**里，实际断言是 `/guard && typeof guard\.unref === 'function/`、`/this\._heartbeatBusy = false;/`、`/iv \* 12|stallMs/`、`/_heartbeatStalls\+\+/`、`/强制释放防停摆/`、`/clearTimeout\(guard\)/` —— 均在 bootstrap.js 现值 :63/:66/:67/:69/:73/:77 逐条命中（该文件属 WS2，已同步转告）。

## 6. node --check

`src/app` 下全部 **50** 个改动文件（含 bootstrap.js）逐个 `node --check`：**failures = 0**。
下级 A：38/38 通过；下级 B：38/38 通过。

## 7. CI 风险点

| 风险 | 评估 | 处置 |
|---|---|---|
| 注释删除命中某测试的匹配串 | **已系统性排除**（§5 独立复核：224 CJK + 91 ASCII 全扫，断言型命中仅 2 处且为 check 名称） | 无 |
| 删 `PKG_DEFAULT` 导出（先例 f410a3a） | 低：ops.js 自有同名常量、test/bin 零消费者 | 若红，单独回退 1 行 |
| 删 shutdown.js 未使用 `registerAll` 导入 | 低：adapters 另有两处加载点、无顶层副作用 | 保留 |
| instance-adapter.js 删除行含泛化字面量 `daemon`（下级 A 自设门禁误报） | 已人工证伪：该测试对本文件唯一读取是 `/entry\.guardian !== true/` | 保留 |
| DG-11 判据当前 `strip()` 会剥离注释（已核实 domain-structure-gate-test.js:79-94），故注释内旧写法本不触发；改为无字面量形态是防御 WS3 收紧 | 无 | 无 |
| WS2 的 bootstrap.js 注释删除含 `不拖住进程退出` | 断言实为代码形态，B 值已验证齐全 | 已转告主控 |

## 8. 约束遵守声明

未运行任何测试（仅 `node --check` / `grep` / `read` / `wc` / 只读 git）；未做任何 git 写操作；未改 `test/`、`package.json`、`CHANGELOG.md`、`ACCEPTANCE-STANDARD.md`、`.github/`；未改独占集外任何文件；本报告不含操作者绝对路径。
