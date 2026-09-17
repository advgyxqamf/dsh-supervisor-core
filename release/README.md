# release/ —— 发布工程（单一入口）

> **流程以 `RELEASE-STANDARD.md` 为准。**
> 本文件只讲发布工程的目录结构与脚本索引，**不再重复流程细节**（此前同一事实散落 5–8 处 → 已多次漂移）。


> 本目录是 **dsh-supervisor 内核发布自动化**的唯一事实源：构建、版本、发布、CI、验收流程全部收拢于此。
> 双仓：内核仓 **`advgyxqamf/dsh-supervisor-core`**（**公开**，本仓）只管内核 npm 子包；
> 壳仓 `wasi7mglns/dsh-supervisor-launcher`（**公开** MIT）管桌面安装程序（见壳仓自身 workflow）。
> （2026-09-11：内核仓由 `wasi7mglns` 迁至 `advgyxqamf` —— 原账号私有仓 Actions 额度耗尽；
>   迁移动机与事故处置见 `CHANGELOG.md` 的「仓库迁移至新账号」一节。
>   **2026-09-13：内核仓转为公开** —— 公开仓 Actions 免额度（含 macOS），原「私有仓倍数计费」
>   约束随之解除；本文中以额度为动因的段落已改写。转公开前已做安全审计：
>   工作树与全历史均无密钥模式命中，仓库 14M、最大跟踪文件 212K。）
> 命令**统一在仓库根执行**；所有脚本以仓库根为基准定位产物（绝对 ROOT 解析），可任意 cwd 调用。

---

## 0. 两仓构建决策（**为什么必须分两个仓**）

这不是历史包袱，是**刻意的架构决策**，后期多项决策都依赖它：

| | 内核仓 `dsh-supervisor-core` | 壳仓 `dsh-supervisor-launcher` |
|---|---|---|
| 职责 | 产品逻辑 + 守护：API/路由/relay/实例/插件/端口/更新编排 | **仅**桌面体验：引导页、托盘、安装程序、原生能力（systemd/launchctl/schtasks） |
| 技术栈 | JS（CommonJS），运行时依赖 **0**、原生扩展 **0** | Rust（Tauri 2）+ TS/React 前端 |
| 产物 | npm 平台子包 `@dsh-sup/dsh-core-{linux-x64,darwin-arm64,darwin-x64,win-x64}` | 安装程序 `deb/rpm`、`dmg/app`、`msi/nsis` + 壳 npm 包 `@dsh-sup/shell-*` |
| 分发通道 | **npm registry** | **GitHub Release**（安装包）+ npm（自更新产物） |
| 节奏 | **高频**（小步快跑，可单独 hotfix） | **低频**（安装程序，用户不常更新） |
| 构建负担 | 轻（纯 JS，一次构建派生四平台） | 重（Rust 编译 + 各平台系统库） |
| 门禁侧重 | 行为/契约/跨进程 | 平台分支编译 + 引导流程 + 签名/清单 |

**分离带来的四个具体好处**（也是「不合并」的理由）：
1. **更新节奏解耦**：内核可单独热修，不必为改一行逻辑重发一遍安装程序。
2. **用户更新成本**：内核走 npm 子包（小、增量、可静默）；壳走安装程序（大、需重启）。
3. **构建负担隔离**：壳的 Rust/Tauri 依赖不会拖累内核「零依赖纯 JS」这一特性。
4. **为后期决策留空间**：两仓可独立决定开源策略、发布节奏、乃至商业形态。

**代价与对策**：两仓**不共享代码**，契约只能靠**文件**传递 —— 见 §0.1。

### 0.1 跨仓契约（唯一的耦合面）

| 文件 | 方向 | 内容 |
|---|---|---|
| `registry.json` | 壳 → 内核 | 镜像源偏好与测速结果（内核「优先采用壳投放的 selected」） |
| `identity.json` | 壳写 | 壳自身身份（`version`/`phase`/`exe`/`lastSeenAt` 等运行时字段）；护栏/回退字段已废除 |
| `update-journal.json` | 内核写 | 壳更新账本（`to`/`confirmed`）；强制更新，**不含回退/拉黑** |

**约束**：契约字段的**新增**必须向后兼容（读方在字段缺失时降级）；
契约字段的**移除或语义变更**必须**内核先行**，并允许两侧版本错配运行一个发布周期。

### 0.2 跨仓发布时序（规范）

```text
1) 内核发布（先）
     · 新增/变更契约字段 → 内核先发（读方降级兼容）
     · 验收：npm 四平台子包齐备 + GitHub Release 附件
2) 壳发布（后）
     · 依赖内核契约的壳改动，至少在「内核那一版已发布」之后再发
     · 验收：四平台安装包 + shell-manifest + 验签
3) 交叉验证
     · 「壳=最新、内核=上一版」跑一遍引导（验证降级路径）
     · 「壳=上一版、内核=最新」跑一遍引导（验证向后兼容）
```

---

## 0.3 跨平台架构规范（**工业标准 · 唯一合法做法**）

> 本节回答一个明确要求：**「后续开发不会再因为内部业务逻辑开发而影响跨平台构建能力」**。
> 办法不是靠自觉，而是**把平台知识收口到一处 + 用门禁锁住边界**。

> **开发流程（改代码前必读）**：`DEVELOPMENT-TRACK.md` —— 分层定位、平台事实入口、
> 跨层依赖登记、测试补齐、注入验证标准、假绿形态清单。

### 铁律一：平台知识只允许存在于 `src/platform/**`

`process.platform` / `process.arch` / `os.platform()` / `os.arch()`
**只允许出现在 `src/platform/**`**。业务域（`domains/`、`app/`、`api/` …）必须经：

| 需求 | 唯一入口 |
|---|---|
| 取平台事实（platform/arch/osTag）| `src/platform/contract/matrix.js` 的 `current()` / `osTag()` |
| 取 npm / 产物标签 | `src/platform/contract/matrix.js` 的 `npmTag()` |
| 取 FRP 官方产物标签 | `src/platform/contract/matrix.js` 的 `frpTag()` |
| 判断平台能力（如进程组语义）| `src/platform/contract/matrix.js` 的 `supportsProcessGroup()`，或 `platform/os/index.js` 的 `capabilities()` |
| 需要平台专属行为 | `src/platform/os/*` 的 Provider（`service` / `desktop` / `pidlookup` …）|

**为什么**（本仓付出过的代价）：os/arch→标签 这一事实曾散落 **5 份**
（`frpmgr.js` / `dist/index.js` / `settings-view.js` / `plugins.js` / `platform/os/*`）。
多份副本必然漂移；更关键的是——**业务域持有的平台知识在非本平台上不会被校验**，
一旦写错，只有在对应平台的构建/运行中才暴露。

### 铁律二：禁止在业务域写 os/arch 映射表

禁止（历史形态，已清除）：

```js
const osMap = { darwin: 'darwin', win32: 'win', linux: 'linux' };
const os = osMap[process.platform];
if (process.platform !== 'win32') { /* POSIX 进程组 */ }
```

正确：

```js
const matrix = require('../../platform/contract/matrix');
const os = matrix.osTag();
if (matrix.supportsProcessGroup()) { /* POSIX 进程组 */ }
```

### 铁律三：新增平台支持 = 固定四步（不得跳步）

| 步 | 动作 | 由哪道门禁守 |
|---|---|---|
| 1 | 在 `package.json#npmPublish.packages` 声明子包 | `platform-matrix-single-source-test` M-a |
| 2 | 在 `src/platform/contract/matrix.js` 的 `SUPPORTED` 加入该组合 | 同上 M-a / M-b |
| 3 | 在 `src/platform/os/*` 补该平台 Provider 分支（`capabilityProfile` 显式档位）| `cross-platform-architecture-gate-test` CP-3 |
| 4 | 在 `.github/workflows/build.yml` 的 build 矩阵加入 runner | `release-auth-test` R6-a2 |

### 守住边界的六道门禁（**均已注入验证**）

| 门禁 | 守什么 |
|---|---|
| `test/platform-matrix-single-source-test.js`（17 断言）| 矩阵与发布清单**逐项一致**；`src/` 中**除 matrix.js 外无第二份 os/arch 映射表**；标签取值正确（含 FRP 的第三方命名 `windows_amd64` ≠ npm 的 `win-x64`）|
| `test/cross-platform-architecture-gate-test.js`（11 断言）| **平台事实只在 `src/platform/**`**；业务域无映射表；三平台档位齐备且与矩阵同集合；`engines.node` 单一声明 |
| `test/four-platform-behavior-matrix-test.js`（43 断言）| **四平台逻辑一次穷举**（在 Linux 上）：标签映射 / 能力档位 / 模板替换 / 运行时与矩阵同源；**能力字段集合四平台必须一致**（防「新增能力只加一个平台」）|
| `test/platform-layer-portability-test.js`（41 断言）| **平台层模块**的平台行为穷举：exec-path 的候选名/标准目录/`npm.cmd` 解析（P1-C 复现）、service 的四 provider 方法集一致与显式抛错、autostart 的 `status().kind` 与能力档位**表达同一事实** |
| `test/platform-parsers-and-commands-test.js`（38 断言）| **平台输出解析 + 命令构造**穷举：netstat/lsof/ss/`/proc/net/tcp` 解析（端口整段匹配、CRLF、0A 状态）、**P1-2 锚点**（wmic 空输出必须回退 CIM）、notify 的**按平台转义规则**（AppleScript 反斜杠 / PowerShell 双写）、desktop 会话判定与 `sessionAvailable()` **同源** |
| `test/test-chain-completeness-test.js`（10 断言）| `test/*-test.js` **要么在链中、要么在显式排除表里写理由** —— 消灭「新增门禁静默不进 CI」|

> **诚实边界**：这六道门禁证明的是**逻辑**（映射 / 档位 / 模板 / 同源），**不能**证明**平台原生行为**
> （真能跑 systemd/launchctl/schtasks、真能 spawn Windows 可执行、真能出 MSI）——后者仍必须由**真实四平台 CI 构建**裁决。两者互补，不可互相替代。
>
> 六道门禁都有**反向断言**（判据必须能识别违规形态），并已用真实注入验证：
> 业务域写回 `process.platform` → CP-1 失败；写回 os 映射表 → M-c / CP-2 失败；
> 新增一个不在链中的测试 → N-a 失败；矩阵与发布清单不一致 → M-a 失败；
> 删掉某平台的 shellSelfHeal 声明 → P-4/P-5 失败；标签写错 → P-1/P-6/P-7 全链路失败；
> 还原 exec-path 的「不传播 platform」→ X-2 五条失败；移除 autostart 未知平台守卫 → X-4 两条失败。
> 把 PowerShell 转义退回 JSON 规则 → Y-3/Y-5 四条失败；wmic 空输出误判为有值 → Y-2 两条失败。

### 为什么这能「防止业务开发破坏跨平台构建」

1. **知识单源** → 平台事实不存在「改一处忘了另一处」的漂移空间。
2. **边界由门禁强制** → 业务域一旦越界，CI 的 `npm test`（`test` job，ubuntu-latest）立刻失败，
   不必等到 mac/win runner 才发现。
3. **新增测试自动有归属** → 不会出现「写了门禁但没接进 CI」。
4. **新增平台是清单化流程** → 四步各有门禁，跳步即失败。
### 两仓对称：壳仓的等价门禁

同一套纪律在壳仓由既有门禁承担（**不必新增**）：

| 壳仓门禁 | 对应内核侧铁律 |
|---|---|
| `bootstrap_flow.rs` **G1-a**：平台分支（`#[cfg(target_os)]`）只出现在 `platform/` 内 | 铁律一（平台知识只在 `src/platform/**`）|
| `bootstrap_flow.rs` **G2**：`commands/` 只做校验与委托，不得直接执行外部命令/不得有平台分支 | 铁律二（业务域不得持平台知识）|
| `bootstrap_flow.rs` **G3**：`main.rs` 只做组装（行数上限 550、零 IPC 命令） | 分层纪律 |
| `platform_shared_items_test.rs` | 平台文件必须导入所用共享项（E0425 防线）|
| `ci_gate_coverage_test.rs` C-a/C-b + CI `ls tests/*.rs` 自动枚举 | 内核 `test-chain-completeness-test` **N-a**（同一目标）|

> 即：**两仓各有一套「边界门禁」，目标一致、实现按各自语言惯例**
> （内核用 JS 静态扫描 + 行为断言；壳仓用 Rust 结构断言 + 真实平台编译）。

---

## 1. 产线现状（2026-09-14，硬标准）

### 1.1 构建与发布一律在 CI

- **四平台完整构建**：`.github/workflows/build.yml` 的 `build` job，4 runner 矩阵
  （`ubuntu-22.04` / `windows-latest` / `macos-latest` / `macos-14`），各 runner 只构建**自己**的平台；
  `build` **不受 `need_build` 门控**（2026-09-14 硬标准）—— 每次 push / PR 都跑。
- **验证内容**：`ci-core.sh` 内 `verify:versions` → 前端 `verify` → `npm test` → `build:launcher` →
  子包组装 + `npm publish --dry-run`；构建期断言四平台 `core.cjs` 逐字节一致，并做
  self-check + fresh-HOME daemon 自举 + UI 服务端到端冒烟。
- **发布**：tag `v*` + 有 `NPM_TOKEN` + `need_build=true` 时，各平台 runner 执行
  `ci-core.sh --publish`。`need_build`（`precheck` 探测「四平台是否已全部发布」）**只作用于发布**，
  用于防同版本重发（npm 409）；它**不再跳过构建**。
- **本地**：只允许 S0–S3（凭据 / 版本 / 前端产物前置）与 `--dry-run`；**S4 全量回归起一律由 CI 执行**（本机不得执行 `npm test`）；任何真发布都要求 `GITHUB_ACTIONS=true`（见「内核构建模式」）。

> 产线结论看 GitHub Actions 的 run 列表即可 —— 文档不再固化 run 号（必然漂移）。

### 1.2 推送即回归（push master）

`test` job 在每次 push 时运行，且已修正三处「从未真正执行」的问题：

| 修复 | 原因 |
|---|---|
| 先 `build-ui.sh` 再 `npm test` | `core-test` 的面板 CSP / nosniff 断言需要**构建产物**，否则 503 → 2 条失败 |
| `xvfb-run -a npm test` | 看护 E2E 需要**图形会话**；无头 runner 里看护按设计拒绝拉起 GUI 壳 |
| **内核仓不再检出/读取壳仓源码** | 两仓按账号/仓库隔离；跨语言契约只经「已发布产物 / schema / 测试向量」消费，由 `test/no-cross-repo-test.js` 锁定 |

> 曾经的 `test/_shell-repo.js` / `DSH_SHELL_REPO` / 壳仓 checkout 已整体删除：
> 它把「跨语言行为一致性」错误实现成了「跨仓库源码读取」，会让内核 CI 读壳仓 `main`
> 的浮动版本 → **本地绿、CI 红**，且两仓隔离被穿透。

---

## 目录结构

```
release/
├── README.md                  ← 本文件：唯一端到端 SOP（入口）
├── runbooks/                  ← 操作手册（已纳入 git 版本管理）
│   └── publish-and-verify.md  ← 发布与验收：全流程 + 状态追踪（**runbooks/ 下唯一一份**）
│       （凭据 runbook 见根目录 CREDENTIALS-STANDARD.md；桌面壳的签名密钥手册与 GUI 验收清单
│        属壳仓资产，见壳仓 docs/UPDATER-SIGNING-KEY.md、docs/DESKTOP-ACCEPTANCE.md）
└── scripts/                   ← 发布自动化脚本（唯一可执行集）
    ├── bump.sh                ← 版本提升（**--core 内核单源**；壳版本提升见壳仓 scripts/bump-shell.sh）
    ├── build-ui.sh            ← 前端统一构建（ui/ → ui-react/ 镜像；npm test 与 launcher 携带依赖）
    ├── build-launcher.sh      ← 内核统一发布物（esbuild bundle core.cjs + node 启动脚本 + ui-react）
    │                             `--all-platforms` 仅 CI 内放行（本地 exit 2）
    ├── _platforms.sh          ← 平台矩阵**单一事实源**（读取 package.json#npmPublish.packages）
    ├── _npm-auth.sh           ← npm 认证解析共享库（**单源**；publish-core/configure-credentials 共用）
    ├── ci-core.sh             ← 发布产线核心逻辑（**单源**：四平台 build 矩阵调用；test job 自跑等价步骤）
    ├── publish-core.sh        ← 内核 npm 平台子包发布（本地 dry-run；`--publish` 仅 CI 内）
    ├── release.sh             ← 源码打包出口（tar.gz，非发布通道）
    ├── （release-core.sh 已于 2026-09-13 删除 —— 硬标准：构建/发布均经 GitHub CI）
    ├── configure-credentials.sh ← 本机凭据安全配置（环境变量 → 0600 配置，值不入库）
    └── verify-versions.js     ← 版本自洽校验（内核 package.json 单源）
```

## npm 命令映射

| npm 命令 | 对应脚本 | 用途 |
|---|---|---|
| `npm run verify:versions` | verify-versions.js --core | 内核版本自洽校验 |
| `npm run build:launcher` | build-launcher.sh | 构建本机平台 launcher（发布链路在 CI 内） |
| `npm run publish:core` | publish-core.sh | 子包组装 + dry-run（本地可用） |
| `npm run publish:core -- --publish` | publish-core.sh | 真发布 —— **仅 CI 内**（本地 exit 2） |
| `npm run build:launcher:all` | build-launcher.sh --all-platforms | 一次构建 → 派生 4 平台目录 —— **仅 CI 内**（本地 exit 2） |
| `npm run release:guard` | release.sh | 源码打包 |

> 已移除：`build:sea` / `verify:shell`（2026-09 双仓拆分：SEA 形态全平台弃用 → launcher 形态）。

> **双仓隔离（2026-09-11）**：本仓（内核）**不再持有任何壳资产**。此前混放于本仓的
> `shell-release/`（壳的 npm 打包工具）、9 份 `SHELL-*.md`（壳设计文档）、`export-shell.sh`、
> 以及 `bump.sh --shell` / `verify-versions.js --shell` 均已迁至壳仓：
> 壳工具 → `shell-release/`、`scripts/bump-shell.sh`、`scripts/verify-shell-versions.js`；
> 壳文档 → `docs/`。本仓仅保留**内核侧**的壳对接代码（`src/domains/shell/`、`src/api/domains/shell.js`
> —— 内核需要展示桌面版本并观测壳健康，属内核职责）。

## 内核构建模式（硬标准）

> 现行唯一流程见 `RELEASE-STANDARD.md`。

| 项 | 现行（硬标准）|
|---|---|
| 构建发生地 | **仅 GitHub CI**（`build` job 的 4 runner 矩阵）|
| 发布发生地 | **仅 GitHub CI**（tag 触发，各平台 runner 执行 `ci-core.sh --publish`）|
| 本地允许做什么 | S0–S3 与 `--dry-run`（如 `verify:versions` / `build-ui.sh`）；**本机不得执行 `npm test`**（全量回归由 CI 的 test job 经 `xvfb-run -a npm test` 执行） |
| 本地禁止做什么 | 任何平台构建/发布产物（`--all-platforms` 本地一律 exit 2；`release-core.sh` 已删除）|
| 四平台同源如何保证 | launcher 为架构无关纯 JS，CI 四平台产物 `core.cjs` 逐字节一致（由 CI 断言）|

**历史动因与消解**：内核仓原为私有，Actions 按倍率计费（macOS 10x），2000 分钟/月实测耗尽；
「本地构建 mac/win」曾是**被迫**选择。2026-09-13 转公开后免额度，但硬标准要求「构建与发布一律经 CI」——
理由不再是额度，而是**可复现、可审计、单一入口**。原「全平台本地构建」能力已按硬标准移除。

---

## 版本规范

- **内核**：唯一事实源 = 根 `package.json`（`bump.sh --core`；tag `v<内核>` 触发 build.yml）。语义化版本 + 两档预览后缀：`-BETA.n` / `-RC.n` / 无后缀=正式。
- **壳**：独立于内核。版本在壳仓**三处互锁**（`src-tauri/Cargo.toml` / `tauri.conf.json` / `Cargo.lock`），由壳仓 `scripts/verify-shell-versions.js` 校验、`scripts/bump-shell.sh` 提升。
- npm dist-tag（2026-09-16 发布通道契约，`RELEASE-CHANNEL-CONTRACT.md` §4）：`-BETA.n` → `beta`；`-RC.n` → `latest`（正式版占 latest），rc 别名在 publish 之后经 `npm dist-tag add ... rc` 补打；无后缀 → `latest`（publish-core.sh 自动判定）。`rollback` / `canary` 不由脚本设置（人工运维）。

## 端到端发布 SOP

### A. 内核发布（npm 子包 + GitHub Release）

```bash
# 1) 整理 CHANGELOG：[未发布] 段 → 新版本号段，并新开 [未发布]
# 2) 提升版本
bash release/scripts/bump.sh --core 0.1.2-BETA.7
# 3) 一键编排 dry-run（干净树+CHANGELOG 预检 → 委托 ci-core.sh 全部门禁 → 打印发布计划）
见 `RELEASE-STANDARD.md`（本地只做 S0–S3，S4 起在 CI）
# 4) 真发（commit + tag v<ver> + push --tags 触发 CI；四个平台全部由 CI 产出并各自 ci-core.sh --publish）
CI（tag 触发）
```

> **与壳发布的先后**：若本次内核改动涉及**跨仓契约**（新增/移除/改语义的字段），
> 必须遵守 §0.2 的时序 —— **内核先发**，壳随后；并做一次两侧版本错配的交叉验证。
> 不涉及契约时可与壳完全独立。

### 平台分工（2026-09 定案；2026-09-13 **已统一为四平台全由 CI 产出**）

| 平台 | 生产位置 | 子包 |
|---|---|---|
| **linux-x64** | **CI**（ubuntu-22.04 基座）| @dsh-sup/dsh-core-linux-x64 |
| win-x64 | GitHub CI（tag 触发 build.yml 矩阵） | @dsh-sup/dsh-core-win-x64 |
| darwin-arm64 | GitHub CI | @dsh-sup/dsh-core-darwin-arm64 |
| darwin-x64 | GitHub CI | @dsh-sup/dsh-core-darwin-x64 |

**四平台全部经 GitHub CI**（2026-09-13 硬标准）：`build` job 的 4 runner 矩阵各自构建并（tag + NPM_TOKEN + need_build 时）`ci-core.sh --publish`；
**本地无任何平台构建/发布路径**。GitHub Release 附件由单独 `release` job 汇总四平台 artifact 挂载。

> ✅ **2026-09-13 已执行**：`ubuntu-22.04` 已加回 CI build 矩阵，**四平台全部由 CI 产出**
> （`v0.1.5-BETA.2` 的 tag run 实证：precheck + test + 四平台 build + release 全绿）。
> ⚠ **2026-09-16 更正**：本地 `--all-platforms` **不是**「离线兜底」——`build-launcher.sh` 在
>   `GITHUB_ACTIONS=true` 之外一律 `exit 2`；本地无任何平台构建路径（同节「本地禁止做什么」）。

避免与 CI 形成同平台二次发布（npm 同版本不可重发）。

CI 产线（.github/workflows/build.yml → release/scripts/ci-core.sh）：四平台各自
`verify --core → build-ui → npm test → build:launcher → 子包 dry-run`；**tag 触发 + 存有 NPM_TOKEN 时**
`--publish` 真发并挂 GitHub Release。内核 launcher 为纯 JS（Node ≥18），无需 Rust/系统库。

### B. 壳发布（公开仓 dsh-supervisor-launcher）

壳仓完全独立运营（内核仓不参与）：

```bash
cd <壳仓>                                  # 公开仓 wasi7mglns/dsh-supervisor-launcher
bash scripts/bump-shell.sh <ver>          # 三处互锁同号：Cargo.toml / tauri.conf.json / Cargo.lock
node scripts/verify-shell-versions.js     # 自洽校验
git add -A && git commit && git tag v<ver> && git push origin main && git push origin v<ver>
```

→ tag 触发壳仓 `.github/workflows/build.yml`：四平台 Tauri bundle（deb/rpm/.dmg/.app/.msi/nsis）
+ npm 壳包（`@dsh-sup/shell-*`）+ `shell-manifest.json`。
壳仓已**自持**打包工具（`shell-release/`）、CI（`.github/workflows/build.yml`）、
文档（`docs/`）与版本脚本（`scripts/`），不依赖内核仓。

### C. 验收

- 全量回归：由 CI 的 `test` job 经 `xvfb-run -a npm test` 执行（mock 目标，不触碰真实 DSH/npm）；**本机不得执行 `npm test`**。
- 发布状态追踪：`release/runbooks/publish-and-verify.md`。

## 推送通道（固定标准，2026-09-10 定案）

**所有 git push 走 SSH over 443（ssh.github.com:443）**——国内网络稳定，弃用 github.com git HTTPS 直连（间歇断连）。
核仓/壳仓本地 clone 均已配置 `core.sshCommand`（密钥 `<repo>/.ssh/id_ed25519_dshpush`）与
`remote = ssh://git@ssh.github.com:443/<owner>/<repo>.git`。REST api.github.com 稳定但**不能** push 分支/触发 tag CI。

## 凭据与令牌（**认证单源**，2026-09-10 标准化）

发布链路需要的令牌**值不存仓库目录**，按根目录 **`CREDENTIALS-STANDARD.md`** 管理（工具 `release/scripts/cred.sh`，规范库为真实用户 home 下的 `.dsh/credentials/`，0700/0600）。

| 令牌 | 消费方 | 最小权限 |
|---|---|---|
| GitHub PAT | REST 查状态/建 secret/管部署密钥（不用于 git push） | `advgyxqamf` 账号（内核仓）；壳仓用 `wasi7mglns` PAT |
| SSH key | `git push`（SSH 443，**repo-local `core.sshCommand`**） | **仓库级部署密钥**（非账号级）：内核仓 `~/.ssh/id_ed25519_advgyxqamf`、壳仓 `~/.ssh/id_ed25519_wasi7` |
| `GITHUB_TOKEN` | CI 挂 Release 附件 | Actions 自动注入（workflow 声明 contents: write） |
| NPM token | npm 真发子包（四平台全部由 CI 真发） | `Automation`，仅 `@dsh-sup` scope |

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
- **跨平台标准**：发布平台各自独立——四平台均为 CI 独立 job（fail-fast:false），本地不参与构建/发布。
