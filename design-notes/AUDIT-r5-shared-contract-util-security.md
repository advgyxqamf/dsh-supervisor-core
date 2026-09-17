# AUDIT r5 - src/shared + src/platform/contract + util + security

轮次：第五轮（死代码清理 / 注释精简 / 注释符号清理 / 四维审计）
范围（独占）：src/shared/**、src/platform/contract/**、src/platform/util/**、src/platform/security/**
约束遵守：未运行任何测试或门禁（未执行 npm test / node test/*.js）；只做 node --check、grep、wc、git 只读检查。
未 commit / push；未改 package.json；未加依赖；未启动任何守卫或 daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh。

## 一、改动清单（12 个文件，均由 update 写入）

| 文件 | 改动性质 |
| --- | --- |
| src/shared/guardian.js | 注释精简 |
| src/shared/ip.js | 注释精简 |
| src/shared/version.js | 注释精简 |
| src/platform/contract/deploy.js | 注释精简 + 去掉未用导出 isBinaryExecutable |
| src/platform/contract/matrix.js | 注释精简 |
| src/platform/contract/registry.js | 注释精简 + 去掉未用导出 REASON + 合并冗余分支 |
| src/platform/contract/runtime.js | 注释精简 + 去掉未用导出 file |
| src/platform/util/exec.js | 注释精简 + 去掉未用导出 DEFAULT_MAX_BUFFER |
| src/platform/util/fs.js | 注释精简 |
| src/platform/util/probe.js | 注释精简 |
| src/platform/util/srcpath.js | 注释精简 + 去掉未用导出 resolveSrcRoot |
| src/platform/security/identity.js | 注释精简 + 去掉未用导出 socketIsLoopback |

## 二、删除依据（全仓 grep，含 test/、字符串形态、门禁）

删除前逐符号在整仓（排除 node_modules/.git，含无扩展名的 bin/ 脚本与非 js 文本）grep，确认唯一引用是自身定义/内部调用：

1. deploy.js `isBinaryExecutable`：仅 deploy.js:33 定义、deploy.js:95 内部调用。detect() 仍需要它，故保留函数体，仅从 module.exports 去掉。
2. security/identity.js `socketIsLoopback`：仅 identity.js 内部被 identify() 调用；api/identity.js 只解构 identify。保留函数体，去掉导出。
3. util/exec.js `DEFAULT_MAX_BUFFER`：仅 options() 内部使用。保留常量声明（门禁 G9-d 需要源码含 maxBuffer），去掉导出。
4. util/srcpath.js `resolveSrcRoot`：仅 resolve()/describe() 内部使用。保留函数体，去掉导出。
5. contract/registry.js `REASON`：仅 read() 内部使用；消费者 platform/distribution/registry.js 只调 read()。去掉导出。
6. contract/runtime.js `file`：曾按「仅 read() 内部使用」去掉导出，**该判断错误** ——
   test/native-dsh-binding-test.js:123 调 `rc.file()` 定位契约写入路径（消费漏检）。
   CI run 35196507963 以 `rc.file is not a function` 检出，已恢复导出并加注释。

保留不动的、易被误判为死代码的项：
- supervisor.js、各 daemon.js 为入口；各 contract.js 被门禁以 fs 读取。本范围内无孤儿文件：12 个文件全部有生产或门禁引用。
- `matrix.isSupported` 无 src 生产消费者，但被 test/four-platform-behavior-matrix-test.js、test/platform-matrix-single-source-test.js 引用，属门禁引用，保留。
- `matrix.osTag` 仅被 app/self/notify.js、app/settings/versions.js 使用，保留。
- `matrix.npmTag` 的抛错文案 `不支持的平台组合` 是测试断言的对外契约，原样保留。
- `runtime.SUPPORTED_SCHEMA` 被 test/runtime-contract-test.js 断言；`registry.SUPPORTED_SCHEMA` 被 test/package-root-test.js 断言；`exec.DEFAULT_TIMEOUT_MS` 被门禁 G9-d 以源码正则引用。以上均保留。

冗余代码合并（等价）：
- registry.js `if (!file) return Object.assign({}, empty, { reason: REASON.NO_FILE });` 中 empty.reason 本就是 REASON.NO_FILE，改为 `if (!file) return empty;`。empty 每次调用新建，无共享可变状态，行为等价。

未找到可确认的重复实现（范围内）。范围内 12 个文件未发现第二份 semver / IP / 平台映射实现。

## 三、等价性验证（静态）

对 12 个文件做了 node --check（全部通过）。另用注释剥离器对 HEAD 版本与工作区版本做去注释代码比对，
确认差异仅有如下 7 处（全部为上述导出删除 + registry 冗余分支）：

- deploy / runtime / exec / srcpath / identity：仅 module.exports 一行。
- registry：`if (!file)` 一行 + module.exports 一行。

其余改动全部落在注释，代码逐字节等价。未做任何行为变更。

## 四、注释统计（注释行 = 以 //、/*、* 开头的行）

| 文件 | 改前 | 改后 |
| --- | --- | --- |
| guardian.js | 47 行 / 14 注释 (30%) | 37 行 / 4 注释 (11%) |
| ip.js | 38 / 11 (29%) | 31 / 4 (13%) |
| version.js | 66 / 23 (35%) | 49 / 6 (12%) |
| deploy.js | 117 / 54 (46%) | 77 / 14 (18%) |
| matrix.js | 118 / 55 (47%) | 80 / 17 (21%) |
| registry.js | 145 / 50 (34%) | 112 / 16 (14%) |
| runtime.js | 78 / 22 (28%) | 67 / 11 (16%) |
| exec.js | 138 / 68 (49%) | 87 / 16 (18%) |
| fs.js | 37 / 5 (14%) | 34 / 2 (6%) |
| probe.js | 73 / 11 (15%) | 67 / 4 (6%) |
| srcpath.js | 138 / 76 (55%) | 76 / 14 (18%) |
| identity.js | 52 / 34 (65%) | 28 / 10 (36%) |
| 合计 | 1047 / 423 (40.4%) | 745 / 118 (15.8%) |

说明：identity.js 仍为 36%，因其代码体只有两个短函数，10 行注释多为信任根/归属契约等必须保留的非显然信息。
保留的均是非显然的 WHY、外部契约与不变量、陷阱与反直觉点（如 exec 的成功可能返回 null、semver 首个连字符切分、
registry 的 C2 降级、srcpath 的存在性验证、身份判定的信任根）；删除的是 WHAT 复述、变更历史/日期叙事、逐行解释。

## 五、注释符号清理

清除了全部本轮禁用字符：框线 (U+2550)、箭头 (U+2192/U+21D2)、警示 (U+26A0)、带圈数字 (U+2460/2461/2462)、
中点 (U+00B7)、省略号 (U+2026)、乘号 (U+00D7)、章节号 (U+00A7)。改用纯文本（注意、正确、错误、要点 / 顿号等）。

唯一残留的非 ASCII 符号是 matrix.js:43 错误信息字符串里的乘号 U+00D7（`不支持的平台组合: ... × ...`）：
它是代码字符串而非注释，且测试可能断言该文案；按任务约定（代码字符串、正则、断言文案按需保留）与“不做行为变更”原则，未改动。

## 六、门禁静态核对（未运行，仅比对其断言的字符串/导出）

- test/round8-fixes-test.js：deploy 需含“不再是 SEA”，且导出 isLauncherForm；已保留（module.exports 去掉的只是 isBinaryExecutable）。
- test/arch-validation-test.js：matrix 需含 `const OS_TAG = {` 与 `不支持的平台组合`；已保留。
- test/release-channel-gate-test.js：registry 源码不得含 dist-tags/disttags；已保留（新注释未引入）。
- test/package-root-test.js：registry 导出 read 与 SUPPORTED_SCHEMA；已保留。
- test/runtime-contract-test.js：runtime 导出 read/npmBin/withPath/SUPPORTED_SCHEMA；已保留。
- test/srcpath-gate-test.js：srcpath 导出 describe、resolvePackageRoot；已保留（去掉的是 resolveSrcRoot）。
- test/exec-bounded-gate-test.js：exec 源码需命中 killSignal...SIGKILL、windowsHide: true、maxBuffer、DEFAULT_TIMEOUT_MS = 数字；已保留（execFileSync 仍仅在本文件）。
- test/kernel-update-single-writer-test.js：fs.js 不得含 extractTarGz；已保留（未引入）。
- test/layering-and-dependency-gate-test.js / test/relay-source-gate-test.js：require 边未变，shared/ip 的 isLoopbackAddress/isPrivateIpv4 导出未动。
- test/directory-structure-gate-test.js DS-G4：platform 去注释源码不得含域名词；新注释中的 router/lan 等只在注释里，会被 strip 去除，代码未引入域名词。

## 七、四维审计发现

### 架构设计
- 分层归属一致：shared 为出度 0 的纯函数；platform/contract 是外部既定事实（矩阵/部署形态/契约）；platform/util 为无状态工具；platform/security 只承载 HTTP 身份。未发现越层依赖。

### 业务逻辑
- 未发现可确认的逻辑错误。registry.read 的 5 个 reason 分支与 schema 1/2 兼容逻辑自洽；exec.run 的成功返回非 null 约定与其对调用方的契约一致。
- 观察（未改，属行为问题）：guardian.instanceRestartDecision 的 nextBackoffLevel 无上限增长，消费者仅用 Math.max(waitMs, 5000) 封顶等待，计数增长本身无副作用。

### 规范标准
- 本轮已清除范围内注释中的禁用符号。
- 观察（跨范围，未改）：platform/contract/registry.js 的私有 normOrigin 与 platform/distribution/policies.js 的 normalizeOrigin 是同一事实的两份实现，语义有细微差异（registry 对非字符串返回空串，policies 对非字符串先 String() 强转）。二者分属不同独占范围，且属行为差异，未改动，建议后续在 distribution 侧统一或显式说明差异。

### 功能设计
- 未发现可确认的功能缺陷。
- 观察（未改，跨平台待 Windows 验证）：runtime.withPath 读取 `e.PATH || e.Path`，但只写回 `e.PATH`。若调用方传入带 `Path` 键的 Windows 环境对象，可能同时出现 Path 与 PATH 两个键；依赖 Node/libuv 在 Windows 上的大小写处理。runtime-contract-test 只覆盖 PATH 形态，故本机无法证实，未做行为改动。
- 观察（未改）：ip.isLoopbackAddress 接受字面量 'localhost'，而 socket.remoteAddress 实际不会返回该值；属防御性冗余，无害。

## 八、未执行项 / 交由主代理
- 本机未运行任何测试与门禁，验收由 CI 裁决。
- 上述“观察（未改）”项均属其它独占范围或行为变更，留给主代理裁定。