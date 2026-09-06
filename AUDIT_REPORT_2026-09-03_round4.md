# dsh-supervisor / skiff-original 全仓认知理解与综合深度审计报告

> 审计范围：`/home/bowen/develop/plus` 下的 dsh-supervisor（Node 守卫核心 + Rust Tauri 壳）与 skiff-original（React 面板源码）。
> 审计方式：**逐文件直读**（src 全量 ~48 文件 + bin + ui-react 镜像 + skiff-original/src 全量 + src-tauri/src + test + scripts），辅以跨模块 grep 实证、node --check 全量语法检查、npm test 全链实测。
> 审计时间：2026-09-03。**纯只读审计，未修改任何源文件**（仅新建本报告文件）。
> **⚠️ 2026-09-06 更名/布局补注**：本文写作时的前端源码目录 `skiff-original/` 已于 2026-09-06 迁至 `dsh-supervisor/ui/`（`git mv`，历史 100% 保留）。文内所有 "skiff-original" 均指该前端源码目录，现路径为 `dsh-supervisor/ui/`；`ui-react/` 仍为构建产物镜像（release.sh 从 `ui/` 构建）。

## 0. 执行摘要（TL;DR）

项目 = DSH 生命周期守卫 + 多域运维面板（零依赖 Node 单体 + Tauri 壳 + React 面板三件套）。**总体架构质量显著高于同类零依赖单体**：controller 状态机、清晰分层、平台抽象、统一任务注册表、唯一令牌节点、端口注册表单一事实源、安全设计有意识；注释详实、常带历史缺陷复盘；经历过至少三轮架构审计与修复，绝大多数高危已闭环。但仍有问题残留（详见第 1-3 章，均带位置/证据）。

| # | 级 | 问题 | 影响 |
|---|---|---|---|
| 1 | 橙/中 | React 面板事件轮询 in-flight 竞态复发（polling.ts refreshEvents 无守卫） | 慢网下同批事件双插重复 |
| 2 | 橙/中 | relay 状态轮询放大同步阻塞：/instances 与 /lan-access 每 2s 各自 reconcile+probeInstance+全 /proc fd 扫描 | 事件循环被挤占 |
| 3 | 橙/中 | 反代 stopInstance SIGKILL 兜底仍裸 setTimeout（无 exit 驱动收敛，frpmgr 已修但 proxy 未同步） | EADDRINUSE 残余窗口 |
| 4 | 橙/低中 | api.js:639 死三元 `send(r.ok ? 200 : 200, r)` | 恒 200，语义误导 |
| 5 | 橙/低中 | proxy.js:24 lastPicked 死字段 + 若干注释残迹 | 审计噪音 |
| 6 | 橙/低中 | deserialize 未归一 nextResetAt（历史 ISO 字符串残留会 NaN） | 到点不探测 |
| 7 | 黄/低 | 重复实现：maskKey ×2、pluginmarket getJson/getText、relay 降级 catch 复制转发约 25 行 | 维护双份易漂移 |
| 8 | 黄/低 | 同步子进程散布：token journalctl execFileSync、systemctl/autostart 等 | 阻塞事件循环 |
| 9 | 黄/低 | 嵌套 git 仓误导 guardVersionLocal commit（8867942 固定 vs 真实 HEAD 66174ed） | UI 版本显示失真 |
| 10 | 黄/低 | 工作区根零字节杂物文件 | 仓库卫生 |

**分层评价**：infra A- > api B+ > domain/native/instance/plugin B+ > router B > relay/frp B- > Tauri 壳 A- > React 面板 B+ > 测试 B+（14 套件全绿，前端零测试）。

## 1. 架构认知（整体图景）

### 1.1 仓库拓扑（重要事实）

| 目录 | 角色 | 说明 |
|---|---|---|
| dsh-supervisor/ | 内核仓库 | 同时是外层 git 仓（HEAD 66174ed + 54M/11D/32?? 工作区）的目标 |
| dsh-supervisor/.git | 嵌套 git 仓 | 仅 1 提交 8867942（早期快照），与工作区内容严重脱节 |
| skiff-original/ | React 面板源码（独立构建） | 无 .git；构建产物 → ui-react/ 镜像 + dist/ |
| ui-react/ | 面板构建产物镜像 | 守卫 :3100 直接托管 supervisor.html + assets/ |
| src-tauri/ | Tauri 壳（Rust，开源 MIT） | 探测 Node → 定位/拉起内核 SEA → 面板；版本双轨 |

关键推论：守卫实际运行的是外层仓跟踪的工作区源码；嵌套仓只是早期快照 → guardVersionLocal / self-update 的 git 视角都读它 → UI 版本/commit 展示有误导风险（见 2.11）。

### 1.2 逻辑架构（数据流 + 控制流）

`src-tauri(壳) --spawn--> Supervisor(supervisor.js 状态机) --new--> infra / domain / system-services / presentation`

- infra：config/log/event-bus/ports/probe/platform/task-registry/version/env-catalog/fs-utils（无业务地基）
- domain：native（原生生命周期/升级卸载）/dist（统一分发/镜像/安装执行器）/instance（沙箱 systemd）/plugin/pluginmarket/token（唯一令牌节点）/guardian（退避纯函数）/monitor（统一探测）
- system-services：router（直连/反代供应商+账号状态机+转发+切换）；relay/frp（远程控制）
- presentation/api.js：本地 HTTP API + 面板静态托管 + 安全门卫
- 数据事实源收敛：TaskRegistry 唯一任务历史；DshTokenService 唯一令牌；ports.json 唯一端口登记；dist 唯一镜像源/安装执行器；instances.json/providers.json 唯一配置。

### 1.3 程序架构（关键对象关系）

Supervisor 构造时 new：Events/createLogger/DshTokenService/DistributionManager/TaskRegistry/RouterService/InstanceManager/LanManager/PluginManager/PluginMarket/NativeManager/Lifecycle/Health/HostService/ports.configureFile；并注入 dshBin/tokenService/tasks/onRemoteChange/onInstanceStart 等回调实现桥接。RouterService 经 Object.assign 混入 forward-core 与 aux 方法集；providers 继承 ProviderBase。api.js 只经 sup.* 门面取数（不直连 infra）。

### 1.4 面板-后端契约（逐端点核对）

client.ts 写端点与 api.js 路由一一对应；types.ts 与后端 2026-09 新投影（activeKeyId/locked/selected/nextResetAt/updateJob/lifecyclePhase）高度吻合；异步任务 202+{ok:true} 契约正确（前端只判 !res.ok，无老版 202 断裂）。instanceUpdate 仅暴露 guardian/remoteEnabled（后端还认 memoryMax/cpuQuota/remoteToken，UI 未给入口，非缺陷）。

### 1.5 壳-面板关系

main.rs 结构清晰：env 探测 → node 引导（下载/校验/安装 LTS）→ core_status → ensure_guard（定位 SEA、等端口 30s）→ navigate 面板；托盘直发本地 API；api_port/api_base_url 从用户 config 解析（不硬编码 3100）。质量 A-。

## 2. 深度审计发现（位置/证据/影响/建议）

### 2.1 [橙/中] React 面板事件轮询 in-flight 竞态复发

- 位置：skiff-original/src/services/supervisor/polling.ts refreshEvents（无 busy 守卫）；start() 每 2s 同时调 refreshEvents + syncAll。
- 证据：旧 vanilla UI 曾修同类缺陷（加 evFetching 去重），React 重写未继承。慢网下两次 refreshEvents 携同一 eventsSeq 并发 → 各 reverse+concat 同批增量 → 双插。
- 建议：refreshEvents 加 in-flight 去重，渲染层按 seq 去重。

### 2.2 [橙/中] relay 状态轮询放大同步阻塞

- 位置：relay/manager.js list() 每调用先 reconcile（同步 probeInstance）；instance list() 每 2s 全 /proc fd 扫描；api /instances、/lan-access 每 2s 被前端拉；PortPanel 另 5s 轮询 /ports。
- 证据：polling.ts 每 2s Promise.all 拉 /instances + /lan-access；两者服务端各自全量 pidlook.findListeningPid（/proc 逐 fd readlink，Linux O(PxF)）。
- 建议：聚合 /instances+/lan-access 单端点；findListeningPid 加 1s TTL；PortPanel 并入 2s 快照。

### 2.3 [橙/中] 反代 stopInstance 仍裸 setTimeout SIGKILL

- 位置：providers/proxy.js stopInstance（SIGTERM → 1500ms 后 SIGKILL，无 exit 收敛）；frpmgr.js stop 已改 exit 事件驱动（注释明确 child.killed 语义），proxy 未同步该修法。
- 影响：端口释放窗口内新 start 仍可能撞未退进程（_doStart 的 ≤3s isTaken 轮询是缓解非根除）。
- 建议：stopInstance 捕获 child 并监听 exit 完成清理（对齐 frpmgr）。

### 2.4 [橙/低中] api.js:639 死三元 `send(r.ok ? 200 : 200, r)`

恒 200，语义误导。应去三元并统一 200（若想表达降级需真正区分）。

### 2.5 [橙/低中] 路由子系统残迹

| 位置 | 内容 | 性质 |
|---|---|---|
| providers/proxy.js:24 | `this.lastPicked = null;` | 死字段（全仓唯一引用） |
| instances/proxy-instance.js:64-71 | freeze/unfreeze 仅测试用 | 有意保留，已注释 |
| aux.js switchToKey → setSelectedProxyKey | 纯别名（临时切换与显式锁定同语义） | 双入口易混淆 |

### 2.6 [橙/低中] deserialize 未归一 nextResetAt

- detect 落库前 normalizeResetTs 已做；但 router/index.js _deserializeProvider 直接赋 a.nextResetAt（无归一）。历史 providers.json 若残留 ISO 字符串 nextResetAt（旧 bug 已写盘数据），load 后数值比较 NaN → 到点不探测。
- 建议：deserialize/load 时统一 normalizeResetTs(acc.nextResetAt)。

### 2.7 [橙/低] relay/index.js 降级 catch 复制转发逻辑

主 HTTP 转发与 mergedCookieHeaders().catch 降级分支各写一份完整 headers 改写 + upstream + HTML 注入（约 25 行重复）。建议抽公共函数。

### 2.8 [黄] 重复实现清单

- maskKey ×2（providers/base.js:46 与 forward-core.js:13）
- pluginmarket getJson 与 getText 大段雷同（上限/重定向/超时）
- 端口探测四处（probe.portListening / pidlookup / ports.isTaken / dist.waitPortHealthy 内联）
- 事件类型 EVENT_LABELS（nav.ts）与后端无自动同步（手工维护）

### 2.9 [黄] 同步子进程/IO 未统一收口

- token capture → execFileSync journalctl（沙箱进入 RUNNING 后 scheduleCapture 6 次退避全同步）；autostart/pidlookup mac-win/systemctl stop 全 execFileSync。频率低可接受，但 token 回填在实例多时周期性阻塞。

### 2.10 [黄] frpc.toml 写后未 chmod 600

- frpmgr saveSettings 有 600，但 buildConfig→syncFromInstances 直写 configFile 未 chmod（frpc.toml 含 frps auth.token 明文，默认 umask 022 → 0644）。建议写后 chmod 600。

### 2.11 [黄] 嵌套 git 仓误导版本展示

- guardVersionLocal 在 dsh-supervisor/.git（单提交快照）上 rev-parse → commit=8867942 恒不变，与真实工作区（外层 66174ed）脱节。

### 2.12 [黄] 前端若干小项

- OverviewPage EventLogPanel 依赖 events 数组身份重置分页（useEffect [events]）→ 每 2s 轮询快照更新后已展开条数被重置到 12。
- polling.ts syncAll 内 tasks 单独 then setPartial → 每周期多一次额外 emit（渲染 2 次）。

### 2.13 [低] 文档漂移

- README「局域网访问 3088 + lanToken」为旧反代设计残留（现行 relay 40000+ 段，README 对应段已过时）；ui-redesign-plan 顶部已标注取代 ✓。

## 3. 关联关系核查结论（关键交叉验证）

| 断言 | 结论 |
|---|---|
| 守卫 spawn 主 DSH 只用 stdout 令牌（D3-A） | ✓ token attach('main',{}) 无 unit；_startProcess feedLine stdout |
| 先停后装完整等待 | ✓ _enterUpgradeHoldAsync 先捕获 refs 再停、等 exit/超时 |
| 冻结恢复调度按 nextResetAt 精确触发+1h 兜底 | ✓ _probeAccountStatesIfDue 双触发 |
| 平台能力门三端 | ✓ capabilities() 实测覆写；sandboxSupported 门 |
| 守卫自更新通道与 D1 收敛一致 | ✓ selfUpdateManifestUrl 默认 null，面板报「未配置源」明确错误 |
| TaskRegistry 唯一历史 + 旧字段兼容视图 | ✓ native/instance/plugin/router 旧字段保留为回退/兼容 |
| relay lanInstances 不落盘、inst.wanPort 持久化 | ✓ syncProxy 逻辑与注释一致 |
| provider 独立端点仅 activated 提供 | ✓ activate/deactivate + _startProviderServer |
| 转发按供应商作用域、不跨池 | ✓ pickFor/resolveTarget 只在本池 |
| token 永不出本机 | ✓ /instances authUrl 仅回环带 token；open-web 校验回环 |
| apiAccessKey 门卫位置 | ✓ createServer 每请求判 host→loopback→带 key 校验 |

## 4. 死代码/废弃/胶水清单（grep 实证）

| 位置 | 内容 | 证据 | 建议 |
|---|---|---|---|
| providers/proxy.js:24 | lastPicked | 全仓 0 引用 | 删 |
| infra/platform/index.js:34,120 | resetCapabilityProbes 导出 | 无外部调用 | 保留(测试)或删 |
| instance/index.js:185 | `installing: !res.ok ? false : true` | 等价 res.ok | 简化 |
| api.js:639 | `send(r.ok ? 200 : 200)` | 恒 200 | 去三元 |
| forward-core.js:13 vs base.js:46 | maskKey 双份 | 独立定义 | 收敛 |
| pluginmarket | getJson/getText 双份 | 大段雷同 | 抽公共 |
| relay/index.js | 降级 catch 复制转发 | ~25 行重复 | 抽函数 |
| task-registry cancel() | 无调用方 | 有意保留(API 面) | 可留 |
| switch.js switchToAccount | 无调用方 | 仅定义 1 处 | 删或内部化 |
| ProxyInstance freeze/unfreeze | 仅测试 | 注释已说明 | 保留标注 |

## 5. 模块评价与测试基线

| 模块 | 评级 | 优势 | 首要改进 |
|---|---|---|---|
| infra | A- | 原子写/0600/轮转/seq meta/端口 registry/纯函数 | 热路径 pid 缓存、同步子进程收口 |
| api.js | B+ | 路由门卫完备、静态资源安全、202 契约正确 | 死三元、README 漂移 |
| native/dist | B+ | 单通道升级回滚闭环、dataPaths 认领 | 回滚与主升级重复逻辑、waitPortHealthy 内联 |
| instance | B+ | systemd 隔离、状态机健壮、更新含回滚 | _updJobs 60s 清理竞态、同步 systemctl |
| plugin | B+ | 作用域锁/串行队列/CLI 注入防护 | getJson/getText 收敛 |
| router | B | 状态机/倒计时/端口绑死/usage 统计成熟 | lastPicked、deserialize 归一、注释残迹 |
| relay/frp | B- | 分层清晰、串行队列、exit 驱动 stop 已修 | 每 2s reconcile 放大、frpc.toml 权限、catch 复制 |
| Tauri 壳 | A- | env 引导完整、托盘直发、不硬编码 3100 | spawn 不持句柄(可接受) |
| React 面板 | B+ | 无 XSS、契约对齐、动作 hook 统一 | 事件竞态复发、分页重置 |
| 测试 | B+ | 14 套件全绿、契约/专用单测覆盖好 | 前端零测试 |

**实测基线**：node --check 全 src+bin 0 语法失败；npm test 14 文件 && 链全绿跑至末套件 guard-update（tail PASS U1/U2 等），无断点。

## 6. 修复路线图（建议优先级）

**P1**：1) 面板事件轮询去重（polling.ts + seq 渲染去重）；2) /instances+/lan-access 聚合 + probe TTL；3) proxy.stopInstance exit 驱动收敛；4) deserialize normalizeResetTs(nextResetAt)。
**P2**：5) 删 lastPicked、去 api 死三元、简化 installing 三元；6) maskKey/getJson/relay 转发抽公共；7) frpc.toml chmod 600；8) EventLogPanel 分页保持。
**P3**：9) 删根目录杂物文件；README 局域网描述同步；guardVersionLocal 去嵌套 git；10) 前端补最小轮询/契约测试。

**说明**：纯只读审计，未改动任何源文件（唯一新文件为本报告）。旧版 AUDIT_REPORT 绝大部分高危已在当前树验证修复；本报告聚焦现行代码仍存在的问题与设计性热点。
