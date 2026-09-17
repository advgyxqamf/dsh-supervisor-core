# 无控制台窗口规范（NO-CONSOLE-WINDOW-STANDARD）

> **本文件是「壳启动内核全链路不得弹出终端窗口」的唯一事实源（SSOT）**，2026-09-16 立。
> 适用范围：**两仓**（内核 `advgyxqamf/dsh-supervisor-core`、壳 `wasi7mglns/dsh-supervisor-launcher`）。

---

## 1. 现象与根因（真机取证）

真机：壳启动内核时**弹出终端窗口**。取证结论：这不是单点 bug，而是**缺少统一约束**——
「不弹控制台」在两仓各自只被零散处理，覆盖不全：

| 侧 | 现状 | 缺口 |
|---|---|---|
| 壳 Rust | `bounded::prepare()` 已加 `CREATE_NO_WINDOW`，`platform/mod.rs`/`service.rs` 也各自加 | `env.rs::node_version()` **直接 spawn node，未经统一执行器** → 每次探测 Node 闪黑框 |
| 内核 JS | `platform/util/exec.js` 的**同步** execFileSync 已 `windowsHide: true`，并有门禁 G9-d | **异步 `spawn` 无任何统一封装与门禁** → 14 处裸 spawn，**13 处缺 `windowsHide`** |

**精确机制（Node 官方文档，`child_process.spawn` 的 `options.detached`）**：

> On Windows, setting `options.detached` to true … **The child will have its own console window.**

即：**`detached: true` 本身就是「给子进程建一个自己的控制台窗口」**，而 `windowsHide: true`
正是用来隐藏「本会创建的」那个窗口。故「detached 且未 windowsHide」= 必弹窗口，**两者必须成对出现**。

**最严重的三处**（`detached:true` + 无 `windowsHide`，Windows 上必弹新控制台）：

> 以下路径为**当前实现位置**；早期行号已随重构失效，故主进程与 daemon 两项不再钉行号，具体以 §4 门禁的实际扫描为准。

- `src/app/main/process.js` —— **主 DSH 进程**（用户看到的终端窗口就是它）；
- `src/app/daemons/process.js`（受管进程 spawn）/ `src/app/daemons/supervise.js`（监督）—— router/lan daemon；
- `src/domains/router/providers/proxy.js:272` —— 反代实例。

其余缺 `windowsHide`：`domains/dist/index.js:522`（npm 安装）、`domains/relay/frpmgr.js:188`、
`domains/shell/index.js:256/269`、`guard/native/manager.js:736`（npm 卸载）、
`guard/proc/daemon-lifecycle.js:76`、`platform/os/browser.js:30/39/113`、`platform/os/notify.js:69`。

---

## 2. 铁律

| # | 铁律 |
|---|---|
| **W1** | **内核 JS**：不得裸调 `child_process.spawn`。一律经统一封装 `platform/os/spawn.js::detached()` / `::piped()`（**默认 `windowsHide: true`**）。 |
| **W2** | **壳 Rust**：不得直接 `Command::spawn()`。一律经 `bounded::prepare()`（加 `CREATE_NO_WINDOW`）或 `bounded::run`；`creation_flags` 只在 `platform/` 与 `bounded.rs` 出现。 |
| **W3** | `windowsHide`/`CREATE_NO_WINDOW` 的默认值是 **true/加标志**：想弹窗必须**显式**关掉并写明理由（当前全仓无此需求）。 |
| **W4** | 壳为 GUI 子系统（`windows_subsystem = "windows"`，release），故壳自身不产生控制台；弹窗只可能来自**子进程未隐藏**。 |
| **W5** | 该约束必须由**门禁**强制，不靠注释：内核「src 下裸 spawn 计数 = 0」，壳「src 下裸 `Command::spawn` 计数 = 0（白名单：bounded.rs/platform）」。 |

---

## 3. 内核统一封装契约（`platform/os/spawn.js`，冻结）

```js
// 独立进程组（后台常驻：主 DSH / daemon / 反代 / 浏览器）——Windows 上必须隐藏控制台
detached(cmd, args, opts) -> ChildProcess
  // opts: { env, stdio='ignore', cwd }
  // 固定: detached:true, windowsHide:true

// 管道模式（需要读取输出：npm install / 插件 CLI / frpc）
piped(cmd, args, opts) -> ChildProcess
  // 固定: stdio:['ignore','pipe','pipe'], windowsHide:true
  // opts.detached 可显式覆盖（默认 false）

// 浏览器/OS 打开（完全脱离本进程）
detachedIgnored(cmd, args, opts) -> ChildProcess   // 等价 detached + stdio:'ignore'
```

**不变量 W-1**：三个入口产出的 options 必含 `windowsHide: true`（门禁以正则/行为双重锁定）。
**不变量 W-2**：`detached()` 仍保持 `detached: true`（进程组语义不得因隐藏窗口而丢失）。
**不变量 W-3**：不得改变既有 `stdio` 契约（主 DSH 需要 pipe 读令牌 → 用 `piped`）。

---

## 4. 门禁

| 门禁 | 断言 |
|---|---|
| K-W1 | `platform/os/spawn.js` 三个入口均含 `windowsHide: true` |
| K-W2 | `src/**` 下 `spawn(` 的**裸调用点 = 0**（只允许经封装；测试可豁免） |
| K-W3 | 反向：能识别旧形态（无 `windowsHide` 的裸 spawn）→ 门禁非空转 |
| S-W1 | 壳 `src/**` 下 `Command::spawn` 仅出现在 `bounded.rs` 与 `platform/mod.rs`、`platform/service.rs` |
| S-W2 | `env.rs::node_version` 不再自行 spawn（改为经统一执行器或显式加标志） |

---

## 5. 非目标

- 不改「是否 detached」的既有语义（那是生命周期设计，与窗口无关）；
- 不在本规范处理 Linux/macOS 的等价物（POSIX 无控制台窗口概念，`windowsHide` 无害且自动忽略）。