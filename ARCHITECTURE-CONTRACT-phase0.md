# 阶段 0 契约：会话生命周期 · 所有权矩阵 · 状态机 · 时序

> 本文是「会话生命周期与所有权重构」的**冻结契约**，先于任何代码改动。
> 全部事实来自对本仓 src/ 与壳仓 .shell-work/ 的实测取证。
> 后续阶段（1/2/3）不得偏离本文定义的所有权与状态语义。

---

## 1. 角色定义（术语表）

| 角色 | 实体 | 说明 |
|---|---|---|
| **桌面壳 Shell** | dsh-supervisor-gui | 容器/呈现层。托管面板、托盘、引导；**不做业务** |
| **守卫 Guard** | dsh-supervisor daemon | 业务本体。监管被管对象、提供 HTTP API |
| **主实例 main** | dsh web（spawn 子进程） | 被监管的原生 DSH |
| **沙箱实例** | dsh-web@inst-*（systemd-run transient） | 被监管的隔离实例 |
| **路由 daemon** | router-daemon（detached） | 智能路由独立进程 |
| **远程 daemon** | lan-daemon（detached） | 远程控制独立进程 |
| **反代实例** | commandcode-api-proxy（router spawn） | 供应商反代子进程 |
| **frpc** | frpc（LanManager/FrpManager spawn） | 公网隧道客户端 |

---

## 2. 生命周期所有权矩阵

### 2.1 目标（冻结）

**铁律**：每个进程有且只有一个「生命周期所有者」；所有者是唯一有权 start/stop/restart 它的一方；任何非所有者只能「请求所有者」。

| 角色 | 生命周期所有者 | 启动方式 | 停止方式 | 重启权威 | 持久化身份载体 |
|---|---|---|---|---|---|
| 桌面壳 | **桌面会话**（用户登录/autostart） | 用户/桌面 autostart | 用户关窗/托盘退出 | 用户 | 桌面 autostart desktop 项 |
| 守卫 Guard | **systemd 用户单元**（唯一） | systemctl --user start（壳发起） | systemctl --user stop（**壳发起**） | systemd（Restart=always） | systemd unit + guard.lock |
| 主实例 main | **守卫** | 守卫 spawn（detached，进程组） | 守卫 stopProcess | 守卫（desired+guardian） | managed-objects.json entry |
| 沙箱实例 | **守卫** | 守卫 systemd-run | 守卫 systemctl stop | 守卫 | managed-objects.json entry |
| 路由 daemon | **守卫** | 守卫 DaemonLifecycle spawn | 守卫 DaemonLifecycle.stop | 守卫监督 | identity.json + managed-objects |
| 远程 daemon | **守卫** | 守卫 DaemonLifecycle spawn | 守卫 DaemonLifecycle.stop | 守卫监督 | identity.json + managed-objects |
| 反代实例 | **路由 daemon**（守卫经 ctl 间接） | proxy spawn | proxy stopInstance | proxy | ports-router.json owner |
| frpc | **远程 daemon / 守卫** | FrpManager spawn | FrpManager.stop | FrpManager | frp.json |

### 2.2 当前实现 vs 目标（违规清单）

| # | 违规 | 现状 | 目标 |
|---|---|---|---|
| V1 | 守卫有**两个启动器** | systemd 单元（enabled+Restart=always）**且** 壳 ensure_guard 直接 spawn（main.rs:256） | 只有 systemd；壳只 start 不 spawn |
| V2 | 守卫**自己停自己** | shutdownAll 内 `systemctl --user stop dsh-supervisor`（supervisor.js:1700）→ 死锁 ETIMEDOUT | 守卫只停被管对象并回执；壳停守卫 |
| V3 | 守卫**自己重启自己** | guardSelfUpdateRestart `systemctl --user restart dsh-supervisor`（supervisor.js:1345） | 守卫置「待重启」并回执；壳/systemd 完成重启 |
| V4 | Windows **第三启动器** | watchdog.ps1 每 5min 探测 API 并拉起 daemon（autostart.js:59） | 平台各自的唯一所有者语义（见 §2.3） |
| V5 | 沙箱停止 glob 失效 | `systemctl stop dsh-web@*` 不经 shell 不展开（supervisor.js:1678） | 按实际单元名停 |

### 2.3 平台映射（唯一所有者如何落地）

| 平台 | 守卫所有者 | 壳启动守卫 | 壳停止守卫 |
|---|---|---|---|
| Linux | systemd --user 单元 | `systemctl --user start dsh-supervisor` | `systemctl --user stop dsh-supervisor` |
| macOS | LaunchAgent（RunAtLoad+KeepAlive） | `launchctl kickstart -k gui/<uid>/com.dsh.supervisor` | `launchctl bootout gui/<uid>/com.dsh.supervisor` |
| Windows | schtasks ONLOGON + 常驻 watchdog（**唯一**保活者） | 启动 daemon 进程即登记；watchdog 保活 | 停 daemon + 暂停 watchdog |

---

## 3. 会话状态机（sessionState）

### 3.1 状态定义

| 状态 | 含义 | 是否接受启停 | 自动拉起 |
|---|---|---|---|
| `starting` | 守卫已启动，正在首次收敛（拉 main 等） | 接受 | 允许 |
| `running` | 稳态运行，服务在跑 | 接受 | 允许（按 desired×guardian） |
| `stopping` | 正在按序停全部被管对象（退出流程） | **拒绝新启停** | **抑制** |
| `stopped` | 全部被管对象已停，守卫即将退出 | 拒绝 | 抑制 |
| `failed` | 收敛/退出异常，需人工介入 | 接受（恢复） | 按 desired |

### 3.2 状态迁移

    [进程启动] ──► starting ──(首拍收敛完成)──► running
                     │                            │
                     │                            ├──(/session/stop)──► stopping ──(停链完成)──► stopped
                     │                            │                          │
                     └──(/session/stop)───────────┘                          └──(收尾/回执)──► [进程退出]

      running ◄──(/session/start 或 desired=running 恢复)── stopped/failed
      failed  ◄──(收敛异常)── starting/running/stopping

### 3.3 状态不变量（可测试）

| 编号 | 不变量 |
|---|---|
| INV-S1 | `stopping`/`stopped` 期间，**任何**自动拉起（main/沙箱/daemon）被抑制 |
| INV-S2 | 进入 `stopping` 由**唯一入口** `/session/stop` 触发，不可由 desired 间接触发 |
| INV-S3 | `stopped` 是终态，只能经进程退出或显式 `/session/start` 离开 |
| INV-S4 | `/session/status` 是会话态的**唯一读取口**；壳与前端只读它，不自行推断 |

---

## 4. 退出时序（closeAction = exit）

### 4.1 目标时序（冻结）

    [用户关窗]
      │
      ▼
    Shell: 读取 closeAction（经 GET /settings/close-action，非字符串正则）
      │ exit
      ▼
    Shell: POST /session/stop  ─────────────►  Guard: sessionState = stopping
      │                                          │ 1) 停 main（stopProcess）
      │                                          │ 2) 停全部沙箱（按实际单元名）
      │                                          │ 3) 停 router-daemon / lan-daemon
      │                                          │ 4) sessionState = stopped
      │  ◄──────── { ok:true, sessionState:stopped } ──┘（守卫不碰 systemctl）
      ▼
    Shell: systemctl --user stop dsh-supervisor   （唯一有权的停止者）
      │
      ├─► Guard: 收到 SIGTERM → shutdown() → writeState → process.exit(0)
      │
      ▼
    Shell: app.exit(0)

**关键**：守卫从不停止自己；停止守卫的是壳（systemd 客户端）。死锁与竞态消失。

### 4.2 隐藏到托盘时序（closeAction = hide）

    [用户关窗]
      │
      ▼
    Shell: window.hide() + api.prevent_close()
      │
      ▼
    Guard: 无感知（sessionState 保持 running，服务链不动）

### 4.3 关键约束

| 编号 | 约束 |
|---|---|
| INV-X1 | 守卫进程内**禁止**出现 `systemctl ... stop|restart dsh-supervisor`（自身单元） |
| INV-X2 | 壳必须**等到** `/session/stop` 回执（或 sessionState=stopped）后才停守卫 |
| INV-X3 | 退出全链后**不得**残留 main/沙箱/反代/frpc/daemon 进程与监听端口 |
| INV-X4 | 退出后 systemd 单元为 inactive；`Restart=always` 不得把它拉起（stop 是主动停止） |

---

## 5. 启动时序

    [桌面登录 / 用户打开壳]
      │
      ▼
    Shell: 探测内核已安装（locate_core）
      │ 已安装
      ▼
    Shell: 探测守卫是否已活（systemd 状态 或 API /healthz）
      │ 未活
      ▼
    Shell: systemctl --user start dsh-supervisor   （不 spawn）
      │
      ▼
    Guard: 启动 → sessionState=starting
      │ 读 desired（唯一持久意图）
      ▼
    desired=running? ──是──► 拉起 main（无条件；guardian 只管崩溃重启）
      │否
      ▼
    保持 stopped（不拉起）
      │
      ▼
    Guard: sessionState=running；面板就绪

**恢复语义（根因 B 的修复）**：`desired` 是持久用户意图，守卫重启后**据此恢复**，不再依赖内存 IntentLedger 或 guardian。

---

## 6. 意图载体契约（三载体归一）

| 载体 | 持久化 | 语义（唯一） | 参与「是否运行」判定 | 参与「崩溃是否重启」判定 |
|---|---|---|---|---|
| `desired` | 持久（managed-objects.json） | 用户期望运行态 | ✅ 唯一权威 | ❌ |
| `guardian` | 持久（dsh-main.json / entry） | 崩溃自动拉起策略 | ❌ | ✅ 唯一权威 |
| `IntentLedger` | **不持久（瞬态）** | 同一次运行内的一次性动作加速 | ❌（重启后由 desired 兜底） | ❌ |
| `sessionState` | 持久（state.json/hub，仅观测） | 会话生命周期相位 | `stopping/stopped` 时抑制一切 | 同左 |

**判定规则（冻结）**：

    是否应运行 = (desired == running) && (sessionState ∈ {starting, running, failed})
    崩溃是否重启 = 是否应运行 && (guardian == true)

---

## 7. 契约 → 根因 → 阶段映射

| 契约定 | 解决根因 | 落地阶段 | 验收测试 |
|---|---|---|---|
| §2 所有权矩阵（V1-V5） | A：所有权不唯一 | 阶段 1 | 「每进程一所有者」对账测试；禁自停静态检查 |
| §3 会话状态机 | C：缺会话抽象 | 阶段 3 | sessionState 迁移测试 |
| §4 退出时序 | A+C：死锁与握手 | 阶段 1+3 | 端到端 exit 链路；无 ETIMEDOUT；无残留 |
| §5 启动时序 | B：意图不执行 | 阶段 2 | 「重启+desired=running+guardian=false → 必拉起」 |
| §6 意图载体 | B：三载体无优先级 | 阶段 2 | 三载体语义门 |

---

## 8. 阶段 1-3 的接口变更清单（实施预告，非本阶段交付）

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增 `POST /session/stop` | src/api/lifecycle.js | 进入 stopping → 停被管对象 → 回执；无 systemctl |
| 新增 `GET /session/status` | src/api/lifecycle.js | 会话态唯一读取口 |
| 删除 self systemctl stop | src/supervisor.js:1694-1704 | shutdownAll 改为纯停被管对象 |
| 删除 self systemctl restart | src/supervisor.js:1345 | 改为回执「待重启」，由壳执行 |
| 壳删除 spawn 守卫 | .shell-work main.rs:256-262 | 改 systemctl start + 探测 |
| 壳退出握手 | .shell-work main.rs:417/439 | POST /session/stop → 等回执 → systemctl stop |
| 收敛门改 desired | src/supervisor.js:2183 | `desired==running && sessionState 允许` 无条件拉起 |
| 沙箱停止按名 | src/supervisor.js:1678 | list-units 取实名后再 stop |

---

## 9. 冻结声明

- 本文定义的所有权矩阵、状态机、时序、意图载体语义为**后续实施的契约基线**。
- 任何新增状态必须归入 `sessionState` / `desired` / `guardian` 三者之一，且语义单一。
- 禁止以「新增标志位压住问题」的方式绕过本契约。
