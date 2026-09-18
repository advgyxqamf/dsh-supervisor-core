# plugin 域 功能设计

> 范围：`src/domains/plugin/`（index.js 35 / ops.js 361 / jobs.js 242 / store.js 353 / market.js 427）。
> 依据：`DOMAIN-DESIGN-BRIEF.md`（§5 模板）+ `DIRECTORY-STRUCTURE-DESIGN.md`（跨层 SSOT）
> + `design-notes/_RULING.md`（R1–R7，**覆盖 BRIEF 相应表述**）。
> 所有「文件:行号」均来自本轮实际 read；实测脚本剥离注释后扫描。

---

## A. 现状审计

### A.1 文件清单与职责（逐文件）

| 文件 | 行数 | 当前职责（实测） | 问题 |
|---|---|---|---|
| `index.js` | 35 | 门面：require store/ops/jobs，`Object.assign(PluginManager.prototype, opsMethods, jobsMethods)`（:33），导出 `{PluginManager, PROTECTED}` | 门面本身**干净**（好样板），但 :33 的合并手法正是 R6 ②③ 禁止的形态 |
| `ops.js` | 361 | 目标解析（:31-91）+ 安全参数校验（:98-105）+ CLI 执行（:107-173）+ install/uninstall/setBundleEnabled 编排（:175-358） | 混 4 类职责；24 处跨文件 `this.X()` |
| `jobs.js` | 242 | 作业模型/互斥（:19-93）+ 进程重启（:95-139）+ 更新检测/执行（:141-239） | 混「纯作业模型」与「进程/网络 IO」；9 处跨文件 `this.X()` |
| `store.js` | 353 | profile 持久化（:44-96）+ 补丁层读改写与队列（:98-208）+ 已装清单（:210-221）+ overlay（:223-228）+ inventory RPC（:230-246）+ manifest（:248-250）+ 组合视图（:252-336）+ PROTECTED（:22）+ overlayEntries getter（:341-343） | **8 类职责挤在一个 class**；3 处跨文件 `this.X()` 反向调 ops |
| `market.js` | 427 | 独立类 `PluginMarket`：HTTP JSON 原语（:44-83）+ 文本原语（:387-418）+ 分类（:19-41）+ 缓存/TTL/预算/坏构建保护（:85-220）+ 三源抓取（:222-367） | **427 行 > R3 的 ≤400**；职责可独立切分 |

### A.2 域内耦合图

**① require 边（剥注释后实测，共 3 条）**

```
index.js:28 → store.js
index.js:29 → ops.js
index.js:30 → jobs.js
```

Tarjan SCC：**0 个环 → require 图是 DAG ✔**。
（跨层出边：ops.js:21→platform/os/spawn、:26→platform/contract/matrix；jobs.js:15→shared/version；store.js:20→platform/util/fs。均为 SSOT 已登记合法边。）

> ⚠ **修正 BRIEF §0**：本域与 router 域一样，**不存在循环 require**（R1 实测）。`ops.js ↔ jobs.js`
> 的 require 边**一条也没有** —— 两文件从不互相 require。BRIEF 所称「循环 require」不成立。

**② this 调用边（实测 36 处跨文件调用、22 个不同被调方法）**

| 方向 | 处数 | 被调方法（行号） |
|---|---|---|
| ops → jobs | 10 | `_createJob`(L179,226) `_finishJob`(L186,233) `_withScopeLock`(L195,242) `_targetRunning`(L205,351,353) `_applyPluginChange`(L276) |
| ops → store | 14 | `isProtected`(L216,291) `installedOn`(L221,304) `_removeFromProfileBundles`(L251) `_scrubPluginLayers`(L269) `_enqueueBundleOp`(L287) `_patchEntryIdsForPlugin`(L310) `_readHomePatch`(L311) `_writeHomePatch`(L329,337) `overlayEntries`(L341,343) `saveOverlayEntries`(L345) |
| jobs → ops | 5 | `_nativeTarget`(L149) `_allSandboxTargets`(L149) `resolveTargets`(L186) `_runCli`(L224,226) |
| jobs → store | 4 | `installedOn`(L152,168,188,216) |
| store → ops | 3 | `_nativeTarget`(L254,319) `_allSandboxTargets`(L254) |

**this 调用图 SCC（Tarjan）：1 个三分量 `{ops, jobs, store}`** —— 这才是本域真实的环（R1 语义）。

### A.3 病症清单（对照 §0 四类，逐条证据）

| # | 病症 | 证据（文件:行号） |
|---|---|---|
| 1 | 巨型文件 | `market.js` 427 行 **超 R3 ≤400**；`ops.js` 361、`store.js` 353 虽未越线，但职责数远超一个文件应承载 |
| 2 | `this` 隐式耦合 | 36 处跨文件 `this.X()`（A.2 ②）；改 `store._scrubPluginLayers` 签名会静默破坏 `ops.js:269`，编译期不可见 |
| 3 | **this 调用环** | `{ops, jobs, store}` 成环：ops→jobs(:179) + jobs→ops(:149) 构成双向（任务点名的 4+4 条）；store→ops(:254) 再加一边 |
| 3b | **BRIEF 误判** | BRIEF §0 的「循环 require」**不成立**：require 图 0 环（A.2 ①）。真实病症是上一条 |
| 4 | 职责错位 | ① `store.js` 一个 class 混「持久化 + 补丁层写队列 + inventory RPC + 组合视图 + 常量」；② `jobs.js` 把**纯作业模型**(:29-66) 与**进程重启**(:95-139)、**网络更新**(:141-239) 放一起；③ `ops.js` 把**纯目标解析**(:80-91) 与 **spawn IO**(:107-173) 放一起 |
| 5 | **假 SSOT（注释与代码不符）** | `index.js:21`/`store.js:12` 注释称「store.listInstalled 调 ops.install 作重启回调」；**实测 `store.js` 中 `install` 出现 0 次**（grep 空）。该注释是拆分前的旧事，却成了「必须合并到同一原型」的**错误论据** |
| 6 | 组合手法（违反 R6） | `index.js:33` `Object.assign(PluginManager.prototype, opsMethods, jobsMethods)`；`ops.js:361` `module.exports = { opsMethods }`；`jobs.js:242` `module.exports = { jobsMethods }` —— R6 ① + ② |

---

## B. 功能切面（★ 设计核心）

> 不看现有文件，只回答「插件域功能上由哪几块组成」。

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **F1 领域模型 / 常量** | 内置保护名单（PROTECTED）与作业记录的数据形状 | 常量表、时间戳、随机源 | 不可变常量、作业记录对象 | 无 | **纯** |
| **F2 纯策略 / 判定** | 参数安全校验、spec 类型判定、版本比较、补丁行归属判定、包名归属推断、目标补丁路径推导、CLI argv 组装 | 原始字符串 / 数组 / 对象 | 布尔 / 枚举 / 新数组 / 错误文案 | 无 | **纯** |
| **F3 目标解析** | 把前端 target 串（`native`/`all`/`id:<实例>`/实例 id`）解析成可执行目标描述 | targetStr + 实例清单 + profile 上下文 | `{ok, targets[]}` 或 `{ok:false,error}` | **读文件系统**（`fs.existsSync(t.bin)` :76,89）→ 非纯 | 否（只读） |
| **F4 CLI 执行** | 以目标描述的 env/runtime 起 `dsh plugin` 子进程，整树超时终止，逐行回吐日志 | target、args、registry origin、超时 | `{ok,error}` + onLine 回调 | **spawn / kill / timer** | 否 |
| **F5 补丁层与持久化（读）** | 读 profile package.json / node_modules 版本 / home 补丁层 / profile 补丁层 / overlay / manifest / inventory RPC | profileDir、overlayFile、dshPort | 结构化条目数组 / 已装清单 / inventory | **文件读 + HTTP RPC** | 否 |
| **F6 补丁层写（串行）** | 本插件行「只增/只删 disabled 行」的读改写；卸载残留 scrub；两层共用一条串行队列 | target、插件名、目标启用态 | 变更后的条目 / `{cleaned,warnings}` | **原子写盘（tmp+rename+0600）** | 否 |
| **F7 作业模型** | 作业表（保留上限 50）、作用域互斥队列、状态视图、统一任务注册表桥接 | kind/name/targets、TaskRegistry | job 记录 / 作业视图 | 内存态变更（无 IO） | **纯**（除注入的 tasks/log 边界） |
| **F8 变更生效（重启）** | 对已变更且运行中的目标触发重启：沙箱走 `instances` 停起重试，原生走 `onNativeRestart` 回调 | target、kind、onLog | `true/false` | **进程停起 / 回调 / 事件** | 否 |
| **F9 安装 / 卸载编排** | 逐目标串行推进作业：解析 → 加锁 → CLI → 清理 bundles → scrub → 生效 | spec/name/targetStr | `{ok,jobId,target}` + 作业进度 | **F3+F4+F5+F6+F8 的组合副作用** | 否 |
| **F10 启停（补丁层热应用）** | 启用/禁用插件：写 disabled 行 + 清 legacy overlay，**不重启**（热载） | name、on、targetStr | `{ok,rows,results[]}` | **F5+F6 写盘 + 事件** | 否 |
| **F11 更新检测 / 执行** | 查 registry 最高版 vs 已装版；npm 型走 update→add，git/local 型拒绝 | force / name / targetStr | 更新行集合 / `{ok,jobId}` | **网络 + F4 + F8** | 否 |
| **F12 已装清单视图** | 聚合多目标已装插件 + enabled 判定 + 目录体积 | targets（已解析）、overlay/patch 状态 | `{ok,rows,thirdParty,...}` | **文件读 + 目录体积** | 否 |
| **F13 市场索引（独立）** | 实时聚合 npm+GitHub+社区源，TTL 缓存、构建预算、坏构建保护 | force、cacheDir、ttlMs、buildBudgetMs、dist | 插件索引 `{indexedAt,plugins[]}` | **HTTP / 磁盘缓存** | 否 |

**边界裁决**：F13（市场）与 F1–F12（管理器）**零共享状态、零互相调用**（实测：market.js 内 `this.<管理器方法>` 调用 0 处；管理器内 market 引用 0 处）。它不是「域内一块」，而是一个**并置的内聚子域**，只是恰与插件管理器同放一个目录 —— 见 C 节市场分节。

---

## C. 目标结构（★ 逐文件）

### C.1 目录树

```
src/domains/plugin/
├── index.js           门面：只做组合 + 导出（≤70 行）
├── model.js           F1  内置保护名单 + 作业记录形状 + 纯状态迁移
├── policies.js        F2  全部纯判定/映射（零 IO）
├── targets.js         F3  目标解析（只读 fs）
├── cli.js             F4  dsh plugin 子进程执行 + 整树终止
├── store.js           F5+F12  持久化读 + 已装清单视图
├── layers.js          F6  补丁层写（读改写 + 串行队列 + scrub）
├── jobs.js            F7  作业模型 + 作用域互斥 + 任务桥接（纯状态）
├── restart.js         F8  变更生效（沙箱停起 / 原生回调）
├── ops.js             F9+F10  安装/卸载/启停编排
├── updater.js         F11  更新检测与执行
├── market.js          F13(a)  市场服务本体（缓存/TTL/预算/坏构建保护/分类）
├── market-sources.js  F13(b)  三源抓取 + raw 镜像回退
└── market-net.js      F13(c)  HTTP JSON/文本原语（重定向协议校验 + 体积上限）
```

扁平文件（不建子目录）：R2 明确「优先用扁平文件」；本域无「多个同类文件」需要子目录。

### C.2 逐文件（行数估计 + 来源）

| 新文件 | 行数估计 | 职责 | 从哪来（旧文件:行区间） | 纯? |
|---|---|---|---|---|
| `index.js` | ~70 | 门面：require 各模块 → **注入协作方构造** `PluginManager` → 导出 `{PluginManager, PluginMarket, PROTECTED}` | 现 index.js:1-35（**删去 :33 的 Object.assign**） | — |
| `model.js` | ~60 | `PROTECTED`；`createJobRecord`/`finishJob`/`planJobCleanup`/`taskStateToJobState` | store.js:22；jobs.js:19,29-34,49-66,74 | ✅ |
| `policies.js` | ~75 | `assertSafeCliArgs`、`specType`、`isUpdateAvailable`、`isOwnRow`/`isOwnDisabled`、`ownerPackage`、`targetHomePatchPath`、`cliArgv` | ops.js:98-105,321-322,134-143；jobs.js:141-146；store.js:70-72,346-351 | ✅ |
| `targets.js` | ~70 | `pathExtra`、`nativeTarget`、`sandboxTarget`、`allSandboxTargets`、`resolveTargets`（显式入参，不读 `this`） | ops.js:31-91 | 只读 |
| `cli.js` | ~95 | `runCli({target,args,opts,registryOrigin,logger})`：stdio 收集、超时 SIGTERM→SIGKILL、`matrix.supportsProcessGroup()` 能力查询 | ops.js:107-173 | 否 |
| `store.js` | ~180 | `readProfile`、`pkgVersion`、`installedOn`、`readManifest`、`readHomePatch`、`patchEntryIdsForPlugin`、`overlayEntries`、`inventory`、`listInstalled(targets)`、`listInstalledNative` | store.js:44-51,70-87,98-112,210-221,230-250,252-336,341-343 | 否（读） |
| `layers.js` | ~170 | `removeFromProfileBundles`、`writeHomePatch`、`saveOverlayEntries`、`createLayerQueue`、`applyBundleEnabled`、`scrubPluginLayers`(+Inner) | store.js:53-68,89-96,114-208,223-228；ops.js:290-358（内层逻辑） | 否（写） |
| `jobs.js` | ~90 | `createJobService({tasks})`：`withScopeLock`、`createJob`、`finishJob`、`cleanupJobs`、`installStatus` | jobs.js:19-93 | 状态 |
| `restart.js` | ~60 | `targetRunning`、`applyPluginChange`（依赖注入 `instances`/`onNativeRestart`/`events`） | jobs.js:85-139 | 否 |
| `ops.js` | ~150 | `install`、`uninstall`、`setBundleEnabled`、`listInstalled`（解析 targets 后转交 store） | ops.js:175-288；store.js:252-310（编排部分） | 否 |
| `updater.js` | ~110 | `checkUpdates`、`update` | jobs.js:141-239 | 否 |
| `market.js` | ~230 | `PluginMarket`：缓存/TTL/`_deadline` 预算/`_truncatedSources`/坏构建保护 A+B/`classify`/`pickAuthor` | market.js:19-220,420-425 | 否 |
| `market-sources.js` | ~160 | `indexNpm`、`indexGithub`、`indexCommunity`、`safeFetchLatest`、`safeRepoPkg`、`rawGet`+`RAW_MIRRORS` | market.js:222-385 | 否 |
| `market-net.js` | ~80 | `getJson`、`getText`（重定向协议校验、跳数上限、体积上限） | market.js:43-83,387-418 | 否 |

**行数核对（R3：单文件 ≤400、index ≤150）**：最大文件 `market.js` ≈230、`store.js` ≈180，全部达标；`index.js` ≈70 ≤150。

---

## D. 依赖图（★ 必须是 DAG）

### D.1 域内 require 边（全部单向，无环）

```
index.js ──→ model.js, policies.js, targets.js, cli.js, store.js, layers.js,
             jobs.js, restart.js, ops.js, updater.js, market.js, market-sources.js, market-net.js
ops.js     ──→ policies, targets, cli, store, layers, model
updater.js ──→ policies, targets, cli, store, model
layers.js  ──→ store, policies
restart.js ──→ policies, model
jobs.js    ──→ model
store.js   ──→ policies
cli.js     ──→ policies
targets.js ──→ policies
market-sources.js ──→ market-net
market.js  ──→ market-sources, market-net
model.js   ──→ ∅
policies.js──→ ∅（仅 shared/version，L0）
```

**关键不变量**：`jobs.js`/`store.js`/`layers.js`/`cli.js`/`targets.js`/`model.js`/`policies.js`
**零出边指向 `ops.js`/`updater.js`/`index.js`** → 环被物理消除。

### D.2 逐边理由

| 边 | 理由 |
|---|---|
| ops/updater → policies | 参数校验、spec 判定、版本判定、argv 组装是纯函数，无需状态 |
| ops/updater → targets | 目标解析是只读、无状态；显式 require 比注入更省样板（§3 手法 A） |
| ops/updater → cli | CLI 执行是无状态函数（依赖经参数传 registryOrigin/logger） |
| ops/updater → store | 读已装清单/inventory；store 不反向依赖 |
| ops/updater → model | 作业记录创建/收尾是纯函数 |
| layers → store | 补丁层写入前需读回当前条目（`readHomePatch`）；store 只读，无回边 |
| **jobs 无出边** | 作业模型是纯状态服务；`tasks` 注册表经 ctor 注入 → **ops↔jobs 双向环在此断链** |
| market-* 三件套 | 仅向下；与管理器**零边**（父子域隔离，见 G 节） |

### D.3 状态注入清单（明确边界）

| 协作方 | 注入到 | 理由 |
|---|---|---|
| `jobs`（作业服务） | ops, updater | 有状态（`_jobs`/`_scopeQueues`）→ 手法 B |
| `layers`（补丁层服务） | ops | 有状态（串行队列）→ 手法 B |
| `tasks` (TaskRegistry) | jobs | 平台服务，装配期注入 |
| `instances` / `onNativeRestart` / `events` / `logger` / `dist` | ops, updater, restart, cli(registryOrigin) | 外部能力，全部经 ctor 注入（不 require 具体实现） |
| 纯配置（`dshBin`/`profileDir`/`profileName`/`overlayFile`/`dshPort`） | targets, store, layers | 值注入 |

### D.4 跨域/跨层边（现状，均合法，无需本期改动）

| 边 | 性质 |
|---|---|
| `app/assembly/compose.js:24,295,299` → plugin 域 | app→domains 装配边，已在 `layering-and-dependency-gate-test.js` 的 `CROSS_LAYER['app -> domains']['src/domains/plugin']` 登记（:91） |
| `api/deps.js:85` 声明 `plugins: ['config','pluginManager','pluginMarket']` | —— |
| ops→platform/os/spawn、platform/contract/matrix；jobs→shared/version；store→platform/util/fs | domains→platform / domains→shared，均已登记 |

⚠ **跨域候选（需上层裁决，本期不动）**：`market-net.js` 的 `getJson`/`getText`
是通用 HTTP-JSON 原语，`platform/distribution` 内很可能有第二份同类实现。
若上移 `platform/` 会改 L0 表面与 `platform` 的 「无域名词」约束，**超出本域设计权限** —— 记此待裁决。

---

## E. `this` 隐式耦合消解表（★ 逐条，22 个方法 / 36 处调用点）

### E.1 ops.js → jobs.js（10 处）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this._createJob(kind,name,str,targets)` | ops.js:179,226 | **A+C** | `createJobRecord(kind,name,str,targets,Date.now())`（model，纯）+ `jobs.createJob(...)` 记账（注入服务） |
| `this._finishJob(job,ok,err)` | ops.js:186,233 | **A+C** | `finishJob(job,ok,err,Date.now())`（model，纯）+ `jobs.finishJob(...)` 桥接 tasks |
| `this._withScopeLock(id,fn)` | ops.js:195,242 | **B** | `this.jobs.withScopeLock(id,fn)`（注入的作业服务持有队列）；语义逐字保留：`prev.then(fn,fn)` + `run.catch()` 续链 |
| `this._targetRunning(target)` | ops.js:205,351,353 | **A** | `require('./restart').targetRunning({instances}, target)` |
| `this._applyPluginChange(t,k,log)` | ops.js:276 | **A** | `require('./restart').applyPluginChange(ctx, target, kind, onLog)` |

### E.2 ops.js → store.js（14 处）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.isProtected(name)` | ops.js:216,291 | **A+C** | `policies.isProtectedName(name)`（读 model.PROTECTED，纯） |
| `this.installedOn(target)` | ops.js:221,304 | **A+C** | `store.installedOn(target, PROTECTED)`（无状态，入参显式） |
| `this._removeFromProfileBundles(t,name)` | ops.js:251 | **A+B** | `this.layers.removeFromProfileBundles(target, name)`（写服务，注入） |
| `this._scrubPluginLayers(t,name,log)` | ops.js:269 | **B** | `this.layers.scrubPluginLayers(target, name, onLog)` |
| `this._enqueueBundleOp(tag,fn)` | ops.js:287 | **B** | 收进 layers 内部（`setBundleEnabled` 入队）—— 唯一入队点不再暴露给调用方 |
| `this._patchEntryIdsForPlugin(t,name)` | ops.js:310 | **A** | `store.patchEntryIdsForPlugin(target, name, inventory)` |
| `this._readHomePatch(target)` | ops.js:311 | **A** | `store.readHomePatch(target)` |
| `this._writeHomePatch(t,entries)` | ops.js:329,337 | **B** | `this.layers.writeHomePatch(target, entries)` |
| `this.overlayEntries`（getter） | ops.js:341,343 | **A+C** | `store.overlayEntries(this.overlayFile)`（**函数化**，路径入参） |
| `this.saveOverlayEntries(list)` | ops.js:345 | **B** | `this.layers.saveOverlayEntries(list)` |

> ★ `overlayEntries` 现状是 getter（store.js:341），且是 `index.js:24` 注释里
> 「不能 Object.assign」的唯一理由。改为**普通函数 + 路径入参**后，该顾虑连同 `Object.assign` 手法一起消失。

### E.3 jobs.js → ops.js（5 处）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this._nativeTarget()` | jobs.js:149 | **A+C** | `targets.nativeTarget(ctx)`（`targets` 经参数传入 updater，非 this） |
| `this._allSandboxTargets()` | jobs.js:149 | **A+C** | `targets.allSandboxTargets(ctx)` |
| `this.resolveTargets(str)` | jobs.js:186 | **A+C** | `targets.resolveTargets(ctx, targetStr)`（updater 直接 require targets） |
| `this._runCli(t,args,opts)` | jobs.js:224,226 | **A** | `require('./cli').runCli({...ctx}, target, args, opts)` |

### E.4 jobs.js → store.js（4 处）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this.installedOn(target)` | jobs.js:152,168,188,216 | **A+C** | `store.installedOn(target, PROTECTED)`（updater.js 内显式 require，不入 `this`） |

### E.5 store.js → ops.js（3 处，**反向边，必须消**）

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `this._nativeTarget()` | store.js:254,319 | **C** | `listInstalled(targets)` / `listInstalledNative({targets})` —— **目标由调用方（ops.js）解析后传入**；store 不 require targets |
| `this._allSandboxTargets()` | store.js:254 | **C** | 同上 |

> 消解后 `store.js` 出边只剩 `policies`（纯），反向环彻底断开。

**消解结果**：36 处跨文件 `this.X()` → **0 处**；this 调用图 SCC 由 `{ops,jobs,store}` → 无环。

---

## F. 迁移步骤（★ 可执行、可分批）

> 每步独立可提交；每步后 `npm test` 与 `node test/directory-structure-gate-test.js` 仍绿。
> 行为零变化原则：只搬代码 + 显式化入参，**不改语义、不改文案**（源码级门禁按字符串断言，文案即契约）。

| 步 | 动作 | 影响文件 | 验证 |
|---|---|---|---|
| **1** | **market 拆分**（最独立、零耦合）：`market.js`→`market.js` + `market-sources.js` + `market-net.js`；`class` 改为 ctor 接收 sources | market*.js | `node test/market-budget-test.js`（M-a~M-g 全绿，尤其 M-d 的源码正则 `for (let i = 0…` + `_budgetExhausted` 必须仍在 market.js）；`node test/round8-fixes-test.js` J-g（域聚合读 ≥2 处「重定向到不支持的协议」） |
| **2** | 抽 `policies.js` + `model.js`（纯函数，无调用方改动） | +2 新文件；ops/jobs/store 改 import | `test/round8-fixes-test.js` J-g（`_patchEntryIdsForPlugin` 仍须在域内、正则 `async _patchEntryIdsForPlugin(target, name) {` 匹配到）；新增纯函数单测 |
| **3** | 抽 `targets.js`（`_nativeTarget`/`_sandboxTarget`/`_allSandboxTargets`/`resolveTargets` 函数化，ctx 入参） | ops.js 瘦身 | `node test/plugin-change-restart-test.js`（该测试用 `pm.resolveTargets = …` 桩替换 → **需同步把门面暴露为可覆盖方法**，见 G 风险） |
| **4** | 抽 `cli.js`（`_runCli` + `_registryOriginAsync`；`_assertSafeCliArgs` 用 step2 的 policies） | ops.js 瘦身 | `test/round8-fixes-test.js` J-i（`spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], { env, detached: true })`、`process.kill(-child.pid, sig)`、killTree SIGTERM/SIGKILL —— 域聚合读取仍命中）；`test/platform-matrix-single-source-test.js` M-c |
| **5** | `store.js` 拆出 `layers.js`；`overlayEntries` getter 函数化；`listInstalled` 改收 targets 入参（**断 store→ops 反向边**） | store.js, layers.js, ops.js | `node test/round13-discipline-gaps-test.js` ①（队列不毒化 + 两条路径共用同一队列 —— **访问路径 `pm._bundleOpQueue` 需随新结构更新，见 G）；`test/plugin-change-restart-test.js` I/J/K |
| **6** | jobs.js 纯化：`_targetRunning`/`_applyPluginChange`→`restart.js`；`checkUpdates`/`update`→`updater.js`；jobs.js 只剩纯作业模型 + 互斥 | jobs.js, restart.js, updater.js, ops.js | `test/plugin-change-restart-test.js` A~N；`test/task-registry-test.js`（`reg.begin('plugin','install',…)` 契约不变） |
| **7** | `index.js` 去 `Object.assign`（删 :33），改 **ctor 注入**协作方；导出面保持 | index.js, ops.js 等 | `node test/plugin-change-restart-test.js`（`new PluginManager({...})` 单参构造契约**必须保持**）；`node test/round13-discipline-gaps-test.js`（`new PM({logger,dist,tasks})`） |
| **8** | 更新受影响断言 + 落 `test/domain-structure-gate-test.js`（H 节判据） | test/round13、test/native-dsh-binding、新 gate | H 节判据全绿；`node test/native-dsh-binding-test.js`（`:110` 断言 ops.js 含 `target.runtime` → 拆后该串落在 **targets.js**，需改路径） |

**必须同步更新的既有断言（否则静默失效）**：
1. `test/native-dsh-binding-test.js:110` — `target.runtime` 从 ops.js 迁至 targets.js；
2. `test/round13-discipline-gaps-test.js:87,90` — `pm._bundleOpQueue` 访问路径随 layers 服务对象改变；
3. `test/round8-fixes-test.js:216` — `_patchEntryIdsForPlugin` 的 `readDomain` 聚合读取仍有效（无需改，但拆后须复核正则仍命中）；
4. `test/round8-fixes-test.js:45` `readDomain` 白名单按目录内所有 `*.js` 聚合 → **新增文件自动纳入**，无需改。

---

## G. 风险与取舍

### G.1 破坏性改动（点名消费方）

| 改动 | 消费方 | 处置 |
|---|---|---|
| `index.js:33` 的 `Object.assign` 删除 | 无外部消费者（`opsMethods`/`jobsMethods` 在 src/ 与 test/ 均 **0 引用**，grep 实测） | 安全；仅 index.js 内部改 |
| `PluginManager` 构造契约 | `app/assembly/compose.js:299`、`test/round13:52`、`test/plugin-change-restart:66,221` | **保持单参 opts 对象不变**；内部组装协作方 |
| `pm.resolveTargets` / `pm.installedOn` / `pm._runCli` / `pm._allSandboxTargets` / `pm.inventory` / `pm.saveOverlayEntries` / `pm._removeFromProfileBundles` / `pm._scrubPluginLayersInner` / `pm._setBundleEnabledInner` / `pm._bundleOpQueue` 被测试桩替换或直接读 | `test/plugin-change-restart:74-89,126,135,208,222,226`、`test/round13:55,57,80,87,88` | **必须保留同名可覆盖方法**（门面把这些操作以**实例方法/实例属性**暴露，转发到注入的服务）。这是「名字可覆盖」而非「隐式 this」——门面转发是显式一行，不违反 DF-4 |
| `market.js` 路径 | `test/market-budget-test.js:39`（`SRC=…/market.js` 的**源码正则扫描**）、`app/assembly/compose.js:295` | market.js **文件名与导出的 `{PluginMarket}` 不变**；M-d 断言的两个批次循环必须留在 market.js 内（故 `indexNpm/indexCommunity` **不迁到 market-sources.js** —— 见 G.2） |

### G.2 取舍：market 拆分粒度（**降级为文件内合理切分**）

`test/market-budget-test.js:99-106` 用**源码正则**断言：
`indexNpm`/`indexCommunity` 的批次循环里 `_budgetExhausted()` 必须出现在 `slice(i,` 之前，
且 `buildIndex` 必须用 `try/finally { this._deadline = 0; }`（同文件）。

**裁决**：遵守门禁意图，`indexNpm`/`indexGithub`/`indexCommunity` 的**批次循环体保留在 market.js**；
`market-sources.js` 只承载**无预算状态的叶子原语**：`safeFetchLatest`/`safeRepoPkg`/`rawGet`/`getJson`/`getText`。
即 market.js ≈ 260 行（仍 ≤400）而非原估 230。**不为行数而破坏既有门禁语义**。

### G.3 不做的部分与理由

| 不做 | 理由 |
|---|---|
| **不把 `market.js` 移出 plugin 域** | 它是**并置子域**（零共享状态）。移出需新域目录 + `layerOf` 域粒度登记 + `CROSS_LAYER` 新增 `app→domains/plugin-market` + api 路由改动 → **跨层，需上层裁决**。本设计只做「域内隔离」（不并入 `PluginManager`、不共享队列/状态） |
| **不把 `market-net.js` 上移 `platform/`** | 跨层行为，超出本域权限；见 D.4「需上层裁决」 |
| 不建 `handlers/`/`scheduler.js`/`daemon.js` | 本域无请求处理器、无周期任务、无独立进程入口（R5 提醒 daemon.js 属 router/relay，本域无关） |
| 不引入 `overlayEntries` 兼容 getter shim | 直接函数化 + 显式传路径；兼容层会复活隐式 `this` 语义 |
| 不改任何**行为/文案** | 源码级门禁（round8 J-g/J-i、market M-d）按字符串断言，文案即契约 |

### G.4 行为零变化的守护点

- `_withScopeLock`：`prev.then(fn, fn)` + `this._scopeQueues[id] = run.catch(()=>{})` + 返回 `run.catch(e=>({ok:false,error}))` —— 逐字保留（round13 依赖「异常不吞、调用方 .then 继续」）。
- `_enqueueBundleOp`：`_bundleOpQueue` 续链吞 rejection + 返回给调用方的 run 保留 rejection → `tag` 日志文案 `'[plugins] 补丁层写失败('` 不改。
- `_runCli`：`exit` 而非 `close`（:168-170）、`detached:true`、P1-6 null-registry 不注入、超时文案 —— 全部逐字保留。
- `_patchEntryIdsForPlugin` 包名边界匹配（`===`/`+ '/'`/`+ '@'`，**不用 includes**）—— round8 J-g 行为级断言依赖。

---

## H. 门禁建议（落 `test/domain-structure-gate-test.js`）

> 贯彻 R6：**所有判据先剥注释**（`strip()` 同 `directory-structure-gate-test.js:52`），
> 否则注释里的 `require`/源码样例会伪造命中（R1 取证陷阱）。

| 门禁 | 断言 | 反向自检（防空转） |
|---|---|---|
| **P-G1 禁混入原型**（R6 ①+②） | 全 `src/` 剥注释后无 `/Object.(defineProperties|assign)(s*[w$.]+.prototypes*[,)]/`，且无 `/module.exportss*=s*{s*methodss*[:}]/` 分片导出 | 样本 `Object.assign(X.prototype, mod.methods);` 必须命中 **①**；`module.exports = { methods: {...} }` 必须命中 **②**；并断言 `Object.defineProperties(Supervisor.prototype, require('./x'))` 仍命中（覆盖旧形态） |
| **P-G2 域内 this 跨文件调用 = 0** | 对 `src/domains/plugin/` 建「方法→所属文件」表；扫描每个文件的 `this.<method>`，其 owner 必须等于本文件 | 构造样本：`ops.js` 中 `this._createJob()` 而 `_createJob` 定义在 `jobs.js` → 必须判 FAIL |
| **P-G3 域内 require 图 + this 图均无环** | 对 plugin 域 12 个模块做 Tarjan SCC，两图分量大小均 = 1 | 样本 `A→B, B→A` 必须被识别为一个二分量的环 |
| **P-G4 文件体量**（R3） | `index.js` ≤150 行；域内任何 `*.js` ≤400 行 | 样本 401 行 / index 151 行必须 FAIL |
| **P-G5 市场隔离** | 域内**除 `market*.js` 外任何文件不得 require `market-sources`/`market-net`/`market`**；`PluginMarket` 不得出现在 `PluginManager` 的原型/实例成员中 | 样本 `ops.js` require `./market-sources` 必须 FAIL |
| **P-G6 导出面保真** | `require('src/domains/plugin')` 的 `PluginManager`/`PROTECTED` 为真且 `typeof PluginManager === 'function'`；`providers` 域宽度=0 | 样本删除一个导出必须 FAIL |
| **P-G7 DF-6 独立可测**（新增，最关键） | 逐个 `require` 域内非门面模块，断言：**能加载**、**不构造 PluginManager**、且模块顶层无副作用（不建目录/不写盘） | 样本模块顶层 `fs.writeFileSync(...)` 必须 FAIL |
| **P-G8 依赖方向单向** | 断言 `model/policies/jobs/store/layers/cli/targets` 的 require 集合**不含** `ops`/`updater`/`index`（DF-7） | 样本 `store.js` require `./ops` 必须 FAIL |

**P-G7 的落地方式（可自动化）**：门禁内 `strip()` 后解析 `require(...)` 边；
对「叶子集」`{model, policies, cli, targets, store, layers, jobs}` 逐个 `require()`（它们零上层依赖，可安全加载），
并断言 `require.cache` 中**不出现** `PluginManager` 的外部实例化。
**P-G2/P-G3 的对象是「域」，不硬编码文件名** —— 新增文件自动纳入，避免判据腐化（同 round8 `readDomain` 的既有做法，:45）。

**同步修正既有门禁**：
- `test/directory-structure-gate-test.js:122` 的 DS-G3 只禁 `defineProperties` → 按 **R6** 换成组合判据（或由 P-G1 取代）；
- `test/directory-structure-gate-test.js:170` 的 `ALLOWED` 按 **R2** 放宽为 `providers instances policies model store handlers core jobs`（本域用扁平文件，暂不依赖该放宽）。

---

## 附：本设计与 BRIEF 的偏差（如实上报）

| BRIEF 原文 | 实测/裁决 | 修正 |
|---|---|---|
| 「plugin/ops.js ↔ plugin/jobs.js **循环 require**」 | `ops.js` 与 `jobs.js` **无任何互相 require 边**（A.2 ①，Tarjan 0 环） | 按 **R1** 改述为 **this 调用环 `{ops,jobs,store}`** |
| 「域内 this 跨文件调用 **18 处**」 | 实测 **36 处调用点 / 22 个不同方法** | 以实测为准 |
| 「store.js 354 行」 | 实测 **353 行** | 以实测为准 |
| 「market.js 428 行」 | 实测 **427 行** | 以实测为准 |
| 「index.js 33 行」 | 实测 **35 行** | 以实测为准 |
| §0 第 4 类「职责错位」 | 本域额外发现 **假 SSOT 注释**（A.3 #5） | 新增一类证据 |
