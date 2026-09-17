# WS1-a 报告：src/platform/** 注释精简 + 死代码普查

> 作业单：design-notes/_workorder-phase2.md（§0 硬约束 / §1 R1·R2 / §2 口径 / §3 分区 / §6 钉子表）。
> 范围：`src/platform/**` 全部 .js，共 **65** 个文件（独占，无跨界）。
> 约束遵从：未跑任何测试/门禁（仅 node --check / grep / read / git 只读）；未做任何 git 写操作；
> 未启 daemon；未碰 /tmp/dsh-* 与状态根；未改 package.json、test/、他人分区文件；报告无操作者绝对路径。

---

## 1. 文件分配表（65/65，互斥且无遗漏）

| 子代理 | 文件数 | 文件 |
|---|---|---|
| **WS1-a 主代理**（本报告作者） | 14 | service/config.js, service/env-catalog.js, service/install-id.js, service/state-root.js, service/tasks.js, service/task-store.js, service/log/{core,events,hub,logcore,log,sources,tail,watermark}.js |
| **分片 A**（contract/util）报告 _p2-ws1a-shardA.md | 15 | contract/{deploy,matrix,registry,runtime}.js, ctl/server.js, distribution/{index,install,policies,registry,release}.js, util/{exec,fs,probe,srcpath}.js, security/identity.js |
| **分片 B**（platform/os）报告 _p2-ws1a-shardB.md | 18 | os/autostart/{darwin,index,linux,win32}.js, os/{browser,capability-profile,desktop,exec-path,file-protect,index,netinfo,notify,process,service,spawn}.js, os/pidlookup/{index,norm,probe}.js |
| **分片 C**（ports/token）报告 _p2-ws1a-shardC.md | 18 | service/ports/{alloc,core,index,migrate,pool,probe,store}.js, service/token/{capture,exchange,follow,index,infer,kinds,persist,pool,snapshot}.js, service/version.js, service/monitor.js |

核对：65 = 14 + 15 + 18 + 18；各分片清单两两不相交，并集覆盖 `src/platform` 下全部 .js（`find src/platform -name '*.js'` = 65）。
三个下级均已读作业单（§0/§1/§2/§4/§5 与 §6 钉子表）。

---

## 2. 改动清单（31 个文件：13 insertions / 119 deletions）

### 2.1 主代理（6 个）
| 文件 | 理由 |
|---|---|
| service/env-catalog.js | 删与签名重复的 `@returns` 与两条 `@param` 表 |
| service/install-id.js | 删 `@returns` 类型标注（散文契约保留） |
| service/state-root.js | 删 `@returns` 表 |
| service/tasks.js | 删构造器/begin/run 三处重复 JSDoc 参数表（−20 行） |
| service/log/events.js | 删 `成功返回 true` 式 WHAT 复述 |
| service/log/log.js | 删与签名重复的返回值列举 |

### 2.2 分片 A（7 个）
registry.js / runtime.js / distribution/{install,policies,registry}.js：删纯 WHAT 单行注释；
distribution/release.js：删与散文重复的 `@param/@returns`；util/srcpath.js：删重复行内注释 +「同类缺陷曾因…」历史句。

### 2.3 分片 B（13 个，净 −43 行）
os/autostart/{index,linux,win32}.js、os/{browser,desktop,exec-path,file-protect,netinfo,process,service,spawn}.js、os/pidlookup/{norm,probe}.js：删复述 WHAT、重复段落、过期表述、与签名重复的 `@param`。未变更 5 个（darwin、capability-profile、index、notify、pidlookup/index）——注释均为所有权契约/跨平台差异/陷阱，无可删。

### 2.4 分片 C（5 个）
token/{kinds,persist,follow}.js：删 4 个未导出死函数（见 §4）及其文档注释；ports/pool.js：删过期 `os.homedir()` 注释与 `byOwner` WHAT 复述；monitor.js：删「已上游化…Phase 1」出处注释。其余 13 个核对无冗余。

---

## 3. 形式钉子保留项（R1，全部原样未动）

| # | 受保护字样 | 钉住它的测试 | 文件 | 状态 |
|---|---|---|---|---|
| 7 | `守卫服务定义缺失` | autostart-ownership-test.js:57 | os/autostart/darwin.js:91 | 未动（grep=1） |
| 8 | `不再是 SEA` | round8-fixes-test.js:73 | contract/deploy.js:4 | 未动（该文件全程未改） |
| 9 | `最小兜底` / `兜底` + `壳` | package-root-test.js:65 | service/config.js:26,85 | 未动（grep=2） |
| 10 | `所有者` 后 12 字内 `桌面壳` | kernel-daemon-contract-test.js:109 | os/autostart/win32.js:5 | 未动（grep=1） |

下级报告登记的新钉子（同样保留）：
- distribution/index.js:3「原 domains/dist」← layering-and-dependency-gate-test.js:79（分片 A 曾删其括注，**已回退原文**）；
- ctl/server.js:116「2026-09 复检根治/keepAliveTimeout」← reconcile-instance-test.js:273（陷阱注释，保留）；
- os/autostart/linux.js「GUI（桌面壳）登录自启」← §6 #10 宽口径，分片 B **已恢复原文**；
- os/capability-profile.js:46 `processTreeKill: true … _killTree` ← process-tree-kill-test.js:79（未动）。

事故 B 防线：`contract/runtime.js` 的 `file` 导出**保留**（test/native-dsh-binding-test.js:123 消费），未删。

---

## 4. 导出增删（R2 全仓核验）

**新增导出：0。删除导出：0。**
删除的 4 个**未导出、不可达**函数（分片 C，附核验证据）：

| 符号 | 文件 | 在 module.exports 中 | 外仓消费者 | 判定 |
|---|---|---|---|---|
| `getKinds` | token/kinds.js | 否 | 0 | 可删 |
| `isDshSideKind` | token/kinds.js | 否 | 0 | 可删 |
| `tokenFileBaseName` | token/persist.js | 否 | 0 | 可删 |
| `listenerCount` | token/follow.js | 否（类方法） | 0（唯二命中在 ui/node_modules 第三方包内，非本仓消费者；`FollowBus` 仅 pool.js 用，且 pool.js 只调 emit/on） | 可删 |

`runtime.js.file` 有 test 消费者 → 保留（对照事故 B）。遗留死导出（未动、仅上报，需与 app 侧 WS1-c 同批）：`token/pool.js` 再导出 `kindInference`、`token/persist.js` 的 `tokenFileName`。

---

## 5. node --check

31 个被改文件全部 `node --check` 通过（整体 exit 0）；三个分片各自 15/18/18 全部通过。**未运行任何测试。**

---

## 6. 主代理复核（对整棵 src/platform 的独立验证）

1. **R1 反查**：取本批全部「删除的注释行」（89 行，≥8 字符）在 `test/` 全量 grep → **0 命中**。
   （首轮脚本误把「删除的代码行」也算入，已修正为只取注释行；修正前命中的 `return out;` 等均为测试自身代码。）
2. **代码零变化**：对 31 个文件逐一对「剥离整行注释后的源码」做前后 diff：
   - 26 个完全相同；
   - browser.js / monitor.js 差异为**行内注释**被删（代码未变，启发式假阳性，已人工核对 diff 确认）；
   - token/{kinds,persist,follow}.js 为 §4 的有意死函数删除（已按 R2 逐符号核验）。
3. **装饰符号**：本批新增行中无 emoji/框线/箭头/带圈数字（grep 0 命中）。
4. **X-2**：按门禁判据（`/home|Users/<name>`，名长 ≥4 且非通用占位）扫描全树 .md → 唯一命中 `CHANGELOG.md`（门禁显式排除）。三个分片报告与本文均无操作者绝对路径。
5. **覆盖面**：65 文件全部有明确归属（§1），无遗漏、无重叠。

---

## 7. CI 风险点

1. **微小**：本批只删/改注释与 4 个未导出死函数，不触任何被门禁锚定的代码形态；已用 R1 反查确保被测试匹配的注释串零删除。
2. **共享工作区**：`src/platform` 之外仍有 WS1-b/c/d 与 WS2 的未提交改动；提交前建议按分区复核 `contract/runtime.js` 的 `file` 导出仍在。
3. **遗留死链**：`kindInference`、`tokenFileName` 为半截死链，本批按「宁可保留」未动，待与 app 侧同批处理。
4. 最终以 CI 四平台裁决；本报告不作验收结论。
