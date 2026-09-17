# P4-A 交付报告：instance + settings（积压 #4/#11/#10/#6/#30/#29）

> 负责人 P4-A。独占范围：`src/domains/instance/**`、`src/app/settings/**`（**排除 `token-kinds.js`**，已由主控让渡给 P4-C）。
> 未跑任何测试/门禁；未 `require` 产品模块或执行它；未做 git 写；未改 `test/`；未碰 `/tmp/dsh-*` 与状态根。
> 行号以写入本报告时的当前工作树为准；合并时请按「文件 + 符号」定位。

## 0. 范围与下级分配（文件互斥）

| 执行者 | 独占文件 | 任务 |
|---|---|---|
| P4-A（本人） | `src/domains/instance/ops.js`、`src/app/settings/lan-panel.js` | #10；#6 的同型旁路（见 §4） |
| P4-A-1（下级） | `src/domains/instance/store.js` | #4、#11 |
| P4-A-2（下级） | `src/app/settings/access.js`、`src/domains/instance/model.js` | #6、#30 |

改动文件共 **5 个**（+83/−10）：`instance/store.js`、`instance/ops.js`、`instance/model.js`、`settings/access.js`、`settings/lan-panel.js`。

## 1. #4 端口变更后旧 `inst:*` 登记永久泄漏 —— 已修（P4-A-1）

- 改动：`store.js` `syncPorts()` per-instance 分支新增 owner 对账 —— `:98` `ports.byOwner('inst:'+id)`；`:99` 已存在且 ≠ 当前 `inst.port` 时先 `unregister('inst:'+id)`；`:100` 保留原 `registerUser(port, 'inst:'+id)`（逐字未改）；`:103-109` 原「实例已不存在则清」清理原样保留。
- 证据：`ports` = `platform/service/ports/index.js:10` 的单例；`byOwner`/`unregister`/`registerUser` 见 `ports/pool.js:131-134 / 99-105 / 87-96`（`registerUser` 对已登记端口**抛错**且**不迁移**同 owner 旧登记 —— 这正是泄漏成因）。记录加载**保序不排序**（`ports/store.js:20-29`），故存量泄漏对中旧端口在前，首轮 `load()` 即清除。
- **行为变更声明**：① 端口变更时旧登记先移除（多一次 ports.json 落盘）；② 新端口被他人占用或位于保留池时，由「留陈旧登记」变为「本轮无登记」（**宁无不错** —— 登记一个实例并不使用的端口会同时阻塞他人且保护不了真实端口），异常仍走原 warn 文案。
- 本人复核：逐行确认三态分支正确；并**全仓排查同类点** —— `src/domains/instance/**` 内无其它代码给 `inst.port` 赋值，`updateInstance` 也不接受 `port`（端口变更的真实来源是用户编辑 instances.json），故修复位置覆盖真实路径。`router/**` 的 `inst.port =`（`providers/probe.js:53/104`、`model.js:87`）是**代理实例**、另域另持久化，不属本项。
- 边界（已登记，未加码）：`syncPorts` 仅由 `load()` 调用，运行期不重载则不触发。

## 2. #11 instances.json 解析失败静默清空 —— 已修（P4-A-1）

- 改动：`load()` 拆三态（`:25-49`）：**ENOENT**（首启无文件）→ 清空、不告警、不备份；**读失败非 ENOENT / JSON 解析失败** → 新增 `_quarantineCorrupt()`（`:51-59`）：先 `logger.warn` → `renameSync` 到 `<instancesFile>.corrupt-<ts>` 保留现场 → 再 `_replace([])`；备份失败补 warn 后仍清空。
- 关键次序：**备份先于清空**，故后续 `save()` 不会覆盖损坏现场。
- **行为变更声明**：损坏时新增 1-2 条 warn 日志；原文件被改名移走（下次 save 写新空文件）。合法 JSON 但形状不符（`doc.instances` 非数组）仍静默清空 —— 与旧行为一致，未扩大改动面。无新依赖。

## 3. #10 `inst.sandbox` 未 guard —— 已修（本人）

- 改动：`ops.js:118` 新增 `if (patch.memoryMax !== undefined || patch.cpuQuota !== undefined) inst.sandbox = inst.sandbox || {};`，原两行写入（`:119-120`）逐字保留。
- 证据：`model.normalizeInstance`（`model.js:20-29`）只补 `guardian`/`state`，**不建 `sandbox`**；`createRecord` 才建。故历史/手工编辑的实例记录走 `updateInstance` 会 `TypeError`，而此前 `guardian`/`remoteEnabled` 可能已被改 → **半改状态**。
- **全仓排查同类点**（P3 教训：别只修被点名的那一处）：`\.sandbox\.[成员]\s*=` 全仓仅 `ops.js:116-117` 两处，**无旁路**；而所有**读取**点（`sandbox.js:41-44`）本就写成 `(inst.sandbox && inst.sandbox.memoryMax)` —— 读侧早有 guard，写侧缺失，本次补成对称。
- 行为变更：无（仅在缺失时补空对象，正常记录路径不变）。

## 4. #6 持久化失败仍回 `ok:true` —— 已修（P4-A-2）+ **同型旁路一并收口（本人加做）**

### 4.1 `settings/access.js`（P4-A-2）
- 改动：`:3` 顶层 `require('node:fs')`（DG-15：函数体内 require = 0）；`:14-25` 新增 `verifyPersisted(configPath, patch)` 回读配置文件逐键比对；`:53-58` `setAccessKey`、`:79-84` `setCloseAction` 落盘后核验，非 null 即 `return { ok:false, error }`。P3-A 的 `lanClosed`/apiHost 回环逻辑**逐字保留**。
- **行为变更声明**：① 返回契约由恒 `{ok:true,...}` 变为「有 configPath 且回读核验不通过 → `{ok:false,error}`」（原因文案 `配置未落盘: <key>` / `配置读取核验失败: <msg>`）；② 对应 HTTP `POST /settings/access-key`、`/settings/close-action` 由 200 变 **500**（`api/domains/guard.js:93` 既有映射，未改 guard）；③ 失败时不再 append `access_key_changed`/`close_action_changed`；④ **内存态 `this.config` 不回滚**（`ok:false` 仅表示未落盘）；⑤ 成功路径与无 configPath 语义逐字不变。
- 无断言风险：全 `test/` 对 `setAccessKey`/`setCloseAction`/`accessKeyStatus`/`closeActionStatus` **零引用**；唯一引用 `state.persistConfigPatch` 的是 `test/app-ctor-injection-test.js:88,90`，它测 state store 且不使用返回值。

### 4.2 `settings/lan-panel.js`（本人加做，作业单 #6 未点名）
- 理由：`setLanPanel` 的落盘失败同样只 `logger.error` 后照报 `ok:true`（`lan-panel.js:54`→`:59`），是 AUDIT D8 的**同型另一半**。P3 的教训正是「修了被缺陷命中的那一个、没修同类旁路」，且该文件在本工作流独占范围内，故一并收口。
- 改动：落盘 catch 记 `persistError`（保留原 `logger.error` 文案），在完成重绑与事件后 `return { ok:false, error, ...lanPanelStatus() }`。
- **行为变更声明**：落盘失败时 `POST /settings/lan` 由 200 变 **500**（`guard.js:93` 既有映射：`ACCESS_KEY_REQUIRED`→400，其余失败→500）；成功路径与 `ACCESS_KEY_REQUIRED`（未设密钥）分支逐字不变。
- 次序说明：**仍完成 `_apiRebind()` 与事件**，再报失败 —— 因为「内存是运行期权威」（与 `store.save()` 的既有降级纪律一致）；若跳过重绑，会让内存 `apiHost` 与监听 socket 不一致，比报失败更坏。返回值里的 `lanPanelStatus()` 投影如实反映当前绑定。
- 无断言风险：`test/` 对 `setLanPanel` **零引用**。

## 5. #30 三份平行实现 —— 已加注释（P4-A-2，仅注释、零行为）

- `instance/model.js:8-15` 标注 `taskStateToView` 与 `domains/plugin/model.js` 的 `taskStateToJobState`、`domains/router/ops/apps-registry.js` 的 `proxyUpdateStatus` 内联为**有意平行**，映射分支完全一致；差异仅在宿主投影（apps-registry 紧邻另算 `errors = t.state === 'failed' ? 1 : 0`，故 canceled 映射成 failed 而 errors 为 0）。
- 不抽公共函数（三处分属三域，须三处同批；backlog #30 已裁定）。
- **本人修正**：初版注释写死行号（`plugin/model.js:37`、`apps-registry.js:139`），实测 `taskStateToJobState` 在 `plugin/model.js:43`、:37 是注释起点 —— 写死行号本身就会变成下一条失效引用。已改为**按符号名定位**并在注释里写明该理由。

## 6. #29 零消费者导出 —— 重枚举结论：**本次删除数 = 0**

按作业单要求**不照抄旧清单**，用 `release/scripts/export-consumers.sh` 对当前树逐个核验：

### 6.1 `src/domains/instance/**`（21 个导出，全部 EX 核验）
`InstanceStore`、`root`、`dataDir`、`installDir`、`effectiveCommand`、`unitProps`、`sandboxEnv`、`supported`、
`createUpgrade`、`createDshInstall`、`InstanceManager`、`setRunning`、`setStopped`、`fail`、`restart`、
`taskStateToView`、`normalizeInstance`、`createRecord`、`viewRow`、`createOps`、`createLifecycle`

**21/21 结论均为「不可删（定义文件之外有消费者）」**，故**无一条可删**。单消费者项已逐条人工复核属实：
`createDshInstall`←`upgrade.js:33`；`unitProps`←`lifecycle.js:56`；`sandboxEnv`←`lifecycle.js:57`；
`createRecord`←`ops.js:44`；`viewRow`←`ops.js:20`；`dataDir`←`store.js:89`；`effectiveCommand`←`lifecycle.js:53`；
`supported`←`index.js:57`。`contract.js` 是门禁读的数据 SSOT（DG-9/DG-10），不在删除面。

### 6.2 `src/app/settings/**`（只读盘点；按令不改 `token-kinds.js`）
- 门面方法导出 14 个（`accessKeyStatus`/`closeActionStatus`/`setAccessKey`/`setCloseAction`/`autostartStatus`/`setAutostart`/`dshenvStatus`/`envStatus`/`lanPanelStatus`/`setLanPanel`/`guardCorePkg`/`guardVersionLocal`/`_readBinarySelfVersion`/`_vcsRoot`）—— 逐个 EX 核验，**无零消费者项**。
- ⚠ **重要反例（务必留给后人）**：EX 工具对 `_vcsRoot` 报「可删（仅定义文件内出现）」，但它是 `settings/versions.js` 的 `{methods}` 成员，被**同门面兄弟方法**经 `this._vcsRoot()` 调用（`versions.js:91`、`:112`）。`this` 是宿主、方法由门面统一安装，故**删掉该方法会让两个调用点运行时失效**。
  ⇒ **对 `{methods}` 门面，EX 的「定义文件之外消费者 = 0」是假阳性**：必须额外查「同文件内 `this.<名>` 间接消费」。本次因此**未删** `_vcsRoot`。
- `token-kinds.js`（**归 P4-C 独占**）：本节**仅只读观察**，不含改动；按主控要求**不提删除建议**。观察结论：其导出面在本次盘点中均有消费者，无需处置。

## 7. 移交上级（跨域，未动）

1. **`persistConfigPatch` 的返回契约**（`src/app/state/desired.js:58-73`，P4-C 域）：现失败只 `warn`、**无返回值**，故 `access.js` 只能用「回读核验」判成败。结构上更干净的做法是让它返回成败布尔（失败路径同样在 catch 里），`access.js` 已写成**不读返回值**的形式，将来改 boolean 兼容。请裁决是否派给 P4-C。
2. **`src/domains/plugin/model.js:38` 的引用已被本次改动漂移**（P4-C 正在改该文件）：它写 `domains/instance/model.js:9 \`taskStateToView\``，而本次在 `taskStateToView` 上方新增注释后该函数移到 **:16**。建议 P4-C 改为**按符号名**引用（与本报告 §5 同一纪律），否则又是一条失效行号引用。
3. `syncPorts` 仅 `load()` 调用：本项修复对「用户编辑 instances.json」这一真实路径有效；若将来 `/instances/update` 支持改端口，须同批调用 `syncPorts()`。

## 8. 约束遵守与 CI 风险

- `node --check`：5/5 通过。未跑任何测试/门禁；未 `require` 产品模块；无 git 写；`test/` 零改动；未碰 `token-kinds.js` 与 `compose/core.js`（`git status` 均证）。
- R1：新增/改写注释逐条切 CJK（`grep -oP '\p{Han}{4,}'`）+ ASCII≥6 串回扫 `test/`。仅两处命中且均为**测试自身散文**（`lifecycle-restart-failure-test.js:21` 的「同一纪律」、`app-this-ratchet-gate-test.js:82` 的「本函数与」），二者都**不读**本批文件，非断言钉子；前者已顺手改写措辞以保扫描干净。
- X-2：本报告三份 `_p4-a-*.md` 无操作者绝对路径。
- **CI 风险（逐项）**：
  1. #6 的两处 200→500 是**有意变更**；`test/` 对四个方法零引用，且 `guard.js` 映射未动 → 预期不转红；若转红应改断言而非回退。
  2. #4 新增一次 `ports.json` 写（仅端口变更时）；`test/instance-safety-test.js:74` 的域级正则 `/ports\.unregister\('inst:'\+id\)/` **只增不减**，`:149-153` 的 `addInstance` 锚点在 `ops.js:43` 未动 → 预期不转红。
  3. #11 仅在损坏路径新增 warn + rename；正常/首启路径不变 → 预期不转红。
  4. #30 与 #10 无行为变更。
  5. 最终以 CI 四平台裁决；本报告不构成验收结论。
