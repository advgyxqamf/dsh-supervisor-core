# EXEC —— plugin 域结构改造（5 文件 → 14 文件）

> 状态：完成（2026-09-17）。范围：src/domains/plugin/** + plugin 相关测试断言。
> 依据：EXECUTION-CONTRACT.md + DOMAIN-STRUCTURE-DESIGN.md §5.4 + design-notes/plugin.md。

## 1. 实际改动（逐文件）

| 文件 | 行数 | 职责 | 来源 |
|---|---|---|---|
| index.js | 95 | 薄门面：ctor 组装 jobs/layers/store；可覆盖转发方法；导出 {PluginManager, PluginMarket, PROTECTED} | 现 index.js，**删 :33 Object.assign** |
| model.js | 49 | 纯：PROTECTED / MAX_JOBS / createJobRecord / finishJobRecord / planJobCleanup / taskStateToJobState | store:22；jobs:19,29-66,74 |
| policies.js | 72 | 纯：isProtectedName/assertSafeCliArgs/specType/isUpdateAvailable/isOwnRow/isOwnDisabled/ownerPackage/targetHomePatchPath/cliArgv | ops/jobs/store 的纯判定 |
| targets.js | 86 | 只读 fs：pathExtra/nativeTarget/sandboxTarget/allSandboxTargets/resolveTargets（ctx 入参） | ops:31-91 |
| cli.js | 100 | runCli + registryOrigin（显式入参）；整树终止/超时 | ops:93-173 |
| store.js | 206 | 只读：readProfile/pkgVersion/readManifest/readHomePatch/overlayEntries/inventory/installedOn/listInstalled/listInstalledNative；PluginStore._patchEntryIdsForPlugin | store 读部分 + :252-336 |
| layers.js | 235 | 写：removeFromProfileBundles/writeHomePatch/saveOverlayEntries/enqueue/applyBundleEnabled/scrubPluginLayers(+Inner) | store:53-208；ops:290-358 |
| jobs.js | 78 | 有状态作业服务 createJobs({tasks})：withScopeLock/createJob/cleanupJobs/finishJob/installStatus | jobs:19-93 |
| restart.js | 68 | targetRunning/applyPluginChange（ctx 注入 instances/onNativeRestart/events） | jobs:85-139 |
| ops.js | 131 | install/uninstall/listInstalled 编排 | ops:175-288 |
| updater.js | 107 | checkUpdates/update | jobs:141-239 |
| market.js | 332 | PluginMarket 本体：缓存/TTL/预算/坏构建保护/分类/三源批次循环 | market.js（批次循环保留） |
| market-sources.js | 49 | 叶子：RAW_MIRRORS/rawGet/fetchLatest/repoPkg | market:222-385（叶子部分） |
| market-net.js | 87 | getJson/getText（重定向协议校验 + 体积上限） | market:43-83,387-418 |

测试同步改动（3 处）：
1. test/native-dsh-binding-test.js：runtime 断言改**整域聚合读取**（由并发协作者完成）；
2. test/round13-discipline-gaps-test.js：pm._bundleOpQueue 私有字段判据改**行为判据**（由并发协作者完成）；
3. test/round8-fixes-test.js：J-g 的 getJson/getText 协议校验读取对象 **market.js → market-net.js**（本代理改 1 行 + 注释）。

## 2. 破环结果（DF-4/DF-5/DF-7）

- jobs.js 对 ops.js **零出边**（仅 require model）→ 旧 this 调用环 {ops,jobs,store} 物理消失；
- store.listInstalled(ctx, targets) 改**收 targets 入参**（ops 解析后传入）→ store → ops 反向边消除；
- **DF-4 实测 0 处跨文件 this 调用**；**DF-5 require 图 Tarjan 0 环**；
- model/policies/targets/cli/store/layers/jobs/restart 对 ops/updater/index 出边 = 0（DF-7）；
- R6：plugin 域内 Object.assign(*.prototype, …) = 0、module.exports = { methods } = 0。

实测依赖边（均为 DAG）：

    index → model,store,targets,cli,restart,jobs,layers,ops,updater,market
    ops → policies,store        updater → policies
    layers → store,policies     store → model,policies
    jobs → model                policies → model
    targets/cli/restart → （仅跨层 platform/shared）
    market → market-net,market-sources      market-sources → market-net

## 3. 与设计的偏差（如实）

1. _patchEntryIdsForPlugin 落在 store.js 的 PluginStore 类（而非 ops），理由：
   (a) round8 J-g 源码正则 "async _patchEntryIdsForPlugin(target, name) {" 必须**仍在域内命中**；
   (b) 避免把领域算法塞进门面（DF-1 只做组合）。
   其 inventory 经 ctor 注入 getInventory: () => this.inventory() 惰性取，故 pm.inventory 桩替换仍生效。
2. updater.js / ops.js 的目标/cli/store/jobs 协作**全部经 ctx 参数**，故静态 require 边比 D.1 预测少
   （如 updater 仅 → policies）。DF-7 更严（无反向边），仍为 DAG。
3. restart.js 零 require（设计 D.1 预测 → policies/model）：不变量/映射不落在 restart，故无静态边。
4. index.js 95 行：满足 DF-1 ≤150，但高于 §5.4 的理想 ≤70。原因是 G.1 明确要求保留约 12 个
   **同名可覆盖转发方法**（测试桩替换），这些转发本身占行数；转发是显式一行，非隐式 this。
5. policies.cliArgv(target) 只返回 argv 前缀（plugin --profile <n> [--store-dir <d>]）——
   J-i 正则要求调用点为 spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], …)。
6. market 拆分遵守 G.2 裁决：indexNpm/indexGithub/indexCommunity 的**批次循环体保留 market.js**
   （M-d 源码正则锁定 _budgetExhausted() 在 slice(i, 之前）；market-net.js 只承载 HTTP 原语。

## 4. 遗留 / 未做（需上层裁决或他人负责）

1. test/round13-discipline-gaps-test.js 当前 **3 FAIL 全在块 ②**（instance 域：
   mgr.removeInstance is not a function）——instance 域重构进行中，**非 plugin 问题**；
   plugin 块 ①（含队列不毒化、共用队列行为判据）**全 PASS**。
2. market-net.js 的 getJson/getText 是通用 HTTP-JSON 原语，可能与 platform/distribution 内实现重复；
   上移 platform/ 会改 L0 表面，**超出本域权限**（同 design G.3/D.4）——记待裁决。
3. 未把 market.js 移出 plugin 域（并置子域隔离已达成：与管理器零共享状态、零互相调用）。

## 5. 验证（实跑，2026-09-17）

| 命令 | 结果 |
|---|---|
| node test/plugin-change-restart-test.js | **52 passed, 0 failed** |
| node test/round8-fixes-test.js | **59 passed, 0 failed** |
| node test/market-budget-test.js | **16 passed, 0 failed** |
| node test/native-dsh-binding-test.js | **12 passed, 0 failed** |
| node test/task-registry-test.js | **ALL PASS** |
| node test/platform-matrix-single-source-test.js | **18 passed, 0 failed** |
| node test/layering-and-dependency-gate-test.js | **10 passed, 0 failed** |
| node test/directory-structure-gate-test.js | **12 passed, 0 failed** |
| node test/round13-discipline-gaps-test.js | 21 passed, 3 failed（**全为 instance 域块 ②**） |
| 域内 DF 扫描（本代理脚本） | DF-4=0、DF-5=0 环、DF-7=0、index 95 行、最大 333 行、8/8 叶子可独立 require 且不构造 PluginManager |

**未启动任何守卫/daemon 进程**；仅 require() + 桩调用 + node --check 验证。
