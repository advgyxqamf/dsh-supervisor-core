# WS1-d 报告：src/api/** + src/shared/** + bin/**（注释精简 + 死代码普查）

> 分片：WS1-d。作业单：design-notes/_workorder-phase2.md（§2 注释口径 / §4 WS1 / §6 形式钉子）。
> 约束遵守：未运行任何测试或门禁（只 node --check / grep / read / wc / git 只读）、未做任何 git 写操作、
> 未改 test/、未碰 bin/dsh-supervisor、未加依赖、未启动任何 daemon。报告内全部为相对路径。
> 工作区改动保留，由主控统一提交。

---

## 0. 分片分配表（§3 要求）

分片仅 22 个 .js（剔出 WS2 独占的 api/domains/instances.js 后 21 个），未派生下级（主控已授权：
「文件量小，可自行决定是否派生」）。全部由本代理独占处理，无并行写者，无遗漏。

| 处理者 | 文件 |
|---|---|
| 本代理（WS1-d） | src/api/contract.js, deps.js, identity.js, security.js, index.js, router-table.js, static.js；src/api/domains/{dist,guard,lifecycle,native,plugins,relay,router,shell,tasks}.js；src/api/transport/{body,server}.js；src/shared/{guardian,ip,version}.js |
| 排除（WS2 独占） | src/api/domains/instances.js（N11）。本代理未动，其 +20 行改动属 WS2 |
| bin/** | 无 .js 文件。bin/dsh-supervisor 是无扩展名的 Node 脚本，按 §3 字面（bin/** 的 .js）不属本分片；归属疑义见 §4.3 |

改动落到 15 个文件（其余 7 个经通读后判定无需改动，见 §3）。

---

## 1. 改动的文件清单（每文件一行理由）

### 1.1 注释精简（§2 口径；代码零变化）

| 文件 | 删了什么 | 理由 |
|---|---|---|
| src/api/contract.js | /shell/health、/shell/update-pending 前的 3 行「曾声明为壳…现按真实情况标注」 | 变更历史叙事；真实结论已落在该条目的 note/consumers 字段（数据未动） |
| src/api/deps.js | 「本轮保持只声明」与「启用条件（本轮不做）」中的「本轮」 | 过程记录措辞；启用条件本身（3 条）保留 |
| src/api/identity.js | 「纯 IP 事实：唯一实现…」「HTTP 身份：唯一实现…」两行标题行内注、「纯 IP 事实 re-export」行 | 复述紧邻 require 的来源；头注已完整说明 SSOT 与移除条件 |
| src/api/security.js | isLocalOrLanHost 的「IPv6 方括号形态：去掉括号再判」、originAllowed 闸 1 的「接受…与文件头声明一致」 | 复述代码与头注；安全语义与事故必因（DNS-rebinding、LAN CSRF）全部保留 |
| src/api/transport/server.js | 与 security.js 重复的「安全边界三层」整段、旧路由清单尾行、api_proxy 透传历史、「// 404」、「// 去掉前导 /」 | 同一事实两处陈述（SSOT 在 security.js）／变更历史／复述代码 |
| src/api/domains/guard.js | 「更新日志：概览「版本与升级」只关心 DSH」行内注 | 与上方函数 docstring 重复；docstring 里的 UI 位置（被 cross-platform A4-d 钉住）原样保留 |
| src/api/domains/lifecycle.js | 头注「旧 /start|/stop|/restart 已删除」、API 路由标题注、写动作「旧路由曾各自门禁」、「原 /logs/events-tail 已删除」与尾部同义说明、「旧 /start…已删除」尾注 | 变更历史与重复叙事；不变量（唯一入口 /lifecycle/dsh/*、Origin 门禁、域内 404/405 兜底）保留 |
| src/api/domains/native.js | 「原生 DSH 生命周期（唯一通道）：状态/检测/安装…」 | 与域头注重复 |
| src/api/domains/plugins.js | 「插件管理」标题注 | 纯复述域头注 |
| src/api/domains/router.js | 「智能路由（中转服务）生命周期」、「局域网访问开关」（错位标签：该处是 /router/providers） | 复述域头注／标签与代码不符 |
| src/api/domains/tasks.js | 「统一安装/更新任务（Task Registry）：」前缀 | 与域头注重复；任务模型语义（状态机 + step + 日志 + 持久化）保留 |
| src/shared/guardian.js | shouldGuard 的 JSDoc「该目标是否开启进程守护开关（默认关）」 | 与文件头注 + 代码 inst.guardian === true 重复 |
| src/shared/version.js | 行内注「剥离 build metadata（不参与比较）」 | 复述 split 取值 |
| src/api/domains/dist.js | 未删：注释均为 CSP／同源探活的 WHY 与 DistributionManager SSOT | 见 §3 |

### 1.2 死代码普查（§4；R2 全仓核验后删除）

| 文件 | 删除内容 | R2 证据 |
|---|---|---|
| domains/{dist,native,plugins,relay,router}.js | 解构中的 identity、tokOf（各 2 个绑定） | 逐文件按词边界 grep 两符号 → 仅出现在解构行；全仓 tokOf 消费者只有 src/api/domains/instances.js（WS2）与 transport/server.js 的定义；test/ 对解构形态零匹配 |
| domains/lifecycle.js | 同上 2 个 + res、collectBody | grep 显示 res／collectBody 仅出现在解构行；originAllowed 有 2 处真实调用，保留 |
| domains/tasks.js | 同上 2 个 + res、collectBody、originAllowed | 三者仅出现在解构行（该域只有 GET，无写动作，故无 Origin 门禁与 body 读取） |

导出（module.exports）增删：0。全部既有导出经全仓核验均有消费者（排除 node_modules/.git）：

| 导出 | 消费者（R2 核验） |
|---|---|
| src/shared/version.js semverCompare / VERSION_RE | distribution、app/settings、router、instance、plugin、shell 域 + test/{version-vectors,release-channel,release-channel-gate,upgrade,round8-fixes} |
| src/shared/guardian.js shouldGuard / bumpCrashWindow / instanceRestartDecision | domains/instance、app/main/{health-gate,process}、app/assembly/collaborators |
| src/shared/ip.js normalizeRemoteAddress / isLoopbackAddress / isPrivateIpv4 | platform/security/identity、api/identity、domains/relay/core、test/relay-source-gate |
| src/api/security.js originAllowed 等 | transport/server、api/index re-export、test/{defects-batch-f,lan-access-boundary} |
| src/api/contract.js SURFACE/PREFIXES/CATEGORIES/summary | test/api-surface-test |
| src/api/deps.js GATEWAY/DOMAIN_DEPS | 无消费者，但按设计保留：该文件自述为文档性数据（无逻辑、无副作用、不被 index.js 加载），价值即存在即可查；删除会丢依赖清单 |

其他死代码项：无被注释掉的代码块（已按 CLI/变量声明/return 等模式在 src/api + src/shared 扫描，唯一命中是中文散文里的花括号字符，非代码）；无恒真/恒假分支改动。

---

## 2. node --check 结果

find src/api src/shared -name *.js → 22 个文件逐个 node --check：全部 exit 0，无 FAIL。
另外复核：test 未改；bin/dsh-supervisor 未改（git status -- bin/ 为空）。

变更规模：15 个文件；非注释改动仅 §1.2 的 7 行解构（每行删除的绑定均经全仓 grep 证明零消费者），其余为整行注释删除。

---

## 3. 通读后判定「不改」的文件（附理由）

| 文件 | 不改理由 |
|---|---|
| src/api/index.js | 头注是三层安全边界的对外契约；re-export 段说明哪些测试直调（api-contract / lan-access-boundary / defects-batch-f K6），属契约与消费者事实 |
| src/api/security.js（其余段落） | 头注三层职责、isLocalOrLanHost 的故障必因（开 LAN 后写操作全 403）、LAN CSRF 主机一致性、访问密钥语义——均为非显然 WHY 与安全语义 |
| src/api/static.js | CSP/nosniff/路径穿越/no-store 均为安全面语义；多候选目录解析是发行形态差异说明 |
| src/api/transport/body.js | 头注与 onDone 抛出边界的说明是陷阱（会升级为进程级 uncaughtException） |
| src/api/domains/shell.js | 端点设计原则 4 条是不变量（只回环／不持更新源／写操作走 originAllowed／无 rollback） |
| src/api/router-table.js | 「顺序即优先级」「改动顺序会改变路由归属」是不变量 |
| src/shared/ip.js | 头注说明拆分理由（relay 反向依赖）与 L0 出度 0 约束 |
| src/api/deps.js（其余段落） | 声明口径 4 条是表本身的契约；逐成员行内注解释为何需要该成员，非复述代码 |
| src/api/domains/dist.js | /dist/registry/probe 的同源探活背景是 CSP 约束下的必要 WHY |
| 各域尾部「域内未匹配(方法/子路径)：全局兜底语义…」 | 10 个域共用的一行事实（404/405 兜底归属），删除收益极小、改动面大；保留 |

---

## 4. 形式钉子保留项（R1 / §6）

### 4.1 §6 #13、#14 未受任何影响

本代理未修改 bin/dsh-supervisor（既因作业单 §3 字面为 bin/** 的 .js，也因这两条钉在运行期文案而非注释）：

- #13 服务定义/开机自启/桌面入口由桌面壳负责 → bin/dsh-supervisor:397 的 console.log（运行期字符串），被 test/kernel-daemon-contract-test.js:65 的 D-4 断言；该测试同时要求 installBody 不含 UNIT_PATH/systemctl enable（反向判据 looksLikeDeploy 为 false）。
- #14 shutdown 超时（8s） → bin/dsh-supervisor:269 的 console.error（运行期字符串），被 test/graceful-shutdown-test.js:77 的 G-e 断言。
- 两处均为非注释字符，按 §2「绝不改动任何非注释字符」本就不可触碰。当前文件与 HEAD 一致。

### 4.2 新发现的形式钉子（登记，未改测试、未硬改）

| # | 受保护形态 | 钉住它的测试 | 文件 | 性质 |
|---|---|---|---|---|
| N-1 | security.js 内从 ./identity 解构 isPrivateIpv4 的代码形态（跨行容错正则） | lan-access-boundary-test.js:88（E-g） | src/api/security.js | 代码形态钉子（非注释）；本代理只动同文件注释，已复核该行原样 |
| N-2 | 不得出现 pathname === /logs/events-tail 的代码形态（负向断言） | api-surface-test.js:80 | src/api/domains/lifecycle.js | 代码形态；被删注释里只是文字提及，非该代码形态，断言仍通过 |
| N-3 | /dist/registry/probe 字面量与 http(s) 前缀校验 | round13-csp-probe-test.js:73-75 | src/api/domains/dist.js | 代码形态；本代理未改该文件 |
| N-4 | router.js 内任何含 .then( 的行必须同时含 .catch( | round13-dropped-result-test.js:45-61 | src/api/domains/router.js | 代码形态；本代理只删注释，未动任何 then 链 |

### 4.3 归属疑义（请主控裁决）

bin/dsh-supervisor 无 .js 扩展名，按 §3 表它不落在 WS1-a..d 任一「的 .js」范围内，但 §6 把 #13/#14 归给 WS1-d。
本代理按只保护、不动手处理：该文件仍未被任何 WS1 分片处理过注释。若主控希望精简其注释请明确授权
（该文件含大量运行期错误文案与 D-4/D-5/G-e 断言的字符串，风险高于普通源文件）。

---

## 5. 未改动的边界（合规声明）

- test/ 下本代理零改动。git status -- test/ 显示的 3 个改动（directory-structure-gate-test.js、test-chain-completeness-test.js、docs-reference-gate-test.js）均为 WS3 的产物。
- src/api/domains/instances.js 属 WS2（N11），本代理未触碰；其 +20 行不计入本报告。
- 未新增/删除任何导出，未改任何函数签名、未移动代码、未改文件名。

---

## 6. CI 风险点（供主控提交前评估）

1. 低：15 条为纯注释删除，7 条为死绑定删除（行为等价：解构无副作用，被删绑定零引用）。node --check 全通过。
2. 中（信息面）：api-surface-test 的双向一致会重新提取源码路由字面量——本代理未改任何路由判定代码，清单与源码仍一一对应；已删注释里的 /logs/events-tail 文字不构成新路由字面量。
3. 低：kernel-daemon-contract-test D-3 读 src/api/index.js + domains/lifecycle.js 断言 /healthz 存在——该分支代码未动。
4. 低：session-lifecycle-test P4-A/P4-B 对 domains/lifecycle.js 做正文匹配（hub.readVisible、const hub = sup.eventHub）——两处均在代码中且未改。
5. 提示：本分片刻意不做整段同义改写，只做整行删除，以规避前两次 CI 事故（245585c / f410a3a）的同类风险。
   本轮已做 R1 全量 token 复核：把所有删除行切成 CJK 4 字以上与 ASCII 6 字符以上 token 后逐 token 回扫 test/，
   命中项仅「插件管理」「启停唯一入口」「统一安装」三条，均已核实为测试自身头注，非对我文件的钉子。

---

## 7. 交付状态

- 工作区改动已就绪，未提交、未推送（遵守 §0.2）。
- 本报告即 design-notes/_p2-ws1d-api-shared.md。
