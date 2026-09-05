# 中间层结构盘点：健康/端口/状态机/守护 的割裂-重复-空转全图（2026-09-05）

> 方法：3 路并行子代理（状态持有拓扑 / 观测循环重复 / 前端数据源割裂）+ 一手代码交叉验证。
> 只读，未改代码。目标：理顺中间层（健康管理/端口管理/统一状态机/守护/任务/事件），找割裂/重复/空转。

---

## 1. 中间层"状态持有者"全图

| 状态面 | 事实源 | 持久化 | 写者 | 进统一状态机 |
|---|---|---|---|---|
| DSH 主程序 | 守卫自身 this.*（16 字段） | state.json | 守卫 tick | ✅ dsh 项（被动镜像） |
| 沙箱实例 | InstanceManager.instances[] | instances.json | instance watchdog | ✅ instances 项（注册未喂） |
| router-daemon 进程 | 守卫探测 | — | 守卫 supervise | ✅ router 项 |
| router 内部（账号/反代实例） | router-daemon RouterService | providers.json | router-daemon | ❌ 黑盒不进 |
| lan-daemon 进程 | 守卫探测 | — | 守卫 supervise | ❌ 应注册未注册 |
| relay/frp | lan-daemon LanManager | frp.json + ports-lan.json | lan-daemon | ❌ |
| 端口绑定 | infra/ports | ports*.json（按 owner 分） | 各 owner | ❌ 注册表非状态机 |
| 插件 | PluginManager | 插件自身 | plugin | ✅ plugins 项（status null） |
| 令牌/任务 | 内存/registry | 不落盘/tasks.json | 各 owner | ❌ |

## 2. 割裂（同一事实多源/多份拷贝）

### 2.1 最大：router 业务双持有点
真源 = router-daemon RouterService（独占写 providers.json）。守卫内嵌第二份完整拷贝（supervisor.js:120 同 providerFile 构造），daemon 在线禁写但仍作 local() 应急源 + lifecycle 执行器。PHASE3 只加 stale 标注，副本未摘除。

### 2.2 DSH 状态双出口
守卫 16 字段与状态机 dsh 项 10 字段平行（phase/desired/restartCount/lastProbeAt 重叠），dsh detail=statusSummary → /status 与 /lifecycle/dsh 同一状态双出口，前端走 /status。

### 2.3 relay wanPort 三处描述
lan-daemon 内存 + inst.wanPort（instances.json）+ ports-lan.json——有意可恢复设计但写路径多。

### 2.4 端口活性两套 TCP
/ports 与 /router/ports 各自探测同一 4100x，因分域前端只拿守卫段（接线断，router 段丢）。

## 3. 重复（同功能多套/并行观测）

### 3.1 工具层无重复（健康）
infra/probe（L1 TCP/L2 HTTP）+ domain/monitor（probe/probeInstance）是全系统唯一探测实现，8 循环全复用 ✅。

### 3.2 观测循环并行（同对象多触发方）
| 循环 | 周期 | 对象 | 判据 |
|---|---|---|---|
| supervisor tick | 5s | DSH main | monitor.probe |
| instance tick | 5s | 沙箱实例 | monitor.probeInstance |
| lan-daemon reconcile | 2s | 同一批沙箱实例 | monitor.probeInstance（并行） |
| router monitorLifecycle | 30s | 反代实例 | pid+HTTP |
| router _probeAccountStates | 10s+5min | 账号额度 | billing |
| 守卫 _superviseTimer | 30s | router/lan daemon 进程 | 端口+cmdline |

## 4. 空转（写了没人读/注册了没消费）——最严重

### 4.1 lan 幽灵逻辑（铁证）
- get lan() daemon 模式返回 null（supervisor.js:236）→ registerAll(lan:null) → adapters 跳过注册（日志实证"已注册: router,instances,dsh,plugins"）
- 但 _superviseLanDaemon 按"已注册"写完整代码：每 30s mirror("lan") + 读 guardian 开关 + restartCount 记账
- lifecycleManager.get("lan") 恒 null → mirror 静默丢弃、guardian 判断失效（永远走拉起分支）
- 守卫在管 lan-daemon 进程，状态机却无 lan 项

### 4.2 lifecycle detail 三处死回调（detail 恒 null）
| 位置 | 调用的方法 | 实际 |
|---|---|---|
| adapters.js:43 (router) | router.routerStatus() | 不存在（只有 status()）→ null |
| adapters.js:77 (instances) | instances.summary() | 不存在 → null |
| adapters.js:113 (plugins) | status: () => null | 恒 null |

### 4.3 instances 注册从不喂
mirror 只覆盖 dsh/router/lan，无 instances；实例项 healthy 恒 false（实际有实例在跑）。

### 4.4 main(DSH) 守护不经状态机
守卫 tick 内联探测 → _beginRestart（L1443-1465），不经 lifecycle；dsh 项只是被动镜像。

## 5. 收的方法问题

当前收法 = 守卫主动探测 + 守卫判 ok/error + _mirrorHealth 覆盖写 phase/healthy：
- 判定权在守卫，不在资源自报（违反"只收状态不判业务"）
- phase 被守卫按 desired 强制覆盖为 running（非资源真实 phase）
- 只收 {ok:boolean}，丢中间态（installing/frozen/backoff...）
- lan/instances 连这条被动收法都断着

正确收法方向：资源自报真实状态（router 报 providers、lan-daemon ctl list()、实例 list()），守卫只收口；detail 接真实自报方法。

## 6. 目标拓扑（理顺后）

资源自报层 → 收口层(统一状态机 LifecycleManager) → 消费层(前端 /lifecycle + 守护策略同源决策)；端口注册表独立(按 owner 分文件) → /ports + /router/ports 前端合并。

**理顺三层动作**：1) 补收口断点（lan 注册/instances 喂入/detail 死回调）2) 去双份（守卫内嵌副本、DSH 双出口）3) 前端接统一出口（/lifecycle + /router/ports 接回 PortPanel）。

## 7. 事实源干净（不用动）
令牌（内存唯一）、端口注册表（S1-S5 单写）、任务/registry/native-manifest、probe/monitor 工具层。

---
*只读盘点。详细拓扑见 .dsh/state-topology-audit.md（子代理存档）。*