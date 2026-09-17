# AUDIT-r5 架构一致性审计报告（Architecture Consistency）

> 范围：内核仓根（相对路径 `./`）。方式：只读静态审计。
> 约束遵守：未运行任何测试 / 门禁，未启动任何 daemon，未碰 /tmp/dsh-* 与状态根，
> 未 commit / push，未改 package.json，未加依赖。本次**未修改 src/**（J 组约束：对 src/ 只报告），
> 也未修改文档与测试（阈值裁决属主代理权限）。仅新建本报告。
> 允许动作：node --check、grep、wc、逐文件阅读。依赖图由 require 文本静态解析（663 处匹配 / 462 条相对边）。
> 校验：node --check 全通过（256/256 src 文件）。

## 0. 结论摘要

| 维度 | 结论 |
|---|---|
| 五层结构与实际依赖 | 符合 DIRECTORY §2.2。实测 0 条越层 require、0 条跨域（domains 之间）require、shared 出度 0、platform 无向上出边 |
| 门面只组合导出 | 全部 index.js 小于等于 150 行；但 app 层装配仍以"方法集合合并到 host"的形态工作，app/facade 内仍有业务逻辑 |
| 与两份 SSOT 符合度 | 主体符合；发现 DF-2/DS-9 阈值两套（300 与 400 并存）、DS-10 所述唯一来源位置过时、§3 目录树多处漂移、domain SSOT 未登记唯一性门禁 |
| DF-1..DF-9 | DF-1/2/3/6/7/8/9 达标；DF-4/DF-5 仅域内达标，**app 层不达标**（见 A1/A6） |
| 高置信问题 | 3 条（A1、A2、B1） |
| 中置信问题 | 8 条（A3-A6、B2-B4、D1-D2） |

## 1. 五层结构与实际依赖（实测）

按 DIRECTORY-STRUCTURE-DESIGN §2.2 的依赖矩阵逐边核对，结果如下（计数为我方静态解析的相对 require 边）：

| from -> to | 边数 | 是否合法 |
|---|---|---|
| shared -> 任意 | 0 | 合法（DS-1 出度 0） |
| platform -> platform / shared | 85 / 4 | 合法 |
| platform -> domains / app / api | 0 | 合法（DS-2） |
| domains/<域> -> 同域 | 15+26+22+61+6 | 合法 |
| domains/<域> -> platform / shared | 5+3+14+23+3 / 4+1+1+2+1 | 合法 |
| domains/<域> -> 另一域 | 0 | 合法（DS-G1） |
| app -> app | 90 | 合法 |
| app -> platform / shared | 58 / 3 | 合法 |
| app -> domains | 7 | 合法（装配期 DI） |
| app -> api | 0 | 合法（DS-3） |
| api -> api / platform / shared | 18 / 4 / 1 | 合法 |
| api -> app / domains | 0 | 合法（DS-3） |
| root -> api/app/platform/domains(relay) | 1 / 2 / 1 / 1 | 合法（薄壳四类出边，已被 layering 门禁登记） |

结论：**五层单向依赖在实测下成立**。app -> domains 的 7 条边全部位于装配/动作层，无"domain 反向 require app/api"的旁路。

## 2. 门面一致性

- 全部 index.js 与 supervisor.js 行数（wc 实测）：router 150、platform/os 136、autostart 102、instance 102、
  token 100、distribution 84、plugin 84、supervisor 78、pidlookup 42、api 27、shell 24、ports 20、relay 18。
  全部小于等于 150（DF-1 达标）。
- 全仓最大单文件为 app/daemons/process.js 297 行、next domains/router/handlers/forward.js 296 行。
- 但按 DOMAIN-STRUCTURE-DESIGN §5 的**域内目标**，多处超出（属设计目标、非硬门禁，见 D1）。

## 3. 四维审计发现

每条给出：文件:行号 + 事实 + 为何是问题 + 建议 + 置信度。

### 3.1 架构设计

**A1（高）app 层仍把多个文件的方法集合合并到同一个 host 实例，DF-5 的"真实含义"未真正达成**
- 文件:行号：src/app/assembly/facets.js:75-80（installMethods 逐名挂到 host）、:114
  （installMethods(host, f.mod.methods)）；现有 20 个模块仍以 `module.exports = { methods: ... }` 形态导出：
  control/scheduler.js:10、control/instance-adapter.js:8、main/{process:17,health-gate:11,controller:12,shadow:10,port-rederive:87,signals:12,decide:11}、
  settings/{autostart:41,lan-panel:9,versions:17,env:22,access:6,node-lts:9}、
  daemons/{identity:11,probe:16,supervise:15,runtime:17}、audit/orphan-scan.js:15。
- 事实：DOMAIN-STRUCTURE-DESIGN:38-45（DF-5 真实含义）明确"DF-5 落地为：禁止把两个文件的方法合并到同一 this"；
  :239 的级 1（必做）要求"37 模块改 class/具名函数 + 只留 1 个小于等于 150 行兼容门面"。
  现状是改为挂到 host **实例**（不再挂 prototype），但"多文件方法合并到同一 this"的实质未变。
- 为何是问题：ARCHITECTURE-ACCEPTANCE.md:87 把 DF-5 记为"DG-5b = 0"达标，而 DG-5b 的扫描域
  （test/domain-structure-gate-test.js:706-738 的 DOMAIN_MODELS）只覆盖 domains/，**app 层不在其扫描范围**。
  于是"DF-5 全部满足"的表述在 app 层是过度声明；同时 host 上的兼容门面方法是由
  app/assembly/collaborators.js:76-85 运行期生成，静态不可见，进一步削弱可测性。
- 建议：在 ARCHITECTURE-ACCEPTANCE 的 DF-5 行标注"仅域内"，并补一条 app 层判据（扫描 facets.js 的
  FACETS 中仍含 methods 的条目数，降到 0 才可转 hard）；或按 SSOT:239 继续把 20 个模块改为具名函数/工厂。
- 置信度：高（文件与门禁范围均已核实）。

**A2（高）layering-and-dependency-gate-test.js 的 layerOf 仍是"整个 domains 一个层"，SSOT 指定的门禁升级未落地**
- 文件:行号：test/layering-and-dependency-gate-test.js:143（return 'domains'）、:144（app 层已更新）；
  而 DIRECTORY-STRUCTURE-DESIGN §5.2:218-238 与 D8:273 明确要求"**必须**改 layering-and-dependency-gate-test.js"，
  把 layerOf 细分到域粒度（示例写入 'domains/router'），修复"跨域边从不检查"的制度缺口。
- 事实：真正的域粒度检查被放进了一个新门禁 test/directory-structure-gate-test.js:97-107（DS-G1）。
  因此**覆盖没有丢失**，但被 SSOT 点名的既有门禁未按 SSOT 修改，其 L-2 登记表仍以 domains 为整体。
- 为何是问题：同一不变量由两份门禁承担，且旧门禁的头注仍描述已不存在的结构（见 A6），
  属"SSOT 指令与实现不一致"；未来维护者按 SSOT 去改旧门禁时会发现它并非 SSOT 描述的样子。
- 建议：要么按 SSOT 把旧门禁 layerOf 改为域粒度并与 DS-G1 去重，要么修订 DIRECTORY §5.2 明确
  "由 directory-structure-gate-test 承担 DS-G1、layering 门禁不再细分"，消除两套说法。
- 置信度：高。

**A3（中）app/assembly/collaborators.js 的 THIN_SPEC 是冗余的二次转发胶水层，且导出面含未用符号**
- 文件:行号：src/app/assembly/collaborators.js:27-61（THIN_SPEC）、:180-189（installThin 生成 host.ctl/host.daemons/... 转发对象）、:201
  （module.exports = { THIN_SPEC, SPEC: THIN_SPEC, THIN_NAMES, assertCollaboratorTargets, installCollaborators }）。
- 事实：THIN_SPEC 的每个条目把 host.<协作方>.<pub> 转发到 host.<既有方法>（如 ctl.call -> host._ctlCall）。
  全仓 grep 显示这些符号**只在本文件内部使用**（src/ 内无其它消费者；test/ 内无引用），
  其中 `SPEC` 是完全未被引用的别名。
- 为何是问题：这是"新旧两套调用面并存"的胶水层，增加一次无行为价值的间接跳转，
  并使 host 同时暴露 _ctlCall 与 ctl.call 两个入口（旁路/冗余）；未用导出属任务一的死导出候选。
- 建议：在 app 切面工厂化时删除 THIN_SPEC 与 installThin，直接以具名协作者暴露；
  至少先删除无消费者的 `SPEC` 别名（需先 grep 全仓含 test/ 确认）。
- 置信度：中（删除需主代理裁决，因为 SSOT:240 的级 2 尚未完成、THIN_SPEC 是过渡脚手架）。

**A4（中）api/identity.js 过渡 shim 的移除前置已过时，现为可删除的冗余转发**
- 文件:行号：src/api/identity.js:10（头注声称"api/index.js 仍以 require('./identity') 消费 identify / isPrivateIpv4"）；
  实际消费者为 src/api/security.js:26（require('./identity') 取 isPrivateIpv4）
  与 src/api/transport/server.js:28（require('../identity') 取 identify）。
  src/api/index.js 已完全不 require ./identity（其 :18/:25 分别 require ./transport/server 与 ./security）。
- 事实：DIRECTORY §2.2/D6 的设计意图是纯 IP 事实归 shared/ip、HTTP 身份归 platform/security，
  api/identity.js 只是让消费者零改动的过渡层；其自述移除条件 1) 已满足。
- 为何是问题：头注与代码现状不符（"注释声称、代码没有"的同类失效模式），
  且 api/security.js 本可直接 require '../shared/ip'，api/transport/server.js 本可直接 require
  '../platform/security/identity'，当前多一跳无收益转发。
- 建议：把 security.js:26 改为 require('../shared/ip')、transport/server.js:28 改为
  require('../platform/security/identity')，同步 test/lan-access-boundary-test.js 与
  test/relay-source-gate-test.js 的 require 路径，然后删除 api/identity.js；若本轮不动，至少修正 :10 的过时头注。
- 置信度：中高（代码事实高；删除涉及测试改动，需主代理决定批次）。

**A5（中）domains/router/instances/proxy-instance.js 仍是一行 re-export shim**
- 文件:行号：src/domains/router/instances/proxy-instance.js:1（module.exports = require('../model')），
  被 src/domains/router/index.js:12 require。
- 事实：DOMAIN-STRUCTURE-DESIGN §5.1:128 标注"re-export shim（过渡）-> 最终删除"。
- 为何是问题：属已声明的过渡冗余；目录 instances/ 现在只为这一个 1 行文件存在。
- 建议：把 index.js:12 改为 require('./model') 并删除该文件（删除前 grep 全仓确认无其它消费者）。
- 置信度：中（已知过渡件，非缺陷；但收尾即可消除一处冗余）。

**A6（中）layering 门禁头注与登记表记载了不存在的结构，L-3 实际空转**
- 文件:行号：test/layering-and-dependency-gate-test.js:15（层清单仍写 domains 含 dist）、:16（仍写 guard/ 层）、
  :18 与 :38-39 与 :270（引用 src/core.cjs）、:204（allowedRoot = CROSS_LAYER['platform -> root'] || {}）。
- 事实：src/ 下已无 dist 域、无 guard/ 层、无 core.cjs（实测 ls 与 find 均无）；CROSS_LAYER（:66-136）中
  已无 'platform -> root' 键，故 :204 恒取 {}，L-3 判据在无 platform->root 边时空转通过（当前恰好无边，尚无假阴）。
- 为何是问题：门禁自述的层结构与登记表已与仓库脱节，属规范/文档漂移；一旦未来真的新增 platform->root 边，
  L-3 与 L-2 的登记预期不一致，易误判。
- 建议：删除头注中的 guard/dist/core.cjs 叙述；若保留 L-3，用显式常量或恢复 CROSS_LAYER 条目，避免 || {} 空转。
- 置信度：中高。

### 3.2 规范标准

**B1（高）DF-2 / DS-9 的"单文件上限"存在两套并存数字（300 与 400），SSOT 内部与门禁注释三处相互矛盾**
- 文件:行号：
  - DOMAIN-STRUCTURE-DESIGN.md:29（DF-2 = 小于等于 300） 与 :249（R3 = 单文件小于等于 400） 与 :300（DG-2 = 小于等于 400）**互相矛盾**；
  - DIRECTORY-STRUCTURE-DESIGN.md:191 与 :213（DS-9 = 小于等于 400）；
  - test/domain-structure-gate-test.js:9（头注写 400）与 :576-580（实现 oversized(ENTRIES, 300)，判据名为"小于等于 300 行"）**同文件内矛盾**；
  - src 内 9 处注释按 300 落地（compose.js:11、compose/{core,domains,observers}.js:6、
    main/process.js:13、main/port-rederive.js:6、daemons/process.js:24、daemons/process-marks.js:6、daemons/process-wait.js:6、control/heartbeat.js:6）；
  - ARCHITECTURE-ACCEPTANCE.md:84（DF-2 = 小于等于 300，"本轮由 400 取严"）。
- 事实：实测最大单文件 297 行，两套阈值都能通过，故不是当前的功能缺陷；
  但 SSOT（"唯一事实源"）内部给了两个不同数字，门禁头注与实现也不一致。
- 为何是问题：阈值是机器判据的语义核心；一旦有人按 R3/DG-2/DS-9 的 400 去新增 350 行文件，
  domain-structure-gate-test 的 DG-2（300）会 FAIL，而 directory-structure-gate-test 的 DS-9（400）会 PASS，
  同一事实两份结论。这直接违反"一域一规范"。
- 建议：由主代理裁决唯一阈值（本报告倾向 300，因为 ARCHITECTURE-ACCEPTANCE 与 src 注释与 DG-2 实现都已按 300），
  然后同步 DOMAIN §2/§6/§9、DIRECTORY §4.5/DS-9、domain-structure-gate-test.js:9 头注，使其逐字一致。
- 置信度：高（各文件行号已逐一定位）。

**B2（中）DOMAIN-STRUCTURE-DESIGN.md 未登记进"规范唯一性"门禁**
- 文件:行号：test/standards-uniqueness-test.js:38-49 的 STANDARDS 表已登记 DIRECTORY-STRUCTURE-DESIGN.md
  （'目录结构与分层'，gate = directory-structure-gate-test.js），但**未登记 DOMAIN-STRUCTURE-DESIGN.md**；
  该文件 :3 自称"本文件是域内分层/拆分的唯一权威"（用词"唯一权威"），故 U-3 的
  "唯一事实源/唯一规范"匹配不到它。
- 为何是问题：域内 SSOT 与跨层 SSOT 是并列的两份"唯一权威"，但机器只保护了后者；
  本报告发现的 B1 阈值冲突正是"域内规范缺少唯一性登记"的直接后果之一。
- 建议：把 '域内结构' -> { file: 'DOMAIN-STRUCTURE-DESIGN.md', gate: 'test/domain-structure-gate-test.js' }
  加入 STANDARDS，并在 README 索引把该文件标为唯一事实源。
- 置信度：中高。

**B3（中）DIRECTORY-STRUCTURE-DESIGN §3 目录树多处与实际不符**
- 文件:行号：DIRECTORY-STRUCTURE-DESIGN.md:115（assembly 写 compose/bootstrap/fixed-ports/lifecycle-registration，
  实际为 api-rebind/bootstrap/collaborators/compose/facets/log-sources）、:123（native 写 command/installer/binding，
  实际无 binding.js，另有 manifest/npm/ops/policies/probe/upgrade）、:102（os 写"12 文件不动"，实际 15 个 .js）；
  §3 树未列 audit/ 与 domain-actions/（虽 §4.5/R7/R8 有述）、未列 api/transport/（server.js/body.js）、
  也未列 platform/service/log 的新拆分（core/sources/tail/watermark）。
- 为何是问题：SSOT 的目录树是"文件放哪里"的唯一事实源；实际结构已演化但树未同步，
  后来者按树找文件会落空（例如找 app/native/binding.js）。
- 建议：以实测树重写 §3，或在 §3 增补"过渡期新增目录"小节并注明 R7/R8 产物。
- 置信度：中高（漂移事实清楚；是否重写由主代理决定）。

**B4（中）DS-10"硬编码路径归零"未达成：daemon 相对路径在两处被字面量重复**
- 文件:行号：src/app/daemons/probe.js:27（cmd.indexOf('/domains/router/daemon.js')）与 :46
  （cmd.indexOf('/domains/relay/daemon.js')）；唯一来源现为 src/app/daemons/scripts.js:21-24 的 DAEMON_REL，
  且 scripts.js:14 明确"仍经 srcpath.resolve 做存在性验证"。
- 事实：DIRECTORY §5.1:214（DS-10）写明"daemon 脚本位置唯一来源 platform/util/srcpath.DAEMON_REL，
  cmdline 匹配由它派生"——该描述本身已过时（§4.2 反转法把映射移到了 app/daemons/scripts.js，
  srcpath.js 现只有通用 resolve，见 src/platform/util/srcpath.js:5/39）。
- 为何是问题：probe.js 的路径字面量是对同一事实的第二份实现；脚本位置演进时（src/ 调整）
  这里会静默失配，正是 DS-10 要防的形态。另外 DS-10 指向的文件位置已不存在。
- 建议：probe.js 改为从 DAEMON_REL 派生匹配标记（如 require('./scripts').DAEMON_REL），
  同步修正 DS-10 的"唯一来源"路径描述。
- 置信度：中高。

**B5（低）ARCHITECTURE-ACCEPTANCE 的存档数字已轻微漂移**
- 文件:行号：ARCHITECTURE-ACCEPTANCE.md:57（最大单文件 298）实测 297；:60（supervisor 79 行）实测 78；
  :64（测试链 125）与文件其它处（如 :44 的 76 passed）需以 CI 为准，本报告不核测试数。
- 为何是问题：报告自称"数字为实测"，但数字已随提交漂移，属过期存档。
- 建议：改为"约 297"或注明取数提交，避免被当成现值。
- 置信度：低（仅存档准确性问题，无功能影响）。

### 3.3 业务逻辑

**C1（无确认缺陷）** 本次静态审阅未发现新的业务逻辑错误。
正面证据：src/app/domain-actions/main.js:15 从 domains/relay/core 引用 verifyFrpExposure 的**同一份**校验
（单一事实源），src/domains/relay/core.js 的 validateFrpExposure 是唯一实现；DIRECTORY §5.1 缺陷 1 所指的
"写权闸三处各查一半"已在 shapes 层收敛（router/index.js:52 的 canPersist 委托 store.canPersist）。
按契约"不确定就只报告"，此项不作为缺陷。

**C2（中）app/facade/ports.js 内含实质业务逻辑，与"facade 只读视图"的定位存在张力**
- 文件:行号：src/app/facade/ports.js:20-54（三注册表归并、oauthCallback 过滤、supervisor-api 残留清理、
  容量可观测）、:62-74（_portActives 3s TTL 缓存）。
- 事实：R7/DIRECTORY §4.5:252 与 DOMAIN §5.6:239 把 app/facade 定位为"只读视图"，
  DG-14（domain-structure-gate-test.js:532-550）只按"写动词/写目标调用"判定，因此本文件以
  FACADE_EXCEPTIONS 白名单通过（:534-537）。
- 为何是问题：它确实无写副作用，故不违规；但"只读"被用来容纳了聚合/缓存/残留清理等策略逻辑，
  使 facade 不再是"只读视图"而更像"只读业务服务"，弱化 R7 的边界语义。
- 建议：若主代理认同，可把聚合策略下沉 domains 侧或 platform 的只读聚合接口，facade 只做调用；
  至少给 DG-14 增补"facade 不得含缓存/状态字段（如 _portActivesCache）"的判据。
- 置信度：中（属边界判定，非明确违规）。

### 3.4 功能设计

**D1（中）多个文件的实测行数超出 DOMAIN-STRUCTURE-DESIGN §5 的域内目标值**
- 文件:行号与事实（左=SSOT 目标，右=实测）：
  - instance/index.js：§5.3:164 目标 95，实测 102；
  - plugin/index.js：§5.4:183 目标 70，实测 84；
  - plugin/layers.js：§5.4:189 目标约 170，实测 223；
  - plugin/store.js：§5.4:188 目标约 180，实测 193；
  - plugin/market.js：§5.4:192 目标约 260，实测 264；
  - router/providers/policies/freeze.js：§5.1:121 目标 200，实测 236；
  - shell/core.js：§5.5:211 目标约 95，实测 106；
  - relay/daemon.js：§5.2:152 目标"不变 214"，实测 217。
- 为何是问题：这些是 SSOT 的域内目标（非 DF-1/DF-2 硬门禁），超限说明拆分未完全按 §5 目标收敛；
  若无人知晓，SSOT 会逐步沦为纸面值。
- 建议：或按 §5 继续收敛，或在 SSOT 中把目标值更新为现值并注明取数日期。不要两套并存。
- 置信度：中高（行数实测明确；取舍属主代理）。

**D2（中）DF-6"非门面文件可独立 require 直测"在 app 层只部分成立**
- 文件:行号：app 侧大量兼容方法由 src/app/assembly/collaborators.js:76-85（installFieldHelpers 生成 _mX/_mSetX）
  与 :86-137（installState 生成兼容外壳）在运行期创建；facade 方法体直接消费这些生成名
  （例：src/app/facade/main.js:33 的 this._mPhase、src/app/facade/status.js:20-51 的 host._mChild/_mDesired 等）。
- 事实：ARCHITECTURE-ACCEPTANCE:88 以 DG-6（只扫 domains/）判定 DF-6 达标；
  app 侧仅 state/session/control 三处真 ctor 工厂可"只 require 工厂 + 假 deps 直测"（collaborators.js:21-24），
  其余切面仍依赖 host 上运行期生成的方法。
- 为何是问题：DF-6 的意图（可独立单测）在 app 层未覆盖，与 A1 同源；DG-6 的范围未声明。
- 建议：DF-6 行标注"仅域内"；app 侧按 A1 的工厂化收尾后再宣称全域 DF-6。
- 置信度：中高。

## 4. DF-1..DF-9 真实达成度

| 编号 | 判据 | 真实达成度 | 证据 / 范围说明 |
|---|---|---|---|
| DF-1 | 门面 小于等于 150 行 | 达成 | 最大 index.js = router 150；全部 index.js 均 小于等于 150；business 关键词扫描见 DG-1 |
| DF-2 | 单文件 小于等于 300 | 达成（阈值有两套，见 B1） | 实测最大 297（app/daemons/process.js）；域名门禁实现按 300 |
| DF-3 | 纯 / IO 分离 | 达成 | 5 个 contract.js 均声明 pure；shared/ 无 IO；contract.js 本身零 require |
| DF-4 | 零跨文件 this.X() | 仅域内达成 | DG-4 只扫 domains/；app 层 host 仍调用注入/生成方法（A1/A6、D2） |
| DF-5 | 禁方法集合并 | 仅域内达成 | DG-5b 只扫 domains/；app 仍有 20 个 { methods } 合并到同一 host（A1） |
| DF-6 | 非门面文件可独立 require 直测 | 仅域内达成 | DG-6 只扫 domains/；app 生成 helper 依赖 host（D2） |
| DF-7 | 依赖单向 rank 不上升 | 域内达成 | 实测 domains 内 0 条向上 require（rank 表由 DG-7 校验） |
| DF-8 | require 必须在顶层 | 达成 | 唯一函数体内 require 为 supervisor.js:44 的 get lan()，在 DG-15 白名单内；其余缩进 require 均为顶层对象/数组字面量（api/router-table.js、platform/os/index.js、app/assembly/facets.js） |
| DF-9 | 函数嵌套 小于等于 6 | 达成 | DG-16 扫描全仓；本报告未复算，但未发现异常深层嵌套 |

## 5. 候选死代码 / 冗余（仅报告，未删除）

| 对象 | 依据 | 建议 |
|---|---|---|
| api/identity.js | 头注前置过时，仅剩两处可直接指真实归属的消费者（A4） | 改消费者后删除，或修正头注 |
| domains/router/instances/proxy-instance.js | 1 行 re-export，SSOT 已注明最终删除（A5） | 改 index.js 指向 ./model 后删除 |
| app/assembly/collaborators.js 的 SPEC 别名 | 全仓含 test/ grep 零消费者（A3） | 删除；THIN_SPEC/THIN_NAMES/assertCollaboratorTargets 也无外部消费者，随工厂化一并撤 |
| api/deps.js | 全仓零 require（src/ 与 test/ 均无），自述"不被 index.js 加载" | 属 R9 有意的"只声明不强制"文档数据，**不建议按死代码删**，但应在文件头显式标注"文档数据、非运行代码" |
| api/contract.js | 仅被 test/kernel-update-single-writer-test.js 读取 | 门禁数据源，保留 |

## 6. 注释符号基线（本次未编辑注释，供 K 组任务三使用）

本次为架构审计，未改动任何注释，故无前后差；以下为 src/ 全量禁用符号现状基线（grep -oP 计数）：

| 类别 | Unicode 码位 | 数量 |
|---|---|---|
| 制表框线（双线） | U+2550 | 11476 |
| 右箭头 | U+2192 | 712 |
| 制表横线 | U+2500 | 407 |
| 警示/注意符 | U+26A0 | 168 |
| 实心/空心星 | U+2605 / U+2606 | 30 |
| 带圈数字 1-5 | U+2460..U+2464 | 67 |
| 左箭头 | U+2190 | 19 |
| 重右箭头 | U+21D2 | 8 |
| 双向箭头 | U+2194 | 6 |
| 白对勾 | U+2705 | 4 |
| 发光星（emoji） | U+1F31F | 1 |
| 叉（emoji / 文本） | U+274C / U+2718 | 2 |
| 对勾（文本） | U+2714 | 1 |
| 双向空心箭头 | U+21C4 | 1 |
| 合计 | - | 约 12902 |

（主要集中在文件头 banner 与分隔线。）
其中 test/ 下的断言文案与代码字符串按任务三要求不在清理范围。

## 7. 本次改动清单

| 文件 | 动作 |
|---|---|
| design-notes/AUDIT-r5-architecture-consistency.md | 新建（本报告） |

未修改 src/、未修改 package.json、未 commit。
未改文档与测试：B1 阈值、B2 登记表、B3 目录树等均需主代理裁决后再动，本次只报告。

## 8. 复核命令（只读，可复现）

- 依赖图：对 src/**/*.js 提取 require 文本并解析相对路径，按层分类；本次得 462 条边、0 越层、0 跨域。
- 行数：find src -name '*.js' -exec wc -l {} +
- 语法：for f in $(find src -name '*.js'); do node --check "$f"; done
- 符号基线：cd src && grep -rhoP '[\x{2600}-\x{27BF}\x{1F300}-\x{1FAFF}\x{25A0}-\x{25FF}\x{2500}-\x{257F}\x{2190}-\x{21FF}\x{2460}-\x{24FF}]' . | sort | uniq -c
