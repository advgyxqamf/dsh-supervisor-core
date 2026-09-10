# 内核 + 前端 逻辑自洽审计报告

> 审计对象：/home/bowen/develop/plus（dsh-supervisor 内核仓，v0.1.2-BETA.7）
> 范围：**内核（bin/ + src/）+ 前端（ui/）作为一个整体**。桌面壳（Tauri，独立壳仓）**不在范围内**。
> 方法：源码通读 + 2 路并行子审计（前后端契约、内核不变量）+ 实机验证 + 全测试链回归。
> 结论：**两者逻辑自洽性良好，无硬断线**；发现并修复 1 个前端运行时崩溃、3 个端口泄漏/分叉、1 个事件语义不一致；其余为小型类型漂移与死分支。

---

## 0. 边界确认（回答你的问题）

**是的——内核与前端是一个不可分割的整体，与桌面壳无逻辑耦合。** 实测证据：

| 检查项 | 结果 |
|---|---|
| 壳源码（src-tauri/）是否在本仓 | ❌ 不存在（已拆到独立公开仓） |
| 内核/前端是否 require 壳 | ❌ 零引用（仅 CORS 白名单认 tauri:// 源、autostart 桌面项是可选部署物） |
| 前端如何被托管 | 内核 HTTP 服务从 ui-react/ 或 ui/dist/ 读静态产物（src/api/index.js resolveUiDir） |
| 前端如何取数 | 同源 fetch 到内核 API（client.ts BASE=""），无跨源、无壳透传 |
| 测试链 | 内核 npm test 与 ui/ 独立测试，互不依赖壳 |

结论：**内核 `bin/ + src/ + ui/` 三者构成完整闭环**，壳只是「拉起内核 + 内嵌面板」的引导器，改动内核/前端不影响壳契约。

---

## 1. 三方对账（后端路由 ↔ 前端 client ↔ 页面）

对 9 个 API 域（lifecycle/native/instances/router/plugins/relay/guard/dist/tasks，共 75 条路由）与 client.ts 全量方法逐条比对：

- **客户端调用后端不存在的路由/方法：0 处**（无硬断线）。
- 后端有、前端未封装的端点：`/router/start|stop`（已被 /lifecycle/router/* 取代）、`/router/ports`、`/router/domain-summary`、`/tasks/:id`、`/tasks/:kind/current`、`/plugins/install-status`、`/native/status`、`/env/dsh`、`/shutdown`、`/changelog` —— 属**内部/运维/壳用**，非缺陷。

---

## 2. 发现并修复的问题

### 🔴 P0 — 前端运行时崩溃（已修）

**2.1 `PortPanel.tsx` 端口表因 owner=null 整页崩溃**

- 证据：`PortPanel.tsx:15` `roleTone(role, owner)` 内 `owner.startsWith("inst:")`；`:91` 以 `r.owner` 调用。
  而后端 `ports.js:97` / `supervisor.js:794` 明确 `owner: r.owner || null` —— owner 合法可为 null。
- 影响：任一端口记录 owner 为 null 时，端口管理页渲染抛 TypeError（PageErrorBoundary 兜底但仍不可用）。
- 类型 `types.ts:100` 却声明 `owner: string`，静态层面掩盖了运行时风险。
- **修复**：`roleTone` 加 `(owner || "")` 防空 + 类型改 `string | null`（反映真实契约）。

### 🟠 P1 — 端口泄漏 / 状态分叉（已修）

**2.2 `removeProvider` 不释放端口登记（永久泄漏）**

- 证据：`domains/router/index.js` removeProvider 删除供应商、停端点、停实例，但**从不** `ports.unregister('providerApi:'+id)` / `proxy:<keyId>`。
- 影响：每删一个供应商就泄漏其 API 端点 + 各反代实例端口登记，owner 永久累积、池最终耗尽。
- 反证：其它释放路径（router-ops:584 removeProxyKey、base:283 discardAccount、relay/manager 多处）都正确释放——唯 removeProvider 漏了。
- **修复**：新增 `_releaseProviderPorts()`，删除时级联释放 providerApi + 各 proxy 记录。
- **测试**：P30 原断言把「泄漏」当预期（删除后记录仍在）；已改为「删除前可见（P29b）+ 删除后释放（P30）」双向覆盖。

**2.3 oauth 回调端口分配失败泄漏**

- 证据：`router-ops.js` `base = await ports.allocate('oauthCallback',...)` 后，若 5 个候选端口全绑不上，`if (!server) return` **未** unregister → 永久泄漏 `oauth:<state>`。
  且回退到 `base+i` 绑定时，注册表仍记 `base`（视图/释放错位）。
- **修复**：失败路径回滚登记；回退命中时 `allocateMark` 更正为真实绑定端口。

**2.4 `_applyMainPort` 端口注册与配置分叉**

- 证据：`supervisor.js` `_applyMainPort` 先 `release(oldPort)` 再 `try{register(new)}catch{log}` 后**无条件** `config.targetPort=newPort`。
  若 register 因端口被其它 system: 角色占用而抛错 → 注册表**无 dsh-main 记录**，而配置已改 → 两者分叉。
- **修复**：改为「先 register 新、成功后才 release 旧」；register 失败则保留旧端口并 `return false`，配置不变。

**2.5 `claimSlot` 双分配竞态窗口（加固）**

- 证据：`claimSlot` 的 `tryClaim` 内 `await isTaken`（异步探测）**不在分配互斥内**；`_allocLock` 只保护 `_allocFree`。
  理论窗口：两并发 claimSlot（异 owner）都读到空闲 → 双分配。
- **修复**：整个「探测→登记」决策置于单一 `_allocLock` 下（抽出 `_claimSlotLocked` + `_allocFreeCore`，消除重入）。
- **实测**：10 并发 claimSlot → 10 个唯一端口（无重复）；超容量 → 显式 `pool-full`。
- 说明：隔离实测旧代码在该并发度下也得到 10 唯一端口（窗口窄），但加锁消除了 check-then-act 窗口，属正确的健壮性加固。

### 🟡 P2 — 语义一致性（已修其一）

**2.6 `/events` 降级路径过滤顺序不一致**

- 证据：`api/lifecycle.js` hub 路径用 `readVisible`（先过滤 internal 再取尾）；**降级路径**（hub 未启用）用 `readSince(after, limit)` 先切 500 再过滤 → 内部事件（shadow_* 每拍产生）可能挤空业务事件窗口。
- **修复**：降级路径放大窗口 → 过滤 internal → 再取尾，与 hub 路径语义一致。

---

## 3. 已确认但未改（记录在案，非本轮目标）

| # | 位置 | 现象 | 判定 |
|---|---|---|---|
| 3.1 | `types.ts` `RouterStatus.conflict` | 前端读 `r?.conflict` 渲染「端口被占」，后端 routerStatus/router.status **从不返回** conflict → 死分支 | 无害；建议删前端分支或后端补语义 |
| 3.2 | `AboutCard` 初始 `guardVersion()` | GET 是本地视图（updateAvailable 恒 false）；只有点「检查更新」走 selfUpdateStatus 才准 | **设计如此**（前端注释明示：本地视图不查网）；非缺陷 |
| 3.3 | `supervisor.js` `_mSetRestartCount/CrashWindow*` | 经 `_mField` 改内存但 registry `_save` 不持久化这些字段；仅 state.json 持久化 | 双副本，loadState 从 state.json 恢复；当前路径一致，但注释「目录持久化」对此不实 |
| 3.4 | `ports.js` `RANGES` 兼容导出 | 供旧调用方，src 内已无消费者 | 兼容保留 |
| 3.5 | `daemon-lifecycle.js` `_stopping` | stop() 后置 true 且不重置；实例缓存 → 不可恢复 | 当前仅 shutdownAll 调用，影响有限 |
| 3.6 | `daemon-lifecycle.js` `superviseOnce` | 无调用方 | 死代码 |
| 3.7 | `native/manager.js` 头注释 | 写 `upgrading` 状态，代码实际用 `restarting` | 文档漂移 |
| 3.8 | `loghub` watermark | appendRaw 吞写错误仍返回 seq → 水位推进过快（E1） | 低概率（磁盘满）；retry 契约名存实亡 |

---

## 4. 数据流自洽性验证（正向确认）

| 层 | 机制 | 结论 |
|---|---|---|
| 单一数据源 | 后端 API 是唯一事实源；前端 store 只读快照 | ✅ |
| 轮询 | `polling.ts` 2s `syncAll` 拉 7 端点 + 增量 events；in-flight 守卫防重叠 | ✅ |
| 事件游标 | `eventsSeq` + 按 seq 去重兜底；跨轮转/守卫重启连续 | ✅ |
| 写后刷新 | 所有写操作后 `store.refresh()` 立即同步 | ✅ |
| 快照覆盖 | 全页面消费字段都在 syncAll/refreshEvents 填充集内（含新增 `ports.capacity`） | ✅ |
| 状态机 | desired/guardian 正交：显式启停永不被守护开关短路；stop 不走 guardian 门 | ✅ |
| 端口池 | 池可配、选址避开 OS ephemeral、容量可观测、池满显式 ErrFull | ✅ |
| 日志单例 | LogCore 每进程唯一；异进程 init 拒绝 | ✅ |
| 升级状态机 | 所有分支可达终态；installing 标志每次出口重置 | ✅ |

---

## 5. 验证结果

| 验证项 | 结果 |
|---|---|
| `npm test`（31 文件） | **600 passed / 0 failed，EXIT=0** |
| `ui` typecheck | 通过 |
| `ui` lint | 通过 |
| `ui` test | 8/8 通过 |
| 并发端口分配 | 10 并发 → 10 唯一端口 |
| 端口池容量 | 200 供应商连续分配成功；池满显式错误 |
| p2p-api 契约 | 34/34（含新增删除前/后双向端口断言） |

本轮改动：22 个文件，+392/−142（内核 15 + 前端 4 + 测试 2 + 发布脚本 6 的延续）。

---

## 6. 最终结论

**内核与前端作为一个整体，逻辑自洽性成立。**

- **无硬断线**：75 条后端路由与前端 client 全量对齐，零孤儿调用；页面消费的每个快照字段都有后端生产者。
- **数据流单向且无第二事实源**：后端→store→render，写后 refresh，事件游标防重。
- **本轮修复的都是「边角真实缺陷」**：一个前端空指针崩溃、三处端口登记泄漏/分叉、一处事件过滤语义不一致、一处竞态加固。
- **初版剩余项（类型漂移/死代码/双副本/水位）已在第 7 节全部清理、纠正、接线——不含未决风险。**

**边界清晰**：内核+前端闭环自洽，桌面壳是外置引导器，二者通过「内核 HTTP API + 静态产物托管」这一稳定契约交互，互不侵入。
## 7. 剩余项风险清理（2026-09 后续补做）

报告初版第 3 节列出的 8 项「低风险风险」，随后已**全部清理/纠正/接线**——不留任何已知架构债：

| # | 原风险 | 处置 | 验证 |
|---|---|---|---|
| 3.1 | RouterStatus.conflict 死分支 | **删除**前端「端口被占」分支 + 类型字段（后端从不产出） | typecheck 通过 |
| 3.2 | AboutCard 概览恒不显示「可更新」 | **纠正**：挂载后后台权威检查一次；本地 GET 仍即时展示 | typecheck 通过 |
| 3.3 | restartCount/crashWindow 双副本 | **归一**：纳入 registry 持久化，_mField 写后落盘目录；state.json 降为投影 | managed-registry 26/26、core 39/39 |
| 3.4 | RANGES 死兼容导出 | **删除**（src 内无消费者），保留 DEFAULT_POOLS/SEGMENT_POOL | ports 17/17、capacity 18/18 |
| 3.5 | DaemonLifecycle._stopping 不可恢复 | **纠正**：stop() 结束复位 _stopping=false + 清 spawn latch，实例可复用 | daemon-lifecycle 14/14 |
| 3.6 | superviseOnce 死代码 | **接线**：抽出无副作用 classify()，生产 _daemonSuperviseOnce 用其识别「外部/异代际 daemon」 | daemon-lifecycle 14/14 |
| 3.7 | native manager 头注释 upgraded 漂移 | **纠正**注释（代码用 restarting/verifying；upgrading 不存在） | syntax 通过 |
| 3.8 | loghub watermark 写失败仍推进 | **修正**：appendRaw 报告写盘失败；ingest/pushGuard 失败时不推进水位、下轮补齐 | loghub 19/19 |

**回归**：\`npm test\` 31 文件 600/0 通过、EXIT=0；UI typecheck/lint/test 全绿。

至此审计总结论更新为：**内核+前端整体无已知 P0/P1 未决项，8 项架构债全部清零**；仅剩的『设计使然/低价值清理』见第 3 节头部已删（不再有遗留风险项）。
