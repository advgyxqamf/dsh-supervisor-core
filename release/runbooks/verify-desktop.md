# 桌面实机验收（Phase 1/2 手工清单）

> 前置：Linux（本仓库可验证）；macOS / Windows 需要对应平台构建（见 §5）。

## 1. 构建产物
```bash
# 壳（不内置 Node）
cargo build --manifest-path src-tauri/Cargo.toml --release
# 安装包（Linux deb；macOS dmg / Windows msi 在对应平台同命令）
npx @tauri-apps/cli@2 build
# 守卫源码打包出口（D1 定案：非自更新通道；内核发布走 build:sea + publish:core）
npm run release:guard
```

## 2. 场景 A：全新环境（无 Node.js）
1. 安装产物（Linux：`sudo dpkg -i dist/*.deb`，随后 `dsh-supervisor-gui` 启动壳）；
2. 预期：壳窗口出现**引导页**「检测到缺少 Node.js · 官方最新 LTS <v>」+「一键安装 Node.js LTS」按钮（无 Node 也能跑，证明不携带运行时）；
3. 点「一键安装」→ 弹出一次系统授权（pkexec/msiexec/installer）→ 进度条/日志 → Node 装好；
4. 预期：自动拉起守卫 → 窗口切到面板 `127.0.0.1:3100`；任意终端 `node --version` 为最新 LTS；
5. 面板「设置 → 环境与自更新」卡：Node（系统+运行时）、npm、DSH 状态、守卫自更新（未配置源 → 明确提示）。

## 3. 场景 B：已有旧版 Node
1. 预期：壳直接进面板（不弹引导页）；
2. `/env/status`：`node.detected` 为旧版；若低于官方最新 LTS，面板给出升级入口（当前：引导页仅出现于缺失态；升级 Node 走官方安装器手动或后续接入——记录为已知缺口）。

## 4. 场景 C：守卫自更新（manifest 通道已按 D1 定案废除；本段仅为底层执行器回归验证保留）

> D1（2026-09 定案）：release.sh 不再产出 manifest，守卫自更新统一走 npm 平台子包
> （DistributionManager 执行器）。self-update.js（tar 解包/校验/翻转）仍保留并被
> guard-update-test 全量覆盖——下述自更新端点/配置项仅作底层能力验证，非发布通道。
```bash
# 本地源（无外网发布也能验收）：
python3 -m http.server 39240 --directory dist/release &
# 配置 selfUpdateManifestUrl/Dir 后：
curl -s http://127.0.0.1:3100/self-update/status   # 可更新标志
curl -s -X POST http://127.0.0.1:3100/self-update/apply
ls -l ~/.dsh/supervisor/guard/current              # 版本目录翻转
curl -s -X POST http://127.0.0.1:3100/self-update/restart-guard  # 需 guardRestartAllowed=true 才自重启
```
预期：`current` 指向新版本目录、旧版本保留（回滚）、篡改 sha256 被拒。

## 5. 构建矩阵
| 平台 | 命令（对应平台执行） | 产物 |
|---|---|---|
| Linux | `npx @tauri-apps/cli@2 build` | deb + AppImage |
| macOS | 同上 | dmg |
| Windows | 同上 | msi |

Node 安装矩阵（壳内实现）：Windows `msiexec /qn`（UAC）/ macOS `installer -pkg`（管理员）/ Linux `pkexec tar到/usr/local`（官方 tar.xz + SHASUMS256 校验）。

## 6. 已知缺口（验收记录用）
- ✅（已实现）Node 已装但低于最新 LTS：引导页显示「升级到官方最新 LTS」+「跳过并使用现有版本」；
- 守卫自更新后 `guardRestartAllowed` 默认关（防误杀），生产发行版由安装器配置打开；
- GUI 真机手动项（引导页交互/托盘/关窗隐藏）需桌面环境逐个核对；
- AppImage 打包需可达 GitHub 下载 extern 工具（本环境超时；deb 已产出）。