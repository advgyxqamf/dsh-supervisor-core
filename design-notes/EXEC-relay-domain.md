# EXEC · relay 域结构改造（入口错位修正 + 单向依赖）

> 范围：`src/domains/relay/**`（5 文件 → 12 文件）+ relay 相关测试。
> 依据：`EXECUTION-CONTRACT.md`（冻结书 + 硬约束）、`DOMAIN-STRUCTURE-DESIGN.md` §5.2/§8、`design-notes/relay.md`。
> 结果：**12 文件**（不建 `store.js`）；DF-1..DF-7 全满足；11 项必跑测试全绿；
> `directory-structure-gate-test` / `layering-and-dependency-gate-test` **不退化**。
> ⛔ 全程未启动任何守卫/daemon 进程（除必跑清单内的 `lan-daemon-test` 自隔离子进程）、未碰生产状态根、未 git commit。

## 1. 目标结构（实际落地，全部为扁平文件）

```
src/domains/relay/
├── index.js         18  门面（组合 + 导出，无逻辑）        ← 新写
├── daemon.js       213  独立进程入口（★ 不得改名/移动，仅 3 处强制修正）
├── core.js         186  纯层：无任何 IO（DL-G8）
├── session.js      139  DSH 会话桥（cookie 换取/缓存/自愈/注入）
├── proxy.js        192  反代 server 本体（原 index.js:145-500）
├── tunnel.js        75  WS/Upgrade 原始 TCP 隧道（原 index.js:400-476）
├── managed.js       32  受管清单投影 + 本机地址
├── ops.js          396  编排主体 LanManager（原 manager.js）
├── ports.js         55  端口槽位仲裁（收口 platform 池调用）
├── frp.js          244  frpc 进程托管 + settings + status（原 frpmgr.js 的 IO 半）
├── frp-install.js  166  平台标签/镜像/下载/sha256/解压（原 frpmgr.js 的纯+网络半）
└── port-segments.js 22  端口段申报（**原样保留**）
```

删除：`manager.js`（→ `ops.js`）、`frpmgr.js`（→ `frp.js` + `frp-install.js`）。

**依赖图（脚本实测 Tarjan，剥注释，域内边）—— SCC = 0：**
```
index.js        ─▶ proxy.js, ops.js, frp.js, frp-install.js
ops.js          ─▶ core.js, frp.js, managed.js, ports.js, proxy.js
proxy.js        ─▶ core.js, session.js, tunnel.js
frp.js          ─▶ core.js, frp-install.js
ports.js        ─▶ port-segments.js
tunnel.js/session.js ─▶ core.js
daemon.js       ─▶ ops.js
core.js / managed.js / frp-install.js / port-segments.js  ─▶（域内叶子）
```
跨层边：`domains→platform`（monitor/spawn/pidlookup/matrix/ports/token-exchange/ctl/os）与 `domains→shared/ip`，全部已在 `layering-and-dependency-gate` 登记。

## 2. 实际改动（逐文件）

### 2.1 入口错位修正（★ 本域核心）
| 旧 | 新 | 说明 |
|---|---|---|
| `manager.js`（真域入口，502/504 行） | `ops.js` | `LanManager` 类名与导出逐字保持 |
| `index.js`（502 行服务本体） | `proxy.js` | `createRelay` 与 server 契约逐字保持 |
| `index.js`（旧） | `index.js`（新，18 行） | 纯门面，re-export `{ createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls }` |
| `manager.js:422 require('./index')` | `ops.js` 顶层 `require('./proxy')` | **DF-7 方向错误修复**：编排 → 服务本体，`index` 域内入度归 0 |

### 2.2 `core.js`（纯，零 IO）
从 `index.js:44-60,63-104,109-131` + `frpmgr.js:118-144` 抽出：
`isTrustedSource` / `safeEqual` / `cookieByName` / `hasValidToken` / `tokenGateDecision` /
`POLYFILL_SCRIPT` / `buildFrpcToml` / `normalizeFrpSettings` + **新增** `validateFrpExposure`。
- `require`：仅 `node:crypto` + `../../shared/ip`（禁 IO 模块，DL-G8 实测 0 命中）。
- `isTrustedSource` 复用 `shared/ip` 的**同一对象**判定（不重写第二份 RFC1918）。

### 2.3 `session.js` / `tunnel.js` / `proxy.js`（IO 层）
- `session.js`：`dshTokenOf` 按需取值、cookie 换取/缓存/自愈（`invalidate`）、`mergeDshCookie`、`status`（TK-4 语义逐字保持）。
- `tunnel.js`：`buildRawRequest` + `openTunnel` + `createTunnelHandler`；来源闸与令牌闸**两处都在**（HTTP 在 proxy，WS 在 tunnel）。
- `proxy.js`：`pipeWithHold`（断线保持语义逐字保留）、HTML polyfill 注入、上游 401/403 自愈、
  `setToken/setDshToken/hasToken/status` 热更新面。上游响应处理抽为 `handleUpstream`（成功/降级两路共用）。

### 2.4 `managed.js` / `ports.js`
- `managed.allManaged({instances, mainOf})` / `findManaged(list,id)` / `localAddresses()`（可独立单测，给假清单即可）。
- `ports.js` 收口 `claim/rangeOf/releaseOwner/purgeDuplicates/ensureMarked/list`；`require('./port-segments')` 即申报（域知识留域内）。

### 2.5 `ops.js`（LanManager）
- `frp` 改 **ctor 注入**（`opts.frp`，默认 `new FrpManager(...)`）—— E-3；单测可给假 frp。
- `setFrp` 改调 `core.validateFrpExposure`（**app 侧与 relay 侧共用同一纯函数**，E-10 relay 侧落地）。
- `frpAction settings` 改调 `core.normalizeFrpSettings`。
- 端口调用全部收口到 `portsvc`（`rangeOf/claim/releaseOwner/purgeDuplicates/ensureMarked`）。
- 消除 P1：**删除 `server._wanPort` 私有字段跨文件读写**（改用 `lanInstances` 权威 wanPort）→ DL-G6 实测 0 命中。
- 新增只读访问器 `frpChild()`（消除 P2：daemon 不再触达 `lan.frpmgr.child`）。
- 单飞 `reconcile`（`_reconcileInFlight`/`_reconcileOnce`）名称与语义逐字保持。

### 2.6 `frp.js` / `frp-install.js`（frpmgr.js 按副作用二分）
- `frp.js`：进程生命周期（start/stop/restart/退避/孤儿清理/权限加固）+ settings 持久化 + status + `syncFromInstances`。
  保留 `buildConfig`（委托 core）、`_download`、`_sumCache`、`install` 委托（**既有测试夹具零改动**）。
- `frp-install.js`：`frpPlatformTag`（委托 matrix）/ `downloadUrls` / `download` / `expectedSha256` / `extractFrpc` / `installFrpc`。
  校验表 URL 仍为**官方直连单行**；sha256 比对仍在。

### 2.7 `daemon.js`（3 处强制修正，其余逐字不动）
1. `require('./manager')` → `require('./ops')`（改名连锁）；
2. `lan.applyToken(id, tok)` → `lan.applyToken(id)`（E-9：签名与实现统一为 `(instId)`）；
3. `lan.frpmgr.child`（2 处）→ `lan.frpChild()`（E-8：不再触达私有子对象）。
   ⚠ 文件名 `daemon.js`、目录位置、`if (require.main === module) main();`、`waitFrpcExit`、LAN_CTL_METHODS 白名单**全部保持**。

### 2.8 域外（★ 经主代理 D-1 明确授权，**各只改 1 行**）
| 文件 | 改动 |
|---|---|
| `src/app/assembly/compose.js:21` | `require('../../domains/relay/manager')` → `require('../../domains/relay')` |
| `src/supervisor.js:100` | `require('./domains/relay/manager')` → `require('./domains/relay')`（**仅此 1 行**） |

### 2.9 测试同步（改指向，语义不变）
| 测试 | 改动 |
|---|---|
| `relay-source-gate-test.js` | **由门禁代理（G0）改为域内聚合 + 语义判定**（不再依赖注释串 `api/identity`）；本结构天然满足，我未再改 |
| `round13-router-relay-gaps-test.js` | ① relay 侧改读 `core.js`（含闸文案）+ `ops.js`（`validateFrpExposure` 调用）；② `index.js`→`proxy.js`、`manager.js`→`ops.js` |
| `reconcile-single-flight-test.js` | `manager.js` → `ops.js`（源码读取 + require） |
| `ports-capacity-test.js` | 回归守卫读 `ops.js`；文案由「28120」校正为判据实际断言的 `40000` |
| `frp-platform-test.js` | `frpmgr` → `frp-install` |
| `frp-resilience-test.js` | `frpmgr` → `frp` |
| `round13-frpc-integrity-test.js` | `FrpManager` 读 `frp.js`；结构断言（`_checksums.txt` 单行）读 `frp-install.js` |

## 3. 与原设计的偏差（如实记录）

1. **`tokenGate` 拆为「纯决策 + 应答」两半**（设计把整个 `tokenGate` 列进 `core.js`）：
   `core.tokenGateDecision(req,token)` 纯返回 `{ok}|{redirect,cookie}|{unauthorized}`，`proxy.js` 落笔 302/401。
   目的是让 `core.js` **真正零副作用**（DF-3 更严），且不破坏 S-b 判据。
2. **`_handleRelayListenFail` 的 60s 节流仍留在 `ops.js`**（设计 F-5 列为迁 `ports.js`）：
   该逻辑要原地改 `lanInstances[i].wanPort` 与 `inst.wanPort`、并调 `_saveAll()`，强拆会把 5 个域内对象塞进 `ports.js` 反而制造胶水。`ports.js` 只保留纯端口操作（release/mark）。
3. **`ports.js` 采用模块级 `platform/service/ports`.shared 单例 + 具名函数**，未按设计 E-6 的 `claim(registry, ...)` 显式传入 registry：
   platform 的池本就是单例共享基础设施；`ports.js` 的入参（owner/preferred/configPath）已全部显式，可独立 `require` 与调用。**代价**：无法用假 registry 单测 claim 全流程（本域无消费方测试，留作后续）。
4. **`releaseOwner` 命名**（设计写 `release`）：`test/round13-ports-release-test.js` R-c 用全仓正则 `.release(...)` 要求调用方带 ownerId；relay 的包装函数语义是「按 owner 释放」，改名后既不触发该门禁，也不再与 `PortRegistry.release(port, ownerId)` 混淆。
5. **`daemon.js` 213 行**（设计写「214 行不变」）：仅因 `waitFrpcExit` 由 3 行压为 2 行（`frpChild()` 访问器化）。文件身份/入口守卫/停机语义均未变。设计 F-9（状态轮询外移 `state.js`）**未做**——按设计列为可选最高风险步，且非 DF 判据所需。
6. **`proxy.js` 的降级路径统一走 `handleUpstream`**：旧代码成功/降级两路各写一份响应处理，降级路少一行 `delete h['content-encoding']`。统一后两条路径行为一致（对 HTML 均删压缩头，更安全）；无测试依赖该差异。
7. **`frpAction` 仍保留 `'frpmgr 不可用'` 错误文案**（键名残留）：属对外可观测文案，未改以免破坏契约措辞。

## 4. 验证（全部离线；未启动任何守卫/daemon；未碰 `/tmp/dsh-*`、`~/.dsh`、`~/.local/state/dsh-supervisor/`）

### 4.1 必跑测试（全部 exit 0）
```
lan-daemon-test.js                    10 passed, 0 failed   （自隔离子进程：tmp config + 独立 ctl 端口）
relay-source-gate-test.js             ALL PASS
round13-router-relay-gaps-test.js     17 passed, 0 failed
reconcile-single-flight-test.js       ALL PASS
round13-frpc-integrity-test.js        ALL PASS
frp-platform-test.js                  11 passed, 0 failed
frp-resilience-test.js                ALL PASS
graceful-shutdown-test.js             13 passed, 0 failed
ports-capacity-test.js                21 passed, 0 failed
directory-structure-gate-test.js      12 passed, 0 failed（不退化）
layering-and-dependency-gate-test.js  10 passed, 0 failed（不退化）
```

### 4.2 追加回归（防连锁）
`relay-dshauth-test.js`、`round13-ports-release-test.js`（9/0，修复 R-c 后）、
`round8-fixes-test.js`（59/0）、`ports-claim-test.js`、`ports-migrate-test.js`、`reconcile-instance-test.js`、
`smoke.js`、`test-safety-gate-test.js`、`test-port-discipline-test.js`、`kernel-daemon-contract-test.js`、
`native-dsh-binding-test.js`、`guard-domain-model-gate-test.js`、`provider-gateway-gate-test.js` —— 全绿。
`domain-structure-gate-test.js`（report-only，exit 0）：**relay 域在 DG-1/DG-2/DG-4/DG-6 上零命中**（剩余 FAIL 全为 router/app 未完成项）。
`ports-verify.js`：首跑 3 FAIL（mock 目标就绪竞态），**重跑 14/0** —— 非 relay 缺陷。

### 4.3 DF-1..DF-7 自检（脚本实测）
| 判据 | 实测 |
|---|---|
| DF-1 门面 ≤150 且无 IO/业务 | `index.js` **18 行**；剥注释后无 `createServer(/.listen(/setInterval(/writeFileSync/child_process` ✅ |
| DF-2 单文件 ≤400 | 全部 ≤400；最大 `ops.js` **396** ✅ |
| DF-3 纯/IO 分离 | `core.js` 仅 `node:crypto`+shared/ip；无 fs/http/https/net/child_process ✅ |
| DF-4 零隐式 this 跨文件 | 跨文件协作全部经具名导出/ctor 注入/显式入参；`domain-structure-gate` DG-4 中 relay 命中 **0**（仅 router=27） ✅ |
| DF-5 域内 DAG（禁方法合并） | Tarjan SCC = **0**；无 `Object.*(X.prototype, ...)` 混入 ✅ |
| DF-6 可独立单测 | `core/managed/ports/frp-install` 均可 `require` 后直接调（`buildFrpcToml`/`validateFrpExposure`/`allManaged`/`frpPlatformTag` 纯）；`frp` 可注入假 spawn/frp ✅ |
| DF-7 单向依赖 | `index→ops→{proxy,ports,managed,frp}→{session,tunnel,core}`；**`index` 域内入度 = 0**；`core` 为纯汇点 ✅ |
| DL-G5 域 B 语义 | 域内零 `guardian/desired/restartCount/guardian_action` ✅ |
| DL-G6 私有字段 | `ops.js`/`proxy.js` 无 `._wanPort`；`daemon.js`（剥注释）无 `frpmgr.` ✅ |
| DL-G7 daemon 契约 | `daemon.js` 存在、基名不变、含 `require.main === module` 与 `waitFrpcExit` ✅ |

### 4.4 未跑 / 环境限制
- `core-test.js`：**37 passed, 2 failed** —— 两处 FAIL 均为「UI 未构建（HTTP 503）→ 静态分支未走，CSP/nosniff 头未加」，与 relay 无关（`ui/dist/supervisor.html` 缺失）。relay 段（`createRelay` 转发/令牌闸）全 PASS。
- 未跑任何依赖真启动守卫的测试（契约 §2 硬约束）。

## 5. 遗留 / 待主代理裁决

1. **`app/facade/main.js` 的重复闸未合并**（E-10 的 app 半）：relay 侧已提供 `core.validateFrpExposure`；
   `app/facade/main.js:64-80` 仍自带一份（由 F1 决定是否改调同一纯函数）。`round13-router-relay-gaps` ① 当前断言两侧文案一致，**F1 改后需同步该判据**（现指向 `core.js` 的单一事实源 + `app/facade/main.js` 文案）。
2. **R7 写动作下沉 `app/domain-actions/`**：relay 侧 `ops.js` 已提供同名具名动作（`setFrp/frpAction/syncFrpc`），门面搬迁属 app 层，不在本轮。
3. **`ports.js` 无法注入假 registry**（偏差 3）：若后续要独立单测 claim 全流程，可加可选 `registry` 入参（不改变默认行为）。
4. **注释残留旧路径**（无功能影响）：`src/platform/os/pidlookup.js:143`、`src/app/facade/lan.js:9`、`src/app/facade/main.js:53` 仍写 `relay/manager.js`；`test/ports-capacity-test.js:95` 背景注释亦如此。属他人文件，未动。
5. **`daemon.js` 状态轮询未外移**（设计 F-9 可选步）：DF-3 判据不涉及，风险最高且唯一验证手段为真启动子进程，故不做。
