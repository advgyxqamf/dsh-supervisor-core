# release/ —— 发布工程（单一入口）

> 本目录是 **dsh-supervisor 内核/壳双轨发布自动化**的唯一事实源：构建、版本、发布、CI、验收流程全部收拢于此。
> 私有仓存内核（UNLICENSED 闭源构建物 + 源码）；公开 npm 发布内核 SEA 子包（热更新通道）；壳（MIT）导出公开仓引流。
> 命令**统一在仓库根执行**；所有脚本以仓库根为基准定位产物（绝对 ROOT 解析），可任意 cwd 调用。

## 目录结构

```
release/
├── README.md                  ← 本文件：唯一端到端 SOP（入口）
├── runbooks/                  ← 操作手册（已纳入 git 版本管理）
│   ├── publish-and-verify.md  ← 发布与验收：双轨全流程 + 状态追踪
│   ├── verify-desktop.md      ← 桌面真机手工验收清单（GUI 场景）
│   └── credentials.md         ← 凭据/令牌管理（GitHub PAT + NPM token，值不入库）
└── scripts/                   ← 发布自动化脚本（唯一可执行集）
    ├── bump.sh                ← 版本提升（--core 内核单源 / --shell 壳两处互锁）
    ├── build-ui.sh            ← 前端一源双出口统一构建（ui/ → ui-react/ 镜像）
    ├── build-shell-frontend.sh← 组装 Tauri 壳 frontend/（cargo build 前置）
    ├── build-sea.sh           ← 内核 SEA 构建物化（esbuild→V8 code cache→postject→冒烟）
    ├── publish-core.sh        ← 内核 npm 平台子包发布（dry-run/--publish；self-check 版本核对）
    ├── export-shell.sh        ← 导出公开壳仓 dsh-supervisor-launcher（MIT 引导器）
    ├── release.sh             ← 源码打包出口（tar.gz，非发布通道）
    ├── verify-versions.js     ← 版本自洽校验（内核单源 + 壳 Cargo/tauri 互锁）
    ├── verify-shell.sh        ← 壳无头冒烟（cargo build + --node-plan + npm test）
    ├── ci-core.sh             ← CI 发布产线核心逻辑（本地可复跑；.github/workflows 薄壳调用）
    ├── release-core.sh        ← 一键发布编排（dry-run / --publish 两档）
    └── configure-credentials.sh ← 本机凭据安全配置（环境变量 → 0600 配置，值不入库）
```

## npm 命令映射（package.json 已接线，命令名保持历史稳定）

| npm 命令 | 对应脚本 | 用途 |
|---|---|---|
| `npm run verify:versions` | verify-versions.js | 版本自洽校验 |
| `npm run build:sea` | build-sea.sh | 构建内核 SEA |
| `npm run publish:core` | publish-core.sh | 内核子包发布（默认 dry-run） |
| `npm run publish:core -- --publish` | publish-core.sh | 真发布 |
| `npm run release:core` | release-core.sh | **一键编排 dry-run** |
| `npm run release:core:publish` | release-core.sh --publish | **一键编排真发** |
| `npm run verify:shell` | verify-shell.sh | 壳无头冒烟 |
| `npm run export:shell` | export-shell.sh | 导出公开壳仓 |
| `npm run release:guard` | release.sh | 源码打包 |

## 版本规范（DESIGN §16）

- **内核**：唯一事实源 = 根 `package.json`（`bump.sh --core`；tag `v<内核>` 触发私有仓 build.yml）。语义化版本 + 两档预览后缀：`-BETA.n` / `-RC.n` / 无后缀=正式。
- **壳**：独立于内核（`bump.sh --shell`，0.1.0 起）；`Cargo.toml` 与 `tauri.conf.json` 两处互锁同号（verify-versions.js 强制）。
- npm dist-tag：`-BETA.n` → `beta`；`-RC.n` → `rc`；正式 → `latest`（publish-core.sh 自动判定）。

## 端到端发布 SOP

### A. 内核发布（私有仓，SEA + npm 子包 + GitHub Release）

```bash
# 1) 整理 CHANGELOG：[未发布] 段 → 新版本号段，并新开 [未发布]
# 2) 提升版本
bash release/scripts/bump.sh --core 0.1.2-BETA.6

# 3) 一键编排 dry-run（干净树预检 → verify → build:sea → 子包 dry-run → CHANGELOG 段检查）
npm run release:core

# 4) 真发（子包 --publish + commit + tag v<ver> + push --tags 触发 CI 全平台产线）
npm run release:core:publish
```

CI 产线（`.github/workflows/build.yml` → `release/scripts/ci-core.sh`）：4 平台矩阵（linux-x64 / win-x64 / darwin-arm64 / darwin-x64）各自 `verify:versions → 壳前端组装 → 壳冒烟 → npm test → build:sea → 子包 dry-run`；**tag 触发 + 存有 NPM_TOKEN 时** `--publish` 真发并挂 GitHub Release。

> 多平台真发注意：本机编排只发**当前平台**子包；其余平台由 CI 矩阵在各自 runner 补发（无交叉编译）。若离线无 CI，则在各平台机器执行 `bash release/scripts/ci-core.sh --publish`。

### B. 壳发布（公开仓 dsh-supervisor-launcher，MIT 引流）

```bash
# 1) 提升壳版本（Cargo.toml + tauri.conf.json 两处同号）
bash release/scripts/bump.sh --shell 0.1.1
# 2) 导出公开壳仓（URL 缺省=只组装 dist/export-shell/ 不推送）
bash release/scripts/export-shell.sh git@github.com:<you>/dsh-supervisor-launcher.git
# 3) 公开仓 commit + push；GitHub 上设 Public；tag v<壳版本> 触发 launcher-build.yml
#    → 三平台 Tauri bundle 挂公开仓 Release
```

### C. 验收

- 全量回归：`npm test`（mock 目标，不触碰真实 DSH/npm）。
- 壳无头冒烟：`npm run verify:shell`。
- 桌面真机：`release/runbooks/verify-desktop.md`（场景 A/B/C + 托盘交互）。
- 状态追踪：`release/runbooks/publish-and-verify.md`（剩余平台 dry-run/真发、公开仓 push、GUI 验收等未竟项）。

## 凭据与令牌（发布/多平台构建/热更新的认证前提）

发布链路需要的令牌**值不存仓库目录**，按 `release/runbooks/credentials.md` 管理。
本发布工程的最小权限形态：私有仓 `lobbowen/dsh-supervisor` + npm scope `@dsh-sup`（`dsh-core-*` 四平台子包）：

| 令牌 | 消费方 | 最小权限（值存放） |
|---|---|---|
| GitHub PAT | 本机 `git push` 私有仓 | 仅 `lobbowen/dsh-supervisor`，`Contents: Read/Write`（本机 credential helper，已从 remote 脱敏） |
| `GITHUB_TOKEN` | CI 挂 Release 附件 | Actions 自动注入，无需配置 |
| NPM token | npm 真发子包（CI 与 `--publish`） | `Automation`，仅 `@dsh-sup` scope `dsh-core-*` 发包（CI Secrets `NPM_TOKEN` / 本机 `~/.npmrc` 0600） |

scope 单源声明于 `package.json → npmPublish.scope = "@dsh-sup"`。
本机一键（`release:core:publish`）需要 git + npm 双侧认证；自检 `bash release/scripts/configure-credentials.sh --check`；
最小权限自查清单见 `release/runbooks/credentials.md`。

## 关键约束

- **产物绝不上库**：`dist/`（sea/npm/export-shell/release）与 `ui-react/`、`src-tauri/frontend`、`src-tauri/target` 全部 gitignore，可随时重建。
- **版本单源**：任何构建/发布脚本不手写版本；从根 package.json 注入；SEA 二进制自报版本 ≠ 单源 → 拒绝发布（publish-core.sh 强制）。
- **发布必须官方 registry**：npm publish 指向 registry.npmjs.org（token 经 ~/.npmrc 或 NPM_TOKEN）；镜像源只读消费。
- **手册入库**：runbooks 随工程纳入 git 版本管理（任何 clone 即有完整流程）。
- **发布从干净树出发**：release-core.sh 预检 git status，脏树中止。
