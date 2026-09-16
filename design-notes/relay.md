# relay 域功能设计

> 范围：`src/domains/relay/`（index.js 502 / manager.js 504 / frpmgr.js 439 / daemon.js 214 / port-segments.js 22）
> 约束：只做设计；所有「文件:行号」来自本轮实际 read；已按主代理裁决 **R1–R5** 补正。
> 定位：relay 是 **域 B 基础设施**（`GUARD-DOMAIN-MODEL.md` §2：router-daemon + lan-daemon 不设 guardian）。本设计**不得**改变该语义（见 G-4 / H-DL-G5）。

---

## §0 直答四问（任务要求）

### 问 1：manager.js require `./index` 是循环吗？

**不是循环。是「门面被编排层反向依赖」的方向错误（DF-7 违规），不是 DF-5 环。**

证据（实测，非印象）：

| # | 证据 | 位置 |
|---|---|---|
| 1 | relay 域内只有 **一条** `./index` 入边，且**零出边** | `manager.js:422` `const { createRelay } = require('./index')` |
| 2 | `index.js` 全文**没有任何域内相对 require** | 仅 `index.js:21-23`（node 内建）、`:26`（`../../shared/ip`）、`:29`（`../../platform/service/token/exchange`）；grep 域内相对 require 命中 0 |
| 3 | `index.js:502` 只导出 `{ createRelay }`，不 require manager | `module.exports = { createRelay };` |
| 4 | 剥注释 + Tarjan SCC 扫描本域 5 文件：**0 个环** | 见 A.2 图 |

结论：`manager.js → index.js` 是**扇出到叶子**，方向为「编排 → 门面」。按 `DIRECTORY-STRUCTURE-DESIGN` §2.2 / DF-7，`index` 只能在依赖图**顶端**（`index → ops → core`）。当前形态使 `index.js` 必须**永远保持叶子**（不得 require 任何域内文件），否则立刻成环——这是**隐性约束**，必须消除。
**消解**：服务实现迁出 `index.js` → `proxy.js`；`ops.js` 直接 `require('./proxy')`，`index.js` 变为纯 re-export 门面。边变为 `index → ops → proxy`（合法 DAG）。

### 问 2：index.js 里哪些是「relay 服务本体」/「账号·代理管理」/「frp 编排」？

| 归属 | 行区间 | 内容 |
|---|---|---|
| **relay 服务本体** | `index.js:44-54`（来源闸）、`81-104`（令牌闸）、`109-120`（polyfill）、`252-275`（`pipeWithHold`）、`291-398`（HTTP 转发）、`400-476`（WS 隧道）、`478-497`（server 热更新面） | 全部 |
| **DSH 会话桥（服务本体的子能力）** | `166-229`（`dshTokenOf/dshCookie/bootstrapping/ensureDshCookie/refreshDshSession`）、`277-289`（`mergedCookieHeaders`） | 全部 |
| **账号 / 代理管理** | **0 行** | `index.js` 不含任何账号、供应商、凭证逻辑（grep `frp` 命中仅 `:42`、`:152` 两处**注释**） |
| **frp 编排** | **0 行** | 同上；frp 逻辑全在 `manager.js:103-181` + `frpmgr.js` |

即：`index.js` **不是门面，而是「单实例反代服务」实现**；它既不含账号管理也不含 frp 编排。frpmgr.js 与它的边界是「同域内的服务侧 vs 客户端侧」，**清晰**。

### 问 3：manager.js 与 index.js 的关系？是否职责重叠？

**不重叠（功能上互斥），但命名与依赖方向错位——需「重新划分」，不是「合并」。**

- `index.js` = **服务实例工厂**（1 个实例 = 1 个 server）；`manager.js` = **多实例编排 + frp 策略**（0..n 个 server + frpc 进程）。
- 错位证据：**真正的域公共入口是 `manager.js` 而非 `index.js`**——`compose.js:21`、`supervisor.js:100`、`adapters` 消费的都是 `relay/manager`；`api/router-table.js:22` 注册的 `api/domains/relay.js` 全程走 `sup.*` 门面（`app/control/adapters.js:63-83`），也不 require `index.js`。
- **裁决（重新划分）**：
  1. 服务实现 → `index.js` **让位**并改名 `proxy.js`（职责名，非「从哪切出来」名，符合 DS-12）；
  2. 编排主体 `manager.js` → `ops.js`（LanManager 保留类名，导出不变）；
  3. `index.js` 回归真门面：re-export `{ createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls }`，≤150 行、无逻辑。
- 消费方**零改动**（`manager.js` 仍导出 `{ LanManager }`，`index.js` 仍是 `require('.../relay')` 的落点）——见 F 步 3/7 的兼容策略。

### 问 4：域 B 基础设施语义是否被改？

**不改。** `app/control/specs.js:91-99` 的 `lan-daemon` 申报块**不含** `guardian` 字段、`app/control/adapters.js:63-83` 的 B 平面 `id='lan'` 不设 guardian；本设计不新增任何 `desired`/`guardian`/`restartCount`/`guardian_action`。relay 单元**只有**「业务条件 `remoteEnabled` × 目标可达性」的收敛（`manager.js:212-260`），正是 §2「域 B：保活 + 业务条件」的形态。新增门禁 DL-G5 锁定之（H 节）。

---

## A. 现状审计

### A.1 文件清单与职责（逐文件）

| 文件 | 行数 | 当前职责（按行区间） | 问题 |
|---|---|---|---|
| `index.js` | **502** | ①来源闸 `44-54`；②常数时间比较 `56-60`；③令牌校验/门卫 `63-104`；④polyfill 常量 `109-120`；⑤cookie 解析 `123-131`；⑥**反代 server 工厂** `145-500`（HTTP 转发 `291-398`、WS 隧道 `400-476`、热更新面 `478-497`）；⑦会话桥 `166-229,277-289` | 名义「门面」实为 502 行服务实现；**混纯判定 + HTTP 管线 + 网络 IO + 会话状态**（违反 DF-2/DF-3）；非门面故 DF-1 不成立 |
| `manager.js` | **504** | ①ctor 装配 `15-34`；②视图投影 `36-45,65-100`；③frp 策略与设置写回 `103-170`；④frpc 同步 `173-181`；⑤对账（单飞）`203-260`；⑥实例联动 `263-272,394-409`；⑦可达判定 `278-282`；⑧**代理生命周期/端口仲裁** `285-475`；⑨停机 `478-485`；⑩令牌热换 `490-501` | 504 行承载 10 类职责（违反 DF-2）；`422` 反向 require 门面（违反 DF-7）；`358/362/417/439` 读写 `server._wanPort` 私有字段（隐式跨文件耦合） |
| `frpmgr.js` | **439** | ①平台标签纯函数 `28-33`；②镜像表 `37-46`；③**纯配置文本生成** `118-144`；④设置读写 `84-104`；⑤状态 `107-115`；⑥**进程生命周期** `147-283`（spawn/退避/孤儿）；⑦**网络下载 + 完整性校验 + 解压** `300-435` | 439 行；纯文本生成 ③ 与网络/进程 IO ⑥⑦ 同处（违反 DF-3/DF-2）；仅 `118-144`、`28-46` 是可独立单测的纯部分 |
| `daemon.js` | **214** | ①常量 `27-28`；②ctl 白名单 `35-38`；③配置加载 `40-50`；④**装配** `52-98`；⑤**状态文件轮询 + diff** `100-140`；⑥tick `143-158`；⑦ctl 服务 `160-163`；⑧**优雅停机（等 frpc）** `178-210`；⑨入口守卫 `213-214` | ⑤ 是业务逻辑（§4 要求 daemon 仅装配+启动）；**独立进程入口，改动风险最高** |
| `port-segments.js` | **22** | 端口段申报（`relay→managed`，`require` 即注入） | 无问题；**保留** |

### A.2 域内耦合图（require 边 + this 跨文件调用边，逐条）

**require 边（剥注释实测，共 4 条域内相对 require）：**

| # | from | to | 位置 | 性质 |
|---|---|---|---|---|
| 1 | `daemon.js` | `manager.js` | `daemon.js:53` | 装配（合法） |
| 2 | `manager.js` | `port-segments.js` | `manager.js:10` | 副作用申报（合法，须先于 `:11` 取 `ports.shared` 才有时序意义） |
| 3 | `manager.js` | `frpmgr.js` | `manager.js:12` | 编排→实现（**应改 ctor 注入**，见 E-3） |
| 4 | `manager.js` | `index.js` | `manager.js:422` | **门面反向依赖（DF-7 违规）** |

```
daemon.js ──▶ manager.js ──▶ index.js          (叶子)
                        ├──▶ frpmgr.js        (叶子)
                        └──▶ port-segments.js (叶子)
SCC（Tarjan，剥注释）：无环
```

**`this` 跨文件调用边：0 条**（实测：`index.js` 0 处 `this.`；`daemon.js` 0 处；`manager.js` 45 处、`frpmgr.js` 19 处**全部落在各自文件内**）。与 BRIEF §0 表格（relay 0 条）一致。

**但存在四处「属性级」隐式跨文件耦合（本域真实缺陷，计数器看不见）：**

| # | 形态 | 位置 | 为何是隐式耦合 |
|---|---|---|---|
| P1 | 跨文件读写私有字段 `server._wanPort` | 写：`manager.js:439`；读：`manager.js:358,362,417` | `_wanPort` 由 `manager` 单方面挂在 `index.js` 造出的 server 上；两侧无任何声明，改名静默失效 |
| P2 | 跨文件触达私有子对象 `lan.frpmgr.child` | `daemon.js:179`、`daemon.js:198` | daemon 直接读 `LanManager` 内部字段 `frpmgr`→`child`；`frpmgr` 是 ctor 私有依赖（`manager.js:22`） |
| P3 | 鸭子类型调用未声明方法 | `manager.js:82` `srv.status()` | `index.js` 造出的 server 上的 `status/setToken/hasToken/setDshToken` 无任何接口声明，靠约定 |
| P4 | 域内私有方法被鸭子调用 | `daemon.js:132` `lan.applyToken(id, tok)` | 签名与实现不符：实现 `manager.js:490` 只接 `(instId)` |

### A.3 病症清单（对照 §0 四类，逐条证据）

**① 巨型文件（DF-2，阈值 400 行）** —— 3 个文件违规：
- `index.js` 502 行、`manager.js` 504 行、`frpmgr.js` 439 行。
- 混杂证据：`index.js:109-120` 纯字符串常量与 `index.js:291-398` HTTP 管线同处；`frpmgr.js:118-144` 纯文本生成与 `frpmgr.js:300-435` 下载/校验/解压同处；`manager.js:65-100`（视图）与 `manager.js:411-447`（server 生命周期）同处。

**② `this` 隐式耦合（DF-4）** —— 域内跨文件 = **0**（好消息，A.2 实测）。但存在 P1–P4 四处**属性级/鸭子类型**耦合，应一并显式化（E 节）。

**③ 循环 require（DF-5）** —— 域内 **0 环**（Tarjan 实测；与 **R1** 结论一致：本域不存在 BRIEF §0 所述「plugin/router 式」require 环）。唯一方向性问题是 `manager.js:422 → index.js` 的**扇出方向错误**（DF-7），非环。

**④ 职责错位（DF-1）** —— `index.js` 是名义门面却承载 502 行服务实现且无「组合与导出」语义（`index.js:502` 仅导出 `createRelay`）；真正的域入口是 `manager.js`（`app/assembly/compose.js:21`、`src/supervisor.js:100`）。
- **附带发现（跨层，需上层裁决）**：公网暴露安全闸在 `manager.js:108-110` 与 `app/facade/main.js:64-80` **各写一份**（同一条错误文案、同一段端口/占用校验，共约 25 行），仅靠 `test/round13-router-relay-gaps-test.js:52-59` 用字符串比对锁一致性。见 E-10。

---

## B. 功能切面（★ 设计核心）

> 先不看现有文件：relay 域在功能上由下列 14 块组成。

| 功能块 | 职责（一句话） | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **B1 反代服务本体** | 在 `0.0.0.0:<wanPort>` 监听并把 LAN 流量转发到 `127.0.0.1:<dshPort>`，做回环呈现 + HTML polyfill 注入 + 断线保持 | 回环 target(host,port)、wanPort、门卫 token 初值、`dshTokenOf()`、logger、events、id | `http.Server`（附 `setToken/hasToken/setDshToken/status` 与 wanPort 元数据） | 端口监听、TCP/HTTP 连接、进程内状态 | 否 |
| **B2 请求门禁** | 判定来源是否回环/私网；校验 `dsh_lan_token`（URL/Cookie 常数时间比较），首次凭 URL 令牌种 HttpOnly Cookie | `req`/`res`/`socket`、当前 token | 放行 / 302 种 Cookie / 401 / 403 | 写响应头、Set-Cookie | 判定纯，应答有 IO |
| **B3 DSH 会话桥** | 按需从令牌池取 `dshToken` → 换取 `dsh-auth-*` cookie → 缓存**派生结果**并注入 HTTP+WS；上游 401/403 时清 cookie 自愈 | `dshTokenOf()`、回环 target | `"name=value"` cookie 或 null | 网络换取、进程内缓存、事件 | 否 |
| **B4 WS/Upgrade 隧道** | 重建原始请求行+头（回环呈现 + cookie）后建立双向原始 TCP 隧道 | `req`/`socket`/`head` | 隧道 | 网络 | 否 |
| **B5 代理编排/对账** | 把「受管清单 × `remoteEnabled`」收敛为运行中的 relay 集合；单飞；含目标可达判定与孤儿清理 | 受管清单、可达探测、当前 server 表 | 内存投影 `lanInstances` + server 启停 | 建/停 server、TCP 探测、端口注册表、事件 | 否 |
| **B6 端口槽位仲裁** | 为每个 relay 实例确定性分配 `wanPort`（绑定复用 → 槽位回收 → 池内最小空闲 → 显式 conflict），禁跳号 | `inst.wanPort` 绑定、owner、`configPath` | `{port}` 或 `{conflict:true}` | 端口注册表读写、cmdline 回收、等待 | 否 |
| **B7 frpc 配置生成** | `settings × instances` → `frpc.toml` **文本** + `[[proxies]]` 计数 | settings、instances | `{text, count}` | **无** | **是** |
| **B8 frpc 进程托管** | frpc 子进程生命周期：启/停/平滑重启、非预期退出有界退避、孤儿清理、权限加固 | binPath、configFile、settings | `{ok,pid,error,needInstall,already}` | 子进程、文件、事件 | 否 |
| **B9 frp 安装（下载+完整性）** | 镜像回退下载 → **官方直连**取 sha256 → 校验（不匹配拒绝该镜像）→ 纯 JS 解压 | asset、镜像表 | `{ok,binPath}` / `{ok:false,error}` | 网络、文件、chmod | 否 |
| **B10 暴露配置写入（策略）** | 令牌闸 + 端口合法性 + 端口占用校验后，写回实例/主实例元数据并同步 frpc | id、`frpEnabled`、`frpRemotePort` | `{ok,...}` | 持久化、事件 | 否 |
| **B11 视图/状态投影** | `list()`/`frpStatus()`/server `status()` → **非机密**结构（令牌只出布尔） | 内存投影、server 状态 | JSON | 无（`list()` 会触发一次异步 reconcile） | 半纯 |
| **B12 令牌热更新分发** | `applyToken` → `server.setDshToken()`；`syncProxy` 快路径 → `server.setToken(want)` | instId / 新令牌 | boolean | relay 内状态、事件 | 否 |
| **B13 进程入口/装配** | 读配置 → 注册日志源/端口注册表文件 → 构造编排器 → 2s 轮询状态快照 → 起 ctl → 优雅停机 | `-c <cfg>` / env | 进程 | 全部 | 否 |
| **B14 端口段申报** | 声明 `relay → managed` 池（域知识留在域内） | — | 注册副作用 | 全局端口注册表 | 否 |

**切面判据自检**（§2 四把刀）：
- 刀 1（副作用）：B7 纯文本生成从 `frpmgr.js:118-144` 抽出；B2 的判定部分（`index.js:44-78,123-131`）为纯函数，应答部分留 IO。
- 刀 2（变更频率）：B10 阈值/闸门（常变）与 B7 协议文本（稳定）分开。
- 刀 3（生命周期）：B13 进程级、B5 定时级（2s tick / 请求级触发）、B1/B4 请求级。
- 刀 4（角色）：传输(B1/B4) vs 决策(B5/B10) vs 持久化(B7 文本 + frp.json 写) vs 观测(B11)。

---

## C. 目标结构（★ 逐文件）

| 新文件 | 行数估计 | 职责 | 从哪来（旧文件:行区间） | 纯? |
|---|---|---|---|---|
| `index.js` | **≤60** | 门面：组合 + 导出（无逻辑） | 新写（导出面取自 `index.js:502` + `manager.js:504` + `frpmgr.js:439`） | 是 |
| `core.js` | ~180 | 纯判定与纯构造：来源信任归一、常数时间比较、cookie 取值/门卫决策、回环呈现头构造、polyfill 常量、frpc.toml 文本、settings 归一 | `index.js:44-60,63-104,109-131` + `frpmgr.js:118-144` + `frpmgr.js:84-96` 的归一化部分 | **是** |
| `session.js` | ~170 | DSH 会话桥：`dshTokenOf` 按需取值、cookie 换取/缓存/自愈、注入头、诊断状态 | `index.js:166-229,277-289` + `index.js:176-195`（state/record*） | 否 |
| `proxy.js` | ~200 | 反代 server 本体：HTTP 管线、polyfill 注入、断线保持、server 热更新面 | `index.js:145-160,232-275,291-398,478-499` | 否 |
| `tunnel.js` | ~110 | WS/Upgrade 原始 TCP 隧道 | `index.js:400-476` | 否 |
| `managed.js` | ~60 | 受管清单视图合成 + 本机地址（纯投影 + 一次 `os.networkInterfaces`） | `manager.js:36-45,54-63` + `65-100` 的 map 部分 | 半纯 |
| `ops.js` | ~300 | 代理编排主体（LanManager）：对账/单飞、syncProxy、实例联动、server 启停、frp 策略与状态、停机、令牌热换 | `manager.js:14-34,65-181,203-409,411-447,466-501` | 否 |
| `ports.js` | ~120 | 端口槽位仲裁：绑定复用/回收/池内最小空闲/冲突、EADDRINUSE 迁移节流、段申报触发 | `manager.js:285-288,330-391` 的端口段 + `449-464` | 否 |
| `frp.js` | ~280 | frpc 进程托管 + settings 持久化 + status + syncFromInstances | `frpmgr.js:48-115,147-297` | 否 |
| `frp-install.js` | ~200 | 平台标签/镜像 URL/下载/sha256 完整性校验/纯 JS 解压 | `frpmgr.js:19-46,300-435` | 否 |
| `daemon.js` | **214**（**禁改名、禁移动**） | 进程入口：装配 + tick + ctl（R5） | 原样保留（仅 `100-140` 可选外移，见 F-9） | 否 |
| `port-segments.js` | 22 | 端口段申报 | 原样保留 | 否 |

**目录树（扁平优先，采纳 R2）：**

```
src/domains/relay/
├── index.js           门面（组合 + 导出，≤60 行）
├── daemon.js          独立进程入口（★ 文件名与路径均不得变，R5）
├── core.js            纯判定/纯构造（无 IO）
├── session.js         DSH 会话桥（cookie 换取 + 注入）
├── proxy.js           反代 server 本体（原 index.js 的服务实现）
├── tunnel.js          WS/Upgrade 隧道
├── managed.js         受管清单视图投影
├── ops.js             代理编排（原 manager.js 的 LanManager）
├── ports.js           端口槽位仲裁
├── frp.js             frpc 进程托管
├── frp-install.js     frp 下载 + 完整性校验 + 解压
└── port-segments.js   端口段申报（保留）
```

**为何不用子目录**：R2 明确「优先扁平」。本域 12 文件、单一职责、无同类多实现（`frp.js`/`frp-install.js` 已按副作用切开），建子目录只增路径噪音。**不建 `store.js` 的理由**：本域无自有数据模型——实例配置的单一数据源在 instance 域与 `app/state`，relay 只经注入的 `persist`/`instances.save` 回写（`manager.js:48-51`）；唯一域内持久化是 `frp.json`/`frpc.toml`，与 frpc 同生命周期，故并入 `frp.js`（IO 同生命周期，符合刀 3）。


**与 `app/facade` 的分层（R7）**：域内 `ops.js` 的 `list/setFrp/frpStatus/frpAction/syncFrpc` 是**域业务动作**，
到达路径有两条：本机经 `sup`（`app/facade/lan.js`，见 `src/api/deps.js:99`）或 独立进程经 ctl（`daemon.js:35-38` 白名单）。
按 **R7**，`app/facade/lan.js:44-62` 的写动作应下沉 `app/domain-actions/`（门面只留 `listLan`:14` / `frpStatus`:49` 两个只读视图）。
**该搬迁属 app 层结构调整，本设计不擅自改**；relay 侧只要求：迁移后门面/动作层**只是转发**，业务规则全在 `ops.js`（含 `core.js` 的 `validateFrpExposure`，见 E-10）。
---

## D. 依赖图（★ 必须是 DAG）

```
index.js ──▶ ops.js ──▶ proxy.js ──▶ session.js ──▶ core.js
   │           │           │            └──────────▶ platform/service/token/exchange
   │           │           └──▶ core.js
   │           ├──▶ tunnel.js ──▶ session.js / core.js
   │           ├──▶ ports.js ──▶ platform/service/ports (+ port-segments.js)
   │           ├──▶ managed.js
   │           └──▶ frp.js ──▶ frp-install.js ──▶ platform/contract/matrix, platform/os/*
   ├──▶ frp.js / frp-install.js（仅 re-export）
   └──▶ core.js（仅 re-export）

daemon.js ──▶ ops.js / port-segments.js / platform/{ctl,log,service:ports,config,state-root}
port-segments.js ──▶ platform/service/ports
```

**逐边与理由：**

| 边 | 理由 | 类型 |
|---|---|---|
| `index → ops/proxy/frp/frp-install/core` | 门面只做组合与再导出（DF-1） | 域内 · 合法 |
| `ops → proxy` | 编排创建 server（**替代旧的 ops→index**，消除 DF-7 反向边） | 域内 · **本次修复** |
| `ops → ports` | 槽位仲裁独立单元（可独立单测：给假 registry） | 域内 · 合法 |
| `ops → managed` | 清单投影纯函数 | 域内 · 合法 |
| `ops → frp` | 编排调 frpc 托管（**建议 ctor 注入**，见 E-3） | 域内 · 合法（可降为注入） |
| `ops → core` | 纯判定复用 | 域内 · 合法 |
| `proxy → session` | server 请求路径需 cookie 注入 | 域内 · 合法 |
| `proxy → core` | 门禁判定/polyfill/头构造 | 域内 · 合法 |
| `tunnel → session/core` | WS 重建需 cookie 与回环呈现 | 域内 · 合法 |
| `session → core` | cookie 解析/合并纯函数 | 域内 · 合法 |
| `frp → frp-install` | 进程缺失时按需安装 | 域内 · 合法 |
| `frp → platform/{os/spawn, os/index, contract/matrix}` | spawn/文件保护/平台标签 | 跨层 · 合法（domains→platform ✓） |
| `frp-install → platform/contract/matrix` | **os/arch 映射唯一事实源**（`test/platform-matrix-single-source-test.js:99` 白名单） | 跨层 · 合法 |
| `proxy/session → shared/ip, platform/service/token/exchange` | 来源信任 / dsh-auth 换取（协议知识只一份） | 跨层 · 合法 |
| `ops → platform/service/monitor` | TCP 可达探测 | 跨层 · 合法 |
| `ports → platform/service/ports` | 通用池 + 分配算法（段名由域申报，§4.2 反转法） | 跨层 · 合法 |

**跨域边：0 条。** relay 不 require 任何 `domains/*`（router/instance/plugin/shell 皆无）——符合 DS-2。
**禁止边（本设计的硬断言）：**
- ⟂ **任何域内文件 → index.js**（DL-G3，杀掉 `manager.js:422` 形态）。
- ⟂ `ops ↔ proxy` 双向、⟂ `session ↔ proxy` 双向（保持分层单向）。
- ⟂ `core.js` 出现任何 IO require（`node:fs`/`node:http`/`node:child_process`）——纯层。

**DAG 自检**：全部叶子为 `core/managed/port-segments`，无回边 → SCC = 0（F 步每步后复跑 A.2 的 Tarjan 脚本即可验证）。

---

## E. `this` 隐式耦合消解表（★ 逐条）

> 前提：本域**现有** `this` 跨文件调用 = 0（A.2 实测）。下表消解的是**拆分将暴露/已潜伏**的耦合，以及 P1–P4 属性级耦合。

| # | 旧调用 | 位置 | 消解手法 | 新形态 |
|---|---|---|---|---|
| E-1 | `require('./index')` 取 `createRelay`（门面反向依赖） | `manager.js:422` | **A** | `ops.js` 顶部 `const { createRelay } = require('./proxy')`；`index.js` 回归纯 re-export。**方向反转为 index→ops→proxy** |
| E-2 | `srv.status()` 鸭子调用 | `manager.js:82` | **B** | `proxy.js` 导出的工厂显式返回带 `status()/setToken()/hasToken()/setDshToken()` 的 server；`ops.js` 只经该**具名契约**读取 |
| E-3 | `this.frpmgr = new FrpManager({...})` + `this.frpmgr.status()/start()/stop()/install()/syncFromInstances()` | `manager.js:22-26,129,154,160,164-166,176` | **B** | `ops.js` ctor 增注入位 `frp`（默认 `new FrpManager(...)` 保持兼容），**不 require 具体实现**；装配期传入。单测可给假 frp |
| E-4 | `this._allManaged()` / `this._findManaged(id)` | `manager.js:54-63`（定义）、`:55,62,68,116,130,214,252`（调用） | **C** | 提为纯函数 `managed.allManaged({ instances, mainOf })` / `findManaged(list, id)`，`s` 显式入参——**最易测**（给 `{instances:[], mainOf:()=>null}` 即可） |
| E-5 | `this._saveAll()` | `manager.js:48-51`（定义）、`:122,371,461` | **C** | 纯化为 `persistFlow({persist, instances, logger})`，副作用经注入的 `persist` 单点 |
| E-6 | `ports.claimSlot/unregister/rangeOf/list/isRegistered/allocateMark/release` 散落调用 | `manager.js:226,268,342-350,365-369,386,456` | **A** | 收口 `ports.js`：`claim(registry, { owner, inst, configPath })` / `release(registry, owner)` / `migrateOnListenFail(...)`；`ops.js` 只调具名函数 |
| E-7 | **`server._wanPort` 读写**（私有字段跨文件） | 写 `manager.js:439`；读 `manager.js:358,362,417` | **C** | 删除第二副本：`ops` 侧已有 `lanInstances[i].wanPort` 为权威；`_startLanServer` 不再挂 `_wanPort`，重复检查改用 `lanInstances` 查找。若必须保留，则以 `proxy.js` 显式 `server.wanPort` 契约暴露 |
| E-8 | **`lan.frpmgr.child` 触达私有子对象** | `daemon.js:179,198` | **B** | `ops.js` 暴露具名只读访问器 `frpChild()`（或 `waitFrpExit()` 直接由 `frp.js` 提供），daemon 只经声明面等待退出 |
| E-9 | `lan.applyToken(id, tok)` 传参与实现不符 | 调用 `daemon.js:132`；实现 `manager.js:490` | **C** | 签名统一为 `applyToken(instId)`（值一律由 `tokenOf` 按需取，TK-4）；daemon 侧去掉多余实参 |
| E-10 | 跨层重复闸（`setFrp` vs `patchDshMain`） | `manager.js:108-118` ↔ `app/facade/main.js:64-80` | **A+C**（仅域侧） | relay 侧把「令牌闸 + 端口合法性 + 占用校验」提为 `core.js` 纯函数 `validateFrpExposure({ remoteToken, frpRemotePort, peers })`，`ops.js:setFrp` 调它；**`app/facade/main.js` 改为调用同一纯函数属跨层改动——需上层裁决（与 **R7** 同一议题：该写动作应随 facades 写动作一并下沉 `app/domain-actions/`），本设计只提供单元，不擅自改 app** |

---

## F. 迁移步骤（★ 可执行、可分批，每步后 `npm test` 必须仍绿）

> 通用验证命令：`node --require ./test/_preload.js test/<file>`
> 行数门禁（每步后自检）：`awk 'END{print FILENAME, NR}' src/domains/relay/*.js`

| 步 | 动作 | 影响文件 | 验证 | 可独立提交 |
|---|---|---|---|---|
| **F-1** | 抽 `core.js`（纯）：`isTrustedSource`/`safeEqual`/`hasValidToken`/`tokenGate` 决策/`cookieByName`/`POLYFILL_SCRIPT`/`buildFrpcToml`/`normalizeFrpSettings`。`index.js`、`frpmgr.js` 改为 require 它 | `index.js`(迁出 44-131)、`frpmgr.js`(迁出 118-144)、新增 `core.js` | `test/relay-source-gate-test.js`（**须同步改判据，见 G-3**）、`test/relay-dshauth-test.js`、`test/core-test.js`、`test/frp-platform-test.js` | ✅ |
| **F-2** | 抽 `session.js`：`dshTokenOf/dshCookie/bootstrapping/state/record*/ensureDshCookie/refreshDshSession/mergedCookieHeaders`；暂由 `index.js` 内部调用 | `index.js`(迁出 166-229,277-289) | `test/relay-dshauth-test.js`（场景 1–3 + `setDshToken` 热换） | ✅ |
| **F-3** | `index.js` → `proxy.js`（整文件改名，服务本体）；`index.js` 新建为 **re-export 门面**；`manager.js:422` 改 require `./proxy` | 新增 `proxy.js`；重写 `index.js`；`manager.js:422` | `test/core-test.js:242`、`test/relay-dshauth-test.js:11`、`test/round13-router-relay-gaps-test.js:107`（改读 `proxy.js`）；**新增断言 index.js ≤150 且域内入度=0** | ✅（**DF-7 修复点**） |
| **F-4** | 抽 `tunnel.js`（WS/Upgrade）：`proxy.js` 的 `server.on('upgrade')` 整体迁出并显式注入 `{ core, session, authority }` | `proxy.js`(迁出 400-476)、新增 `tunnel.js` | `test/relay-dshauth-test.js`（WS 路径）、`test/relay-source-gate-test.js` S-b（改读 `tunnel.js`） | ✅ |
| **F-5** | 抽 `ports.js`：`claimSlot` 调用收口、`_handleRelayListenFail` 迁移节流、段申报 require 触发 | `manager.js`(迁出 342-350,449-464)、新增 `ports.js` | `test/ports-claim-test.js`、`test/ports-capacity-test.js:101-107`（改读 `ports.js`）、`test/ports-verify.js` | ✅ |
| **F-6** | 抽 `managed.js`（`_allManaged/_findManaged/list` 投影）+ `frp.js`/`frp-install.js`（`frpmgr.js` 按副作用二分）；`ops` ctor 注入 `frp` | `manager.js`、`frpmgr.js`(拆)，新增 `managed.js/frp.js/frp-install.js` | `test/frp-platform-test.js`、`test/frp-resilience-test.js`、`test/round13-frpc-integrity-test.js`（改读 `frp-install.js`）、`test/reconcile-single-flight-test.js` | ✅ |
| **F-7** | `manager.js` → `ops.js`（编排主体改名）；`index.js` re-export 面扩为 `{ createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls }`；清 E-7/E-8/E-9 | `manager.js`→`ops.js`、`daemon.js:179,198` | `test/reconcile-single-flight-test.js:38,50`（改路径）、`test/ports-capacity-test.js:101`、`test/graceful-shutdown-test.js:86-91`、`test/lan-access-boundary-test.js`、`test/adopt-token-reclaim-test.js:73` | ✅（**建议尽早**，因消费方引用 manager 路径） |
| **F-8** | 同步所有按**旧路径**读取源码的门禁/测试（清单见 G-1）；`test/directory-structure-gate-test.js` 落 H 节新判据 | 约 10 个 test 文件 | `test/directory-structure-gate-test.js`、`test/layering-and-dependency-gate-test.js`、`test/provider-gateway-gate-test.js`、全量 `npm test` | ✅ |
| **F-9（可选，风险最高）** | `daemon.js:100-140` 的状态快照轮询 + diff 外移到 `state.js`（读 `lan-state.json`）；daemon 只留装配/tick/ctl | `daemon.js`、新增 `state.js` | `test/lan-daemon-test.js`（**真启动子进程集成测试**——本步唯一验证手段）、`test/graceful-shutdown-test.js` | ⚠ 建议最后做；可整步回滚 |

**每步的通用校验（不启动任何守卫进程）**：
- 行数：`index.js ≤150`、单文件 `≤400`（R3）；
- DAG：重跑 A.2 的 Tarjan 脚本（剥注释）→ SCC = 0；
- 域内入度：`grep -rn "require('./index')" src/domains/relay/` → 0 命中（F-3 后）；
- 域 B 语义：`grep -n "guardian\|desired" src/domains/relay/*.js` → 0 命中。

---

## G. 风险与取舍

### G-1 破坏性改动：导出面/路径变化 → 点名消费方

| 变化 | 消费方（必须同步） | 位置 |
|---|---|---|
| `manager.js` → `ops.js` | 装配/惰性 getter/门面 | `src/app/assembly/compose.js:21`、`src/supervisor.js:100` |
| `frpmgr.js` 拆分后 `frpPlatformTag/downloadUrls` 迁至 `frp-install.js` | 测试 + 完整性门禁 | `test/frp-platform-test.js:9`、`test/frp-resilience-test.js:22`、`test/round13-frpc-integrity-test.js:65,135` |
| `index.js` 服务实现迁 `proxy.js` | 源码级门禁 + 行为测试 | `test/relay-source-gate-test.js:45,85`、`test/round13-router-relay-gaps-test.js:96,107` |
| 路径字面量（`src/domains/relay/index.js` 等） | 按旧路径读源码的门禁 | `test/ports-capacity-test.js:101`、`test/reconcile-single-flight-test.js:38,50`、`test/graceful-shutdown-test.js:86` |
| **`createRelay` 导出面保持不变** | `test/core-test.js:242`、`test/relay-dshauth-test.js:11` | 零改动（门面 re-export 保证） |

### G-2 ⛔ 最高风险：`relay/daemon.js` 是**独立进程入口**（R5）

- **不得改名**（必须仍为 `daemon.js`）：cmdline 匹配点——`src/app/daemons/probe.js:46`（字面量 `'/domains/relay/daemon.js'`）、`src/app/daemons/scripts.js:23`（`DAEMON_REL.lan`）、`src/app/daemons/process.js:96-99`（**从 script 路径派生**标记）、`test/round8-fixes-test.js:88,131,134`（`/src/domains/router/daemon.js` 同构形态）。
- **也不得移动**：`probe.js:46` 用**字面量**匹配 `/domains/relay/daemon.js`——改名能过、**移动目录会打断生产探活**（判定恒 false → 重复拉起/双占 43108）。故本设计**不把 daemon.js 放入子目录**。
- **不得去掉入口守卫** `if (require.main === module) main();`（`daemon.js:213`）——`test/provider-gateway-gate-test.js:222-228`（PG-9）锁定；历史上曾因裸 `main()` 误启生产 daemon。
- **停机语义不得退化**：`daemon.js:178-210` 的 `waitFrpcExit` 必须保留（`frpmgr.stop()` 同步发 SIGTERM，SIGKILL 兜底在 3s 后；紧接 `process.exit` 会造孤儿 frpc 占公网端口）。由 `test/graceful-shutdown-test.js:86-91` 锁定。
- **取舍**：F-9 收益是 DF-3 纯度，代价是**唯一验证手段为真启动子进程的 `test/lan-daemon-test.js`**（无法用纯 require 验证）。故列为**可选最后一步**，需人工确认。

### G-3 源码形态门禁会被「正当重构」打断（必须在同一步改判据）

| 门禁 | 依赖的当前形态 | 重构后的落点 |
|---|---|---|
| `test/relay-source-gate-test.js:48` | `index.js` 内 `function isTrustedSource(` | → `core.js` |
| 同 `:49-50` | `index.js` 串含 `"api/identity"`（来自 `:25` 注释） | ⚠ **注释一旦精简即失败**；应改为断言 `shared/ip` 具名导入 |
| 同 `:56-59` | `index.js` 内 `if (!isTrustedSource(req))` / `(req, socket)` | → `proxy.js` / `tunnel.js`（**须两处都断言**，S-b 的防绕过语义不能丢） |
| 同 `:85-88` | `frpmgr.js` 含 `localIP = "127.0.0.1"` | → `core.js` 的 `buildFrpcToml` |
| `test/round13-router-relay-gaps-test.js:98-104` | `index.js` 的 `let token`、`server.setToken =`、`server.hasToken =`；`manager.js` 的 `existing.token !== want`、`setToken(want)` | → `proxy.js` / `ops.js` |
| `test/reconcile-single-flight-test.js:39-44` | `manager.js` 的 `_reconcileInFlight`/`_reconcileOnce` | → `ops.js` |
| `test/ports-capacity-test.js:106-107` | `manager.js` 无裸 `40000`、含 `rangeOf('relay')` | → `ops.js`（`rangeOf` 调用）+ `ports.js` |
| `test/round13-frpc-integrity-test.js:135-144` | `frpmgr.js` 内 `_checksums.txt` + `const url = 'https://github.com/...'` 同一行 | → `frp-install.js`（行内定界断言对行号不敏感，但对文件名敏感） |
| `test/platform-matrix-single-source-test.js:99` | 白名单只放行 `platform/contract/matrix.js` | `frp.js:56` 已委托 matrix，重构后保持（**不得把 os/arch 映射搬回域内**） |

### G-4 不做 / 取舍说明

1. **不建 `store.js`**：本域无自有数据模型（理由见 C 节）。强行建空文件违反 §4「没有对应职责就不要建空文件」。
2. **不做 ctor 注入 `frp`（E-3）以外的全面 DI 改造**：relay 已是零跨文件 `this` 调用，全面 DI 是「为设计而设计」；只对 `frp`（有替身价值）与 `persist/tokenOf/mainOf`（已是注入）动手。
3. **不动 `port-segments.js`**：22 行、零耦合、门禁 DS-G4 依赖其「require 即申报」时序（`manager.js:10` 必须先于 `:11`）。
4. **不动 `app/facade/main.js` 的重复闸**（E-10）：跨层，标「**需上层裁决**」。
5. **不动 daemon 的 ctl 白名单内容**（`daemon.js:35-38`）：`test/provider-gateway-gate-test.js:182-183`（PG-5）锁定「按域注入 + fail-closed」。
6. **不改域 B 语义**（`GUARD-DOMAIN-MODEL` §2/G-1）：不引入 `guardian/desired/restartCount/guardian_action`；`test/guard-domain-model-gate-test.js:167-177,242-255` 必须继续通过。

---

## H. 门禁建议（供 `test/domain-structure-gate-test.js`）

> 通用要求：每条判据**必须配反向自检**（构造旧形态样本，证明判据能命中），否则门禁空转。

### H-1 R6：禁止把「外部方法集」挂到原型（**必含**；R6 取代 R4 的原正则）

> R4 的原正则右值必须是**内联 require**，因此 `src/supervisor.js:160` 的
> `Object.assign(Supervisor.prototype, mod.methods)`（右值是**变量**）被漏掉；
> 而 `supervisor.js` 中唯一被 R4 命中的恰好是**第 21 行注释** —— 假阴性 + 假阳性同时发生。
> 故按 R6 改为**两条正则组合**，并**必须先剥注释**。

```js
// ⚠ 必须先剥注释再判（否则会命中说明文字，D10 已实测）
const strip = (s) => s.replace(/\/\*[\s\S]*?\/\*/g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ① 任何把「外部方法集」挂到原型上的手法（右值不限：变量 / 内联 require 都要抓）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（module.exports = { methods: ... }）——与 ① 联合定位「方法集来源」
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;

const violations = [];
for (const f of files) {
  const code = strip(fs.readFileSync(f, 'utf8'));
  if (MIXIN_INTO_PROTOTYPE.test(code)) violations.push(rel(f) + ' [prototype-mixin]');
}
check('DS-G3b 无 Object.(defineProperties|assign)(X.prototype, ...) 注入（右值不限）',
  violations.length === 0, violations.join(', '));

// ③ 反向自检：**必须**含「变量右值」与「内联 require」两种样本
const SAMPLE_VAR = 'Object.assign(Supervisor.prototype, mod.methods)';
const SAMPLE_INLINE = `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)`;
const SAMPLE_DEFPROP = 'Object.defineProperties(Supervisor.prototype, mod.accessors)';
check('DS-G8b 反向：判据能命中**变量右值**（R6 的核心补漏）', MIXIN_INTO_PROTOTYPE.test(strip(SAMPLE_VAR)));
check('DS-G8b 反向：判据能命中内联 require', MIXIN_INTO_PROTOTYPE.test(strip(SAMPLE_INLINE)));
check('DS-G8b 反向：判据能命中 defineProperties 形态', MIXIN_INTO_PROTOTYPE.test(strip(SAMPLE_DEFPROP)));
// ⚠ 假阳性防护：剥注释后，**注释里**的同形文字不得命中（D10 实测的 supervisor.js:21 即是）
check('DS-G8b 反向：剥注释后注释内样本不再命中',
  !MIXIN_INTO_PROTOTYPE.test(strip('// 旧写法：Object.assign(X.prototype, require("./y"))')));
check('DS-G8b ② 分片导出判据可用', METHODS_FRAGMENT.test(strip('module.exports = { methods: { a() {} } };')));
```

**判据语义**：② 单独出现**不是**违规（`app/facade/*.js` 合法地导出 `module.exports = { methods: {...} }`）；
只有 ①（挂到原型）才构成「把两个文件的方法合并到同一 `this` 上」。② 的用途是**定位方法集来源** ——
本仓的真实命中点是 `src/supervisor.js:150-172` 的 `APP_MODULES` 循环（`:160` 的 ① 与各 `app/*` 文件的 ②）。

**relay 域实测**：① 0 命中、② 0 命中（relay 无任何分片导出）——请把该判据做成**全域**门禁，relay 只是受益方。

### H-2 relay 域结构判据（DL-G1 .. DL-G8）

| 门禁 | 断言 | 判据要点 |
|---|---|---|
| **DL-G1 门面纯化** | `src/domains/relay/index.js` 行数 **≤150**；且剥注释后**不含** `createServer(`/`.listen(`/`setInterval(`/`writeFileSync`/`child_process` | 门面只组合与导出（DF-1） |
| **DL-G2 单文件上限** | `src/domains/relay/*.js` 每文件 **≤400** 行（`port-segments.js` 忽略） | DF-2（R3 严值） |
| **DL-G3 门面不被域内依赖** | `domains/relay` 下**除 index.js 外**无文件 require `./index`（正则 `require\\(\\s*['\"]\\./index['\"]\\)`）；即 `index.js` 域内入度 = 0 | 杀 `manager.js:422` 形态（DF-7） |
| **DL-G4 域内 DAG** | 对 `domains/relay/*.js` 建 require 图（**先剥注释**），Tarjan SCC = 0 | DF-5（R1 取证方式） |
| **DL-G5 域 B 语义** | `domains/relay/*.js` 剥注释后**不含** `guardian`/`desired`/`restartCount`/`guardian_action` | 契约 §2 G-1（新增，防回归） |
| **DL-G6 私有字段不跨文件** | `ops.js`/`proxy.js` 中不出现 `\\._wanPort`；`daemon.js` 中不出现 `frpmgr\\.`（剥注释） | 杀 P1/P2（E-7/E-8） |
| **DL-G7 daemon 入口契约** | `src/domains/relay/daemon.js` **存在且 basename 为 daemon.js**；含 `require.main === module`；含 `waitFrpcExit`；`src/app/daemons/scripts.js` 的 `DAEMON_REL.lan` 指向 `domains/relay/daemon.js` | R5 + PG-9 + 停机语义 |
| **DL-G8 纯层无 IO** | `core.js` 剥注释后不 require `node:fs`/`node:http`/`node:https`/`node:net`/`node:child_process` | DF-3（刀 1） |

反向自检样本（举例）：
```js
check('DL-G8 反向：判据能识别纯层里的 IO',
  /require\\(\\s*['\"]node:fs['\"]\\)/.test("const fs = require('node:fs');"));
check('DL-G3 反向：判据能识别门面被反向依赖',
  /require\\(\\s*['\"]\\.\\/index['\"]\\)/.test("const { createRelay } = require('./index');"));
```

### H-3 建议同步修订的既有门禁

- `test/relay-source-gate-test.js`：S-a/S-b/S-d 改为**多文件**断言（`core.js` + `proxy.js` + `tunnel.js`），并新增「S-a′ 复用 `shared/ip`」断言替代对注释串 `"api/identity"` 的依赖（G-3）。
- `test/directory-structure-gate-test.js:170` 的 `ALLOWED`：按 R2 放宽为 `providers instances policies model store handlers core jobs`（本设计实际只用**扁平文件**，故该步对 relay 非必需，但需与其余五域一致）。
- `src/app/facade/`：按 **R7**，写动作（`setRouterRunning` / `patchDshMain` / `setLanFrp` / `lanFrpc` / `syncFrpc`）应下沉 `app/domain-actions/`；
  受影响的注入表是 `src/api/deps.js:57`（`patchDshMain`）、`:81`（`setRouterRunning`）、`:99`（`setLanFrp/lanFrpc`）。
  ⚠ 属 **app 层**结构调整，**需上层裁决**；relay 侧只需保证域内 `ops.js` 继续提供同名具名动作。
- `test/reconcile-single-flight-test.js` / `test/ports-capacity-test.js` / `test/graceful-shutdown-test.js`：路径指向 `ops.js`（F-6/F-7）。

### H-4 R7：门面只允许只读视图（写动作须下沉 `app/domain-actions/`）

> 实测（`src/app/facade/` 五个文件逐方法）：

| 文件 | 只读方法 | **写方法**（违规） |
|---|---|---|
| `facade/router.js` | `routerDaemonActive`(`:9`)、`routerStatusView`(`:25`)、`routerProviders`(`:37`)、`routerStatus`(`:51`)、`routerDomainSummary`(`:58`) | `setRouterRunning`(`:78`) |
| `facade/main.js` | `dshMainView`(`:14`) | `patchDshMain`(`:41`) |
| `facade/lan.js` | `listLan`(`:14`)、`frpStatus`(`:49`) | `setLanFrp`(`:44`)、`lanFrpc`(`:54`)、`syncFrpc`(`:59`) |

**为何属 relay 域**：relay 域对外经 `api/deps.js` 注入的表是 `relay: ['config','frpStatus','lanFrpc','setLanFrp','listLan']`（`api/deps.js:99`）——
其中 `setLanFrp`/`lanFrpc` 是**写动作**，且 `facade/lan.js:41,46,51,56,61` 在本地模式下**直接改 LanManager 状态**，
绕过 `app/control/adapters.js:63-83` 的生命周期登记与事件记账。

```js
// 门面白名单：只读动词（view/get/list/status/providers/summary/…）
const READ_ONLY_FACADE = /^(?:.*(View|Status|Providers|Summary|List|Active|Info|Tail)|\.\.\.)$/;
const WRITE_VERBS = /(set|patch|apply|toggle|start|stop|restart|install|sync|enable|disable|update|save|remove|delete|create)/i;

for (const f of facadeFiles) {
  const code = strip(fs.readFileSync(f, 'utf8'));
  const body = code.slice(code.indexOf('methods'), code.lastIndexOf('}'));
  for (const m of body.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = m[1];
    if (WRITE_VERBS.test(name) && !READ_ONLY_FACADE.test(name)) {
      violations.push(rel(f) + ':' + name);
    }
  }
}
check('R7 门面无写动作（写动作应在 app/domain-actions/ 或域内 ops）', violations.length === 0, violations.join(', '));

// 反向自检（三条，缺一不可）
check('R7 反向：判据能识别 setLanFrp（当前违规）', WRITE_VERBS.test('setLanFrp'));
check('R7 反向：判据能识别 patchDshMain（当前违规）', WRITE_VERBS.test('patchDshMain'));
check('R7 反向：只读视图不误报',
  !WRITE_VERBS.test('frpStatus') && !WRITE_VERBS.test('listLan') && !WRITE_VERBS.test('dshMainView')
  && !WRITE_VERBS.test('routerStatusView') && !WRITE_VERBS.test('routerDomainSummary'));
```

**⚠ 与 R7 裁决的边界**：R7 只约束 `app/facade/**`；
**本设计在 relay 域内新增/保留的 `ops.js`（LanManager）不受约束**（`_RULING.md` R7 末句）。
因此 relay 域的迁移**不依赖** `app/domain-actions/` 的落地。

**跨层提示（需上层裁决，与 E-10 同一议题）**：relay 侧可先完成的部分是——把
`facade/lan.js:44-62` 三个写动作改为调用域内具名动作（`LanManager.setFrp` / `frpAction` / `syncFrpc`，均已存在），
使门面**不含业务规则**；但**门面本身的搬迁（`app/facade/lan.js` → `app/domain-actions/lan.js`）是 app 层结构调整**，
与 E-10（`app/facade/main.js` 的重复闸）一并交上层裁决，本设计不擅自改 app。

---

## 附：DF-1 .. DF-7 达成自检

| 判据 | 目标 | 本设计如何达成 |
|---|---|---|
| **DF-1** 门面纯化 ≤150 | `index.js` ≤60 | 只 re-export（C 节）；DL-G1 锁定 |
| **DF-2** 单文件 ≤400 | 最大 `ops.js` ~300、`frp.js` ~280 | 三个 439–504 行文件全部拆细（C 节行数估计）；DL-G2 锁定 |
| **DF-3** 纯/IO 分离 | `core.js` 无 IO | B2/B7/B10 的判定与文本生成 ⇒ `core.js`；DL-G8 锁定 |
| **DF-4** 零隐式 this 跨文件 | 现为 0，拆后仍为 0 | 所有跨文件协作经 A/B/C（E 节 10 条）；P1–P4 一并显式化 |
| **DF-5** 无 require 环 / 禁 prototype 合并 | 现为 0 环 | 保持 0 环（DL-G4）；**按 R1 + R6，DF-5 真义是禁止把外部方法集挂到原型（右值不限：变量或内联 require）——relay 本就 0 命中（① 与 ② 均 0），并纳入全域门禁 H-1** |
| **DF-6** 可独立单测 | 每个非门面文件可独立 require | `core.js`（纯函数）、`managed.js`（假清单）、`ports.js`（假 registry）、`frp.js`（注入假 spawn）、`session.js`（假 `dshTokenOf` + 桩 `bootstrapDshCookie`） |
| **DF-7** 单向依赖 | `index → ops → {proxy,ports,managed,frp} → {session,core}` | 修复 `manager.js:422` 反向边为 `ops → proxy`（E-1，DL-G3 锁定）。**注（R7）**：relay 的写动作目前经 `app/facade/lan.js:44-62` 直达 `ops`，绕过生命周期/事件记账；按 R7 应由 `app/domain-actions/` 承载后再调 `ops` 的具名动作 |