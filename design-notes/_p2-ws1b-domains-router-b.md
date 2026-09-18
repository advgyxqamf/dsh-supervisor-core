# WS1-b-2 交付报告（分片 B：router 顶层编排 + relay 全域）

范围：`design-notes/_p2-ws1b-allocation.md` 分片 B 的 29 个文件（router 顶层 *.js + relay 全域，
不含 WS2 的 `session.js`/`frp-install.js`）。上级作业单：`design-notes/_workorder-phase2.md`。

## 1. 改动文件清单（9 个，全部为注释精简，代码零变化）

| 文件 | 改动理由 |
|---|---|
| `src/domains/relay/port-segments.js` | 删 anchor 注释里的变更史「（原按「同池段序 * 1000」得出同值，现显式固定，…）」，保留起点的 WHY（与申报顺序无关）。 |
| `src/domains/relay/frp.js` | 删两个复述成员的段标签 `/* 设置持久化 */`、`/* 状态 */`（方法名已自明）。 |
| `src/domains/relay/proxy.js` | 删 `res.on('close')` 分支里复述代码的 `// 正常结束后的 close`。 |
| `src/domains/router/model.js` | 删头注变更史「（原 instances/proxy-instance.js 上移）」；删墓碑注释「已删除 _set()/freeze()/unfreeze()…」。 |
| `src/domains/router/switch.js` | 删墓碑注释「已删除 _capture() 取证旁路（无消费方的子系统）」。 |
| `src/domains/router/endpoint.js` | 删日期叙事「（2026-09 池重构）」，保留「池满必须显式失败」的不变量。 |
| `src/domains/router/port-segments.js` | 删 anchor 注释里的变更史「（原实现按「同池段序乘 1000」得出同值，现显式固定，…）」。 |
| `src/domains/router/store.js` | 删头注变更史「此前三处各查一半（…）导致双写/清零；现…」；删反序列化注释里的「（旧 validity 字段已删除，曾 status+validity 双写分叉）」。 |
| `src/domains/router/views.js` | 删「（修复视图/检测措辞分叉）」与「（validity 字段已删除）」两处变更史尾巴，保留单源不变量。 |

其余 20 个文件按 §2 逐文件通读后判定无可删项（见 §3），字节不变。

## 2. 形式钉子保留项（R1）：1 项

作业单 §6 登记表 `#11` 命中本分片：

| 受保护字样 | 钉住它的测试 | 文件 | 处理 |
|---|---|---|---|
| `开启公网暴露前请先为该实例设置远程访问令牌`、`无效的公网端口`、`已被实例「` | `test/round13-router-relay-gaps-test.js:55-59` | `src/domains/relay/core.js`（163-169 行 return 字符串，代码） | **该文件本次零改动**，8 行内任何字符（含紧邻注释）原样保留。 |

说明：该测试的 `strip()`（:44）只剥离整行 `//` 注释，真正被匹配的是 `core.js` 的**代码字符串**；
按 §2 本就不得改动非注释字符，故保留。

R1 自查：对本分片全部 29 文件逐个 `grep test/` 搜注释特征串（`_capture`、`取证旁路`、`_set`、
`unfreeze`、`2026-09`、`池重构`、`工业标准`、`上移`、`validity`、`措辞分叉`、`同池段序`、`原按`、
`单事实源`、`双写分叉` 等）。命中项均为**先 stripComments / 过滤 `//` 行再匹配**，或断言的是
运行期 error/log 文案，非注释钉子；未发现新的未登记钉子。

## 3. 未改动但需说明的判定（保守保留）

- `src/domains/relay/daemon.js` / `src/domains/router/daemon.js`：注释含大量非显然的 WHY 与事故教训
  （SIGKILL 兜底窗口、必等 frpc 退出、迁移先于构造防数据丢失、入口守卫），按 §2「不确定就保留」整段保留。
- `src/domains/router/scheduler.js`：`hasImminentReset`/`hasOverdueReset` 注释含「frozen 且无恢复点也
  视为…」的缺陷语义（非日期叙事），保留。
- `src/domains/router/store.js` / `ports-bootstrap.js` / `providers/**`：`真实数据丢失教训`、
  `配置静默清零`、`TOCTOU` 等为陷阱语义，保留。

## 4. 死代码普查（R2）：删除的导出 = 0

对 29 个文件的每个 `module.exports` 符号做**全仓** grep（`src test bin release ui *.md design-notes
.github app`，排除 node_modules/.git）。`test/` 或 `bin/` 有消费者一律保留。**0 个导出/函数/常量被删。**

无 test/bin 消费者、仅定义 + design-notes 提及的「疑似」符号，全部按 R2「宁可保留」保留：

| 符号 | 文件 | 全仓命中（除本文件） | 结论 |
|---|---|---|---|
| `CONFIG_PATH` | `src/domains/router/config.js` | design-notes 3 处（AUDIT-r5-dead-code-census / router-daemon-and-depgraph / EXEC-router-switch-instance-daemon） | 保留（死代码审计已登记为内部使用） |
| `releaseProviderPorts` | `src/domains/router/ops.js` | design-notes 3 处 | 保留（审计登记；契约导出名） |
| `POOLS` | `src/domains/router/port-segments.js` | design-notes 2 处 | 保留（申报数据，`registerPools` 入参） |
| `hasImminentReset` / `hasOverdueReset` | `src/domains/router/scheduler.js` | design-notes 2 处 | 保留（头注声明「另具名导出两个纯判据」） |
| `stateContainer` / `serializeInstance` / `deserializeInstance` | `src/domains/router/model.js` | design-notes 4 处；`EXECUTION-CONTRACT.md:61` model.js 行逐项列名 | 保留（冻结具名导出） |
| `list`（relay/ports.js） | `src/domains/relay/ports.js` | 契约面（`index.js` 注释声明 ops 只经本模块操作端口） | 保留 |
| `cookieByName` | `src/domains/relay/core.js` | `src/domains/relay/session.js:7,97`（消费方） | 保留 |

有 test/bin 消费者的关键导出（抽样证据，均为全仓 grep 命中）：`isServable`（test×2）、
`occupiesSlot`（test×1）、`INSTANCE_STATES`（test×1）、`ProxyInstance`（test×2）、`FrpManager`（test×2）、
`createRelay`（test×3）、`LanManager`（test×2）、`frpPlatformTag`（test×1）、`downloadUrls`（test×2）、
`ROUTER_CTL_METHODS`（test×2）、`SEGMENTS`（test×2）、`rangeOf`（test×2）、`claim`（test×3）、
`applyToken`（test×1）、`targetReachable`（test×1）、`joinUpstream`（test×1）、`RouterService`（test×9）、
`RouterStore`（test×1）、`SwitchEngine`（test×1）、`listProviders`（test×4）、`domainSummary`（test×1）、
`PROXY_APPS`（test×3）、`shutdown`（bin×1）。

## 5. `node --check` 结果

对全部 29 个受派文件逐一执行 `node --check`：`checked=29 fail=0`。
每个改动文件在编辑后立即复检，9/9 通过；未运行任何测试/门禁。

## 6. CI 风险点

1. **pin #11**：`relay/core.js` 未改，`round13-router-relay-gaps-test.js:55-59` 的三处字符串安全。
2. **墓碑注释删除**：`switch.js` 的「已删除 _capture()…」被删后，`test/upstream-credits-test.js:176-177`
   的 `!/_capture|onEvidence/` 是反向断言且先剥离注释行，删除只会更通过，不会转红。
3. **`model.js` 变更史删除**：`test/router-test.js:82`、`test/p2p-router-test.js:148` 的
   「实例级 freeze/unfreeze 已删除」位于**测试文件自身注释**，不读源码文本，不受影响。
4. **代码零变化**：9 个文件的 diff 经 `git diff -U0` 逐行核对，全部为注释行增删，无任何非注释字符改动。
5. **工作区含他工作流改动**：`git diff --stat -- src/domains` 同时列出 WS2/WS1-b-1/WS1-b-3 的文件；
   本报告只对上述 9 个文件负责，未触碰 `session.js`/`frp-install.js`/`probe.js`/`quota-strategies.js`/
   `forward.js` 及其它他人文件。
6. **约束遵守**：未运行任何测试/门禁，未做任何 git 写操作，未改 `test/`。
