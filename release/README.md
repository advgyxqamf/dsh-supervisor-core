# release/ —— 发布工程（单一入口）

> 本目录是 **dsh-supervisor 内核发布自动化**的唯一事实源：构建、版本、发布、CI、验收流程全部收拢于此。
> 2026-09 双仓拆分定案：内核仓 `wasi7mglns/dsh-supervisor-core`（私有，本仓）只管内核 npm 子包；
> 壳仓 `wasi7mglns/dsh-supervisor-launcher`（公开 MIT）管桌面安装程序（见壳仓自身 workflow）。
> 命令**统一在仓库根执行**；所有脚本以仓库根为基准定位产物（绝对 ROOT 解析），可任意 cwd 调用。

## 目录结构

```
release/
├── README.md                  ← 本文件：唯一端到端 SOP（入口）
├── runbooks/                  ← 操作手册（已纳入 git 版本管理）
│   ├── publish-and-verify.md  ← 发布与验收：全流程 + 状态追踪
│   ├── verify-desktop.md      ← 桌面真机手工验收清单（GUI 场景）
│   └── credentials.md         ← 凭据/令牌管理（GitHub PAT + NPM token，值不入库）
└── scripts/                   ← 发布自动化脚本（唯一可执行集）
    ├── bump.sh                ← 版本提升（--core 内核单源；--shell 仅随壳仓流程使用）
    ├── build-ui.sh            ← 前端统一构建（ui/ → ui-react/ 镜像；npm test 与 launcher 携带依赖）
    ├── build-launcher.sh      ← 内核统一发布物（esbuild bundle core.cjs + node 启动脚本 + ui-react）
    ├── ci-core.sh             ← CI 发布产线核心逻辑（本地可复跑；.github/workflows 薄壳调用）
    ├── publish-core.sh        ← 内核 npm 平台子包发布（dry-run/--publish；self-check 版本核对）
    ├── export-shell.sh        ← 导出公开壳仓（壳仓更新桥；URL 缺省=仅组装 dist/export-shell/）
    ├── release.sh             ← 源码打包出口（tar.gz，非发布通道）
    ├── release-core.sh        ← 一键发布编排（dry-run / --publish 两档）
    ├── configure-credentials.sh ← 本机凭据安全配置（环境变量 → 0600 配置，值不入库）
    └── verify-versions.js     ← 版本自洽校验（内核 package.json 单源）
```

## npm 命令映射

| npm 命令 | 对应脚本 | 用途 |
|---|---|---|
| `npm run verify:versions` | verify-versions.js --core | 内核版本自洽校验 |
| `npm run build:launcher` | build-launcher.sh | 构建内核 launcher（唯一构建入口） |
| `npm run publish:core` | publish-core.sh | 内核子包发布（默认 dry-run） |
| `npm run publish:core -- --publish` | publish-core.sh | 真发布 |
| `npm run release:core` | release-core.sh | **一键编排 dry-run** |
| `npm run release:core:publish` | release-core.sh --publish | **一键编排真发** |
| `npm run export:shell` | export-shell.sh | 导出公开壳仓（壳更新桥） |
| `npm run release:guard` | release.sh | 源码打包 |

> 已移除：`build:sea` / `verify:shell`（2026-09 双仓拆分：SEA 形态全平台弃用 → launcher 形态；
> 壳冒烟归壳仓 CI，核仓无 src-tauri 故 verify-shell/build-shell-frontend 一并删除）。

## 版本规范

- **内核**：唯一事实源 = 根 `package.json`（`bump.sh --core`；tag `v<内核>` 触发 build.yml）。语义化版本 + 两档预览后缀：`-BETA.n` / `-RC.n` / 无后缀=正式。
- **壳**：独立于内核，版本在壳仓 `src-tauri/Cargo.toml` 与 `tauri.conf.json` 两处互锁（壳仓内 verify）。
- npm dist-tag：`-BETA.n` → `beta`；`-RC.n` → `rc`；正式 → `latest`（publish-core.sh 自动判定）。

## 端到端发布 SOP

### A. 内核发布（npm 子包 + GitHub Release）

```bash
# 1) 整理 CHANGELOG：[未发布] 段 → 新版本号段，并新开 [未发布]
# 2) 提升版本
bash release/scripts/bump.sh --core 0.1.2-BETA.7
# 3) 一键编排 dry-run（干净树预检 → verify --core → build-ui → npm test → build:launcher → 子包 dry-run）
npm run release:core
# 4) 真发（子包 --publish + commit + tag v<ver> + push --tags 触发 CI 全平台产线）
npm run release:core:publish
```

CI 产线（`.github/workflows/build.yml` → `release/scripts/ci-core.sh`）：4 平台矩阵（linux-x64 / win-x64 / darwin-arm64 / darwin-x64）各自 `verify --core → build-ui → npm test → build:launcher → 子包 dry-run`；**tag 触发 + 存有 NPM_TOKEN 时** `--publish` 真发并挂 GitHub Release。内核 launcher 为纯 JS（Node ≥18），无需 Rust/系统库。

### B. 壳发布（公开仓 dsh-supervisor-launcher）

壳仓独立运营：直接改壳仓 `src-tauri/` → push → tag `v<壳版本>` 触发 launcher-build.yml → 三平台 Tauri bundle（.deb/.AppImage/.dmg/.msi）挂壳仓 Release。核仓 `export-shell.sh` 仅作历史同步桥（一般不再用）。

### C. 验收

- 全量回归：`npm test`（mock 目标，不触碰真实 DSH/npm）。
- 发布状态追踪：`release/runbooks/publish-and-verify.md`。

## 推送通道（固定标准，2026-09-10 定案）

**所有 git push 走 SSH over 443（ssh.github.com:443）**——国内网络稳定，弃用 github.com git HTTPS 直连（间歇断连）。
核仓/壳仓本地 clone 均已配置 `core.sshCommand`（密钥 `/home/bowen/develop/plus/.ssh/id_ed25519_dshpush`）与
`remote = ssh://git@ssh.github.com:443/<owner>/<repo>.git`。REST api.github.com 稳定但**不能** push 分支/触发 tag CI。

## 凭据与令牌

发布链路需要的令牌**值不存仓库目录**，按 `release/runbooks/credentials.md` 管理。

| 令牌 | 消费方 | 最小权限 |
|---|---|---|
| GitHub PAT | REST 查状态/建 secret（不用于 git push） | wasi7mglns 账号 |
| SSH key | `git push`（SSH 443） | 账号级 key（已注册） |
| `GITHUB_TOKEN` | CI 挂 Release 附件 | Actions 自动注入（workflow 声明 contents: write） |
| NPM token | npm 真发子包 | `Automation`，仅 `@dsh-sup` scope（CI Secrets `NPM_TOKEN` / 本机 `~/.npmrc` 0600） |

scope 单源声明于 `package.json → npmPublish.scope = "@dsh-sup"`（`dsh-core-linux-x64` / `darwin-arm64` / `darwin-x64` / `win-x64`）。

## 关键约束

- **产物绝不上库**：`dist/`（launcher/npm/release）与 `ui-react/` 全部 gitignore，可随时重建。
- **版本单源**：构建/发布脚本不手写版本；从根 package.json 注入；launcher 自报版本 ≠ 单源 → 拒绝发布（publish-core.sh 强制）。
- **发布必须官方 registry**：npm publish 指向 registry.npmjs.org（token 经 ~/.npmrc 或 NPM_TOKEN）。
- **手册入库**：runbooks 随工程纳入 git 版本管理。
- **发布从干净树出发**：release-core.sh 预检 git status，脏树中止。
- **跨平台标准**：4 平台各自独立 job（fail-fast:false）；win 平台 lan-daemon 测试历史遗留问题见 runbooks 状态追踪。
