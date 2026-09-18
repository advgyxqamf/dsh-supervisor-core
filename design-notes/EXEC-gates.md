# 门禁基础设施（批 0）执行记录 —— EXEC-gates

> 范围：**门禁基础设施（批 0）**。产出两个文件，**未改任何 src/**，未启动任何 daemon/守卫进程，
> 未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor、~/.dsh，未 git commit。
> 依据：EXECUTION-CONTRACT.md（接口冻结 + 硬约束）、DOMAIN-STRUCTURE-DESIGN.md §9（DG-1..DG-14）、
>       design-notes/domain-contract-and-gates.md（逐判据设计）、DIRECTORY-STRUCTURE-DESIGN.md §5。
>
> ⚠ 本文所有 RED 数字是**某次快照**（见 §4 时间戳）。域改造正由多路子代理并行推进，
>   源码树在快照间持续变化（同一判据在两次运行间从 6 个降到 5 个超限文件是常态）——
>   这正是 DG-13「门禁不得以行号为断言目标」与「判据只按语义/结构匹配」的动因。

---

## §1 交付物

| 文件 | 状态 | 行数 | 作用 |
|---|---|---|---|
| test/domain-structure-gate-test.js | **新建** | 841 | DG-1..DG-14 域结构与域间契约门禁（report-only） |
| test/directory-structure-gate-test.js | **升级** | 262 | DS-G3b（R6 assign 形态）+ DS-9（严格阈值）+ report-only 软判据机制 |
| package.json | **改 1 行** | — | scripts.test 追加 domain-structure-gate-test.js（并登记孤儿测试 switch-policies-test.js，见 §6） |
| design-notes/EXEC-gates.md | **新建** | — | 本文 |

设计上原计划把分析器抽到 test/_domain-graph.js；本批**未建该文件**（派工单只授权上述两个测试文件），
分析器以纯函数形式内联在 domain-structure-gate-test.js 顶部，DG-4/5/7/9 共用同一实现（口径不漂移）。
若后续要复用，可原样抽出——函数已按无 IO 纯函数编写。

---

## §2 判据实现（DG-1..DG-14；每条都有反向自检）

| 判据 | 实现 | 反向自检（构造违规样本验证判据能命中） | 真跑常数断言（防空转） |
|---|---|---|---|
| DG-1 | 域 index.js 行数 ≤150 且去注释源码不含 http.createServer / fs.writeFileSync / setInterval( | 151 行样本命中；含 http.createServer 样本命中；合规样本不命中 | 扫描 5 个域门面 |
| DG-2 | src/**/*.js ≤400 行 | 401 行命中、400 行不命中（边界 ±1） | 真实超限 ≥1 |
| DG-3 | 读 domains/*/contract.js 的 pure 声明，对声明文件扫 IO require（node:fs/net/child_process/http/https/tls/dns） | node:fs 命中；require('./y') 不命中 | 真实形态样本命中 |
| DG-4 | 域内跨文件 this.X()：X 未在本文件定义、却在同域他文件定义；剔除语言关键字 + 抽象占位 + 契约豁免 | A 定义 save、B 调 this.save() 命中 1；B 自定 save 命中 0；abstracts 含 save 时命中 0 | 真实 this.X() 调用 ≥100（实测 235） |
| DG-4b | 豁免表（CONTRACT_HOOKS）每项必须能在对应 contract.js 的 deps/hooks 找到出处 | 假豁免 __nope__ 命中；真豁免 tokenOf 不命中 | — |
| DG-4c | **消费口径**：某名字被 bare this.X() 消费（调用者自身未定义）且被 ≥2 个兄弟文件定义 → 指向不明 | 两兄弟都定义且被消费 → 命中；只一个定义 → 不命中 | — |
| DG-4d | 方法体仅 throw 'must be implemented' 的抽象占位不计违规；但 abstract 集合每项必须有非抽象实现 | 无实现命中；有实现不命中 | router 抽象占位 12 个全部有实现 |
| DG-5a | 域内 require 图 Tarjan SCC，环数必须 0 | 夹具 A↔B 命中 | 真实 require 环 0 |
| DG-5b | 组合图（require ∪ 跨文件 this）SCC；非继承 SCC 即 mixin 造成的环 | 夹具 require + 跨文件 this 环命中 | — |
| DG-5c | extends 两文件 + 基类声明抽象占位 → 合法继承 SCC，显式输出不计违规 | 夹具 Base/Sub + 抽象体被判为继承 SCC | 输出已知合法 SCC 清单 |
| DG-6 | 非入口域文件零顶层副作用（行首第 0 列的 setInterval/setTimeout/prototype 并接/new X(）+ 有 module.exports | 顶层 setInterval 命中；正常导出不命中 | 覆盖 74 个非入口文件 |
| DG-7 | 域内依赖方向单调（require ∪ 跨文件 this）：from.rank ≤ to.rank；未归类文件（rank=null）也判违规 | store→core 命中；index→store 不命中；未归类 foo.js 命中 | — |
| DG-8 | R6 三件套：MIXIN_INTO_PROTOTYPE 硬判（右值不限、先剥注释）；METHODS_FRAGMENT* 仅告警 | 变量右值 Object.assign(X.prototype, mod.methods) 命中；defineProperties+require 命中；Object.assign({},a) 不命中；注释样本不命中 | 真实命中 ≥1 |
| DG-9 | contract.exports 数组 vs index.js 实际 module.exports 字面量键，双向 diff（支持跨行；非字面量记 dynamic） | extra 命中；missing 命中 | — |
| DG-10 | 消费方 (this|host|sup|self).<域绑定>.<成员> ⊆ 目标域 PUBLIC_API；**排除 domains/router 与 domains/instance 的 this.instances（ProxyInstance 同形不同物）** | 越权成员命中；list() 不命中；router 的 this.instances 被排除 | 输出未声明消费数（71） |
| DG-11 | 域外 .instances.instances 穿透（domains/instance 自身豁免） | sup.instances.instances.find() 命中；sup.instances.list() 不命中 | — |
| DG-12 | 非空转下界：文件 ≥140、字节 ≥500000、this.X() ≥400 | 文件下界判据非恒真 | 实测 files/bytes/thisCalls |
| DG-13 | 扫描两份门禁源码，禁止形如 x.line === 758 / lineNumber === 8 的**行号断言**（行号只作证据字符串） | 行号断言样本命中；证据字符串样本不命中 | 两份门禁自身 0 命中 |
| DG-14 | app/facade/*.js 内每个方法：方法名命中写动词白名单（set/patch/install/apply/toggle/sync/start/stop/restart/enable/disable/update/remove/delete/reset），或方法体调用写目标（.frpAction/.setFrp/.syncFrpc）；例外表（listLan/listPorts 读触发副作用）显式豁免 | setRouterRunning 命中；routerStatusView 不命中；例外 listLan 不命中；lanFrpc（名无动词但调 frpAction）命中 | — |

### 关键实现细节（避坑记录）

1. **strip() 自写扫描器**（非正则）：逐字符跳注释并保留换行与字符串字面量内容。设计原稿的正则
   （^|[^:])\/\/ 在「同行既有 URL 又有注释」时会误删尾段；扫描器消除该已知缺陷，且块注释里的换行被保留。
   R1 取证陷阱（注释里的 require / Object.assign(prototype)）因此不产生假阳性。
2. **definedNames 三形态**（class 体 / 对象字面量 / 顶层 function）+ 关键字剔除；
   DG-14 另用 methodBodies（大括号配对）区分「方法名无动词但语义是写」。
3. **DG-4 的抽象占位剔除**：base.js 的 12 个 throw 'must be implemented' 占位在**定义侧**即被
   definedNames 收录，因此 base.js 内的 this.stopInstance(...) 不产生跨文件边 —— 与设计「排除 12 处误报」等价，
   且比「先报后豁免」更少噪音。
4. **DG-6 顶层锚定第 0 列**：最初用 ^[ \t]* 匹配，导致方法体内缩进的 new Promise(...) / setTimeout(...) 假阳性
   （handlers/forward.js、plugin/cli.js 等 4 个文件误报）。已改为只认行首第 0 列。
5. **DG-4c 改为消费口径**：按设计「同级兄弟都定义就 FAIL」会把 39 组通用同名方法（load/save/getJson…）全部报警，
   噪音过大且永远无法归零。改为「被 bare this.X() 消费且 ≥2 定义者」，精准命中 canPersist 型真实歧义（当前 3 组）。
6. **DG-7 rank 扩展**：rank 表覆盖 SSOT §5 目标树 + 子目录首段（ops/store/model/handlers/policies/core/jobs）；
   未归类文件仍判违规（防「加个 foo.js 免检」）。子目录首段优先于 basename，故 store/usage.js=3、ops/*.js=1。

---

## §3 与设计的偏差（逐条如实记录）

| # | 设计原稿 | 实际实现 | 理由 |
|---|---|---|---|
| 1 | DG-6 用子进程 require 探针（spawnSync + 临时状态根） | **改为静态代理**：顶层副作用 + 导出面 + 依赖边 | EXECUTION-CONTRACT §2 硬约束「绝不启动任何进程 / 不碰产品状态根」；探针需 spawn node 且依赖 DSH_SUPERVISOR_HOME 临时目录。静态判据仍能命中「不可独立 require」的可判形态，且反自检证明非空转 |
| 2 | 分析器抽 test/_domain-graph.js | 内联在门禁文件顶部（纯函数） | 派工单只授权两个测试文件；抽出属后续重构 |
| 3 | DG-5c 预期豁免 router {base,proxy} | 当前**未触发**继承豁免（输出「无」） | 本实现的 definedNames 已收录抽象占位，base→proxy 不产生 this 边 → 二者不构成 SCC。DG-5c 判据本体仍实现且反向自检通过，一旦出现 extends SCC 会显式豁免 |
| 4 | DG-8 命中数常数 6 | 实测 2（仅 supervisor.js 两行） | 域内 4 处 Object.assign 已被并行子代理删除（批 1..7 进行中）；supervisor.js 属 app/ 层改造范围，保持 report-only |
| 5 | DG-4 基线 127 处 | 实测 18 处（仅 router） | instance/plugin/relay 的跨文件 this 已被并行子代理消解；基线随快照变化，故不断言等值常量，只断言非空转下界 |
| 6 | DG-9/DG-10 需 contract.js | 判定为「contract.js 未建」RED | 契约文件属 M3/M4 批，不在本批文件归属内；判据本体已实现并用夹具反向验证 |
| 7 | DS-9 只改文档 | directory 门禁**新增** DS-9 软判据（门面 ≤150 / 单文件 ≤400） | 派工单要求「DS-9 行数阈值与 SSOT 一致」；原门禁无 DS-9 断言，故新增（report-only） |
| 8 | DS-G3 只禁 defineProperties | 保留 DS-G3 硬判据，**新增 DS-G3b** 软判据（R6 右值不限、先剥注释） | 直接把 DS-G3 改成硬失败会令链红；拆为「硬（旧形态，当前 0）+ 软（assign 形态，当前 1）」既补齐 R6 缺口又不破坏「不退化」 |
| 9 | DS-G6 白名单 = R2 七项 | 实际白名单 = R2 七项 + ops | router 目标树含 ops/*.js 子目录（EXECUTION-CONTRACT §3.2），不加 ops 会误判目标结构违规 |

---

## §4 RED 基线（report-only 快照）

**命令**：node --require ./test/_preload.js test/domain-structure-gate-test.js
**结果**：53 passed, **0 failed(hard)**, 11 failed(soft/report-only)；退出码 0

    - DG-2 任何 src/**/*.js ≤400 行  <- 5 个: app/native/installer.js(806), domains/router/providers/proxy.js(1111), platform/distribution/index.js(690), platform/service/log/hub.js(492), platform/service/ports/index.js(567)
    - DG-3 contract.pure 声明文件零 IO require  <- contract.js 未建（无 pure 声明）
    - DG-4 域内跨文件 this.X() = 0  <- 18 处: router=18
    - DG-4b 契约豁免项在 contract.js 有出处  <- instance/plugin/relay/router: contract 未建
    - DG-4c bare this.X() 无同名兄弟歧义  <- 3 组: router:accountQuotaSummary(base.js|quota.js), router:applyDetection(base.js|freeze.js), router:canPersist(index.js|store.js|store.js)
    - DG-5b 无 mixin 造成的 this 图 SCC  <- 2 个: router:[store.js|base.js], router:[usage.js|forward-core.js|index.js]
    - DG-7 域内依赖方向单调  <- 5 条: layers.js -> policies.js(3->2), store.js -> policies.js(3->2), frp.js -> frp-install.js(2->1), store/usage.js -> handlers/parse.js(3->1), store/usage.js -> index.js(3->0)
    - DG-8 无 Object.(defineProperties|assign)(X.prototype, ...)  <- 2 处: supervisor.jsx2
    - DG-9 contract.exports 与实际导出双向一致  <- 5 域 contract.js 未建
    - DG-10 消费方成员 ⊆ 目标域 PUBLIC_API  <- contract.js 未建（71 处消费未校验）
    - DG-11 域外无 .instances.instances 穿透  <- 9 处: api/domains/instances.js, app/assembly/bootstrap.js, app/audit/orphan-scan.js, app/control/instance-adapter.js, app/control/specs.js, app/daemons/runtime.js, app/facade/main.js, app/session/shutdown.js ...(+1)

**命令**：node --require ./test/_preload.js test/directory-structure-gate-test.js
**结果**：16 passed, **0 failed(hard)**, 3 failed(soft/report-only)；退出码 0

    - DS-G3b 无 Object.assign(X.prototype, ...) 注入  <- 1 处: supervisor.js
    - DS-9 [report-only] index.js 门面 ≤150 行  <- 4 个: api/index.js(179), platform/distribution/index.js(690), platform/os/index.js(192), platform/service/ports/index.js(567)
    - DS-9 [report-only] 任何 src/**/*.js ≤400 行  <- 5 个: app/native/installer.js(806), domains/router/providers/proxy.js(1111), platform/distribution/index.js(690), platform/service/log/hub.js(492) ...(+1)

### 转硬失败的口子（迁移批 10 用）

    DG_STRICT=1 node --require ./test/_preload.js test/domain-structure-gate-test.js
    GATE_STRICT=1 node --require ./test/_preload.js test/directory-structure-gate-test.js

两个门禁的**反向自检任何时候都是硬失败**（门禁自身完整性不可空转）：当前 38 条反向自检全 PASS。

---

## §5 遗留

1. **contract.js 未建**（DG-3/DG-9/DG-10 仍 RED）：需 M3/M4 批在 domains/<域>/ 建
   { domain, exports, classApi, deps, pure } 纯数据文件。DG-10 的 PUBLIC_API 需含端口化后的成员面
   （list/get/projectTarget…），并把 domains/router 的 ProxyInstance 继续排除。
2. **supervisor.js 的 Object.assign(Supervisor.prototype, mod.methods)**（DG-8 2 处 + DS-G3b 1 文件）：
   属 app/ 编排层改造（级 1/级 2），非本批。设计文档已注明这是**已知待办**而非新缺陷。
3. **DG-7 的 3->2 / 2->1 反向边**（plugin layers/store→policies、relay frp→frp-install、router store/usage→handlers|index）：
   需各域设计确认是「rank 归类问题」还是「真实反向依赖」。若属归类，改 RANK 表即可（集中在一处）。
4. **DG-4c 的 store.js|store.js**：router 有 store.js 与 store/usage.js 两个同名 basename，证据串显示重复；
   不影响判定（两个不同文件都定义了 canPersist），如需可改为输出全路径。
5. **DST/平台侧 >400 文件**（platform/distribution、platform/service/ports|log）不在五域范围内，由对应专题处理；
   DG-2/DS-9 已把它们如实列出。
6. **DIRECTORY-STRUCTURE-DESIGN.md §4.5/§5.1 的 DS-9 仍写 ≤450/≤200**：本次未改该文档（不在派工单文件归属内）。
   门禁已按 R3 严值（≤150/≤400）执行；文档同步需主代理合并时处理（R11）。

---

## §6 验证记录（实跑命令与结果）

| 命令 | 结果 |
|---|---|
| node --check test/domain-structure-gate-test.js | 通过 |
| node --check test/directory-structure-gate-test.js | 通过 |
| node --require ./test/_preload.js test/domain-structure-gate-test.js | 53 passed / 0 hard / 11 soft；exit 0 |
| node --require ./test/_preload.js test/directory-structure-gate-test.js | 16 passed / 0 hard / 3 soft；exit 0 |
| node --require ./test/_preload.js test/layering-and-dependency-gate-test.js | 10 passed / 0 failed（193 条跨层边，非空转） |
| node --require ./test/_preload.js test/test-chain-completeness-test.js | 10 passed / 0 failed |
| node --require ./test/_preload.js test/switch-policies-test.js | 27 passed / 0 failed |

**关于 switch-policies-test.js（越界 1 行 package.json，已报主代理）**：
该文件是并行子代理产出的 router 纯策略单测，当时**未入 scripts.test 链**，令 test-chain-completeness 的
N-a（每个 *-test.js 必须入链或被显式排除）FAIL。因 package.json 测试链是 G0 的负责面，已将其登记。
⚠ 重复登记会让 N-a 的计数断言（inChain 数 + 排除数 === 测试总数）FAIL，其他子代理**不要**再登记它。

---

## §7 纪律声明

- **未修改任何 src/ 文件**；未启动任何守卫/daemon；未 spawn 子进程（DG-6 采用静态判据，正是为此）。
- 未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh、已安装包；未 git commit/push。
- 门禁只读 src/**（readFileSync/readdirSync）+ require(domains/*/contract.js 纯数据，未建时跳过）。
- 所有判据的扫描均先 strip() 剥注释；所有反向自检与正向判据**共用同一判据函数**。
