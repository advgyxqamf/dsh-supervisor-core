# 跨平台构建与自更新完整方案（公开产品视角）

> **流程以 `RELEASE-STANDARD.md` 为准。**
> 本文件只讲跨平台方案**论证**，**不再重复流程细节**（此前同一事实散落 5–8 处 → 已多次漂移）。


> 起因（用户批评，成立）：**此前方案只按本机 Linux 想，Linux 也没有完整的分发逻辑**。
> 我们是**公开发行的跨平台桌面产品**，必须适配不同 Linux 发行版、macOS、Windows，
> 且**构建统一基于 GitHub**，最终完成「桌面壳可自更新」的整套链路。
> 本文全部结论基于**实测与源码证据**，非推断。

---

## 一、先承认三个真实缺口（我的问题）

| # | 缺口 | 后果 |
|---|---|---|
| **G1** | 只按**本机**（Linux Mint 22.3 / Ubuntu 24.04 基座）考虑 | **当前公开发布的 deb 只能装在 Ubuntu 24.04+**（详见二） |
| **G2** | 把 Linux 当成**单一形态**（deb 一种） | 未考虑发行版差异、架构差异、依赖差异 |
| **G3** | 未展开 macOS / Windows 的**构建、签名、自更新**全链路 | 无法作为公开产品发布 |

---

## 二、决定性实测：当前 Linux 产物**只能装 Ubuntu 24.04+**

### 2.1 证据

**证据 A**：已安装 deb 声明的依赖（`dpkg -s dsh-supervisor`）：

```
Depends: libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0
```

**证据 B**：二进制实际链接的 WebKit ABI：

```
$ ldd /usr/bin/dsh-supervisor-gui | grep webkit
  libwebkit2gtk-4.1.so.0 => /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0
```

**证据 C（最关键）**：二进制要求的 **glibc 符号版本**：

```
$ objdump -T /usr/bin/dsh-supervisor-gui | grep -oE "GLIBC_[0-9.]+" | sort -uV | tail -1
GLIBC_2.39        ← 最高要求
```

原因是**在本机（Ubuntu 24.04 基座，glibc 2.39）构建** —— glibc 是**前向兼容**：
**在新 glibc 上编译的二进制，无法在旧 glibc 上运行**。

### 2.2 发行版覆盖矩阵（当前状态）

| 发行版 | glibc | webkit2gtk-4.1 | **当前 deb 可用？** |
|---|---|---|---|
| Ubuntu 24.04 LTS | 2.39 | 有 | ✅ |
| Ubuntu 26.04 | ≥2.39 | 有 | ✅ |
| Debian 13 | 2.41 | 有 | ✅ |
| **Ubuntu 22.04 LTS** | **2.35** | **有**（security/universe，实测） | ❌ **glibc 不足** |
| **Debian 12** | **2.36** | 有（实测） | ❌ **glibc 不足** |
| Ubuntu 20.04 / Debian 11 | 2.31 / 2.31 | **无**（实测 focal 无 4.1） | ❌ ABI + glibc 均不足 |
| Fedora / Arch | 2.4x | 有 | ⚠️ 视 glibc 版本 |

> **结论**：当前的公开 deb **把最主流的 Ubuntu 22.04 LTS 与 Debian 12 用户全部排除在外**。
> 这是一个必须修的产品缺陷，而非配置细节。

### 2.3 修复原则（工业标准）

**在「你想支持的最老基座」上构建，而不是在最新上构建。**

| 方案 | 基座 | 覆盖 | 取舍 |
|---|---|---|---|
| **推荐** | **`ubuntu-22.04`**（glibc 2.35 + webkit2gtk-4.1） | Ubuntu 22.04+ / Debian 12+ / Fedora 36+ | ✅ 覆盖最广且不需容器 |
| 备选 | 容器内用 Debian 12 基座 | 类似 | ABI 需匹配 4.1 |
| 更激进 | 容器内更老基座（如 Debian 11） | 更广 | **无 webkit 4.1** → 需改用 4.0，**Tauri 主线不支持** |

**已实测验证**：Ubuntu 22.04（jammy）**确实提供 `libwebkit2gtk-4.1-0`**
（`2.50.4-0ubuntu0.22.04.1`，security/universe）—— 因此 `ubuntu-22.04` 是**可行且最优**的 Linux 基座。


---

## 二·补 本地实证（2026-09-11，Rust 工具链就绪后的真实验证）

### 2.4 验证环境与结果

| 项 | 结果 |
|---|---|
| Rust 工具链 | **rustc 1.98.1 / cargo 1.98.1**（经 rsproxy 镜像安装，官方源仅 18KB/s） |
| 构建 | `cargo build --release` **成功**，耗时 **3m52s**，产物 8.5MB ELF |
| 系统依赖 | libwebkit2gtk-4.1-dev / libgtk-3-dev / libayatana-appindicator3-dev / librsvg2-dev 齐全 |
| 构建基座 | Linux Mint 22.3（Ubuntu 24.04 基座，**glibc 2.39**） |

### 2.5 ⛔ F1 缺陷的决定性证据（加载测试）

仅靠符号表还不够，做了**真实加载测试**：下载 Ubuntu 22.04 的 `libc6 2.35` 并解包，
用其 `ld.so` 加载本机构建的产物：

```
$ <glibc-2.35-ld.so> --library-path <2.35-libs>:<host-libs> dsh-supervisor-gui --node-plan
dsh-supervisor-gui: libc.so.6: version `GLIBC_2.39' not found
                    (required by .../dsh-supervisor-gui)
```

**结论：产物真无法在 Ubuntu 22.04 加载** —— 不是"可能"，是确定不行。

### 2.6 🎯 根因定位（最小复现，两行代码）

逐层排除后得到**最小复现**：

| 程序 | 最高 glibc 需求 | pidfd 弱符号数 |
|---|---|---|
| hello-world（`fn main(){}`） | `GLIBC_2.34` ✅ | 0 |
| **hello-world + `Command::new("/bin/true").status()`** | **`GLIBC_2.39`** ❌ | 2 |

> 仅加入一次**进程 spawn**，就复现了整个 F1 缺陷。

**完整根因链**：

1. **Rust 官方预编译 std** 的 `process` 模块含有对 `pidfd_spawnp` / `pidfd_getpid` 的**弱引用**
   （`objdump` 显示为 `w` = weak；二者是 glibc **2.39 才新增**的 `posix_spawn` pidfd 变体）。
2. 在 **glibc 2.39 基座**上链接时，链接器**在本机 `libc.so.6` 中成功解析**了这两个弱符号，
   因而在 `.gnu.version_r`（verneed）中记录了一条 **硬性** `GLIBC_2.39` 版本需求。
3. 该 verneed 条目在旧系统上**无法满足** → 动态链接器直接报错退出。
4. 在 **glibc 2.35 基座**（Ubuntu 22.04）上链接时，`libc.so.6` **并不提供**这两个符号，
   弱引用保持**未解析且无版本** → **不产生 verneed 条目** → 二进制可在旧系统运行。

**排查中排除的假设**（保留过程，避免重复劳动）：
- ❌ 不是 `tokio`（其 `pidfd_spawnp` 仅出现在注释/测试中，非运行时代码）
- ❌ 不是 `libc` crate（无相关引用）
- ❌ 不是本项目代码
- ✅ **是 Rust 预编译 std 的 process 模块 + 构建基座的 glibc 版本**

### 2.7 修复方案（已确证充分）

**在 `ubuntu-22.04`（glibc 2.35）基座上构建** —— 这是唯一且充分的正解，
与 Chrome / VS Code 等产品的做法一致（**在最老的受支持基座上构建**）。

**为什么不需要其它 hack**：根因是**链接期**的弱符号解析，而非代码或依赖版本问题；
换基座即从根上消除（该环境不存在可解析的 2.39 符号）。

**已落地的防线**（`ci/check-glibc.sh`，防止回归）：

```
$ bash ci/check-glibc.sh <binary> 2.35
== glibc 门禁: <binary> ==
  要求的最高符号: GLIBC_2.39   允许上限: 2.35
  ❌ 失败：该产物要求 GLIBC_2.39 > 2.35
     发行版兼容性将受限（例如 Ubuntu 22.04 仅有 glibc 2.35）。
     修复：在更老的基座上构建（推荐 GitHub runner: ubuntu-22.04）。
```

- 已用**真实产物**验证：能正确报出并拦截
- 已接入内核测试链：`test/glibc-gate-test.js`（7 断言，含平台守卫，非 Linux 优雅跳过）
- **同步方式（2026-09-11 变更）**：`export-shell.sh` 已随双仓隔离删除，两仓不再自动同步。
  内核 `ci/check-glibc.sh` 与壳仓同名脚本现为**各自维护**（内容当前一致）；
  如需再单源化，应改用显式同步手段而非隐式导出目录。

### 2.8 至此确认的结论

| # | 结论 | 状态 |
|---|---|---|
| 1 | Rust 工具链可用，壳可在本机构建 | ✅ 已验证 |
| 2 | 本机构建的产物**确实无法**在 Ubuntu 22.04 运行 | ✅ 已实测 |
| 3 | 根因 = Rust std 弱引用 + 构建基座 glibc 版本 | ✅ 已最小复现 |
| 4 | 修复 = CI 基座改 `ubuntu-22.04` | ✅ 方案充分（待 CI 实跑确认，见 V2） |
| 5 | 门禁可拦住该缺陷回归 | ✅ 已落地并验证 |

---

## 三、GitHub Runner 精确可用性（实测标签）

从 `actions/runner-images` 官方 README 的 Available Images 表提取：

| 目标 | YAML 标签 | 架构 | 可用性 |
|---|---|---|---|
| Linux x64（**基座**） | **`ubuntu-22.04`** | x64 | ✅ 可用 |
| Linux x64（新） | `ubuntu-24.04` / `ubuntu-latest` | x64 | ✅ |
| Linux arm64 | `ubuntu-24.04-arm` / `ubuntu-22.04-arm` | arm64 | ✅ |
| macOS arm64 | `macos-latest`(=macOS 26) / `macos-15` | arm64 | ✅ |
| **macOS x64（Intel）** | **`macos-15-intel`** / `macos-26-intel` | x64 | ✅ **可用**（无需再靠交叉编译！） |
| Windows x64 | `windows-latest` / `windows-2025` | x64 | ✅ |
| Windows arm64 | `windows-11-arm` | arm64 | ✅（可选） |

> **重要修正**：此前方案假设「GitHub 已无 Intel macOS runner，darwin-x64 需交叉编译」。
> **实测表显示 `macos-15-intel` 存在** → darwin-x64 可**原生构建**（更可靠，避免交叉编译的签名问题）。
> 注意：macOS 14 镜像已进入弃用流程，**不要用 `macos-14`**。

### 3.1 一个关键的额度事实

**壳仓 `dsh-supervisor-launcher` 是公开仓（MIT）→ GitHub Actions 标准 runner 额度免费。**
因此壳的构建矩阵**不受额度约束**，可以按「覆盖优先」设计（多发行版、多架构）。

**内核仓 `dsh-supervisor-core` 已转为公开仓**（2026-09-13）→ 不再受 Actions 额度约束；「Linux 本地生产」的额度动因随之消失，现**四平台全由 CI 产出**（见 release/README.md）。

~~原文（已作废）：内核仓是私有仓 → 受额度约束 → 这也是「Linux 本地生产」决策的由来。~~

---

## 四、完整构建矩阵（GitHub；壳**四平台**（linux/mac arm64/mac x64/win），见壳仓 `docs/RELEASE-STANDARD.md`）

### 4.1 目标产物矩阵

| # | 平台 / 架构 | Runner | 产物 | npm 包名 |
|---|---|---|---|---|
| 1 | Linux x64 | `ubuntu-22.04` | `.deb` | `@dsh-sup/shell-linux-x64` |
| 2 | Linux x64 | `ubuntu-22.04` | `.rpm`（可选，N2b） | 同上 |
| 3 | Linux arm64 | `ubuntu-22.04-arm` | `.deb` | `@dsh-sup/shell-linux-arm64` |
| 4 | macOS arm64 | `macos-latest` | `.app.tar.gz` + `.dmg` | `@dsh-sup/shell-darwin-arm64` |
| 5 | macOS x64 | **`macos-15-intel`** | `.app.tar.gz` + `.dmg` | `@dsh-sup/shell-darwin-x64` |
| 6 | Windows x64 | `windows-latest` | NSIS `-setup.exe` + `.msi` | `@dsh-sup/shell-win-x64` |
| 7 | Windows arm64（可选） | `windows-11-arm` | NSIS | `@dsh-sup/shell-win-arm64` |

### 4.2 为什么这样切分

| 维度 | 依据 |
|---|---|
| **Linux 基座 = 22.04** | glibc 2.35 覆盖 22.04+；且已实测有 webkit2gtk-4.1 |
| **Linux arm64 单列** | 服务器/ARM 桌面渐多；`.deb` 的 `Architecture` 字段不同 |
| **macOS 双架构原生** | `macos-15-intel` 可用；避免交叉编译的签名/公证风险 |
| **Windows 用 NSIS 为主** | NSIS 支持 per-user 免提权 + 静默 `passive` 更新；MSI 需管理员 |

---

## 五、各平台自更新链路（完整）

### 5.1 统一入口（所有平台同一代码路径）

```
壳启动 → 门 0 → tauri-plugin-updater:
    check(端点=清单) → 比对版本 → download(url) → minisign 验签 → 平台安装 → app.restart()
平台差异全部封装在 Tauri 插件内，壳不写平台分支。
```

### 5.2 Linux（deb / rpm）

| 项 | 内容 |
|---|---|
| 安装位置 | `/usr/bin/dsh-supervisor-gui`（系统级，dpkg 管理） |
| 更新方式 | Tauri `install_deb` → **`pkexec dpkg -i`**（图形密码框） |
| 依赖声明 | `Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1` |
| 提权 | **需要一次密码** |
| 失败处理 | 用户拒绝/依赖未满足 → 选择页【重试】【继续】 |
| 依赖未满足 | 提示 `sudo apt install -f` 或 `apt install ./x.deb`（自动补依赖） |

### 5.3 macOS

| 项 | 内容 |
|---|---|
| 形态 | `.app`（由 `.dmg` 首次装载）；安装到 `~/Applications`（用户级，可写） |
| 更新方式 | Tauri `Installer::App` → 替换 `.app`（**需退出并重启**） |
| **签名** | **必须**：Developer ID Application 证书（否则 Gatekeeper 拦截） |
| **公证** | **必须**：`notarytool` 提交 Apple 公证 + `stapler` 装订（否则首次运行被拦） |
| Hardened Runtime | **必须**（公证前提） |
| 最低系统 | Tauri 2 支持 macOS 10.15+（arm64 需 11.0+） |
| 双架构 | x64（10.15+）与 arm64（11.0+）**各自独立签名** |

### 5.4 Windows

| 项 | 内容 |
|---|---|
| 形态 | NSIS `-setup.exe`（主，per-user）/ `.msi`（备，per-machine） |
| 安装位置 | NSIS per-user → `%LOCALAPPDATA%`（**免提权**，Tauri 默认） |
| 更新方式 | Tauri `installMode: passive` → 小进度条静默安装 → `app.restart()` |
| **WebView2** | **运行时依赖**（Win10 以下需装）；用 `downloadBootstrapper`（默认）或 `embedBootstrapper`（离线） |
| **代码签名** | **强烈建议**（否则 SmartScreen 告警 + 更新体验受损） |
| 最低系统 | Windows 7+（WebView2 限制） |

---

## 六、发布链路（统一基于 GitHub）

```
【壳发布】公开仓 dsh-supervisor-launcher（CI 免费额度）
  ① git push origin HEAD && git tag v0.2.0 && git push origin v0.2.0
  ② GitHub Actions 矩阵（7 个 job，见 §4.1），每个 job：
       - 装系统依赖（Linux 22.04 的 webkit2gtk-4.1-dev 等）
       - Rust 工具链（dtolnay/rust-toolchain）
       - npx tauri build（设置 TAURI_SIGNING_PRIVATE_KEY）
       - 产出：安装包 + 更新产物 + .sig
  ③ 汇总 job：组装 npm 包 + shell-manifest.json → npm publish
  ④ 同时挂 GitHub Release（人工下载通道）

【内核发布】dsh-supervisor-core（已公开；四平台全由 CI 产出）
  linux : CI（ubuntu-22.04 基座 / glibc 2.35）
  mac/win: tag → GitHub Actions（同一矩阵，四平台）
```

### 6.1 清单（shell-manifest.json）

```json
{
  "version": "0.2.0",
  "notes": "…", "pub_date": "2026-09-11T00:00:00Z",
  "platforms": {
    "linux-x86_64":   { "url": "https://unpkg.com/@dsh-sup/shell-linux-x64@0.2.0/artifact/….deb",         "signature": "…" },
    "linux-aarch64":  { "url": "https://unpkg.com/@dsh-sup/shell-linux-arm64@0.2.0/artifact/….deb",       "signature": "…" },
    "darwin-x86_64":  { "url": "https://unpkg.com/@dsh-sup/shell-darwin-x64@0.2.0/artifact/….app.tar.gz", "signature": "…" },
    "darwin-aarch64": { "url": "https://unpkg.com/@dsh-sup/shell-darwin-arm64@0.2.0/artifact/….app.tar.gz","signature": "…" },
    "windows-x86_64": { "url": "https://unpkg.com/@dsh-sup/shell-win-x64@0.2.0/artifact/…-setup.exe",     "signature": "…" }
  }
}
```

> Tauri 的 `{{target}}`/`{{arch}}` 变量会自动按平台取对应键，无需壳内判断。

---

## 七、自更新完整时序（含安全网）

```
① 壳启动 → 只读探针（平台/架构/网络/安装形态）
② 门 0：check(清单) → 有新版？
     否 / 离线 / 已达阈值 → 放行（落盘记录原因）
     是 → 备份当前产物 → download(CDN) → minisign 验签 → 平台安装 → app.restart()
③ 新版本启动 → 写 shell.log + identity.json(attempt 自增) → 引导
④ 达 finish_boot → POST /shell/health {phase:ready, version}
⑤ 内核（若在运行，systemd 常驻）：
     · 确认：version == journal.to → confirmed=true，清 journal，打 .ok
     · 回退：未确认 且 attempts>2 → 判坏 → pinnedVersions += v → 用缓存重装 previous → 事件+通知
⑥ 失败（下载/验签/安装/提权拒绝）→ 选择页【重试】【继续】
```

---

## 八、风险登记（跨平台新增）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **L1** | glibc 基座过新 | 主流发行版装不上（**当前已发生**） | **基座固定 `ubuntu-22.04`**；CI 加**门禁断言**：`objdump -T` 最高 GLIBC ≤ 2.35 |
| **L2** | webkit2gtk ABI 不匹配 | 运行失败 | 固定构建 4.1；`Depends` 显式声明；文档说明最低发行版 |
| **L3** | 发行版依赖缺失 | `dpkg -i` 失败 | 提示 `apt install -f`；文档；可选后续做 apt 仓库（N4） |
| **M1** | macOS 未签名/未公证 | **用户装不上/被拦** | Developer ID + notarytool + stapler（硬性） |
| **M2** | macOS 双架构签名差异 | 某架构失效 | 两个架构各自构建+签名+公证 |
| **W1** | 缺 WebView2 运行时 | 启动失败 | `downloadBootstrapper` 自动安装；提供离线包选项 |
| **W2** | 无代码签名 | SmartScreen 告警，转化率低 | 代码签名证书（D6 定案） |
| **W3** | MSI 需管理员 | 无法 per-user 自更新 | **主推 NSIS per-user**；MSI 仅作备选 |
| **C1** | minisign 私钥丢失 | 已发布用户永久无法更新 | 异地多份 + 双人托管 + 发布前演练恢复 |

---

## 九、需修正的既有缺陷清单（按优先级）

| # | 缺陷 | 修正 |
|---|---|---|
| **F1** | Linux 构建基座过新（glibc 2.39）—— **已实测确证**（产物无法在 Ubuntu 22.04 加载） | ✅ **已修**：壳仓 CI 基座改 `ubuntu-22.04` + 门禁断言 `glibc_max=2.35`；`ci/check-glibc.sh` 单源导出到壳仓 |
| **F2** | 壳仓 CI 缺 `createUpdaterArtifacts` | ⏳ 待密钥：CI 已接 `TAURI_SIGNING_PRIVATE_KEY` 环境变量与 `.sig` 收集；**未配密钥时不产 .sig 并告警**（不阻断构建） |
| **F3** | 无 macOS 签名/公证 | ⏸ **暂缓**（用户定案 2026-09-11：暂无证书）。不阻塞构建与手动安装（有拦截提示，用户可手动放行）；自动更新链路由 minisign 保障完整性，与此无关 |
| **F4** | 无 Windows 代码签名；MSI 需管理员 | ⏸ **暂缓**（同上，无证书）。CI 已改主推 NSIS per-user（免提权）；无签名时 SmartScreen 会提示，用户可继续 |
| **F5** | CI 触发为 `push main + tags`（浪费构建） | ✅ **已修**：改为仅 `tags: ['v*']` + `workflow_dispatch` |
| **F6** | 内核 `desktop/` 模板路径与 deb 实况不符 | ✅ **已修（2026-09-16）**：模板内嵌进 `autostart.js`，Exec/Icon 按实际安装解析；外置 `desktop/` 目录已删 |
| **F7** | 壳零落盘日志、无版本上报 | P0.1 / P0.2（执行方案） |

---

## 十、待确认与待实测

| # | 项 | 说明 |
|---|---|---|
| **V1** | Tauri 是否为 **deb/rpm** 生成 `.sig` | 官方文档 v2 产物列表未列 deb；若未生成则用 `tauri signer sign` 自签（清单的 signature 只要求能被 pubkey 验过） |
| ~~V2~~ | ~~`ubuntu-22.04` 上能否顺利构建~~ | **部分验证 ✅**：本机（24.04 基座）`cargo build --release` **成功，3m52s**；系统依赖齐全；根因已定位（见 2.6），故 22.04 基座必然消除 2.39 需求。**仍需 CI 实跑一次确认端到端**（含 `tauri build` 打包与 `.sig` 生成） |
| **V3** | Linux arm64 是否有用户需求 | 影响是否保留 job 3 |
| **V4** | Windows arm64 是否纳入 | 影响是否保留 job 7 |
| **N2b** | 是否发 rpm | 建议先只发 deb |
| **N4** | 是否建 apt/yum 仓库 | 后续加分项 |
| **W4** | macOS 最低支持版本（10.15 / 11.0 / 12.0） | 影响构建 target 与测试面 |

---

## 十一、一句话总结

```
构建：GitHub 全平台矩阵（Linux 22.04 基座 / macOS 双架构原生 / Windows NSIS per-user）
  关键修复：Linux 基座从 24.04 降到 22.04 → 覆盖从「仅 24.04+」扩到「22.04+ / Debian 12+」
签名：三平台都要（Linux 用 minisign；macOS 用 Developer ID + 公证；Windows 用代码签名）
分发：产物发 npm 包 → unpkg 清单 → 壳直连自更新（实测 1.71MB/s）
安全网：内核预取 + 备份 + 健康确认 + 有界回退（不受监督方由受监督方兜底）
边界：壳管壳、内核管内核；绝不互相降级
```

