# release/ —— 发布工程（单一入口）

> 本目录是 **dsh-supervisor 内核发布自动化**的唯一事实源：构建、版本、发布、CI、验收流程全部收拢于此。
> 双仓：内核仓 **`advgyxqamf/dsh-supervisor-core`**（私有，本仓）只管内核 npm 子包；
> 壳仓 `wasi7mglns/dsh-supervisor-launcher`（公开 MIT）管桌面安装程序（见壳仓自身 workflow）。
> （2026-09-11：内核仓由 `wasi7mglns` 迁至 `advgyxqamf` —— 原账号私有仓 Actions 额度耗尽；
>   迁移动机与事故处置见 `CHANGELOG.md` 的「仓库迁移至新账号」一节。）
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
    ├── _npm-auth.sh           ← npm 认证解析共享库（**单源**；publish-core/configure-credentials 共用）
    ├── ci-core.sh             ← 发布产线核心逻辑（**单源**：CI 与本地 Linux 生产都跑它）
    ├── publish-core.sh        ← 内核 npm 平台子包发布（dry-run/--publish；self-check 版本核对）
    ├── export-shell.sh        ← 导出公开壳仓（壳仓更新桥；URL 缺省=仅组装 dist/export-shell/）
    ├── release.sh             ← 源码打包出口（tar.gz，非发布通道）
    ├── release-core.sh        ← 一键发布编排（薄编排：委托 ci-core.sh + 平台闸/预检/tag 时序）
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
# 3) 一键编排 dry-run（干净树+CHANGELOG 预检 → 委托 ci-core.sh 全部门禁 → 打印发布计划）
npm run release:core
# 4) 真发（commit + tag v<ver> + push --tags 触发 mac/win CI；随后本机发 linux 子包）
npm run release:core:publish
```

### 平台分工（2026-09 定案：GitHub 额度优化）

| 平台 | 生产位置 | 子包 |
|---|---|---|
| **linux-x64** | **本地 Linux 机器**（release:core:publish） | @dsh-sup/dsh-core-linux-x64 |
| win-x64 | GitHub CI（tag 触发 build.yml 矩阵） | @dsh-sup/dsh-core-win-x64 |
| darwin-arm64 | GitHub CI | @dsh-sup/dsh-core-darwin-arm64 |
| darwin-x64 | GitHub CI | @dsh-sup/dsh-core-darwin-x64 |

**Linux 不经 GitHub**：本地跑完整门禁后直推 npm，省 Actions 额度。因此 .github/workflows/build.yml
的矩阵**只含 mac/win 三平台**，且原常驻 ubuntu-latest 的前端门禁作业（ui-verify）已并入本地
release-core.sh（每次发布都会跑，不会漏跑）。Linux 的 launcher 构建物**不再挂 GitHub Release**
（npm 即其分发通道）。

**真发布有平台闸**：release-core.sh --publish 在非 Linux 机器上直接拒绝（exit 2）并提示走 tag 触发 CI，
避免与 CI 形成同平台二次发布（npm 同版本不可重发）。

CI 产线（.github/workflows/build.yml → release/scripts/ci-core.sh）：mac/win 三平台各自
`verify --core → build-ui → npm test → build:launcher → 子包 dry-run`；**tag 触发 + 存有 NPM_TOKEN 时**
`--publish` 真发并挂 GitHub Release。内核 launcher 为纯 JS（Node ≥18），无需 Rust/系统库。

### B. 壳发布（公开仓 dsh-supervisor-launcher）

壳仓独立运营：直接改壳仓 `src-tauri/` → push → tag `v<壳版本>` 触发 launcher-build.yml → 三平台 Tauri bundle（.deb/.AppImage/.dmg/.msi）挂壳仓 Release。核仓 `export-shell.sh` 仅作历史同步桥（一般不再用）。

### C. 验收

- 全量回归：`npm test`（mock 目标，不触碰真实 DSH/npm）。
- 发布状态追踪：`release/runbooks/publish-and-verify.md`。

## 推送通道（固定标准，2026-09-10 定案）

**所有 git push 走 SSH over 443（ssh.github.com:443）**——国内网络稳定，弃用 github.com git HTTPS 直连（间歇断连）。
核仓/壳仓本地 clone 均已配置 `core.sshCommand`（密钥 `/home/bowen/develop/plus/.ssh/id_ed25519_dshpush`）与
`remote = ssh://git@ssh.github.com:443/<owner>/<repo>.git`。REST api.github.com 稳定但**不能** push 分支/触发 tag CI。

## 凭据与令牌（**认证单源**，2026-09-10 标准化）

发布链路需要的令牌**值不存仓库目录**，按 `release/runbooks/credentials.md` 管理。

| 令牌 | 消费方 | 最小权限 |
|---|---|---|
| GitHub PAT | REST 查状态/建 secret/管部署密钥（不用于 git push） | `advgyxqamf` 账号（内核仓）；壳仓用 `wasi7mglns` PAT |
| SSH key | `git push`（SSH 443，**repo-local `core.sshCommand`**） | **仓库级部署密钥**（非账号级）：内核仓 `~/.ssh/id_ed25519_advgyxqamf`、壳仓 `~/.ssh/id_ed25519_wasi7` |
| `GITHUB_TOKEN` | CI 挂 Release 附件 | Actions 自动注入（workflow 声明 contents: write） |
| NPM token | npm 真发子包（CI 发 mac/win；本机发 linux） | `Automation`，仅 `@dsh-sup` scope |

### npm 认证解析（唯一顺序，`release/scripts/_npm-auth.sh` 单源实现）

`publish-core.sh`（读）与 `configure-credentials.sh`（写/自检）**共用同一份解析器**，优先级：

1. `DSH_NPMRC` — 显式指定 npmrc 文件（测试/特殊部署）
2. `NPM_CONFIG_USERCONFIG` — npm 原生标准；已设且文件存在则尊重，不干预
3. `NPM_TOKEN` / `NODE_AUTH_TOKEN` — 写**临时 userconfig**（0600，进程退出即删，不落盘）
4. **真实用户 home** 下的 `~/.npmrc` — **规范位置**（`configure-credentials.sh --npm` 写入于此）
5. `$HOME/.npmrc` — 兜底（沙箱内可能存在的旧副本）

> **为什么要「真实 home」**：DSH 沙箱会把 `$HOME` 指向实例数据目录
> （`~/.dsh/supervisor/instances/<id>/data`）。若认证只看 `$HOME`，同一台机器上会出现
> 「A 沙箱能发版、B 沙箱报 `ENEEDAUTH`」——这是此前的真实故障（token 曾散落在某个实例 home 下）。
> 解析器用 `getent passwd` / `dscl` / `~user` 展开定位真实 home，**不受 `$HOME` 覆盖影响**。

**发布脚本绝不执行 `npm config set`**（既不永久改开发机 registry，也不把 token 明文写入 `~/.npmrc`）。

```bash
# 规范配置（一次性；写入真实 home/.npmrc 0600）
export NPM_TOKEN='<npm automation token>'
bash release/scripts/configure-credentials.sh --npm
# 自检（只读，不含值；与发布用同一解析器判定，不会出现「自检说没配、发布却成功」）
bash release/scripts/configure-credentials.sh --check
```

scope 单源声明于 `package.json → npmPublish.scope = "@dsh-sup"`（`dsh-core-linux-x64` / `darwin-arm64` / `darwin-x64` / `win-x64`）。

## 关键约束

- **产物绝不上库**：`dist/`（launcher/npm/release）与 `ui-react/` 全部 gitignore，可随时重建。
- **版本单源**：构建/发布脚本不手写版本；从根 package.json 注入；launcher 自报版本 ≠ 单源 → 拒绝发布（publish-core.sh 强制）。
- **发布必须官方 registry**：npm publish 指向 registry.npmjs.org。
- **认证单源**：解析逻辑仅在 `release/scripts/_npm-auth.sh` 一份（`publish-core.sh` 与
  `configure-credentials.sh` 共用）；规范位置 = **真实 home** 的 `~/.npmrc`，详见「凭据与令牌」节。
  发布脚本**绝不**执行 `npm config set`（不改开发机全局 registry、不把 token 明文写入 `~/.npmrc`）。
- **手册入库**：runbooks 随工程纳入 git 版本管理。
- **发布从干净树出发**：release-core.sh 预检 git status，脏树中止。
- **跨平台标准**：发布平台各自独立——mac/win 为 CI 独立 job（fail-fast:false），linux 为本地编排单跑。
