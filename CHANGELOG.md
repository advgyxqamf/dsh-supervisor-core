# Changelog

本项目的全部重要变更记录于此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2-BETA.7]（2026-09-09）

### 双仓拆分定稿（2026-09-09）：壳/核彻底分离，发布永不错位
- 单仓 `lobbowen/dsh-supervisor` 拆为双仓并迁至账号 `wasi7mglns`：
  - **内核仓** `wasi7mglns/dsh-supervisor-core`（私有，本仓）：bin/src/ui/systemd/release + 文档，`npm` 子包发布产线
  - **壳仓** `wasi7mglns/dsh-supervisor-launcher`（公开）：src-tauri 引导器形态（MIT），GitHub 安装程序产线
- **核仓产线自足化**（本版本核心）：剥离壳依赖——`ci-core.sh` 移除壳前端组装/壳集成冒烟（归壳仓职责），步骤重排为 verify(--core)→npm test→build:launcher→子包发布；`build.yml` 去掉 Rust/cargo/apt 壳依赖步骤；`verify:versions` 仅校验内核 package.json 单源（壳版本互锁随壳仓剥离）。内核 launcher 为纯 JS（Node ≥18），无 Rust/系统库依赖。
- 壳仓首次 CI（launcher-build）产出 Linux 桌面安装程序 `.deb/.AppImage`——用户下载安装的桌面程序。

## [0.1.2-BETA.6]（2026-09-09）

### 跨平台架构整改：全平台弃 SEA 统一 Node launcher 发行形态
- Node SEA 在 macOS 上注入后段错误（最小 SEA 亦崩，铁证=上游缺陷）→ 全平台改发 Node launcher（esbuild bundle + bin 启动脚本），darwin/win/linux 统一可发布
- 修 4 处 Linux-only 假设：pgrep -af、macOS 无 timeout、SIGTERM 语义、0600 权限断言
- darwin-x64 runner macos-13→macos-14（GitHub 弃用 macos-13）

### 发布自动化工程化（2026-09-09）：散落脚本收拢为专一 `release/` 发布工程
- **单一发布工程根 `release/`**：`release/scripts/`（9 个发布脚本从根 `scripts/` 迁入 + `ci-core.sh` CI 核心 + `release-core.sh` 一键编排）、`release/runbooks/`（publish-and-verify / verify-desktop 手册迁入并**纳入 git 追踪**）、`release/README.md`（唯一端到端 SOP）。根 `scripts/` 已移除。
- **CI 逻辑单源本地可跑**：`.github/workflows/build.yml` 变薄壳，矩阵各步调用 `release/scripts/ci-core.sh`（verify → 壳前端组装 → 壳冒烟 → npm test → build:sea → 子包 dry-run / tag 触发时 `--publish`）；顺修原 workflow `if: runner.os ==  + Linux +` 语法 bug（→ `'Linux'`）。
- **一键发布编排**：`npm run release:core`（dry-run：干净树预检 → verify:versions → build:sea → 子包 dry-run → CHANGELOG 段检查 → 发布清单）；`npm run release:core:publish`（真发 + commit + tag `v<内核>` + push --tags 触发 CI）。
- **版本与发布入口不变**：npm scripts（build:sea / publish:core / verify:versions / verify:shell / export:shell / release:guard）命令名保持原样，仅内部路径改指向 `release/scripts/`。

## [0.1.2-BETA.5]（2026-09-08）

### 内核自更新部署形态闭环（2026-09-08）：安装目标=运行目标，重启链路可观测
- 背景：生产实测「面板点击更新后无动作」——apply 把新内核 npm 装到了 global 段，而本机部署是源码开发形态（systemd ExecStart 指向开发目录 bin 壳），装出的 SEA 二进制与运行位无关，永远不生效；且 restart 被 guardRestartAllowed 未配置闸死，两层叠加 = 用户视角「点了没反应」。
- A1 部署形态判定（platform/deploy.js 单源）：detect() 依运行位文件 magic 头判 sea-binary/source-shell；非标准形态显式拒绝自更新（不再假装成功）；`DSH_DEPLOY_FORM` 环境变量供测试/CI 注入。
- A2 自重启能力按形态自动判定：SEA 形态自动允许（systemctl restart），删除 guardRestartAllowed 人工配置门槛；重启前落盘预期版本，重启后 status 校验达标才报成功（guard_self_update_verified 事件），闭环可观测。
- A3 双版本口径：/guard/version 返回 runningVersion（进程固化）与 diskVersion（运行位实况），不一致即 updatePending=true（status 同步暴露）——根除「version 旧 + commit 新」的自相矛盾呈现。
- B 内核自更新下载源强制官方 registry：镜像 tarball 曾 stale（拉出旧版本二进制），真相源与下载源统一；镜像继续服务沙箱安装等大流量场景。
- C 壳（launcher）内核定位文案对齐 @dsh-sup；bootstrap 引导页内核缺失时一键 `npm i -g @dsh-sup/dsh-core-<platform>-<arch>` 标准产品包（原仅提示语），轮询兜底放宽至 10 分钟。
- 回归：guard-update 23/23（S1-S3 用 SEA 模拟形态对齐、S8 断言改无 systemd 单元指引）；deploy 判定双形态验证。

## [0.1.2-BETA.3]（2026-09-08）

### 月额度冻结/解冻语义定稿（2026-09-08）：信号=权威，快照只展示——修复 99% 灰区冻结/解冻死循环
- 现象：账号月额度用到 99%（余额剩几美分）时，面板不显示限额状态，请求持续失败；事件日志显示账号在 frozen/ready 间秒级死循环（生产实测 1 分钟内同一账号 frozen→recovered 各 4 次，累计 25 轮）。
- 根因：上游 400 insufficient credits 是「月额度不足以服务请求」的权威信号，冻结正确；但冻结后的补探测拉到 billing 快照（percent=99<100、remaining>0）不满足冻结阈值 → applyDetection 误判「已恢复」解冻 → 下一请求再挑中再失败再冻结。快照（滞后、粗粒度、Math.round 抹掉 99.33%）推翻了即时权威信号——两口径打架。
- 语义定稿（用户拍板）：**信号=权威，快照只展示**。credits 冻结的解冻不再回判阈值，只认正向恢复证据：① 月度重置到期（periodEnd）② 余额较冻结时刻回升（充值，冻结时记录 limit.creditsAt 基线）。
- 落地：applyDetection 解冻分支增加 credits 冻结证据门槛（无正向证据 → 维持冻结，quota 快照仍刷新供展示）；_setLimit 同 kind 重建保留 creditsAt 基线；quota-strategies 的 subscriptions（periodEnd）拉取条件放宽为「凡 credits 冻结即取」（灰区冻结也需精确恢复时刻，维持 6h 缓存）。
- 回归：新增 test/monthly-credits-freeze-test.js（冻结/维持/充值解冻/到期解冻/旧数据兼容/正常账号不受影响 8 场景）；upstream-credits 78、commandcode-quota 14、router 18 全绿。

## [0.1.2-BETA.2]（2026-09-08）

### 内核自更新版本检查直查发布权威源——修复镜像同步延迟漏报
- fetchLatestVersion 增加 `authoritative` 选项：自有发布包（内核自更新）的版本真相源 = 官方 registry.npmjs.org；镜像（npmmirror 等）同步存在分钟~小时级延迟，把『镜像未同步』误判为『已是最新』是真相源错误（生产实测：0.1.2-BETA.1 发布后面板检查更新漏报）。
- selectRegistry 按延迟选镜像继续服务安装下载流量——查询元数据与下载流量语义分离。
- authoritative 源解析：配置列表含官方源则用之；测试注入非官方列表（mock）尊重注入；空列表回退默认官方。

## [0.1.2-BETA.1]（2026-09-08）

### 全量代码审计与结构性修复（2026-09-08）：安全信任根/意图模型/执行契约/事件系统四层归位

第三方视角全量审计（约 2.3 万行）发现 1×P0、5×P1、12×P2、20+×P3，全部按结构根因修复（非补丁），详见 dsh-supervisor-AUDIT-REPORT.md 与 REPAIR-PLAN.md。

- **P0 安全（信任根错位）**：API 访问者身份改由 `src/api/identity.js` 依 `req.socket.remoteAddress` 判定——此前 Host/Origin 头可伪造导致「局域网窃取 DSH 会话令牌 + apiAccessKey 门卫被绕过」；Host 头职责归位防 DNS-rebinding，Origin 头归位防跨站驱动。
- **P1-1 adopt 观察窗绕过**：`_tokenReclaimAt` 等瞬态字段未在构造期初始化（undefined ≠ null）→ 接管后首拍即重建 DSH（实测 565ms，设计应观察 20s）。新增 `guard/intent.js` 意图登记簿 + 构造契约根治。
- **P1-2 畸形 URL 3 连崩**：`/lifecycle/%E0%A4%A` 触发未捕获 URIError → 守卫 60s 内 3 次 uncaughtException 自杀重启循环。API 分派器升级为统一异常边界（同步抛错/Promise reject 一律兜底 500），路径解码收敛单点。
- **P1-3 升级后不自动拉起**：守护开关（默认关）误拦升级恢复——升级完成经 `upgrade-resume` 显式意图穿透；upgrade-test 从 6 项 FAIL 回归全绿（此前 npm test 实为 EXIT=1 被管道掩盖）。
- **P1-4 shutdown 期望状态竞态**：`stopAll` 翻转 DSH desired 依赖 exit 竞态——契约化 `stopAll(reason, { exclude })`，守卫退出永不含 dsh；`shutdownAll` 显式持久化 stopped。
- **P1-5 锁 fail-open**：守卫单实例锁非 EEXIST 错误改 fail-closed（双守卫并存风险）。
- **P2 系列**：升级作业 catch 契约（不再永久 running 锁死实例）、stopInstance systemctl 超时、UI 缺失 503（不再 TypeError 崩溃环）、loghub 水位绑定写成功、事件轮转原子化、LogCore 聚合流路径冲突断言、relay 端口回收 configPath 注入（防误杀其它配置的 lan-daemon）。
- **P3 系列**：switcherAutoStart 死迁移复活、bump.sh SemVer 数值比较、CLI events 参数位、CLI 兜底端口对齐、`_findManagedDshPort` 劫持收窄、facade 危险键词表、测试卫生（退出兜底清理残留进程）。
- **死代码清理**：ensureMainInstance/_mainInstance/_syncMainEntry、token 重复扫描段。
- **测试基建**：新增 api-fuzz-test（伪造身份/畸形输入/存活断言）与 sigterm-desired-test（P1-4 契约门）；smoke/upgrade 退出兜底清理防残留污染；全量 npm test 625 PASS / 0 FAIL / EXIT 0。

### 账号锁定语义定稿（2026-09-05 A）：锁只对可用账号有意义——死锁不落盘/不复活/可拒锁
- 背景：遗留 selectedAccountKeyId 指向早已冻结的账号（8AEkNh，月额度耗尽，与其余限额账号同一冻结状态机），
  无任何逻辑让其跟随账号生命周期（仅 banned/discarded 清锁、无解锁入口）→ UI 死锁徽标/持久化死锁残留。
- 语义（用户拍板 A）：账号因任何原因冻结（额度任意窗口/封号/作废/不存在）即锁失效；恢复后由用户按需重新显式锁定。
- 落地：base._reconcileLock()（serialize 前置收敛 + _setStatus 冻结/封号/作废即清锁 + 加载后收敛丢弃死锁）；
  aux.setSelectedProxyKey 拒绝锁定不可用账号；死锁不落盘、重启不复活。
- 回归：router-test 3c / p2p-router F 改 A 语义断言；reconcile 新增 R14（冻结清锁/序列化不落盘/加载收敛）；全量 npm test exit 0。

### 端口管理激活失真修复（2026-09-05）：_portActives 改 TCP 探测——不再依赖 pid 映射
- 表现：前端端口管理所有 proxyInstance 无激活（41038 真实在监听而 active=false）。
- 根因：_portActives 用 findListeningPid（/proc/<pid>/fd 反查 socket→pid）判激活；对本环境守卫管理树
  （router-daemon 反代孙进程）fd 读取受限返回 null → 恒 inactive。真实监听与 pid 映射无必然关系。
- 修复：改为纯 TCP connect 探测（infra/probe.portListening，300ms）——与端口是否监听直接等价、
  与 infra/ports 判占用同语义、零 /proc 权限依赖、三平台一致；保留 3s TTL 缓存。
- 效果：实测 41038 active=true(7ms)/死端口 false；端口管理恢复真实状态。

### 智能路由复检之二：前端「账号切换/在用漂移」= 守卫回退陈旧本地视图（2026-09-05）
- 表现：前端看到 Kbobt7 在用、三账号轮转、锁定账号(8AEkNh)怪异——而 daemon 事件里并无对应流量/切换。
  实测 3100 /router/providers 在【daemon 真值】(2NVZWA 在用) 与【守卫内嵌陈旧副本】(Kbobt7 在用 + MxULq9 ready，
  07:36 快照随守卫常驻) 两态间 ~1/3 概率交替 → 前端每几秒整卡重渲染。
- 根因：Node≥19 http.globalAgent 默认 keepAlive=true（连接池化），守卫经 ctl 调 daemon 复用长连；而 ctl server
  未设 keepAliveTimeout（Node 默认 5s 回收空闲连接）→ 守卫复用已关 socket → 间歇 'socket hang up'（全天内 ~2s 一条
  WARN）→ routerProviders 回退守卫陈旧视图（监督模式下守卫内嵌 router 本不应再对外供数）。
- 修复：router-ctl server 设 keepAliveTimeout=65s（与供应商端点对齐）+ headers/request 超时上探——长连不再被
  服务端空闲回收。router 与 lan 共用本 ctl 模块，两 daemon 一并受益。
- 效果：修复后 40×1.5s 采样单一指纹、WARN 归零。
- 遗留（另立专项）：守卫内嵌 router 陈旧副本在监督模式仍可能被兜底路径外供（建议 last-good 缓存，需守卫重启）；
  lan-daemon 全天慢性重启（05-30min 一次，'lan-daemon 失联重新拉起'）致远程控制周期性掉线，独立子系统问题待查。

### 智能路由复检根治：账号切换根因（2026-09-05：停服孤儿化 / adopt 楔死 / 超时不自愈）
- 表现（实测复现）：健康常驻账号的实例楔死后（CPU 110% 旋转、completion 全挂而 /health 秒回），每次请求撞上 →
  15s 上游 connect 超时 → 换账号冷启动重试 → 前端「在用」跳变、账号不断切换（5 个真实请求中第 4 个从 wvr3t4 跳到 2NVZWA）。
- 根因链（代码确认 + 实证）：
  ① 停服孤儿化：stopInstance 的 SIGKILL 兜底是 unref 1.5s 定时器，router-daemon 随即 process.exit → 定时器随进程消亡
     永不触发 → 子进程孤儿化、stdio 管道死（426880/677630 两次实锤，重拉后 reparent 到 systemd）；
  ② adopt 复用不安全：重启幸存者的 stdout/stderr 读端属于已死 daemon，首个请求写日志即 EPIPE 楔死（677630 实测），
     且 /health 健康探针检测不到「completion 挂死 + CPU 旋转」类病态 → 认领复用无安全判据、adopt 后请求日志永久丢失；
  ③ 上游超时不自愈实例：net-error 路径先清 pid 再 markInstanceNetFail（内部 !pid→return，请求级熔断成死代码），
     且超时从不重启实例 → 楔死实例持续被撞 → 每次请求跳账号。
- 修复（三层根治）：
  - 停服必杀：stopInstance(inst, force) 支持停服强制路径（stopAllInstances 一律 force——在用/在途 defer 仲裁只用于
    运行期收敛，停服若沿用会把在用实例放过关停 → 孤儿，三次实锤）；stopInstance 登记 _terminatingPids 台账；
    RouterService.stopAndWait + provider.waitAllStopped 轮询确认子进程已死（zombie 亦视为已死：SIGKILL 已投递、
    端口/stdio 已释放），未退即 SIGKILL 进程组兜底；router-daemon 优雅退出改为 await stopAndWait 后再 exit。
  - 幸存者禁 adopt：_doStart 认领前置保留（claimSlot 之前、绑定端口、等释放），但同 pkg 幸存进程一律 SIGKILL 弃用重拉
    ——实例 stdio/env 必归当前 daemon；删除失效的后置 adopt 块。
  - 超时自愈：forward-core net-error 区分 timeout（connect 15s/response 180s）→ restartInstance('upstream-timeout')
    实例级 kill+同端口重拉（2min 退避），非超时网络错才清 pid 走按需激活。
- 回归：reconcile-instance-test R11 改为弃用重拉语义 + 新增 R12（停服台账/忽略 TERM 进程 SIGKILL 兜底）R13（超时重启同端口）；
  53 断言全绿；全量 npm test exit 0。

### 智能路由实例管理架构收敛（2026-09-05：reconcile 唯一决策者）
- 背景/根因：反代实例启停此前由 7 条各自写 if 的并行路径驱动（ensure/stopIdle/prewarmByQuota/probe/refresh/请求按需/生命周期），互相无仲裁——实况 41012 端口 5min 周期 prewarm+reclaim 死循环（prewarm 只看 percent>=80 不看可用性，预热已限额账号后回收同 tick 停掉，再预热）。
- 决策（用户拍板）：1) usage 纯派生（从 activeAccount/实例实况算，不落盘）；2) 常驻 1（resident）+ 至多 1 备胎（仅当常驻将耗尽 >=80% 且存在更低占用可用账号）。
- 落地：
  - providers/proxy.js 新增 reconcile 引擎：residentAccount / desiredRunningAccounts / _runReconcile / reconcileInstances（单飞互斥 _reconcileBusy）/ reconcileNow；resident 服务跟随 activeAccount + 内存 sticky 兜底；备胎只选 usable 最低占用者（绝不为不可用账号预热）；stopInstance 空安全 + 无一次性 timer（孤儿直接回收）；_retryPendingStop 请求结束补刀。
  - providers/base.js 状态单事实源：删 validity / 持久化 usage 双字段；usageOf 纯派生；markWarming/markIdle 死代码删除；一致性守卫 serialize 前置 ready+满额归位 frozen+limit（矛盾态不落盘）。
  - forward-core.js 在途计数接线（inflight 原只读不写=死保护）：begin/end 计数 + 归零补刀；取代旧一次性 2.5s timer（命中在途即空放永不重排的泄漏根因）。
  - index.js 清理 _primaryAccountKey/_prewarmByQuota/refresh 尾重复 reconcile；probe/refresh 用 isDesiredAccount 同源判定。
  - providers/proxy.js 重启幸存者认领前置（2026-09 复检根治）：adopt 判定提前到 claimSlot 之前、针对持久化绑定端口执行——原逻辑在 claimSlot 之后只看新分端口，绑定端口被上一代幸存进程（重启后 reparent 到 systemd/init 继续服务的残留）占用时 claimSlot 先 bindingLost 迁移 → adopt 永不触发 → 每次重启残留幽灵进程 + 绑定漂移（实测 41028 孤儿）；现健康幸存者认领复用（pid 接管探活/停止）、不健康 SIGKILL 后同绑定端口全新拉起——不漂移、不留幽灵。
- 回归：新增 reconcile-instance-test（R1-R11，40 断言：常驻/备胎可用性/孤儿收敛/在途补刀/单飞/交替请求资源有界/usage 派生/一致性守卫）；router-test 18、p2p-router 42、ensure 8、upstream-credits 71、commandcode-quota 14 全绿；全量 npm test exit 0。

### 上游 insufficient credits 自动切换（2026-09-04）
- 根因（用户指正）：Command 预付 credits 耗尽时上游回 400 insufficient credits/billing/balance；
  forward-core 旧逻辑把 400 一律当业务拒绝透传 → 一直打到空余额 key，不切换。
- 修复：classifyUpstreamLimited 按 状态+响应体 区分 credits(预付余额)/window(时间窗配额)/none；
  400/402/429/403 出现 credits 信号 → markCreditsExhausted（冻结+10min 周期回探）+ 本请求换下一账号重试；
  isAccountUsable/applyDetection 纳入余额阈值（monthlyRemaining<0.5 即不可选/保持冻结，充值后自动解冻）；
  ProxyProvider 停实例+冻结+预热下一个。非额度 400 仍透传（业务拒绝语义不变）。
- test/upstream-credits-test.js 15 断言并入 npm test；回归 router16/commandcode8/p2p-router40/p2p-api27 全绿。
- 实测：空余额 key(…EkNh) 已冻结不再被挑，有余量 key(…ULq9) 承载流量；单 key 池耗尽将返回
  all accounts exhausted(429) 并留日志，不再以空 key 反复 400。
## [未发布]

### 注入可诊断层（2026-09-04，docs/token-management.md §七）
- relay 内置注入状态（tokenSet/cookieReady/lastOkAt/lastError/lastErrorAt）+ 事件
  lan_cookie_exchanged/failed/invalidated（带实例 id）；LanManager.list 附 inject；
  sup.listLan() 白名单外显（含 inject，令牌永不下发）。
- /lan-access 每实例可读注入状态；前端远程控制页显示「远程就绪/正在注入/令牌缺失」徽标（title 给失败原因）。
- 「远程访问不了」定位路径：面板实例徽标 + lastError + 事件流，不再靠 401 猜。
- 回归：relay-dshauth / token-boundary 12 / lan-daemon 10 / p2p-api 27 全绿。
## [未发布]

### DSH 令牌注入稳定性根治（2026-09-04，docs/token-management.md §六）——「远程访问不了」实证修复
- 长驻实例令牌滚窗丢失：capture 只回看 journald 最近 400 行，启动即打印的 token 行早已滚出 → 令牌恒空 →
  relay 无 cookie 401（实测 inst-…920 启动 18h+ 未重启即此症）；修复为 journalctl -g 取最近一条 URL 行。
- 回填被实例 phase 卡住：InstanceManager 原仅 RUNNING 分支 ensureCaptured；孤立/长驻实例守卫重启后
  永不回填；改为 tick 对 sandbox 无条件 ensure（服务内节流）。
- lan-state churn：_syncLanState 每 30s 因 updatedAt 重写 → lan-daemon 全员重换 cookie；改稳定内容哈希。
- 实测：920 修复后守卫重启 5s 内 40003→200；40000/40001/40003 全 200。
## [未发布]

### DSH 访问令牌管理梳理与收敛（2026-09-04，docs/token-management.md）
- **梳理结论**：令牌已有唯一节点（DshTokenService：attach 登记源 → capture(journald/stdout 最新行)/feedLine
  → get/onChange 分发），非「无主分散」；真正问题是**节点外的边界残留/泄露/落盘**。
- **P1 泄露修复（高危）**：/lan-access 直出各实例 dshToken（真实会话令牌）且面板允许 LAN 访问 → 绕过
  F1「token 永不出本机」；sup.listLan() 两路（本地/L3b 门面）剔除 token/dshToken。
- **P2 持久化收敛**：instances.json 历史遗留 dshToken 列载入即剔（内存断行），线上文件已清。
- **P3 日志脱敏补洞**：守卫 stdout 实时镜像改走脱敏完整行，dsh-supervisor journald 不再残留 token 明文。
- **边界固化**：docs/token-management.md 载明「谁能持 token」裁决表；test/token-boundary-test.js（9 断言）
  并入 npm test。守卫重启 #10 后 dshTokenCaptured true、relay 40001 200、daemon 不受影响。
- 后续可选（未做）：lan-state token 改 ctl push；relay 内部缓存收敛为单一 owner；前端 type 移除 dshToken 字段。
## [未发布]

### L3b lan(relay) daemon 解耦上线（2026-09-04，docs/L3-process-decoupling.md + config.lanDaemon=true）
- **lan-daemon 独立进程**（src/service-daemon/lan-daemon.js）：远程控制（40000 主 relay + 4000x 实例 relay + frpc）
  不再驻守卫——守卫重启不影响远程控制（实测：lan-daemon/router-daemon pid 跨守卫重启不变，relay 在线）。
- 数据流：守卫写 lan-state.json（实例清单+令牌，原子 0600，事件驱动+30s 兜底）→ daemon 2s 轮询 diff →
  reconcile/applyToken 热换；relay 端口注册表独立（ports-lan.json）；43108 ctl（复用 router-ctl dispatcher）。
- 守卫委托：listLan/setLanFrp/frpStatus/lanFrpc/syncFrpc 经 lanApi() 门面；api.js /instances /lan-access /lan/frp
  改 Promise 兼容；守卫 30s 监督拉起失联 daemon；lan-daemon.lock 管理锁（同 router 三重门）。
- **守卫 shutdown 不停 daemon 修复**：lifecycle router/lan 适配器 stop 在 sup._stopping 时豁免（曾致每次守卫
  重启 SIGTERM router-daemon 并持久化 routerAutostart=false）。
- **pidlookup 修复（关键）**：/proc/net/tcp 数据行 inode 实测第 9 列（勿按表头取列——表头 12 名 vs 行 17 列）；
  ss 兜底（异 pidns 环境 /proc fd 扫描不可见宿主进程时经 netlink 归因 pid，补 /usr/sbin PATH 候选）。
  危害：探测恒 null → 守卫 30s 监督每轮重复拉起 daemon（stray 堆积）、DSH adopt 失效。
- **daemon 拉起仅限真实守卫**：_ensureRouterRuntime 对无 configPath 实例（测试 Supervisor）一律 embedded，
  杜绝测试在探测不可见环境把 router-daemon 拉成 stray。
- 清理：本会话早期未门控测试曾向生产 Command 供应商写入 pk-2 测试账号（已 discarded）——经 daemon 路径移除，
  账号恢复 14 零丢失。
- 验证：守卫重启 #6 后 lan/router daemon pid 不变（守卫重启不影响被管模块，L3a/L3b 语义实证）；relay
  40000/40001 代理 200；全量回归：p2p-api 27、smoke 34、lan-daemon 10、adopt 13、guard-update 23 等全绿。
## [未发布]

### L3 监督模式状态一致性修复（2026-09-04，HANDOFF #4 定案 + #3 前端迁移）
- **router 控制经 ctl 转发 daemon（#4）**：router-daemon 新增 127.0.0.1:43107 ctl 控制口（POST /ctl {method,args}，
  同步/异步/异常统一语义）；守卫 routerApi() 门面在 daemon 监督模式下全量转发——此前守卫本地 RouterService 副本
  persist 关、不 live 同步 → 视图陈旧（daemon 刷新后守卫仍是旧快照）、写操作不落盘 daemon 无感知（双脑）。
  实测：守卫视图=daemon 一致；refresh/activate/deactivate 经守卫落到 daemon 并持久化。
- **daemon 模式三重门判定（隔离修复）**：routerDaemonActive() = routerAutostart ∧ 管理锁（stateFile 同域
  router-daemon.lock）∧ 43011 监听为 router-daemon；spawn/接管落锁、停止清锁；异主 daemon（测试内嵌等）一律
  退回内嵌语义。根治 p2p-api-test 误接生产 daemon（曾把测试 provider 写操作打到线上、/router/stop 误杀生产 daemon）。
- **守卫 30s 监督 tick**：router-daemon 期望运行但失联 → 自动重新拉起（事件 router_daemon_supervised；实测
  kill 后 15s 内自动恢复）。
- **#3 前端迁移统一 /lifecycle**：OverviewPage DSH 启停、RouterPage 路由启停改调 /lifecycle/{id}/start|stop
  （client.ts 增 lifecycle*、删旧 start/stop/restart/routerStart/routerStop；types.ts 增 Lifecycle 类型）；
  lifecycle router 启停适配器改走守卫 setRouterRunning（daemon 感知，/lifecycle/router/restart E2E 通过）。
- **单测**：新增 test/router-ctl-test.js（9 断言）；p2p-api-test 27/27 全绿（隔离回归验证）。
## [未发布]

### 守卫重启根源审计定案（2026-09-04，见 docs/guard-restart-audit-20260904.md）
- **定案**：无外部神秘重启者——显式重启（journald 有 Stopping 行）= DSH 会话部署 restart（主因）；
  观感「无人操作也重启」= 崩溃自重启（Failed with result exit-code/signal，无 Stopping 行，systemd 自动拉起）。
- **实证**：8 月多次数小时连续崩溃循环（8/22 exit-code 每 5s、8/28 SIGKILL 每 ~10s）即历史频发观感来源；
  9 月仅 2 例：09-04 05:09 nodeLtsStatus 部署中间态未捕获异常 3 击自退、05:41 SIGKILL（agent 测试），均查实为自崩溃。
- **取证法**：守卫重启先按 Stopping 有无分类；signal 死亡查 code=killed, status=9/KILL。
## [未发布]

### 守卫重启后远程访问令牌不可达修复（2026-09 第四轮：adopt 令牌接管）
- **问题**：守卫重启（systemd KillMode=process）后，新守卫 `_adopt()` 接管旧守卫 spawn 的主 DSH——被接管进程非新守卫 spawn，其启动令牌只打印在旧守卫已断开的 stdout 管道里（令牌服务不落盘）→ 主令牌永久不可达 → relay 无法用令牌向回环 DSH 换 `dsh-auth-*` cookie → LAN 远程控制全 401（实况：主进程被接管后 `/status` dshTokenCaptured=false、`/lan-access` main dshToken=EMPTY，而 sandbox 实例走 journald 不受影响）。
- **修复**：RUNNING tick 新增 `_maybeReclaimAdoptToken()`——被接管（`adoptedPid && !child`）且主令牌空置时启动观察窗（`config.tokenReclaimGraceMs`，默认 20s，覆盖 adopt 后 journald/补获可能），窗口内令牌迟到即复位不干预；窗口过仍空置 → 受控重建一次（`_beginRestart('adopt_token_reclaim', {countCrash:false})`：杀 adopt 进程 → 状态机回 RESTARTING → 自 spawn 建新 stdout 管道 → 令牌必然可捕获）。`_tokenReclaimTried` 保证每次接管仅重建一次，防重启循环；令牌就绪/本守卫 spawn 时复位观察。
- **回归测试**：新增 `test/adopt-token-reclaim-test.js`（13 断言：观察窗语义/单次重建防循环/令牌就绪与自 spawn 不干预/窗口内迟到复位/默认窗 20000ms）并入 npm test；smoke makeConfig 显式拉满观察窗（mock 不打令牌，防 adopt 场景误触发重建），冒烟保持确定性。smoke 34/34。

### 智能路由 COMMAND 全量审计修复（2026-09 第三轮，见 docs/ROUTER-AUDIT.md）
- **额度恢复不同步修复（问题①）**：`resetsAt` 统一归一 `normalizeResetTs`（ISO 字符串/epoch 秒/毫秒均支持）——原 `_nextResetAt` 对 ISO 串 `Number()=NaN` → 30 天兜底，把精确恢复点（如月窗口 09-21）覆写成 +30 天，且恢复探测只按该错误 nextResetAt 触发 → 到真实重置点账号不被探测恢复（实况：OpenCode 6 账号全 frozen、nextResetAt=10-03 远晚于 09-21 真实重置）。direct/proxy 检测落库前归一；`_nextResetAt` 返回 `{t, precise}`；`applyDetection` 仍满额分支防回推（纯兜底不得覆写精确值）。
- **前端无法定位当前账号修复（问题②）**：`selected` 派生口径分裂——账号行只认 `selectedAccountKeyId`、头部回退 `activeAccount`，且 `activeAccount` 为内存态不持久 → 路由实际在用的账号列表不亮。修复：统一 `selectedKeyId()`（锁定可用→锁定；锁定冻结/失效→实际在用 activeAccount）；视图新增 `activeKeyId`/`locked` 同源锚点；`switchToAccount` 同时写持久化锁定；`_deserializeProvider` 恢复直连/反代锁定（兼容旧 selectedProxyKeyId）；锁定仅对永久失效（封号/作废/删除）清空，临时冻结保留（恢复后自动续用）；前端账号行「当前在用账号（锁定）」与「当前在用账号」区分。
- **预热池/启停风暴修复（问题③）**：实例启动前增加端口释放等待（≤3s，旧进程 SIGTERM→SIGKILL 1.5s 内未退即放弃并明确报错）——根除同端口并发 spawn 的 EADDRINUSE 秒退循环（实况：41012 端口 ~10s 一次启停数十次）；10min 额度刷新不再临时拉起全部 ready 账号（改为只探测已在运行的 primary/selected/prewarmed/在用实例）——消除周期性批量启停风暴。
- **回归测试**：router-test 12→16（normalizeResetTs/_nextResetAt 精确解析/selected 派生统一/锁定持久化）、p2p-router-test 37→40（F 段：临时冻结不清锁/解冻后锁定优先/封号清锁）；全量 npm test EXIT=0。
- **Command Code 额度获取修复（问题① Command 侧）**：`detectInstanceQuota` commandcode-billing 分支窗口耗尽判定改为纯 `used/cap` 推导（>=100%→rate-limited），不再依赖上游可选的 `exceeded` 标志（实况：三账号 weekly 100% 却存 status=ok 的矛盾记录）；支持 `{data:{windowLimits,credits}}` 信封解包、used/cap 字符串解析、credits 缺席时 monthlyRemaining=null。对照开源参考 opencodex quota.ts 逐字段核验。新增 `test/commandcode-quota-test.js`（8 断言）并入 npm test。

### 决策定案落地（2026-09 第二轮：D1-D6 拍板 → 剩余 Phase 3 落地）
- **决策记录（docs/DECISIONS.md 定案）**：D1 废 release.sh 自更新旁路统一 npm；D2/D5 单一 SEA（daemon+CLI 合一、全静态）确认；D3 **选 A 砍 useSystemdForMain**（守卫统一自 spawn，三端语义等价最短路径）；D4 壳更新形态 = npm 平台子包；D6 阶段门禁确认；版本双轨独立 + CHANGELOG 过期「壳同号跟随内核」句标注废弃。
- **D3-A 落地**：supervisor.js 全部 `useSystemdForMain===true` 分支折叠到 spawn 语义（tick/_startProcess/stopProcess/_enterRunning/_beginRestart/升级 hold）；删除 `_ensureSystemdMain/_systemdMainActive` 与 native 的 `systemdMainActive`；主 DSH 令牌源只走 stdout；升级健康验证不再依赖 `dsh-web@main` 单元；守卫 systemd 单元加 `KillMode=process`——守卫自身重启/升级不再连带杀掉其 spawn 的 DSH（「重启守卫不断 3080」由 process 模式 + spawn 接管语义保证）；主实例观测记录在守卫启动时注册（仅元数据：清单/relay/端口登记）。config 与测试配置删除死键。测试同步：smoke 34/34、guard-update 23/23、npm test 全绿。
- **F2 apiAccessKey（采纳）**：可选配置 `apiAccessKey`——仅设置后强制：非回环请求（0.0.0.0 局域网 / 私网 Host / FRP 通道）须带 `Authorization: Bearer <key>` 或 `?access_key=<key>`（常数时间比较），否则 401；回环豁免。新增 `GET/POST /settings/access-key`（空串=清除，不回显明文）+ supervisor accessKeyStatus/setAccessKey + skiff SettingsPage「出回环访问密钥」设置项；api-contract 增 F2 五断言。
- **D1 收敛**：`scripts/release.sh` 不再生成 `dist/release/manifest.json`（污染复发面消除），仅作源码打包出口；DESIGN §16.2/16.3 release.sh 行、verify-desktop.md 场景 C 同步为「非自更新通道」；守卫自更新统一走 npm 执行器（DistributionManager + 平台子包，路线见 DECISIONS.md）。

### 修复与重构（2026-09 架构级审计：发布形态驱动 — 壳开源 + 按平台 npm 拉内核 + 内核闭源热更新）
详见 docs/ARCHITECTURE-v2.md。全量 `npm test` EXIT=0（234 PASS）验证。
- **SEA 真内核化（决定性修复）**：bin daemon 的动态 require 改静态（`require('../src/supervisor')`）——此前 esbuild 打 bin 入口且 daemon 用 `path.join(ROOT)` 动态 require，内核从未打入 SEA（bundle 仅 585 行 CLI 壳），SEA daemon 运行时依赖旁置 src/ 明文；静态化后 bundle 11937 行含全部内核类。`--version` 复用 `guardVersion()`（原 vunknown）。内嵌 `DEFAULT_CONFIG` 替代 ROOT/config.json 外读（fresh-HOME 自举崩溃修复）。build-sea.sh 冒烟升级：self-check + `--version` 注入断言 + fresh-HOME daemon 自举三重验证。
- **发布链测试污染治理**：guard-update-test require 路径修复（self-update 迁移到 domain/dist 后断链）；smoke/upgrade-test 清理改 SIGCONT+SIGKILL（SIGTERM 杀不掉 detached/SIGSTOP 残留 mock → 占端口致链序偶发断）
- **补丁层数据破坏修复（Blocker）**：setBundleEnabled 禁用只置 disabled 保留用户行/insert 行，启用只删本插件 disabled 行（原 filter 整删同 id 所有行静默丢数据）；JSON 深比较替代长度比较；回归测试 F0 6 断言
- **原生卸载数据安全（HIGH）**：manifest dataPaths 改显式认领制——首装且 ~/.dsh 干净才认领；升级/回滚继承既有认领；默认空数组（不再默认写 ~/.dsh 凭据/会话路径防误删）
- **逻辑健壮性**：instance tick save() 纳入 try/catch（磁盘错不再经 uncaughtException 触发守卫 3 次退出重启）；restartCount 稳定运行 5min 后清零（偶发重启不再跨时间累计到 20 上限永久 FAILED）；waitPortHealthy 超时精确化（稳定期预算检查，不再溢出 timeoutMs+15s）；INSTALLING/FAILED 死锁自愈（安装超时竞态后成功恢复拉起）
- **逻辑单轨化**：TaskRegistry 观测层单一事实源（upgradeStatus/updateJob 用 current() 精确优先，running 期间不误显旧任务）；唯一 npm 安装执行器（native._runInstall 删重复实现，dist.runNpmInstall 支持 commandTemplate）
- **平台等价（Phase 3）**：frp 平台化（三镜像硬编码 linux_amd64 → frpPlatformTag 动态 os/arch 产物 + frpc.exe 支持 + 不支持平台明确拒绝）；平台能力门 capabilities() 真实矩阵 + /env/status 暴露（原硬编码全 true 与 win/mac 现实不符）；dshBin 统一解析（PluginManager 不再硬编码裸 'dsh'，与 InstanceManager 同源取 config.command[1] 绝对路径防 PATH shim 劫持）；pidlookup readCmdline 补 mac(ps)/win(wmic+CIM)（原非 Linux 返 null 致接管校验防线静默失效）
- **授权边界收口（F1）**：/instances 的 authUrl 仅回环 Host 请求附带 DSH 会话 token（token 永不出本机）；LAN/私网 Host 只给免认证 lanUrl + tokenPresent:false；api-contract 新增 F1 双断言防回归；setLanPanel(0.0.0.0) 记 lan_panel_exposed 风险事件
- **CLI/网络加固**：插件 spec/name 前导 '-' 注入防护（_assertSafeCliArgs settle-safe）；profile package.json 原子写（tmp+rename+0600）；pluginmarket getText 加固（2MB 上限/5 跳重定向/2xx 校验）
- **配置单一事实源**：bin 的 DEFAULT_CONFIG 改为从 src/infra/config.js DEFAULTS 派生 + 补 command/healthUrl 模板必填项（原 30 键手写副本与 DEFAULTS 漂移：缺 pluginsProfileName/routerAutostart/selfUpdate* 等）
- **可测化（跨平台核心逻辑）**：frpPlatformTag/capabilityProfile 纯函数化导出；新增独立测试 frp-platform-test（11 断言）/ capability-profile-test（8 断言）/ instance-state-test（9 断言）——三端映射、能力档位、实例状态机不再依赖真实 OS/进程即可验证
- **发布链 manifest 守卫（F5 关闭）**：release.sh 拒绝本地/私网/占位符 URL 生成 manifest（曾产出 url=127.0.0.1:39240 测试污染产物）
- **自更新去外部 tar**：fs-utils 新增纯 Node extractTarGz（GNU 长名/防穿越/stripComponents）；self-update 不再 execFileSync tar（Windows 无 GNU tar 时原不可用）；guard-update 全链路 23/23 验证
- **frpc 孤儿清理平台化**：pgrep（Linux/mac）→ win32 走 wmic/PowerShell CIM 按 Name+CommandLine 找残留 frpc

### 移除（Command Code 免费通道彻底下线）
- **背景**：免费通道（-free 模型免额度档）干扰正常付费账号稳定性（频繁中断付费流量），用户决策彻底移除，清除全部免费通道逻辑。
- **后端**：providers/base.js（freeCooldownMs/freeSelectedAccountKeyId/freeActiveAccount/freeCursor/freeModels 字段、isFreeAccountUsable/freeCooldownRemaining/markFreeLimited 方法、序列化 free 字段）；providers/proxy.js（markFreeLimited 覆写/_prewarmNextFree/实例仲裁免费分支，恢复单通道 _canStopInstance）；switch.js（免费双通道池，恢复纯付费引擎）；forward-core.js（免费模型分流/isFreeModel/proxyForFree 整方法）；router/index.js（hasFreeChannel/免费视图字段/免费模型周期刷新/实例回收免费分支）；router/aux.js（refreshFreeModels/_refreshFreeModelsIfDue/setFreeSelectedAccountKey）；proxy-apps.js（freeChannel/freeApiBase/freeModelFallback）；api.js（/router/providers/free/select|refresh 端点）。
- **前端**：ui/views-router.js（免费标签区/免费块/事件绑定）、app.css（free-* 样式）、core.js（6 条免费事件映射）。
- **测试**：删除 test/free-channel-test.js 并移出 npm test 链。
- **验证**：npm test 全套 exit=0（含 router/proxy/p2p 套件零回归）；重启守卫后 /router/providers 视图无任何免费通道字段（仅余官方模型名 ox-alpha-free 定价行，无关）。
### 新增（版本管理规范 v2：单一事实源 + 全派生链）
- **版本规范定稿（DESIGN §16）**：SemVer 2.0 纯数字、禁预发布后缀（自更新字符串比较前提）；单一事实源=仓库 package.json.version；
  派生链只读单源；v 前缀只出现在发布通道外层（manifest/tag/版本目录），npm 子包例外=裸版本（npm 强制）。
- ~~**壳版本策略（已拍板）**：Cargo.toml + tauri.conf.json **同号跟随内核**；补丁整包发布（内核 0.10.1 → 壳同步 0.10.1，一个 tag 出全平台整包）。~~ **[已废弃]** 同日下条「版本双轨独立（DESIGN §16.4）」裁定替代：壳 0.1.x 起独立、公开仓 Release 极少更；内核 0.10.x npm 热更。以下行/相关代码以双轨为准。
- **修复（SEA 版本不自包含，历史断点）**：`src/infra/version.js` 支持 `__DSH_VERSION__` 编译期注入常量；build-sea.sh 以 `esbuild --define` 注入单源版本。
  实证：此前 SEA 脱离 dist/sea 目录自报 `guardVersion=unknown`；修复后源码形态 / dist/sea / 孤立目录三态均自报 0.10.0。
- **SEA 产物命名带版本**：`dsh-supervisor-<ver>-<platform>-<arch>`（不再无版本）。
- **版本双轨独立（替代早期同号策略，DESIGN §16.4）**：双仓库拆分开后发布通道解耦——内核走 npm（频繁热更新）、壳走公开仓 Release（稀少）；`bump.sh` 改为 `--core`/`--shell` 双模式（互不 bump、拒回退）；`verify-versions.js` 双轨自洽（内核 package.json 单源 / 壳 Cargo=tauri.conf 互锁）；壳版本 **0.1.0 起**；私有仓 CI 剥离壳 Release（只产 SEA + npm 子包），壳构建仅留集成冒烟。
- **`scripts/bump.sh`（版本提升唯一入口）**：校验 SemVer（拒预发布）→ package.json → Cargo.toml → tauri.conf.json → 一致性强制校验 → 人类清单。
- **`scripts/verify-versions.js` + `npm run verify:versions`**：三处同号校验；接入 `verify:shell` 第 0 步与 bump.sh 尾步（防壳脱轨回归）。
- **双仓库方案落地（壳开源 / 内核闭源）**：壳解耦——tauri.conf resources 仅 bootstrap/icons（不再内嵌内核资产）；main.rs 定位已安装内核（PATH/~/.local/bin/~/.npm-global/bin/旧资源兜底）daemon 拉起（SEA 自足不依赖 Node）；引导页新增 core_status 显示内核安装状态。公开壳仓 `dsh-supervisor-launcher`（MIT）：`scripts/export-shell.sh` 导出（壳+产品主页 README+MIT LICENSE+公开仓 CI），导出目录独立 cargo build 验证通过（clone 即构建）。许可定案：内核 **UNLICENSED**（主 package.json + 根 LICENSE + npm 子包继承），壳 **MIT**。
- **`scripts/publish-core.sh` + `npm run publish:core`（内核 npm 子包发布）**：单源注入裸版本（与内核同号）、`os`/`cpu` 字段平台过滤、`bin` 指向 SEA 二进制（win 为 .exe）、发布前强制 self-check 版本=单源（错配拒绝）、默认 dry-run 保护（`--publish` 真发）。Linux x64 dry-run 实测：包 47.5MB、integrity 已生成。scope 解析链：package.json.npmPublish.scope → 环境 DSH_CORE_SCOPE → 兜底 @dsh-core。### 新增（内核构建物化：SEA 单文件 + V8 字节码）
- **`scripts/build-sea.sh`**：内核发布产线——esbuild CJS bundle → `node --experimental-sea-config`（`useCodeCache` 生成 V8 字节码 `prep.blob`）→ postject 注入 `NODE_SEA_BLOB` → SEA 二进制自举冒烟（`self-check`）。路径统一绝对化，修复子壳相对路径错位（此前 `(cd out)` + 相对 BIN 导致 postject 目标不存在）。
- **`bin/dsh-supervisor self-check`**：SEA/源码双形态自检子命令（guardVersion/node/platform 三段）。
- **Linux x64 验证**：注入 done、`self-check: OK`（guardVersion=0.10.0）；`strings` 无 `class RouterService` 明文（字节码生效），仅字符串常量池可见——闭源构建物口径成立（知悉非绝对防逆向）。
- **发布形态**：公开 npm 内核子包（按平台 `@scope/dsh-core-<os>-<arch>`，内核版本号对齐）、私有 GitHub 存源码、壳开源引流。文档：README「内核发布：SEA 构建物化」+ `scripts/publish-and-verify.md` 双轨重写。
### 重构（前端架构分层：数据层 / 状态中心 / 视图层，工业级单向数据流）
- **分层**：HTTP API（后端）→ syncAll 一次并行拉取（数据层）→ Store（唯一事实源）→ renderActive 渲染当前活跃视图（视图层）。
- **消除重复请求**：/status、/instances 由多次独立拉取合并为 syncAll 一次快照（此前 /instances 每周期拉 3 次、/status 拉 2 次）；
  swActiveProv/Key 从 Store.providers 读取，不再第 3 次拉取 /router/providers。
- **视图纯函数化**：renderStatus/renderUpdate/renderInstances/renderLan/renderFrp/renderSwitcher/renderProviders 全部只读 Store；
  旧 refreshX 混合体移除，操作回调统一走 unifiedTick（操作 → 同步 → 渲染管线）。
- **活跃视图渲染**：renderActive 只渲染当前页 + 概览全局元素（hero/版本卡/事件），设置页低频配置数据按需拉取（不进 2s 同步）。
- **视图联动闭环**：停止 DSH → 后端停 relay → syncAll 刷新 lan 快照 → LAN 页开关/代理徽标/访问链接随快照联动更新（含实例未运行禁用开关）。

### 修复（前端状态架构：状态中心 + 视图联动 + 启动链路根治）
- **前端状态中心 Store（单向数据流）**：所有视图状态统一存 Store（status/instances/lan/frp/switcher/providers/events），
  refresh* 拉取写入、render* 只读渲染；unifiedTick 全量覆盖含远程控制（LAN/FRP）——停止 DSH 时后端联动停 relay，
  LAN 页开关/代理状态随同一状态快照联动刷新，消除「A 页变了 B 页不知道」的断链。
- **远程控制联动语义**：开关 = 实例运行中 ∧ remoteEnabled ∧ relay 实际监听；实例未运行时开关禁用并明示「实例未运行」，
  不再只是 remoteEnabled 配置位。
- **停止链路根治**：systemd 托管模式下 pid 观测提前到 desired=stopped 调和之前，stopProcess 增加「端口占用者
  现场探测 + DSH cmdline 校验」兜底——停止不再因 adoptedPid 未就绪而静默无效，也不误杀外来进程。
- **启动链路根治（systemd）**：_cleanStaleUnit 删除 transient 单元文件后补 daemon-reload，systemd-run 重建同名单元
  不再报「Unit already loaded or has a fragment file」（实测启动一次成功，无 systemd_start_failed）。
- **desired 正交轴彻底解耦**：显式 start/stop 始终生效（守护开关只约束崩溃后自动拉起）；/restart 同属显式操作。

### 修复（useSystemdForMain 模式下「启动 DSH」失效——深度根因）
- **根因**：useSystemdForMain=true 时，主实例「进程守护」开关默认关（guardian=false），tick 在调和前被
  「只观测、绝不拉起」短路——DSH 崩溃后守卫不自动拉起，且前端 POST /start 设置的 desired 永不触发 spawn，
  表现为「点击启动无反应，只能手动命令启动」。
- **修复**：显式操作（POST /start）穿透守护开关一次（_explicitAction 标志）：守护开关只约束「崩溃后自动拉起」，
  绝不约束用户主动点启动；启动等待期保持 STARTING 呈现（systemd 单元拉起数秒内不闪回「已停止」）。
- **语义边界**：自动拉起仍遵循守护开关（默认关，前端「▶ 启动进程守护」按钮开启）；/start 每次显式拉一次。

### 新增（前端即时响应：消除状态真空）
- **统一状态驱动**：单一 2s 主循环（unifiedTick）替代三个独立定时器（5s/3s/5s），页面重新可见时立即同步；
  安装/卸载/实例安装/升级等长任务全部纳入同一轮询驱动。
- **安装/卸载异步任务化**：/native/install|uninstall 由「同步等待 npm 完成」改为 202 受理 + 状态流
  （state / installLog / lastInstall / lastUninstall），hero 区实时进度卡（标题 + npm 输出日志尾 +
  禁用重复操作按钮），完成/失败自动刷新全视图——不再需要手动刷新。
- **卸载不再冻结守卫事件循环**：uninstall() 由同步 execFileSync 改为异步 spawn。
- **写操作后全量即时刷新**：安装/卸载/升级终态统一触发 unifiedTick()（hero/按钮态/版本卡一次到位）。
- **DOM 重建去重**：refreshInstances / refreshProviders 数据未变不重建（2s 轮询下防闪烁与事件重复绑定）。

### 修复（底层架构治理，审计后）
- **插件安装必崩修复（P0）**：`plugins.js` 使用 `os.homedir()` 却未 `require('node:os')`，任何插件安装都抛 ReferenceError 且 API 无响应——已补引用，并为插件安装调用链兜底。
- **健康探测语义回归（三层）**：恢复 L2 HTTP 探活（`GET healthUrl`，超时 `probeTimeoutMs`），新增 `failThreshold` 连续失败防抖与 `httpProbeEnabled` 逃生门（非 HTTP 命令可关闭 L2）。"假死识别"（事件循环卡死）真正生效：端口在但 HTTP 连续失败 → `http_unhealthy` 判故障重启；STARTING 启动门与 RESTARTING/BACKOFF 恢复条件均要求端口+HTTP 双通过。
- **事件增量读取跨守卫重启连续**：seq / rotatedSeq 持久化到 `events.log.meta.json`（原子写），轮转后重启不再丢 `.1` 历史、seq 不再重号；无 meta 时向后兼容旧行为。
- **API 重绑竞态修复**：切换面板局域网访问时旧 keep-alive 连接导致 EADDRINUSE 打死 API——改为 `closeAllConnections` + 10 次重试 listen。
- **守卫版本检查不再冻结事件循环**：`git fetch` 由同步 `execFileSync` 改为异步 `execFile` + 10s 超时；`GET /guard/version` 走本地视图（同步安全），`POST /guard/version/check` 才触发远端 fetch。
- **中转转发增加响应头超时（30s）**：防「已连接但静默」的上游挂死请求占满连接池（仅约束到响应头，长流不受影响）。
- **单实例锁**：`daemon` 入口 O_EXCL pidfile + 存活检测 + 崩溃残留自愈，杜绝双守卫并存。
- **沙箱实例安装走全局镜像源**：`_installSandbox` 注入 dist 选中的 registry（与 DSH 自升级同一镜像配置）；`startInstance` 异步化，调用链（API/tick/守卫）全部对齐。
- **API body 统一有界读取**：所有写接口超过上限先应答 413 再断开，不再静默挂死。
- **实例删除清理沙箱目录**：`removeInstance` 对 sandbox 域异步删除 install/data 残留。
- **实例持久化写放大治理**：`instances.json` 内容未变不写盘。
- **中转费用估算落地**：按实际使用供应商的 models.dev 官方单价累计 `costUsd`（无单价不虚报）。
- **前端清理**：删除 qrcode.js 死引用与死元素调用（swCool/swActive 等）；`wire()` 统一判空绑定；反代版本更新由「打开面板自动重启实例」改为显式「更新」按钮 + 用户确认。
- **overlay 治理**：插件覆盖层只记录 `disabled:true` 条目，启用=删除记录，不再无限累积。

### 重构（信息架构 → 桌面管理台形态）
- 采用侧边导航 + 工作区的桌面软件标准布局：概览 / 大模型中转 /
  局域网访问 / 版本与升级 / 事件日志 / 设置 六个功能页。
  未来新功能（插件市场等）以新增导航项方式扩展。
- 每页全宽布局，消除卡片堆叠导致的参差高度；
  操作按钮统一锚定区块底部。
- 顶栏简化为单一系统状态徽标；期望状态详情保留在概览页。

## [0.10.0] - 2025-08-22

### 重构（面板 UI 全面重设计）
- **布局**：12 列栅格分区式排版——核心监控(7列)+中转服务(5列)、
  版本与升级(5列)+局域网访问(7列)、时间线与服务位置通栏。
  同行卡片等高拉伸，消除参差不齐。
- **视觉层级**：运行状态卡新增大字阶段指示（呼吸状态点），
  关键指标网格化；每卡带类型标签（DSH/LLM Relay/Update/LAN）。
- **操作锚定**：所有操作按钮统一贴卡片底部（margin-top:auto），
  跨卡对齐一致。
- **顶栏**：单一系统状态徽标 + 图标化设置按钮；移除期望胶囊。
- **细节**：阶段呼吸动画、卡片头部渐变、二维码投影、
  服务位置表新增局域网入口行。

### 说明
- 纯前端重构，后端零改动；全部元素 id 保持不变。

## [0.9.3] - 2025-08-22

### 调整（面板 UI）
- 大模型中转服务卡片移至「版本与升级」之后，内部重排为
  状态行 / 统计网格 / 操作按钮 / 按模型统计 四层结构，间距规范化。
- 顶栏简化：移除「期望」胶囊，单一「系统状态」徽标展示运行阶段
  （期望状态详情保留在运行状态卡内）。

## [0.9.2] - 2025-08-22

### 修复
- **客户端断开被误判为上游故障**：长流中用户主动停止（DSH 停止生成、
  客户端超时等）会错误地给当前 Key 施加怀疑冷却，反复触发会劣化整个 Key 池。
  现已区分：客户端断开仅清理连接；上游异常断流才施加冷却。
- 补充上游无 error 无 end 直接关闭 socket 的兜底处理。
- 新增转发连接级超时（15s），防护 TCP 黑洞/握手挂死；
  响应头到达后自动解除，长流不限时长。

## [0.9.1] - 2025-08-22

### 清理与修正（全面代码审计）
- 移除死代码：supervisor._deliberateRestart、keypool.addKeys、
  /switcher/add-keys 路由、面板孤儿 addKeys 函数、
  死 CSS（.sw-add/.sep/.lan-url）、未使用的 killWaitMs 配置项
  （DEFAULTS/config 模板/README/DESIGN 同步清理）。
- 统一：CLI `events` 命令改用与自定义配置一致的日志路径解析。
- 中转代理成功路径生命周期重构：区分客户端断开（仅销毁上游连接）与
  上游异常断流（怀疑冷却+事件），并处理上游过早关闭（aborted 事件）。
- usage 提取支持嵌套子对象（括号计数），修复统计恒为零。

## [0.9.0] - 2025-08-22

### 新增
- **中转服务稳定性重构**（长任务断流根治）：
  - 监听器 `requestTimeout=0`、双侧 TCP keepalive 15s、上游连接池复用——
    长流不限时长、抗 NAT 断链、重连更快；
  - 连接级失败：30s 短冷却轮换下一键并清粘滞（修复原版"同坏键反复尝试后放弃"）；
  - 流中断观测：记录 STREAM_ABORTED 并对键施加 60s 怀疑冷却引导后续请求；
  - 客户端断开：响应前中止上游请求，响应中销毁透传管道，不泄漏连接。
- **流式 Token 统计**：自动注入 `stream_options.include_usage`
  （上游不认时自动去字段重试一次），SSE 尾部 usage 括号计数提取
  （支持嵌套 details 子对象）；成功但无 usage 的调用计入请求数。
- **失败计数**：totals.errors 统计最终失败请求数。

### 安全
- 含密钥/令牌/用量数据的文件以 0600 权限落盘；已有文件加载时自动收紧权限。

### 修复
- 中转代理注入回退逻辑的变量残留与顺序问题整体清理。

## [0.8.2] - 2025-08-22

### 修复
- **嵌套 usage 对象解析失败**：上游返回的 usage 内含
  `prompt_tokens_details` 等子对象，正则 `[^{}]*` 截断导致 JSON.parse 失败、
  统计恒为零。改为 lastIndexOf 定位 + 括号计数提取，支持任意嵌套。
  现网实测：经中转的真实调用已正确计入明细与按模型累计。

## [0.8.1] - 2025-08-22

### 修复
- **用量统计恒为零的根因**：usage 提取正则缺少捕获组，`m[0]` 携带 `"usage":` 前缀
  导致 JSON.parse 必然失败。改用捕获组取花括号部分后解析。
  实测经中转的真实调用已正确计入明细与累计。

## [0.8.0] - 2025-08-22

### 新增：OpenCode 中转（原生实现，替代退役的 opencode-switcher）
- `src/keypool.js` 多账号 Key 轮换代理：粘滞活跃键→顺序游标轮换；
  仅 429/403+额度关键词触发冷却（Retry-After / Reset 头 / "Resets in N min" 解析，
  缺省 5 小时）；SSE 与普通响应透传；joinUpstream 的 /v1 去重与 Go 版逐条对齐。
- 冷却状态持久化（重启不丢）；首次启动自动无损迁入旧版
  ~/.config/opencode-switcher 的配置与冷却状态。
- 面板新增「OpenCode 中转」卡片：运行状态、Key 池列表（当前使用/可用/冷却倒计时）、
  启动/停止、追加 Key、单键移除、额度探测（消耗极小额度）、管理页直达。
- 守卫 API 新增 /switcher/*（status/start/stop/config/test/logs/add-keys/remove-key/
  stop-legacy）；旧版进程一键接管（精确终止其代理二进制）。
- 配置项：switcherPort/switcherUpstream/switcherAutoStart/switcherLegacyDir。

### 说明
- 退役旧版后建议 `sudo dpkg -r opencode-switcher` 并关闭其 GUI 自启；
  本模块占用同一端口 8787，DSH 的 plan 模型指向不变，切换无感。

## [0.7.1] - 2025-08-22

### 调整
- 局域网访问卡片视觉重排：二维码加大加投影、区块间距规范化；
  移除二维码下方地址文字（令牌已嵌入二维码，无需暴露地址）；保存按钮升级主色。

## [0.7.0] - 2025-08-22

### 新增
- **局域网访问卡片**：主界面新增独立卡片——二维码扫码直进（自动携带令牌）、
  局域网地址展示、访问令牌面板内设置（保存即持久化并热生效）。
- 反代对 HTML 文档响应附加 `Cache-Control: no-store`，杜绝局域网设备拿到陈旧页面。

### 修复
- **局域网源 RPC 全废的根因**：`crypto.randomUUID` 为 secure-context-only API，
  非回环 HTTP 源上不存在，而 DSH 客户端用它铸造每个 RPC id——缺失导致所有请求抛错、
  WS 就绪握手失败。反代现向 HTML 注入等价 polyfill（</head> 前执行），
  实测 workspace.list/settings.describe 等经代理与直连返回一致。
- 令牌门卫顺序错误导致"URL 令牌放行并种 Cookie"分支不可达。
- HTML 响应附加 `Cache-Control: no-store` 防设备陈旧页面。
- 已知上游限制：设置**写入**作用域由前端按页面地址选择（非回环=浏览器内存态），
  局域网设备的设置修改在重载后不落盘；读取/展示与桌面完全一致。
  该门禁随官方认证层演进，反代层无法在不篡改前端代码的前提下安全解除。

## [0.6.0] - 2025-08-22

### 新增
- **局域网全权限访问**：反代对 `/api` 与 WebSocket 握手做回环呈现
  （Origin/Referer 改写为回环权威），DSH 浏览器信任围栏将代理流量视为本机，
  设置/Agent 预设/模型/插件等特权配置面在局域网完整可用。
- **反代层可选令牌**（`lanToken`）：首次凭 `?token=` 进入自动种 HttpOnly Cookie，
  常数时间比较；令牌只存在于反代层，不进入 DSH。

### 边界声明
- 遵循硬边界：以上全部在守卫反代层实现，**不改动 DeepSeek Harness 的任何源码、
  配置文件，也不安装任何插件**；DSH 本体保持只听回环。

## [0.5.0] - 2025-08-22

### 新增
- **局域网访问 DeepSeek Web**：守卫内置反向代理（默认 0.0.0.0:3088 → 127.0.0.1:3080），
  局域网设备经 IP 直接使用与桌面端同步的 DSH Web；支持 WebSocket 透传；
  DSH 本体保持只听回环零改动；面板设置中心一键开关。
- **顶栏设置中心**：⚙ 设置按钮聚合配置项；「开机自动启动服务」升级为整条服务链
  开关（systemd 单元 + linger + GUI 自启条目），登录后守卫、DSH、面板全部就位。

### 修复
- 面板按钮可用状态与守卫实际可执行动作严格对齐（重启仅在受管运行时可用等）；
  控制区与上方内容间距规范化。

## [0.4.0] - 2025-08-22

### 新增
- **界面版本信息**：顶栏版本徽标 + 版本卡守卫大字版本；「更新日志」弹层直读 CHANGELOG。
- **一键安装 DeepSeek Harness**：未安装时版本卡提供在线安装按钮（全新安装路径，
  装完按期望状态自动拉起）；守卫对"命令不存在"进入 60s 冷静期并不再刷崩溃计数。
- **面板内登录自启开关**：设置卡直接切换（GET/POST /gui-autostart）。

### 修复
- **期望停止时不再"失明"**：发现无主运行实例进入 OBSERVED 观测模式——
  如实展示运行状态与 pid、不强杀不拉起；「启动」同一实例无缝转正纳管，
  「停止」显式终止。修复"DSH 明明在跑，守卫却显示没检测到"。
- GUI 启动时若守卫未运行，自动尝试 systemctl 拉起。

## [0.3.0] - 2025-08-22

### 新增
- **系统托盘常驻**：Tauri 托盘图标 + 菜单（显示面板 / 启动 / 停止 / 重启一次 / 退出）；
  关窗即隐藏到托盘，守卫状态随时可达；菜单动作经裸 TCP 直发本地 API，零新增依赖。
- **桌面通知**：崩溃进入退避、升级完成/失败/回滚失败、hold 超时等关键事件经
  `notify-send` 触达（`notifyEnabled` 可关；环境不支持自动静默停用）。
- **GUI 自启与入口纳管**：`.desktop` 模板入库；`install` 自动部署菜单入口与图标；
  `dsh-supervisor gui-autostart on|off` 控制登录自启面板。

## [0.2.0] - 2025-08-22

### 新增
- **版本管理**：package.json 为单一版本源；`dsh-supervisor --version` 自报版本；
  `/status` 返回 `guardVersion`；`guard_started` 事件携带版本号。
- **日志管理**（三路分文件、分级、统一轮转，保留一代 `.1`）：
  - `supervisor.log` 守卫运行日志（debug/info/warn/error，`logLevel` 可配）
  - `dsh.log` 被监管目标 stdout/stderr（行缓冲还原完整行）
  - `upgrade.log` npm 安装原始输出
  - CLI 新增 `dsh-supervisor logs [name] [N]`
- `src/pidlookup.js`：/proc 按端口反查进程 pid，接管既有实例可被 stop / 升级。
- API 安全边界：Host 本机校验、POST Origin 校验、移除 CORS `*`、CSP/nosniff 头。
- 测试扩至三套件（core / smoke / upgrade），覆盖 §12 全部用例与安全边界。
- LICENSE（MIT）与 `npm test`。

### 修复
- systemd unit 的 `StartLimitIntervalSec/Burst` 移入 [Unit] 段（原写于 [Service] 被
  systemd 忽略，崩溃循环保护实际失效）。
- 控制端点透传结果：拒绝时返回 409 与原因，不再假成功。
- 配置缺省 `stateFile/logFile` 时事件与状态静默丢失 → 补内置默认值；
  `healthUrl` 非法改为 fail-fast。
- CLI 控制命令此前无视 `-c`/`DSH_SUPERVISOR_CONFIG` 自定义配置。
- RESTARTING/BACKOFF 重启前复查端口占用，不再对占端口的不健康进程反复 spawn 计崩溃。
- 守卫 shutdown 清理升级定时器；崩溃窗口跨守卫重启持久化。
- 非法版本号不再被静默当作"已是最新"。

### 变更
- **升级流程改为"先停后装"**：停 DSH → 安装 → 自动拉起 → 健康验证；
  失败自动回滚旧版并恢复运行。消除运行中替换文件的混合版本窗口
  （行为变化：安装失败时 DSH 会以旧版本重启而非保持原进程）。
- SIGTERM/SIGKILL 发往进程组（detached spawn），DSH 子进程一并退出。
- 事件日志按大小轮转（`eventsMaxBytes`）。

## [0.1.0] - 2025-08-21

### 新增
- 首个可用版本：期望状态调和状态机、两层健康探测、崩溃退避、
  127.0.0.1:3100 本地 API 与运维面板、Tauri 桌面壳、systemd user unit 安装器、
  版本监测与一键升级（回滚）、mock 冒烟测试。
