# 内核仓跨平台规范审计报告

> 范围：内核仓 `dsh-supervisor`（src/ 18,090 行 / 63 个 JS 模块 + bin/ + release/ + .github/）。
> 维度：**目录分层与架构规范**、**平台抽象层质量**、**跨平台能力矩阵**、**业务逻辑跨平台正确性**、**CI/测试**。
> 结论先行：**分层骨架存在且方向正确（platform/os 门面），但「声明的规范」与「实际实现」存在系统性偏差——域层仍在直呼平台命令，且多平台能力有真实缺口。**
>
> ⚠️ **2026-09-11 复核更正**：本报告 §三 给 `os/autostart.js` 的评级（C+「三端齐全」）**是错的**，
> 已下调为 **D**。错误原因与完整证据见 **§五.a**：本报告按**平台名**数能力，未验证**行为**，
> 因而漏掉了「macOS 壳自启/自愈从奠基提交起就不存在」这一事实。
> 本次更正同时确立了不变量：**跨平台能力的声明必须由可执行断言支撑，文字不构成证据。**
>
> ## ⚠ 本文件是**历史审计快照**，不是现状描述
>
> 其中的 文件:行号 与「域层直呼平台命令」等结论描述的是**审计当时的状态**；
> 此后已有一批修复（部分由本仓、部分由壳仓完成）。**要看现状请读代码**：
>   · 平台能力矩阵现由 test/platform-capability-audit-test.js 强制绑定实现；
>   · 自启 / 壳自愈的所有权见 PLATFORM-CAPABILITY-MATRIX.md 的「自启所有权矩阵」。

---

## 一、结论摘要

| 维度 | 评级 | 一句话 |
|---|---|---|
| 目录分层 | **B** | `api / domains / guard / platform` 四层清晰，platform/os 是明确门面；但域层有泄漏 |
| 平台抽象层 | **B-** | 三端能力矩阵、能力探测、纯函数可测做得好；但**无 Provider 模式**，纯 if/else |
| 分层纪律 | **C** | 平台命令在域层直接调用：**systemctl ×8、xdg-open ×3、powershell ×1、wmic ×1** |
| 能力矩阵 | **C+** | 沙箱（多实例）**仅 Linux**；mac/win 为明确禁用（非等价降级） |
| 跨平台正确性 | **C+** | Windows 自启路径缺 `.exe`（真实缺陷）；`0600` 权限在 Windows 空转；symlink 无回退 |
| CI/测试 | **B** | 3 平台矩阵**确实跑 npm test**（好）；但缺平台集成测试 |

**总评：架构「看起来」是跨平台的（有 platform/os 门面与能力矩阵），但纪律执行不彻底、Windows 侧存在真实功能缺陷。属于「骨架规范、肌肉不到位」。**

---

## 二、目录分层与架构规范

### 2.1 分层现状（结构本身是规范的）

    src/
      api/        接入层（11 域模块，按域拆 HTTP 路由）
      domains/    业务域（dist/instance/plugin/relay/router）
      guard/      监管核心（lifecycle/registry/native/proc/monitor）
      platform/   平台与基建（os/ 平台抽象门面 + config/log/events/token/tasks/exec/fs-utils）
      supervisor.js  编排（3387 行）

**优点**：职责边界在目录名上自解释；`platform/os/` 集中平台差异（13 个文件）；纯函数（`capabilityProfile`）可测。

**问题 1：`supervisor.js` 3387 行单体**，承担编排 + 收敛状态机 + 端口 + daemon 监督 + 自更新 + 通知 + 迁移。编排应薄。

**问题 2：声明与实现不符（文档债务）**：
`src/platform/os/index.js:6` 宣称「**每一平台均有 Provider 实现**」，但实际是：

    if (pl === 'linux') { ... } else if (pl === 'darwin') { ... } else if (pl === 'win32') { ... }

**全仓无 Provider 注册表/工厂**（grep `Provider` 仅命中该注释与 TODO）。注释描述了一个不存在的架构——这会误导后续维护者以为「加平台只需加 Provider」。

### 2.2 分层纪律违规（核心发现）

`src/platform/os/index.js:3-5` 立下铁律：

> 「平台无关域（supervisor/domain/system-services）**不得直接触碰平台 API**（systemctl/notify-send/xdg-open//proc/netstat/lsof...），一律经本门面。」

**实际违规统计**（平台专属命令在 `platform/os/` 之外的调用）：

| 命令 | 总出现 | 平台层 | **域层泄漏** | 位置 |
|---|---|---|---|---|
| `systemctl` | 12 | 4 | **8** | supervisor.js:1713；instance/index.js:140,339,697,698,709,796；dist/index.js:370 |
| `xdg-open` | 4 | 1 | **3** | router-ops.js:149,153 |
| `powershell` | 5 | 4 | **1** | frpmgr.js:221 |
| `wmic` | 2 | 1 | **1** | frpmgr.js:210 |
| launchctl / schtasks / osascript / notify-send / taskkill / netstat / lsof | 各 1-8 | 全部 | 0 | ✅ 已收敛 |

**即：除 Linux systemd 与浏览器打开外，其余平台差异基本已进平台层。泄漏集中在「沙箱/systemd 单元」这条线上。**

**评估**：这些泄漏**当前不会导致功能错误**（沙箱本身仅 Linux 支持，systemctl 分支只在 Linux 触达），但它们**腐蚀分层契约**——一旦要支持 mac/win 沙箱，这些散落的 systemctl 就是 8 个必须逐个改的点，而非「换一个 Provider」。

---

## 三、平台抽象层逐模块评价

| 模块 | 行数 | 评价 | 备注 |
|---|---|---|---|
| `os/index.js` | 126 | **B** | 能力矩阵 + 工具探测双层设计好；但 if/else 无 Provider 模式；头注释与实现不符 |
| `os/pidlookup.js` | 222 | **A-** | 三端显式实现 + Linux ss 兜底 + 文档化踩坑（mac pgrep -a 陷阱、win wmic→CIM 回退）。**全仓质量最高的跨平台模块** |
| `os/process.js` | 44 | **B+** | POSIX 进程组 vs Windows taskkill /T 语义桥接清晰 |
| `os/notify.js` | 49 | **B+** | 三端实现；Windows 走 PowerShell 气泡 |
| `os/browser.js` | 21 | **B** | 三端分支；但直接 `process.platform` 判断（未用统一 isX 常量） |
| `os/autostart.js` | 190 | **D** | ⚠️ **2026-09-11 复核下调（原评 C+「三端齐全」是错的）**：`setGuiAutostart` 对非 Linux **静默返回 `ok:true`**，`status()` 对 macOS **硬编码 `gui:on`**，而 macOS 壳自启/自愈**从奠基提交起就不存在**。详见 §五.a |
| `platform/deploy.js` | 74 | **A** | 形态判定用 ELF/PE/Mach-O magic，跨平台严谨 |

---

## 四、跨平台正确性缺陷（按严重度）

### 🔴 P0-1：Windows 自启的守护进程路径缺 `.exe`

```js
// src/platform/os/autostart.js:132-134
function daemonCommand() {
  return process.env.DSH_SUPERVISOR_DAEMON
    || path.join(os.homedir(), '.local', 'bin', 'dsh-supervisor');  // ← Windows 无 .exe
}
```

用于 Windows watchdog.ps1：
```powershell
$daemon = "C:\Users\X\.local\bin\dsh-supervisor"   # 无扩展名
Start-Process -FilePath $daemon -ArgumentList 'daemon' -WindowStyle Hidden
```
Windows 可执行文件必须有扩展名（`.exe`/`.cmd`），且 `.local/bin` 是 **Unix 约定**（Windows 标准为 `%APPDATA%\npm`）。→ **Windows 崩溃自拉的 watchdog 实际会失败**（`$ErrorActionPreference=SilentlyContinue` 使其静默）。

同一函数还用于 macOS plist（`autostart.js:95`）——mac 上若用户只做 `npm i -g` 而未跑内核 `install`，该路径**不存在**（npm 全局 bin 在 `$(npm prefix -g)/bin`）。

### 🟠 P1-1：`0600` 文件权限在 Windows 空转（25 处）

`fs.writeFileSync(..., { mode: 0o600 })` 在 Windows 上**被忽略**（NTFS ACL 与 POSIX mode 不同）。涉及 **敏感文件**：`config.json`（含 lanToken）、`dsh-main-token.log`（DSH 访问令牌）、`registry.json`、`state.json`。→ **Windows 上这些文件对所有本机用户可读**，是安全降级。

### 🟠 P1-2：`bin install` 用 `symlinkSync` 无 Windows 回退

```js
// bin/dsh-supervisor:315
fs.symlinkSync(path.join(__dirname, 'dsh-supervisor'), BIN_PATH);
```
Windows 创建符号链接需**管理员权限或开发者模式**，否则 `EPERM`。且 `BIN_PATH` 无 `.exe`。无 `try/catch` + `.cmd` 垫片回退。

### 🟡 P2-1：`PATH` 拼接硬编码 `':'`

```js
// src/domains/instance/index.js:733
const paths = [nodeBinDir, path.join(installDir, 'bin'), process.env.PATH || ''].join(':');
```
应使用 `path.delimiter`（Windows 为 `;`）。当前上下文是 systemd-run `--setenv`（Linux-only），**暂无实害**，但是复制即错的模板。对比 `plugins.js:52` 正确使用了 `path.delimiter`。

### 🟡 P2-2：沙箱（多实例）仅 Linux

`capabilityProfile`：`multiInstance` 在 Linux=true、mac/win=**false**。`instance/index.js:37` 据此设 `sandboxSupported`，非 Linux 直接拒绝启停。
→ **这不是「能力等价降级」，而是功能缺失**。注释承认是 TODO（「Phase 3 迁移 launchd 后置 true」），但 **mac/win 用户完全无法使用沙箱**。

### 🟡 P2-3：Windows 信号语义

daemon 用 `process.on('SIGTERM')`（router/daemon.js:142、relay/daemon.js:157、bin:211）。Windows 上 Node 对 SIGTERM 的支持有限（`process.kill(pid,'SIGTERM')` 实为强制终止）。→ 优雅停机在 Windows 不完全可靠，依赖端口/pid 探测自愈兜底。

### 🟢 P3-1：`supervisor.js` 3387 行单体

编排 + 收敛 + 端口 + 监督 + 自更新 + 通知混居，跨平台改动需在 3387 行里定位，维护成本高。

---

## 五、跨平台能力矩阵（实测）

| 能力 | Linux | macOS | Windows | 等价性 |
|---|---|---|---|---|
| 守卫开机自启 | systemd --user + linger | LaunchAgent + KeepAlive | schtasks ×2（ONLOGON + Watchdog） | ⚠️ 语义不同（watchdog 是轮询模拟） |
| 守卫崩溃自愈 | systemd Restart=always | KeepAlive | Watchdog 每 5 分钟轮询 | ⚠️ Windows 最弱 |
| **壳开机自启** | XDG autostart .desktop | **❌ 未实现** | schtasks `DSH-Supervisor-GUI` | ❌ **macOS 缺失** |
| **壳崩溃自愈** | **❌ 未实现** | **❌ 未实现** | Watchdog（壳检查已独立于守卫块） | ❌ **仅 Windows** |
| 进程树终止 | 进程组 kill(-pid) | 进程组 kill(-pid) | taskkill /T | ✅ |
| 端口反查 pid | /proc + ss 兜底 | lsof | netstat -ano | ✅ |
| 命令行读取 | /proc/<pid>/cmdline | ps -o command= | wmic → PowerShell CIM | ✅ |
| 桌面通知 | notify-send | osascript | PowerShell 气泡 | ✅ |
| 浏览器打开 | xdg-open | open | cmd /c start | ✅ |
| 进程匹配 | pgrep -af | pgrep -f + ps | CIM Win32_Process | ✅ |
| **沙箱多实例** | **systemd-run** | **❌ 不支持** | **❌ 不支持** | ❌ **功能缺失** |
| 文件权限保护 | 0600 | 0600 | **❌ 空转** | ❌ **安全降级** |

### 五.a、2026-09-11 复核更正：原矩阵把「守卫能力」当成了「整链能力」

**原表的错误**：`开机自启` / `崩溃自愈` 两行只描述了**守卫**，却写在「整链」的行里 ——
于是 macOS 那格看起来「有 LaunchAgent + KeepAlive」，掩盖了**壳完全没有自启/自愈**这一事实。

**真相（git 考古 + 代码实测）**：

| 事实 | 证据 |
|---|---|
| macOS 壳自启**从未实现** | `autostart.js` 的 `setGuiAutostart` 从**奠基提交 8867942（2026-09-01）**起即 `if (!isLinux) return { ok: true }` —— 静默成功 |
| macOS 壳自愈**从未实现** | `macPlist` 从奠基提交至今**逐字节未变**，`ProgramArguments` 只含守卫 |
| 注释是**假的** | 原文「macOS：LaunchAgent plist + 登录面板（**同 plist 附带**）」—— plist 里没有壳 |
| 状态是**假的** | `status()` 返回 `{ gui: on }`（把守卫自启当作壳自启） |
| 审计是**假的** | 本文件原评「三端齐全」（按平台名数，未验证行为） |

**四层互相背书，没有一层验证行为** —— 这是本项目最值得警惕的失效模式：

```
注释（声称已实现）
   ↓ 被当作规范读
实现（静默 ok:true）
   ↓ 被当作证据
status（硬编码 gui:on）
   ↓ 被当作事实
审计文档（按平台名数 → 「三端齐全」）
   ↓
测试：只断言「函数返回绝对路径」—— 从未断言「能力存在」
```

**已修正**（2026-09-11）：
- `capabilityProfile()` 新增 `guardAutostart` / `guardSelfHeal` / `shellAutostart` / `shellSelfHeal` 四个能力字段；
- `setGuiAutostart(on, platform)` 对未实现平台**显式报告**（`ok:false, unsupported:true`），不再静默成功；
- macOS `status()` 如实返回 `gui: false, guiSupported: false`；
- Windows watchdog 的**壳检查移出 `if (-not $up)`** —— 旧实现只在「守卫也挂了」时才检查壳，
  而「壳崩、守卫活」正是唯一需要它的场景（现已修正，`shellSelfHeal: true`）；
- Linux `.desktop` 的 `Exec` 改为**按实际安装解析**（deb/rpm 装到 `/usr/bin`，模板原硬编码 `~/.local/bin`）；
- 新增 **`test/platform-capability-audit-test.js`**（42 项断言）把「声明」与「实现」强制绑定：
  A1 完整性 / A2 声明=true→有产物 / A3 声明=false→显式不支持 / A4 行为一致 / A5 自愈机制真实 / A6 历史假声明不得重现。

> **不变量（本次确立）**：跨平台能力的**声明**必须由**可执行断言**支撑；
> 文字（注释/审计/文档）不构成证据 —— 「不支持」是可接受的回答，「假装支持」不是。

---

## 六、CI / 测试评价

**优点**：
- `.github/workflows/build.yml` 矩阵含 **ubuntu / windows / macos(arm64) / macos-14**，且每平台都执行 `release/scripts/ci-core.sh`，其内含 `npm test`（`ci-core.sh:25`）。→ **三平台确实跑测试**，这是规范做法。
- `capability-profile-test.js` 以纯函数覆盖三平台 + 未知平台档位。

**不足**：
- **无平台集成测试**：能力矩阵只测「静态档位声明」，不测「实际命令可用性」（如 Windows 上 taskkill/netstat 真能跑通）。
- 平台相关测试仅 2 个（`frp-platform-test.js`、`native-test.js`）。
- `release/*.sh` 全 bash，Windows 依赖 git-bash——可接受但未文档化。

---

## 七、修复建议（架构级，非补丁）

### 7.1 平台 Provider 化（消除 if/else + 域层泄漏）
将 `platform/os/` 从「函数内 if/else」升级为**Provider 注册表**：

    platform/os/providers/{linux,darwin,win32}.js
    每个 Provider 实现同一接口：serviceManager / processControl / pidLookup /
                              notify / browser / autostart / fileProtect
    platform/os/index.js 按 process.platform 选择 Provider，未实现的能力显式报 CapabilityError

然后把 8 处 systemctl 泄漏收敛为 `platform.service.stopUnit(name)` / `daemonReload()`。→ 加平台=加 Provider，而非改 8 个调用点。

### 7.2 修复 Windows 自启路径（P0）
`daemonCommand()` 改为**经 PATH 解析 + Windows 加 `.exe`/`.cmd`**：

    platform.resolveExecutable('dsh-supervisor')  // Windows: .exe/.cmd；PATH 优先；.local/bin 仅 Unix

### 7.3 跨平台文件保护抽象（P1）
`0600` 不够：新增 `platform.fileProtect(path)` —— Unix 走 `chmod 0600`；Windows 走 `icacls`（移除继承、仅当前用户）或至少落盘到用户私有目录。敏感文件（token/lanToken）必须覆盖。

### 7.4 统一路径分隔符与可执行解析
`PATH` 拼接改 `path.delimiter`；所有「可能带扩展名的可执行」经 `platform.resolveExecutable`。

### 7.5 能力缺失显式化
`capabilityProfile` 的 false 项应在 API/UI 上**显式标注「平台不支持」**而非静默失败（沙箱已在做，需推广到全部能力）。

### 7.6 拆分 `supervisor.js`
把收敛状态机、端口编排、daemon 监督、自更新分别下沉到 `guard/`，supervisor 保留编排与门面。

### 7.7 测试补强
矩阵 job 增加**平台冒烟**：三平台各跑一次 `pidlookup/pgrepList/process.killTree/notify/autostart status` 的真实调用断言（非纯函数）。

---

## 八、优先级

| 优先级 | 项 | 影响 |
|---|---|---|
| **P0** | 7.2 Windows daemon 路径 | Windows 崩溃自愈失效（静默） |
| **P1** | 7.3 文件保护 | Windows 敏感文件（令牌）无保护 |
| **P1** | 7.1 Provider 化 + systemctl 收敛 | 架构纪律；决定 mac/win 沙箱可行性 |
| **P2** | 7.4 分隔符/可执行解析；7.5 能力显式化 | 规范整洁 |
| **P2** | 7.6 拆分 supervisor.js | 可维护性 |
| **P3** | 7.7 平台冒烟测试 | 回归防线 |

---

## 附：证据索引（可复核）

- 分层铁律：`src/platform/os/index.js:3-5`
- 声明与实现不符：`src/platform/os/index.js:6`（Provider）vs 55-97（if/else）
- systemctl 泄漏：`supervisor.js:1713`、`instance/index.js:140,339,697,698,709,796`、`dist/index.js:370`
- Windows 路径缺陷：`autostart.js:132-134`（daemonCommand）、`autostart.js:67,80`（.local\bin）、`autostart.js:75`（Start-Process）
- 权限空转：`grep -rn "mode: 0o600" src/` → 25 处
- symlink 无回退：`bin/dsh-supervisor:315`
- 分隔符：`instance/index.js:733`（`join(':')`）vs `plugins.js:52`（`path.delimiter`）
- 沙箱能力门：`instance/index.js:33-37`
- CI 矩阵：`.github/workflows/build.yml:15-37`；测试入口 `release/scripts/ci-core.sh:25`

---

## 九、实施记录（2026-09-10 落地）

### 已修复

| 编号 | 项 | 位置 | 内容 |
|---|---|---|---|
| **P0** | 跨平台可执行解析 | src/platform/os/exec-path.js（**新增**） | resolveExecutable：PATH（Windows 含 PATHEXT）→ %APPDATA%\npm → ~/.local/bin → ~/.npm-global/bin；Windows 候选含 .exe/.cmd/.bat |
| **P0** | daemonCommand / GUI 路径 | src/platform/os/autostart.js | 经 resolveExecutable 解析（不再硬拼无扩展名的 ~/.local/bin/dsh-supervisor）；新增 guiCommand()；watchdog/schtasks 改用解析结果 |
| **P1** | 跨平台文件保护 | src/platform/os/file-protect.js（**新增**） | Unix chmod / Windows icacls（移除继承 + 仅当前用户）；ensurePrivateDir / protectFile / writePrivate |
| **P1** | 数据目录保护 | src/supervisor.js 构造 | 启动即对 swDir 与 supervisorDir 施加保护（**目录级一次**，NTFS 继承覆盖后续新建文件——不对热写文件逐个 icacls，避免写放大）；statusSummary 暴露 dataDirProtected |
| **P1** | bin 安装跨平台 | bin/dsh-supervisor | Windows 用 .cmd 垫片（无需 symlink 特权）+ 路径改 %APPDATA%\npm |
| **P2** | PATH 连接符 | src/domains/instance/index.js | join(":") → join(path.delimiter) |
| **§7.1** | 服务管理器 Provider | src/platform/os/service.js（**新增**） | systemd / launchd / windows-service / none 四 Provider；未实现能力抛 CapabilityError |
| **§7.1** | systemctl 泄漏收敛 | instance/index.js、supervisor.js、dist/index.js | 8 处 + systemd-run 全部改经 service（stopUnit/daemonReload/isUnitActive/cleanTransient/startTransient） |
| **§7.1** | wmic/powershell 泄漏 | src/domains/relay/frpmgr.js | 删除重复的 Windows 分支，统一走平台层 pidlookup.pgrepList（三端已实现） |
| **§7.1** | xdg-open/cmd/open 泄漏 | src/platform/os/browser.js + router-ops.js | 新增 launchIsolated；router-ops 不再有 process.platform 分支 |
| 文档 | 头注释纠正 | src/platform/os/index.js | 删除「每一平台均有 Provider 实现」的不实陈述，按真实形态描述 |

### 验收

| 验证 | 结果 |
|---|---|
| npm test（33 文件） | **667 passed / 0 failed，EXIT=0** |
| UI typecheck / lint / build | 全通过 |
| 新增 test/cross-platform-test.js | 29 项：可执行解析（3 平台候选/目录）、文件保护、PATH 连接符、bin 安装、**分层不变量**（域层/guard/api/supervisor 无裸平台命令）、Provider 接口与能力 |
| 分层不变量扫描 | 域层/guard/api/supervisor **零** 裸平台命令调用 |
| 非平台层 process.platform 残留 | 仅 2 处纯映射/日志文本（无行为分支） |

### 未实施（明确边界）

- §7.5 能力缺失 UI 显式化（沙箱已在做，未推广到全部能力）。
- §7.6 拆分 supervisor.js（3387 行）——结构性重构，风险独立。
- §7.7 平台集成冒烟测试（需 CI 三平台真实调用）。
- macOS/Windows 沙箱支持（需 launchd/schtasks 的 transient 等价实现）——本次只把「加平台」的成本从「改 8 处」降为「加一个 Provider」。

### 遗留验证

- Windows 侧 icacls 与 .cmd 垫片、macOS launchctl 均**未在本环境实机验证**（本机 Linux）；cross-platform-test.js 已按平台条件断言，真实行为需三平台 CI 复核。

---

## 十、§7.6 实施记录：拆分 supervisor.js（2026-09-10）

### 成果

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/supervisor.js` | **3414 → 1138（−67%）** | 编排骨架：构造/启停/状态持久化/会话生命周期/升级 hold/注册表字段基座/兼容访问器 |
| `src/guard/supervisor/registry-view.js` | 267 | main 元数据（dsh-main.json）+ 受管目录（ManagedRegistry）同步 |
| `src/guard/supervisor/control-view.js` | 632 | 路由/远程控制门面 + 端口视图 + daemon 生命周期基元 |
| `src/guard/supervisor/settings-view.js` | 428 | 环境状态 + 守卫自更新 + 面板/访问密钥/关闭行为设置 |
| `src/guard/supervisor/converge-view.js` | 436 | 影子决策 + main 收敛状态机（`_dshConverge`/`tick`） |
| `src/guard/supervisor/main-process.js` | 375 | main 进程生命周期（spawn/接管/信号/崩溃窗/停止） |
| `src/guard/supervisor/supervise-view.js` | 297 | daemon 监督单拍 + 游离对象审计 + 端口再推导 + 假死判定 |

### 拆分机制（零行为变更）

- 每个 mixin 为 **class 包装 + 原型描述符导出**：`class Xxx {...}` → `Object.getOwnPropertyDescriptors(Xxx.prototype)`（删 `constructor`）→ 导出。
- supervisor.js 类尾按序注入：`Object.defineProperties(Supervisor.prototype, require('./guard/supervisor/xxx'))`。
- **保留 getter/setter 语义**（描述符原样搬运）、**保留构造器**（不覆盖 `prototype.constructor`）。
- 方法体**逐字未改**——仅依赖头由脚本按块内实际使用自动携带。

### 拆分中捕获并修复的三类真实缺陷（脚本已内建防护）

| # | 缺陷 | 症状 | 修复 |
|---|---|---|---|
| 1 | **遗漏依赖** | `_syncManagedRegistry: os is not defined`（registry-view 用了 `os.homedir()`） | 脚本改为**按块内实际使用自动检测**并携带内建模块与本地符号；后续 `deploy`/`guardVersion` 同样被自动捕获 |
| 2 | **内联函数未迁移** | 设置块引用模块级 `envCatalogSummary`（原在 supervisor.js 类外） | 随块迁入 mixin（否则运行期 ReferenceError） |
| 3 | **相对路径失效** | 块内 `require('./guard/monitor/probe')` 在 mixin 目录下解析失败 → `/ports` **500** | 脚本自动把块内 `require('./`）前移两级为 `require('../../` |

### 验收

| 验证 | 结果 |
|---|---|
| `npm test`（33 文件） | **667 passed / 0 failed，EXIT=0**（每步提取后各跑一次，共 6 次全绿） |
| UI typecheck / lint / build | 全通过 |
| `cross-platform-test`（分层不变量） | 29 passed / 0 failed |
| `session-lifecycle-test`（会话不变量） | 38 passed / 0 failed |
| 方法名冲突核验 | mixin 间**无重复**；与类体**无重叠**（108 个方法） |
| 进程内端到端 | `phase=RUNNING`（spawn→健康→收敛全链路正常） |

### 排障笔记（重要，供后续参考）

- **测试假失败**：多次出现的 `EADDRINUSE` / smoke S1 `phase=null` 经查为**并发或中断残留的 daemon 进程**占用 3900/392xx 端口，非代码回归——清理残留后全绿。
- **`pkill -f <pattern>` 会匹配自身命令行**导致 shell 自杀；清理须用精确 PID。
- 沙箱 `HOME` 被重定向，读取真实部署状态须 `HOME=/home/bowen`。

### 未做

- **未改变行为或对外接口**：纯结构性拆分，`module.exports = { Supervisor, normalize }` 不变。
- 后续可选：给 mixin 目录加 `index.js` 汇总、或将 `_m*` 字段基座也独立成模块。
