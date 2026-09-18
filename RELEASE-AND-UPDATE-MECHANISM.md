# 发布与更新机制总纲（RELEASE & UPDATE MECHANISM）

> **流程以 `RELEASE-STANDARD.md` 为准。**
> 本文件只讲机制**原理**（为何这样设计），**不再重复流程细节**（此前同一事实散落 5–8 处 → 已多次漂移）。


> 本文梳理「内核」与「桌面壳」的**推送（发布）**与**更新**机制（原理说明，流程见 `RELEASE-STANDARD.md`）。
> 判据：**稳定与可靠优先**，工业级标准，有舍有得。

---

## 0. 决策记录（累计）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 桌面形态 | **保留 Tauri 原生壳**（桌面级产品） |
| D2 | 壳更新源 | **壳直连公网自更新**；内核**不做更新源**，只做安全网 |
| D3 | 更新失败 | 显示选择页 **【重试】【继续】**（不静默放行，但【继续】始终可用） |
| **D4** | **Linux 分发形态** | **废弃 AppImage，采用标准 Linux 包（deb，可选 rpm）** |
| D5 | 通道 | npm CDN（unpkg 主 / jsdelivr 备） |
| D6 | 内核更新机制 | **绝不被本方案破坏**（四条路径原样保留） |

### D4 的影响与契合度（重要）

**你的决定实际上让分发回归了生产现状**——已取证：

```
$ dpkg -S /usr/bin/dsh-supervisor-gui
dsh-supervisor: /usr/bin/dsh-supervisor-gui      # 当前生产就是 deb 安装
```

且这**同时带来两个净收益**（均为实测/源码证据）：

| 收益 | 证据 |
|---|---|
| **体积缩小 20 倍** | deb **3.8MB** vs AppImage **77MB** |
| **更新耗时缩短 20 倍** | unpkg@1.71MB/s：deb **约 2 秒** vs AppImage 约 45 秒 |
| **自更新仍然成立** | Tauri 源码 `Some(Installer::Deb) => self.install_deb(bytes)`，实现为 `pkexec dpkg -i` |

**代价**：deb 安装到系统目录（`/usr/bin`，root 所有）→ 更新时需**一次 pkexec 密码确认**。
这是「标准 Linux 包」的固有属性，不是缺陷。

---

## 1. 两个组件、两条独立发布链（核心认知）

本项目有**两个独立演进的组件**，各有**独立的版本号、发布链、更新入口**：

| | 内核（dsh-supervisor） | 桌面壳（dsh-supervisor-gui） |
|---|---|---|
| 语言/形态 | Node.js（bundled core.cjs） | Rust / Tauri 2 |
| 仓库 | `dsh-supervisor-core`（**2026-09-13 起转为公开**） | `dsh-supervisor-launcher`（**公开**） |
| 分发单位 | **npm 平台子包** | **系统安装包** |
| 安装位置 | 用户级（`~/.npm-global` 等运行时前缀） | 系统级（Linux `/usr/bin`） |
| 版本示例 | `0.1.2-BETA.7` | `0.1.0` |
| 更新入口 | 壳引导 `core_plan/core_apply`；面板「检查更新」 | 壳启动 **门 0** |
| 监督 | **systemd `Restart=always`**（受监督） | 无（不受监督） |
| 日志 | `<产品状态根>/supervisor/log/`（Linux `~/.local/state/dsh-supervisor/supervisor/log/`）| `<产品状态根>/shell/shell.log` |

> **关键**：两条链**互不干扰**。壳的更新失败**不得**影响内核，反之亦然（D6）。

---

## 2. 内核发布链（**现有机制，本方案不改动**）

### 2.1 产物与命名

```
@dsh-sup/dsh-core-linux-x64
@dsh-sup/dsh-core-darwin-arm64
@dsh-sup/dsh-core-darwin-x64
@dsh-sup/dsh-core-win-x64
```

每个包内含：`bin/dsh-supervisor`（node 启动脚本）+ `core.cjs`（esbuild bundle）+ `ui-react/`（面板产物）。

### 2.2 构建与推送（平台分工，2026-09-10 定案）

| 平台 | 生产位置 | 入口 | 命令 |
|---|---|---|---|
| **linux-x64 / win-x64 / darwin-arm64 / darwin-x64** | **GitHub CI**（2026-09-13 硬标准：四平台全由 CI 产出） | tag `v<ver>` 触发 `build.yml` | 四平台矩阵各自 `ci-core.sh --publish`（本地无构建/发布路径）|

**认证**：`NPM_TOKEN`（经临时 userconfig 注入，不落盘）或既有 `~/.npmrc` 登录态；解析单源在 `release/scripts/_npm-auth.sh`。

### 2.3 用户侧落地与更新

```
壳引导门 2：core_plan（查最新） → core_apply（npm i -g --prefix <真实前缀>）
面板：guardSelfUpdateStatus（**只读**）；安装/重启由壳 core_apply 与 `kernel_update_apply` 桥执行（`guardSelfUpdateApply`/`guardSelfUpdateRestart` 已删除，协议 §A 方案）
镜像：registry_origins() 四源回退（npmmirror 优先，官方源兜底）
```

**本方案对此链的接触面 = 零**（P1 仅**只读**复用 `dist.fetchLatestVersion` 去查壳版本）。

---

## 3. 桌面壳发布链（**新建**）

### 3.1 产物矩阵（D4 后）

| 平台 | 产物 | 体积 | 更新产物 | 安装位置 | 提权 |
|---|---|---|---|---|---|
| Linux | `.deb`（**主**） | 3.8MB | `.deb` + `.sig` | `/usr/bin` | 更新需 pkexec |
| Linux（可选） | `.rpm` | ~4MB | `.rpm` + `.sig` | `/usr/bin` | 更新需 pkexec |
| macOS | `.app`（由 `.dmg` 装载） | 3.1MB | `.app.tar.gz` + `.sig` | `~/Applications` | 否 |
| Windows | `.msi` / NSIS `-setup.exe` | 3.7MB | `-setup.exe` + `.sig` | `%LOCALAPPDATA%`（per-user） | 否 |

> **不再构建 AppImage**（D4）。壳仓 `tauri.conf.json` 的 `bundle.targets` 由 `["deb","appimage","dmg","msi"]` 改为 `["deb","rpm","dmg","msi"]`。

### 3.2 发布流程（从 commit 到用户可更新）

```
① 开发完成 → push 到壳仓 main
② 打 tag：git tag v0.2.0 && git push origin v0.2.0
    ⚠ **必须先 `git push origin main`**：实测（2026-09-11）若 tag 指向的提交不在任何分支上，
    **GitHub 不会为该 tag 推送触发 workflow**（run 数为 0）。原 `release-core.sh` 只 `git push --tags`
    正是踩了这个坑；已改为 `git push origin HEAD --tags`。
    （CI 触发条件从「push main + tags」**改为仅 tags + workflow_dispatch**——省配额，见 P4.3）
③ 壳仓 CI（三平台并行）：
      export TAURI_SIGNING_PRIVATE_KEY=<CI secret>
      npx tauri build            # createUpdaterArtifacts: true → 产出安装包 + 更新产物 + .sig
④ 组装 npm 包：
      @dsh-sup/shell-linux-x64@0.2.0/
        ├── artifact/dsh-supervisor_0.2.0_amd64.deb    （更新产物本体）
        ├── artifact/....deb.sig                       （minisign 签名）
        └── shell-manifest.json                        （Tauri 静态清单）
⑤ npm publish --access public --tag <beta|rc|latest>
⑥ 清单即通过 CDN 直达用户：
      https://unpkg.com/@dsh-sup/shell-linux-x64@latest/shell-manifest.json
```

### 3.3 清单格式（Tauri 静态 JSON 语义）

```json
{
  "version": "0.2.0",
  "notes": "…",
  "pub_date": "2026-09-11T00:00:00Z",
  "platforms": {
    "linux-x86_64":   { "url": "https://unpkg.com/@dsh-sup/shell-linux-x64@0.2.0/artifact/…deb",       "signature": "<minisign sig>" },
    "darwin-aarch64": { "url": "https://unpkg.com/@dsh-sup/shell-darwin-arm64@0.2.0/artifact/….app.tar.gz", "signature": "…" },
    "windows-x86_64": { "url": "https://unpkg.com/@dsh-sup/shell-win-x64@0.2.0/artifact/…-setup.exe",   "signature": "…" }
  }
}
```

> **要点**：`url` 是任意 HTTPS（源码已验证 `pub url: Url`，无域名白名单）；
> **签名校验独立于托管位置** —— 故「npm CDN 承载 + minisign 验签」等价安全于「GitHub 承载 + 验签」。

### 3.4 与 GitHub Release 的关系

- **npm CDN = 更新通道**（程序自动更新走这里，实测 1.71MB/s）
- **GitHub Release = 人工下载通道**（首次安装、离线拷机、客服支持）
- 两者产物**同源同签**，不产生两套真相

---

## 4. 更新机制矩阵（用户侧，分平台）

| 平台 | 更新方式 | 提权 | 失败表现 |
|---|---|---|---|
| **Linux（deb/rpm）** | 应用内：Tauri → `pkexec dpkg -i` / `rpm -U` | 一次密码 | 选择页【重试】【继续】 |
| **macOS** | 应用内：Tauri → 替换 `~/Applications/xxx.app` | 否 | 选择页 |
| **Windows** | 应用内：Tauri → NSIS `passive` 静默 | 否 | 选择页 |

### 4.1 唯一的更新入口（保证一致性）

**所有平台都走同一条代码路径**：壳启动门 0 → `tauri-plugin-updater` → 下载 → 验签 → 平台安装 → 重启。
平台差异**全部封装在 Tauri 插件内**，壳不写任何平台分支。

### 4.2 Linux 使用标准包机制的必然推论

| 推论 | 说明 |
|---|---|
| 安装到系统目录 | `/usr/bin/dsh-supervisor-gui`（deb 标准），root 所有 |
| 更新需提权 | `pkexec` 图形密码框；用户拒绝 = 正常失败路径 → 选择页 |
| **依赖由 dpkg 校验** | deb 声明 `Depends`；因当前版本已在运行，依赖已满足；若新版本**新增**依赖，`dpkg -i` 可能报未满足 → 归入失败路径 |
| 内核 XDG 自启 .desktop | **已修（2026-09-16）**：模板改为**内嵌**（`autostart.js`），Exec/Icon 按实际安装路径重写，不再依赖外置 `desktop/` 目录 |

---

## 5. 完整时序（端到端）

### 5.1 发布时序（开发者视角）

```
【内核发布】
  CI（四平台）: git push origin HEAD --tags → 干净树+CHANGELOG 预检 → ci-core 全套门禁
                 → build.yml 四平台矩阵各自 ci-core.sh --publish（本地不参与）

【壳发布】
  壳仓:        git push origin main && git tag v<ver> && git push origin v<ver>   # 同样必须先推分支
                 → 四平台构建 + 签名 → npm publish @dsh-sup/shell-<os>-<arch>
                 → 用户下次启动自动看到更新（清单经 unpkg 直达）
```

### 5.2 启动时序（用户视角）

```
壳进程启动
 ├─[探针] 只读：平台/网络/安装形态（~200ms，失败不阻断）
 ├─[门 0] 壳自更新（直连 npm CDN）
 │      无更新/离线/不可自更新 → 放行
 │      有更新 → 备份当前产物 → 下载 → minisign 验签 → 安装（Linux 走 pkexec）→ 重启
 │      失败 → 选择页【重试】【继续】
 ├─[门 1] Node 运行时（低于最低标准才安装）
 ├─[门 2] 内核（core_plan → core_apply；npm 镜像四源回退）
 ├─[门 3] 守卫就绪（systemd 拉起 + TCP/HTTP 双确认）→ 面板
 └─[确认] finish_boot → 上报健康（= 更新确认信号）
          内核据此清 journal / 打 .ok（自动回退已移除：仅 pending→confirmed）
```

### 5.3 健康确认与回退（安全网闭环）

```
内核（受 systemd 监督）:
  · 观察：读 <产品状态根>/shell/identity.json（version / phase）
  · 确认：收到 phase=ready 且 version==journal.to → confirmed=true，清 journal
  · **无预取、无自动回退**：预取缓存、attempts 自增、pinnedVersions 拉黑与「重装 previous」
    等机制均已整体移除（`domains/shell/index.js` 现只有 pending→confirmed；紧急回退改由发布通道
    契约的 `rollback` dist-tag 显式触发，见 `RELEASE-CHANNEL-CONTRACT.md` §3/§4）
```

---

## 6. 与内核更新机制的边界（单一写入者，2026-09-15 修订）

**硬规则**：内核 npm 包的安装/升级**只有一个写入者 = 桌面壳**。守卫（内核）**不再安装自己**，
只提供只读状态。此前的「D6 双通道」判定（下表 ①④）作废 —— 它正是「更新逻辑分裂」的根因：
同一个全局 npm 包被内核与壳两个进程写，两套版本判定、两种源策略（内核强制官方 registry，壳走镜像）。

| 内核更新路径 | 旧语义 | 现方案 |
|---|---|---|
| ① 守卫自更新（npm 通道） | 内核 `POST /self-update/apply` → `runNpmInstall` | **撤销**：端点下架（410 + `KERNEL_UPDATE_SINGLE_WRITER`）；安装归壳 `core_apply` |
| ② 原生 DSH 更新 | 唯一 `_runInstall` → `dist.runNpmInstall` + 自动回滚 | **不改**（这是 DSH 本体，不是内核） |
| ③ 沙箱实例更新 | 带 `--prefix`，每实例独立 | **不改**（具名实例，不是内核包） |
| ④ manifest 通道 | `selfUpdateManifestUrl` 默认 null（未启用） | **删除**：死代码（端点从未接线，仅自测引用） |

**只读面（保留）**：内核 `GET /self-update/status` —— 版本/可更新性是事实查询，不是写入。
**写入面（唯一）**：壳 `core_apply`（启动门 2）与壳命令 `kernel_update_apply`（面板请求）。
**重启面（唯一）**：壳经服务管理器重启守卫（守卫从不重启自己）。

**面板请求通道**：面板由内核托管、运行在壳的内容 iframe 内，**不能用 Tauri IPC**（IPC 仅主帧）。
故面板经 `postMessage` 把「更新内核」转交壳主帧，由壳调用 `kernel_update_apply`（协议与校验见壳仓
`docs/DESIGN-SHELL-ARCHITECTURE.md` §3.2c）。核心里**没有任何**安装/重启自己的代码路径。

**壳侧约束**：
1. **禁止**为兼容旧壳而把内核降级或 pinned；
2. **禁止**壳回退时连带回退内核；
3. 内核更新**必须**经壳（单一写入者）——壳是唯一有权 `npm i -g <corePackageName>` 的一方；
4. P1 复用 `dist` 仅限**只读**（`fetchLatestVersion`）；壳安装内核走 `core.rs::install_version`，
   **不调用**内核 `dist.runNpmInstall`。

**隔离证明**：壳状态 `~/.dsh/shell/` vs 内核状态 `~/.dsh/supervisor/`（物理隔离）；
壳账本 `update-journal.json` vs 内核事件流（不同命名空间）。（历史注：`pinnedVersions` 拉黑机制已整体移除——壳现在只有 pending→confirmed；紧急回退改由 `rollback` dist-tag 显式触发。）
内核 npm 包是**共享产物**，故以「单一写入者」而非物理隔离来保证一致性。

---

## 7. 版本与兼容

| 维度 | 规则 |
|---|---|
| 内核版本 | `package.json` 单源；`X.Y.Z(-BETA.n/-RC.n)` |
| 壳版本 | 壳仓**三处互锁**：`Cargo.toml` = `tauri.conf.json` = `Cargo.lock`（`scripts/verify-shell-versions.js`，壳仓自持）|
| 两者关系 | **独立版本线**；通过元数据声明兼容区间协商（`kernelMin` / `shellMin`） |
| 不兼容时 | **唯一允许动作：先升级壳**（禁止降级内核） |
| npm dist-tag | `-BETA.*`→`beta`；`-RC.*`→`latest`（rc 为发布后补打的附加别名）；无后缀→`latest`；`rollback`/`canary` 人工运维（见 `RELEASE-CHANNEL-CONTRACT.md` §4）|

---

## 8. 风险登记册（发布与更新相关）

| # | 风险 | 缓解 |
|---|---|---|
| K1 | minisign 私钥丢失 → 已发布用户**永久**无法更新 | 异地多份 + 双人托管 + **首次发布前演练恢复** |
| K11 | Tauri 原地安装不保留旧版本 | **更新前强制备份** + 内核缓存 |
| K13 | npm CDN（unpkg/jsdelivr）为第三方 | 多 CDN 回退 + **内核本地缓存**兜底 + 失败进选择页 |
| K14 | deb 自更新需 pkexec，用户可拒绝 | 视为正常失败路径 → 选择页【重试】【继续】 |
| K15 | deb 新版本新增依赖 → `dpkg -i` 报未满足 | 归入失败路径并**如实显示原因**；文档说明可用 `apt install ./x.deb` 手动补依赖 |
| K16 | 壳仓 CI 推 main 即四平台完整构建（耗时；2026-09-13 按明确要求改为 push main 也跑完整矩阵）| 公开仓 Actions 免额度；**发布**仍仅 tag 触发（`publish` job）|

---

## 9. 待实测/待确认

| # | 事项 | 说明 |
|---|---|---|
| V1 | Tauri 是否为 **deb/rpm** 自动生成 `.sig` | 官方文档的 v2 产物列表只列 AppImage/macOS/Windows。**若未生成 → 我们自己用 `tauri signer sign` 签**（清单的 signature 只要求能被 pubkey 验过，与来源无关）。需 Rust 环境验证 |
| V2 | deb 自更新在缺依赖时的真实行为 | 需真机验证 `dpkg -i` 的报错形态，以定错误文案 |
| **N2** | **Linux 是否加 rpm**（除 deb 外） | 建议：**先只发 deb**（覆盖主流），rpm 视用户需求再加——减少 CI 与测试面 |
| **N4** | 是否发布 **apt/yum 仓库**（VS Code 模式） | 可选增强：系统包管理器自动更新 + 依赖解析。代价：需仓库托管 + GPG 密钥管理 |

---

## 10. 一句话总览

```
内核：公开仓 → npm 平台子包（**四平台全由 CI 产出**）→ 用户经壳引导或面板更新（镜像四源）
壳  ：公开仓 → CI 构建 deb/dmg/msi + 签名 → npm 包 @dsh-sup/shell-* → unpkg 清单
        → 壳启动门 0 自更新（Linux 走 pkexec 标准包）→ 健康确认（无常驻回退；紧急回退走 rollback dist-tag）
边界：壳管壳、内核管内核；兼容靠声明协商；绝不互相降级
```

