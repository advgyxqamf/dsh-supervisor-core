# P4-A-1 修复报告：`instance/store.js`（积压 #4 / #11）

> 工作流 **P4-A-1**，独占且只改 `src/domains/instance/store.js` 一个产品文件（交付另一文件为本报告）。
> 未跑任何测试/门禁；未 `require` 或执行产品模块；未做 git 写；未改 `test/`；未碰 `/tmp/dsh-*` 与状态根。
> 验证手段仅 `node --check` / `read` / `grep` / 只读 `git`。行号为本次改动后的当前树。

## 0. 结论

| 积压# | 条目 | 状态 | 落点（`src/domains/instance/store.js`） |
|---|---|---|---|
| 4 | 端口变更后旧 `inst:*` 登记永久泄漏 | 已修 | :97-101（配合 :104-108 原清理） |
| 11 | `instances.json` 解析失败静默清空 | 已修 | :25-59（load + `_quarantineCorrupt`） |

`node --check src/domains/instance/store.js` → **exit 0（通过）**。

---

## 1. 积压 #4：端口变更后旧 `inst:*` 登记永久泄漏

### 1.1 改动

`syncPorts()` 的 per-instance 分支由「缺则补」改为「按 owner 对账后再补」：

- 新增 `:98` `const bound = ports.byOwner('inst:' + id);`
- 新增 `:99` 当 `bound !== null && Number(bound) !== port`（即该 id 已登记但端口已变）时，先 `ports.unregister('inst:' + id)` 移除其全部旧登记；
- `:100` 保留原逻辑 `if (!ports.isRegistered(port)) ports.registerUser(port, 'inst:' + id);`（**逐字保留**，未改写）；
- `:103-109` 原「registry 有 `inst:*` 而内存无对应实例则 unregister」清理**原样保留**；
- 三者同处一个 `try/catch`（`:97-101`），异常仍走原 warn 文案（`'syncPorts register ' + id + ':' + port + ': '`，未改字符串）。

### 1.2 证据（file:line）

- 修复前缺陷定义：`design-notes/AUDIT-r5-instance-plugin-shell.md:65-66`、`design-notes/_p3-e-audit-backlog.md:78`、作业单 §3 P4-A 行 34。
- `ports` 为共享单例：`src/platform/service/ports/index.js:10`（`shared = new PortRegistry()`）。
- `byOwner(owner)`：`src/platform/service/ports/pool.js:131-134`，返回首个同 owner 的 port 或 `null`。
- `unregister(owner)`：`src/platform/service/ports/pool.js:99-105`，删除该 owner 的**全部**记录并 `_save()`。
- `registerUser(port, owner)`：`src/platform/service/ports/pool.js:87-96`，端口已登记即**抛错**且**不迁移**同 owner 的旧登记 —— 这正是旧 `inst:*` 永久泄漏的机制。
- 记录加载保序（关键）：`src/platform/service/ports/store.js:20-29` 逐条 push、不排序；`saveRecords` 写 `[...this._records.values()]`（`pool.js:63` 调用，Map 插入序）。故历史泄漏对中「旧端口记录先于新端口记录」，`byOwner` 必返回旧端口（≠ 当前）→ 触发本轮 unregister+register，**存量泄漏也会在首次 load 后被对账清除**。
- 调用面：全仓 `syncPorts` 仅 `store.js:47`（`load()` 内）调用，无其它调用点（grep 全仓确认）。

### 1.3 行为变更声明

1. **常态**：同 id 的登记端口与配置 `inst.port` 一致时行为与旧实现完全相同（`isRegistered` 为真 → 跳过）；稳态不新增写盘、不新增日志。
2. **端口变更**：先移除旧 `inst:<id>` 登记，再登记新端口。旧 `inst:*` 记录不再泄漏（本轮修复目标）。
3. **落盘次数**：`unregister`/`registerUser` 内部各自 `_save()`（`pool.js:104`/`:94`）。端口变更那一拍的 `load()` 会多一次 `ports.json` 写（旧实现变更时本来也会因 `registerUser` 写一次；现为「unregister + 视情况 register」1–2 次）。稳态（端口未变）零新增写。
4. **冲突降级语义变化**：若新端口已被他人登记或位于保留池，旧实现会**保留旧端口的陈旧登记**；新实现先移除本实例旧登记，随后 `isRegistered` 为真则跳过（不抢占他人），或 `registerUser` 抛错被 `catch` 记 warn（文案不变）。此时该实例本轮**没有** `inst:*` 登记。这是有意取舍：宁无登记，也不留错误端口投影。
5. 返回值、内存数组身份、`_replace` 语义均不变。

### 1.4 CI 风险点

- `test/instance-safety-test.js:74` 断言域级正则 `/ports\.unregister\('inst:' \+ id\)/` 必须命中。该字面量在 `src/domains/instance/ops.js:67`（未改），且新代码 `store.js:99` **同样新增**了该形态 → 命中点只增不减，不会转红。
- `test/instance-safety-test.js:149-153` 从域聚合文本抽取 `addInstance` 函数体，要求其中出现 `ports.registerUser(port, 'inst:' + id)`。该字面量在 `ops.js:43`（未改），且 `store.js:100` **逐字保留** → 锚点不受影响。
- `test/round13-ports-release-test.js:96-106` 扫描 `.release(` 调用方；新代码用 `unregister`，不是 `release` → 无关。
- `test/ports-claim-test.js`、`test/reconcile-instance-test.js:297` 只对非 `inst:` owner 使用 `byOwner` → 无交互。
- 注释钉子门禁 `test/comment-pin-gate-test.js`：CP-4 五条登记针均不在本文件；CP-5（硬）为「单目标测试 + ≥6 连续汉字/≥10 ASCII」，当前**无任何测试以 `store.js` 为唯一目标**；新注释 CJK token 在 `test/` 反查 0 命中（见 §3）→ 不触发。CP-1 全量为 report-only。
- 残余边界（不在本修法内）：`byOwner` 只返回首个同 owner 记录。若**外部手工编辑** `ports.json` 把「当前端口」排在同 id 的旧端口之前，则可能漏清一个重复项；本仓代码路径无法产生该排序（旧记录总是先插入），故仅登记、不再加码（作业单明确要求 `byOwner` 对账口径）。
- 残余边界：修复只在 `load()` 生效；运行期若不重载 store，同 id 端口变更不会即时对账（与作业单口径一致）。

---

## 2. 积压 #11：`instances.json` 解析失败静默清空

### 2.1 改动

`load()` 的单一 `catch { this._replace([]); }`（旧 :29）改为区分三态，并抽出隔离助手：

- `load() :25-49`：先单独 `fs.readFileSync`；
  - `:31` `ENOENT`（首启无文件）→ `_replace([])`，**不告警、不备份**；
  - `:32` 其余读失败（EACCES/EISDIR 等，文件存在但读失败）→ `_quarantineCorrupt(e)`；
  - `:34-39` 读成功后仅对 `JSON.parse` 单独 try；解析失败 → `_quarantineCorrupt(e)`；解析成功 → 原 `Array.isArray(doc.instances)` 逻辑清空/装载。
- 新增 `_quarantineCorrupt(err) :51-59`：**先** `logger.warn`（含 `err.message` 与备份目标路径）→ `fs.renameSync(this.instancesFile, this.instancesFile + '.corrupt-' + Date.now())` **再** `this._replace([])`；rename 抛错时补一条 warn，但仍清空（best-effort，不阻断启动）。

### 2.2 证据（file:line）

- 改动前现场：`design-notes/AUDIT-r5-instance-plugin-shell.md`（B2）、`design-notes/_p3-e-audit-backlog.md:85`、作业单 §3 P4-A 行 35；旧代码 `store.js:29`（历史行号）。
- 同仓既有同款约定：`src/domains/router/store.js:38-39` 用 `renameSync` 把损坏文件保留为 `.corrupt-<ts>`（`providers.json` 场景）。
- 命名断言参考：`test/round13-robustness-batch-test.js:162-163` 期望存在 `.corrupt-` 备份（对象是 `router/store.js`，非本文件；命名约定一致）。
- 依赖已在位：`node:fs` 于 `store.js:7` 引入，未新增包。

### 2.3 行为变更声明

1. `ENOENT`：与旧实现一致——清空且无日志、无备份。
2. 文件存在但读取失败（非 ENOENT）或 JSON 解析失败：新增 `logger.warn`（**warn 级**，1 条；备份失败再补 1 条），随后把损坏文件改名到 `<instancesFile>.corrupt-<epoch-ms>`，再清空内存。**备份先于清空**，故后续 `save()` 只写新的空 `instances.json`，不会覆盖 `.corrupt-<ts>` 现场。
3. 备份采用 **rename（移动）**：备份成功后原 `instances.json` 不复存在，下一次 `save()` 重新写出。选型理由：与 `router/store.js:38-39` 一致，且对「文件不可读（EACCES）」场景仍能保留现场（copy 需先读）。
4. 若 rename 失败（权限/跨设备等）：补 warn 后仍 `_replace([])`；此时原文件保留未动，后续 `save()` 仍可能覆盖它（best-effort 上限，已如实告警）。
5. 合法 JSON 但形状非对象/无 `instances` 数组（含 `null`）：仍静默 `_replace([])`。其中 `null` 在旧实现里经 TypeError 落 catch，新实现经 `doc &&` 短路落到同一结果，**无告警差异**。
6. 日志形状为新增（warn 文案为新增字符串）；返回/持久化格式/数组身份不变。

### 2.4 CI 风险点

- 全仓无任何针对 `instance/store.js` 损坏路径的断言；`test/round13-robustness-batch-test.js:137-171` 的 `corrupt`/`.corrupt-<ts>` 断言对象是 `src/domains/router/store.js`，不读取本文件。
- `test/token-boundary-test.js:86-92` 写合法 `instances.json` 后 `load()`，走合法读取分支，不受影响。
- 新增日志不改变返回/状态码；无测试断言本 store 的日志条数或 `instances.json` 在损坏后必须存在。
- `save()` 语义未改；`_lastBody` 去重仍生效（损坏清空后首次 `save()` 因内容由 `null` → `{"instances":[]}` 而写盘一次，符合「内存权威」设计）。

---

## 3. R1 反查登记（新增/改写注释）

方法：把注释切成 ≥4 字 CJK 串与 ≥6 字符 ASCII 串，逐 token 在 `test/` 反查（CJK 以 `\p{Han}{4,}` 等价逐串 grep）。

| token | 类型 | `test/` 命中 | 处置 |
|---|---|---|---|
| 首启尚无文件 / 属合法空态 / 其余读失败按损坏处理 | CJK | 0 | 可新增 |
| 损坏现场隔离 / 再把损坏文件改名为 / 最后清空内存 / 会覆盖原文件 / 后原文件不再被覆盖 | CJK | 0 | 可新增 |
| 已登记端口与当前配置端口不一致 / 旧登记再按新端口 / 而永久泄漏 | CJK | 0 | 可新增 |
| ENOENT | ASCII | 10（`platform-layer-portability-test.js` 等注释） | 命中即保留（新注释保留该词） |
| 保留现场 | CJK | 2（`round13-robustness-batch-test.js:34/162`） | 命中即保留（新注释保留该词） |
| corrupt / rename | ASCII | 3 / 7 | 命中即保留 |
| registerUser / unregister | ASCII | 7 / 16 | 命中即保留 |

- 既有 `syncPorts` 文档注释（旧 :67-69）的 CJK 分片在 `test/` 全部 0 命中；本次仅**追加**两行，未删除既有文字，`registerUser`/`unregister`/`inst:` 等命中词均原样保留。
- 结论：无「删除被测试钉住的注释」风险；未改 `test/`。

---

## 4. 残余与边界（供主控裁决，不在 P4-A-1 范围）

1. `syncPorts` 仅 `load()` 调用；运行期不重载不触发对账（作业单口径如此）。
2. `byOwner` 单值语义对「同 owner 多项重复」只在首项≠当前端口时全清；外部手工重排 `ports.json` 才可能留一项（代码路径不可达，见 §1.4）。
3. #11 的备份为 rename，原文件被移走；若某调用方假定「损坏后 `instances.json` 仍在原位」，需知悉（全仓无此假定）。
4. #11 新增 warn 文案含 `err.message`；若上游对日志做精确匹配（未发现此类门禁），需同步。

---

## 5. 交付物

- `src/domains/instance/store.js`（唯一被改产品文件）
- `design-notes/_p4-a-1-store.md`（本报告）
