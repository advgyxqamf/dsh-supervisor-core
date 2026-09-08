# dsh-supervisor 代码审计报告

> 审计对象：/home/bowen/develop/plus/dsh-supervisor（v0.1.1-BETA.1，约 2.3 万行 JS + Rust/React 壳 + 构建/发布脚本）
> 审计方式：**只读**，未修改任何项目文件。全部发现经源码上下文核对，关键问题做了运行时实测复现；并对照项目自带 CODE_REVIEW.md 排除已修复项。
> 审计方法：逐行精读核心（supervisor.js 状态机、guard 生命周期、relay/api/bin/platform），7 路子代理覆盖全部 src/、bin/、scripts/、src-tauri/、ui-react/，npm test 实跑验证。

## 一、执行摘要

| 级别 | 数量 | 代表问题 |
|---|---|---|
| P0（安全） | 1 | 回环判定仅凭可伪造的 Host 头 → 局域网可窃取 DSH 会话令牌、绕过访问密钥 |
| P1（严重） | 5 | adopt 观察窗被未初始化字段绕过（实测 565ms 即重建 DSH）；畸形 URL 3 连崩守卫；upgrade-test 已成回归（6 项 FAIL）；shutdown 期望状态竞态；锁文件 fail-open 双守卫 |
| P2 | 12 | UI 缺失崩溃环、升级作业永久卡 running、同步 systemctl 冻结事件循环、ctl 面无 catch 等 |
| P3 | 20+ | 死迁移分支、CLI 参数 off-by-one、版本比较用字符串、事件轮转窗口等 |

测试现状：`npm test` 实际退出码为 **1**（8 passed / 6 failed），失败项为 upgrade-test 的升级后自动拉起断言——根因是 commit 2b82db2（守护开关默认关）引入后仅对齐了 smoke 等测试，upgrade-test 未同步（commit 5da1922 遗漏）。此前"全绿"的表象是因为失败输出被管道 tail 截断且脚本未以非零码暴露。

---

## 二、P0/P1 严重问题（已逐一实测或双人复核）

### P0-1 回环判定只看 Host 头 → 令牌泄露 + 访问密钥绕过
- **位置**：src/api/index.js:225-244、:125-138（hostAllowed）；泄露点 src/api/instances.js:28-30, 84-90
- **事实**：全仓库 grep `remoteAddress` 为 0 处。`reqFromLoopback = isLoopbackHostname(req.headers.host)` 完全信任客户端伪造的 Host；`hostAllowed` 对"声称 RFC1918"的 Host 一律放行，不校验真实源 IP。
- **后果**：
  1. 局域网设备发 `Host: 127.0.0.1:3100` 的 GET /instances → 响应携带每个实例（含 main 原生 DSH）的**会话令牌**（authUrl ?token=...），可完整接管 DSH Web。注释宣称的"token 永不出本机（审计修复 F1）"被一个请求头击穿。
  2. 同一手法定 `reqFromLoopback=true`，`apiAccessKey` 门卫（0.0.0.0 局域网模式下唯一 API 认证）整体失效。
- **修复**：回环判定改用 `req.socket.remoteAddress`（含 ::ffff: 映射处理）；Host 头仅保留防 DNS-rebinding 用途。

### P1-1 adopt 令牌观察窗被未初始化字段完全绕过（实测复现）
- **位置**：src/supervisor.js:2342-2370（`_maybeReclaimAdoptToken`）；字段 `_tokenReclaimAt` 全文件**从未初始化**（grep 仅 3 处赋值 null/时间戳，构造器无定义）
- **逻辑链**：首次进入时 `this._tokenReclaimAt === null` 为 false（实际是 undefined）→ 跳过"启动观察窗"分支 → `Date.now() < undefined` 恒 false → **首拍立即穿透**到"受控重建"。
- **实测**：起守卫 → RUNNING → SIGTERM 杀守卫 → 新守卫 adopt 同一 pid → **565ms** 后即触发 `adopt_token_reclaim_started` 并杀掉重启 DSH（代码语义应为观察 20s；测试 smoke 用 tokenReclaimGraceMs=3600000 拉满掩盖了此问题）。
- **附带**：adopt-token-reclaim-test.js 因显式 `sup._tokenReclaimAt = null` 播种，单元测试无法暴露该缺陷。
- **影响**：守卫每次重启/接管，用户 DSH 都会被无谓杀掉重建一次（会话中断），与设计"免重建会话中断"背道而驰。
- **修复**：构造器初始化 `this._tokenReclaimAt = null; this._tokenReclaimTried = false;`（或判 `== null`）。

### P1-2 畸形 URL 未捕获 URIError → 无认证远程 3 连崩守卫
- **位置**：src/api/lifecycle.js:32 `const id = decodeURIComponent(parts[0]);`（无 try）；分派层 src/api/index.js:272-274 无兜底；放大器 bin/dsh-supervisor:214-229（60s 内 3 次 uncaughtException → exit(1)，systemd Restart=always）
- **实测**：`decodeURIComponent('%E0%A4%A')` 抛 URIError。攻击者循环发 3 个 `GET /lifecycle/%E0%A4%A` → 守卫退出重启 → 重复，形成无人值守的守卫重启循环，监管能力反复中断。
- **修复**：解码包 try/catch 返 400；分派层对 `d.handle(ctx)` 统一兜底（纵深防御）。

### P1-3 upgrade-test 6 项失败 = 守护开关引入后的未对齐回归
- **实跑**：`npm test` 退出码 1；upgrade-test U2/U3/U4 的"升级后 DSH 恢复 RUNNING / 进程已替换 / 崩溃窗口不计数 / 失败回滚恢复"全部 FAIL（升级终态超时 null）。
- **根因链**：commit 2b82db2（2026-09-07，"原生 DSH 守护开关默认关"）给 STOPPED 自动拉起分支加了 `_mGuardian()` gate；但 upgrade-test 的 makeConfig 从未写 dsh-main.json（guardian=false），升级完成后的自动拉起被 gate 拦截，`_waitNativeHealthy` 超时。commit 5da1922"测试对齐新守护语义"只改了 smoke/lifecycle-mirror/guard-update，**漏掉 upgrade-test**。
- **影响**：不仅是测试问题——它暴露**产品语义矛盾**：README 承诺"一键升级……自动拉起"，但 guardian 关（默认）时升级后 DSH 不会自动恢复，用户升级完服务即下线，需手动点启动。
- **修复**：native 升级完成后经 `_explicitAction` 穿透一次拉起（升级本身即用户显式意图）；同步对齐 upgrade-test。

### P1-4 shutdown 链路"期望状态翻转"竞态（设计红线冲突）
- **位置**：src/supervisor.js:462-503（shutdown）、:495 `this.lifecycleManager.stopAll('guard-shutdown')`（**未 await**）→ adapters.js:108 dsh 的 stop 回调 = `setDesired('stopped')`
- **矛盾**：代码注释自称"守卫退出不动 DSH，恢复后幂等调和"、README 将其列为硬约束；但 stopAll 的确会把 dsh 项 stop → setDesired('stopped') 并持久化。
- **实测**：SIGTERM 后立即 process.exit(0)（bin:208），stopAll 的异步链通常被掐断——probe 中 desired 保持 running；但这纯属"exit 赢了竞态"。若事件循环恰好多跑几拍（如 stopAll 前面模块的 stop 较快），desired 将被**永久持久化为 stopped**，守卫重启后 DSH 不再被拉起。行为不确定性本身就是缺陷。
- **修复**：shutdown 里显式豁免 dsh（对齐"不动 DSH"语义），或同步翻转前保存/恢复 desired；不要依赖 exit 竞态。

### P1-5 守卫单实例锁 fail-open → 双守卫并存
- **位置**：bin/dsh-supervisor:143-175 `acquireLock`
- **分析**：`openSync(LOCK_FILE,'wx')` 遇 EACCES 等非 EEXIST 错误**直接放行启动**（注释"不阻塞启动"）。锁写失败时后续持有者检测全废——两个守卫并存则双写状态文件、双心跳、竞态 spawn（注释 L135 自己列出的全部风险成立）。
- **修复**：非 EEXIST 错误 fail-closed。

---

## 三、P2 问题

**守卫可用性/健壮性**
1. **UI_DIR 为 null 时 serveStatic 抛 TypeError**（api/index.js:54-58, 295-302）：UI 缺失的部署首次 GET / 即同步抛错 → 复用 P1-2 的 3 连崩机制形成稳定崩溃环。应 503 或 fail-fast。（api 审计线实测）
2. **stopInstance 同步 execFileSync 无 timeout**（instance/index.js:829）：systemctl/dbus 挂起则整个守卫事件循环无限冻结。同文件其他 systemctl 调用都带 timeout，此处遗漏。（api 审计线）
3. **沙箱升级后台 IIFE 无外层 catch**（instance/index.js:495-608）：runNpmInstall 等一旦 reject → 任务永久 running → `isBusy` 恒 true → **该实例启停/升级永久锁死**，只能重启守卫。（api 审计线）
4. **router/plugins 域 9+ 处 Promise 链缺 .catch**（api/router.js:51,60,76,86,91,96,134,139,144 等）：daemon 失联时请求永不响应 + unhandledRejection 成片。（api 审计线）
5. **API 域分派无同步异常兜底**（api/index.js:272-274）：任何一处同步 throw 都升级为守卫自杀（P1-2 即实例）。

**日志/事件系统**
6. **EventHub 聚合流水位前推不回头**（platform/loghub.js:190-198）：转写写盘失败仍推进 watermark → 磁盘瞬满期间守卫事件永久丢失；pushGuard 落盘间隙崩溃则重启后重复转写。（platform 审计线）
7. **Events.readSince 与 readAll 判据不一致**（platform/events.js:136-157 vs 183-198）：meta 损坏回退时 rotatedSeq=null，游标落在旧代文件的客户端事件"消失"，两个读路径结果矛盾。（platform 审计线）
8. **EventHub 潜在递归污染**（platform/loghub.js:123 + events.js:129-132）：config.logFile 若被用户配成聚合流同路径 → pushGuard→writer.appendRaw→再 pushGuard 无界同步递归。构造时无路径相等断言。（platform 审计线；默认配置不触发，属配置错误引爆点）

**token/并发**
9. **DshTokenService.capture 内 execFileSync(journalctl, 5s)**（platform/token.js:140）在心跳路径同步执行：journalctl 卡顿直接冻结守卫心跳；ensureCaptured 的"检查-后-动作"无 in-flight 防护（单进程内暂安全，与 P1-5 叠加即双守卫重复广播）。（platform 审计线）
10. **extractTarGz 符号链接目标不校验**（platform/fs-utils.js:47-51）：tar-slip 二段写可落盘到 destDir 外（调用方 self-update 有 sha256 缓解，强度=完全信任分发源）。（platform 审计线）
11. **端口回收 reclaimCfg 引用不存在的字段**（relay/manager.js:274 `(this.instances && this.instances.configPath) || ''`——InstanceManager 无 configPath 字段，恒空串）→ 回收匹配仅按 cmdMark 'lan-daemon.js'，**同机其它配置的 lan-daemon 会被误杀**（pgrep -af 匹配 + 仅排除自己/受管代/ctl 属主）。我亲证（relay 精读）。
12. **events.js 轮转 unlink+rename 两步非原子** + append 失败仍消费 seq（platform/events.js:92-98, 116-128）：崩溃窗口丢一代/重号。（platform 审计线）

---

## 四、P3 问题（择要）

**逻辑/语义**
- `switcherAutoStart` 旧键迁移分支死键（config.js:93-94，DEFAULTS 已给 routerAutostart=false 遮蔽 undefined 判断；persistConfigPatch 又无条件删旧键）→ **旧用户 routerAutostart=true 被静默重置 false**。我已用 node 实测确认。
- bumpCrashWindow 的 crashBurst=1 语义偏差（guardian/index.js:27-29，先自增再比较；默认 5 不受影响）。
- `isDshCmdline` 匹配过宽（pidlookup.js:159-163，实际只查"含 dsh 子串"）→ 接管/回收可被同机含 dsh 字样的进程碰瓷。
- Events.readSince 游标丢事件 / plugins 域 `indexOf('refresh=1')` 子串误判 / collectBody 按 UTF-16 码元计量 / TaskRegistry._load 不清 _current 索引。

**工程/运维**
- CLI `events [N]` 读 argv[4] 恒默认 50（bin:399-400，usage 写 events [N]）。
- CLI 兜底端口 3100 与内核默认 36360 不一致 → 无配置时 status 恒"未运行"误导。
- bump.sh 用字符串比较做版本回退门禁（0.10.0 < 0.2.0 误判，双向失效）。
- `/guard/changelog` 发行态恒 404（CHANGELOG.md 不随产物分发）；guardVersionCheck 依赖 git 仓库布局。
- notify() Windows 分支 NotifyIcon 泄漏、失败不降级；hasTool 能力探测进程级永久缓存；env-catalog Windows 恒报 npm missing。
- verify-versions.js 壳版本缺失静默通过；build-sea.sh 依赖 PATH node 而非 process.execPath；Rotator 每行 statSync + 无跨进程锁。
- systemd unit KillMode=process 的管辖区间缺口（守卫被 SIGKILL 时 DSH 成孤儿，靠端口探测接管兜底——设计确认项）。
- smoke.js 中途异常不清理守护/mock 进程 → **跨运行互相污染**（本次审计实测：残留 mock 3901/3921 导致 S6/S8/S10 失败点漂移，清理后 34/34 全过）。
- facade `_makeCtlFacade` BANNED 词表缺 `__proto__`（node 实测 `p.__proto__()` 可达）——ctl 仅回环信任模型下低危。

---

## 五、确认无恙的高危面（排除误报）

- /lan-access、listLan 输出经 sanitize 白名单剔除 token/dshToken（token-boundary-test 三路径覆盖）。
- safeKeyEqual 常数时间比较实现正确；静态服务路径穿越防护（relative 校验 + 白名单）有效。
- 端口注册表 claimSlot 的绑定/回收/迁移状态机与 DaemonLifecycle 的换代不变量（TERM→验死→验端口→spawn、spawn latch、身份文件 owner 连续）实现严谨，测试覆盖到位。
- setFrp 有 remoteToken 安全闸（公网暴露强制令牌）；frp 端口冲突校验完整。
- 崩溃窗口/退避（默认 crashBurst=5、五级退避）主语义正确，crash-loop 有 smoke 覆盖。

## 六、修复优先级建议

1. **立即**：P0-1（remoteAddress 判定）+ P1-2（decodeURIComponent + 分派兜底）——两者都是几行的修复，却堵住无认证远程攻击面。
2. **本周**：P1-1（初始化两个字段）、P1-3（升级后 explicit 拉起 + 对齐 upgrade-test，让 npm test 回绿）、P1-5（锁 fail-closed）、P2-3（补 timeout）。
3. **下一迭代**：shutdown 语义收敛（P1-4）、升级 IIFE 兜底、ctl 面补 catch、loghub 水位/断言、P1-5 关联的双守卫场景测试。
4. **随手清理**：P3 中的死迁移、CLI off-by-one、bump.sh 版本比较、smoke 测试卫生（killDaemon 后统一 pkill 兜底）。

## 七、审计覆盖说明

- **逐行精读**：src/supervisor.js（3178 行全量）、src/guard/{lifecycle/{objects,adapters,ports,index,managed},monitor/{probe,index},guardian/index,proc/daemon-lifecycle,health}.js、src/platform/{config,events,token,version,logcore,loghub,os/pidlookup}.js、src/domains/relay/{manager,index,daemon}.js、src/api/{index,lifecycle,instances,relay,tasks,guard}.js、bin/dsh-supervisor。
- **子代理全量覆盖**：platform+bin+scripts+systemd（24 条发现）、api 层（12 条）、guard 域、router 域、relay/plugin/dist 域、instance 域、src-tauri/ui-react/构建脚本。
- **实测复现**：adopt 观察窗绕过（565ms）、SIGTERM desired 竞态、switcherAutoStart 死迁移、facade __proto__、npm test 退出码 1 及 upgrade-test 回归定位（git 考古到 commit 粒度）、残留进程污染测试的复现与清理验证。
- **未深挖**：ui-react 前端组件逻辑（仅安全面检查）、src-tauri Rust 细节、providers/base.js 配额策略细节、frpmgr 的 toml 生成——建议作为二轮补充。
