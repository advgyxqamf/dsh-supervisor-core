# 内核跨平台能力矩阵（可执行审计）

> 生成日期：2026-09-11　范围：内核仓 `src/platform/os/`（跨平台能力面）
> 配套测试：**`test/platform-capability-audit-test.js`**（42 项断言，三平台 CI 均运行）

---

## 一、为什么需要这份文档

本项目曾发生一次**跨平台能力的系统性误判**，值得作为反面教材：

macOS 的**壳自启 / 壳自愈从项目奠基提交（`8867942`, 2026-09-01）起就不存在**，
但整整四层都「确认」它存在：

```
① 注释        「macOS：LaunchAgent plist + 登录面板（同 plist 附带）」   ← 声称已实现
      ↓ 被当作规范读
② 实现        setGuiAutostart: if (!isLinux) return { ok: true }        ← 静默成功
      ↓ 被当作证据
③ 状态        status() → { gui: on }（把守卫自启当成壳自启）             ← 硬编码谎报
      ↓ 被当作事实
④ 审计文档    AUDIT-CROSS-PLATFORM.md：「三端齐全」                      ← 按平台名数，未验证行为
      ↓
⑤ 测试        只断言「函数返回绝对路径」—— 从未断言「能力存在」
```

**四层互相背书，没有一层验证行为。** 而 `macPlist` 从奠基提交至今**逐字节未变**（16 行，只含守卫）——
只要有任何一处做了行为验证，第一天就会暴露。

### 本文件与配套测试确立的不变量

1. **声明必须有断言支撑** —— 文字（注释 / 审计报告 / 文档）**不构成证据**；
2. **「不支持」是可接受的回答，「假装支持」不是** —— 未实现的能力必须**显式报告**，
   绝不静默返回成功（与 `service.js` 的 `CapabilityError` 同规）；
3. **能力必须区分「守卫」与「壳」** —— 原矩阵把守卫能力写在「整链」行里，
   这正是掩盖 macOS 缺口的原因（见 §三）；
4. **测试不得依赖外部状态** —— 断言「无 systemd 单元」就必须隔离 `$HOME`，
   否则跑过一次真实壳之后该断言必然失败（同一失效模式：断言与行为脱钩）。

---

## 二、能力矩阵（每格由测试强制绑定）

图例：**✅ 已实现**　**❌ 未实现（显式报告）**

| # | 能力 | Linux | macOS | Windows | 实现位置 | 验证 |
|---|---|---|---|---|---|---|
| C1 | 产品数据目录 | ✅ | ✅ | ✅ | `platform/os/index.js` | A1 |
| C2 | 可执行解析（PATH/标准目录/扩展名）| ✅ | ✅ | ✅ | `platform/os/exec-path.js` | A2 · cross-platform P0 |
| C3 | 敏感文件保护 | ✅ `chmod` | ✅ `chmod` | ✅ `icacls` | `platform/os/file-protect.js` | A2 · cross-platform P1 |
| C4 | 进程信号 / 进程树终止 | ✅ 进程组 `kill(-pid)` | ✅ 进程组 | ✅ `taskkill /T` | `platform/os/process.js` | A2 |
| C5 | 端口 → PID 反查 | ✅ `/proc` + `ss` 兜底 | ✅ `lsof` | ✅ `netstat -ano` | `platform/os/pidlookup.js` | A2 |
| C6 | 进程列表 / 命令行读取 | ✅ `pgrep -af` | ✅ `pgrep` + `ps` | ✅ CIM | `platform/os/pidlookup.js` | A2 |
| C7 | 桌面通知 | ✅ `notify-send` | ✅ `osascript` | ✅ PowerShell 气泡 | `platform/os/notify.js` | A2 |
| C8 | 打开浏览器（含隔离 profile） | ✅ `xdg-open` | ✅ `open -na` | ✅ `cmd start` | `platform/os/browser.js` | A2 |
| C9 | 服务单元管理 | ✅ systemd | ❌ **显式** | ❌ **显式** | `platform/os/service.js` | A3 |
| C10 | 沙箱多实例（transient） | ✅ `systemd-run` | ❌ **显式** | ❌ **显式** | `platform/os/service.js` | A3 |
| C11 | **守卫**开机自启 | ✅ systemd + linger | ✅ LaunchAgent | ✅ schtasks | `platform/os/autostart.js` | A2 |
| C12 | **守卫**崩溃自愈 | ✅ `Restart=always` | ✅ `KeepAlive` | ✅ Watchdog 每 5 min | `platform/os/autostart.js` | A5 |
| C13 | **壳**开机自启 | ✅ XDG `.desktop` | ❌ **未实现** | ✅ schtasks `DSH-Supervisor-GUI` | `platform/os/autostart.js` | A4 |
| C14 | **壳**崩溃自愈 | ❌ **未实现** | ❌ **未实现** | ✅ Watchdog（检查已独立于守卫块）| `platform/os/autostart.js` | A5 |

**运行时声明**：`capabilityProfile()` 输出 `guardAutostart` / `guardSelfHeal` / `shellAutostart` / `shellSelfHeal`
四个字段（2026-09-11 新增），经 `/env/status` 暴露给壳与面板 —— 消费者据此做能力感知与降级提示，
**不再依赖注释或文档描述**。

---

## 三、原矩阵的错误与更正

原 `AUDIT-CROSS-PLATFORM.md` §五 的矩阵把**守卫能力**写在了**整链能力**的行里：

```diff
- | 开机自启 | systemd --user + linger | LaunchAgent + KeepAlive | schtasks ×2 |
- | 崩溃自愈 | systemd Restart=always   | KeepAlive                | Watchdog     |
```

于是 macOS 那格看起来「齐全」，而**壳完全没有自启/自愈**这一事实被掩盖。
现拆分为「守卫」与「壳」两行（C11–C14），缺口变得可见。

同时更正：`os/autostart.js` 评级由 **C+「三端齐全」下调为 D** ——
不是实现质量差，而是**声明与实现不一致**（`setGuiAutostart` 静默成功 + `status()` 谎报）。

---

## 四、本次修复清单（2026-09-11）

| # | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| F1 | `setGuiAutostart` 对非 Linux **静默 `ok:true`** | 未实现平台显式返回 `{ok:false, unsupported:true}` | A4 |
| F2 | macOS `status()` **谎报 `gui: on`** | 如实返回 `gui:false, guiSupported:false` | A6 |
| F3 | Windows watchdog 的**壳检查嵌套在 `if (-not $up)` 内** | 移出守卫块 —— 使「壳崩、守卫活」时可自愈 | A5 |
| F4 | Linux `.desktop` 的 `Exec` **硬编码 `~/.local/bin`** | 按实际安装解析（deb/rpm 实为 `/usr/bin`）| A6 |
| F5 | 能力字段**缺失**（无 `shellAutostart`/`shellSelfHeal`）| `capabilityProfile()` 补 4 个字段 | A1 |
| F6 | 假声明注释 / 悬空路径（`src/infra/platform/…`）| 更正注释，标注真实能力来源 | A6 |
| F7 | `guard-update-test.js` S8 **依赖开发者 `$HOME`** | 隔离 HOME（跑过真实壳后不再误报）| 该套测试 |

### F3 详解（用户直接指出的缺陷）

```powershell
# 修复前 —— 壳检查被嵌在守卫块内
if (-not $up) {                       # 仅当「守卫也不可达」时才进入
  ... 拉起 darwin/windows 守卫 ...
  $g = @(Get-Process -Name dsh-supervisor-gui ...)
  if (-not $g) { Start-Process $gui }  # ← 壳自愈在这里
}
```

**「壳崩、守卫活」→ `$up` 为真 → 整块跳过 → 壳永远不会被拉起。**
而那恰是壳自愈唯一需要生效的场景（守卫由服务管理器保活，壳无人管）。
修复后壳检查独立于守卫状态（C14 Windows 列由此变为 ✅）。

---

## 五、尚未实现的能力（需产品决策）

以下缺口已**如实声明**（不再静默），但**尚未实现**：

| 能力 | Linux | macOS | Windows | 影响 |
|---|---|---|---|---|
| **壳崩溃自愈** | ❌ | ❌ | ✅ | **壳崩后永久失去 UI，直到用户手动打开** —— 违背产品意图「壳关不掉」 |
| **壳开机自启** | ✅ | ❌ | ✅ | macOS 用户重启后需手动打开壳 |

### 建议方向（待确认，尚未实施）

守卫心跳监督壳（三平台通用，无需新增服务定义）：

```
守卫每 N 秒：读 ~/.dsh/shell/identity.json（含 pid / lastSeenAt / phase）
  ├─ 壳 pid 存活且心跳新鲜        → 正常
  ├─ 壳 pid 已死 / 心跳过期        → restartShell()（该函数已存在于 domains/shell/）
  └─ 无图形会话（Linux 注销 / 无 DISPLAY）→ 不尝试拉起，记待办，会话恢复后再拉起
```

理由：壳**无法监督自己**（监督者会随它一起死）；守卫是抗重启的那个
（`Restart=always` / `KeepAlive`），且**已在读取** `identity.json`、**已实现** `restartShell()`。

---

## 六、如何运行审计

```bash
node test/platform-capability-audit-test.js    # 42 项断言，任意平台可跑
node test/capability-profile-test.js           # 能力档位纯函数（8 项）
node test/cross-platform-test.js               # 可执行解析/文件保护/分层不变量（39 项）
```

审计测试的六组不变量：

| 组 | 含义 |
|---|---|
| **A1 完整性** | 每个能力字段对三平台 + 未知平台都有明确布尔值（无 `undefined`）|
| **A2 声明=true** | 该能力必须有**实现产物**（源码/机制证据）|
| **A3 声明=false** | 该能力必须**显式报告不支持**（绝不静默成功）|
| **A4 行为一致** | 模块的跨平台行为与 `capabilityProfile()` 声明一致（真实调用，非文本扫描）|
| **A5 自愈真伪** | 自愈类能力的声明匹配实际机制（不得声称存在而实现被条件屏蔽）|
| **A6 无回归** | 历史错误声明不得重现（剥离注释后检查代码）|
