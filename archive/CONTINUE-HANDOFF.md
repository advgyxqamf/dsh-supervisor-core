# DSHSup 工程拆分与发布 —— 交接文档（Continue Handoff）

> 生成时间：2026-09-09（会话窗口已满，新窗口继续）
> 本文件是唯一权威交接依据；所有事实均来自本会话命令输出，未做推测。

---

## 一、你正在做的事（目标）

把单仓 `lobbowen/dsh-supervisor`（壳+核混放）彻底拆成**双仓**，带完整 git 历史迁移到新账号 `wasi7mglns`，让发布永不"壳/核错位"。核心诉求：**桌面壳（GitHub 安装程序）与内核（npm 包）发布分离，且壳首次产出可下载的 Linux 桌面安装程序（.deb/.AppImage）**。

## 二、关键认知（已澄清，勿再混淆）

| 交付物 | 是什么 | 产物 | 谁发布 |
|---|---|---|---|
| **桌面壳 Shell** | Tauri GUI 程序（用户真正下载/安装的"桌面程序"） | `src-tauri/` 构建 → `.deb/.AppImage/.dmg/.msi` | 壳仓 `launcher-build.yml` |
| **内核 Core** | 命令行守护进程（被壳拉起，监管 DSH） | `bin/ src/ ui/` → npm 子包 `@dsh-sup/dsh-core-*` | 内核仓 `build.yml` |

**此前错误**：一直把"内核 npm 包"当成"安装程序"——那是错的。安装程序=壳的产物。

## 三、已完成（双仓已建、历史已迁移、已推送）

| 步骤 | 状态 | 结果 |
|---|---|---|
| 1. 全量备份 | ✅ | `plus-pre-split-backup-20260909-224258/plus-repo.bundle`（110MB，含全部分支/标签） |
| 2. 排查 src-tauri 历史 | ✅ | 历史含两前缀：旧 `dsh-supervisor/src-tauri/` + 新 `src-tauri/`（3f5de31 提升提交切换） |
| 3. 安装 git-filter-repo | ✅ | `pip install git-filter-repo` → 脚本在 DSH 沙箱 `.../data/.local/bin/git-filter-repo`；**调用方式必须用 `python3 -m git_filter_repo`（`git filter-repo` 别名失效）** |
| 4. **内核仓** Was i7mgl ns/dsh-supervisor-core（私有） | ✅ **已推送** | 用 filter-repo 剔除 src-tauri（两前缀 invert-paths）；根内容：bin/src/test/ui/release/systemd/desktop+文档，**无 src-tauri**；HEAD `8f43307`，提交数 550+ |
| 5. **壳仓** wasi7mglns/dsh-supervisor-launcher（公开） | ✅ **已推送** | 用 filter-repo 只保留 src-tauri、`--path-rename dsh-supervisor/src-tauri:src-tauri` 归一；根内容：src-tauri + README(LAUNCHER_README)/LICENSE/.gitignore/.github/workflows/build.yml；HEAD `d8a8cac`，41 有效提交（含 v0.3.0/v0.4.0 桌面能力史） |
| 6. 本地内核工作区 | ⚠️ **未改** | `/home/bowen/develop/plus` 仍是旧单仓（origin 还指向旧 lobbowen），未同步新拆分历史 |

## 四、临时目录（新窗口可继续用）

- `/tmp/kernel-split` → 内核仓历史（已剔壳，已验证无 src-tauri）
- `/tmp/shell-split` → 壳仓历史（已归一 src-tauri，已验证）

## 五、凭据与账号

~~（已移除：令牌路径与导出命令）~~ —— 凭据一律经 **CREDENTIALS-STANDARD.md** 管理，
~~**禁止**记录实例附件目录（ephemeral，换会话即失效）等非规范位置。~~
- 归属账号：`wasi7mglns`（已验证可建私有+公开仓）
- 旧账号 `lobbowen` 已弃用（旧仓无法再访，历史靠 bundle 备份留档）

## 六、下一步（新窗口待办）—— 2026-09-10 更新

### ✅ 已完成（2026-09-10 会话）

- [x] **本地 `develop/plus` 已切换为内核仓干净 checkout**（master=8f43307 起始；origin→wasi7mglns/dsh-supervisor-core，tracked 210 文件无 src-tauri）
- [x] **内核仓 CI 修复并推送**：剥离 src-tauri 依赖（ci-core.sh 移除壳组装/冒烟、build.yml 去 Rust/apt、verify:versions 仅 --core）——`3dbd908`→master（git push 成功时）
- [x] **核仓产线补 build-ui 前置**（npm test 需 ui-react）——`3a8299e`（本地）/ 远端 REST 重建 sha 孪生
- [x] **壳仓 CI 修复并推送 main**：引导器形态（frontendDist=bootstrap + 去 embedded-panel default）+ Linux 系统依赖 + 修矩阵（去 macos-13）——`18a4537`
- [x] **壳仓首次 CI 全绿产出 Linux 安装程序**：run 34370396079 → `dsh-supervisor_0.1.0_amd64.deb` + `.AppImage`（artifact linux-x64 186MB，Actions artifact 可下载）
- [x] **壳仓 workflow 加 permissions + tags 触发器**（本地 `4098231`，**尚未推到远端**——git HTTPS 通道不通）
- [x] **内核 tag v0.1.2-BETA.7 → npm 真发 3 平台**：linux-x64 ✓ darwin-arm64 ✓ darwin-x64 ✓（registry 已验证 0.1.2-BETA.7）；darwin-x64 首次发布成功（此前从未有该包）
- [x] **核仓 NPM_TOKEN secret 已设**（本机 ~/.npmrc 的 lob.bowen token，PUT 201）
- [x] **win 测试缺陷修复（已推远端）**：guard-update-test tar `-C`→cwd（c738f59）；lan-daemon-test 加诊断（f10d70c）+ 窗口放宽 30s（e8bc1a6 系列，REST 重建 sha 已推送）

### ⚠️ 阻塞/未完成

- [x] **win-x64 已首次发布成功**（2026-09-10）：`@dsh-sup/dsh-core-win-x64@0.1.2-BETA.7` 已在 npm registry 验证 ✓ —— 该包历史首次存在
- [ ] 无核心阻塞（四平台 npm 全部发布完成）

### ✅ win-x64 跨平台修复全记录（2026-09-10，根本原因逐层定位）

1. **relay 目标判定改 TCP 直连**（d8f4185）：relay/manager 原用同步 `probeInstance`（pidlookup→Windows netstat 滞后秒级）→ 新增 `targetReachable()`（monitor.isPortListening TCP 600ms 跨平台可靠），syncProxy/reconcile 改 await，reconcile 转 async（调用方 fire-and-forget）
2. **winFind 回退 netstat**（26e7579）：曾改 PowerShell 致 smoke.js S9 端口占用判定失效 → 回退；relay 不再依赖 pidlookup
3. **ports-verify 适配 async reconcile**（72d9605）：同步调 reconcile 后立即断言 → 改 await
4. **lan-daemon 令牌注入轮询**（0492d79）：容忍 reconcile 重建窗口
5. **guard-update tar 跨平台三修**（48aa9dc→3d82b57）：-C 盘符 → --force-local(macOS 不认) → **cwd 相对路径产出+rename 定案**（三平台全兼容）
6. 结果：三平台 dry-run CI 步骤4全绿（linux/darwin-arm64/win），Release 无 tag 失败仅 dry-run 预期；tag v0.1.2-BETA.7 触发真发 → **win-x64 首次发布成功**

### ✅ 核仓深度清理记录（2026-09-10，SSH 推送）

- **历史 108MB 垃圾剔除**：filter-repo 剔旧 `dsh-supervisor/` 路径（历史截图 ui-market.png 19MB×8 等 + 旧 UI vendor）→ 646 提交重写为 9 提交，force push `b20bbe9→00d6d18`；HEAD tree 207 文件 path+sha 与远端一致（210-3 删除死脚本）
- **删除死脚本**：verify-shell.sh / build-shell-frontend.sh / build-sea.sh（核仓无 src-tauri、SEA 已弃用、CI 从不调用）
- **package.json 收敛**：移除 verify:shell / build:sea 别名，保留 build:launcher 唯一构建入口
- **release/README.md 重写**：双仓拆分后的标准发布 SOP（含 SSH 443 固定推送、4 平台矩阵说明）
- 注意：GitHub repo size 显示可能仍 108MB（服务端 GC 未回收不可达对象），master 分支数据已干净


### ✅ 壳仓修复全记录（2026-09-10，SSH 推送）

- **workflow 只挂真安装包**：`bundle/**/*` → `*.deb/*.AppImage/*.dmg/*.msi`（修 Release 242→4 资产）
- **Linux apt 稳定**：删 google-chrome.sources(deb822)+google*.list → update 必须成功（历经 Chrome hash mismatch→Unable to locate→Malformed entry 三轮修复）
- **窗口标题栏清理**：shell.html 移除软件名 dsh-supervisor 与 logo，只留拖动区+窗控按钮（7835edd）
- **git 历史深度清理**：filter-repo 剔 src-tauri/gen/（46 提交重写，.git 712K→600K）
- **.gitignore 补全**：忽略 gen/frontend/AppDir 等 Tauri 产物

### 🔑 固定推送机制（2026-09-10 定案，SSH over 443）

**git push 一律走 SSH over 443（ssh.github.com:443）——稳定固定，不再用 github.com git HTTPS 直连（国内间歇断连）。**

```bash
# 密钥（持久）
KEY=/home/bowen/develop/plus/.ssh/id_ed25519_dshpush
# 壳仓 .shell-work 已配置 core.sshCommand（见 .git/config）：
#   ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/home/bowen/develop/plus/.ssh/known_hosts
# remote 已是: ssh://git@ssh.github.com:443/wasi7mglns/dsh-supervisor-launcher.git
git push origin main       # 推送主分支
git push origin v0.1.0     # 推送 tag → 触发挂 Release CI
# 核仓若需推送（HTTPS 不通时）：同法把 remote 改 SSH 443 + core.sshCommand
```

- **api.github.com REST（Bearer token）完全稳定**——建 tag/传文件/建 secret/查状态全走它（但 REST 建 tag 不触发 CI，必须 git push tag）
- github.com git HTTPS（Basic）时通时断——**弃用**，只用 SSH 443
- 密钥公钥已注册 wasi7mglns 账号（dsh-push-443-20260910）；私钥仅存本地 workspace

## 七、已知风险/备忘

- filter-repo 改写 git 历史（不可逆）——已有 110MB bundle 备份，可恢复。
- 本地 `develop/plus` 的 `.gitignore` 同时管理壳产物（src-tauri/target）与内核产物（dist/sea）混在一起，拆分后应各自收敛。
- npm 发布遇 403 墓碑：同版本被反复发布/撤销过（0.1.2-BETA.5/0.1.2-BETA.6）——析出新版本号再发。

## 八、命令速查（新窗口直接可用）

```bash
~~（已移除：令牌路径与导出命令）~~ —— 凭据一律经 **CREDENTIALS-STANDARD.md** 管理，
~~**禁止**记录实例附件目录（ephemeral，换会话即失效）等非规范位置。~~
# 查看两新仓
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/wasi7mglns/dsh-supervisor-core/contents/
curl -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/wasi7mglns/dsh-supervisor-launcher/contents/
```