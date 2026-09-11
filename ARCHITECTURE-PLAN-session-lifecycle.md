# 根因级架构计划：会话生命周期与所有权重构

> 基于本轮全部调查（退出死锁、启不回来、端口池、状态双写、事件水位、壳/核配合）。
> 目标：**找出真正的根因并从架构层解决，不做补丁**。
>
> ## ⚠ 本计划**已执行**，其中的 文件:行号 是撰写时快照
>
> 计划本身（所有权矩阵、退出时序、状态机收敛）已落地：`supervisor.js` 已从 1188 行
> 拆为 6 个 `guard/supervisor/*-view.js` mixin，`src/` 目录结构亦经重构。
> 故文中 `main.rs:256`、`supervisor.js:1698` 等行号**全部失效** —— 要看现状请读代码。

---

## 第一部分　产品意图与实现的落差

### 你的产品定义

- 壳是**容器/呈现层**，内核是**业务本体**；壳不做业务。
- 关窗**只有两种**：hide（隐藏托盘，服务继续）/ exit（退出全部服务）。
- 该二态是**系统级设置**，存在内核，壳读取执行。

### 实现现状

| 意图 | 实现 | 落差 |
|---|---|---|
| 关窗二态由内核设置驱动 | 内核 config.closeAction + API + UI + 壳读取 | 设计齐备 |
| hide：服务继续 | 壳 window.hide() + prevent_close | 做通 |
| exit：退出全部服务 | 壳 POST /shutdown 后立即 app.exit(0) | **未做通** |
| 退出后仍能正常再启动 | 依赖 desired/guardian/意图 | **未做通** |

---

## 第二部分　症状收敛：一堆问题其实只有 3 个根因

### 症状清单（全部已实测）

1. 退出管家时 systemctl stop 自我死锁 → spawnSync systemctl ETIMEDOUT（日志铁证）。
2. 退出后程序起不来：desired=running + guardian=false + 意图不持久 → 新守卫不拉起 DSH。
3. 壳 POST /shutdown 发完即弃 → 与内核退出竞态。
4. 壳直接 spawn daemon vs systemd 单元 Restart=always → **双启动器、身份漂移**。
5. _stopAllSandboxes 用 dsh-web@* 不经 shell → glob 不展开，沙箱停不掉。
6. env.rs 用字符串正则扫 config.json 读 closeAction → 脆弱。
7. 审计 A1/B1/B2：desired 不被强制、state.json 与 managed-objects.json 权威倒置、崩溃字段双副本。
8. 端口池曾固定小段/越界（已修，暴露了「段=常量」的架构问题）。
9. 事件水位/过滤双路径语义不一致（已修，暴露了「双读路径」的架构问题）。

### 收敛：3 个真正的根因

#### 根因 A —— 守卫的生命周期所有权不唯一（最根本）

守卫可以被**两个互不知晓的启动器**拉起，也可以**自己停自己**：

- 启动器 1：**systemd 单元**（enabled + linger + Restart=always）→ 开机/崩溃。
- 启动器 2：**壳 ensure_guard 直接 spawn**（main.rs:256）→ 会话期。
- 自杀路径：**守卫在 shutdownAll 里 systemctl stop 自己**（supervisor.js:1698）。

→ 结果：进程可游离于 systemd 之外；停止时**自己等自己的启动器**造成死锁；没有任何一方是「生命周期的最终权威」。**这是所有退出异常的总根源。**

#### 根因 B —— 用户意图被建模成三个不同生命周期的东西

| 载体 | 持久化 | 语义 | 谁在管 |
|---|---|---|---|
| desired（state.json / managed-objects.json） | 持久 | 用户意图 running/stopped | 收敛循环 |
| guardian（dsh-main.json） | 持久 | 崩溃自动拉起策略 | 收敛门 _mGuardian() || intents.any() |
| IntentLedger | **内存，重启即失** | 一次性显式动作 | 收敛点消费 |

→ 三者**无明确优先级**：守卫重启后只剩 desired，而拉起门却要求 guardian || 内存意图。desired=running 是「持久用户意图」却不被执行——这就是「起不来」。同样的结构缺陷也让端口、崩溃窗出现「双副本」。

#### 根因 C —— 缺少「会话/运行生命周期」这一层抽象

系统有「进程守护（guardian）」和「期望状态（desired）」，但**没有**一个贯通 壳+守卫+服务 的**运行生命周期状态机**：

- 关窗的 exit 本质是一个**会话生命周期决策**（停止整个运行单元），却被拆成「壳读配置 + 调一个半成品 /shutdown」。
- 没有 starting/running/stopping/stopped 的会话态，就无法表达「正在退出，勿拉起」「已退出，下次启动要恢复什么」。
- 因此退出顺序、握手、恢复语义都只能靠零散代码拼——**补丁的温床**。

---

## 第三部分　目标架构（职责边界 + 状态机 + 所有权）

### 3.1 唯一的生命周期所有权（解决根因 A）

**铁律：一个进程只有一个生命周期所有者。**

- **守卫的所有者 = systemd 用户单元（唯一）**。
  - 开机/会话/崩溃由 systemd 负责（Restart=always 保留）。
  - 壳**绝不 spawn 守卫**；只 systemctl --user start（或探测已活）。
  - 守卫**绝不 systemctl stop 自己**——它只停「被管对象」，然后 process.exit(0)；由**壳**去 systemctl --user stop。
- **被管对象（DSH 主实例 / 沙箱 / router-daemon / lan-daemon）的所有者 = 守卫**。
  - 只有守卫停它们；壳不直接碰。
- **壳的所有者 = 桌面会话**（用户/桌面 autostart）。

### 3.2 退出时序（解决根因 A + C）

正确顺序（谁停谁，一目了然）：

    用户关窗（closeAction=exit）
      → 壳 POST /session/stop        （请求内核进入 stopping）
      → 内核：停 main + 沙箱 + daemon → 返回 {ok, sessionState:stopped}  （内核不碰 systemctl）
      → 壳收到回执 → systemctl --user stop dsh-supervisor  （壳停内核，合法）
      → 守卫 process.exit(0)（在回执之后自然退出）
      → 壳 app.exit(0)

关键点：**内核从不停止自己所属的 systemd 单元**；停止守卫的是它外部的壳。这同时消除了死锁与竞态。

### 3.3 意图单一事实源（解决根因 B）

**新模型：意图 = 持久化的会话期望态，唯一载体，三层明确。**

- **desired（唯一持久意图）**：running | stopped。
  - **语义升级**：它是**持久用户意图**，守卫重启后**必须**据此恢复（desired=running → 拉起 DSH），不再需要 guardian 或内存意图来解锁。
- **guardian（纯策略，不表达意图）**：只回答「进程意外死亡时是否自动重启」。
  - 与 desired **完全正交**：desired 决定「该不该运行」，guardian 决定「崩了要不要救」。
- **IntentLedger（瞬态加速器，可选）**：仅用于「同一次运行内的一次性动作」，**绝不作为恢复依据**；重启后由 desired 兜底。

由此：**重启恢复逻辑 = 读 desired，无条件执行**（除 upgradeHold 等明确的临时闸）。

### 3.4 会话状态机（解决根因 C）

新增显式的运行生命周期（贯通壳与内核）：

    sessionState:  starting → running → stopping → stopped
                                      ↘ failed

- running：服务在跑，可接受启停。
- stopping：正在按序停链；**期间任何自动拉起被抑制**（替代今天用 desired=stopped 兼作「别拉起」的 hack）。
- stopped：全部停止，守卫即将退出。
- 内核 /session/status 暴露该态；壳据此做退出握手与下次启动判断。

### 3.5 配置读取健壮化（根因 A 的伴随）

- 壳读 closeAction 改为**真正的 JSON 解析**，不再字符串正则。
- 或更优：壳经内核 API GET /settings/close-action 读取（同源、已存在），配置文件格式变化不影响壳。

### 3.6 其它架构级修正（顺带根治的既有债）

- **状态单一事实源**：managed-objects.json 是唯一权威；state.json 降级为**纯只读投影**（或直接废弃）——一次性解决 B1/B2 双副本。
- **端口池**：保留已重构的「可配置物理池」（已是工业形态），补 dsh-web@* 停止的 glob 正确性。
- **事件单读路径**：只保留 EventHub 一条读路径，删除 fallback 双语义。

---

## 第四部分　分阶段实施计划（每阶段独立可验收）

### 阶段 0　契约冻结（不写业务代码，先定边界）

- 产出：**生命周期所有权矩阵**（谁启动/停止谁）+ **会话状态机定义** + **退出时序图**。
- 验收：矩阵中每个进程恰好一个所有者；无「自己停自己」；无「两个启动器」。

### 阶段 1　所有权归一（解决根因 A，最高优先）

1. 壳删除直接 spawn daemon，改为 systemctl --user start（非 Linux 走各平台自启器）+ 探测已活。
2. 内核 shutdownAll 删除 systemctl stop 分支，改为：停被管对象 → 置 sessionState=stopped → 返回回执。
3. 壳改为：POST /session/stop → **等回执** → systemctl --user stop → app.exit。
- 验收：退出无 ETIMEDOUT；journalctl 可见「壳停守卫」而非「守卫停自己」；退出后 systemd 单元 inactive 且**不再被 Restart 拉起**。

### 阶段 2　意图单源（解决根因 B，第二优先）

1. 收敛拉起门：desired=running **无条件**触发拉起（guardian 只管崩溃重启，不再参与「首次拉起」判定）。
2. IntentLedger 明确为瞬态加速器，契约写明「重启后由 desired 兜底」。
3. state.json 与 managed-objects.json 权威归一（单源，另一份为投影）。
- 验收：新增测试「守卫重启 + desired=running + guardian=false + 端口空 → 必须拉起」；退出后重开壳，DSH 自动恢复。

### 阶段 3　会话状态机（解决根因 C）

1. 内核实现 sessionState（starting/running/stopping/stopped）与 /session/status。
2. stopping 期间抑制所有自动拉起（替代 desired 兼作闸的 hack）。
3. 壳退出握手基于 sessionState 轮询；关窗二态完全由该状态机驱动。
- 验收：关窗 hide → sessionState=running 不变；关窗 exit → 观测 running→stopping→stopped 全链路事件。

### 阶段 4　遗留债清零（收尾）

- _stopAllSandboxes glob 正确性（按实际单元名停）。
- 壳 closeAction 改经 API 读取（删除字符串正则）。
- 事件单读路径；端口池边界测试补全。
- 验证：全量 npm test + UI 门禁 + 实机退出/重启/恢复三场景。

---

## 第五部分　防回归护栏（确保不再打补丁）

1. **架构不变量测试**（新增）：
   - 「守卫不得在自身进程内调用停止自己所属单元的 systemctl」——静态检查 + 集成断言。
   - 「每个进程一个所有者」——所有权矩阵对账测试。
   - 「desired=running 重启必拉起」——恢复语义门。
   - 「退出后无孤儿进程/端口」——退出后 systemd/端口/进程三重扫描。
2. **两态关窗的端到端测试**：hide 与 exit 各一条链路（壳↔内核握手 + 状态机 + 恢复）。
3. **禁止清单**：不允许再出现「某处再补一个标志位压住问题」；所有状态必须归入 sessionState / desired / guardian 三者之一且语义单一。

---

## 第六部分　优先级与依赖

| 顺序 | 阶段 | 解决 | 依赖 | 风险 |
|---|---|---|---|---|
| 1 | 阶段 1 所有权归一 | 退出死锁、身份漂移、起不来(部分) | 阶段 0 | 中（跨壳改动） |
| 2 | 阶段 2 意图单源 | 起不来(根因)、状态双写 | 阶段 0 | 中（收敛语义） |
| 3 | 阶段 3 会话状态机 | 退出握手、关窗二态完整性 | 阶段 1/2 | 中 |
| 4 | 阶段 4 遗留债 | glob/解析/事件路径 | 阶段 3 | 低 |

**结论**：三个根因（所有权不唯一 / 意图三载体 / 缺会话状态机）**共同解释了你观察到的全部现象**。
按阶段 1→2→3 实施，可一次性根治「退出后起不来」与「退出逻辑与壳配合」问题，并顺带清掉此前的状态双写与恢复语义债——**不是补丁，是边界重构**。

---

## 阶段 1 实施完成记录（所有权归一）

### 已落地

| 项 | 位置 | 内容 |
|---|---|---|
| V2 修复 | src/supervisor.js shutdownAll | 删除 `systemctl stop` 自己 → 停被管对象后置 sessionState=stopped 并回执；**守卫不自退** |
| V3 修复 | src/supervisor.js guardSelfUpdateRestart | 删除 `systemctl restart` 自己 → 退回执，由 systemd Restart=always 经进程退出拉起 |
| V5 修复 | src/supervisor.js _stopAllSandboxes | `dsh-web@*`（不经 shell 不展开）→ 按实际单元名逐个停 |
| 会话态 | src/supervisor.js | 新增 `_sessionState`（starting/running/stopping/stopped）、`sessionState()`、`_setSessionState()`、`_sessionHalting()` |
| INV-S1 | src/supervisor.js _dshConverge | stopping/stopped 期间抑制一切自动拉起 |
| 退出语义 | src/supervisor.js _stopMainDsh | 退出会话**不再翻 desired**（保留用户运行意图；停后不拉起由 sessionState 抑制） |
| API | src/api/lifecycle.js | 新增 `GET /session/status`、`POST /session/stop` |
| V1 修复（壳） | .shell-work main.rs | 删除 `spawn daemon` → `start_guard_service()`（systemctl/launchctl/schtasks） |
| V1 修复（壳） | .shell-work main.rs | 退出改为 `shutdown_all()`：`POST /session/stop`（等回执）→ `stop_guard_service()` |
| 防回归 | test/session-lifecycle-test.js | INV-X1/S1/S2/S4 + V1 壳不变量，已入 npm test 链 |

### 验证结果

| 验证 | 结果 |
|---|---|
| `npm test`（32 文件） | **618 passed / 0 failed，EXIT=0** |
| 源码态端到端（/session/stop） | 回执 `{ok:true,sessionState:stopped}`；**守卫进程存活不自退**；日志「等待外部所有者停止守卫进程」 |
| 壳结构核验 | start/stop_guard_service 各 4 定义（三平台+fallback）；无 `spawn daemon`；退出两处均走握手；括号平衡 156/156 |

### 遗留 / 交接

- **壳需在壳仓 `cargo build` 验证**（本环境无 cargo）——源码已改，结构核验通过。
- **发布**：本机运行的守卫是 npm 安装的 0.1.2-BETA.7（旧版），阶段 1 改动需重新构建/安装内核方生效。
- **观察到的既有影子差异**：`shadow=start vs actual=none`（desired=running + guardian=false + 无意图时，纯决策认为该拉起但门不放行）——**阶段 2「意图单源」将消除**（desired=running 无条件拉起）。

### 阶段 1 达成的根因修复

- 根因 A（所有权不唯一）：守卫不再自停/自重启（V2/V3），壳不再 spawn（V1）→ **退出死锁与身份漂移的结构性根除**。
- 退出链路：`壳 → /session/stop → 内核停对象+回执 → 壳 systemctl stop → 守卫自然退出`，无自停、无 ETIMEDOUT。

下一步：**阶段 2（意图单源）** —— desired=running 无条件恢复、guardian 纯策略、state.json 降为投影。


---

## 阶段 2 实施完成记录（意图单源）

### 已落地

| 项 | 位置 | 内容 |
|---|---|---|
| 拉起门重构 | src/supervisor.js STOPPED 分支 | `guardian || intents.any()` → `_shouldRun()`；**desired=running 无条件拉起** |
| 判定规则 | src/supervisor.js `_shouldRun()` | `desired==running && !sessionHalting && !crashHalted`（契约 §6） |
| 守护语义保留 | src/supervisor.js | 新增瞬态 `_crashHalted`：guardian=false 崩溃 → 停靠；显式启动/重启/拉起时清除；**不持久化** |
| 意图定位 | src/guard/intent.js | 契约注释：IntentLedger = **瞬态加速器，非恢复依据** |
| 状态单源 | src/supervisor.js loadState | state.json 的 desired **仅在目录无磁盘来源时**作一次性迁移种子；否则目录权威（B1 修复） |
| 磁盘来源标记 | src/guard/lifecycle/objects.js | `_loadedFromDisk`（构造前是否存在文件）——精确判定迁移 vs 权威 |
| 测试 | test/session-lifecycle-test.js | P2-A/B/C/D 恢复语义 + 守护语义门（已入链） |

### 验证结果

| 验证 | 结果 |
|---|---|
| `npm test`（32 文件） | **623 passed / 0 failed，EXIT=0** |
| 端到端恢复（/tmp/e2e-recovery.sh） | ① desired=running+guardian=false → **拉起**（旧架构不拉）；② /session/stop 后 desired **未被翻转**；③ 重开守卫 → **自动恢复运行** |
| smoke S12 | 34/34（回归修复：迁移判定用 `_loadedFromDisk` 而非文件存在性） |

### 阶段 2 达成的根因修复

- 根因 B（意图三载体）：**desired 成为唯一「是否运行」权威**；guardian 退回纯崩溃策略；IntentLedger 降为瞬态加速器。
- 「退出后起不来」：退出不再翻转 desired + 重开按 desired 无条件恢复 → **根治**。
- 状态双写（B1）：state.json 降为投影，目录为权威。

### 遗留

- 阶段 3（会话状态机贯通壳/前端 API 暴露）；阶段 4（glob 已修、壳 closeAction 改经 API、事件单读路径）。
- 壳改动仍需壳仓 cargo build 验证；内核需重新构建/安装本机生效。


---

## 阶段 3 实施完成记录（会话状态机贯通）

### 已落地

| 项 | 位置 | 内容 |
|---|---|---|
| 会话态暴露 | src/supervisor.js statusSummary | 新增 `sessionState` 字段（与 phase 正交），面板/壳可读 |
| INV-S1 全域 | src/supervisor.js | `_dshSuperviseOnce` / `_sandboxSuperviseOnce` / `_daemonSuperviseOnce` 三处入口在 halting 时短路（原先仅 `_dshConverge`） |
| 前端类型 | ui/src/services/supervisor/types.ts | 新增 `SessionState` 类型 + `SupervisorStatus.sessionState` |
| 前端客户端 | ui/src/services/supervisor/client.ts | 新增 `sessionStatus()` → GET /session/status（INV-S4 唯一读取口） |
| 前端展示 | ui/src/features/supervisor/SupervisorApp.tsx | 状态栏：stopping/stopped 明确表达「正在退出/已退出」 |
| 壳握手增强 | .shell-work main.rs | `post_local_timeout`（防守卫挂起阻塞）+ `get_session_state` 轮询至 stopped + `stop_guard_service` |
| 测试 | test/session-lifecycle-test.js | P3-A…H：会话态暴露/迁移/全域抑制/前端接入/壳握手（已入链） |

### 验证结果

| 验证 | 结果 |
|---|---|
| `npm test`（32 文件） | **631 passed / 0 failed，EXIT=0** |
| UI typecheck / lint / test / build | 全通过 |
| 端到端（/tmp/e2e-phase3b.sh） | A) hide：sessionState 保持 running；B) exit：/session/stop → stopped（回执 `{ok,sessionState:stopped}`）；C) /status.sessionState 可读；D) 被管对象端口已释放 |

### 阶段 3 达成的根因修复

- 根因 C（缺会话抽象）：**sessionState 全线贯通**（内核状态机 → statusSummary → 前端 API/类型/展示 → 壳握手），
  退出顺序、握手、恢复语义均由显式状态机表达，不再依赖零散标志拼装。
- INV-S1 全域：退出中抑制的不只是 main，而是全部被管对象（main/沙箱/router/lan daemon）。

### 遗留（阶段 4）

- 壳 closeAction 改经内核 API 读取（删除 env.rs 字符串正则）。
- 事件单读路径（删除 fallback 双语义）。
- 壳改动仍需壳仓 cargo build 验证；内核需重新构建/安装本机生效。

## 四阶段总结

| 阶段 | 状态 | 核心 |
|---|---|---|
| 0 契约 | ✅ | 所有权矩阵 / 会话状态机 / 退出时序冻结 |
| 1 所有权归一 | ✅ | 取消自停/自重启、壳不再 spawn、退出握手 |
| 2 意图单源 | ✅ | desired 唯一权威、恢复语义、state.json 降为投影 |
| 3 会话贯通 | ✅ | sessionState 全线贯通 + INV-S1 全域 + 壳握手增强 |
| 4 遗留债 | ⏳ | closeAction 经 API、事件单读路径 |


---

## 阶段 4 实施完成记录（遗留债清零）

### 已落地

| 项 | 位置 | 内容 |
|---|---|---|
| 事件单读路径 | src/platform/loghub.js | 新增 **EventReader**（空对象适配器）：把本地事件流适配成与 EventHub **完全相同**的读接口 |
| 读实现共享 | src/platform/loghub.js | `visibleFrom/filteredFrom/exportFrom/metricsFrom` 单一实现，EventHub 与 EventReader 共用（消除双语义漂移） |
| 降级接线 | src/platform/logcore.js | `this.reader = this.hub \|\| new EventReader(this.events)`（**永不为 null**） |
| API 单路径 | src/api/lifecycle.js | `/events`、`/logs/tail`、`/logs/events-tail`、`/logs/export`、`/metrics` 删除全部 `if(hub)…else…` 双分支 |
| 壳配置解析 | .shell-work env.rs | `config_json()` 统一入口 + serde_json；`apiPort`/`closeAction` 双处字符串扫描全部删除 |
| 测试 | test/session-lifecycle-test.js | P4-A…G（单读路径/适配器接口/同源语义/壳 JSON 解析）（已入链） |

### 验证结果

| 验证 | 结果 |
|---|---|
| `npm test`（32 文件） | **638 passed / 0 failed，EXIT=0** |
| UI typecheck / lint / test / build | 全通过 |
| 端到端（/tmp/e2e-phase4.sh） | A) /events 单读路径可用且过滤内部簿记；B) /metrics 派生投影可用；C) /logs/export 降级语义一致；D) 退出链路 + 端口释放 |
| 遗留债扫描 | 无自停/自重启；无壳 spawn；无字符串扫描；无事件双分支；无 RANGES |

### 阶段 4 清理的架构债

- **事件双读路径**（E1/E2 类）：降级路径曾忽略 source/type filter 且与 hub 语义漂移 → 空对象适配器统一为一条路径。
- **壳配置字符串扫描**：`apiPort` 与 `closeAction` 各有一份"极简 JSON 提取"（格式微调即失效）→ serde_json 统一解析。
- 保留正当降级（非守卫进程/初始化失败），但**语义与主路径严格一致**（不再牺牲正确性换兼容）。

## 全阶段收官

| 阶段 | 状态 | 核心 | 验收 |
|---|---|---|---|
| 0 契约 | ✅ | 所有权矩阵 / 会话状态机 / 时序 | 契约冻结 |
| 1 所有权归一 | ✅ | 取消自停/自重启、壳不再 spawn、退出握手 | 无 ETIMEDOUT；守卫不自退 |
| 2 意图单源 | ✅ | desired 唯一权威、恢复语义、状态投影 | 退出后可恢复 |
| 3 会话贯通 | ✅ | sessionState 全线 + INV-S1 全域 + 壳握手 | 两态关窗端到端 |
| 4 遗留债 | ✅ | 事件单读路径、壳 JSON 解析 | 债扫描清零 |

**三根因全部根治**：A 所有权不唯一 → 阶段 1；B 意图三载体 → 阶段 2；C 缺会话抽象 → 阶段 3；既有债 → 阶段 4。

**交付物**：ARCHITECTURE-CONTRACT-phase0.md（契约）、ARCHITECTURE-PLAN-session-lifecycle.md（计划+实施记录）、test/session-lifecycle-test.js（38 项不变量）。

**交接**：壳改动需在壳仓 `cargo build` 验证（本环境无 cargo，已做结构核验）；内核需重新构建/安装后本机生效。

