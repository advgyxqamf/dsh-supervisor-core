# 开发轨道（DEVELOPMENT-TRACK）

> 本文件是**修改本仓时的强制流程**。规则不写在纸上才有用 —— 每一条都对应一个**会失败的门禁**。
> 违反规则时，CI 门禁会失败（按 ACCEPTANCE-STANDARD，测试与验收一律经 CI 裁决，不在本机执行）。

---

## 0. 三条铁律

| # | 铁律 | 由哪道门禁守 |
|---|---|---|
| 1 | **平台知识只允许在 `src/platform/**`** | `cross-platform-architecture-gate-test` CP-1/CP-2 |
| 2 | **跨层依赖必须显式登记**（`test/layering-and-dependency-gate-test.js` 的 `CROSS_LAYER`）| `layering-and-dependency-gate-test` L-2 |
| 3 | **新增测试必须进链**（或在排除表里写理由）| `test-chain-completeness-test` N-a |

---

## 1. 分层（`src/`）

```
root        src/supervisor.js（进程入口薄壳；build-launcher.sh 经 esbuild 打成 core.cjs）
  ^
api         HTTP/WS 契约面
  ^
app         编排层（组装根与业务主体；原 guard/** 并入）
  ^
domains     业务域（router/relay/instance/plugin/shell）
  ^
platform    平台抽象、配置、执行器、日志、矩阵、分发 —— 所有人的地基
  ^
shared      纯函数（version/ip/guardian）—— 与 platform 并列 L0，出度恒为 0
```

**`platform/` 不得依赖任何上层**（L-1）。其余跨层依赖**允许但必须登记**（L-2）。

### 为什么是「登记」而不是「禁止逆向」

本仓存在**刻意的**跨层共享，禁止会误伤：

| 依赖 | 为什么刻意 |
|---|---|
| `domains -> shared/ip` | relay 复用回环/RFC1918 判定，**不得重写第二份**（`relay-source-gate-test` S-a 主动要求）|
| `domains -> platform/service`（端口）| ports.js 自称「**系统级**统一端口管理」，instance/router/relay 都靠它登记端口 |
| `platform -> shared` | version/ip 为 L0 纯函数，platform 与 domains 共用同一份，不得各自重写 |
| `api -> platform`、`root -> 全部` | 正常向下组装 |

把这些写成「禁止」，门禁第一次运行就红，然后被人加白名单绕过 —— 那就成了摆设。
**登记 + 理由 + 变更可见**才是能长期活下去的形态。

---

## 2. 要改代码时，按这个顺序走

### 第 1 步：定位层

| 你要改的东西 | 应该在哪 |
|---|---|
| 平台差异（OS 判定、命令、路径、解析）| `src/platform/**`（**只能在这**）|
| 业务逻辑（路由/中继/实例/插件/发布）| `src/domains/<域>/` |
| 守护/监督/生命周期（编排）| `src/app/**`（原 `guard/**` 并入）|
| HTTP/WS 接口 | `src/api/**` |
| 装配 | `src/app/assembly/**`；`src/supervisor.js` 为薄壳（加载配置 → 调组装 → 启动 API）|

### 第 2 步：取平台事实（**唯一入口**）

```js
// 禁止：业务域里直接判断平台
if (process.platform === 'win32') { /* ... */ }
const osMap = { win32: 'win', linux: 'linux', darwin: 'darwin' };

// 正确：经平台层
const matrix = require('../../platform/contract/matrix');
const os = matrix.osTag();              // 'win' | 'darwin' | 'linux'
const tag = matrix.npmTag();            // 'linux-x64' 等
const frp = matrix.frpTag();            // 第三方命名 'windows_amd64'
if (matrix.supportsProcessGroup()) { /* POSIX 进程组 */ }
```

能力查询用 `platform/os/index.js` 的 `capabilities()` / `capabilityProfile()`；
**不要**自己写 `process.platform` 分支。

### 第 3 步：新增跨层依赖 -> 登记

若确实需要新的跨层 import：

1. 先问：能否经 `platform/` 或**已登记的共享单元**？
2. 不能，则在 `test/layering-and-dependency-gate-test.js` 的 `CROSS_LAYER` 增加一条，**写明理由**；
3. 由 CI 门禁核对：L-2c 核对理由、L-2b 核对无多余登记（按 ACCEPTANCE-STANDARD，测试不在本机执行）。

### 第 4 步：写测试（**这是规则的核心**）

| 你做的事 | 必须补的测试 |
|---|---|
| 新增平台分派/标签/能力 | 在 `four-platform-behavior-matrix-test` 加穷举断言 |
| 新增平台解析（命令输出 -> 数据） | **抽成纯函数**并在 `platform-parsers-and-commands-test` 加断言 |
| 新增平台层模块/行为 | 在 `platform-layer-portability-test` 加穷举断言 |
| 修任何缺陷 | 先写**会失败的断言**（注入验证），再修 |
| 新增测试文件 | 加进 `package.json#scripts.test`（否则 N-a 失败）|

### 第 5 步：验证（**不可跳过**）

按 ACCEPTANCE-STANDARD，测试与验收一律经 CI；本机只做 `node --check` 语法自校与只读检查，不得以本机结果作结论。

---

## 3. 注入验证（**修缺陷的强制标准**）

任何门禁/断言都必须证明**它会失败**，否则等于没有：

```
(1) 写门禁 -> (2) 注入缺陷 -> (3) 确认 FAIL -> (4) 还原（sha256 校验）-> (5) 确认 PASS
```

**注入必须保持可编译/可解析**（否则失败原因是语法错误，不是门禁生效）。

### 常见的「假绿」形态（本仓都踩过）

| 形态 | 例子 | 怎么避免 |
|---|---|---|
| 判据依赖默认值兜底 | 删掉 `.cmd` 候选，`PATHEXT` 默认值又把它加回来 | 断言**排位**而非「包含」|
| 夹具顺序让贪婪匹配巧合正确 | `:2800` 排在 `:28100` 前 | 用**只有长串**的夹具，问短串必为 `null` |
| 门禁读的与被注入的不是同一处 | 注入 `sessionAvailable()`，门禁读 `describe()` | 先确认**消费链**，或让被注入处就是门禁读处 |
| 断言匹配到自己的说明文字 | 注释里写了错误形态作对照 | **剥离注释**后再断言 |
| 空集让门禁空转 | 路径未相对 ROOT 归一 -> 跨层边集为空 -> 全过 | 加一条「集合非空」的反向断言 |

---

## 4. 新增平台支持（固定四步，不得跳步）

| 步 | 动作 | 门禁 |
|---|---|---|
| 1 | `package.json#npmPublish.packages` 声明子包 | `platform-matrix-single-source-test` M-a |
| 2 | `src/platform/contract/matrix.js` 的 `SUPPORTED` 加入 | 同上 M-a/M-b |
| 3 | `src/platform/os/*` 补 Provider 分支（`capabilityProfile` 显式档位）| `cross-platform-architecture-gate-test` CP-3 |
| 4 | `.github/workflows/build.yml` build 矩阵加入 runner | `release-auth-test` R6-a2 |

---

## 5. 守住边界的七道门禁

| 门禁 | 断言 | 守什么 |
|---|---|---|
| `platform-matrix-single-source-test` | 17 | 矩阵与发布清单逐项一致；src/ 无第二份 os/arch 映射表 |
| `cross-platform-architecture-gate-test` | 11 | 平台事实只在 `src/platform/**` |
| `four-platform-behavior-matrix-test` | 43 | 四平台**逻辑**一次穷举 |
| `platform-layer-portability-test` | 61 | 平台层**11 个模块**行为穷举 |
| `platform-parsers-and-commands-test` | 38 | 平台输出解析 + 命令构造穷举 |
| `layering-and-dependency-gate-test` | 10 | 分层与跨层依赖登记（**开发轨道**）|
| `test-chain-completeness-test` | 10 | 新增测试必有归属 |

> **诚实边界**：这些门禁证明的是**逻辑**（映射/档位/解析/命令/分层），
> **不能**证明**平台原生行为**（真能跑 systemd/launchctl/schtasks、真能 spawn Windows 可执行、真能出 MSI）。
> 后者仍必须由**真实四平台 CI 构建**裁决。两者互补，不可互相替代。

---

---

## 5.1 凭据管理

改动涉及**令牌 / 密钥 / CI Secrets / 分支保护**时，**必须**先读 `CREDENTIALS-STANDARD.md`。

- 凭据只允许在规范库（**真实用户 home** 下的 `.dsh/credentials/`；**禁止**实例子目录 / 附件目录 —— 那是 ephemeral 的）；
- 用 `bash release/scripts/cred.sh list|doctor|verify` 查看与管理；
- ⚠ `$HOME` 被重定向到实例数据目录，**一律用绝对路径**，禁止 `~`；
- 新增 / 轮换后必须经 `credential-hygiene-test`（由 CI 执行）。
### 5.2 不可逆操作（破坏性操作）

**任何不可逆操作**（覆盖凭据 / 发 npm 包 / force push / 删分支 / 覆盖文件）执行前必须自问三问：

1. 会不会不可逆？→ 2. 有无备份/回滚手段？→ 3. **失效方向是否安全**（出错时是拒绝，还是降级到真机）？

并遵守：

- 破坏性子命令**默认拒绝真机**，需显式确认；
- 覆盖前先备份，使操作可逆；
- **注入验证优先选非破坏性注入点**；
- 轮换/迁移期保留旧值副本，直到新值验证通过。

> 血泪案例（务必读）：`INCIDENT-2026-09-13-credential-overwrite.md` ——
> 我用「破坏隔离」去证明门禁有效，而那道隔离保护的正是不可逆操作，结果覆盖了真令牌。

### 5.3 运行时禁区（**源码开发绝不触碰系统安装版**）

> 血泪案例（2026-09-16）：清理临时文件时执行 `rm -rf /tmp/dsh-*`，而 **DSH 自身正在用
> `/tmp/dsh-subprocess-<随机>/` 存放子进程输出** —— 目录被删后 DSH 写日志 `ENOENT` **崩溃退出（code=1）**，
> 由守卫 6 分钟后才重新拉起。**源码开发绝不应该影响系统正在运行的 DSH 与已安装的 supervisor。**

#### 铁律 R-1：开发只作用于工作区

| 允许 | 禁止 |
|---|---|
| 读写**本仓工作区**（当前工作目录）内文件 | 改/删 `~/.local/state/dsh-supervisor/`（系统的状态根） |
| 在本仓工作区内改代码 + `node --check` 语法自校（**测试一律由 CI 裁决**，本机不得跑测试） | 停/启/改 `dsh-supervisor.service`（系统已安装的服务） |
| 读系统状态用于**诊断**（只读） | 覆盖 `/usr/bin/dsh-supervisor-gui`、`~/.npm-global/lib/node_modules/@dsh-sup/*` |
| 操作 `/tmp` 下**自己创建的具名路径** | 触碰 `~/.dsh`（DSH 自身的数据目录） |

#### 铁律 R-2：`/tmp` 清理必须**逐路径具名**，禁止通配符

DSH 与 AI 运行时**都在** `/tmp` 用 `dsh-*` / `dsh-spill-*` / `dsh-subprocess-*` 作为**活动目录**。
一个 `/tmp/dsh-*` 通配符会**同时命中**它们 → 直接打崩正在运行的进程。

- **禁止**：`rm -rf /tmp/dsh-*`、`/tmp/tmp.*`、`/tmp/*.log` 之类**通配/前缀**删除；
- **必须**：只删**自己明确创建、且知道其全名**的具体路径；
- **删除前先核对**：执行 `ls -d <pattern>` 看清匹配到谁，再决定；
- 测试临时物一律经 `mkdtemp`（或经 `test/_preload.js` 注入的隔离 `DSH_SUPERVISOR_HOME`）创建**自己的前缀**，**自带清理**，不依赖外部扫 `/tmp`。

#### 铁律 R-3：发现「好像动了系统」时，先取证再行动

只读取证优先：`systemctl --user show dsh-supervisor.service -p NRestarts -p ActiveEnterTimestamp`、
系统状态根下的 `events/*.log` / `log/dsh.log`。**不得**用「重启服务」作为排查手段。

> 门禁：`test/dev-runtime-safety-gate-test.js` 扫描仓内脚本/文档，禁止出现对系统路径的破坏性命令与 `/tmp` 通配删除。

## 6. 提交规范

- 中文 commit message；
- 说明**缺陷 -> 修法 -> 验证**；注入验证要列出「注入什么 -> 哪条 FAIL」；
- 修缺陷的提交必须包含**回归锚点**（防同一形态再犯）；
- 两仓（内核/壳）**不得共享代码**，只经文件契约：`registry.json` / `identity.json` /
  / `update-journal.json`。契约**新增**须向后兼容；
  **删除/语义变更**须**内核先行**，保留一个发布周期的跨版本容忍。
---

## 7. CI 强制（服务器端兜底，2026-09-13 启用）

本机只能做 `node --check` 等只读自校（**测试一律由 CI 裁决**），「没推送就跑 CI」是常见疏漏。故在 GitHub 侧加了**服务端兜底**。

### 内核仓 `advgyxqamf/dsh-supervisor-core` · `master` 分支保护

| 设置 | 值 | 作用 |
|---|---|---|
| Required status checks | `precheck`、`test` | 这两个 check 未通过，**PR 合不进去** |
| Strict（Require branches to be up to date）| 开启 | 合并前分支必须与 master 同步，强制在新基线上重跑 |
| Enforce for administrators | 开启 | **管理员也不能绕过** |
| Required conversation resolution | 开启 | 未解决的评审意见阻止合并 |
| Allow force push / deletions | 关闭 | 防历史被改写 |

### 为什么只设 `precheck` 与 `test`，不设 `build` 矩阵

`build`（4 平台）自 2026-09-14 起**每次 push / PR 都跑**（不受 `need_build` 门控，仅其中的 `--publish` 步骤受门控；
见 `RELEASE-STANDARD.md` §4 与 `test/release-spec-consistency-test.js` 的 P-8）。
仍是**条件 job** 的只有 `release`（tag `v*` 且 `need_build`）。
required checks 只设 `precheck` 与 `test`（合并门禁）；`build` 只作构建验证，不设为 required ——
条件 job 若设为 required，GitHub 会等一个**永远不会出现的状态**，所有 PR **永久合不进去**。

### 实测结论（修正我先前的判断）

我原先以为「required checks 只在 PR 合并路径评估、直推不受影响」——**实测证伪**。
开启 `enforce_admins=true` + required checks 后，直推被服务端拒绝：

```
remote: - 2 of 2 required status checks are expected.
 ! [remote rejected] master -> master (protected branch hook declined)
```

即 GitHub **在直推路径上也评估** required checks。由此产生一个**死锁**：
新提交在推上去之前无法产生 check，而没 check 又推不上去 → **直推通道被完全关闭**。

### 因此：本仓的改代码流程 = **必须走 PR**

```bash
# 1) 在分支上改并推送
git switch -c feat/xxx
git commit -am '...'
git push origin HEAD:refs/heads/feat/xxx

# 2) 开 PR（随后 precheck/test 自动跑）
#    gh pr create --fill   或经 GitHub UI/API

# 3) 两个 required check 通过后合并（GitHub UI「Merge」或 API）
git switch master && git pull --ff-only
```

> **发布标签不受影响**：`v*` tag 推送走 tag 通道，分支保护只管分支。
> 故发布流程（打 tag → 触发 release）保持不变。

### 若要放开直推（需要时）

| 想达到的效果 | 怎么改 |
|---|---|
| 管理员可直推（其余人仍受门禁）| `enforce_admins: false` |
| 完全回到无保护 | `DELETE .../branches/master/protection` |
| 保持现状（**默认**，最强）| 不改，走 PR |

### 为什么只设 precheck 与 test（重申）

只有 `release` 是条件 job（`need_build == 'true'` 才跑，版本已全部发布时 `skipped`）；
`build`（4 平台）**每次 push / PR 都跑**（见 `RELEASE-STANDARD.md` §4）。
required 只设 `precheck` 与 `test` 两个**无条件** job；`build` 不设为 required。

### 壳仓

壳仓属**另一账号**（`wasi7mglns`）。**2026-09-13 已设置分支保护**（required checks =
`version` + 4 条 `build (...)`，strict + enforce_admins）。

两仓保护配置见 `CREDENTIALS-STANDARD.md` 与本节；壳仓的 required 语境**内嵌矩阵参数**，
改平台矩阵时必须同步更新保护配置（否则旧语境永不出现 → 所有 PR 阻塞）。

已完成的准备工作（本仓已推）：

- **补 `pull_request` 触发器**（壳仓 `fd0287c`）：壳仓 CI 此前只由 `push: tags/main` 触发，
  **PR 完全不跑 CI**；若不补而直接设 required，GitHub 会等一个**永不出现的状态** → 所有 PR 永久阻塞。
- 其 `build` 是**无条件 4 平台矩阵**（每次必跑）→ **可以且应该**设为 required（与内核仓相反）。
- 完整 required 配置、精确 contexts、可直接执行的 API 调用与**矩阵变更陷阱**：
  见壳仓 `docs/RELEASE-AND-BUILD-DECISION.md` 的「把 CI 设为合并门禁」附录。

> ⚠ 陷阱：壳仓 required context **内嵌矩阵参数**（如 `build (ubuntu-22.04, linux-x64, deb,rpm, 2.35)`），
> 增删平台或改 arch 组合后旧语境变为「预期但永不出现」→ 所有 PR 合不进去。改矩阵时必须同步更新保护配置。

### 本次启用的完整设置（内核仓 `master`）

| 项 | 值 |
|---|---|
| required_status_checks.contexts | `["precheck","test"]` |
| required_status_checks.strict | `true` |
| enforce_admins | `true` |
| required_conversation_resolution | `true` |
| allow_force_pushes / allow_deletions | `false` |

---

## 8. 域内结构归一化（2026-09-17 起 · **执行中**）

> 跨层问题（上一轮步骤 1–10）已收口；本轮解决**域内部高耦合**（巨型文件 / 隐式 `this` / 原型 mixin / 职责错位）。

### 8.1 规则来源（三份，不可互相替代）

| 文件 | 角色 |
|---|---|
| `DOMAIN-STRUCTURE-DESIGN.md` | **域内结构唯一权威（SSOT）**：DF-1..DF-7 + R1..R12 + 五域/app 逐文件目标结构 + DG-1..DG-16 + §8 须同步改的门禁 |
| `EXECUTION-CONTRACT.md` | **并行施工接口冻结书**：判据 + 硬约束 + 冻结的内部导出面/依赖 + 迁移纪律（所有执行子代理逐条遵守） |
| `design-notes/*.md` | 逐域详细设计（router / relay / instance / plugin / shell / app / gates） |

### 8.2 判据（取严值，与 DS-9 一致）

| 编号 | 判据 | 阈值 |
|---|---|---|
| DF-1 | 门面 `index.js` 只做组合与导出 | **≤150 行** |
| DF-2 | 任何单文件 | **≤300 行** |
| DF-3 | 纯计算与副作用（IO/定时/进程）不混同一文件 | — |
| DF-4 | 零隐式 `this` 跨文件 | **0 处** |
| DF-5 | 域内依赖图无环（且禁方法集合并到同一 this） | 0 环 |
| DF-6 | 非门面文件可独立 `require` 可测 | — |
| DF-7 | 依赖单向：`index → ops/scheduler → core/policies → model/store` | — |

### 8.3 施工方式

- **主代理 + 12+ 子代理并行**；子代理**文件归属互斥**，须完整转达执行契约，**验证自己做**（不外包）。
- **批 0–10**（先立门禁后重构；每批：`node --check` → `require` 加载 → 提交并推送，相关测试由 CI 裁决（本机不得跑测试，见 ACCEPTANCE-STANDARD））：

| 批 | 内容 |
|---|---|
| 0 | 立 `test/domain-structure-gate-test.js`（report-only，记录 RED 基线） |
| 1 | shell（最接近达标，验证方法论） |
| 2 | plugin（破环示范：model/cli/jobs 三层断链） |
| 3 | instance（先改 `instance-upgrade-test` 的 owner 补丁） |
| 4 | relay（入口错位修正） |
| 5 | router-ops / router-forward（先纯后 IO） |
| 6 | router-facade（门面纯化 + 写权闸单源） |
| 7 | router-providers（最大文件） |
| 8 | app 级 1（停跨文件挂原型 + 兼容门面） |
| 9 | app 级 2（按切面 ctor 注入） |
| 10 | 门禁转硬失败 + 删除兼容门面 |

- **行为变更步**（如 router `inflight.end()` 统一）**必须独立提交**，不与纯结构步混。

### 8.4 迁移时同步维护的登记（文档/门禁）

| 项 | 要求 |
|---|---|
| `DIRECTORY-STRUCTURE-DESIGN.md` DS-9 | 已取严为 **门面 ≤150 / 单文件 ≤300**（R3/R11），与 DF-1/DF-2 逐字一致 |
| `DIRECTORY-STRUCTURE-DESIGN.md` DS-G3 | 除 `Object.defineProperties` 外，**同时禁 `Object.assign(X.prototype, ...)`**（R6；右值不限、须先剥注释） |
| README 文档索引 | 根级 md **全部登记**（`standards-uniqueness-test` U-4）；`EXECUTION-CONTRACT.md` 已登记 |
| `CROSS_LAYER`（`layering-and-dependency-gate-test.js`）| 域改造**只在同层内搬文件**，理论不新增跨层边；确因新边（如 `app/domain-actions/*` → 域）报 L-2 失败时**按 CI 实跑报错补登记**（本机不得跑门禁，见 ACCEPTANCE-STANDARD），**不得放宽判据**、不得凭猜测预登记 |
| 源内容钉死的门禁 | SSOT §8 列出的 10 处随方法与家园同步改指向（否则静默失效） |

### 8.5 本轮验证门禁

`standards-uniqueness`、`test-chain-completeness`、`layering-and-dependency-gate`、
`directory-structure-gate`、`no-dev-path`、`no-cross-repo`；
以及每域相关测试（改哪域由 CI 跑哪域；本机不得跑测试）。
