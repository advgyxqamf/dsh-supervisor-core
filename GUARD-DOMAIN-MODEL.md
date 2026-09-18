# 守护域模型（GUARD-DOMAIN-MODEL）

> **本文件是「守护业务如何分域」的唯一事实源（SSOT）**，2026-09-16 立。
> 解决的问题：此前把**两类本质不同**的东西塞进同一个"用户意图"抽象，
> 导致模型错位、语义矛盾与一连串衍生缺陷（详见 §1）。

---

## §1 问题（为什么必须分域）

### 事实取证（均代码级验证）

| 维度 | DSH（原生 + 沙箱实例） | 智能路由 router | 远程控制 lan |
|---|---|---|---|
| `desired` 来源 | **用户开关**（dsh-main.json / instances.json 的 guardian） | `config.routerAutostart`（配置项）+ API 可改 | `config.lanDaemon`（**仅部署配置**） |
| 面板开关 | ✅ 有（启动区块 / 实例页） | ⚠️ 仅 API（无 UI 入口） | ❌ **无任何入口** |
| `entry.guardian` | 用户可 patch（`dsh_guardian_changed` 事件） | **硬编码 true** | **硬编码 true** |
| 崩溃语义 | 守护关 → **停就停**（`_crashHalted`） | 恒自愈 | 恒自愈 |
| 用户是否知情 | 显式呈现 | 部分 | **完全静默** |

### 错位造成的真实后果

1. **`lan` 守护计数恒为 0**（可观测性断裂）：
   为基础设施硬套"守护开关"语义 → 代码出现 `entry.guardian !== true` 判断（对恒 true 者无意义）
   → 引入 A/B 平面 id 混乱（`lan` vs `lan-daemon`）→ 计数写入 `get('lan-daemon')`（恒 null）
   而读取用 `get('lan')` → **`guardian_action` 里 lan 的 restartCount 恒 0**。
2. **语义自相矛盾**：`routerAutostart` 名为"启动开关"（用户意图），却配 `guardian: true` 硬编码（剥夺停的能力）。
3. **`lan` 无用户意图却配全套意图机制**（`desired`/`guardian`/`restartCount`/`skip-guardian-off`）。

**根因**：用"用户意图模型"描述"基础设施自愈"——**模型与业务不匹配**。

---

## §2 两个域（正确模型）

### 域 A：**被管对象**（用户意图域）

| 项 | 规定 |
|---|---|
| 成员 | `main`（原生 DSH）、沙箱实例 `<id>` |
| 本质 | **用户意图的投射** —— "我要它运行 / 停止" |
| 模型 | `desired`（持久意图）× `guardian`（崩溃是否自愈）**两个正交轴** |
| 开关 | **必须有用户可见入口**（面板） |
| 崩溃 | `guardian=false` → 停就停（`crashHalted`，等显式启动） |
| 计数 | **有意义**（回答"用户开的守护触发了几次"），但**不经** `guardian_action`——该事件已删除（见下）。真实实现各走独立链路：**dsh** → `src/app/main/process.js` 崩塌收敛发 `restart_triggered` 事件 + `_mSetRestartCount` 写 `restartCount`（`_beginRestart` 内，仅 `countCrash:true` 计数）；**沙箱实例** → `domains/instance/index.js` 自身 `state.restartCount`（`_restartInstance` 递增 + 稳定窗归零）。 |
| 停止条件 | 用户关开关 / 退出管家 |

### 域 B：**基础设施**（能力自愈域）

| 项 | 规定 |
|---|---|
| 成员 | **`router-daemon`**、**`lan-daemon`**（及未来同类基础服务）|
| 本质 | **维持业务底线** —— "只要业务需要，它就必须活着" |
| 模型 | **保活**（keepAlive），**不存在** `desired`/`guardian` 用户意图轴 |
| 开关 | **不对用户暴露**（用户无需知情，也无需干预） |
| "是否需要它" | 由**业务条件**判定（如 router 有启用意图 / lan 有远程实例），**不是**用户开关 |
| 崩溃 | **无条件拉起**（这是它的职责，不是"守护功能"） |
| 计数 | **不适用**（"用户意图被触发"的语义）；且 `guardian_action` 事件已随死代码删除，全域不再有任何生产者 |
| 停止条件 | 业务不再需要它 / 退出管家 |

---

## §3 铁律

| # | 铁律 |
|---|---|
| **G-1** | 基础设施**不得**有 `desired`/`guardian` 用户意图字段；只有"当前是否应运行"的**业务条件**。 |
| **G-2** | 基础设施的保活**不得**写 `guardian_action`（该事件专表"用户意图被触发"）。**2026-09-16 收口**：该事件唯一生产者 `_guardianEvent()` 已删除（域 B 两分支删除调用后成为死代码，从未服务域 A），登记（`platform/service/log/hub.js` 内部簿记名单）与 UI 标签（`ui/.../nav.ts` EVENT_LABELS）同步移除。 |
| **G-3** | 域 A 对象**必须**有用户可见开关；无 UI 入口的"用户意图"是伪意图。 |
| **G-4** | 两域**共用**心跳驱动（这是对的：都是周期收敛），但**不得共用**同一个状态模型。 |
| **G-5** | 同一对象在两个域中**不得有两个 id**（A/B 平面命名必须一致或显式映射）。 |
| **G-6** | 删除"为兼容错位模型而存在"的补丁性代码（如对恒 true 值的 `!== true` 判断）。 |

---

## §4 目标形态

```
ManagedRegistry（心跳驱动 —— 共用）
   │
   ├─ 域 A 受管对象（desired × guardian）
   │    main / sandbox-instance
   │    · 守护计数（restart_triggered/restartCount）、用户开关、crashHalted 语义
   │
   └─ 域 B 基础设施（keepAlive + 业务条件）
        router-daemon / lan-daemon
        · 保活（失联即拉起），无守护计数、无 guardian_action（事件已删），无用户意图字段
        · 应由 needsRouter() / needsLan() 业务条件决定"是否该活着"
```

**注意**：两域仍共用 `ManagedRegistry.heartbeat` 与 adapter 机制 —— 这是**正确的复用**
（周期收敛是同一件事）；分域针对的是**状态模型与语义**，不是驱动机制。

---

## §5 门禁

| 门禁 | 断言 |
|---|---|
| GD-1 | 基础设施 kind（router-daemon/lan-daemon）的 entry **不含** `guardian` 字段 |
| GD-2 | 基础设施保活路径**不调用** `_guardianEvent`；且该函数已从 `src/app/daemons/runtime.js` **删除**（GD-2b：代码全域无定义/调用，注释不计），`guardian_action` 全域无生产者（GD-2c） |
| GD-3 | 两平面 id **显式映射**，保活路径不跨平面混用 id（G-5）；域 A 计数不经 `guardian_action` |
| GD-4 | 反向：判据能识别"基础设施带 guardian 字段"的旧形态（门禁非空转） |
| GD-5 | 不再存在对恒 true 值的 `guardian !== true` 补丁判断（基础设施无此概念）|
