# P4-B-2 交付报告：relay（#18 / #19 / #29-relay）

> 范围：`src/domains/relay/**`（唯一独占）。仅改 7 个 relay 文件 + 本报告。
> 未运行任何测试/门禁；未 require 产品模块、未做内存冒烟；未做 git 写操作；未启 daemon；
> 未给 `package.json#dependencies` 加包；未改 `test/`。
> 工作树内其它非 relay 文件的改动来自并行工作流，不在本报告范围。
> 行号为写入本报告时的当前树（工作树被多代理并行修改，定位请以「文件 + 符号」为准）。

---

## 0. 结论摘要

| 积压# | 结论 | 改动文件 |
|---|---|---|
| 18 | frp「启用」写侧拒启 + frpc spawn 执行边界无条件复校，双闸共用一个纯函数 | `core.js`、`ops.js`、`frp.js` |
| 19 | 核实后确认**不可能出现重复 id**；只修注释使其与行为一致（选 b） | `managed.js`、`ops.js` |
| 29(relay) | 重新枚举后删除 3 个零消费者导出键（`ports.list`、`port-segments.SEGMENTS`、`session.hasCookie`）。EX 建议可删 9 项，复核后仅删 3；**EX 结论不作依据，已全部原始 grep 复核；本轮删除数 = 3** | `ports.js`、`port-segments.js`、`session.js` |

逐文件 `node --check`：15/15 relay 文件通过（见 §4）。改动行数：core.js 182→194、frp.js 247→251、
ops.js 279→283（≤DG-2 300）、managed.js 32→37、ports.js 54→51、port-segments.js 18→19、session.js 147→145。

---

## 1. #18 frp 启用但 serverAddr 为空仍 start frpc

### 1.1 缺陷与启用入口定位

- `frp.js:55`（未改）`loadSettings()` 把 `serverAddr` 归一为 `String(s.serverAddr || '')`，空值被静默接受。
- 启用入口有三条，原先都无 `serverAddr` 校验：
  1. **全局设置启用**：`ops.js#frpAction('settings')`（原 `:126-131`）`normalizeFrpSettings` 后无条件 `saveSettings`，再 `syncFrpc()`；
     写出的 `frp.json {enabled:true, serverAddr:''}` 会被 daemon 冷启动（`daemon.js:130-136 tick → syncFrpc`）读取并 `start frpc`。
  2. **执行边界**：`frp.js#syncFromInstances`（`:88-106`）在 `settings.enabled && count>0` 时 `restart()→start()`，只校验 bin 是否存在，不校验地址。
  3. **手动 toggle**：`ops.js#frpAction('toggle')`（`:141`）直接 `this.frp.start()`，`start()` 原 `:113-114` 完全不读 settings。

### 1.2 修法（两闸 + 一个纯函数）

- `core.js:151-160` 新增纯函数 `validateFrpServerSettings(settings)`：`serverAddr` trim 后为空即
  `{ok:false, error:'启用 frp 前必须填写服务器地址（serverAddr）'}`；否则 `{ok:true}`。
  未新增 require（core.js 仍零 IO，DG-3 不受影响）；已加入 `core.js:185-195` 的 `module.exports`。
- **写侧拒启** `ops.js:129-132`：`frpAction('settings')` 在 `saveSettings` **之前**
  `const vs = next.enabled ? validateFrpServerSettings(next) : { ok: true };`，不通过即
  `return { ok:false, error }`（不落盘、不 `syncFrpc`）。关闭方向（`enabled:false`）不受闸，允许停用后清空地址。
- **执行边界复校** `frp.js:115-118`：`start()` 在任何 spawn 之前无条件校验地址，失败返回
  `{ ok:false, error, needServerAddr:true }`。`restart()`/`syncFromInstances()`/`_scheduleRestart()`/
  `frpAction('toggle')` 全部经 `start()`，故覆盖「旧版 frp.json enabled:true」「ctl 直写」「停用态手动 toggle」所有 spawn 路径。
- `ops.js:10`、`frp.js:14` 的 require 解构各加一个键（不增行）。
- **未回退 P3-F 的 FIX-1**：`ops.js#syncFrpc`（`:150-175`）的 `validateFrpExposure` 复校逐字保留，只在 `frpAction('settings')` 内**新增** 4 行。

### 1.3 行为变更声明（#18）

- `LanManager.frpAction('settings', body)`：当结果设置 `enabled===true` 且 `serverAddr` 为空时，
  返回值从 `{ok:true, ...frpStatus()}` 变为 `{ok:false, error:'启用 frp 前必须填写服务器地址（serverAddr）'}`，
  且**不持久化**、**不**触发 `syncFrpc`。原先该调用会落盘 `enabled:true` 并在后续 spawn 一个连不上任何 frps 的 frpc。
- `FrpManager.start()`：新增失败返回 `{ok:false, error, needServerAddr:true}`（任何 `serverAddr` 为空的 spawn 请求）。
- `FrpManager.syncFromInstances()`：地址为空时其内部 `restart()` 的返回值现在是上述失败对象（原为 spawn 结果）；
  `ops.js#syncFrpc` 对该结果只读 `needInstall`，故无额外副作用、不 spawn。
- 对外 HTTP 形状：`/lan` 的 frp settings 动作失败时如实回 `ok:false`（此前恒 `ok:true`），符合「未验证不得报成功」不变量。

### 1.4 证据

- 纯函数：`core.js:151-160`；导出：`core.js:185-195`。
- 写侧闸：`ops.js:129-132`；调用点 `ops.js:124-135`。
- 执行边界闸：`frp.js:115-118`；`start()` 定义 `frp.js:113`。
- 既有 FIX-1 复校保留：`ops.js:150-175`（`validateFrpExposure` 逐字未动）。
- 消费入口：`src/app/domain-actions/lan.js:35-38`（daemon→ctl / 本地→`lan.frpAction`），错误原样透传。

### 1.5 CI 风险

- 全仓无测试对 `frpAction('settings')` 做行为断言：`grep -rn "frpAction" test/` 仅命中
  `test/domain-structure-gate-test.js:544`（只匹配源码正则 `.frpAction(`）与 `:953`（合成样本），不驱动本路径。
- `test/frp-resilience-test.js` 的 `saveSettings({enabled:true, serverAddr:'127.0.0.1'...})`（`:53/:96`）与
  `syncFromInstances`（`:55/:97`）均带非空地址，新闸放行，不受影响。
- `test/round13-router-relay-gaps-test.js:56-66` 读 `ops.js`/`core.js` 断言 `validateFrpExposure` 与错误串，
  本次未删改这些串/函数；新增 `validateFrpServerSettings` 不进该断言。
- `contract.js#PUBLIC_API`/`classApi.FrpManager` 未变（`start` 仍在），DG-9/DG-10 不受影响。
- 反向自检：`frp.start()` 的失败分支在 `this.child` 已存在时**不触发**（`:114` 早退），
  故不会误杀已连通的实例；只有「无子进程且地址为空」才拒绝。

---

## 2. #19 受管清单 main 优先级与注释不符

### 2.1 核实：`instances.all()` 是否可能出现 id `main` / domain `native`

**会**，但**不会与 `mainOf()` 同时出现**（即不会在同一 `allManaged()` 结果里重复 id）：

1. **沙箱创建路径不可能产出 id `main`**：`src/domains/instance/ops.js:34` 生成
   `id = 'inst-' + Date.now() + '-' + random`；`src/domains/instance/model.js:35-61 createRecord` 恒写
   `domain:'sandbox'`；`normalizeInstance`/`updateInstance` 均不改 `id`/`domain`。
2. **历史 main 记录在装配期被迁出**：`src/app/assembly/compose/domains.js:54` 在 `instances.load()` 后调
   `host._migrateMainRecord()`；`src/app/state/store.js:64-92` 找到 `id==='main'` 即（无论 dsh-main.json 是否已存在）
   `im.instances.splice(idx,1)` 并 `save()`。守卫内嵌模式因此看不到 main 记录。
3. **daemon 模式下确实会出现 main**：`src/app/daemons/runtime.js:66-69` 把
   `instances.all()` 与 `views.dshMain()`（`src/app/facade/main.js:13,17`，`id:'main', domain:'native'`）合成写进
   `lan-state.json`；`daemon.js:104-115` 把它灌入 `lanSource.instances`。但 `daemon.js:78-85` 构造 LanManager 时
   **不注入 `mainOf`**，故 daemon 侧 `allManaged` 的 `mainOf()` 为 `null`，main 只出现一次（经 `all()` 进数组）。
4. 两模式互斥：`src/supervisor.js:27-28` `get lan()` 在 `lanDaemonEnabled()` 时返回 `null`，守卫内嵌不承载 relay；
   `src/supervisor.js:39-47` 才注入 `mainOf:()=>({id:'main',domain:'native',...})`。

结论：唯一可能「同一次 `allManaged()` 出现两份 id=main」的形态是「`instances.all()` 含旧 main 记录 **且**
注入 `mainOf`」——该组合在当前树不存在（迁移先于消费，两模式互斥）。因此**不是重复 id 真缺陷**，
按作业单选 **(b) 只修注释**。

### 2.2 改动（注释，行为零变更）

- `managed.js:20-25`：把「main 优先守卫视图」的失实描述改为实际语义（沙箱在前、main 在尾部），并写明
  id 空间不相交的两条事实依据（`instance/model.js#createRecord` 生成 `inst-*`；`app/state/store.js#migrateMainRecord`
  装配期迁出历史 main），以及 daemon 模式由 `lan-state.json` 承载 main、`mainOf` 为 null。
- `managed.js:32`：`findManaged` 注释改为「按 id 取首个匹配（清单无同 id 项）」。
- `ops.js:56`：同一处注释同步（避免第二份失实描述）。
- **未动** `managed.js#allManaged` 的 `return main ? [...sandboxes, main] : sandboxes;`（`:29`）与
  `findManaged` 函数体（`:33-34`），也**未回退** P2/DG-11 的 `instances.all()` 查询接口（`:27`）。

### 2.3 行为变更声明（#19）

- **无**：清单条数/顺序不变，`findManaged` 行为不变，`_allManaged()` 消费者（`ops.js` 的 `list/setFrp(peers)/frpStatus/_findManaged`、
  `ops/reconcile.js#reconcileOnce`）均不依赖顺序，且无重复项可剔除。

### 2.4 R1 注释 token 自检

- 被删除/改写的 token：`合成查找`、`优先守卫视图`、`其余走沙箱数组` → 在 `test/` 中
  `grep -oP '\p{Han}{4,}'` 与整句 grep **均 0 命中**，可改。
- 保留 token：`受管 DSH 合成清单`、`原生主干` 未删（`原生主干` 在 `test/api-contract-test.js:133`、
  `test/ports-verify.js:48` 有命中，本就不动这些文本）。
- ASCII token `allManaged`/`findManaged`/`instancemgr` 在 `test/` **0 命中**；`mainOf` 在
  `test/domain-structure-gate-test.js:624` 命中（依赖注入登记表），本改动未触碰 `mainOf` 语义。

### 2.5 CI 风险

- 纯注释，无运行时影响；无门禁读这两条注释内容（DG-9 只解析 `index.js` 导出字面量键）。
- 若未来新增注入 `mainOf` 且 `all()` 含 main 的路径，(b) 不提供防御；已在注释中写明该前提，
  届时应升级为 (a)（main 置头 + 同 id 剔除），并声明清单顺序变更。

---

## 3. #29(relay) 当前树零消费者导出重枚举与删除

> **纪律声明（硬要求）**：`release/scripts/export-consumers.sh`（EX）存在**系统性假阴性**（危险方向：误报「可删」）——
> 其定义行判据含裸子串 `sym( ... ) {`，不校验词边界，会把门面转发器 `_foo(x) { return foo(x); }` 判为「定义行」，
> 将同文件真实消费点藏入定义文件。**本报告所有 #29 结论一律不以 EX 的「可删」为依据**；每个候选均做了
> ① 原始 `grep -rn <符号>`（含 `src test bin *.md`，排除 `node_modules/.git`）复核；
> ② 同文件内 `this.<名>` 间接消费检查；③ EXECUTION-CONTRACT.md「必须导出」表比对；④ 泛型名按「文件 + 符号 + 调用形态」核验。
> **本轮删除数 = 3**（`ports.list`、`port-segments.SEGMENTS`、`session.hasCookie`）；EX 建议可删共 9 项，其余 6 项经复核为误报，全部保留。

### 3.0 四条硬要求逐条自检

1. **不以 EX 结论为据 + 原始 grep 复核**：3 个删除项的原始 `grep -rnw` 证据见 §3.2 各行。
   EX 判「可删」的 6 项（`allManaged/findManaged/syncProxyQueued/reconcileOnce/startLanServer/stopLanServer`）
   经原始 grep 证实是 `ops.js` 的**真实跨文件消费**（下划线包装 `_allManaged(){ return managed.allManaged(...) }`
   触发 EX 裸子串误判），全部保留（§3.3）。
2. **同文件 `this.<名>` 间接消费**：relay 已知的 `{methods}` 门面转发形态在 `src/domains/relay/**` 内**不存在**
   （域内无 `module.exports = { methods }`）。全域 `this.list` 仅 `ops.js:110` 一处，实为 `LanManager.list()`（`ops.js:61` 定义）
   自调用，**与本批删除的 `ports.list` 无关**；`grep -rnE "this\.(list|hasCookie|SEGMENTS|allManaged|findManaged)" src/domains/relay/` = 仅该 1 处。
   另查无 `Object.keys/Object.values/...spread` 作用于 relay ports 模块（`grep` = 0）、无 `portsvc['list']` 形式访问（=0）。
3. **EXECUTION-CONTRACT.md「必须导出」表比对**：该文件 §3.2 必须导出表为 **router 域专属**（`model.js`/`store.js`/
   `views.js`/`scheduler.js` 等，含 `stateContainer`——非本分片文件）；relay 的冻结对外面是 §0.6 的 `LanManager`
   （`EXECUTION-CONTRACT.md:37`）。本批删除的 3 个键**均不在该表、也不在 `src/domains/relay/contract.js` 的
   `exports`/`PUBLIC_API`/`classApi`**（`contract.js:10-31`），故不违反冻结面。
   ⚠ 顺带说明：`ports.list` 曾被 P2 过程文档 `design-notes/_p2-ws1b-domains-router-b.md:61` 以「契约面」为由保守保留——
   该行是**过程记录里的保守取舍**，非机器校验契约；经本次「模块限定」核验，`ports.js` 的 3 个 requirer 里
   `list` 零消费（`platform/service/ports#list` 与 `instance.list`/`LanManager.list` 是同名不同物），故解除该保守保留。
4. **泛型名按文件+符号+调用形态核验**：`SEGMENTS`/`list` 属泛型名，未裸 grep 计数，改为
   「模块限定 require 清单 + 成员调用形态」核验（§3.2/§3.3）；EX 报的 `SEGMENTS` test=2 已核实为
   `test/_ports.js` 自有常量与 `router/port-segments.js` 的同名符号碰撞。

### 3.1 方法

对 `src/domains/relay/**` 全部 15 个文件的每个导出键（共 37 个），逐个跑
`release/scripts/export-consumers.sh <符号> --defs`，再按 §3.0 四条以**模块限定 grep 复核**
（工具按全仓符号词边界判定，同名跨模块符号会互相污染，故工具结论只作初筛、不作依据）。
R2 判据：定义文件之外、`src|test|bin|release|ui` 任一命中即不得删。

### 3.2 删除清单（3 项）与逐项消费者证据

| # | 文件 | 删除的导出键 | 消费者计数证据 | 函数体处理 |
|---|---|---|---|---|
| 1 | `src/domains/relay/ports.js` | `list` | relay/ports 的 requirer 全仓仅 3 处：`ops.js:8`、`ops/reconcile.js:7`、`ops/lan-servers.js:8`（原始 grep：`require('./ports')`/`require('../ports')` 仅此 3 处，绝对路径 `domains/relay/ports` 仅 design-notes）；其成员调用只有 `rangeOf`(`ops.js:226`)、`claim`(`:227`)、`purgeDuplicates`(`:248`)、`ensureMarked`(`:249`)、`releaseOwner`(`ops.js:265`/`reconcile.js:28,95`/`lan-servers.js:52`)，**无 `.list`**；`grep -rnE "domains.{0,4}relay.{0,4}ports" test/ release/ bin/` = 0；无动态键遍历（`Object.keys/values(spread)` = 0）、无 `portsvc['list']` = 0。P2 过程文档 `_p2-ws1b-domains-router-b.md:61` 曾保守保留，本次解除（见 §3.0 规则 3）。函数体内部亦零引用。 | 删除函数体 + 导出键 |
| 2 | `src/domains/relay/port-segments.js` | `SEGMENTS` | requirer 仅 `ports.js:6`（`require('./port-segments')` 副作用，无解构）与 `test/ports-capacity-test.js:28`（绝对路径 require，同样只取副作用）；全仓无对 relay 模块取 `.SEGMENTS`。常量本体仍被 `:16 ports.registerSegment(SEGMENTS)` 使用。 | 保留常量，仅删导出键（`module.exports = {}`） |
| 3 | `src/domains/relay/session.js` | `hasCookie` | 工具：`hasCookie` 定义外消费者 = 0（删除前全仓仅 3 命中 = census 注释 + `:130` 定义 + `:141` 返回键）。`proxy.js`/`tunnel.js` 消费的是 `currentCookie/hasToken/status/mergeDshCookie/invalidate/ensureDshCookie/mergedCookieHeaders/refreshDshSession`，无 `hasCookie`。 | 删除函数体 + createSession 返回对象的键 |

### 3.3 复核后**不删**的疑似项（工具误报，逐一说明）

工具对以下 6 个符号给出「可删」，但均为**误报**，未删：

- `managed.js`：`allManaged`、`findManaged`
- `ops/reconcile.js`：`syncProxyQueued`、`reconcileOnce`
- `ops/lan-servers.js`：`startLanServer`、`stopLanServer`

原因：工具的 `is_definition_line` 形态 3（`*"${sym}("*") {"* | *"${sym}()"*`）会被 relay `ops.js` 的
**下划线包装方法**命中——例如 `ops.js:55 _allManaged() { return managed.allManaged({...}) }` 含子串
`allManaged()`，于是整行被误判为「定义行」，`ops.js` 被并入定义文件；`ops.js:57/188/192/271/272` 同理。
这些是**真实跨文件消费者**（`_findManaged`/`_reconcileOnce`/`_syncProxyQueued`/`_startLanServer`/`_stopLanServer`），
删导出键会让 `ops.js` 立即 `undefined is not a function`（与历史 `contract/runtime.js` 的 `file` 误删同型事故）。
按 R2「有消费者即不得删」，全部保留。

其余导出键（`index.js` 门面 5 键、`core.js` 8 键、`frp-install.js` 4 键、`tunnel.js`/`session.js`/`proxy.js`/
`frp.js`/`ops.js` 的构造器、`ports.js` 其余 5 键、`ops/reconcile.js` 其余 4 键、`ops/lan-servers.js` 其余 3 键、
`managed.js` 3 键、`contract.js` 契约数据键）经复核均有 ≥1 外部消费者，或属契约/入口（「绝不能删」清单），不删。

### 3.4 行为变更声明（#29）

- `require('src/domains/relay/ports').list` → 由函数变为 `undefined`（无消费者）。
- `require('src/domains/relay/port-segments').SEGMENTS` → `undefined`（副作用 `registerSegment` 不变，
  `test/ports-capacity-test.js` 只依赖副作用，不受影响）。
- `createSession(opts).hasCookie` → 不存在（无消费者）。

### 3.5 CI 风险（#29）

- 无 `test/`、`bin/`、`release/` 消费者（§3.2 逐项证据）；`test/ports-capacity-test.js:27-28` 仍因顶层
  `registerSegment` 副作用通过；`test/ports-claim-test.js` 用的是 `platform/service/ports`（`:20`），与本域无关。
- 无门禁要求 `port-segments.js` 非空导出（`grep -rnE "module.exports\).length|导出非空" test/` = 0）；
  DG-9 只比对 `index.js` 导出字面量键，本批未动 `index.js`，`contract.js#exports` 无需同步。
- 反向自检：工具对 `SEGMENTS` 删后仍报「定义文件之外有 2 处消费者」，经核实那 2 处是
  `test/_ports.js:126` 自有的 `SEGMENTS`（被 `test/test-port-discipline-test.js:77,93` 消费）与
  `src/domains/router/port-segments.js` 的 `SEGMENTS`，非 relay 被删符号——属同名跨模块污染，非 R2 消费者。

---

## 4. node --check 结果

对 `src/domains/relay/` 全部 15 个文件执行 `node --check`（逐个独立），**15/15 通过**：
`index.js / contract.js / tunnel.js / ports.js / core.js / ops/lan-servers.js / ops/reconcile.js /
port-segments.js / proxy.js / session.js / frp-install.js / managed.js / daemon.js / ops.js / frp.js`。
本次修改的 7 个文件均单独复核通过：core.js、frp.js、ops.js、managed.js、ports.js、port-segments.js、session.js。

行数（`wc -l`）：core.js 194、frp.js 251、ops.js 283、managed.js 37、ports.js 51、port-segments.js 19、session.js 145。
其中 `ops.js 283 ≤ 300`（DG-2 余量 17 行）。

---

## 5. 未做 / 边界

- 未运行任何测试或门禁（作业单硬约束）；`relay` 相关行为实测交 CI。
- 未 require 产品模块、未做内存冒烟；全部结论为静态判据 + 消费点反查。
- 未做 git 写；仅用只读 `git status/diff` 确认本批改动范围（本报告仅改上述 7 个 relay 文件 + 本报告）。
- `#18` 只做「非空」校验，未做主机名合法性/端口/TOML 注入加固（作业单「别过度设计」；
  `buildFrpcToml` 的引号剥离维持原样）。
- `#19` 选 (b) 的前提（同一次合成不出现同 id main）已在 §2.1 给出当前树逐路径证据；
  若后续引入新的 main 注入路径需重估。
