# WS1-a 分片 A：注释精简 + 死代码普查报告

范围：WS1-a 分片 A 独占的 15 个文件（src/platform/ 下 contract、ctl、distribution、util、security）。
约束遵守：未运行任何测试或门禁（仅 node --check / grep / read / wc / git 只读）；未做任何 git 写操作；
未启动 daemon、未触碰 /tmp/dsh-* 与状态根；未改 package.json、test/、他人文件；仅改注释，代码零变化。

## 1. 改动文件清单（7 文件，每文件一行理由）

| 文件 | 改动 | 理由 |
|---|---|---|
| src/platform/contract/registry.js | 删 2 行 | 「本内核支持的契约版本」「规范化一个 origin（去尾斜杠）」是对紧邻常量/一行的纯 WHAT 复述。C2/C3 与 probe/schema 契约注释保留。 |
| src/platform/contract/runtime.js | 删 2 行 | 「本内核理解的契约 schema」「契约文件路径」纯 WHAT。file 导出的事故教训注释与 C2 注释保留。 |
| src/platform/distribution/install.js | 删 1 行 | 私有 portListening 的「单次端口连通探测」纯 WHAT。 |
| src/platform/distribution/policies.js | 删 1 行 | normalizeOrigin 的「去掉首尾空白与尾部斜杠」与代码重复，纯 WHAT。 |
| src/platform/distribution/registry.js | 删 1 行 | registryOrigins 的「生效的候选 registry 列表」纯 WHAT。 |
| src/platform/distribution/release.js | 删 4 行 | isOurReleasePackage / highestVersion 的 JSDoc @param/@returns 与散文重复（§2「重复 JSDoc 参数表」）。冻结算法的散文与 pickReleaseVersion 契约 JSDoc 保留。 |
| src/platform/util/srcpath.js | 删 3 行 | resolvePackageRoot 内两处行内注释与函数 JSDoc 重复；JSDoc 末句「同类缺陷曾因固定相对路径推算而失效」为历史叙事。“比固定层数稳健”这一 WHY 保留。 |

未改动文件（8 个；注释均属非显然 WHY、契约不变量、陷阱事故、跨平台差异或安全语义，无 §2 白名单内容可删，或为形式钉子）：
deploy.js、matrix.js、ctl/server.js、distribution/index.js、util/exec.js、util/fs.js、util/probe.js、security/identity.js。

（全部 15 文件均已完成注释口径复核；未做任何结构重构、未改文件名、未移动代码。）

## 2. 形式钉子与 §7.3 片段复核（§7 取代 §6）

按 §7.3 对 v1 保留/回退过的行逐行复核：把注释行切成 CJK ≥4 字片段与 ASCII ≥6 字符片段，
各自 `grep -F` 于 test/（块注释同样参与匹配）。结果：

| 行 | 候选片段 | grep -F test/ | 处置 |
|---|---|---|---|
| distribution/index.js:3 | domains/dist（12 ASCII） | **命中（5 处）**：directory-structure-gate-test.js 依赖样本 `{ from: 'domains/router', to: 'domains/dist' }`、layering-and-dependency-gate-test.js:79、arch-validation-test.js、directory-structure-gate-test.js | 整行**保留**（§7.3 命中即保留）；v1 回退后维持原样 |
| distribution/index.js:3 | 域解体上移（5 CJK） | 0 命中 | 因整行已被 domains/dist 命中而整行保留 |
| ctl/server.js:116 | 复检根治（4 CJK） | **命中**：reconcile-instance-test.js:273 | 保留；该行本身是 keepAlive 陷阱 WHY |
| runtime.js:66-67 | 必须导出 / rc.file is not a function / 消费漏检（ASCII、CJK） | 0 命中 | 非 §7.3 钉子；按 §2「陷阱与事故教训」并 R2（file 导出有 test 消费者）保留 |

- deploy.js:4「不再是 SEA」：WS1-a 的钉子（test/round8-fixes-test.js:73），但本分片全程未改 deploy.js，无需动作。
- 结论：本分片**没有仅因 v1 而多留的可删行** —— v1 唯一回退的 distribution/index.js:3 经 §7.3 确认命中，
  应保留。故 §7 复核的补完改动为 **0 行**；第 1 节的 17 行删除不受影响（其片段全部 0 命中，见第 6 节）。
- darwin.js「守卫服务定义缺失」与 autostart/**「所有者...桌面壳」不在本分片 15 文件清单内，本分片未触碰。

## 3. 死代码普查与 R2 核验

结论：本分片**未删除、未修改任何导出或函数**，R2 未触发；逐文件核对后未发现可安全清除的明显死代码。

- 无消费者的局部变量/函数：逐文件核对，无。所有非导出辅助（isBinaryExecutable、sanitizeOrigins、
  normOrigin、options、_candidateRoots、socketIsLoopback、portListening 等）均在文件内被使用。
- 恒真/恒假分支：grep `if (true`、`if (false`、恒真/恒假 -> 0 命中。
- 被注释掉的代码块：仅 ctl/server.js 模块头第 26-29 行一段「调用方摘要」用法示例（文档示例，非死代码），保留。
- 重复实现（登记，未动）：src/platform/distribution/install.js 的私有 `portListening(host, port)` 与
  src/platform/util/probe.js 导出的 `portListening(host, port, timeoutMs)` 逻辑近同构。去重需改调用或移动代码，
  违反“不做结构重构、不移动代码”，故保留并在此登记。
- 导出消费者抽检（全仓 grep，排除 node_modules 与 .git）：
  dirSizeBytes(5，src/domains/plugin/store.js 等)、supportsProcessGroup(17，test/platform-matrix-single-source-test.js)、
  isSupported(13，test/four-platform-behavior-matrix-test.js)、frpTag(32，src/domains/relay/frp.js 等)、
  resolvePackageRoot(6，test/srcpath-gate-test.js、src/app/settings/versions.js)、
  httpProbe(3，src/platform/service/monitor.js)、isLauncherForm(9，test/round8-fixes-test.js)、
  runningTarget(11，src/app/settings/versions.js)、identify(10，src/api/identity.js)、
  waitPortHealthy(16，src/domains/instance/upgrade.js、test/instance-upgrade-test.js)、
  fetchGithubLatest(6)、pickFastestReachable(3)、rebuildRegistryConfig(3)、
  isInCanaryList(6，test/release-channel-test.js)、DEFAULT_TIMEOUT_MS(16，test/exec-bounded-gate-test.js、ui/src/services/supervisor/client.ts)。
- 特别核验（事故 B 防线）：src/platform/contract/runtime.js 的 `file` 导出在 src 内无消费者，
  但有 test 消费者 test/native-dsh-binding-test.js:123 `const rcFile = rc.file();`，**保留未动**。

## 4. node --check 结果

对全部 15 个独占文件逐一 `node --check`，全部 exit 0（ALL_OK）：
deploy.js、matrix.js、registry.js(contract)、runtime.js、server.js(ctl)、index.js(distribution)、
install.js、policies.js、registry.js(distribution)、release.js、exec.js、fs.js、probe.js、srcpath.js、identity.js。

## 5. CI 风险点

- diff 已在机器层面校验：git diff 中 17 行删除 + 3 行改写，**全部为注释行，非注释变更 0**，代码零变化。
- 已按 §7.3 复核所有保留行（片段命中者保留）；已按 R2 不删任何导出；已守住 runtime.js 的 file 导出。
- 会读本批文件的源码正则门禁（抽检）均只依赖代码或不冲突的注释，本批删改未触及：
  - test/arch-validation-test.js 读 matrix.js（`const OS_TAG = {`、`不支持的平台组合`）与 distribution/*.js 聚合（`return matrix.npmTag()`、负向 osMap/archMap）。
  - test/release-channel-test.js 与 release-channel-gate-test.js 读 distribution/*.js（`canary === true`、`function highestVersion(` 唯一性、`isValid: ... VERSION_RE.test`）与 contract/registry.js 负向 `!/dist-?tags/`。
  - test/package-root-test.js 读 distribution/index.js 负向 `!/const REGISTRY_PRESETS = \[/`。
  - test/kernel-update-single-writer-test.js 读 util/fs.js 负向 `!/extractTarGz/`。
  - test/runtime-contract-test.js、test/native-dsh-binding-test.js require runtime.js（file 导出保留）。
  - test/srcpath-gate-test.js 的 G10-b 对 srcpath.js 自身豁免。
- 未运行任何测试或门禁（遵守 §0 硬约束）；测试结论由 CI 裁决。

## 6. 自检证据摘要

- 本批 7 文件：git diff --stat 显示均只有注释行增减（registry.js -2、runtime.js -2、install.js -1、
  policies.js -1、distribution/registry.js -1、release.js -4/+2 重排、util/srcpath.js -3/+1 重排）。
- 校验脚本按 git diff 逐行判定：删除行与新增行均满足“空行或注释行”判据（非注释 0）。
- §7.3 复核（本轮）：distribution/index.js:3 因 `domains/dist` 命中 test/ 而保留，故补完改动 **0 行**；
  已删 17 行的特征片段（本内核支持的契约版本 / 规范化一个 origin / 单次端口连通探测 / 去掉首尾空白与尾部斜杠 /
  生效的候选 registry 列表 / @param {string} pkg / @param {Iterable<string>} candidates / @returns {boolean} /
  同类缺陷曾因固定相对路径推算而失效 / 从本模块位置逐级上溯找 package.json / 兜底：cwd 等）逐一 grep -F test/ 均 0 命中。
- 本报告不含操作者绝对路径。
