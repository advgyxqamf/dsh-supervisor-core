# AUDIT-plugin-shell：src/domains/plugin/** + src/domains/shell/** 第五轮审计

范围：`src/domains/plugin/**`、`src/domains/shell/**`（24 个 .js 文件）。
本轮只做：确认后删除死代码/未用导出、压缩注释、清理注释中的表情与符号字符、四维核对。
未运行任何测试（遵 ACCEPTANCE-STANDARD 与 .github/workflows/build.yml），改动保守且等价。

## 一、改动清单

### 1. 代码级改动（行为等价）

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| plugin/cli.js | module.exports 去掉 `CLI_TIMEOUT_MS`、`DEFAULT_REGISTRY`（二者仍在本文件内部使用） | 全仓 grep 仅本文件出现 |
| plugin/jobs.js | createJobs 返回对象去掉 `cleanupJobs`（仍内部调用） | grep 无外部引用 |
| plugin/layers.js | 删除未被调用的 `scrubPluginLayers` 入队包装（index.js 的 `_scrubPluginLayers` 自己入队，属重复实现）；删除未被读取的 `_bundleOpQueue` getter | grep 无调用；test/round13 已改为行为判据，不再读该私有字段 |
| plugin/market.js | 删除未使用局部变量 `const pkgName = meta.name \|\| r.name`；`this._refreshIfStale(force)` 改为无参（该分支已保证 force=false，实参为死参） | grep `pkgName` 仅此一处；getIndex 分支 `!force` |
| plugin/store.js | `readManifest` 改为委托 `readProfile`（二者原为逐字相同的两份实现，单一事实源）；`installationOwned` 由硬编码两个包名改为 `[...PROTECTED]`（与 PROTECTED 同一事实）；exports 去掉 `pkgVersion`、`listInstalledNative` | 两函数体逐字相同；PROTECTED 与硬编码数组逐字相同 |
| plugin/model.js | exports 去掉 `MAX_JOBS`（仍作默认参数） | grep 仅本文件 |
| plugin/market-sources.js | exports 去掉 `RAW_MIRRORS`（仍内部使用） | grep 仅本文件 |
| plugin/policies/classify.js | exports 去掉 `CATEGORIES`（仍内部使用；api/contract.js 的同名常量无关） | grep 仅本文件 |
| plugin/targets.js | exports 去掉 `pathExtra`（仍内部使用） | grep 仅本文件 |
| shell/journal.js | exports 去掉 `writeJournal`（仍内部使用；shell/index.js 不导出它） | grep 仅本文件 |
| plugin/contract.js | deps.instances 描述串去掉强调符号 ★（纯展示串，无消费点读取） | 门禁只读 exports/PUBLIC_API/pure/hooks/exempt |

上表之外的文件均为注释级改动。所有 `module.exports` 键的改动均不影响 index.js 门面导出
（DG-9 的 contract.exports 对照面未变）。

### 2. 装饰线删除
全范围删除仅由框线字符组成的纯装饰行（`// ═…` / `// ─…`），共约 40 行。

## 二、注释前后统计

行占比 = 仅注释行 / 总行数（awk 统计，trim 后以 `//`、`*`、`/*` 开头）。

| 文件 | 前 | 后 | 文件 | 前 | 后 |
| --- | --- | --- | --- | --- | --- |
| plugin/cli.js | 38/100 38% | 25/87 28% | shell/contract.js | 9/39 23% | 4/34 11% |
| plugin/contract.js | 11/68 16% | 7/64 10% | shell/core.js | 57/136 41% | 27/106 25% |
| plugin/index.js | 22/94 23% | 12/84 14% | shell/index.js | 19/35 54% | 8/24 33% |
| plugin/jobs.js | 15/78 19% | 11/74 14% | shell/journal.js | 54/140 38% | 25/111 22% |
| plugin/layers.js | 31/235 13% | 23/223 10% | shell/restart.js | 79/159 49% | 42/122 34% |
| plugin/market.js | 45/277 16% | 33/264 12% | shell/watchdog.js | 82/228 35% | 28/173 16% |
| plugin/market-net.js | 13/87 14% | 9/83 10% | plugin/restart.js | 9/68 13% | 5/64 7% |
| plugin/market-sources.js | 13/49 26% | 8/44 18% | plugin/targets.js | 17/86 19% | 10/79 12% |
| plugin/model.js | 21/79 26% | 14/72 19% | plugin/updater.js | 9/107 8% | 6/104 5% |
| plugin/ops.js | 21/131 16% | 17/127 13% | plugin/store.js | 31/206 15% | 20/193 10% |
| plugin/policies.js | 11/47 23% | 7/43 16% | plugin/classify.js | 3/38 7% | 2/37 5% |
| plugin/market-entry.js | 4/40 10% | 3/39 7% | plugin/market-cache.js | 4/28 14% | 3/27 11% |

合计：**618/2555 = 24.2% -> 349/2278 = 15.3%**。删除的主要是 WHAT 复述、变更历史（日期/修复编号叙事）、
逐行解释与重复叙述；保留非显然 WHY、外部契约（导出面、测试断言文案）、不变量与陷阱。

## 三、注释符号清理

已清除注释中的框线（═ ─）、圆点（·）、箭头（→ ←）、警示（⚠）、禁止（⛔）、星（★）、
对勾叉（✅ ❌）、以及 `── 小节 ──` 形式，改为纯文本（注意、要点、->、:）。

唯一残留：`layers.js:130` 与 `ops.js:108` 的 **字符串字面量** `'⚠ …'`（运行期日志前缀）。
按本轮约定「本约束针对注释；代码字符串按需保留」，且移除会改动输出文案，故保留。

## 四、四维审计发现

### 架构设计
- 无孤儿文件：24 个文件均有 require/入口/门禁 fs 读取指向。
- 域内分层与依赖方向未变；DP-10 类方法面未变；DG-9 index.js 导出面未变。
- 已消除的重复事实：`store.readManifest` / `store.readProfile`（逐字重复），
  `store.installationOwned` / `model.PROTECTED`（同一名单两份），`layers.scrubPluginLayers` /
  `index._scrubPluginLayers`（同一入队逻辑两份，前者已死）。
- 仅注释引用、代码已无引用：design-notes 中仍列 RA_MIRRORS/MAX_JOBS/writeJournal/scrubPluginLayers 等，
  属文档滞后，不在本轮文件范围，建议文档代理同步。

### 业务逻辑
- 未做行为变更。核对了 install/uninstall/update 的逐目标串行、作用域互斥与收尾事件，未发现可达错误。
- `store.inventory(dshPort)` 的 rpcId 仅用 `Date.now()`，同一毫秒内并发调用可能重号；
  影响有界（本地 RPC 串行度低），未改，供后续裁决。
- `market.js` 保护 A（预算截断并集）与保护 B（整源失败沿用）判据已确认互不覆盖，逻辑正确。

### 规范标准
- 注释占比由 24.2% 降至 15.3%（本域此前最高 shell/index.js 54%、shell/restart.js 49%）。
- 注释无表情/符号字符（两处字符串字面量除外，见上）。
- node --check 全部通过；无新增 require/依赖；未改 package.json。

### 功能设计（存疑未改）
- `cli.js.DEFAULT_REGISTRY` 与 `market.js.REGISTRY` 各自硬编码 `https://registry.npmjs.org`，
  是同一默认值的第二份实现。因分属不同模块的降级常量、且真实来源是 dist.selectRegistry，
  本轮仅记录，未强行合并。
- `store/market-cache.js:saveIndex` 与 `layers.js:profile 补丁层落盘` 未带 mode 0600，
  与同仓其它原子写（0600）不一致；前者非敏感缓存、后者是用户文件，故未改。
- `shell/restart.js:waitGone` 对 `procs.some(...)` 重复求值两次，纯冗余、无副作用，未改。

## 五、验证记录（未运行测试）
- `node --check`：24 个文件全部通过。
- `git diff --check`：无空白错误。
- 静态复刻门禁判据（只读源码正则/串，非执行测试）全部通过：
  market-budget M-d（2 个批次循环、预算检查在 slice 之前、finally 清零）、
  round8 J-g/J-i/J-e、platform-capability A2/A7、shell-safety-net R4-g/R10（含剥注释后的回退反回归）。
- 对全部删除导出做了全仓 grep（src/test/app/bin/ui/shared），删除后仅剩本文件内部引用或零引用。
\