# P6-C2 只读预扫描：改动这 4 个文件会碰到的「形式钉子」

> 只读产出。未改任何文件（本报告除外）、未跑测试/门禁、未 require 产品模块、无 git 写。
> 目标文件：src/platform/os/exec-path.js、src/domains/instance/lifecycle.js、
> src/api/domains/instances.js、src/domains/instance/sandbox.js。
> 行号以写入本报告时的当前工作树为准（HEAD = 28e3f67）。

---

## 0. 一句话结论

**这 4 个文件上「真正的源码形态钉子」只有 3 处，且都不在 P6-C 计划改动的函数内部**：
① instances.js 的 `Promise.resolve(sup.instances.addInstance(j))` 调用形态（instance-safety-test.js:158）；
② instances.js 的**路由字面量集合**（api-surface-test.js 双向比对）；
③ sandbox.js 的**纯文件声明**（DG-3，不得新增 IO require）。

**主控预判的三个风险点里，两个不成立**：
- ❌ lifecycle.js 的 `const cmdArr = sandbox.effectiveCommand(...)` / `!cmdArr || !cmdArr.length` ——
  **全 test/ 对 `effectiveCommand` 与 `cmdArr` 零引用**，没有任何钉子钉这段顺序。
- ❌ instances.js 的 `commandShapeError` 函数名/签名/内部字符串（`command[0] 只接受 DSH/node 入口`、
  `DSH_ENTRY`、`isDshPackageEntry`）—— **全 test/ 零引用**（含 CJK 串），可自由重构。
- ✅ exec-path.js 的导出面：**只有 typeof 断言、无键集断言**，新增导出安全。

**但真正的风险在别处**（见 §2）：实例域**聚合读取**的 4 个测试 + 全域门禁
（DG-2 行数 / DG-4 域内 this / DG-15 函数体 require / G9-a 子进程唯一入口 / DG-3 纯文件）。
其中 **DG-4 与 DG-15 最容易被新代码无意触发**。

---

## 1. 源码形态钉子（逐条）

### 1.1 src/api/domains/instances.js

| # | 测试:行 | 正则/字符串原文 | 目标区间 | P6-C 改动是否会破 |
|---|---|---|---|---|
| A1 | instance-safety-test.js:158-159 | `/Promise\.resolve\(sup\.instances\.addInstance\(j\)\)/` | instances.js 的 POST /instances/add 分支（约 :213 起） | **高**：若重构把该调用改写成别的形态（先存变量/包进 helper），直接红。**必须逐字保留这一行** |
| A2 | instance-safety-test.js:160-161 | 负向 `!/const r = sup\.instances\.addInstance\(j\);/` | 同上 | 低：只要不把它改回同步直读 |
| A3 | api-surface-test.js:30-31 读文件 + :37-40 抽取 | `/pathname === '([^']+)'/g`、`/pathname\.startsWith\('([^']+)'\)/g`（**双向比对** api/contract.js 的 SURFACE/PREFIXES） | instances.js 全文（现含 `'/open'`、`'/instances'`、`'/instances/'`，见 :45/:174/:176/:213） | **高**：**不得新增/删除/改名任何路由字面量**；也不得让新守卫把字面量移出文件（抽取对全文件做正则，重复出现 Set 去重，无害） |

### 1.2 src/domains/instance/lifecycle.js

| # | 测试:行 | 正则/字符串原文 | 目标区间 | 是否会破 |
|---|---|---|---|---|
| B1 | （无） | 全 test/ 对 `effectiveCommand` / `cmdArr` **零命中** | `_systemdStart` 的启动命令段（现 :53） | **不会**——主控预判的风险不存在 |
| B2 | instance-safety-test.js:149-153 | `/async\s+(?:function\s+)?addInstance\s*\(\s*payload\s*\)\s*\{([\s\S]*?)\n  \}/` 后 indexOf 比序 | **整个 instance 域聚合**（lifecycle.js 在内） | 低：该非贪婪切片落在 ops.js；只要不新增第二个同签名 addInstance |
| B3 | instance-upgrade-test.js:84-86 | `/fromUpgrade: true/g` 计数 `>= 2`；`/await this\.startInstance\(id\)\.catch/g` 计数 `=== 0` | instance 域聚合 | 低：新增 fromUpgrade 只会让计数变大（仍 >=2）；**但不得新增 `await this.startInstance(id).catch`** |
| B4 | cross-platform-test.js:84-85 | `!/process\.env\.PATH[^\n]*\.join(':')/`、`instSrc.includes('path.delimiter')` | instance 域聚合 | 低：不得写 `process.env.PATH…join(':')`；别删 `path.delimiter` |
| B5 | cross-platform-test.js:170-171 | `instSrc.includes('GET /env/status') && instSrc.includes('capabilities.multiInstance')` | instance 域聚合 | 低：不得删这两处字符串（在别文件，非改动面） |

### 1.3 src/platform/os/exec-path.js

| # | 测试:行 | 原文 | 说明 | 是否会破 |
|---|---|---|---|---|
| C1 | native-dsh-binding-test.js:119 | `typeof ep.resolveDsh === 'function' && typeof ep.dshJsIn === 'function'` | **仅 typeof，无键集断言** | **不会**——新增导出安全 |
| C2 | cross-platform-architecture-gate-test.js:100-103 | `needFiles = [..., 'exec-path.js']` 存在性 | CP-3 | 不会（只要求文件存在） |
| C3 | 功能性调用（须保签名不变） | `candidateNames(name, platform)`、`standardDirs(platform, home, env)`、`npmBin({platform,env})`、`npxBin({platform,env})`、`resolveExecutable(name)` | cross-platform-test.js:26-47、npm-resolution-test.js:37-43/47-54/92-99、platform-layer-portability-test.js:72-136 | 不会（**纯行为断言**，不读源码形态）——但**不得改这些函数的签名/返回** |

### 1.4 src/domains/instance/sandbox.js

| # | 测试:行 | 原文 | 说明 | 是否会破 |
|---|---|---|---|---|
| D1 | instance/contract.js:79（被门禁读） | `pure: [..., 'domains/instance/sandbox.js', ...]` → **DG-3** 断言「声明的纯文件零 IO require」 | 门禁级 | **会**——若往 sandbox.js 加任何 IO require（fs/child_process/os 等）。**保持它纯** |

---

## 2. 全域门禁约束（这 4 个文件都在扫描面内，最易被无意触发）

| 门禁 | 判据 | 对 P6-C 的意义 |
|---|---|---|
| **DG-4** | **域内跨文件 this.X() = 0**（豁免仅 6 个已声明 hooks：onRemoteChange/onInstanceStart/onInstanceStop/onCreate/onRemove/onDestroy） | 4 个文件目前 **this. 用量全为 0**。**在 lifecycle.js / sandbox.js / instances.js 里新写任何 `this.X()` 都会红**。用 deps.X() / 具名导出。 |
| **DG-15** | require() 必须在**模块顶层**，函数体内 0 处（唯一白名单 src/supervisor.js） | **不要把 `require('…exec-path')` 写进 `_systemdStart` 或 `commandShapeError` 的函数体**——必须在文件顶部 require。本轮最容易踩的一条。 |
| **DG-2** | 任何 src/**/*.js **≤300 行**（判据 >300 才红） | 现值：exec-path.js 268、lifecycle.js 231、instances.js 264、sandbox.js 79。各文件**余量 30-70 行**；exec-path.js 余量最小（32 行）。 |
| **G9-a** | src/ 内**只有 platform/util/exec.js** 可调 execFileSync/spawnSync | 启动期复校**不得**用 child_process 直接执行（用 fs.realpathSync 即可）。 |
| **DG-16** | 函数嵌套深度 ≤6 | 新增校验函数注意别写深层嵌套 |
| **DG-3** | 见 §1.4 | sandbox.js 保持纯 |
| **L-1/L-2** | 跨层 import 须在 CROSS_LAYER 登记 | `api -> platform` **已登记** ⇒ api/domains/instances.js require platform/os/exec-path.js 合法；domains -> platform 正常。无需改门禁。 |
| **CP 门禁** | 只覆盖**注释**钉子 | 代码形态钉子它覆盖不到（P3-B 已注明）——故 §1 需人工遵守 |

---

## 3. 注释钉子（R1）

**结论：这 4 个文件上「零」注释钉子。**

方法：抽取 4 个文件 `//` 注释文本，用 `grep -oP '\p{Han}{4,}'` 切出 **305 个 ≥4 字 CJK 短语**，
逐个在 test/ grep（**必须用 -oP；`grep -E '[一-龥]{4,}'` 在本机静默返回空 = 假绿**）。
所有命中经逐条判读，**全部是测试自身的注释、check() 名称或夹具字符串**，无一是对这 4 个文件注释文本的断言
（例：模板让位 / 让位目标名带 / 无需先删 是 instance-safety-test 与 instance-systemd-aside-behavior-test 的
**自身注释**；候选名含 / 解析不到时 / 无扩展名兜底 是 platform-layer-portability-test 的 **check 名称**）。

**唯一相关的注释钉子在邻域（不是这 4 个文件）**：

| 测试:行 | 注释串 | 目标 | 备注 |
|---|---|---|---|
| instance-safety-test.js:154-155 | `/探测失败不阻断创建/` | src/domains/instance/ops.js:41（catch 内块注释，非 `//` 行故不被该测试的剥注释滤掉） | 属 instance 域**聚合**读取面。P6-C 不改 ops.js ⇒ 安全；**但不得删该注释**。它已登记在 comment-pin-gate-test.js 的 CP-4 豁免表。 |

---

## 4. 给主控的可执行清单（按「必须遵守」排序）

1. **instances.js**：逐字保留 `Promise.resolve(sup.instances.addInstance(j))`；**不动任何** `pathname === '…'` / `pathname.startsWith('…')` 字面量（现为 `'/open'`、`'/instances'`、`'/instances/'`）。
2. **commandShapeError 重构自由**：函数名、签名、DSH_ENTRY / isDshPackageEntry、错误文案**均无测试钉子**（已 CJK + ASCII 双向核验）。
3. **顶层 require**：exec-path 的新公共函数必须在 lifecycle.js / instances.js **文件顶部** require（DG-15）。
4. **不写 this.X()**：这三处改动面内一律走 deps. 或具名导入（DG-4）。
5. **sandbox.js 保持纯**：不加任何 IO require（DG-3）；若确实要动，先确认是否需同步修订 instance/contract.js 的 pure 列表（那属契约表变更）。
6. **不用 child_process**：启动期复校用 fs.realpathSync（G9-a）。
7. **行数**：exec-path.js 余量最小（268/300），若新增较多逻辑注意拆分或复核 DG-2。
8. **lifecycle.js 启动命令段无钉子**：可放心在 effectiveCommand 调用之后插入复校，但**不得新增** `await this.startInstance(id).catch`、`await rollback(`、`version: oldVersion`、`ports.release(inst.port)`、`set sandboxSupported(`、`this.sandboxSupported = `（会破坏 instance 域聚合的计数/负向断言）。
