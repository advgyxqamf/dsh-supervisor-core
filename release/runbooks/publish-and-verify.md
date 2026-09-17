# 发布与验收：内核操作指南

> 本指南基于现行架构（Node launcher + 壳独立成仓）。旧架构（SEA 二进制 + `export-shell.sh` 导出壳仓）已废止：
> SEA 全平台弃用（macOS 上游缺陷）、壳已彻底独立成仓、`export-shell.sh` 已删。

## 仓库位置（两仓完全独立，不同账号）

| 仓 | 地址 | 可见性 | 内容 |
|---|---|---|---|
| **内核** | `advgyxqamf/dsh-supervisor-core` | 公开 | `bin/` `src/` `ui/` `test/` `release/` + 内核文档 |
| **桌面壳** | `wasi7mglns/dsh-supervisor-launcher` | 公开 | `src-tauri/`（Tauri 引导器，MIT）+ 壳文档与脚本 |

两仓**不共享目录**：壳的构建、签名、发布、测试全部由壳仓自持；
内核仓只保留对接代码（`src/domains/shell/`、`src/api/domains/shell.js`）。

## 内核发布：四平台全由 CI 产出（2026-09-13 硬标准）

```bash
# 一条命令走完：门禁 → 构建 → 派生 4 平台 → tag/push → 直推 npm
git push origin HEAD --tags   # 触发 CI 四平台构建+发布
```

**为什么一台 Linux 就能产出四平台**：launcher 是**纯 JS 产物**（内核运行时依赖为 0、
产物中 `.node` 文件为 0），平台差异**仅**体现在 npm 的 `os`/`cpu` 元数据与目录名。
同一 bundle 在 linux / win32 / darwin 三种覆盖下 sha256 完全一致（已逐一验证）。

**为什么必须走 CI**：可复现、可审计、单一入口。本地不得产生发布产物 ——
`publish-core.sh` / `ci-core.sh` 的任何 `--publish` 都要求 `GITHUB_ACTIONS=true`（本地 exit 2）。
（额度曾是历史动因；内核仓转公开后已免除。）

### 分步执行

```bash
# 1) 本地：提升版本（单源 = package.json.version，只允许递增）
bash release/scripts/bump.sh --core 0.1.5-BETA.1
#    然后整理 CHANGELOG.md：[未发布] → [0.1.5-BETA.1]

# 2) 本机不得执行 npm test；全量回归由 CI 的 test job 经 xvfb-run -a npm test 执行
#    （ci-core.sh 内含 npm test 与构建，同样只在 CI 内运行）

# 3) 推 tag：此后构建与发布全部在 CI 内
git push origin HEAD --tags
```

### 门禁内容（`ci-core.sh`）

```
verify:versions → build-ui（ui-react/ 为测试与产物依赖）→ npm test → build:launcher → 子包 dry-run
```

> ⚠ **`build-ui` 不可跳过**：`npm test` 中的面板响应头断言与 launcher 携带的 UI 均依赖
> `ui-react/`（gitignored 构建产物）。直接跑 `npm test` 会得到 503「UI not built」。

## release job 与 need_build

`precheck` 探测「该版本是否已在 npm 全部发布」，输出 `need_build`：
- **只作用于发布**（防 npm 同版本重发）；**不再跳过构建** —— 四平台完整构建每次 push / PR 都跑；
- tag 且 `need_build=true` 时 `release` job 汇总四平台产物并挂 GitHub Release。

## 壳的发布（在壳仓执行，本仓不参与）

```bash
cd <壳仓>
bash scripts/bump-shell.sh 1.0.5        # 三处互锁：Cargo.toml / tauri.conf.json / Cargo.lock
git commit && git tag v1.0.5 && git push origin main && git push origin v1.0.5
```

公开仓 tag 触发 `.github/workflows/build.yml` → 四平台 Tauri bundle 挂 GitHub Release + 发布 npm 壳包 + 生成
`shell-manifest.json`（Tauri updater 静态清单）。**壳仓是公开仓，Actions 额度不受限**。

## 桌面真机验收

按**壳仓** `docs/DESKTOP-ACCEPTANCE.md` 清单执行（该清单属壳资产，不在本仓）。核心链路：

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
| 稳定性 | CI 的 `npm test`（`test` job 经 `xvfb-run -a npm test`）全绿；零端口泄漏；测试端口不落在 OS 动态范围 |

## 状态追踪（2026-09-11）

- [x] **四平台全由 CI 产出**（2026-09-13 硬标准）：tag 触发 `build` 矩阵；本地不再有全平台构建/发布路径
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
- [x] 内核更新收敛为单写入者=桌面壳（2026-09-15）：内核写端点下架（410），壳 `kernel_update_apply` 为唯一安装路径；旧 manifest 引擎已删除
- [ ] Windows 真机验收（托盘右键 / 隐形边框 / 守卫拉起）
