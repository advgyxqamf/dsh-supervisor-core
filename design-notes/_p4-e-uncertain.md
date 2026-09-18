# P4-E：存疑 7 项逐路径确认（只读走查）

> 快照：HEAD `24b2fb7`（内核仓根）。**只读**：未改任何 src/test，未跑测试/门禁，未 `require` 产品模块，未 git 写。
> 工作面板：`design-notes/_p3-e-audit-backlog.md` §3.2。修法由主控另派 —— 本报告只定性 + 给最小修法落点。
> 分工：P4-E 主代理亲办 F9 / D9 / D10（§1）；下级 P4-E-1 走查 D11 / D12 / ARCHITECTURE 数字 / §5 超限（§2，已交叉核对）。

---

## 1. 主代理亲办三项

### 1.1 F9 看护陈旧相位告警只发一次 → **真缺陷（低，可观测性）**

调用链证据：
- `src/domains/shell/watchdog.js:64-67`：`if (phaseStale && !phaseStaleWarned) { phaseStaleWarned = true; warn(...); }`
- `:60`：**离开更新相位只复位 `expectedSince` 与 `phaseStale`，未复位 `phaseStaleWarned`**
- `:38` 声明 `let phaseStaleWarned = false;`
- `:167` `_reset()` 是**唯一**把它置回 false 的地方；`:169` 该 `_reset` 被导出
- 全仓消费者扫描（src/test/bin/release）：`_reset` 的消费者 **= 0**（另两处 `_resetCache`/`_resetForTest` 是不同符号）
- `:50-54` 的注释自称「离开该相位即复位」—— **实现与自述不符**

后果：告警在每个进程生命周期内**至多一次**；第二次及以后的「相位陈旧」静默。
功能面**不受影响**：`phaseStale` 每拍重算（`:63`）、离开相位即复位（`:60`），故 `expectedAbsence()`（`:75`）的宽限抑制逻辑始终正确。

最小修法（一行，落点 `:60`）：
```js
if (!inUpdate) { expectedSince = null; phaseStale = false; phaseStaleWarned = false; return; }
```
置信度：**高**（静态确定；无需运行期证据）。

### 1.2 D9 `install()` 是否缺 try/finally 释放 `installing` → **真缺陷（结构性/潜在；当前未证可达）**

结构证据：
- `src/app/native/ops.js:76`：`host.installing = true`（注释明言「必须在任何 await 之前置位」）
- 解锁点只有三个显式赋值：`:83`（取版本失败）、`:95`（`_runInstall` 返回 `!ok`）、`:105`（成功）
- 函数体 `:71-111` **无 try/finally**
- 疑点提到的 `:56 finally` **属 `checkUpdate`**（`:37` 起），与 `install` 无关
- **不对称对照**：`uninstallOrCleanup` 用 try/finally（`:161` try、`:234` `finally { host.uninstalling = null; }`）
- 卡死爆炸半径：`:115` / `:123` / `:139` / `:156` 的并发闸会**永久拒绝** install / uninstall / upgrade

逐路径核验（决定「当前是否可达」）—— **每一环都自带守卫**：

| 调用 | 落点 | 是否自护 |
|---|---|---|
| `host._latestVersion()` | `:81` | ✅ 显式 `.catch(() => null)` |
| `host._selectRegistry()` | `app/native/npm.js:44` | ✅ 自带 try/catch 返 null |
| `host._runInstall()` | `npm.js:48` → `platform/distribution/install.js:107-141` | ✅ `new Promise((resolve)=>…)` **从不 reject**；唯一可抛语句 `spawnOS.piped` 在 `:109 try/catch` 内 resolve；`onLine` 回调 `:132` 自带 try/catch。残余：executor 内 try **之外**的 `child.stdout.on`/`child.on` 若 child 契约异常会 reject（属契约违约路径） |
| `host._recordManifest()` | `app/native/manifest.js:15-24 save()` | ✅ 自带 try/catch |
| `host._claimDataPaths()` | `manifest.js:58-59` | ✅ try/catch |
| `host.installedVersion()` | `app/native/probe.js:54-59` | ✅ try/catch |
| `host.events.append()` | `platform/service/log/events.js:114-115` | ✅ try |
| `beginTask → tasks.begin()` | `platform/service/tasks.js:45-48 _save()` | ✅ 自带 try/catch |

结论：**缺 try/finally 成立**（与 uninstall 不对称、后果为永久锁死全部安装类操作），但我**未能证明当前存在可达的抛出/拒绝路径** ⇒ 定性「真缺陷（潜在/健壮性）」，而非当前在跑的 bug。

最小修法：把 `:79-110` 包进 `try { … } finally { host.installing = null; }`，三处显式 null 可留可删。纯增量、无行为变更（除「异常时不再卡死」这一改善）。置信度：**中高**（结构确证；可达性未证）。

### 1.3 D10 daemon 异主判定未用 `classify()` → **真缺陷（中低，判据不等价）**

两套判据并存，且回答的是**不同问题**：

- **动态归属** `classify()`（`src/app/daemons/process.js:189-201`）：
  `:191` 取 `expectedPid()` → `:192` 存活则 `:193-195` 比对 `_ctlOwnerPid()` 与 `exp`：不等 ⇒ `external`（异主）。`:198-199` exp 已死但 ctl 仍被占 ⇒ `reclaiming`。
  其文档自称：`:187-188`「识别『异主 daemon』的**唯一判据**」「ensureRunning 只按 cmdline 判 active，无法区分本守卫 daemon 与外部同名 daemon」。
- **静态授权** `_daemonManaged()`（`src/app/daemons/identity.js:22-24`）：
  `return fs.existsSync(<stateDir>/router-daemon.lock)` —— **只判文件存在，不读也不比对锁内 pid**（写入侧 `:27` 写的是 `String(process.pid)`）。`:12 _lanManaged()` 同形。

消费点（三个）：
- `src/app/daemons/runtime.js:129-130`：`daemonActive = _routerDaemonActive()`（`src/app/daemons/probe.js:14-23`：**按 cmdline** 判 ctl 端口占用者是否 daemon）+ `managed = _daemonManaged()`
- `runtime.js:138`：`daemonActive && !managed` ⇒ `mode:'external'`（不接管）✓
- **`runtime.js:145-152`（缺陷点）**：`daemonActive && managed` 的停止路径直接
  `findListeningPid(routerPort)` → `process.kill(pid,'SIGTERM')` → `clearRouterDaemonLock()`，
  **不校验该 pid 是否本守卫的 daemon**
- `src/app/daemons/supervise.js:30`：`if (!this.daemons.managed()) return …`（异主隔离；其后 `:34-35` 另用 `classify()` 兜底）
- `src/app/audit/orphan-scan.js:29`：把 `managed: () => getDaemons().managed()` 当清单判据

缺陷形态：`_daemonManaged()` 为真（本实例写过锁）**且**本实例 daemon 已死**且**外来同名 daemon 占住同一 ctl 端口（例如以相同 cmdMark 手工启动、或旧代残留）⇒ `runtime.js:149-151` **误杀外来进程**。锁文件是「我声明过管理」的**静态授权**，不是「端口占用者是我」的**动态归属**，二者不等价。

**纠正 AUDIT 一处**：`bootstrap.js:120` **不是**独立判据点 —— 该行只是 `} else if (rt.active) { if (rlc) { rlc._setPhase('running'); … } }`，消费的是 `runtime.js` 返回的 `mode/active`，本身不碰 lock/ctl。⇒ 修法只需落在 `runtime.js`。

最小修法：`runtime.js:145-152` 的 kill 前加 `classify()` 归属校验 —— 仅 `mode==='running'` 或 `'reclaiming'` 时停，`'external'` 拒绝 + warn。可选：`supervise.js:30` 同步改用 classify（其兜底已存在）。
可达性：判据不等价**静态可证**；「陈旧锁 + 外来同名 daemon」是否真实发生**需运行期/现场证据**（现场判据：ctl 端口占用者 cmdline 命中 daemon 特征 **且** 本 stateDir 存在 `router-daemon.lock` **且** 该锁内 pid ≠ 当前占用者）。置信度：**中**（结构确证；误杀后果需运行期确认）。

---

## 2. 下级 P4-E-1 走查四项（摘要 + 主代理交叉核对）

下级报告：`design-notes/_p4-e1-uncertain.md`（196 行）。四项定性我逐条核对了其证据链，并复测了数字项（§3），结论一致。

### 2.1 D11 guardian 语义不一致 → **真缺陷（中低，静态可证）**
- 证据：`src/app/daemons/controller.js:155` 算出 `guarded`；`:156-163` 的 adopted / child 死亡分支都据此判断；**`:164-171` 的假死分支全程不读 `guarded`**（`:167 applyHealthCheck` → `:169 beginRestart`）；`health-gate.js:39-51` 只收 `healthOk`，**无 guardian 入参**。
- **纠正疑点**：其引用的 `health-gate.js:165-173` **不可能存在**（该文件仅 53 行）；真实现场是 `controller.js:164-171`。
- 最小修法：**(a) 推荐 —— 注释/事件显式声明「假死自愈不受 guardian 约束」**（最小、无死循环）；**(b) 若定为不受自愈则不可简单前置 `if (guarded)`** —— 会与 `controller.js:121-124` 的 `portUp → adopt()` 形成 adopt↔假死空转，须先补稳定态，风险高。

### 2.2 D12 stopProcess「停止落空」→ **真缺陷（中低；实际落空需运行期证据）**
- **纠正 AUDIT**：「先清 adoptedPid 再 kill」**不成立** —— `src/app/main/process.js:233` 先取**局部** `adoptedPid`、`:237` 才清、`:240` 用该局部 killAdopted，「先取后清」已正确。
- 真缺陷：kill 链路**全吞异常且无失败事件** —— `signals.js:63-65/72-76` 的 `catch{}`、`killTree` 回调 `()=>{}`、`platform/os/process.js:18-25/29-39` 自吞；`stopProcess` `:234` **无条件置 STOPPED**、`:230` **只发成功事件**、无返回值。
- 后果链：kill 失败 → 下一拍 `controller.js:75` `portUp` → `:76` `adoptObserved` 重新观测 ⇒ 用户停止变 OBSERVED 且**无失败事件**。
- 最小修法：`signals.js:66-79` SIGKILL 后仍 `isAlive` 时补 `stop_failed` 事件 + warn；并给 `_adoptKillTimer` 加代际（与 D13 同源）。

### 2.3 ARCHITECTURE-ACCEPTANCE 数字漂移 → **真漂移（文档过期；硬门禁全过）**
见 §3 实测表。文档存的是改造终态快照，与当前树已不符。

### 2.4 §5 域内目标超限 8 文件 → **真漂移（6/8 仍超；均非 CI 红项）**
- 判据 = SSOT `DOMAIN-STRUCTURE-DESIGN.md` §5 的**域内目标**值（来源报告 `AUDIT-r5-architecture-consistency.md:214-227` 明言**不是** DF-1/DF-2 硬门禁）。
- 对照（当时 → 当前 → 是否仍超）：`instance/index.js` 95 → 95 → **否（贴线）**；`plugin/index.js` ≤70 → 80 → **是**；`plugin/layers.js` ~170 → 223 → **是**；`plugin/store.js` ~180 → 193 → **是**；`plugin/market.js` ~260 → 261 → **是（超 1）**；`freeze.js` ≤200 → 234 → **是**；`shell/core.js` ~95 → 106 → **是**；`relay/daemon.js` 214 → 194 → **否**。
- 6 个仍超者**全部 ≤300**（DG-2 硬门禁绿）。修法二选一：收敛行数 或 更新 SSOT 目标值 + 注取数日期。
- 注意：`market.js` 仅超 1 行、`instance/index.js` 恰贴线 —— **后续任何新增行都会重新越界**。

---

## 3. 真实数字实测（主代理独立复测，与下级一致）

| 指标 | 文档现值（`ARCHITECTURE-ACCEPTANCE.md`） | **当前树实测** | 出处 |
|---|---|---|---|
| `src/` 文件数 | 256 | **257** | `:64` |
| 最大单文件 | 298 | **300**（`src/domains/router/handlers/forward.js`） | `:65`（DG-2 判据为 `>`，300 仍绿） |
| `>300` 行的文件 | 0 | **0** ✓ | `:66` |
| `src/supervisor.js` | 79 行 | **66 行** | `:68` |
| 测试链条目 | 125 | **129** | `:72`（链长 **7899** 字符，余量 **101**） |
| DF-2 行内「最大 298」 | 298 | 应更新为 **300** | `:92` |

**一处需注意的数字来源**：任务简报给的参考「`src/supervisor.js` 约 78 行」是**历史值**。git 证据：`git show 3edd267:src/supervisor.js | wc -l`=78、`git show b2f3d3d:src/supervisor.js | wc -l`=66、当前工作树=66。⇒ 更新文档时应以 **66** 为准。

复测命令（只读）：
```sh
find src -name '*.js' | wc -l
find src -name '*.js' -exec wc -l {} + | sort -rn | head -3
wc -l < src/supervisor.js
node -e "const t=require('./package.json').scripts.test;console.log(t.length,t.split(' && ').length)"
```

---

## 4. 汇总：定性 / 优先级 / 修法落点

| # | 条目 | 定性 | 优先级 | 最小修法落点 | 是否需运行期证据 |
|---|---|---|---|---|---|
| F9 | 相位陈旧告警只发一次 | **真缺陷** | P3（可观测性） | `shell/watchdog.js:60` 补 `phaseStaleWarned = false` | 否（静态确定） |
| D9 | `install()` 缺 try/finally | **真缺陷（潜在）** | P2（健壮性） | `native/ops.js:79-110` 包 try/finally | 可达性未证 |
| D10 | 异主判定用锁存在性 | **真缺陷** | P2（误杀风险） | `daemons/runtime.js:145-152` 加 `classify()` 归属校验 | 误杀后果需现场证据 |
| D11 | guardian 语义不一致 | **真缺陷** | P2（自愈语义） | 推荐声明式（改注释/事件），勿裸加 `if(guarded)` | 否（静态可证） |
| D12 | stopProcess 停止落空静默 | **真缺陷** | P2（假成功） | `signals.js:66-79` 补 `stop_failed` + warn；`_adoptKillTimer` 加代际 | 落空需运行期 |
| C | ARCHITECTURE 数字漂移 | **真漂移**（文档） | P3（文档） | 按 §3 表更新 `:64/:65/:68/:72/:92` + 注取数日期 | 否（已实测） |
| D | §5 域内目标超限 | **真漂移**（6/8 仍超） | P3（文档/收敛） | 收敛行数 或 更新 SSOT 目标 + 日期 | 否（已实测） |

**共性结论**：7 项**无一为「非缺陷」**；其中 5 项是**真缺陷**（F9/D9/D10/D11/D12，全部 P2/P3、无 P0），2 项是**真文档漂移**（数字/目标值过期，硬门禁不受影响）。
**最值得先修的**：D12（用户停止被静默吞掉、还谎报成功）与 D10（可误杀外来 daemon）—— 二者都是「失败被吞 + 展示成功」这一类，与本仓 FIX-5/FIX-6/FIX-8 的根因同族。

---

## 5. 纪律与局限

- 全程**只读**：仅 `read` / `grep`（CJK 用 `grep -oP '\p{Han}{4,}'`）/ `sed -n` / `wc` / `find` / `node -e` 读 `package.json`；未改 src/test、未跑测试/门禁、未 `require` 产品模块执行、无 git 写、未启 daemon、未触碰状态根与 `/tmp/dsh-*`。
- 行号以 `24b2fb7` 工作树为准；P4-A..D 并行修改后可能漂移，定位请以「文件 + 符号」为准。
- 本报告**不构成验收结论**；修法是否落地及是否修好，最终由 CI 裁决。
- 报告内所有路径均为仓根相对路径，无操作者绝对路径。
