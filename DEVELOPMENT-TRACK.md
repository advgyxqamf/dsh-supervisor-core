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
bash release/scripts/ci-core.sh   # CI 等价预演（需 DSH_SHELL_REPO）
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

## 6. 提交规范

- 中文 commit message；
- 说明**缺陷 -> 修法 -> 验证**；注入验证要列出「注入什么 -> 哪条 FAIL」；
- 修缺陷的提交必须包含**回归锚点**（防同一形态再犯）；
- 两仓（内核/壳）**不得共享代码**，只经文件契约：`registry.json` / `identity.json` /
  `update-guard.json` / `update-journal.json`。契约**新增**须向后兼容；
  **删除/语义变更**须**内核先行**，保留一个发布周期的跨版本容忍。
