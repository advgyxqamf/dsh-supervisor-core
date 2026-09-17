# WS1-b-3 报告：plugin 全域 + instance 全域（分片 C，28 文件）

> 上级：`design-notes/_workorder-phase2.md` §0/§1/§2/§5/§6；分片分配：`design-notes/_p2-ws1b-allocation.md`「共同约束」+「分片 C」。
> 范围：`src/domains/instance/**`（10）+ `src/domains/plugin/**`（18）= 28 个 .js。本人未触碰 `test/`、未跑任何测试/门禁、未做任何 git 写操作。

## 0. 摘要

| 项 | 值 |
|---|---|
| 分片文件总数 | 28 |
| 实际改动文件数 | 17 |
| 未改动文件数 | 11（见 §6，均为契约数据/无 IO 叶子/测试形态锁定，按「不确定就保留」不动） |
| 形式钉子保留项 | 1（§2，登记表 #12） |
| 删除的导出 / 函数 / 常量 | **0**（§3） |
| 新增导出 | **0** |
| 代码字符变更 | **0**（§4 逐行核验） |
| `node --check` | 17/17 OK，0 FAIL |

## 1. 改动文件清单（17，每行理由）

口径：§2——删复述代码的 WHAT、逐行解释、重复 JSDoc 参数表、日期/工单叙事；保留 WHY、契约不变量、陷阱与事故教训、跨平台差异、安全语义。全部为「整行删除」或「仅去除行内日期/工单号」，不改任何非注释字符。

### instance（8）

| 文件 | 改动 |
|---|---|
| `src/domains/instance/index.js` | 删 4 条复述代码的访问器 JSDoc（`all/forEach/find/map`）；删「P2-2」工单号；`compose.js:272-294` 精确行号 +「不再读 this.<字段>」过程叙事后半段 |
| `src/domains/instance/state-machine.js` | 删 `setRunning` 的 WHAT 头注；删 `attempts > 20` 的行内逐行解释（该阈值语义在上方函数头注已完整保留） |
| `src/domains/instance/ops.js` | 删 `updateInstance` 的 WHAT 头注（函数名已自述、三个 patch 分支自明） |
| `src/domains/instance/ops/dsh-install.js` | 删 `installLog` 行内 WHAT「(有界)」（有界逻辑本身就是紧邻的 60 行截断代码） |
| `src/domains/instance/sandbox.js` | 删「P2-2 修复」叙事，保留「实时求值 + 60s TTL」WHY |
| `src/domains/instance/store.js` | 删 2026-09 日期叙事，保留「只登记 journald 不登记 file 防旧令牌 block journal」WHY |
| `src/domains/instance/upgrade.js` | 删 `taskLogger`/`portHealthOpts` 两条复述代码的 JSDoc（函数体一行自明） |
| `src/domains/instance/lifecycle.js` | 删「原自愈只认「安装超时」文案」过程叙事，保留「必须自愈拉起否则永久卡死 / 重试超限交用户」WHY |

### plugin（9）

| 文件 | 改动 |
|---|---|
| `src/domains/plugin/index.js` | 删 5 条仅作分组的裸注释（目标解析/只读/CLI/编排）；删 `profileDir` 行内复述注释 |
| `src/domains/plugin/model.js` | 删 4 条复述代码的 JSDoc（MAX_JOBS / isProtectedName / isOwnRow / isOwnDisabled） |
| `src/domains/plugin/jobs.js` | 删 `cleanupJobs` WHAT 头注；删与函数头注重复的行内「// 桥接收尾统一任务」 |
| `src/domains/plugin/policies.js` | 删 `isUpdateAvailable` 的重复 JSDoc（一行纯版本比较） |
| `src/domains/plugin/policies/classify.js` | 删与文件头注重复的「// 分类关键词启发」（关键词表名 `CATEGORIES` 已自述） |
| `src/domains/plugin/policies/market-entry.js` | 删 `npmEntry`/`githubEntry` 两条复述代码的 JSDoc |
| `src/domains/plugin/cli.js` | 删 `CLI_TIMEOUT_MS` 行内 WHAT 注释 |
| `src/domains/plugin/market.js` | 删「30 分钟」算术复述；删 3 条逐行解释（分类排序/分页/并行验证） |
| `src/domains/plugin/updater.js` | 删与同文件 `checkUpdates` 内注释重复的行内「取全量最高」说明 |

## 2. 形式钉子保留项（R1）

**本分片形式钉子 = 1 项，逐字原样保留、未进入 diff：**

| 受保护字样 | 钉住它的测试 | 保护文件 | 状态 |
|---|---|---|---|
| `探测失败不阻断创建` | `test/instance-safety-test.js:155` (`/探测失败不阻断创建/.test(code)`，测试未剥注释) | `src/domains/instance/ops.js:41` | **未动**，逐字保留：`} catch { /* 探测失败不阻断创建：交给启动期如实报错 */ }` |

登记表 #11（`无效的公网端口`/`已被实例「`）归属 `src/domains/relay/core.js`，属分片 B，不在本报告范围。

**R1 取证流程**：本次实际删除/改写的注释特征串共 27 条，逐条 `grep test/`。结论：26 条 0 命中；1 条 `2026-09 修复` 在 `test/upstream-credits-test.js:4`、`test/frp-resilience-test.js:4`、`test/instance-state-test.js:5` 出现——但那是**测试自身头注**对该修复的叙述，非对源码注释的正则断言；且 `grep -r "instance/store" test/` = 0 命中，无测试读取被改的 `src/domains/instance/store.js`。故非钉子。

**新增钉子：0**。未在本人文件内发现登记表以外、由测试未剥注释正则命中的中文/符号注释（`readDomain('src/domains/plugin')` 的断言集中于 `market-net.js`/`cli.js` 的**代码形态**，不依赖注释）。

## 3. 死代码普查（R2）——删除的导出

**删除导出 / 函数 / 常量：0；新增：0。** 28 文件 `module.exports` 面与函数/常量集合与改动前逐字一致。

普查方法：对 28 文件全部导出符号（含 `createX` 工厂、类、纯函数、常量、`PROTECTED` 等）在**全仓** grep（`src test bin release ui *.md design-notes .github app`，排除 `node_modules`/`.git`），核验消费者。要点证据：

- `InstanceManager`：`src/app/assembly/compose/domains.js`(7)、`src/api/domains/instances.js`、`src/domains/relay/ops.js`、`test/native-dsh-binding-test.js`(4) 等 16 处 → 保留。
- `createLifecycle`：`src/domains/instance/index.js` + `test/round13-discipline-gaps-test.js` → 保留。
- `createOps` / `createUpgrade` / `createDshInstall` / `InstanceStore`：`src/domains/instance/index.js` 组装根消费 → 保留。
- `taskStateToView`/`normalizeInstance`/`createRecord`/`viewRow`：域内 `upgrade.js`/`store.js`/`ops.js` 消费 → 保留。
- `state-machine` 四函数（`setRunning/setStopped/fail/restart`）：`instance/lifecycle.js` + `test/instance-state-test.js`（`setRunning`(3)/`setStopped`(4)）→ 保留。
- `sandbox` 七导出：`root/dataDir/installDir/effectiveCommand/unitProps/sandboxEnv/supported` 均被 `instance/**` 或 `plugin/targets.js` 消费；`supported` 另被 `test/platform-layer-portability-test.js`(4) 消费 → 保留。
- plugin：`PluginManager`/`PluginMarket`/`PROTECTED` 由 `app/assembly/compose/domains.js` + `test/plugin-change-restart-test.js`/`market-budget-test.js` 消费；`createJobs`/`createLayers`/`createUpgrade` 等工厂由 `plugin/index.js` 消费；`getJson`/`getText` 由 `test/round8-fixes-test.js:203` 直接读取；其余纯函数/叶子均被域内或 api 消费。

**刻意保留（R2「宁可保留」）**——grep 一度可疑但保留：
- `createJobs` 返回的 `_jobs` / `_scopeQueues`：仅 `plugin/jobs.js` 内部可达，无跨文件消费者；但属工厂返回面的既有键，删除会改变对象形状，非「明显无消费者」，保留。
- `instance/sandbox.js` 的 `defaultCommand`：**非导出**、仅 `effectiveCommand` 内部回退，模块内部函数，非死代码，保留。
- `instance/upgrade.js` 的 `taskLogger`/`portHealthOpts`：模块内部具名辅助函数，被同文件多处调用，保留（仅精简其 JSDoc）。
- `instance/upgrade.js` 的 `_scheduleJobCleanup`：在 `module.exports` 返回面上被 `test/instance-safety-test.js` 引用，保留。

**未发现**：被注释掉的代码块、恒真/恒假分支、未使用 require。扫描指令：`require` 名局部计数 ≤1 = 0 处；`if (true|false|0|1)` = 0 处；注释掉的语句 = 1 处（`plugin/jobs.js:7`，实为描述互斥链形态的 WHY 说明，非代码，保留）。

## 4. node --check 结果

对 17 个改动文件逐个 `node --check`：**OK=17 / FAIL=0**。

代码零变化核验：`git diff` 过滤后，唯一非纯注释的行是 6 处**行尾注释移除**（`installLog` / `attempts > 20` / `CLI_TIMEOUT_MS` / `profileDir` / `DEFAULT_TTL_MS` / `fetchNpmLatest`），其代码前缀逐字节不变；其余全部为整行注释的增删。未写回任何 emoji/框线/箭头/带圈数字（所有替换文本均取自原注释本身）。

## 5. CI 风险点

1. **DG-3（contract.pure 零 IO require）**：未删任何 require、未新增 require；`instance/{model,sandbox,state-machine}.js` 与 `plugin/{model,policies*}.js` 的 require 面不变，DG-3 判定不变。
2. **DG-9/§3.3 契约面**：`instance/index.js` 的 accessor/getter/setter 与转发方法体未动，仅删其上方注释；`contract.js` 声明未动，DG-9 双向一致不受影响。
3. **源码正则形态锁**：`test/round8-fixes-test.js` J-g/J-i 依赖 `market-net.js`/`cli.js` 的**代码**（`重定向到不支持的协议`、`spawn.piped(...)`、`process.kill(-child.pid, sig)`）与运行期文案；本次未触碰任何代码行或其命中注释（`market-net.js` 整文件未改），风险 0。
4. **`test/market-budget-test.js` M-d**：以正则定位 `market.js` 批次循环「`_budgetExhausted()` 在 `slice(i,` 之前」；本次只删循环**上方**的说明注释，不动循环体，风险 0。
5. **`test/instance-safety-test.js:155`**：已按 §2 逐字保留钉子（§2），风险 0。
6. **行数/嵌套门禁（DG-1/DG-2/DG-15/DG-16）**：改动仅减少注释行，DG-1 门面 ≤150 行只会更宽松；`plugin/index.js` 删除的都是非注释行之间的独立注释行，不改变函数嵌套结构，DG-16 不变。
7. **报告路径合规**：本报告不含操作者绝对路径，仅相对路径与占位。

## 6. 未改动文件（11）与理由

按 §2「不确定就保留」，且其注释均为契约不变量 / 对外 API 契约 / 安全语义 / 测试形态锁定，无可删的 WHAT 冗余：

- `src/domains/instance/contract.js`：域契约纯数据声明，注释为 DG-3/DG-4b/DG-9/DG-10 判据出处。
- `src/domains/instance/model.js`：记录形状/迁移/视图契约说明（令牌收敛、FAILED 重置等不变量）。
- `src/domains/plugin/contract.js`：同 instance/contract.js。
- `src/domains/plugin/layers.js`：注释为写队列纪律与原子写 WHY（「单次异常不得毒化队列」等）。
- `src/domains/plugin/market-net.js`：被 `test/round8-fixes-test.js` J-g 形态锁定，整文件保留。
- `src/domains/plugin/market-sources.js`：模块头注明确指向 `test/market-budget-test.js` M-d 的锁定，保留。
- `src/domains/plugin/ops.js`：注释为逐目标串行顺序与「不自动重启」契约。
- `src/domains/plugin/restart.js`：注释为沙箱/原生两条生效路径的 WHY。
- `src/domains/plugin/store.js`：注释为包名边界匹配（防 dsh-tool 吞 dsh-tool-extra）等陷阱说明。
- `src/domains/plugin/store/market-cache.js`：`indexedAt` 不得重置为 Date.now() 的契约说明。
- `src/domains/plugin/targets.js`：注释为 DSH_HOME 优先级、pnpm store 固定等跨平台/隔离契约。
