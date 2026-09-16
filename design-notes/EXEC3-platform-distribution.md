# EXEC3 · platform/distribution 下拉到最根部（2026-09-17）

> 范围：`src/platform/distribution/**`（本轮唯一负责目录）。
> 权威依据：EXECUTION-CONTRACT.md（§1–§7）+ DOMAIN-STRUCTURE-DESIGN.md（DF-1..7、R1–R12）。
> 本轮加严判据：DF-2 单文件从 400 降到 **300**；新增 **DF-8**（require 必须模块顶层）、
> **DF-9**（函数嵌套 ≤6 层）。

## 1. 原状

`src/platform/distribution/index.js` = **690 行**（DS-9/DG-2 的 RED 基线之一），一个文件混：
类骨架 + 镜像源选择/探测（纯+IO）+ 选版算法（纯）+ npm 安装执行 + 端口健康 + 版本检查（IO）。
零子目录、零拆分。

## 2. 实际改动（5 文件，全部扁平，无一超 300）

| 文件 | 行数 | 性质 | 内容 |
|---|---|---|---|
| `index.js` | **85** | 门面（组合+导出） | `DistributionManager` 构造 + 16 个一行委托 + 6 项导出 |
| `release.js` | 97 | **纯** | `OUR_RELEASE_SCOPE / isOurReleasePackage / highestVersion / pickReleaseVersion`（§3 唯一实现，逐字搬迁） |
| `policies.js` | 90 | **纯** | 兜底镜像表、origin 规范化/合法性、候选解析、契约+配置合并、探测规格展开、最快可达选取、灰度谓词 |
| `registry.js` | 244 | IO | 契约 TTL 重载、配置载入/落盘（保留壳 v2 字段）、探测、选源、registryInfo、setRegistryConfig |
| `install.js` | 196 | IO | `fetchNpmLatest/fetchGithubLatest/fetchLatestVersion`、`runNpmInstall`、`waitPortHealthy` |

依赖图（DF-7 单向，0 环）：

```
index → registry → policies → shared/version
      → install  → registry, release, policies
      → release  → shared/version
      → policies
```

## 3. 手法与判据落点

- **DF-4 零 `this` 跨文件**：非门面 4 文件**完全不出现 `this.`**（实测 0 处）。
  有状态 IO 函数采用**手法 C（参数显式化）**：`selectRegistry(state, force)`、
  `saveRegistryConfig(state)`…… 状态（contract/registryConfig/selectedRegistry/canary/
  _contractLoadedAt）仍由门面实例持有，作为显式入参传递 —— 不做 mixin、不合并方法集到同一 this。
- **DF-3 纯/IO 不混**：`release.js`+`policies.js` 零 IO require；`registry.js`+`install.js` 只做 IO。
- **DF-6 可独立 require 可测**：`policies.js`/`release.js` require 即用纯函数；
  `registry.js`/`install.js` 可 require 后传**假 state** 单测（既有 `Object.create(prototype)` 用例即此种）。
- **DF-8 顶层 require**：4 文件全部 `require` 在模块顶层（acorn 扫描 inline=0；`require(x).current()` 亦为顶层）。
- **DF-9 嵌套 ≤6**：acorn 实测最大函数嵌套深度 —— index 1 / policies 2 / registry 2 / release 2 / install 3。
- **DS-G4 平台层无域名词**：去注释源码对 `router/lan-daemon/router-daemon/proxyInstance/
  providerApi/dsh-main/frpc` 命中 **0**。

## 4. 与设计的偏差（如实）

1. **`policies.js` 的“形态判定”名不副实**：派工单写 “形态判定（纯）/ text launcher / sea-binary”，
   但**实测 `platform/distribution` 内并无 deploy 形态逻辑** —— 形态判定（`isLauncherForm` /
   `'sea-binary'`）实测住在 `src/platform/contract/deploy.js`，其消费方在 `app/settings/versions.js`
   （见 `test/round8-fixes-test.js` J-a/J-f）。故 `policies.js` 承载的是**本域真正的纯策略**
   （镜像合法性 / 探测规格 / 配置合并 / 选源决策 / 灰度谓词）。**不是漏改**。
2. **fetchLatest 落在 `install.js` 而非 `registry.js`**：它需要选源 + 选版算法 + `VERSION_RE`，
   归入 “IO 编排” 一侧比塞进 registry 更顺（保持 registry ≤250）。
3. **门面保留 2 个一行私有委托**（`_platformTag` / `_inCanaryList` 之外还有 `_loadRegistryConfig` 等）：
   为兼容既有行为级用例（`Object.create(DistributionManager.prototype)` 直接调私有方法）。

## 5. 测试读取面同步（EXECUTION-CONTRACT §4.5）

distribution 有大量**把断言钉在 index.js 源码**上的既有门禁；文件搬移后必须同步读取面，
否则判据**静默失去覆盖面**。按既有范式（读整个目录、只改读取面、阈值/语义逐字不变）：

| 测试 | 原读取面 | 改后 |
|---|---|---|
| runtime-contract-test R-4 | index.js | 目录聚合 |
| npm-resolution-test C-d | index.js | 目录聚合 |
| arch-validation-test A-b | index.js | 目录聚合（行为 `_platformTag()` 仍走门面，不变） |
| four-platform-behavior-matrix P-6 | — | **不改**（行为级，`_platformTag` 仍在 prototype） |
| release-channel-test 防回归/唯一实现 | index.js | 目录聚合 + 形态无关正则（`isInCanaryList`/`async function fetchNpmLatest`） |
| release-channel-gate-test RC-G3 结构 | index.js | 目录聚合 |
| round13-csp-probe-test B | index.js | 目录聚合 + `async function probeOrigin(` |
| round13-contract-reload-test A | index.js | 目录聚合 + 自由函数形态正则 |
| round8-fixes J-c/J-i/J-j | index.js | 目录聚合（J-j 定位 `function saveRegistryConfig(`） |
| instance-upgrade R2-c | index.js | 目录聚合 |

**未放宽任何阈值/不变量**；反向自检（门禁非空转）全部保留。

## 6. 验证（实跑 `node --require ./test/_preload.js`）

我的范围内全绿（22 项基线 → 改动后逐项比对）：

```
release-channel-test            0    version-vectors-test            0
shell-safety-net-test           0    four-platform-behavior-matrix   0
platform-matrix-single-source   0    platform-layer-portability      0
upgrade-test                    0    runtime-contract-test           0
npm-resolution-test             0    arch-validation-test            0
release-channel-gate-test       0    round13-csp-probe-test          0
round13-contract-reload-test    0    round8-fixes *(见遗留②)*       0*
instance-upgrade-test           0    package-root-test               0
kernel-update-single-writer     0    cross-platform-test             0
directory-structure-gate-test   0    layering-and-dependency-gate    0
domain-structure-gate-test      0
```

- **三结构门禁不退化、且 RED 清单收缩**：DS-9（门面 ≤150）与 DS-9/DG-2（≤400）
  不再列出 `platform/distribution/index.js`（690 → 85）。反向自检全部 PASS。
- round8 J-c/J-i/J-j 8 条断言**单独复跑全 PASS**（该文件因遗留①提前中止，见下）。

## 7. 遗留（非本代理范围，已报主代理）

1. **`src/platform/os/{pidlookup,autostart}.js` 正在并行迁移**（`pidlookup.js → pidlookup/` 已完成，
   `autostart.js` 迁移进行中）。`test/cross-platform-architecture-gate-test.js`（CP-3 缺
   `autostart.js,pidlookup.js`）与 `test/platform-layer-portability-test.js`（X-4 子进程
   `Cannot find module ./src/platform/os/autostart.js`，53 passed/8 failed）因此 FAIL。
   **与本轮改动无关**（本代理未触碰 `src/platform/os`；基线时两测试均 PASS）。
   需 **platform/os 的所有者**同步读取面/门禁到新路径。
2. `test/all-platforms-test.js` T6-a「内核零运行时依赖」因 `package.json` 新增 `acorn` FAIL ——
   属该依赖引入者/门禁所有者的范围（非 distribution）。
3. `registry.js` **244 行**，贴近目标 ≤250；后续若继续加功能须先再拆（未超 DF-2 的 300）。
4. `index.js` 的 `_platformTag`/`_inCanaryList`/`_loadRegistryConfig`/`_saveRegistryConfig`/
   `_probeRegistry`/`_registryOrigins` 仍作**一行委托**保留在门面 —— 纯为兼容既有私有方法级用例；
   若后续测试改为直接测 `registry.js`/`policies.js` 具名导出，可删去以进一步纯化门面。
