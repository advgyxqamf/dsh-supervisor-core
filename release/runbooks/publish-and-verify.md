# 发布与验收：内核操作指南（2026-09-11 重写）

> **本文件已于 2026-09-11 重写**。原版基于「SEA 二进制 + export-shell.sh 导出壳仓」的旧架构，
> 该架构已废：SEA 全平台弃用（macOS 上游缺陷）、壳已彻底独立成仓、`export-shell.sh` 已删。

## 仓库位置（两仓完全独立，不同账号）

| 仓 | 地址 | 可见性 | 内容 |
|---|---|---|---|
| **内核** | `advgyxqamf/dsh-supervisor-core` | 🔒 私有 | `bin/` `src/` `ui/` `test/` `release/` + 内核文档 |
| **桌面壳** | `wasi7mglns/dsh-supervisor-launcher` | 🌐 公开 | `src-tauri/`（Tauri 引导器，MIT）+ 壳文档与脚本 |

两仓**不共享目录**：壳的构建、签名、发布、测试全部由壳仓自持；
内核仓只保留对接代码（`src/domains/shell/`、`src/api/shell.js`）。

## 内核发布：全平台本地构建（推荐，零 GitHub Actions 额度）

```bash
# 一条命令走完：门禁 → 构建 → 派生 4 平台 → tag/push → 直推 npm
npm run release:core:all:publish
```

**为什么一台 Linux 就能产出四平台**：launcher 是**纯 JS 产物**（内核运行时依赖为 0、
产物中 `.node` 文件为 0），平台差异**仅**体现在 npm 的 `os`/`cpu` 元数据与目录名。
同一 bundle 在 linux / win32 / darwin 三种覆盖下 sha256 完全一致（已逐一验证）。

**为什么不走 CI**：私有仓 Actions 按倍率计费（macOS 10x、Windows 2x），
本仓 mac/win 矩阵约 110 分钟/次，免费额度 2000 分钟/月仅够约 18 次 —— 曾实测耗尽。
本地全平台生产把额度消耗降为 0。

### 分步执行（如需手动控制）

```bash
# 1) 提升版本（单源 = package.json.version，只允许递增）
bash release/scripts/bump.sh --core 0.1.5-BETA.1
#    然后整理 CHANGELOG.md：[未发布] → [0.1.5-BETA.1]

# 2) dry-run（完整门禁 + 组装 + 打印计划，不 tag 不发布）
npm run release:core:all

# 3) 真发布（内部会 tag + push + 4 平台直推 npm）
npm run release:core:all:publish
```

### 门禁内容（`ci-core.sh`）

```
verify:versions → build-ui（ui-react/ 为测试与产物依赖）→ npm test → build:launcher → 子包 dry-run
```

> ⚠ **`build-ui` 不可跳过**：`npm test` 中的面板响应头断言与 launcher 携带的 UI 均依赖
> `ui-react/`（gitignored 构建产物）。直接跑 `npm test` 会得到 503「UI not built」。

## 兜底路径：CI 补平台（消耗额度）

tag 推送仍会触发 `.github/workflows/build.yml`。其 `precheck` 会先判断「该版本是否已在 npm 全部发布」：
- **已全部发布** → 跳过整个 mac/win 矩阵（约 1 分钟 ubuntu 探测，1x 计费）；
- **未全发布** → 由矩阵补齐 mac/win（macOS 按 10x 计费）。

因此无论走哪条路径，tag 都能收敛到「四平台齐备」。

## 壳的发布（在壳仓执行，本仓不参与）

```bash
cd <壳仓>
bash scripts/bump-shell.sh 1.0.5        # 三处互锁：Cargo.toml / tauri.conf.json / Cargo.lock
git commit && git tag v1.0.5 && git push origin main && git push origin v1.0.5
```

公开仓 tag 触发 `launcher-build.yml` → 四平台 Tauri bundle 挂 GitHub Release + 发布 npm 壳包 + 生成
`shell-manifest.json`（Tauri updater 静态清单）。**壳仓是公开仓，Actions 额度不受限**。

## 桌面真机验收

按 `release/runbooks/verify-desktop.md` 清单执行。核心链路（对应壳 1.0.4 的服务定义修复）：

| 场景 | 通过标志 |
|---|---|
| 全新环境无 Node | 壳引导页 → 自动装 Node → 自动拉起守卫 → 面板 200 |
| 守卫服务定义 | 首启后 `systemctl --user status dsh-supervisor` 存在且 enabled（macOS/Windows 对应 launchd/schtasks） |
| 自更新 | 壳检测到新版本 → 下载 → 验签 → 安装 → 重启 |
| 托盘/关窗/设置页 | 交互正常；Windows 无隐形边框、托盘右键可用 |

无 GUI 自检入口（诊断用，任何平台）：

```bash
dsh-supervisor-gui --service-plan                # 只报告服务定义状态
dsh-supervisor-gui --service-plan --service-apply # 实际建立服务定义
```

## 验收退出标准

| 项 | 通过标志 |
|---|---|
| 内核 | 四平台 `core.cjs` 同源（sha256 一致）；npm 子包安装后 `dsh-supervisor self-check` OK |
| 壳 | 四平台可构建；无 Node 环境引导闭环；服务定义能建立（P0） |
| Node | 多镜像并行测速选最快，SHA256 校验，最低门槛 v22.12 生效 |
| 自更新 | 壳自更新：检测 → 下载 → minisign 验签 → 安装 → 重启 |
| 稳定性 | `npm test` 全绿；零端口泄漏；测试端口不落在 OS 动态范围 |

## 状态追踪（2026-09-11）

- [x] **全平台本地生产落地**：`release:core:all:publish` 零 GitHub 额度；四平台 `core.cjs` 同源验证
- [x] **双仓彻底隔离**：壳资产全部移出本仓（含 `export-shell.sh`、`shell-release/`、壳设计文档、
      `bump.sh --shell`、跨仓测试断言）；壳 checkout 已移出本仓目录
- [x] **版本管理规范**：内核单源 `package.json.version`；壳版本由壳仓 `bump-shell.sh` 三处互锁
- [x] **凭据管理**：令牌不入库（CI Secrets + 本机 0600）；scope 单源 `@dsh-sup`；
      推送改用**仓库部署密钥**（fine-grained PAT 无法管理账号级 SSH key）
- [x] **测试端口纪律**：安全段 28000-28999 + 门禁（防落 OS 动态端口范围）
- [x] **工作流解析行尾归一化**：修复 Windows CRLF 导致的 CI 假失败 + 门禁
- [x] **npm 认证大小写修复**：`NPM_CONFIG_USERCONFIG` 与 `npm_config_userconfig` 双写
- [x] 已发布：`@dsh-sup/dsh-core-{linux-x64,darwin-arm64,darwin-x64,win-x64}@0.1.4-BETA.1`
- [ ] **`v0.1.4-BETA.1` 的 CI 红叉**：Windows job 因 CRLF 假失败（已修，见 CHANGELOG [未发布]）；
      修复在 `master` 上，下次发版自然验证
- [ ] **用户侧人工项**：删除 `wasi7mglns` 账号中已泄露的 SSH 公钥 `dsh-push-443-20260910`；
      吊销两把已泄露的 PAT
- [ ] self-update 引擎接 npm 通道（用户：先不急）
- [ ] Windows 真机验收（托盘右键 / 隐形边框 / 守卫拉起）
