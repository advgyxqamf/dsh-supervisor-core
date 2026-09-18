# P4-E-1 存疑走查报告（只读）

> 执行者：P4-E-1（主控 P4-E 的下级）。内核仓根 = 仓库根。
> 范围：作业单 §3 P4-E 的存疑 7 项中分配给我的 4 项：D11、D12、ARCHITECTURE-ACCEPTANCE 数字漂移、§5 域内目标超限 8 文件。
> 纪律：只读。本报告未改任何 src/test，未跑测试/门禁，未 require 产品模块执行，未做 git 写操作，未启 daemon，未触碰 /tmp/dsh-*、状态根。
> 快照：HEAD `24b2fb7`；取数时刻 `2026-09-17T22:34:27+08:00`。
> 该时刻工作树有并发 P4 代理改动（`M src/domains/instance/ops.js`、未跟踪的 `_p4-c-shards.md`/`_p4-d-recon.md`），以下行数与实测值以该快照为准。
> 方法：`read` / `grep` / `sed -n` / `wc` / `find` / 只读 `git`；CJK 检索用 `grep -oP '\p{Han}{4,}'`。

---

## 汇总

| 项 | 条目 | 定性 | 严重度 |
|---|---|---|---|
| A | D11 guardian 语义不一致 | **真缺陷**（实现与注释/契约不一致，静态可证） | 中低 |
| B | D12 stopProcess「停止落空」 | **真缺陷**（kill 失败被吞、无失败事件、状态无条件置 STOPPED）；「落空」实际发生需运行期证据 | 中低 |
| C | ARCHITECTURE-ACCEPTANCE 数字漂移 | **真漂移**（文档存档值过期；硬门禁仍全过） | 低（文档） |
| D | §5 域内目标超限 8 文件 | **真漂移**（8 项中 6 项仍超 SSOT 域内目标；非 CI 红项） | 低（SSOT 目标） |

---

## A. D11 guardian 语义不一致（health-gate 假死分支不看 guardian）

**定性：真缺陷**（语义不一致；静态可证，中低）。

### 分支逐一走查（当前树）

守护理性判定分两条路（均以 `state.guardian()` 为唯一读口，见 `src/app/state/fields.js:46-52`）：

1. **进程退出路径（检查 guardian）**：
   - `src/app/main/process.js:95-115` 的 `child.on('exit')`：`:107` `if (this.state.phase() === 'STARTING' || this.state.guardian())` 才 `_beginRestart`；否则 `:110-112` 置 `_crashHalted`、`guardian_off_exit`、`STOPPED`。
   - `src/app/main/controller.js:155` `const guarded = this.state.guardian();`；`:156-160` adopted_exit 分支判 `guarded`（`:159`）；`:161-163` child_exit 分支判 `guarded`（`:162`）。
2. **HTTP 假死路径（不检查 guardian）**：
   - `src/app/main/controller.js:164-171`（RUNNING 的 else 分支）：`:167` `const healthDecision = this.main.applyHealthCheck(healthOk);`，`:168` 若 `healthDecision.restart` 则 `:169` 直接 `this.main.beginRestart(...)`。**全程不读 `guarded`**。
   - `src/app/main/health-gate.js:39-51` `_applyHealthCheck(healthOk)`：仅做 `failStreak` 记账与阈值判定，返回 `{ restart: true, reason: 'http_unhealthy', countCrash: true }`；函数签名只收 `healthOk`，**无 guardian 入参**。文件头 `:32-38` 与 `src/app/main/controller.js:165-166` 注释均声明「本方法只记账 + 返回决策，执行由收敛器承担」。
   - 对照注释：`src/app/main/controller.js:153-154` 写「守护语义：崩溃是否自动接管拉起看守护开关 guardian——开=自动拉起；关=回到停止态」；`process.js:105-106` 同口径。假死分支（`:164-171`）与其紧邻注释自相矛盾。

### 证据链（file:line）

- 检查 guardian：`src/app/main/controller.js:155,159,162`；`src/app/main/process.js:107`
- 不检查 guardian：`src/app/main/controller.js:164-171`（`:167` 调 `applyHealthCheck`、`:169` `beginRestart`）；`src/app/main/health-gate.js:39-51`
- 冻结契约：`ARCHITECTURE-CONTRACT-phase0.md:190`「崩溃是否重启 = 是否应运行 && (guardian == true)」；`GUARD-DOMAIN-MODEL.md:44`「guardian=false → 停就停」
- 来源：`design-notes/AUDIT-r5-app-orchestration-api-boundary.md:295-297`（原文即注 `controller.js:177-180`）

### 行号漂移说明

疑点写作 `health-gate.js:43-55` 与 `:165-173`，与当前树不符：当前 `health-gate.js` 仅 53 行（`:43-51` 即 `_applyHealthCheck` 主体，`:52-53` 为注释尾/收尾花括号），`:165-173` 不可能位于该文件。AUDIT 原文本身即把假死分支标注为 `controller.js:177-180`。**结论：以「符号 + 文本」定位，假死分支 = 当前 `controller.js:164-171`。**

### 最小修法（二选一，需主控/SSOT 裁决）

- **(a) 语义定为「假死不属崩溃、必须自愈」**：在 `controller.js:164-171` 补一行注释（并建议加一个独立事件如 `http_unhealthy_restart`）明确「假死自愈不受 guardian 约束」，消除实现与邻近注释/契约的冲突。改动最小、无新状态。
- **(b) 语义定为「guardian=false 一律不自愈」**：**不能**在 `:168` 简单前置 `if (guarded)` —— 假死进程仍在、端口仍在，下一拍 `controller.js:121-124` 的 `portUp → this.main.adopt()` 会反复把状态拉回 RUNNING，形成 adopt↔假死空转；必须同时给「假死 + guardian=false」一个稳定态（保持 RUNNING 但发告警、或 STOPPED 且不再 adopt），属状态机改动、风险高。

**推荐 (a)**（最小且不引入死循环）。若主控认为 (b) 是正解，应作为独立状态机任务立项。

**置信度：高**（分支结构静态确定；`guarded` 是否应覆盖「假死」属产品语义，需主控裁决——此为唯一不确定处）。

---

## B. D12 stopProcess「停止落空」

**定性：真缺陷**（kill 失败被吞、无失败事件、状态无条件置 STOPPED）；**「落空」的实际发生需运行期证据**（依赖 kill 失败或 SIGKILL 免疫）。

### 疑点校正（重要）

AUDIT 原文 `design-notes/AUDIT-r5-app-orchestration-api-boundary.md:298-300` 称「`process.js:246-249` stopProcess **先清 adoptedPid 再 killAdopted**」。**该机制在当前树不成立**：

- `src/app/main/process.js:233` `const adoptedPid = this._mAdoptPid();` —— **先取局部副本**；
- `:237` `this._mSetAdoptPid(null);` —— 之后才清；
- `:240` `else if (adoptedPid) this.main.killAdopted(adoptedPid);` —— 用的是副本。

即「先取后清」部分**已正确**，不是缺陷（`src/app/state/upgrade-hold.js:36-38` 的 `enterAsync` 亦按「先捕获目标引用」这一约定编写）。

### 真实缺陷逐行走查

`stopProcess` 全文 `src/app/main/process.js:228-242`：

```
228  stopProcess(reason) {
229    this.main.actNote('stop', reason);
230    this.events.append('stop', { reason });
231    this.logger.info('stop: ' + reason);
232    const child = this._mChild();
233    const adoptedPid = this._mAdoptPid();
234    this.state.setPhase('STOPPED');          // ← 无条件置 STOPPED（未等确认）
235    this._mSetChild(null);
236    this._mSetAdopted(false);
237    this._mSetAdoptPid(null);
238    this._mSetFailStreak(0);
239    if (child && child.exitCode === null) this.main.killSequence(child);
240    else if (adoptedPid) this.main.killAdopted(adoptedPid);   // ← 无返回值、无失败回报
241    this.state.write();
242  }
```

kill 链路吞掉一切失败：

- `src/app/main/signals.js:61-80` `_killAdopted(pid)`：`:63-65` `try { process.kill(pid, 'SIGTERM'); } catch {}`；`:66-79` 定时器到点后仅在 `pidlook.isAlive(pid)` 为真时发 SIGKILL —— `:72-73` `pc.killTree(pid, 'SIGKILL', () => {})` **回调被丢弃**；`:75` 兜底 `try { process.kill(pid, 'SIGKILL'); } catch {}`。**函数无返回值、无失败事件**。
- `src/app/main/signals.js:46-58` `_killSequence(child)`：`:50` `_signalChild` → `src/platform/os/process.js:18-25` `signalProcess`：Windows `:21` `catch {}`、POSIX `:24` `catch { try { process.kill(pid, sig); } catch {} }` —— 内部自吞，绝不抛出，返回 `undefined`。
- `src/platform/os/process.js:29-39` `killTree`：POSIX `:37-38` 调 `signalProcess` 后 `process.nextTick(cb, null)` **恒报成功**；Windows `:32-34` 的 `taskkill` 结果只回调给调用方，而调用方 `signals.js:73` 传的是 `()=>{}`。

### 「落空」后果链（静态可推）

1. stop 发 SIGTERM/SIGKILL 失败（如 EPERM、或 `_adoptKillTimer` 单槽被后续 stop 覆盖、或 Windows `taskkill` 失败被丢弃）→ 目标进程仍存活。
2. `stopProcess` 已把 phase 置 `STOPPED` 并清空 `adoptPid`，且 `:230` 只发「stop」**成功事件**，无失败事件。
3. 下一拍 controller 走 `desired=stopped` 分支 `src/app/main/controller.js:66-87`：`:75` `portUp` 为真 → `:76` `this.main.adoptObserved()` → `src/app/main/process.js:142-161` 置 `OBSERVED`、重新记录 `adoptPid`。用户点「停止」，面板却显示「观测中」，且无任何失败事件。
4. 若进程已不监听端口但未死，则停在 `STOPPED`（假停止）。
5. 辅助风险：`signals.js:66-67` 的 `_adoptKillTimer` 为单槽，重复 `stopProcess` 会覆盖前一次的确认定时器（与积压 D13 `signals.js:59-65` 的 `_killTimer` 单槽同源）。

### 最小修法

- **(1)（推荐，最小）** `src/app/main/signals.js:66-79` 定时器内：SIGKILL 后仍 `pidlook.isAlive(pid)`，追加失败事件（如 `this.events.append('stop_failed', { pid, adopted: true })`）+ `this.logger.warn(...)`。不改状态机，失败不再静默。
- **(2)** 令 `stopProcess` 不再无条件置 STOPPED，或返回确认结果（需等 `exit` 事件 / adopt 存活确认），调用方如实回报；改动面较大（`controller.js:69,92`、`desired.js:30`、`upgrade-hold.js:28`、`shutdown.js:95` 四处调用点）。
- **(3)** `_adoptKillTimer` 句柄加代际 / 调用前 `clearTimeout`，避免覆盖（与 D13 合并处理）。

**置信度：高**（吞异常、无失败事件、无条件置 STOPPED 均静态确定）；**「停止落空」的实际发生需运行期证据**（kill 失败/免疫场景），属运行期验证项。

---

## C. ARCHITECTURE-ACCEPTANCE 数字漂移

### 三个存档数字各指什么（附行号与上下文）

```
ARCHITECTURE-ACCEPTANCE.md:65:  | 最大单文件 | **1319**（supervisor.js） | **298** |   ← 298 = 终态最大单文件行数
ARCHITECTURE-ACCEPTANCE.md:68:  | src/supervisor.js | 1319 行 | **79 行** |                 ← 79 = src/supervisor.js 行数
ARCHITECTURE-ACCEPTANCE.md:72:  | 测试链条目 | — | **125** |                                ← 125 = package.json#scripts.test 链条目数
```

旁证（同文件）：`:16`「test（ubuntu-latest，127 条测试链…）」、`:55`「链现为 129 条」、`:64` src 文件数 256、`:66` `>300` 行 0、`:67` 门面 `index.js >150` 行 0、`:82`「薄壳（79 行）」、`:92`「最大 298」。

### 当前树实测对照

取数时刻 `2026-09-17T22:34:27+08:00`，HEAD `24b2fb7`：

| 指标 | 存档值（行） | 当前实测 | 实测命令（只读） |
|---|---|---|---|
| 最大单文件 | 298（:65） | **300**（`src/domains/router/handlers/forward.js`） | `find src -type f -name '*.js' -exec wc -l {} + \| sort -rn` |
| `src/supervisor.js` | 79（:68） | **66** | `wc -l src/supervisor.js` |
| 测试链条目 | 125（:72） | **129** | `node -e ```const t=require('./package.json').scripts.test;console.log(t.length,t.split(' && ').length)```` |
| （附）`scripts.test` 长度 | — | **7899 字符**（余量 101/8000） | 同上，`t.length` |
| （附）`src/` .js 文件数 | 256（:64） | **257** | `find src -name '*.js' \| wc -l` |
| （附）`>300` 行文件 | 0（:66） | **0** | 同上排序，实测最大 300 |
| （附）门面 `index.js` 最大 | ≤150 声明（:67） | **150**（`src/domains/router/index.js`） | `find src -name 'index.js' -exec wc -l {} +` |

### 结论

- **定性：真漂移**（文档存档数字过期）。三个数字：298→300、79→66、125→129（src 文件数 256→257）。
- **硬门禁仍全过**：DF-2「单文件 ≤300」——最大 300 恰在阈值内、`>300` 计数 0；DF-1「门面 ≤150」——最大 150 恰在阈值内。故不是 CI 红项，属存档过期。
- 任务所给参考值「supervisor 约 78 行」与当前树不符。git 证据：`git show 3edd267:src/supervisor.js \| wc -l` = **78**，`git show b2f3d3d:src/supervisor.js \| wc -l` = **66**，`git show HEAD:src/supervisor.js \| wc -l` = **66** —— 78 属更早提交，**当前真实值为 66**。78 这个参考值本身即来自旧提交/旧文档（`design-notes/_p3-e-audit-backlog.md:146` 亦写 78，同源过期）。
- **最小修法**：由 P4-D 更新 `:65/:68/:72`（及 `:64/:82/:92`）为实测值并注明取数日期；或按同文件 `:38-41` 已有口径「本表刻意不记会过期的条数」，改为只写判定口径 + 快照日期，不再写死物理指标。

**置信度：高**（行数与链长为可复现的只读实测）。不确定处：并发 P4 代理仍可能再改 `src/`（取数时已有 `src/domains/instance/ops.js` 被修改），以本报告快照时刻为准。

---

## D. §5 域内目标超限 8 文件

### 判据与出处

- 「超限」判据**不是**硬门禁 DF-1/DF-2，而是 SSOT `DOMAIN-STRUCTURE-DESIGN.md` §5 的**域内目标值**。来源报告 `design-notes/AUDIT-r5-architecture-consistency.md:214-227`（D1）明确写着「这些是 SSOT 的域内目标（非 DF-1/DF-2 硬门禁）」。
- 来源清单（当时值）：`design-notes/AUDIT-r5-architecture-consistency.md:214-223`。
- SSOT 目标行：`DOMAIN-STRUCTURE-DESIGN.md:121`（freeze ≤200）、`:151`（relay/daemon 不变 214）、`:163`（instance/index ≤95）、`:182`（plugin/index ≤70）、`:187`（plugin/store ~180）、`:188`（plugin/layers ~170）、`:191`（plugin/market ~260）、`:209`（shell/core ~95）。

### 对照表（「当时值 → 当前值 → 是否仍超限」）

取数时刻 `2026-09-17T22:34:27+08:00`，当前值 = `wc -l` 实测：

| # | 文件 | 目标（SSOT:行） | 当时值（AUDIT:行） | 当前值 | 是否仍超限 |
|---|---|---|---|---|---|
| 1 | `src/domains/instance/index.js` | ≤95（DOMAIN:163） | 102（AUDIT:216） | **95** | **否**（恰好=目标，贴线） |
| 2 | `src/domains/plugin/index.js` | ≤70（DOMAIN:182） | 84（AUDIT:217） | **80** | **是**（超 10） |
| 3 | `src/domains/plugin/layers.js` | ~170（DOMAIN:188） | 223（AUDIT:218） | **223** | **是**（超 53） |
| 4 | `src/domains/plugin/store.js` | ~180（DOMAIN:187） | 193（AUDIT:219） | **193** | **是**（超 13） |
| 5 | `src/domains/plugin/market.js` | ~260（DOMAIN:191） | 264（AUDIT:220） | **261** | **是**（超 1，边界） |
| 6 | `src/domains/router/providers/policies/freeze.js` | ≤200（DOMAIN:121） | 236（AUDIT:221） | **234** | **是**（超 34） |
| 7 | `src/domains/shell/core.js` | ~95（DOMAIN:209） | 106（AUDIT:222） | **106** | **是**（超 11） |
| 8 | `src/domains/relay/daemon.js` | 214（DOMAIN:151） | 217（AUDIT:223） | **194** | **否**（低于目标 20） |

### 结论

- **定性：真漂移**（SSOT 域内目标未随实际收敛同步）。8 个文件里 **2 个已不超限**（`instance/index.js` 收敛到 95、`relay/daemon.js` 降到 194），**6 个仍超限**：plugin 域 4 个（index/layers/store/market）、router freeze、shell core。
- **6 个仍超限文件全部满足硬门禁 DF-2 ≤300**（最大 234），故**不是 CI 红项**，属 §5 计划目标与现值两套并存。
- 敏感点：`plugin/market.js` 仅超 1 行；`instance/index.js` 已贴线（95=95）——后续任何新增行都会立刻重新越界。
- **最小修法**（承 AUDIT D1 建议，二选一，勿两套并存）：① 继续按 §5 目标收敛；或 ② 在 SSOT 中把目标值更新为现值并注明取数日期。建议先做 ②（低风险、一次对齐），把收敛另立任务。

**置信度：高**（当前值 `wc -l` 可直接复现；目标值逐行读到）。不确定处：`layers/store/market/shell/core` 的 SSOT 目标写作 `~NNN` 近似值，`market.js` 261 vs `~260` 是否判违规取决于「~」的容忍度；`freeze/instance/index` 为硬 `≤` 值，判定无歧义。

---

## 附：本报告未做 / 局限

- 未运行任何测试或门禁；未 `require` 产品模块执行；未做内存冒烟；未启 daemon；未改 src/test；未做 git 写操作。
- A/B 项的「真缺陷」为静态分支/异常处理结论；B 项所述「停止落空」的实际触发需运行期条件（kill 失败、权限或平台差异），已如实标注为运行期验证项。
- C/D 行为行数实测，只读可复现；并发 P4 代理可能继续改动 `src/`，数值以快照时刻为准。
