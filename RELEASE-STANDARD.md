# 发布与构建标准（RELEASE-STANDARD）

> **本文件是发布/构建流程的唯一事实源（SSOT）。** 任何流程细节以此为准。
> 由 `test/release-spec-consistency-test.js` **机器校验**：本文件写的每个入口、矩阵、job、门禁
> 都必须与仓库现实一致 —— 规范**无法漂移**（改了代码不改这里，或反之，门禁即红）。

## 0. 硬标准（2026-09-13，不可协商）

> **所有平台构建与发布必须经 GitHub CI 完成。本地不得产生任何发布产物。**

| 要求 | 实现 | 门禁 |
|---|---|---|
| 四平台构建只在 CI 内发生 | `build` job 的 4 runner 矩阵，各 runner 只构建**自己**的平台 | `all-platforms-test` T2-a/T2-a2 |
| 本地不得全平台构建 | `build-launcher.sh --all-platforms` 受 `GITHUB_ACTIONS` 守卫，本地 exit 2 | T2-a2 |
| 本地不得全平台发布 | `publish-core.sh --all-platforms` 一律 exit 2 | T2-b |
| 无本地发布编排器 | `release-core.sh` **已删除** | T2-e |
| npm scripts 无本地发布入口 | `release:core*` 与 `publish:core:all` 全部移除 | T2-g |
| **内核仓不得依赖壳仓源码** | 不检出、不读取壳仓；跨语言契约只经「已发布产物 / schema / 测试向量」消费 | `test/no-cross-repo-test.js` |
| **本地不得真发布（含单平台）** | `publish-core.sh` / `ci-core.sh` 的 `--publish` 要求 `GITHUB_ACTIONS=true` | T2-b2 / T2-d2 |
| **无机器绑定路径** | 真实 home 经 getent/dscl/USERPROFILE 解析；不得写死 `/home/<user>` | `test/no-dev-path-test.js` |

**为什么**：本地构建让「产物从哪来」不可复现、不可审计；曾出现「本地发一部分、CI 发一部分」的分裂，以及本机与 CI 同平台二次发布（npm 同版本不可重发，实测 409 Conflict）。统一到 CI 后：产物可追溯、四平台同构、发布单一入口。

---
## 为什么需要这份文件（问题的实质）

此前**不是没有文档**，而是同一事实散落多处（实测）：

| 事实 | 曾出现在 |
|---|---|
| 发布入口 `release-core.sh` | 内核 **7** 份文档 + 壳 1 份 |
| npm 子包矩阵 | 内核 **5** + 壳 2 |
| glibc 基座 | 内核 **5** + 壳 3 |
| 凭据/令牌 | 内核 **8** + 壳 1 |

多处副本必然漂移，故本文件确立两件事：
**① 流程只在这里写一遍；② 用门禁把「规范 = 现实」钉死。**

## 各文档的分工（不再重复，只指向）

| 文档 | 讲什么 | **不再**讲什么 |
|---|---|---|
| **本文件** | **流程（阶段/入口/命令/门禁/放行/验证）** | — |
| `CREDENTIALS-STANDARD.md` | 凭据的存放与轮换 | 流程阶段 |
| `DEVELOPMENT-TRACK.md` | 改代码的规则（分层/测试/注入验证） | 发布命令 |
| `INCIDENT-2026-09-13-credential-overwrite.md` | 事故复盘 | 现行流程 |
| `release/README.md` | 发布工程**目录结构**与脚本索引 | 流程细节（指向本文件）|
| `RELEASE-AND-UPDATE-MECHANISM.md` | 机制**原理**（为何这样设计） | 操作步骤 |
| `CROSS-PLATFORM-BUILD-AND-UPDATE.md` | 跨平台**方案论证** | 操作步骤 |
| `release/runbooks/publish-and-verify.md` | 发布与验收全流程（runbooks/ 下唯一一份）| 通用流程 |
| 壳仓 `docs/RELEASE-AND-BUILD-DECISION.md` | **壳仓**发布（安装程序） | 内核流程 |

---

## 1. 全流程（阶段化）


| 阶段 | 名称 | 命令 | 必须绿 | 失败怎么办 |
|---|---|---|---|---|
| S0 | 凭据就绪 | `bash release/scripts/cred.sh doctor` | ✅ | 补发/轮换令牌（见凭据标准）|
| S1 | 版本提升 | `bash release/scripts/bump.sh --core <ver>` | ✅ | 只允许递增 |
| S2 | 版本一致性预检 | `npm run verify:versions` | ✅ | 修派生处 |
| S3 | 前端产物 | `bash release/scripts/build-ui.sh` | ✅ | 修 UI 构建 |
| S4 | 全量回归（**由 CI 执行**）| `xvfb-run -a npm test`（本机不得执行）| ✅ | 修缺陷（含注入验证）|
| S5 | **推向 CI**（commit + tag + push）| `git push origin HEAD --tags` | ✅ | **此后一切构建/发布都在 CI 内完成** |
| S6 | CI 四平台构建 | 自动（`build` job，4 runner 矩阵）| ✅ | 看该平台日志 |
| S7 | CI 四平台发布 | 自动（`build` job 内 `ci-core.sh --publish`）| ✅ | npm 同版本不可重发 → 提版本重来 |
| S8 | 发布后验证 | 见 §5 | ✅ | 立即处置（见 §6）|

> **本地只完成 S0–S3**（凭据 / 版本 / 前端产物）；**S4（全量回归）由推送后的 CI test job 执行**，**S5 起全部在 CI 内完成**（见 ACCEPTANCE-STANDARD：本机不得执行任何测试）。
> 本地可用 `npm run build:launcher:all` 仅在 **CI 内**生效（有 `GITHUB_ACTIONS` 守卫，本地一律 exit 2）。

## 2. 平台矩阵（单一事实源）

**唯一来源**：`package.json#npmPublish.packages` → 由 `release/scripts/_platforms.sh` 读取派生。
任何地方（CI 矩阵、文档、脚本）都不得再写第二份清单。

| osTag | platform | arch | npm 子包 | CI runner |
|---|---|---|---|---|
| linux | linux | x64 | `@dsh-sup/dsh-core-linux-x64` | `ubuntu-22.04`（glibc 2.35 基座）|
| darwin | darwin | arm64 | `@dsh-sup/dsh-core-darwin-arm64` | `macos-latest` |
| darwin | darwin | x64 | `@dsh-sup/dsh-core-darwin-x64` | `macos-14` |
| win | win32 | x64 | `@dsh-sup/dsh-core-win-x64` | `windows-latest` |

约束（有门禁）：

- **四平台全由 CI 产出**（`release-auth-test` R6-a/R6-a2）；Linux 必须用 `ubuntu-22.04` 基座（R6-a3 + `glibc-gate-test`）；
- Linux 不得在 24.04 构建（glibc 2.39 产物的 pidfd 弱引用会变成硬 verneed → 22.04/Debian 12 跑不起来）；
- launcher 是**架构无关纯 JS**（0 运行时依赖、0 个 .node）→ 单一构建派生四平台，产物 `core.cjs` **字节一致**。

## 3. 入口命令（唯一入口）

| 用途 | 命令 |
|---|---|
| CI 产线核心（测试 job 与 build 矩阵共用）| `bash release/scripts/ci-core.sh` |
| 本地构建 launcher（本机平台）| `npm run build:launcher` |
| 四平台 launcher（**仅 CI 内**；本地 exit 2）| `npm run build:launcher:all` |
| 本地子包组装 + dry-run | `npm run publish:core` |
| 真发布（**仅 CI 内**；本地 exit 2）| `npm run publish:core -- --publish` |
| 版本一致性 | `npm run verify:versions` |
| 凭据自检 | `bash release/scripts/cred.sh doctor` |

> **红线**：不得绕过上述入口直接 `npm publish` / 手写 dist` —— 元数据与版本单源都在入口脚本里。

## 4. CI 与放行条件

触发：`push`（`master` 与 `v*` tag）、`pull_request`、`workflow_dispatch`。

| job | 何时跑 | 作用 |
|---|---|---|
| `precheck` | 总是 | 探测「该版本是否已在 npm 全平台发布」→ 输出 `need_build` |
| `test` | 总是 | 前端产物 + Xvfb + `npm test`（全部门禁；**不检出壳仓**，见 §0 跨仓隔离）|
| `build` | **总是**（**不受** need_build 门控）| 四平台矩阵各自 `ci-core.sh`：**完整构建 + 验证**（上传制品）；**发布**仅当 tag + NPM_TOKEN + need_build 才执行 |
| `release` | tag `v*` **且** `need_build` | 挂 GitHub Release 附件 |

**`need_build` 只作用于「发布」，不作用于「构建」**（2026-09-14 修正）：

- `need_build` 是「该版本是否尚未在 npm 全平台发布」的探测，**仅**用于决定是否执行 `--publish`（npm 同版本不可重发）；
- **四平台完整构建在每次 push / PR 都跑**（硬标准），不再被它跳过；
- 故「已发布版本之后的改动」也会经过四平台构建验证 —— 这是删掉原门控的原因。

**唯一仍受 `need_build` 影响的是 `release` job**（挂 Release 附件，避免对同一版本重复挂载）。

分支保护（服务器端放行条件）：

| 仓库 | branch | required checks |
|---|---|---|
| `advgyxqamf/dsh-supervisor-core` | `master` | `precheck`、`test`（strict + enforce_admins）|
| `wasi7mglns/dsh-supervisor-launcher` | `main` | `version` + 4 条 `build (...)`（strict + enforce_admins）|

> required 只能设**每次都会跑**的 job。`build` 矩阵如今**每次 push / PR 都跑**（不再是条件 job），
> 故它可作为 required；**唯一仍受 `need_build` 影响的是 `release` job**（见 §4 上文），
> 把它设为 required 会让 PR **永久阻塞**。

## 5. 发布后验证（S8）

| 项 | 命令 / 位置 | 期望 |
|---|---|---|
| npm 四平台齐备 | `npm view @dsh-sup/dsh-core-<platform>@<ver> version` ×4 | 四者皆等于目标版本 |
| dist-tag | `npm view @dsh-sup/dsh-core-linux-x64 dist-tags` | `beta` → 新版本 |
| GitHub Release | `gh release view v<ver>` 或 API | 4 个附件 |
| CI 结论 | tag run 全绿 | precheck + test + 四平台 build + release |
| 凭据仍有效 | `bash release/scripts/cred.sh verify` | 全部 OK |

> **⚠ 查询 npm 必须容忍传播延迟**（2026-09-14 实测）：刚发布后立即查询可能返回 E404 或旧版本列表 ——
> 这是 **registry / CDN 传播延迟**，不代表发布失败。判据顺序：**先看 CI 的 publish 日志**
> （`+ @dsh-sup/<pkg>@<ver>` 是 npm 的确认），再重试查询（建议 45s 间隔、最多 4 次）。
> 本次发布即因此出现过一次假警报（两个包被误判为漏发，实为传播延迟）。

## 6. 失败处置与回滚
| 情形 | 处置 |
|---|---|
| dry-run 阶段失败 | 直接修，无副作用 |
| 真发布**部分平台**成功 | **不要重发同版本**（npm 拒绝）。提 patch 版本重来 |
| tag 已推但 CI 失败 | 修代码 → **删除并重打 tag**（本项目既有做法），或提新版本 |
| 发布后发现内核不可用 | 提新版本回滚（npm 不允许 unpublish 同版本覆盖）|
| 凭据失效 | 见 `CREDENTIALS-STANDARD.md`；`cred.sh doctor` 会提前报缺项 |

## 7. 禁止事项（红线）

1. 不得绕过入口直接 `npm publish`；
2. 不得在 `package.json` 之外维护第二份平台清单；
3. 不得在非 22.04 基座构建 Linux 产物；
4. 不得把令牌写入仓库目录 / remote URL / 实例子目录（见凭据标准）；
5. 不得在未跑 S2–S6 的情况下执行 S7；
6. 不得对**不可逆**操作（真发布 / force push / 覆盖凭据）省略「是否可逆 / 有无备份 / 失效方向」三问。

## 8. 规范自校验（防漂移）

本文件下方嵌一段**机器可读**的流程声明；`test/release-spec-consistency-test.js` 会：

| 组 | 校验 |
|---|---|
| P-1 | 每个入口文件**存在**；`.sh` 可执行 |
| P-2 | 每个 `npm run <name>` 的 `<name>` **存在**于 `package.json#scripts` |
| P-3 | 矩阵与 `npmPublish.packages` **逐项一致**，且 CI build 矩阵覆盖同集合 |
| P-4 | CI job 名与触发（含 tag 模式）与 workflow 一致 |
| P-5 | 本文件列出的门禁文件都存在，且在 `scripts.test` 链中 |
| P-6 | 必需章节标题齐备 |
| P-7 | 反向：判据能识别伪造入口/缺失文件（门禁非空转）|

```json release-pipeline
{
  "version": 1,
  "hardStandard": "所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物",
  "entries": {
    "ciCore": "release/scripts/ci-core.sh",
    "publishCore": "release/scripts/publish-core.sh",
    "buildLauncher": "release/scripts/build-launcher.sh",
    "buildUi": "release/scripts/build-ui.sh",
    "bump": "release/scripts/bump.sh",
    "verifyVersions": "release/scripts/verify-versions.js",
    "platforms": "release/scripts/_platforms.sh",
    "cred": "release/scripts/cred.sh"
  },
  "stages": [
    {
      "id": "S0",
      "cmd": "bash release/scripts/cred.sh doctor"
    },
    {
      "id": "S1",
      "cmd": "bash release/scripts/bump.sh --core <ver>"
    },
    {
      "id": "S2",
      "cmd": "npm run verify:versions"
    },
    {
      "id": "S3",
      "cmd": "bash release/scripts/build-ui.sh"
    },
    {
      "id": "S4",
      "cmd": "CI: xvfb-run -a npm test"
    },
    {
      "id": "S5",
      "cmd": "git push origin HEAD --tags"
    },
    {
      "id": "S6",
      "cmd": "CI: build job (4 runner matrix)"
    },
    {
      "id": "S7",
      "cmd": "CI: ci-core.sh --publish (per platform)"
    }
  ],
  "matrixSource": "package.json#npmPublish.packages",
  "ciWorkflow": ".github/workflows/build.yml",
  "ciJobs": [
    "precheck",
    "test",
    "build",
    "release"
  ],
  "ciRunners": [
    "ubuntu-22.04",
    "windows-latest",
    "macos-latest",
    "macos-14"
  ],
  "tagPattern": "v*",
  "requiredSections": [
    "## 0. 硬标准（2026-09-13，不可协商）",
    "## 1. 全流程（阶段化）",
    "## 2. 平台矩阵（单一事实源）",
    "## 3. 入口命令（唯一入口）",
    "## 4. CI 与放行条件",
    "## 5. 发布后验证（S8）",
    "## 6. 失败处置与回滚",
    "## 7. 禁止事项（红线）",
    "## 8. 规范自校验（防漂移）"
  ],
  "specGates": [
    "test/release-spec-consistency-test.js",
    "test/release-auth-test.js",
    "test/glibc-gate-test.js",
    "test/credential-hygiene-test.js",
    "test/destructive-op-safety-test.js",
    "test/no-cross-repo-test.js",
    "test/no-dev-path-test.js"
  ]
}
```
