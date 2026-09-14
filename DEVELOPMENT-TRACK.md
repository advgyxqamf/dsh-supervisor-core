# 开发轨道（DEVELOPMENT-TRACK）

> 本文件是**修改本仓时的强制流程**。规则不写在纸上才有用 —— 每一条都对应一个**会失败的门禁**。
> 违反规则时，`npm test` 在**本机（Linux）**就会失败，不必等到 mac/win runner 或 CI。

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
root        src/supervisor.js（组装根）、src/core.cjs（打包入口）
  ^
api         HTTP/WS 契约面
  ^
guard       守护与监督（supervisor/lifecycle/monitor/native/guardian）
  ^
domains     业务域（router/relay/instance/plugin/dist/shell）
  ^
platform    平台抽象、配置、执行器、日志、矩阵 —— 所有人的地基
```

**`platform/` 不得依赖任何上层**（L-1）。其余跨层依赖**允许但必须登记**（L-2）。

### 为什么是「登记」而不是「禁止逆向」

本仓存在**刻意的**跨层共享，禁止会误伤：

| 依赖 | 为什么刻意 |
|---|---|
| `domains -> api/identity` | relay 复用回环/RFC1918 判定，**不得重写第二份**（`relay-source-gate-test` S-a 主动要求）|
| `domains -> guard/lifecycle/ports`（9 处）| ports.js 自称「**系统级**统一端口管理」，instance/router/relay 都靠它登记端口 |
| `guard -> domains/dist` | native 卸载要读镜像契约 |
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
| 守护/监督/生命周期 | `src/guard/**` |
| HTTP/WS 接口 | `src/api/**` |
| 装配 | `src/supervisor.js`（**只做组装**）|

### 第 2 步：取平台事实（**唯一入口**）

```js
// 禁止：业务域里直接判断平台
if (process.platform === 'win32') { /* ... */ }
const osMap = { win32: 'win', linux: 'linux', darwin: 'darwin' };

// 正确：经平台层
const matrix = require('../../platform/matrix');
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
3. 跑 `npm test` —— L-2c 会核对你写了理由、L-2b 会核对没有多余登记。

### 第 4 步：写测试（**这是规则的核心**）

| 你做的事 | 必须补的测试 |
|---|---|
| 新增平台分派/标签/能力 | 在 `four-platform-behavior-matrix-test` 加穷举断言 |
| 新增平台解析（命令输出 -> 数据） | **抽成纯函数**并在 `platform-parsers-and-commands-test` 加断言 |
| 新增平台层模块/行为 | 在 `platform-layer-portability-test` 加穷举断言 |
| 修任何缺陷 | 先写**会失败的断言**（注入验证），再修 |
| 新增测试文件 | 加进 `package.json#scripts.test`（否则 N-a 失败）|

### 第 5 步：验证（**不可跳过**）

```bash
npm test                          # 全量；新门禁会拦住越界
bash release/scripts/ci-core.sh   # CI 等价预演（本仓自包含，无需壳仓）
```

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
| 2 | `src/platform/matrix.js` 的 `SUPPORTED` 加入 | 同上 M-a/M-b |
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
- 新增 / 轮换后必须 `npm test`（`credential-hygiene-test`）。
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

## 6. 提交规范

- 中文 commit message；
- 说明**缺陷 -> 修法 -> 验证**；注入验证要列出「注入什么 -> 哪条 FAIL」；
- 修缺陷的提交必须包含**回归锚点**（防同一形态再犯）；
- 两仓（内核/壳）**不得共享代码**，只经文件契约：`registry.json` / `identity.json` /
  `update-guard.json` / `update-journal.json`。契约**新增**须向后兼容；
  **删除/语义变更**须**内核先行**，保留一个发布周期的跨版本容忍。
---

## 7. CI 强制（服务器端兜底，2026-09-13 启用）

本机门禁能拦住错误，但「本机没跑就提交」是常见疏漏。故在 GitHub 侧加了**服务端兜底**。

### 内核仓 `advgyxqamf/dsh-supervisor-core` · `master` 分支保护

| 设置 | 值 | 作用 |
|---|---|---|
| Required status checks | `precheck`、`test` | 这两个 check 未通过，**PR 合不进去** |
| Strict（Require branches to be up to date）| 开启 | 合并前分支必须与 master 同步，强制在新基线上重跑 |
| Enforce for administrators | 开启 | **管理员也不能绕过** |
| Required conversation resolution | 开启 | 未解决的评审意见阻止合并 |
| Allow force push / deletions | 关闭 | 防历史被改写 |

### 为什么只设 `precheck` 与 `test`，不设 `build` 矩阵

`build`（4 平台）与 `release` 是**条件 job**（`if: needs.precheck.outputs.need_build == 'true'`）：
版本已全部发布时它们**根本不运行**。若把它们设为 required，GitHub 会等一个**永远不会出现的状态**
→ 所有 PR **永久合不进去**。required 只能设**每次都会跑**的 job。

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

`build`（4 平台）与 `release` 是**条件 job**（`need_build == 'true'` 才跑）；
版本已全部发布时它们**根本不运行**（本 PR 即为 `skipped`）。
若设为 required，GitHub 会等一个**永远不会出现的状态** → 所有 PR 永久阻塞。
故 required 只能设**每次都会跑**的 job。

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
