# DSHSup 项目全量理解报告 + 逻辑性审计报告

> 审计对象：/home/bowen/develop/plus（内核仓 dsh-supervisor-core，master 分支）
> 版本：0.1.2-BETA.7　审计方式：源码通读 + 5 路并行子审计 + 实机运行态取证 + 测试链实跑
> 结论摘要：**内核实属健康、可运行、测试链全绿（EXIT=0）；主要风险集中在发布产线断裂、文档漂移、少数功能性缺陷与若干结构性遗留。**

---

# 第一部分　理解报告：这个项目到底是什么

## 0. 一句话定位

DSHSup（dsh-supervisor）是一个**独立于 DeepSeek Harness 运行的系统级生命周期守卫进程**。它负责被监管目标（默认 dsh web）的**启动、存活探测、故障自动重启、期望状态调和、一键升级**，并在其上叠加了一整套运维能力：桌面面板、多沙箱实例、智能路由（多供应商 Key 轮换）、局域网/公网远程控制、插件管理、内核自更新。

它是一个**单机单例、无第三方运行时依赖（Node ≥18 仅用内置模块）**的守卫程序，通过 systemd user unit 常驻。

### 关键产品事实

| 维度 | 事实 |
|---|---|
| 发布形态 | **全平台 Node launcher**（esbuild CJS bundle + node 启动脚本 + ui-react/）。SEA 单文件已弃用（macOS 上游缺陷） |
| 许可 | 内核 UNLICENSED（闭源构建物）；桌面壳 MIT |
| 双仓拆分 | 核仓 wasi7mglns/dsh-supervisor-core（私有，本仓）+ 壳仓 wasi7mglns/dsh-supervisor-launcher（公开，Tauri 引导器） |
| npm 子包 | @dsh-sup/dsh-core-<os>-<arch>（linux-x64 / darwin-arm64 / darwin-x64 / win-x64，四平台已发布） |
| 桌面程序 | Tauri 壳（引导 Node 安装 → 拉起守卫 → 内嵌面板），**壳源码不在本仓** |
| 依赖 | dependencies: {}、devDependencies: {} —— 内核零第三方依赖 |

## 1. 进程与部署拓扑

    systemd user unit (dsh-supervisor.service)
      └─ node dsh-supervisor daemon              ← 守卫主进程（唯一监管者，单实例锁）
           ├─ spawn: dsh web --port 3080         ← 原生主 DSH（detached 进程组）
           ├─ spawn: router-daemon (detached)    ← 智能路由独立进程（43011 ctl / 43000+ 端点 / 41000+ 反代实例）
           ├─ spawn: lan-daemon    (detached)    ← 远程控制独立进程（43108 ctl / 40000+ relay 隧道）
           ├─ spawn: dsh-web@inst-* (systemd-run transient) ← 沙箱实例（各自独立 cgroup）
           └─ 内嵌 HTTP API :36360（被占自动 +1 顺延并持久化）

**核心设计原则（贯穿全代码）**：
- **期望状态语义**：desired: running|stopped 持久化于 state.json。stop 后守卫绝不自动拉起。
- **守护开关正交**：guardian（是否崩溃后自动拉起）与 desired（用户意图：运行/停止）是两条独立轴。显式启停永不被守护开关短路。
- **守卫退出不动 DSH**：守卫重启后读持久化状态幂等调和，绝不叠加双实例。
- **单一事实源**：令牌、端口、任务、注册机等均收敛到单点持有者。

## 2. 核心状态机（src/supervisor.js，3269 行，全项目心脏）

    状态：STOPPED / STARTING / RUNNING / RESTARTING / BACKOFF / OBSERVED
    收敛循环 _dshConverge()：
      探测(monitor.probe: L1 端口 + L2 HTTP)
      → 读 desired / guardian / upgradeHold / manualRestart / intents
      → 按相位决策动作（start / stop / adopt / adoptObserved / restart / enterRunning / none）
      → 执行 → 写 state.json

**关键行为**：
- **三层健康探测**：L0 进程存活 → L1 端口监听（在线判定）→ L2 GET healthUrl 2xx/401/403（健康判定）。httpProbeEnabled=false 退化为「端口在线即健康」。
- **假死识别**：进程/端口在但 HTTP 连续 failThreshold 次失败 → 判故障重启。
- **重启协议**：向进程组 SIGTERM → 宽限 stopGraceMs(10s) → SIGKILL → 等端口释放 → 重拉 → 端口+HTTP 通过才算 RUNNING。
- **崩溃循环保护**：crashWindowMs(10min) 内 ≥crashBurst(5) 次 → BACKOFF，指数退避 30s→60s→2m→5m→10m；窗口跨守卫重启持久化。
- **观测模式 OBSERVED**：desired=stopped 时发现无主运行实例 → 只观测展示，不强杀不拉起；点「启动」同一实例无缝转正。
- **端口运行时再推导**：配置端口无监听但受管 DSH 进程在跑（用户改了端口）→ 从 cmdline --port 更正五处注册（30s 节流）。
- **意图登记簿 IntentLedger**（src/guard/intent.js）：显式意图（start/restart/upgrade-resume）是一等公民状态，动作发生处 register、收敛点 consume，消除旧 _explicitAction 时间窗竞态（RC2 结构性修复）。
- **影子对比框架 G1–G5**：影子只「纯计算应然动作」并与实际迁移对比记账，零副作用；连续 5 拍零 diff 为切换门槛。**注意：这是渐进式迁移观测框架，G2「可逆运行时切换」从未落地为开关。**

## 3. 控制平面 v3（双层）

| 层 | 模块 | 职责 |
|---|---|---|
| **ManagedRegistry**（guard/lifecycle/objects.js） | 声明目录 | 记录「管家直接负责」对象的**应然+所有权**（desired/guardian/ports/root），实然只来自观测；heartbeat() 是唯一周期驱动源 |
| **LifecycleManager**（guard/lifecycle/index.js） | 统一启停视图 | 全模块 ManagedLifecycle 注册表；启停统一入口；stopAll 契约化排除 dsh |
| **adapters.js** | 翻译层 | 把 router/lan/instances/dsh/plugins 映射到统一抽象 |

managed-objects.json 实测内容（本机）：dsh:main(running)、router-daemon(running)、lan-daemon(stopped)、4 个 sandbox-instance。唯一心跳 registry.heartbeat(probeIntervalMs) 每拍驱动 dsh 收敛 + 节流驱动 router/lan daemon 监督 + 逐实例监督。

## 4. 各子系统速览

- **NativeManager**（guard/native/manager.js）：原生 DSH 的唯一管理门面。安装/升级/卸载/版本检测。升级「先停后装 → waitPortHealthy 验证 → 失败自动回滚旧版」。统一任务模型 + native-manifest.json 安装清单（卸载按清单清理，首装才认领 ~/.dsh 数据）。
- **InstanceManager**（domains/instance/index.js）：沙箱实例（systemd-run transient unit，独立 cgroup/HOME/依赖）。一实例一独立 DSH 安装（npm install -g --prefix）。仅 Linux+systemd 支持，非支持平台显式拒绝。
- **RouterService**（domains/router/）：智能路由。**无公用入口**——每个已激活供应商持有独立 API 端点（43000+ 段）。直连（API Key 池）/反代（一账号一实例，41000+ 段）两类供应商。账号状态机 registered→ready/frozen/limited/banned/discarded；SwitchEngine 只在同供应商内切 Key（绝不跨供应商 failover）；配额策略可插拔（window-usage / commandcode-billing）。daemon 独占写 providers.json，守卫经 ctl 转发。
- **LanManager + FrpManager**（domains/relay/）：远程控制。relay 隧道（40000+ 段）把 0.0.0.0:wanPort 转发到回环 DSH，并**改写 Origin/Referer 为回环权威**使 DSH 信任围栏放行（不改 DSH 源码）。lan-daemon 每 2s 轮询 lan-state.json diff 收敛。
- **PluginManager**（domains/plugin/）：插件安装/启停/卸载/更新，目标可为 native / all / 指定沙箱实例。安装走官方 dsh plugin CLI；启停走 cordis.patch.yml 热载。
- **DistributionManager**（domains/dist/）：全局镜像源配置（registry.json）+ 唯一 npm 安装执行器 runNpmInstall。自更新查询强制官方 registry。
- **平台抽象**（platform/）：三端（linux/darwin/win）同能力——pidlookup、进程组信号、autostart、notify、browser、capabilities 门。
- **日志/令牌/任务/端口**：LogCore 每进程唯一（logger/events/dshWriter/EventHub 单例）；DshTokenService 是全系统令牌唯一节点（内存态，onChange 广播）；TaskRegistry 统一作业模型（持久化历史，有界 200）；ports.js 分段注册表（relay 40000 / proxy 41000 / oauth 42000 / providerApi 43000），按 owner 分三文件防多写者互踩。

## 5. API 层与安全模型（src/api/）

- 按域拆分：tasks / lifecycle / native / guard / router / plugins / dist / instances / relay，每域 owns()+handle()，网关做安全门卫后分派。
- **三层安全模型**：
  1. **身份层**（identity.js，P0-1 修复）：唯一信任根 = req.socket.remoteAddress（OS 连接事实，不可伪造）。回环 / RFC1918 私有网段判定。**请求头 Host/Origin 绝不参与身份判定。**
  2. **CSRF 深化层**（originAllowed）：带 Origin 的写请求须与本服务同源端口。
  3. **访问密钥层**（apiAccessKey，可选）：非回环请求须带 Bearer / ?access_key=（常数时间比较）。
- 静态资源路径穿越防护、CSP/nosniff 头、统一异常边界（handler 同步抛错/Promise reject 兜底 500，绝不穿透为进程级 uncaughtException）。

## 6. 前端（ui/）

- React 19 + TS + Vite + Tailwind 4 + Radix，入口 main-supervisor.tsx → SupervisorApp。
- **单向数据流**：HTTP API → supervisorStore（单一快照，2s syncAll 并行拉 7 端点 + refreshEvents 增量）→ useSyncExternalStore → 页面只读渲染；写操作后 store.refresh()。
- 7 页懒加载分包：概览 / 实例 / 插件 / 路由 / 任务 / 远程 / 设置。
- 产物单一源码双出口：ui/ → 构建 → ui-react/（守卫托管）。

## 7. 发布/测试工程

- **唯一正确产线 = release/scripts/ci-core.sh**：verify:versions → build-ui → npm test → build:launcher → 子包 dry-run/--publish。.github/workflows/build.yml 是薄壳，4 平台矩阵各调它。
- build-ui.sh → ui/dist → ui-react/；build-launcher.sh（esbuild bundle + 启动脚本 + self-check/fresh-HOME/UI 冒烟）；publish-core.sh（按平台组装 npm 子包）。
- 测试：42 个 test 文件，npm test 链 34 个（真实 spawn mock 进程，**零真实 npm/外网**）。

---

# 第二部分　审计报告

## 0. 实测基线（本机真实取证）

| 项目 | 结果 |
|---|---|
| npm test（串行） | **EXIT=0，全绿**（此前 2 处 FAIL 是 UI 产物未构建 + 两次并发跑抢固定端口所致，非代码缺陷） |
| ui/ npm run build | 成功（npm ci 可用，ui/package-lock.json **确实存在**——某子审计的「无 lockfile」结论有误） |
| bin/dsh-supervisor --version | v0.1.2-BETA.7；self-check: OK |
| 运行中守卫（pid 1483） | phase=RUNNING、dshPid=4397、apiPort=**36361**（36360 被占自动顺延并持久化——避让机制生效） |
| 运行中子进程 | router-daemon(43011)、relay(40000/40001)、反代(41007)、dsh(3080)、GUI(3085) 均在线 |
| /lifecycle/status | 5 模块注册，router running，daemon 模式生效 |

**架构可信度结论**：内核本体健康、结构成熟（单点收敛、原子落盘、幂等调和、跨平台修复到位）。

---

## 1. 缺陷分级清单

### P0 — 功能性断裂（用户可直接触达）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| **P0-1** | **CLI start/stop/restart 全部 404** | bin/dsh-supervisor:278 apiRequest('POST','/'+action) 打向 /start；但 src/api/lifecycle.js:6,149 已删该路由，唯一入口是 /lifecycle/dsh/{action}。**实测 POST /start → 404，POST /lifecycle/dsh/restart → 200** | README 与 usage() 宣传的命令全部不可用 |
| **P0-2** | **npm run release:core / release:core:publish 必失败** | release/scripts/release-core.sh:30 调 npm run build:sea，但 package.json 已无该脚本（build:launcher 才是）。bump.sh:27 同病 | 一键发布编排彻底断裂（CI 走的 ci-core.sh 正确，不受影响） |
| **P0-3** | **插件安装到指定沙箱实例不可用** | PluginsPage.tsx:183 发送目标 "id:"+instId；后端 plugins.js:100-113 resolveTargets 只认 native/all/裸实例id，**不剥 id: 前缀** | 面板「安装到某实例」必然报「指定实例不存在」 |
| **P0-4** | **export:shell / release.sh 引用不存在的 src-tauri/** | export-shell.sh 全程 cp src-tauri/*；release.sh:21 cp src-tauri/icons。双仓拆分后本仓已无 src-tauri | 这两个脚本在本仓必失败（应标注存档/移出可执行集） |

### P1 — 较高风险 / 功能性降级

| # | 缺陷 | 证据 |
|---|---|---|
| **P1-1** | **RouterPage 降级响应整页崩溃** | RouterPage.tsx:88-91 读 r?.usage.requests；后端 supervisor.js:756-763 失败时返回 200 {running:false,error} **无 usage** → .requests 抛 TypeError。应 r?.usage?.requests |
| **P1-2** | **daemon-lifecycle 测试偶发 FAIL** | reclaimOrphans 用 cmdMark+config 精确匹配；测试造的「孤儿」带不同 --marker，cfg 校验把它排除 → killed:0。首跑 13/1，重跑 14/0，**存在抖动** |
| **P1-3** | **frpc.toml 含明文 authToken 且未 chmod** | relay/frpmgr.js:127 写 toml 未设 0600（frp.json 有）；同机其它用户可读 FRP token |
| **P1-4** | **wanPort 缺失时生成 null localPort** | relay/frpmgr.js:113 只校验 frpEnabled && frpRemotePort，未校验 inst.wanPort → 写坏 config |
| **P1-5** | **日志/事件读路径 O(N) 无界** | loghub.js:293-366 / events.readAll 全量读+parse，/events、/logs/export、/metrics 随历史线性膨胀（轮转只限磁盘） |
| **P1-6** | **令牌恢复文件保留未脱敏 ?token= 原文** | token.js:112 注释自认；虽 0600，同机提权即泄露会话令牌 |

### P2 — 逻辑/健壮性缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| P2-1 | Key 分隔正则吃掉字母 s | RouterPage.tsx:320 split(/[,;s]+/) —— 字符类里 s 是字母不是空白；'sk-abc123sdef' 被切碎。应为 /[,;\s]+/ |
| P2-2 | FRP toggle API 存在但 UI 未接线 | 后端 relay.js:21 有 toggle，UI 无启停按钮 |
| P2-3 | dev 模式 API 全 404 | client.ts:8 称用 vite proxy，但 vite.config.ts 无 proxy 配置 |
| P2-4 | TasksPage 脱离状态中心、不自刷新 | TasksPage.tsx:16-32 自管 state + 手动刷新 |
| P2-5 | task-registry 持久化未重建运行索引 | tasks.js:_load 不重建 _current；log() 每行全量写盘 |
| P2-6 | 实例升级失败回滚路径无 try 包裹 | native/manager.js:_handleUpgradeFailure 回滚自身抛错可能卡 rolling_back |
| P2-7 | forward-core 空账号池仍走一次 body | forward-core.js:127 attempts=max(n,1) |
| P2-8 | rl/ctl.js:49 413 后未 res.end | 连接池残留半响应 |
| P2-9 | manager.js:385 空 inst 抛 TypeError | _handleRelayListenFail 用 inst.id 无保护 |
| P2-10 | _allocLock 自旋忙等污染事件循环 | ports.js:259/317 |
| P2-11 | 测试恒真断言 / 硬编码计数 | token-boundary:100 check(...,true)、managed-registry:133 passCount=26 硬编码、lan-daemon:164 \|\|true |
| P2-12 | sigterm-desired-test.js 游离测试链外 | 无 test:* 脚本、无政策说明，P1-4 契约门从不自动跑 |
| P2-13 | RegistryCard 直连 fetch 与壳内 CSP 冲突 | RegistryCard.tsx:159 跨源 ping，壳 connect-src 'self' 拦截 |

### P3 — 卫生/一致性/死代码

- 死导出：Progress/Spinner/Dialog* 子件、classifyUpstreamLimited、lc_status 别名、_mainUnit() 恒 null。
- UI 残留旧产品名 skiff（SupervisorApp/nav 注释与变量）。
- PortPanel owner 猜测用 maskedKey.endsWith 基本配不中；硬过滤 3100/3101。
- client.ts 的 providerKeyUse 用 keyId 当 fingerprint 字段名。
- 大量 UI 原生 confirm 与 Radix Dialog 风格不统一。
- log.js 0600 权限仅首次创建生效（历史 0644 文件不迁移）。
- autostart.js Windows on=on||watchdog 语义不对称。
- capabilities() 档位（autostart/notify/processTreeKill）多数未接线到决策。
- 守卫 statusSummary 对 observedOnly 进程仍展示 pid。

---

## 2. 结构性/架构性观察（非 bug，但影响可维护性）

1. **三份拓扑文档与代码漂移**：README.md 是多代混合文档——同时写「桌面壳（Tauri）在本仓」（第 40、235-250 行）与「双仓已拆」（第 42-55 行），且残留 build:sea、src-tauri/、scripts/ 旧引用；DESIGN.md 被 .gitignore 且不存在却被多处引用。
2. **单实例锁路径不一致（CLI 与 daemon）**：CLI readApiAddress 走 findConfigPath()（遵守 -c），但 STATE_FILE 常量硬编码在默认 ~/.dsh/supervisor/state.json，且默认 apiPort 写 36360（与内核 DEFAULTS 一致，但 README 仍写 3100）。
3. **router 内嵌副本未摘除**：daemon 模式守卫仍持有一份完整 RouterService（只 setPersistEnabled(false)），作为 ctl 失败时的 local() 应急视图（标 _stale）。
4. **ctl 端口双轨**：守卫侧 _daemonLifecycle 用 43011（业务口）做 daemon 存活判定，而 EventHub 与 _lanCtlCall 用 43107/43108（ctl 口）；实测运行 daemon 只监听 43011，导致 guard.log 每 30s 刷 router-daemon eventsTail 不可用: ECONNREFUSED 127.0.0.1:43107。**daemon 事件聚合实际未生效**（守卫侧仍可经内嵌副本供数，功能不崩但聚合通道断）。
5. **G1–G5 影子框架**：连贯自洽但从未落地为可逆运行时开关，属渐进迁移观测。
6. **文档漂移**：release/runbooks/*.md 仍写 build:sea、面板 3100、selfUpdateManifestUrl、壳版本 0.1.0；CHANGELOG 最新版后仍有 4 处 [未发布] 残留。
7. **npm 版本墓碑**：.darm-fail.log 显示 E403 You cannot publish over the previously published versions: 0.1.2-BETA.7；重发需析新版本号。
8. **历史遗留风险（未关闭）**：CHANGELOG 记「守卫内嵌 router 陈旧副本仍可能兜底外供」「lan-daemon 慢性重启致远程控制周期性掉线」——后者在实测中 lan-daemon 当前为 stopped（desired=stopped），未复现。

---

## 3. 安全评估

| 维度 | 结论 |
|---|---|
| 身份信任根 | ✅ 已修复为 socket 事实（P0-1），Host/Origin 不参与身份判定 |
| CSRF | ✅ Origin 同源校验覆盖所有写路由 |
| 访问密钥 | ✅ 常数时间比较、非回环门卫、OPTIONS 豁免 |
| 命令注入 | ✅ 插件 CLI 参数 _assertSafeCliArgs 拦截 - 开头；反代密钥只经 env，不进 cmdline |
| 路径穿越 | ✅ 静态资源 path.relative 校验；tar 解包防穿越 |
| 凭证落盘 | ⚠️ token.js 恢复文件含未脱敏 ?token=（0600）；frpc.toml 含明文 FRP token 未 chmod |
| 自更新信任根 | ⚠️ self-update.js manifest URL 仅校验 http(s)，sha256 来自同一 manifest（HTTP 下 MITM 可换）；应强制 https |
| 局域网暴露 | ✅ 默认只绑回环；0.0.0.0 需显式开关 + 可选 apiAccessKey |

---

## 4. 测试与发布工程评估

- **测试质量整体高**：真实 spawn mock 进程（smoke/upgrade/api-fuzz/p2p-router/reconcile/daemon-lifecycle/lan-daemon 等），**零真实 npm/外网**，离线可跑。npm test 串行 EXIT=0。
- **覆盖缺口**：68 个 src/*.js 仅约 24 个被直接 require；api/{guard,identity,instances,native,plugins,relay,tasks,dist}、guard/{health,host-service,intent,guardian,monitor}、platform/{deploy,exec,fs-utils,token,os/*}、domains/relay/{manager,daemon}、plugin/pluginmarket 等无单元级覆盖（多经 supervisor 集成间接覆盖）。
- **政策排除（不自动跑）**：native-test、api-contract-test、plugin-change-restart-test（_uninstallTests 政策，合理）。
- **发布产线**：ci-core.sh 正确且与 workflow 一致；release-core.sh（P0-2）、export-shell.sh/release.sh/verify-versions --shell/bump.sh --shell（P0-4）因双仓拆分未同步而失效。
- **CI 次要问题**：upload-artifact 含从不生成的 dist/launcher/README.md；4 平台 job 同 tag 追加 Release 未拆分；build job Node 24 vs ui-verify Node 22 不一致。

---

## 5. 优先级修复建议（按投入产出）

1. **P0-1**：bin/dsh-supervisor cmdControl 改打 /lifecycle/dsh/<action>（或恢复兼容路由）。
2. **P0-2**：release-core.sh:30 与 bump.sh:27 的 build:sea → build:launcher，与 ci-core.sh 对齐。
3. **P0-3**：前端去掉 id: 前缀，或后端 resolveTargets 兼容剥前缀。
4. **P0-4**：export-shell.sh / release.sh 标存档或移除 src-tauri 依赖。
5. **P1-1**：RouterPage 可选链补一层（r?.usage?.xxx）或后端补 usage 空壳；顺手修 P2-1 正则。
6. **P1-3**：frpc.toml 写后 chmod 0600；自更新强制 https。
7. **文档**：重写 README / runbooks 为 launcher 形态 + 36360 端口 + D1 现状；补 DESIGN.md 或移除引用。
8. **P1-2/ctl 双轨**：统一 daemon ctl 端口（43011 业务口 vs 43107 ctl 口），恢复 EventHub 的 daemon 事件聚合。

---

# 第三部分　总体结论

**DSHSup 是一个工程成熟度相当高的系统级守护程序。** 它把「生命周期守卫」这一件事做到了纵深：状态机语义清晰、单一事实源收敛、原子落盘、幂等调和、跨三平台、零第三方依赖、真实 mock 的回归测试链全绿，并且已经历过一轮系统性的 P0–P3 结构修复（identity 信任根、意图登记簿、异常边界、任务执行器归一）。

**当前的问题不是「内核坏了」，而是「拆分与演进留下的接缝」**：双仓拆分导致发布脚本与文档大面积漂移（P0-2/P0-4）、一次 API 路由收敛留下 CLI 死路由（P0-1）、前后端一处契约前缀不一致（P0-3）、以及少量前端可选链与测试抖动。这些都属于**低修复成本、高用户可感知**的缺陷，建议优先清理。

**结构性遗留**（router 内嵌副本、ctl 端口双轨、G1–G5 未完成切换、E2E 聚合通道断）不阻塞功能，但应在下一轮架构收敛中处理。
