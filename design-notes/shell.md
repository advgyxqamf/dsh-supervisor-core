# shell 域 功能设计

> 范围：`src/domains/shell/`（index.js 35 / journal.js 150 / restart.js 167 / watchdog.js 282 行，实测值）。
> 依据：`DOMAIN-DESIGN-BRIEF.md` §5 模板 + `DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）+ `design-notes/_RULING.md`（主代理 R1–R7，**覆盖 BRIEF 相应表述**）。
> 所有「文件:行号」均来自本轮实际 read；行数为**逻辑行**（尾换行不计：watchdog.js 文件无尾换行，282 = split('
').length）。

**本设计的三个直接回答（先给结论）**

| 问题 | 结论 |
|---|---|
| **Q1 watchdog.js 282 行还能切吗？** | **能，但只有一刀**：把「纯决策」与「有状态看护」分开（DF-3/DF-6）。**不是**切「周期任务」——本域**不含** `setInterval`，定时器在 app 层（`bootstrap.js:180`），watchdog 只是被外部定时器驱动的**可重入状态机**。切完 `watchdog.js` 仍约 185 行（代码 ~130 行），**剩下的不能再切**（见 §G.2）。 |
| **Q2 `restart.js` require `./journal` + `./watchdog` 方向合理吗？** | `→journal` **合理**（向下：流程 → 持久化）。`→watchdog` **不合理**：它是**反序**的（重启流程 require 上游判定谓词），且与 watchdog 经 `deps.shell` 调 `restartShell` 构成**隐式双向耦合**；作者自己已察觉（`restart.js:98` 注释「按需 require 避免与 watchdog 的循环依赖」）。require 图仍是 DAG，但**依赖方向与数据流相反**。最小修法：把 `isShellProcess` 下沉纯策略层，**删除这条边**。 |
| **Q3 D6 语义** | **不改**。内核**不是**壳的更新源：`SHELL_RELEASE_PKG`（`restart.js:22`）只被传给**注入的** `dist.fetchLatestVersion` 做**版本查询**（`restart.js:41`）；shell 域**零** `require` distribution、**零** `runNpmInstall`、**零**内核版本状态写。新结构必须原样保留这三条，并升级为门禁（§H G-S8）。 |

---

## A. 现状审计

### A.1 文件清单与职责（逐文件：行数 / 当前职责 / 问题）

| 文件 | 行数（代码/注释/空行） | 当前职责 | 问题 |
|---|---|---|---|
| `index.js` | 35（12/19/4） | 门面：仅 require `./journal`(21-29) + `./restart`(31)，`module.exports`(35) | **无逻辑，达标**。⚠ 唯一缺陷是注释失真：`index.js:12-15` 称「supervisor.js:28 require 本文件」——**实测 supervisor.js 现 174 行且不 require shell**；真实消费者是 `src/app/assembly/compose.js:26`（`shellDomain`）与 `bootstrap.js:27`（`createShellWatchdog`）。 |
| `journal.js` | 150（81/52/17） | ① 状态目录与 JSON 原子读写（`shellDir`33-35、`readJson`37-39、`writeJson`41-47）；② 壳身份只读（`identity`51-53）；③ 更新账本（`journalPath`56、`readJournal`57-62、`writeJournal`63、`markPending`66-74）；④ **纯判定**（`evaluate`85-109）；⑤ 健康上报写入 + IO（`health`116-134、`status`137-148） | **DF-3 违反**：纯判定 `evaluate()`（85-109，无 IO、只读 `identity()`/`readJournal()` 两个快照）与 fs 副作用同文件。**DF-6 违反**：`evaluate()` 无注入点，硬编码经 `identity()`/`readJournal()` 读真文件——单测必须隔离 `DSH_SUPERVISOR_HOME`（`shell-safety-net-test.js:32-42` 正是这么做的），无法给假数据。 |
| `restart.js` | 167（78/77/12） | ① 发布包常量（22）；② **版本查询**（`checkUpdate`32-51，注入 dist）；③ 纯解析（`exeFromCmdline`54-62）；④ **重启流程**（`restartShell`77-165：pgrep 过滤 → 定位 exe → SIGTERM → 有界等待 → SIGKILL → detached spawn + `'error'` 监听 + `child.pid` 同步校验） | **DF-3 违反**：纯函数 `exeFromCmdline` 与进程副作用同文件。**依赖方向反序**：`restart.js:99` 函数内 `require('./watchdog')` 取 `isShellProcess`（重启流程依赖上游判定谓词）。 |
| `watchdog.js` | 282（166/97/19） | ① **纯配置**（`DEFAULTS`34-45）；② **纯谓词**（`isShellProcess`48-53）；③ **纯决策**（`decide`68-90，穷举可测）；④ **有状态看护**（`createShellWatchdog`102-280：状态字段 113-121、相位时效 151-163、预期缺席 179-189、exe 定位 191-194、`tick`196-254、`status`257-274、`_reset`277） | **DF-3 违反**：`decide`/`isShellProcess`/`DEFAULTS`（纯）与 `tick`（进程/时钟 IO）同文件。**DF-2 边际**：282 行 > BRIEF 理想值 250（但 ≤400 严阈值；且**代码仅 166 行**）。**require 边 = 0**（实测），是六域中唯一零 require 文件——依赖全经 ctor 注入（`deps`103-111），DF-4 达标。 |

**行数实测复核**（本轮用脚本统计，与 `wc -l` 的差异已解释）：

```
index.js     total=35  code=12   comment=19  blank=4
journal.js   total=150 code=81   comment=52  blank=17
restart.js   total=167 code=78   comment=77  blank=12
watchdog.js  total=282 code=166  comment=97  blank=19
```

> 结论：shell 域 633 行里**代码只有 337 行**。所以「watchdog 282 行」这个数字本身不构成 DF-2 问题；需要切的是**职责混杂**（DF-3/DF-6），不是行数。

### A.2 域内耦合图（require 边 + this 跨文件调用边，逐条列出）

**require 边（域内，4 条，实测 / 已剥注释）**

| # | from | to | 位置 | 性质 |
|---|---|---|---|---|
| E1 | `index.js` | `./journal` | `index.js:21-29` | 合法：门面 → 实现（顶层） |
| E2 | `index.js` | `./restart` | `index.js:31` | 合法：门面 → 实现（顶层） |
| E3 | `restart.js` | `./journal` | `restart.js:15`（`identity`） | 合法：流程 → 持久化（顶层） |
| E4 | `restart.js` | `./watchdog` | `restart.js:99`（`isShellProcess`，**函数内 lazy require**） | ⚠ **反序**：重启流程 require 判定谓词。lazy 写法见 `restart.js:98` 注释，作者已知循环风险。 |

**跨域/跨层边（4 条，全部向下，合法）**

| # | from | to | 位置 | 说明 |
|---|---|---|---|---|
| X1 | `journal.js` | `platform/service/state-root` | `journal.js:34`（**函数内 require**） | 有意保留：状态根解析依赖运行期 `DSH_SUPERVISOR_HOME`，顶层 require 会在配置注入前固化路径（`journal.js:31-32` 注释）。 |
| X2 | `restart.js` | `shared/version` | `restart.js:17`（`semverCompare`） | 复用内核唯一 semver 实现。 |
| X3 | `restart.js` | `platform/os/spawn` | `restart.js:81`（函数内，`detachedIgnored`） | 统一 spawn 封装（固定 `windowsHide:true`，`no-console-window-gate`）。 |
| X4 | `restart.js` | `platform/os/pidlookup` | `restart.js:82`（函数内） | pgrep/isAlive。 |

**this 跨文件调用边：0 条。** 四个文件全文 `this.` 出现次数 = 0（实测），`Object.(assign|defineProperties)(X.prototype, …)` 出现次数 = 0（实测）。**这是 shell 作为「最接近达标样板」的第一块证据。**

**替代 `this` 的隐式耦合（必须记录，否则新设计会把它们藏起来）**

| # | 形态 | 位置 | 判定 |
|---|---|---|---|
| I1 | `deps.shell` 冻结门面对象（动态成员访问） | `watchdog.js:104,153,181,185,193,240` | **手法 B（ctor 注入）**，已显式；但注入的是**整个域门面**，watchdog 实际只消费 3 个成员（`identity`/`readJournal`/`restartShell`，见 `watchdog.js:96`）。属于「注入面过宽」，非 DF-4 违规。 |
| I2 | `deps.pidlookup` / `deps.desktop` 注入 | `watchdog.js:105-106` | 手法 B，达标。 |
| I3 | `shell.identity()` 被 `updatePhaseTracking`(153)、`expectedAbsence`(181)、`exePath`(193) **三处重复调用** | `watchdog.js:151-194` | 同一快照在一拍内被读 3 次（不一致窗口）。**非 this 问题，但属设计缺陷**，见 §G.4。 |
| I4 | 相位判定正则 `phase === "restarting" \|\| phase.indexOf("shell-update") === 0` **重复 2 处** | `watchdog.js:154`、`watchdog.js:182` | 复制粘贴的纯谓词，应提取（§C.2）。 |
| I5 | `restart.js:9` 与 `watchdog.js:64` 曾各自实现「排除自检进程」的 flag 列表并**已分叉**（6 vs 3 个 flag） | 修复记录见 `restart.js:90-98` | 已由共享谓词 `isShellProcess` 消除；本条是**该边（E4）存在的原因**，也说明 E4 不能简单删掉、必须**下沉**。 |

### A.3 病症清单（对照 BRIEF §0 四类，逐条给证据）

> ⚠ 依 **R1**：BRIEF §0 所称「循环 require」在本域**不存在**（实测 0 环）。DF-5 的正确含义 = **禁止把两个文件的方法合并到同一 this**，本域 0 处，达标。

| BRIEF §0 病症 | shell 域判定 | 证据（文件:行号） |
|---|---|---|
| ① 巨型文件（混杂模型/IO/算法/流程） | **轻度**：最大 282 行，但**代码仅 166 行**，≤400 严阈值。真问题是「纯 + IO 混放」。 | `watchdog.js:34-90`（纯：DEFAULTS/isShellProcess/decide）紧邻 `watchdog.js:196-254`（进程/时钟 IO）；`journal.js:85-109`（纯判定）紧邻 `journal.js:116-134`（fs 写）。 |
| ② `this` 隐式耦合 | **不存在**：`this.` 计数 = 0；mixin 注入计数 = 0。残量是 `deps.shell` 宽注入（I1）。 | 实测四文件 `this.`=0；`Object.(assign\|defineProperties)(X.prototype,…)`=0。 |
| ③ 循环 require | **不存在**：域内 4 边构成 DAG（E1/E2/E3/E4，见 §A.2）。**真实缺陷是 E4 方向反序**（非环）。 | `restart.js:99` `const { isShellProcess } = require('./watchdog')`；`watchdog.js` 全文 0 require（反向不成立 → 无环）。 |
| ④ 职责错位 | **一处**：`watchdog.js` 同时是「纯决策库」+「有状态看护进程对象」；`journal.js` 同时是「纯状态机」+「fs IO」。 | `watchdog.js:68-90` vs `196-254`；`journal.js:85-109` vs `116-134`。 |

**附加发现（非 §0 四类，但影响迁移）**

- **F1 基线红灯（既有，非本设计引入）**：`test/shell-watchdog-test.js` 的 W4-a..W4-e 断言 grep `src/supervisor.js` 里的 `domains/shell/watchdog` 接线，但步骤 7 已把接线搬到 `app/assembly/bootstrap.js:27,159-189` → **5 条 FAIL**。实测 `node test/shell-watchdog-test.js` → `29 passed, 5 failed`，**退出码 1**（该测试在 `package.json` test 链中）。这是**测试夹具路径陈旧**，不是产品缺陷；本设计的 F 节把它列为独立修复项。
- **F2 注释失真**：`index.js:12-15` 指名的 `supervisor.js:28` 已不存在（现 `supervisor.js` 174 行、无 shell require）。
- **F3 文档/实现不同步**：`SHELL_RELEASE_PKG` 在 `restart.js:22` 定义后，**除本文件与门面 re-export 外零消费者**（实测：`src/` 与 `test/` 均无外部引用）；`/shell/health` 与 `/shell/update-pending` 亦被 `api/contract.js:127-130` 标注为「壳零调用的排障入口」。**设计不得为这些死键新增消费者**，但**也不得删除**（导出面契约，`index.js:33-34`）。

---

## B. 功能切面（★ 设计核心）

> 不论现有文件怎么切，先回答「shell 域在功能上由哪几块组成」。

| # | 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|---|
| B1 | **发布身份** | 声明桌面壳的发布包名（清单包） | — | `'@dsh-sup/shell-release'` | 无 | ✅ 纯（常量） |
| B2 | **壳身份读取** | 只读壳写入的 `identity.json`（version/phase/exe/lastSeenAt） | 状态根 | identity 对象 \| null | 无（失败静默返回 null） | ❌ IO（只读） |
| B3 | **更新账本持久化** | 账本读写 + 原子写（tmp→rename, 0600） | 账本对象 | 文件 | **写文件** | ❌ IO |
| B4 | **更新阶段机** | 由 (identity, journal) 推导 `idle/pending/confirmed`；**强制更新、无回退** | `(id, journal)` 两个快照 | `{state, reason, target?, current?}` | 无（**纯函数**） | ✅ **纯**（DF-6 应可注入假快照单测） |
| B5 | **健康上报接入** | 壳调 `POST /shell/health` → 兜底写运行时字段并回读判定 | payload | `{ok, phase, state, target}` | **写 identity.json** | ❌ IO |
| B6 | **状态汇总** | 面板/CLI 一次拿到 identity+journal+state | — | `{identity, journal, state, reason, dir}` | 无 | ❌ IO（读） |
| B7 | **壳版本查询** | 经**注入的** dist 查 npm 最新壳版本 → 是否可更新 | `(dist, {authoritative})` | `{ok, installed, latest, updateAvailable, error?}` | 网络（经 dist） | ❌ IO |
| B8 | **壳进程识别** | 谓词：该进程是否**桌面壳主程序**（排除无头自检 flag） | `{cmdline}` | boolean | 无 | ✅ **纯** |
| B9 | **可执行路径解析** | 从 cmdline 首段解析 exe（处理 Windows 引号路径） | cmdline 串 | exe \| null | 无 | ✅ **纯** |
| B10 | **缺失看护决策** | 纯决策：`alive/record/wait/skip/restart` + reason + needMs | `{alive, absentForMs, expectedAbsence, sessionAvailable, restartsInWindow, hasExe, config}` | `{action, reason, needMs?}` | 无 | ✅ **纯**（`watchdog.js:68-90`） |
| B11 | **预期缺席判定** | 「壳在更新/重启中」或「账本未确认」→ 延长宽限 | `(phase 快照, 相位计时, journal)` | boolean | 无（**只读快照**，`watchdog.js:138-140` 明示不得有副作用） | ✅ **纯**（计时由 B12 维护） |
| B12 | **相位时效跟踪** | 给「更新中」相位加 10 分钟时效上限（防陈旧 phase 永久拖住看护） | tick 时刻 + phase | 更新模块内 `expectedSince/phaseStale` | 无（仅内存状态） | ❌ 有状态 |
| B13 | **看护状态机 / 周期拍** | 可重入 tick：观测进程 → 决策 → 记账 → 执行重启 | 注入的 `(shell, pidlookup, desktop, logger, events, config, now)` | `{alive\|absent\|waiting\|skipped\|restarted, …}` | **杀进程 / spawn / 日志 / 事件** | ❌ IO+有状态 |
| B14 | **看护观测快照** | `status()`：供 `/env/status` 与诊断 | 模块内状态 | 快照对象 | 无 | ❌ 读状态 |
| B15 | **外部定时器** | `setInterval` 驱动 B13；`.unref()`；shutdown 清定时器 | config.intervalMs | — | 定时器 | ❌（**不在本域**：`bootstrap.js:180-183` / `shutdown.js:32`） |
| B16 | **壳重启执行** | 杀旧壳（SIGTERM→有界等待→SIGKILL）→ detached spawn 新壳 | `{exePath, procPattern, graceMs, events}` | `{ok, killed, pid, exe, error?}` | **进程信号 + spawn** | ❌ IO |

**关键切面判据（由 B 表直接得出）**

1. **B4 / B8 / B9 / B10 / B11 是纯函数**（无 IO、无时钟、无进程），必须与被注入的 IO 分开（DF-3），且必须能脱离文件系统/进程单测（DF-6）。→ 收敛为**一个纯核心文件**。
2. **B3/B5/B6 是壳状态 IO**，共用 B2/B3 的读写原语；B4 是它们的决策内核。→ 一个**账本文件**。
3. **B7/B16 是版本查询与重启流程**（网络 + 进程），共用 B1/B9。→ 一个**重启文件**。
4. **B12/B13/B14 共享同一组模块内状态**（`missingSince/restarts/busy/lastSkipReason/everSawAlive/expectedSince/phaseStale/phaseStaleWarned`，`watchdog.js:113-121`）→ **必须同文件**。切出去等于把 8 个字段 + 回调经 ctor 传递（§2「文件搬家」反例）。→ 一个**看护文件**。
5. **B15 不在本域**：域内**零** `setInterval`（实测 `watchdog.js` 无 require、无定时器）。**故不建 `scheduler.js`**——那会与 app 层唯一驱动重复，并破坏 `busy` 门闸（`watchdog.js:198,253`）与 `_reset`（`watchdog.js:277`）语义。
6. **B1 常量归属**：留在版本/重启文件，避免让纯核心依赖产品发布身份（保持 core 零领域事实、可独立复用）。

---

## C. 目标结构（★ 逐文件）

### C.1 目标目录树

```
src/domains/shell/
├── index.js        门面：组合 + 导出（35 行，**逐字不动**）
├── core.js         【新】纯核心：所有无 IO 判定/谓词/解析（~95 行）
├── journal.js      更新账本 IO + 健康上报 + 状态汇总（150 → ~110 行）
├── restart.js      版本查询 + 壳重启流程（167 → ~157 行）
└── watchdog.js     有状态看护状态机（282 → ~185 行）
```

> 依 **R2**：扁平文件优先；本域**不建子目录**（纯核心只有 1 个文件，建 `policies/` 反而碎片化）。
> 依 **R5**：本域无 `daemon.js`，不受影响。

### C.2 目标逐文件表

| 新文件 | 行数估计 | 职责 | 从哪来（旧文件:行区间） | 纯? |
|---|---|---|---|---|
| `index.js` | 35（不变） | 门面组合 + 导出 | `index.js:1-35` 原样；仅**修正注释**指明真实消费者（`compose.js:26`/`bootstrap.js:27`） | — |
| `core.js` | ~95 | 纯核心：`DEFAULTS` / `isShellProcess` / `decide` / `isUpdatePhase(phase)`（**新提取**，消除 `154\|182` 重复） / `deriveState(id, journal)`（**新提取**，`evaluate` 的纯内核） / `exeFromCmdline` | `watchdog.js:34-45`（DEFAULTS）+ `48-53`（isShellProcess）+ `55-90`（decide，含 jsdoc）；`journal.js:85-109`（evaluate 的纯判定部分）；`restart.js:53-62`（exeFromCmdline） | ✅ **零 require** |
| `journal.js` | ~110 | 账本 IO + 健康上报 + 汇总：`shellDir` / `readJson` / `writeJson` / `identity` / `journalPath` / `readJournal` / `writeJournal` / `markPending` / `evaluate`（**降为 2 行包装**：读两快照 → `core.deriveState`）/ `health` / `status` | `journal.js:26-74`（IO+账本）+ `76-109`（evaluate，纯部分迁 core）+ `111-148`（health/status） | ❌ IO（决策委托 core） |
| `restart.js` | ~157 | `SHELL_RELEASE_PKG` / `checkUpdate` / `restartShell`（**exeFromCmdline 迁出、watchdog 依赖改指 core**） | `restart.js:1-52` + `64-165`；`exeFromCmdline`(53-62) 迁 `core.js`；`99` 改 `require('./core')` | ❌ IO |
| `watchdog.js` | ~185 | 有状态看护：`createShellWatchdog`（状态字段 / 相位时效 / 预期缺席 / exe 定位 / `tick` / `status` / `_reset`）；顶部 `const { DEFAULTS, decide, isShellProcess, isUpdatePhase } = require('./core')` | `watchdog.js:1-32`（头注释）+ `92-280`；`34-90` 迁 `core.js` | ❌ IO+有状态 |

**切完后 DF 判据自检**

| 判据 | 结果 | 证据 |
|---|---|---|
| DF-1 门面纯化 ≤150 行 | ✅ 35 | `index.js` 12 行代码，无逻辑 |
| DF-2 单文件 ≤400 | ✅ 最大 ~185 | 旧最大 282 已降；且**代码**最大仅 ~130 |
| DF-3 纯/IO 分离 | ✅ | `core.js` 零 require、零 fs/process；三个 IO 文件不再内联纯决策 |
| DF-4 零隐式 this 跨文件 | ✅ | 本就 0；新结构后 `decide` 改为**显式 import**（手法 A），比现在「同文件私有」更明确 |
| DF-5 无环 require（R1 语义：不得合并方法到同一 this） | ✅ | 见 §D；且域内 0 处 mixin |
| DF-6 可独立单测 | ✅ | `core.js` 可用**假快照**直测 `deriveState`（现 `evaluate` 做不到）；`watchdog.js` 注入测试本已达标 |
| DF-7 单向依赖 | ✅ | 删除反序边 E4；`core ← {journal,restart,watchdog} ← index` |

---

## D. 依赖图（★ 必须是 DAG）

```
index.js ──┬─→ journal.js ──→ core.js
           │                    ↑  ↑
           └─→ restart.js ──────┘  │
                                  │
               watchdog.js ───────┘
```

**逐边显式列出与理由**

| # | 边 | 理由 | 变化 |
|---|---|---|---|
| D1 | `index → journal` | 门面组合导出（`status/evaluate/health/markPending/identity/readJournal/shellDir`） | 不变（E1） |
| D2 | `index → restart` | 门面组合导出（`checkUpdate/restartShell/SHELL_RELEASE_PKG`） | 不变（E2） |
| D3 | `journal → core` | `evaluate()` 委托 `deriveState(id, journal)` | **新增**（纯内聚，向下） |
| D4 | `restart → journal` | `restartShell` 需 `identity().exe` 兜底（`restart.js:102`） | 不变（E3） |
| D5 | `restart → core` | `exeFromCmdline`（纯解析）+ `isShellProcess`（纯谓词） | **改写 E4**：`restart → watchdog` **删除** |
| D6 | `watchdog → core` | `DEFAULTS` / `decide` / `isShellProcess` / `isUpdatePhase` | **新增**（原为同文件私有） |
| — | ~~`restart → watchdog`~~ | 已删除 | **−1 边**（消除反序 + 隐式双向） |

**DAG 证明**：唯一可能的环需 `core → …`，而 `core.js` **零 require**（DF-7「core/policies 是汇点」），故无环。
**R1 取证纪律**：本图来自**剥注释后**的 require 扫描；未剥注释会在 `index.js:13`、`watchdog.js:96` 的说明文字里扫出伪边（正是 R1 所述陷阱）。

**跨域边（合法，逐条保留；不合法的提出裁决）**

| # | 边 | 单元 | 层矩阵 | 状态 |
|---|---|---|---|---|
| X1 | `journal → platform/service`（state-root） | `src/platform/service` | domains→platform ✓ | 已在 `layering-and-dependency-gate-test.js:78` 登记；**必须保留函数内 require** |
| X2 | `restart → shared/version` | `src/shared` | domains→shared ✓ | 已登记（`…test.js:104`） |
| X3 | `restart → platform/os`（spawn/pidlookup） | `src/platform/os` | domains→platform ✓ | 已登记 |
| X4 | `app/assembly/{compose,bootstrap} → domains/shell` | `src/domains/shell` | app→domains ✓ | 已在 `…test.js:92` 登记（装配期实例化） |
| X5 | `api/domains/shell → sup.shellDomain` | 注入 | api 不 require domains ✓ | 经 `api/deps.js:102-107` 声明注入；无源码边 |

**无不合法跨域边。无「需上层裁决」项。**
> 注：`watchdog.js` 依赖 `platform/os` 的能力（pgrep/desktop）**经 ctor 注入**而非 require（`watchdog.js:103-111`），故 `watchdog → platform` **不是** require 边——这是本域最干净的一点，新结构必须保持。

---

## E. `this` 隐式耦合消解表（★ 逐条）

**前提：shell 域 `this.` 跨文件调用 = 0 条**（实测四文件 `this.` 计数 = 0；`Object.(assign|defineProperties)(X.prototype, …)` 计数 = 0）。故本节记录的是**替代形态**的隐式耦合。

| # | 旧调用 | 位置 | 消解手法 | 新形态 |
|---|---|---|---|---|
| T1 | `require('./watchdog').isShellProcess`（函数内 lazy，为避环） | `restart.js:99` | **A. 具名导出 + 显式依赖** | `restart.js` 顶部 `const { exeFromCmdline, isShellProcess } = require('./core')`；**顶层**、无环（core 零出度）。**删除** `restart → watchdog` 边。 |
| T2 | `decide / isShellProcess / DEFAULTS` 与 `tick` 同文件私有 | `watchdog.js:34-90` vs `196-254` | **C. 参数显式化**（决策类优先） | 纯函数迁 `core.js`；`tick` 显式 import。三者已天然是 `decide(i)` 入参形态（`watchdog.js:66-89`），**零行为改动**。 |
| T3 | `evaluate()` 硬编码读真文件（无注入点） | `journal.js:85-109` | **C. 参数显式化** | 拆出 `deriveState(id, journal)`（纯，入参即两个快照）；`evaluate()` 降为「读快照 → 调用」两行包装。**单测可直接喂假快照**。 |
| T4 | 相位谓词重复 2 处 | `watchdog.js:154`、`182` | **A.** | `core.isUpdatePhase(phase)`；`updatePhaseTracking` 与 `expectedAbsence` 同源。 |
| T5 | `exeFromCmdline` 纯函数与进程 IO 同文件 | `restart.js:53-62` | **A.** | 迁 `core.js`（与 `isShellProcess` 同属「cmdline 解析」家族）。 |
| T6 | `deps.shell` 宽注入（整域门面） | `watchdog.js:104` | **B. 构造注入**（已用，保持） | **不改**：收窄为 `{identity, readJournal, restartShell}` 会破坏既有测试夹具（`shell-watchdog-test.js:60-64`、`watchdog-phase-freshness-test.js:53-57`）且无 DF 收益；只在 jsdoc 明确「仅消费这 3 个成员」。 |
| T7 | 一拍内 `shell.identity()` 被读 3 次 | `watchdog.js:153,181,193` | **C.**（可选，见 §G.4） | `tick` 读一次快照，作为入参传下去（`updatePhaseTracking(t, phase)`、`expectedAbsence(phase, journal)`）。**属行为改动，本轮不强制**。 |

**判定标准复核（BRIEF §3）**：新结构下可写「只 require `core.js`、给假快照、断言行为」的单测——`deriveState({version:'0.2.0',phase:'ready'}, {to:'0.2.0',confirmed:false}).state === 'confirmed'`，`decide({alive:0,absentForMs:9999,sessionAvailable:false,…}).action === 'skip'`。**两项均无需构造域对象、无需文件系统。**

---

## F. 迁移步骤（★ 可执行、可分批）

> 每步独立可提交；每步后**门禁必须仍绿**（除 F0 已点名的既有红项）。
> ⛔ 全程只改 `src/domains/shell/` + 点名测试文件；**不启动任何守卫进程**（e2e 测试 `shell-watchdog-e2e-test.js` **本轮不跑**——它会真的 spawn 假壳并起 Supervisor；只在 CI/受控环境跑）。

| 步 | 动作 | 影响文件 | 验证（可执行命令） | 独立提交 |
|---|---|---|---|---|
| **F0** | **（前置，独立缺陷）修复基线红灯**：`shell-watchdog-test.js` W4-a..e 判据从 `src/supervisor.js` 改读 `src/app/assembly/bootstrap.js`（真实接线点 `:27,159-189`） | `test/shell-watchdog-test.js:132-138` | `node --require ./test/_preload.js test/shell-watchdog-test.js` → **34 passed, 0 failed**（现 29/5, exit 1） | ✅ 与拆分无关，可先合 |
| **F1** | 新建 `core.js`：**移动**（非复制）`DEFAULTS`/`isShellProcess`/`decide`/`exeFromCmdline`；新增 `isUpdatePhase`；新增 `deriveState`（自 `evaluate` 抽纯内核）。在原文件**保留临时 re-export** 保证导出面瞬时不破 | 新增 `core.js`；`watchdog.js`(删 34-90 并 re-export)、`restart.js`(删 53-62 并 re-export)、`journal.js`(85-109 改为 `deriveState` + `evaluate` 包装) | `node test/shell-watchdog-test.js`；`node test/watchdog-phase-freshness-test.js`（→11 passed）；`node test/shell-safety-net-test.js`（→52 passed） | ✅ |
| **F2** | 改指依赖：`restart.js:99` → `require('./core')`（顶层）；`watchdog.js` 顶部 import core；`journal.js` `evaluate` 调 `core.deriveState`。**删除** `restart → watchdog` 边 | `restart.js`、`watchdog.js`、`journal.js` | `node test/shell-safety-net-test.js`；`node test/watchdog-phase-freshness-test.js`；`node test/shell-watchdog-test.js`（W1/W2/W3 须全绿） | ✅ |
| **F3** | 撤临时 re-export；把测试读取面指向新文件：`shell-watchdog-test.js:17`、`watchdog-phase-freshness-test.js:145` 从 `watchdog` 改 `core`；`platform-capability-audit-test.js:141-152,196-205` 的读取集合加入 `core.js`（沿用 `shell-safety-net-test.js:185-187` 的「按域聚合读取」范式） | 3 个测试文件 | `node test/platform-capability-audit-test.js`（→须 66 passed）；`node test/shell-watchdog-test.js`；`node test/watchdog-phase-freshness-test.js` | ✅ |
| **F4** | 修正 `index.js:12-15` 失真注释（消费者改为 `app/assembly/compose.js:26` + `bootstrap.js:27`）；在域内加 `README.md`（BRIEF §4 要求：职责边界 + 依赖图） | `index.js`、新增 `README.md` | `node test/directory-structure-gate-test.js`（须 12 passed）；`node test/layering-and-dependency-gate-test.js`（影响域单元登记无变化） | ✅ |
| **F5** | （可选，§G.4）`tick` 内 identity 快照单读，消除一拍三重读的不一致窗口 | `watchdog.js` | `node test/watchdog-phase-freshness-test.js`（N-a..N-f 全绿）；`node test/shell-watchdog-test.js` | ✅ |

**F 节的可执行验证汇总**（全部离线、不碰生产状态根）：

```bash
node --require ./test/_preload.js test/shell-watchdog-test.js          # 目标 34/0
node --require ./test/_preload.js test/watchdog-phase-freshness-test.js # 基线 11/0
node --require ./test/_preload.js test/shell-safety-net-test.js         # 基线 52/0
node --require ./test/_preload.js test/platform-capability-audit-test.js# 基线 66/0
node --require ./test/_preload.js test/directory-structure-gate-test.js # 基线 12/0
node --require ./test/_preload.js test/layering-and-dependency-gate-test.js # 基线 10/0
```

**必须同步的硬编码路径（否则静默失效）**

| 位置 | 现状 | F 步后 |
|---|---|---|
| `test/shell-watchdog-test.js:17` | 从 `watchdog` 取 `decide/isShellProcess/DEFAULTS` | 改从 `core` 取 |
| `test/watchdog-phase-freshness-test.js:145` | 从 `watchdog` 取 `DEFAULTS` | 改从 `core` 取 |
| `test/platform-capability-audit-test.js:141,196` | 只读 `watchdog.js` 断言 `function decide(` / `sessionAvailable` / `maxRestarts` | 读取集合须含 `core.js`（否则判据静默失效） |
| `test/round8-fixes-test.js:176-181` | `readDomain('src/domains/shell')` 聚合读整域 | **无需改**（按域聚合，新文件自动纳入） |

---

## G. 风险与取舍

### G.1 破坏性改动（导出面变化 → 点名消费方）

| 变化 | 消费方 | 缓解 |
|---|---|---|
| `watchdog.js` **不再导出** `decide/isShellProcess/DEFAULTS`（移 `core.js`） | `test/shell-watchdog-test.js:17`、`test/watchdog-phase-freshness-test.js:41,145` | 按 F3 同步改测试；**或**临时 re-export 一个版本。**不做**双导出长期保留（会造成同一事实两处导出面，与 `index.js:33-34` 的「逐字一致」纪律冲突）。 |
| `restart.js` **不再导出** `exeFromCmdline` | **零消费者**（实测：仅 `restart.js:167` 自导出；`src/`/`test/` 无引用） | 迁 `core.js` 后由 core 导出；无外部影响。 |
| `index.js` 导出面 | `api/domains/shell.js`（`status/health/markPending/checkUpdate/restartShell`，`:21,31,43,56,71`）、`watchdog` 经 `deps.shell`（`identity/readJournal/restartShell`，`watchdog.js:96`） | **逐字不变**（`index.js:35` 十个键原样）。设计**不新增/不删除**任何键。 |
| 域内文件可 require 面（新增 `core.js`） | 无外部影响（`layering` 域单元登记在目录粒度 `src/domains/shell`，`…test.js:92`） | 无需改登记表 |
| `platform-capability-audit` A2/A7 判据覆盖面 | 若只改 `decide` 位置而不改读取集合 → **判据静默失效**（会假绿） | F3 显式纳入 `core.js` |

### G.2 不做的部分与理由（不要为了设计而设计）

1. **不再继续切 `watchdog.js`**。切完 ~185 行（代码 ~130）；剩余是 B12/B13/B14 三者**共享同一组 8 个模块状态字段**（`watchdog.js:113-121`）。把它们拆出需经 ctor 传 8 字段 + 回调，正是 §2 明令的「文件搬家」反例。**切面到此为止。**
2. **不建 `scheduler.js`**。域内**零** `setInterval`；`B15` 在 app 层（`bootstrap.js:180-183` 建、`shutdown.js:32` 清）。域内自建定时器会与「唯一心跳」体系冲突，并破坏 `busy` 门闸与 `_reset` 语义。
3. **不拆 `core.js` 为 `policies/watchdog.js` + `policies/journal.js`**。两个纯策略合计 ~95 行，拆开接近「为每个函数建文件」的碎片化反例（§2）。**触发条件**：若 `core.js` 超 ~150 行或看图护/账本两族变更频率明显分叉，再按刀 2（变更频率）拆 `policies/`（R2 已允许该子目录）。
4. **不动 `health()` 对 `identity.json` 的写入**。这是内核**观察**壳产物（`journal.js:116-134`），非内核更新状态；`shell-safety-net-test.js:214-215` 明确要求保留 `phase/version/lastSeenAt`，同时禁止写 `attempt`（`:211-213`）。与 D6 无关（D6 指内核**更新机制**，不是核内观察）。
5. **不删除 `SHELL_RELEASE_PKG` / `/shell/health` / `/shell/update-pending` 等零消费者面**。虽然实测零调用（`api/contract.js:127-130`），但它们是**导出面契约**（`index.js:33-34` 逐字保持）与未来接线位。**只标注，不删除。**
6. **不把 `identity()` 的三次读合并**（T7）列入必做。它是真实缺陷（一拍内快照可能不一致），但**改变 tick 行为**，需独立评估；列为 F5 可选项。

### G.3 D6 硬约束的守界清单（设计不得改变该语义）

| 约束 | 现状证据 | 新结构要求 |
|---|---|---|
| 内核**不是**壳的更新源 | `restart.js:28-31`（「内核不是壳的更新源，此处只做版本检测」）；`api/contract.js:118-119` | `core.js`/`restart.js` **不得**出现安装执行器 |
| shell 域**零** require distribution | 实测：域内 4 条跨层边（X1-X4）无 `platform/distribution` | 保持；升级为门禁 G-S8 |
| `SHELL_RELEASE_PKG` 仅用于**查版本** | `restart.js:41`（唯一使用点，传给注入的 `dist.fetchLatestVersion`） | 保持；`dist` 仍由 **API 层注入**（`api/domains/shell.js:56`），域内不 require |
| 不触碰内核更新机制 | `shell-safety-net-test.js:96-103`（R5-a..d）、`kernel-update-single-writer-test.js` | 保持 |
| 强制更新 / 无回退 | `journal.js:82-83,101-102`；`shell-safety-net-test.js:178-221`（R10） | `deriveState` 迁移时**逐字保留**语义；不得引入 `rollback/pinned/attempt` |
| `index.js` 导出面逐字一致 | `index.js:33-35` | 保持十个键 |

### G.4 已知残留风险

| # | 风险 | 级别 | 处理 |
|---|---|---|---|
| R-1 | `tick` 一拍内 `identity()` 读 3 次（`153/181/193`），相位与 exe 可能来自不同快照 | 低 | F5 可选修复 |
| R-2 | `deps.shell` 宽注入，watchdog 对「门面 3 成员」的契约只在注释里 | 低 | jsdoc 明确（T6）；收窄会破测试夹具，不划算 |
| R-3 | 基线红项（F1：W4-a..e）若不在 F0 修，会掩盖 F1-F3 的回归 | **中** | F0 先修 |
| R-4 | `platform-capability-audit` 的 `decide` 判据在 F3 若不同步 → **假绿** | **中** | F3 必做 |
| R-5 | `e2e` 测试会真的 spawn 假壳；本轮**不跑**，CI 覆盖 | 低 | 受控环境执行 |

---

## H. 门禁建议

> 目标文件：`test/domain-structure-gate-test.js`（BRIEF §5 H）。
> **通用纪律**：所有源码级判据**必须先剥注释**（R1 取证陷阱——`index.js:13`、`watchdog.js:96` 的说明文字会伪造命中/漏命中）。
> **通用纪律**：每条判据必须配**反向自检**（构造旧形态样本验证能命中），否则门禁可能空转（BRIEF `directory-structure-gate-test.js:146-154` 已载明该教训）。
> 下表 G-S1..G-S10 中，**加粗**的 3 条（G-S3/G-S7/G-S8）是 shell 域特有、其余五域不一定适用的。

| # | 判据 | 断言 | shell 现状 |
|---|---|---|---|
| **G-S1** | DF-1 门面纯化 | `src/domains/shell/index.js` 行数 ≤150 **且** 不含 `fs.`/`child_process`/`setInterval`/`process.kill` | ✅ 35 行 |
| **G-S2** | DF-2 单文件上限 | `src/domains/shell/*.js` 每文件 ≤400 行（**代码行**另计报告，不设阈） | ✅ 最大 282 |
| **G-S3** | DF-3 纯/IO 分离（**shell 特有**） | `core.js` 内 `require` 计数 = 0 **且** 不出现 `fs.`/`spawn(`/`process.kill`/`setInterval`/`Date.now` | ✅ 设计后成立（现为 ✗） |
| **G-S4** | DF-4 零隐式 this | shell 域源码 `this.` 计数 = 0 | ✅ 0（实测） |
| **G-S5** | DF-5 无环（R1 语义） | 域内 require 图 **0 环**（剥注释后 Tarjan）；**并**断言域内无方法集合并 | ✅ |
| **G-S6** | DF-6 可独立单测 | `core.js` require 后可用**假快照**调用 `deriveState`/`decide` 并断言（门禁内联执行，不落文件、不起进程） | ✅ 设计后成立 |
| **G-S7** | DF-7 单向依赖（**shell 特有**） | ① `core.js` 零域内 require；② 无任何文件 `require('./index')`；③ **禁止** `restart.js` require `./watchdog`；④ 无环 | ✅ 设计后成立（现 ③ ✗） |
| **G-S8** | D6 语义锁（**shell 特有**） | 域内源码**禁止**：`require` 路径含 `distribution`、出现 `runNpmInstall`、出现 `rollback`/`pinnedVersions`/`should-rollback`/`id.attempts*=(?!=)`；`SHELL_RELEASE_PKG` 只允许出现在 `restart.js` 的 `fetchLatestVersion` 调用实参 | ✅（沿用 `shell-safety-net-test.js:96-103,194-221` 的判据内核） |
| **G-S9** | **R4+R6 mixin 判据（★必含）** | 见下方代码块（三条组合 + 剥注释 + 反向自检） | ✅ shell 现状 0 处（作样板） |
| **G-S10** | R7 门面只读 | `app/facade/*.js` 导出面只含只读视图；写动作须在 `app/domain-actions/`（**shell 域不涉及**；`env.js:46-49` 的 `shellWatchdog` 是只读快照，合规） | ✅ 不涉及 |

### H.1 G-S9 判据本体（R4 + R6 的合并裁决，**必须逐字采用**）

```js
// ① 任何把外部方法集挂到原型的手法（右值不限——覆盖 require(...) 与变量两种形态）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（方法集碎片）
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
// ③ 反向自检样本必须包含「右值为变量」这一条——否则漏掉 supervisor.js 的旧形态
const REVERSE_SAMPLES = [
  "Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)", // 能被 R4 旧正则命中
  "Object.assign(Supervisor.prototype, mod.methods)",                                 // R6：旧正则漏掉
  "Object.defineProperties(X.prototype, require('./x'))",                             // DS-G3 旧判据
];
```

**判据实现要点（三条硬性要求）**

1. **先剥注释**：`const code = stripComments(src)`；否则 `supervisor.js:21` 的说明文字会造成**假阳性**（R6 实测）。
2. **扫全 `src/**`**，不只看 domains——mixin 形态现存在于 `src/supervisor.js:160-161`（`Object.assign(Supervisor.prototype, mod.methods)` + `Object.defineProperties(...accessors)`），它是 R6 的直接证据。
3. **反向自检必须含 `REVERSE_SAMPLES[1]`**（右值为变量），并断言 ① 对它命中；同时断言 ① **不**误报合法写法（如 `Object.assign({}, a, b)`、`Object.assign(x.prototype)` 无第二实参）。

> ⚠ G-S9 与 shell 域的关系：**shell 是零命中的样板**（实测四文件均无该形态），故它同时也是「达标参照」。门禁通过 ≠ shell 合格，但 shell 不合格 ⇒ 门禁必然有效（反向自检）。

---

## 附录 · 可复用验收清单（★ 额外任务：供主代理写进最终 SSOT）

> 用途：回答「什么样的结构算达标」。以 shell 为**实测参照样本**（括号内为该判据在 shell 的现状）。
> 适用：所有域。`[自动]` = 可写成门禁；`[人审]` = 需 review 判定。

### L1 门面（DF-1）
- [ ] `[自动]` `index.js` 存在且 ≤150 行（shell：35 ✅）
- [ ] `[自动]` `index.js` 不含 `fs.`/`child_process`/`setInterval`/`process.kill`/`Date.now`（shell：不含 ✅）
- [ ] `[自动]` `index.js` 只有 `require` + `module.exports` 两种顶层语句形态（shell：✅）
- [ ] `[人审]` 门面注释点名的消费者**真实存在**（shell：✗ 注释指 `supervisor.js:28`，实际是 `compose.js:26`——**此类失真必须算不合格**）

### L2 文件规模与纯/IO 分离（DF-2/DF-3）
- [ ] `[自动]` 每文件 ≤400 行（shell：最大 282 ✅）
- [ ] `[自动]` 纯策略文件 `require` 计数 = 0，且无 `fs.`/`spawn(`/`process.kill`/`setInterval`/`Date.now`/`Math.random`（shell：设计后 `core.js` ✅）
- [ ] `[人审]` 每个文件能用一句话回答「它是纯的还是有副作用的」；不能回答即为混放（shell：`watchdog.js` 与 `journal.js` 现为「混放」✗ → 设计修复）

### L3 依赖方向（DF-4/DF-5/DF-7）
- [ ] `[自动]` 域内 `this.` 计数 = 0（shell：0 ✅）
- [ ] `[自动]` 域内无 `Object.(assign|defineProperties)(X.prototype, …)`（shell：0 ✅）
- [ ] `[自动]` 剥注释后域内 require 图 0 环（shell：✅）
- [ ] `[自动]` 无文件 `require('./index')`（门面不可被反向依赖）（shell：✅）
- [ ] `[自动]` 纯核心是**汇点**（零域内出度）（shell：设计后 ✅）
- [ ] `[人审]` **每条域内 require 边的方向 == 数据流方向**（流程 → 持久化 → 纯策略；**不得**出现「下游流程 require 上游谓词」）。shell：`restart → watchdog` ✗（反序）→ 设计删除

### L4 可测性（DF-6）
- [ ] `[自动]` 每个**非门面**文件可被 `require` 而不构造域对象、不启动进程、不绑端口（shell：✅）
- [ ] `[自动]` 每个**纯**文件可用假数据直调并断言（shell：设计后 `core.js` ✅；现 `journal.evaluate` ✗）
- [ ] `[人审]` 有副作用但受注入的文件（如 `watchdog.js`）必须有**注入点**（`now`/`logger`/`events`/`pidlookup`/`desktop`）（shell：✅ `watchdog.js:103-111`）

### L5 导出面与语义契约
- [ ] `[自动]` 域导出面（`index.js` 的键集合）在拆分前后**逐字一致**（shell：现有 10 键，设计不动 ✅）
- [ ] `[自动]` 拆分**不得**改变产品语义约束（shell：D6 —— 内核非壳更新源；强制更新无回退）（设计逐条守界见 §G.3）
- [ ] `[自动]` 域内不得 require 更高层或横向域（shell：跨层边仅 platform/shared ✅）
- [ ] `[人审]` 零消费者的导出键/端点**只标注不删除**（shell：`SHELL_RELEASE_PKG`、`/shell/health`、`/shell/update-pending` ✅）

### L6 门禁自身的有效性（防假绿）
- [ ] `[自动]` 每条判据配**反向自检**（构造旧形态样本必须命中，构造合法写法必须不命中）（shell：见 `directory-structure-gate-test.js:126-127,146-154,216-220` 范式）
- [ ] `[自动]` 源码级判据**先剥注释**（shell：`index.js:13`/`watchdog.js:96` 是活教材）
- [ ] `[自动]` 判据的读取面随文件搬移同步更新，否则**静默失去覆盖面**（shell：`platform-capability-audit-test.js:141` 只读 `watchdog.js` → 拆 `core.js` 后必须纳入读取集合）

### L7 样板参照（shell 的「已达标」证据）
1. `this.` 跨文件 = 0（六域唯一）；
2. `Object.assign(X.prototype, require(...))` = 0；
3. 域内 require 图 = DAG，且**未知的环**来自他域（R1 实测五域全 0 环）；
4. 域内最大文件 **代码行仅 166**——证明「行数不是唯一判据，职责纯度才是」；
5. 有状态模块 100% 经 ctor 注入 IO（`watchdog.js:103-111`），依赖不 require 具体实现；
6. 定时器**归 app 层**（`bootstrap.js:180-183`），域内不持生命期。

**shell 尚不达标的两处（本设计的全部工作量）**：① `watchdog.js` 纯决策与看护状态机混放；② `restart.js → watchdog.js` 反序依赖。**其余五域可把 shell 的 L3/L7 当作目标形态。**

---

### 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-09-17 | 初稿。按 BRIEF §5 八节 + R1–R7 补正：R1（DF-5 语义取「禁止方法合并」而非修 require 环）、R2（不建子目录）、R3（≤150/≤400 严阈值）、R4+R6（H 节 mixin 三判据 + 剥注释 + 反向自检）、R5（本域无 daemon.js，不受影响）；H.1 采用 R6 组合判据；G-S10 采 R7（shell 不涉及 `app/facade` 写动作）。 |
