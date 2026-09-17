# WS1-b 报告：src/domains/** 注释精简 + 死代码普查（含 DG-11 追加任务）

> 负责人：WS1-b。上级作业单：`design-notes/_workorder-phase2.md`（§0/§1/§2/§3/§5，及 §6→§7 钉子表更正）。
> 分片分配：`design-notes/_p2-ws1b-allocation.md`。三个下级报告：`_p2-ws1b-domains-router-a.md`、`_p2-ws1b-domains-router-b.md`、`_p2-ws1b-domains-plugin-instance.md`。
> 全程：未运行任何测试/门禁；未做任何 git 写操作；未改 `test/`；未碰 WS2 的 5 个文件。仅 `read/grep/glob/git diff/node --check`。

## 0. 结论速览

| 项 | 值 |
|---|---|
| WS1-b 拥有文件 | 86（`src/domains/**` 共 91，扣除 WS2 的 5 个） |
| 分片 | A 29 + B 29 + C 28（互斥、无遗漏，见 §1） |
| 改动文件数 | 41（A 14 + B 9 + C 17 + 负责人追加 1） |
| 未改动文件数 | 45（逐行审阅后判定注释均为 §2 保留项） |
| 真·注释钉子 | 1 条（`instance/ops.js:41`「探测失败不阻断创建」），已原样保留 |
| 保守保留项 | 5 条（分片 A 逐条 grep 命中后按「不确定就保留」回退，见 §4） |
| 删除的导出 | 0（新增 0） |
| 非注释字符改动 | 0（41 文件中 40 个为纯注释；`relay/managed.js` 为授权的 DG-11 代码修复，见 §6） |
| `node --check` | 45/45 通过（41 改动 + 负责人复检），退出码 0 |

## 1. 文件分配表（§3 要求）

分片互斥性由负责人用脚本核验：`A=29 B=29 C=28 union=86 overlap=0 omitted=0`；且 91 = 86 + WS2 的 5 个。

### 分片 A —— WS1-b-1（router 内部子目录 + shell 全域，29）
```
router/handlers/parse.js            router/instances/proxy-instance.js  router/model/inflight.js
router/ops/admin.js                 router/ops/apps-registry.js        router/ops/browser.js
router/ops/oauth.js                 router/ops/quotasync.js            router/policies/failure.js
router/policies/switch.js           router/providers/base.js           router/providers/command.js
router/providers/direct.js          router/providers/instance-lifecycle.js
router/providers/model.js           router/providers/pkg-cache.js      router/providers/policies/freeze.js
router/providers/policies/quota.js  router/providers/pool.js           router/providers/proxy.js
router/providers/restart.js         router/providers/store.js          router/store/usage.js
shell/contract.js                   shell/core.js                      shell/index.js
shell/journal.js                    shell/restart.js                   shell/watchdog.js
```

### 分片 B —— WS1-b-2（router 顶层编排 + relay 全域，29）
```
relay/contract.js   relay/core.js      relay/daemon.js    relay/frp.js       relay/index.js
relay/managed.js    relay/ops.js       relay/ops/lan-servers.js  relay/ops/reconcile.js
relay/port-segments.js  relay/ports.js  relay/proxy.js   relay/tunnel.js
router/config.js    router/contract.js  router/daemon.js  router/endpoint.js  router/forward-core.js
router/index.js     router/model.js     router/ops.js     router/port-segments.js
router/ports-bootstrap.js  router/proxy-apps.js  router/router-ops.js  router/scheduler.js
router/store.js     router/switch.js    router/views.js
```

### 分片 C —— WS1-b-3（plugin 全域 + instance 全域，28）
```
instance/contract.js  instance/index.js   instance/lifecycle.js  instance/model.js
instance/ops.js       instance/ops/dsh-install.js  instance/sandbox.js
instance/state-machine.js  instance/store.js  instance/upgrade.js
plugin/cli.js   plugin/contract.js  plugin/index.js  plugin/jobs.js  plugin/layers.js
plugin/market-net.js  plugin/market-sources.js  plugin/market.js  plugin/model.js
plugin/ops.js   plugin/policies.js  plugin/policies/classify.js  plugin/policies/market-entry.js
plugin/restart.js  plugin/store.js  plugin/store/market-cache.js  plugin/targets.js  plugin/updater.js
```

### WS2 独占（WS1-b 全体未触碰，仅列出以示边界）
```
relay/session.js  relay/frp-install.js  router/providers/probe.js
router/providers/quota-strategies.js  router/handlers/forward.js
```

## 2. 改动文件清单（每个一行理由）

### 分片 A（14）
| 文件 | 理由 |
|---|---|
| `router/model/inflight.js` | 删 `begin()` 的纯 WHAT JSDoc「真实转发开始 +1」 |
| `router/ops/browser.js` | 删悬空引用「…见原注释」 |
| `router/policies/failure.js` | 删变更史「（原 switch.js:87-112 判定部分下沉）」 |
| `router/policies/switch.js` | 删变更史「（原 switch.js:31-79 纯判定下沉）」 |
| `router/providers/instance-lifecycle.js` | 删与 `module.exports` 重复的「覆盖：…」清单 |
| `router/providers/model.js` | 删与导出面重复的「覆盖 keyFingerprint/maskKey…」清单 |
| `router/providers/pkg-cache.js` | 删变更史「从 probe.js 抽出」 |
| `router/providers/policies/freeze.js` | 删与 `module.exports` 逐字重复的 10 名函数清单 |
| `router/providers/pool.js` | 删与导出面重复的「覆盖 HOT/WARM…」清单 |
| `router/providers/restart.js` | 删变更史「从 proxy.js 抽出」（保留其后「被源码门禁钉住」警示） |
| `router/providers/store.js` | 删与构造器签名重复的 `@param opts` 参数表 |
| `shell/journal.js` | 删变更史「回退功能已整体移除…」与「护栏/回退字段已废除」子句 |
| `shell/restart.js` | 删与文件头第 14 行重复的行内 semver 说明 |
| `shell/watchdog.js` | 删过程记录「P2：相位时效跟踪（由 tick 维护…）」 |

### 分片 B（9）
| 文件 | 理由 |
|---|---|
| `relay/port-segments.js` | 删 anchor 注释里的变更史「原按同池段序*1000…现显式固定」 |
| `relay/frp.js` | 删复述成员的段标签 `/* 设置持久化 */`、`/* 状态 */` |
| `relay/proxy.js` | 删复述代码的 `// 正常结束后的 close` |
| `router/model.js` | 删变更史「（原 instances/proxy-instance.js 上移）」+ 墓碑「已删除 _set()/freeze()/unfreeze()…」 |
| `router/switch.js` | 删墓碑「已删除 _capture() 取证旁路」 |
| `router/endpoint.js` | 删日期叙事「（2026-09 池重构）」（保留「池满必须显式失败」不变量） |
| `router/port-segments.js` | 删 anchor 变更史「原实现按同池段序乘 1000…」 |
| `router/store.js` | 删「此前三处各查一半…」变更史 + 「旧 validity 字段已删除，曾双写分叉」 |
| `router/views.js` | 删「（修复视图/检测措辞分叉）」「（validity 字段已删除）」两处尾巴 |

### 分片 C（17）
| 文件 | 理由 |
|---|---|
| `instance/index.js` | 删 4 条复述代码的访问器 JSDoc（all/forEach/find/map）+「P2-2」工单号 + 精确行号过程叙事后半段 |
| `instance/state-machine.js` | 删 `setRunning` WHAT 头注 + `attempts > 20` 行内逐行解释（阈值语义在上方函数头注已保留） |
| `instance/ops.js` | 删 `updateInstance` WHAT 头注 |
| `instance/ops/dsh-install.js` | 删 `installLog` 行内 WHAT「(有界)」 |
| `instance/sandbox.js` | 删「P2-2 修复」叙事（保留「实时求值 + 60s TTL」WHY） |
| `instance/store.js` | 删 2026-09 日期叙事（保留 journald 防旧令牌 block journal 的 WHY） |
| `instance/upgrade.js` | 删 `taskLogger`/`portHealthOpts` 两条复述代码的 JSDoc |
| `instance/lifecycle.js` | 删「原自愈只认安装超时文案」过程叙事（保留自愈/重试超限 WHY） |
| `plugin/index.js` | 删 5 条仅作分组的裸注释 + `profileDir` 行内复述 |
| `plugin/model.js` | 删 4 条复述代码的 JSDoc（MAX_JOBS/isProtectedName/isOwnRow/isOwnDisabled） |
| `plugin/jobs.js` | 删 `cleanupJobs` WHAT 头注 + 与函数头注重复的行内注释 |
| `plugin/policies.js` | 删 `isUpdateAvailable` 重复 JSDoc |
| `plugin/policies/classify.js` | 删与文件头注重复的「分类关键词启发」 |
| `plugin/policies/market-entry.js` | 删 `npmEntry`/`githubEntry` 两条复述 JSDoc |
| `plugin/cli.js` | 删 `CLI_TIMEOUT_MS` 行内 WHAT 注释 |
| `plugin/market.js` | 删「30 分钟」算术复述 + 3 条逐行解释 |
| `plugin/updater.js` | 删与 `checkUpdates` 内注释重复的行内「取全量最高」 |

### 负责人追加（1，授权代码改动，见 §6）
| 文件 | 理由 |
|---|---|
| `relay/managed.js` | DG-11：`.instances.instances` 内部数组穿透 → `instances.all()` 契约查询接口 |

## 3. 未改动文件（45）

A 15：`handlers/parse.js`、`instances/proxy-instance.js`、`ops/admin.js`、`ops/apps-registry.js`、`ops/oauth.js`、`ops/quotasync.js`、`providers/base.js`、`providers/command.js`、`providers/direct.js`、`providers/policies/quota.js`、`providers/proxy.js`、`store/usage.js`、`shell/contract.js`、`shell/core.js`、`shell/index.js`。
B 20 + C 11：注释经逐行审阅判定为**非显然 WHY / 契约不变量 / 陷阱与事故教训 / 跨平台差异 / 对外 API 契约 / 安全语义**（§2 保留项），按「不确定就保留」零改动。C 另列出 `instance/contract.js`、`instance/model.js`、`plugin/contract.js`、`plugin/layers.js`、`plugin/market-net.js`、`plugin/market-sources.js`、`plugin/ops.js`、`plugin/restart.js`、`plugin/store.js`、`plugin/store/market-cache.js`、`plugin/targets.js` 的保留理由（见其报告 §4）。

## 4. 形式钉子（R1）

真·注释钉子（§7 更正后本域仅 1 条）：

| # | 受保护字样 | 钉住它的测试 | 文件 | 处置 |
|---|---|---|---|---|
| 1 | `探测失败不阻断创建` | `test/instance-safety-test.js:155`（`/探测失败不阻断创建/.test(code)`，未剥注释） | `src/domains/instance/ops.js:41` | **逐字原样保留**：`} catch { /* 探测失败不阻断创建：交给启动期如实报错 */ }` |

§6 v1 曾列 `src/domains/relay/core.js` 的「无效的公网端口」「已被实例「」为 #11；§7 已更正为 error 字段代码字符串。负责人复核确认：这三处（含 `开启公网暴露前请先为该实例设置远程访问令牌`）均位于 `relay/core.js:163-169` 的 `return` 字符串中，属**代码**；该文件本轮**零改动**，无需「补完」。

保守保留项（分片 A 报告 5 条，非登记钉子；逐条 grep 命中后按「不确定就保留」回退）：
| 文件 | 保留注释 | 证据 |
|---|---|---|
| `shell/watchdog.js` | `// action === 'restart'` | `test/shell-watchdog-test.js:36,38` 含同串，命中原样回退 |
| `providers/proxy.js` | `_doStart` 测试打桩说明 | `test/reconcile-instance-test.js:49-51` 消费 `_doStart` |
| `shell/core.js` | 「core 无出边，保证单向与无环」 | `test/directory-structure-gate-test.js:124` 判据名 |
| `providers/restart.js` | 「…被源码门禁钉住」 | `test/round13-router-relay-gaps-test.js` ④ |
| `shell/index.js` | 「导出面与原 index.js 逐字一致」 | `test/domain-structure-gate-test.js` DG-9 |

新增钉子：0。R1 取证：三个分片共对 41 条删除/改写的注释特征串逐条 `grep test/`，均 0 命中；唯一命中 `2026-09 修复` 的是测试自身头注叙述，而非对源码注释的正则断言。

## 5. 死代码普查（R2）

**删除的导出：0；新增：0。**

零非文档消费者但按 R2「宁可保留」保留的候选（附全仓核验）：
| 符号 | 定义 | 核验结果 | 处置 |
|---|---|---|---|
| `graphicalEnv` | `router/ops/browser.js:14` | 除定义外仅 design-notes 记载「内部使用」；无 src/test/bin 消费者 | 保留（亦为 `openInBrowser` 内部调用） |
| `serializeAccount` | `router/providers/model.js:34` | 无 src/test/bin 消费者，但 `EXECUTION-CONTRACT.md:71` 明列为导出契约 | 保留（删除即事故 B 形态） |
| `CONFIG_PATH` / `releaseProviderPorts` / `POOLS` / `hasImminentReset` / `hasOverdueReset` / `stateContainer` / `serializeInstance` / `deserializeInstance` | router 各文件 | design-notes 多处登记；`EXECUTION-CONTRACT.md:61` 逐项列名 | 保留（冻结具名导出） |
| `cookieByName` | `relay/core.js` | `relay/session.js:7,97` 消费 | 保留 |
| `_jobs`/`_scopeQueues` / `defaultCommand` / `taskLogger` / `portHealthOpts` / `_scheduleJobCleanup` | plugin/instance | 属既有形状；`_scheduleJobCleanup` 被 `test/instance-safety-test.js` 消费 | 保留 |

`router/instances/proxy-instance.js`（1 行 re-export shim）：**有消费者** `router/index.js:12`（属分片 B），按文件独占未动，整文件保留。未发现被注释掉的代码块、恒真恒假分支或未使用 require。

## 6. DG-11 追加任务（负责人执行）

`src/domains/relay/managed.js:22`：
```diff
- const sandboxes = (instances && instances.instances) || [];
+ const sandboxes = (instances && typeof instances.all === 'function' && instances.all()) || [];
```
文件内 `.instances.instances` 残留 = 0；`node --check` 通过。文件头第 4 行同步改为「instances 只需提供 all() 查询接口」。

前置确认（上级要求「若不是 InstanceManager 则回报」——**是 InstanceManager**）：
- `src/domains/instance/index.js:51` `all() { return this._store.instances; }`；`:47` `get instances() { return this._store.instances; }` → 同一活数组。
- `relay/ops.js:34` `this.instances = opts.instances`（注释即标 InstanceManager）；`:55` 是 `allManaged` 唯一调用方。
- 装配点 `src/app/assembly/compose/domains.js:95` `instances: host.instances`。
- `allManaged` 无测试直接调用（`test/reconcile-single-flight-test.js:47` 只在注释提到），无 plain-object 兼容风险。

跨分片发现（已单独上报上级，未擅动）：`grep -rn` 点号形态后，`src/` 仅剩 `src/app/domain-actions/main.js:6` 与 `:42`，**均为注释**（WS1-c 分区）。当前 DG-11 判据取 `ENTRIES.src = strippedOf(abs)`（剥注释）故不会命中；若判据改为扫原文需 WS1-c 处理。`test/ports-verify.js:66`、`test/token-boundary-test.js:91` 的 `sup.instances.instances` 属测试侧，DG-11 只扫 src。

## 7. 负责人独立验证（脚本化，非测试）

| 校验 | 方法 | 结果 |
|---|---|---|
| 分区互斥/完整 | 解析分配表 → 集合运算 | `A29/B29/C28 union=86 overlap=0 omitted=0`；91 = 86 + 5 WS2 |
| 无越界改动 | 变更文件 ⊆ 分配表 ∪ WS2 | `in-slice=41 ws2-scope=4 OUTSIDE=0` |
| 代码零变化 | 逐文件 `strip(HEAD)` vs `strip(work)` 归一化比较（字符状态机剥注释） | `comment-only OK: 40 | CODE-DIFF: 0`（不含授权改动的 `managed.js`） |
| 语法 | `node --check` 全部改动 domain 文件 | `checked=45 fail=0` |
| 钉子存活 | grep 受保护字样 | `instance/ops.js` #1 = 1；`relay/core.js` 代码串 = 3 |
| 报告纯净 | 三个分片报告无操作者绝对路径 | 0 命中 |

## 8. CI 风险点

1. **事故 A（注释形态被硬正则钉住）**：已按 §7 规则逐串 grep；本域唯一真钉子 #1 原样保留；分片 A 另有 5 条保守回退，风险已闭合。
2. **事故 B（删导出）**：本轮删除导出 0，零风险。
3. **DG-11**：`managed.js` 已改；新判据反向样本 `(instances && instances.instances) || []` 已由本改动消除。残留仅在 WS1-c 注释（见 §6）。
4. **DG-9/DG-10/DG-3**：导出面与 require 面零变化（`managed.js` 仅改函数体内表达式）。
5. **DG-7/§3.3**：`relay/core.js` 未改；`instance/lifecycle.js` 的 `stateDir`/`config.stateFile` 指派面未动。
6. **门禁读取面**：分片 A 已对 8 个读取本域文件的门禁逐个静态自查（provider-gateway PG-3/4/7、platform-capability A2/A7、shell-safety-net R4/R5/R10、round13 ③④、kernel-daemon D-7、domain-structure DG-9/DG-10），全部安全。
7. **工作区并发**：报告落笔时工作区还含 WS2/WS1-a/WS1-c/WS3 的改动，本报告只对 WS1-b 的 41 个文件负责。
8. **未验证项**：本机禁止跑测试，以上均为静态自证；最终以 CI 四平台为准。

---
本报告与三个分片报告均不含操作者绝对路径（自检 0 命中）。
