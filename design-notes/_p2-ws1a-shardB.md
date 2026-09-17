# WS1-a 分片 B：`src/platform/os/**` 注释精简 + 死代码普查

> 交付物（本文件）。范围 = 作业单 §3 中 WS1-a 分给本分片的 18 个 `.js`。
> **本版按作业单 §7（形式钉子登记表 v2，取代 §6）重述**；全部路径为仓库相对路径，不含操作者绝对路径。

## 0. 范围与硬约束合规

- **独占 18 文件**（清单见 §1），未触碰任何其他 `src/**`、未改 `test/`、`bin/`、`package.json`、`CHANGELOG.md`、`.github/`。
- **只删注释，代码零变化**：程序化核对（`git show HEAD:<file>` 与工作区文件各自剥离块注释/行注释后逐行比较）→ 18/18 均为 `COMMENT-ONLY`，无任何代码字符改动。
- **未运行任何测试/门禁**；只用 `node --check`、`grep`、`read`、`git diff/status/show`（只读）。
- 无任何 git 写操作；未启动 daemon；未触碰 `/tmp/dsh-*` 与状态根。
- 未做结构重构、未改文件名、未移动代码；未写回 emoji/框线/箭头/带圈数字（删除后的新增行仅为被保留文本的子串）。

## 1. 文件清单（每文件一行理由）

| 文件 | 变更 | 理由 |
|---|---|---|
| `src/platform/os/autostart/darwin.js` | −1 | 删行内 `// 原子写`（复述 WHAT；该 3 字片段低于 §7.3 的 ≥4 字阈值，仅 token-contract 测试自身注释含该词，非判据）。其余注释均含受保护 token（`launchd`/`RunAtLoad`/`KeepAlive`/`Aqua`）或属所有权契约/陷阱，保留。 |
| `src/platform/os/autostart/index.js` | −2 | 删 DI 一句（`DEPS` 自解释）与 `/** 服务链自启（守卫 + 面板）。 */`（函数名即语义）。头注所有权矩阵/历史事故教训保留。 |
| `src/platform/os/autostart/linux.js` | −3 | 删两行 WHAT 型 JSDoc（`守卫（systemd --user unit）自启状态`、`服务链自启`）与行内 `// 原子写`。含「桌面壳」的 GUI 行按 §7.3 token 命中保留（见 §2）。 |
| `src/platform/os/autostart/win32.js` | −1 | 删 `GUI 壳登录自启开关（schtasks…）` 一行 WHAT。**第 5 行 D-8 钉子未动**。 |
| `src/platform/os/browser.js` | −3 / +1 | 删行内 `// 兜底：无隔离` 与 launchIsolated 两行纯类型 `@param`。Windows `start` 空标题陷阱、未知平台退化、error 递归前先注册的 WHY 保留。 |
| `src/platform/os/capability-profile.js` | −1 | 删 `// 声明与实现一致（回归 test/process-tree-kill-test.js）。`（验证/历史注记）。其下一行 processTreeKill 行内注释受 G-d token 保护，保留；逐字段契约注释保留。 |
| `src/platform/os/desktop.js` | −4 | 删四个「函数名即语义」的一行 JSDoc（hasX11Socket/hasWaylandSocket/sessionAvailable/describe）。图形会话平台差异头注与 describe 必须委托的理由保留。 |
| `src/platform/os/exec-path.js` | −9 / +1 | 删 standardDirs 的纯类型 `@param` 表、resolveExecutable 两行 `@param`、npxBin/npmBin 的 `@returns` 类型行、dshJsIn 一行 JSDoc。PATHEXT/ENOENT 缺陷教训、platform/env 向下传播的 WHY、两行含 `便于纯函数测试` 的 `@param`（按 §7.3 命中保留）不动。 |
| `src/platform/os/file-protect.js` | −3 | 删 ensurePrivateDir 一行 JSDoc 与 writePrivate 两行纯类型 `@param`。runOut 陷阱、rename 后重保护、保护失败须如实返回的契约保留。 |
| `src/platform/os/index.js` | −3 / +2 | 删 3 处复述缓存策略的行内/行注释（`正结果：永久`、`负结果：TTL 内沿用`、`负结果过期 -> 落到下面重探`）。负结果 TTL 的理由、runOut 陷阱、notify 契约保留。 |
| `src/platform/os/netinfo.js` | −5 | 删 `/* Linux：iproute2 */`、`/* macOS：route + ifconfig */` 平台标签、VIRTUAL_IFACE 一行 JSDoc、lanAddresses 的 JSDoc 摘要与空行（`@returns` 契约保留）。Windows「避免解析本地化文本」的 WHY 保留。 |
| `src/platform/os/notify.js` | 0 | 三端转义规则差异（AppleScript 反斜杠 vs PowerShell 双写）是缺陷教训；平台清单是跨平台契约，保留。 |
| `src/platform/os/pidlookup/index.js` | 0 | 门面分派契约（三端同一接口 + 平台差异下沉 probe/norm）仅两句，均含契约信息，保留。 |
| `src/platform/os/pidlookup/norm.js` | −1 | 删 parsePowerShellCommandLine 一行 JSDoc（实现自明）。重复「纯解析器」段落按 §7.3 命中保留（`非平行实现`/`只能在对应平台验证`）。 |
| `src/platform/os/pidlookup/probe.js` | −3 | 删 lsof 列名、netstat 输出例、wmic 调用三条 WHAT 例注。异 pidns 的 ss 兜底、P1-2 回退理由、BSD/Linux pgrep 差异保留。 |
| `src/platform/os/process.js` | −2 | 删文件头一行 WHAT 摘要与 isAlive 一行 JSDoc。POSIX 进程组信号 vs Windows `taskkill /T` 的平台差异保留。 |
| `src/platform/os/service.js` | −3 | 删 `/* Linux：systemd --user */` 标签、transientUnitFile/current 两行 JSDoc。N5 教训、opts 原样透传契约、CapabilityError 语义保留。 |
| `src/platform/os/spawn.js` | −15 / +3 | 删三入口的纯类型 `@param`/`@returns` 表。`windowsHide` 契约与 detached/窗口隐藏正交的取舍说明保留。 |

合计：**16 文件变更，9 insertions / 59 deletions（净 −50 行），全部为注释**。
未变更 2 文件：`notify.js`、`pidlookup/index.js`（注释均承载契约/跨平台差异，无可删项）。

## 2. 形式钉子与 §7.3 保留项（按 §7 口径）

### 2.1 §7.1 真·注释钉子（本分片仅 1 条）

| 受保护字样 | 判据 | 对应测试 | 位置 | 处置 |
|---|---|---|---|---|
| `所有者` 后 12 字内 `桌面壳` | `/所有者[^\n]{0,12}桌面壳/`（对 `autostart/**` 未剥注释聚合源码匹配） | `test/kernel-daemon-contract-test.js:109`（D-8） | `src/platform/os/autostart/win32.js:5` | **原样未动** |

静态复核：本分片改完后用 JS 正则复算 `D-8=true`（`所有者都是桌面壳`）；本分片对 win32.js 只删了另一行 `GUI 壳登录自启开关…` JSDoc。

### 2.2 §7.3 token 命中而保留的注释行（非 §7.1 表列）

| 位置 | 命中 token（≥4 字 CJK / ≥6 字符 ASCII，`grep -F test/`） | 备注 |
|---|---|---|
| `capability-profile.js:45` 行内注释 `…使用点见 main-process._killTree` | ASCII `_killTree` → `test/process-tree-kill-test.js`（G-d 判据要求 `processTreeKill: true` **同行**出现 `_killTree`） | 实质等同注释钉子，保留 |
| `autostart/linux.js:48` `/** GUI（桌面壳）登录自启 —— XDG autostart .desktop（Exec 按实际安装解析）。 */` | `autostart`（8 个测试文件）、`.desktop`（5 个测试文件）、`按实际安装解析`（`test/platform-capability-audit-test.js`） | 按 §7.3 命中 → 保留（v1 §6 #10 宽口径已作废，本次系 token 命中） |
| `exec-path.js:96` 与 `:115` `@param … platform 可注入，便于纯函数测试` | ASCII `platform`；CJK `便于纯函数测试` → `test/platform-layer-portability-test.js` | 保留 |
| `pidlookup/norm.js:7-8` 重复「平台输出纯解析器」段落 | CJK `只能在对应平台验证`、`非平行实现` → `test/platform-parsers-and-commands-test.js` | 保留 |

### 2.3 §7.2 澄清

- v1 §6 #7「`守卫服务定义缺失`」（darwin.js）实为 `errors.push` 的**代码字符串**（§7.2），**不是注释钉子**；本分片未改动该代码行（注释精简本就不动非注释字符）。静态复核仍满足 `autostart-ownership-test.js:52/57` 与 `platform-capability-audit-test.js:244`。
- v1 §6 #10 宽口径作废。本分片不再据此保护「仅含桌面壳」的行；其保留完全取决于 §7.3 token 命中。
- 本分片不涉及 §7.1 的其余 4 条（`config.js`、`entry.js`、`deploy.js`、`instance/ops.js`）与 §7.5 排除的 `bin/dsh-supervisor`。

### 2.4 已删注释的 §7.3 证据（≥4 字 CJK / ≥6 字符 ASCII token 在 `test/` 零命中）

- `原子写`（3 字，低于阈值；唯一原始命中为 token-contract 测试**自身注释**，非判据）、
- `正结果：永久`、`负结果：TTL 内沿用`、`负结果过期`、`落到下面重探`（均在 index.js），
- `虚拟/环回网卡前缀`、`地址枚举应排除`、`枚举本机局域网可访问`、`已去重的地址列表`（netinfo.js），
- `平台进程控制`、`存活探测`（process.js），`声明与实现一致`（capability-profile.js），`判定依据`、`得出该结论`（desktop.js），
- 以及 `/* Linux：iproute2 */`、`/* macOS：route + ifconfig */`、三条 WHAT 例注、各纯类型 `@param`/`@returns` 表。

## 3. 导出/函数/常量增删（R2 全仓证据）

**本分片删除 0 个、改写 0 个导出/函数/常量；新增 0 个。**

R2 核验命令（排除 `node_modules`、`.git`）：`grep -rInE "\b<symbol>\b" src test bin release ui *.md design-notes`

- 本分片全部导出均有消费者。关键证据：
  - `dshJsIn` ← `test/native-dsh-binding-test.js`；`candidateNames/standardDirs/npmBin/npxBin/resolveExecutable/resolveDsh` ← `test/cross-platform-test.js`、`test/npm-resolution-test.js`、`test/platform-layer-portability-test.js`、`test/native-dsh-binding-test.js`。
  - `openCommand/isolatedPlan` ← `test/platform-layer-portability-test.js`；`launchIsolated/open` ← `src/domains/router/ops/browser.js`、`test/token-contract-gate-test.js`。
  - `notifyCommand/appleScriptString/powerShellString/notify` ← `test/platform-parsers-and-commands-test.js`、`test/cross-platform-test.js`。
  - `xmlEscape/macGuiPlist/macSetEnabled/GUARD_LABEL/GUI_LABEL` ← `test/escape-validation-test.js`、`test/platform-capability-audit-test.js`、`test/autostart-ownership-test.js`。
  - `hasIcacls/writePrivate/protectFile/protectDir/ensurePrivateDir/IS_WINDOWS` ← `test/exec-return-contract-test.js`、`test/platform-audit-fixes-test.js`、`test/cross-platform-test.js`、`src/app/assembly/compose/core.js`、`src/platform/service/token/persist.js`。
  - `normCmdline` ← `src/app/daemons/process.js`、`src/app/daemons/probe.js`、`test/round8-fixes-test.js`；`readCmdline/isDshCmdline/pgrepList` ← `src/app/main/*`、`src/platform/service/monitor.js`、`src/domains/relay/frp.js`、`test/shell-watchdog-test.js`。
  - `isAlive/signalProcess/killTree` ← `src/app/main/*`、`src/domains/*`、`test/process-tree-kill-test.js`。
- **零外部消费者但同文件内有真实调用点 → 按 R2「宁可保留」保留**：`laFile`、`macLoaded`、`macBootstrap`、`macBootout`（darwin.setAutostart/setGuiAutostart 调用）、`currentUser`（protectFile/protectDir 调用）、`linuxListeningInodes`（linuxFind 调用）、`VIRTUAL_IFACE`（pick 调用）。它们文件外仅被 `design-notes/AUDIT-r5-dead-code-census.md` 提及，无 `test/`/`bin/` 消费者，但非死代码。
- **特别声明（事故 B 相关）**：`src/platform/contract/runtime.js` **不在本分片清单，未被本分片触碰**。静态核对：`module.exports = { SUPPORTED_SCHEMA, file, read, npmBin, withPath }` 仍含 `file`（满足 `test/native-dsh-binding-test.js:123`）。当前共享工作区中该文件由**他人**显示为未提交修改（`git status` → ` M`），提交前请复核。

## 4. 死代码普查结果

- 无被注释掉的代码块（`grep -nE '^\s*//\s*(const|let|var|function|return|if|for|while|fs\.|ex\.|exec|spawn|module|class)'` 零命中）。
- 无「明显无消费者的局部变量」：`_icacls`、`_toolCache`、`byIface`、`cur`、`guiFile_`、`idx`、`atmp/atmp2`、`DSH_PKG` 等均有读写点。
- 无恒真/恒假分支：`hasTool` TTL、`isUnitActive(!unit)`、`sessionAvailable` 平台回退、`macLoaded` try/catch 均为有意语义。
- 无重复实现：`pick/sessionAvailable/openCommand/isolatedPlan/notifyCommand` 等已是单一实现，生产直接调用。
- 结论：**死代码层面无可删项**；未删任何导出/函数/常量（R2 见 §3）。

## 5. `node --check` 结果

18/18 通过，0 FAIL（逐文件 `node --check`）。最终 `git diff --numstat` 合计：**9 insertions / 59 deletions**（净 −50 行），16 文件，全部为注释；另 2 文件（`notify.js`、`pidlookup/index.js`）未改。

## 6. CI 风险点

1. **形式钉子**：§7.1 本分片唯一真钉子 `autostart/win32.js:5`（D-8）**未动**且静态复算通过；另 4 行按 §7.3 token 命中保留（capability-profile `_killTree`、autostart/linux GUI 行、exec-path 两行 `@param`、norm 段落）。建议主控提交前复算 D-8 正则与 G-d 同行正则。
2. 本分片**仅动注释**（程序化 `COMMENT-ONLY` 核对 18/18）；相关门禁多数先 `stripComments` 或只匹配代码形态 → 判据面不变。
3. 少数门禁对**未剥注释**源码做**负向**断言（`!/function macPlist/`、`!asSrc.includes("'/TN', 'DSH-Supervisor-Watchdog'")`、`!/writeFileSync\([^)]*watchdog\.ps1/`）：未新增此类字样，删除的注释也不含。
4. 共享工作区含大量**他人**未提交改动（`src/domains/**`、`src/app/**`、`src/api/**`、`test/**`、`package.json`、`src/platform/contract/runtime.js` 等）。本分片未触碰，请按分区分别裁决。
5. 本报告与本分片产物均不含操作者绝对路径。
