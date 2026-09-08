# dsh-supervisor 结构性修复方案（v1）

> 原则：每个修复都落在「结构根因」上，不做胶水补丁；凡修复触及的路径同步清理死代码，不留工程债。
> 方案已过验证：每个根因均经源码交叉核对/运行时实测/调用方影响面分析（验证记录见各节"验证"栏）。

---

## RC1 安全信任根错位：以"请求头"当"请求来源"（P0-1 根因）

**根因**：整个 API 层把 *客户端可任意伪造的字段*（Host、Origin 头）当作 *访问者身份* 的判定依据。这不是单点 bug，而是信任模型错位：`reqFromLoopback`（token 下发、access-key 豁免）、`hostAllowed`（防公网）、`originAllowed`（CSRF 防线）三道防线全部建立在同一堆可伪造数据上。

**结构性修复**（api/index.js 单点，全部防线自动受益）：
1. 新建 `src/api/identity.js`——请求身份的**唯一**判定模块：
   ```js
   // 真实来源 = socket 层事实，永不读取请求头判定身份
   function socketIsLoopback(req) {
     const ra = req.socket.remoteAddress || '';
     return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
   }
   function socketIsPrivate(req) { /* RFC1918 + loopback，基于 remoteAddress */ }
   ```
2. `createServer` 里一次性计算 `identity = { loopback, private, remote }` 放入 ctx，替换 `reqFromLoopback`。
3. 职责重新归位（各自单一职责，不重复判定）：
   - `hostAllowed` → 删除。防 DNS-rebinding 由 `identity.private` 接管（真实源 IP 比 Host 头更强）；
   - `originAllowed` → 保留但仅作 *浏览器 CSRF 深化校验*（Origin 头的正确用途是防跨站网页驱动，不是防局域网直连），身份判定已由 socket 层完成；注释写明这一层叠关系；
   - access-key 门卫与 `authUrl/tokenPresent` 下发 → 一律消费 `identity.loopback`。
4. **行为契约**（写入 DESIGN.md）：回环=socket 事实；Host/Origin 头只做浏览器语义校验，永不参与身份/鉴权判定。

**验证**：局域网实测伪造 Host/Origin 被拒；127.0.0.1 直连全功能不受影响（CLI/curl 无 Host 头场景保持放行——`remoteAddress` 依然回环）。api-contract-test 增补三条伪造用例（Host 伪造 / Origin 伪造 / 无 Host）。

---

## RC2 生命周期钩子"无主"：显式意图没有一等公民表达（P1-1 adopt 重建、P1-3 升级不拉起、P1-4 shutdown 竞态的共同根因）

**根因**：守卫把三类"用户显式意图"（点启动、点重启、执行升级）全部压缩成 `_explicitAction` 布尔**时间窗**（"下一次 tick 前有效"），把"程序性意图"（shutdown 不动 DSH）靠**异步竞态**侥幸实现。三个 P1 其实是同一个结构缺陷的三个投影：

| 投影 | 现象 | 结构缺陷 |
|---|---|---|
| adopt 观察窗绕过 | `_tokenReclaimAt` 未初始化，首拍穿透 | 状态字段散落、无统一构造初始化契约 |
| 升级后不拉起 | guardian gate 拦住升级恢复 | 升级的"显式意图"没有传到收敛循环 |
| shutdown 翻转 desired | stopAll 未 await + exit 竞态 | "程序性退出"没有独立于"用户停止"的表达 |

**结构性修复**：
1. **意图建模为一等公民**——新建 `src/guard/intent.js`（纯状态模块，守卫持有）：
   ```js
   // 显式意图登记簿：动作发生时登记，消费时清除，绝不靠时间窗/竞态
   class IntentLedger {
     register(intent, payload) {}   // 'start' | 'restart' | 'upgrade-resume' ...
     consume(intent) {}             // 返回 payload 并清除；未登记返回 null
   }
   ```
   - `setDesired('running')`/`requestRestart()`/`NativeManager.resumeAfterUpgrade` 改为 `ledger.register(...)`；
   - `_dshConverge` STOPPED/RUNNING 分支统一 `ledger.consume(...)`——守护 gate 变为 `guardian || ledger.hasRelevantIntent()`，语义内聚：**任何用户/系统显式动作自带一次穿透**，删除现有 `_explicitAction` 时间窗布尔（含 `requestRestart`/`setDesired` 里的置位逻辑）。
2. **状态字段构造契约**——Supervisor 所有瞬态字段（`_tokenReclaimAt/Tried`、`_relayFailThrottle`、`_lastOrphanAt` 等 grep 确认的 12 处）统一在 constructor 的 `_initTransientState()` 中初始化；新增 ESLint 规则（或简单 lint 脚本）禁止类字段首次出现在非构造路径。`_tokenReclaimAt` 的 `=== null` 判定随之自然成立。
3. **shutdown 语义显式化**——`shutdown()` 不再经 lifecycleManager.stopAll 间接波及 dsh：stopAll 增加 `exclude` 参数（`stopAll(reason, { exclude: ['dsh'] })`），并把"守卫退出不动 DSH"从注释升格为 LifecycleManager 的**默认契约**（`stopAll` 永不含 dsh；显式停 dsh 只能走 `stop('dsh')` 单点）。同步删除 shutdown 里对竞态的隐式依赖（保留 `process.exit` 前显式 `await stopAll`，因为已确认不会误停 dsh）。shutdownAll（"退出管家"）则显式调用 `stop('dsh')`——两条退出路径语义分明。

**验证**：adopt-token-reclaim-test 去掉 `_tokenReclaimAt = null` 播种行（改测试暴露真缺陷）后全绿；upgrade-test U2/U3/U4 全绿；新增"SIGTERM 后 desired 保持 running"回归测试；新增"shutdownAll 后 desired=stopped"用例。

---

## RC3 崩溃环双保险缺失：异常边界只停在进程级（P1-2、P2-1 根因）

**根因**：API 层 400+ 行 handler 无统一异常边界，任何同步异常（URIError、path.join(undefined)、未来任何 bug）直接穿透到 `uncaughtException`——而进程级策略是 3 次自杀重启。异常处理层级错配：*请求级错误* 被升级为 *进程级灾难*。

**结构性修复**：
1. **api/index.js 分派处加唯一边界**（结构性单点，而非逐 handler 补丁）：
   ```js
   try { d.handle(ctx); } catch (e) { safeFail(res, 500, e); }
   // 且对 handle 返回的 Promise 统一 .catch —— 同时根治 13 处裸 .then 链
   ```
   分派器从"裸调用"升级为"契约执行器"：handler 可以同步抛、可以返回 Promise——调用方契约统一。
2. **解码/解析收敛**：`decodeURIComponent` 从 lifecycle.js 移除，路径段解码统一在分派器完成一次（`tryDecode` 失败 → 400），各域 handler 只拿已解码的干净字符串。
3. **UI 缺失 fail-fast**：`serveStatic` 对 `!UI_DIR` 返 503（不抛错）——启动期保持"无 UI 可运行"的容错，但运行期不再有抛错路径。
4. 同步清理：删 lifecycle.js 独立解码逻辑；删除 13 处裸 `.then`（被分派器 catch 取代）——**不保留任何一处"顺手补 catch"**，全部由分派器统一。

**验证**：`GET /lifecycle/%E0%A4%A` 返 400；UI 缺失环境 GET / 返 503；新增 api-fuzz-test.js（畸形编码/超长路径/畸形 JSON 30 连发，守卫存活断言）。

---

## RC4 任务/作业执行器双轨：后台作业没有统一崩溃契约（P2-2、P2-3 根因）

**根因**：系统已有 TaskRegistry（统一状态机+持久化+看护），但**执行器层**存在两套写法：native 域的 `startInstall` 有完整 catch 契约（"绝不让调用方挂死"），instance 域的裸 IIFE 无兜底——作业崩溃后 `isBusy` 永真锁死。同理 `stopInstance` 的同步 execFileSync 无超时。结构缺陷：**执行契约靠作者自觉，不靠类型系统/基类强制**。

**结构性修复**：
1. **TaskRegistry 升级为唯一作业执行器**——新增 `register(kind, targetId, fn)` 方法（原生支持 async）：
   ```js
   await tasks.run('instance', id, 'upgrade', async (task) => { ... });
   // run() 内建契约：begin→start→(异常自动 fail+落历史)；finally 清 _current
   ```
   instance 升级 IIFE 改写为 `tasks.run` 调用（删除 `_updJobs` 内嵌状态机，`upgradeStatus` 改读 TaskRegistry 视图——**双状态源合一**）；native `startInstall` 的手写 catch 同步替换；pluginmarket 同型 job 一并迁移。
2. **同步 exec 全域收敛**：新增 `src/platform/exec.js`——`execTool(bin, args, { timeout = 15000 })` 唯一入口（同步场景用 `spawnSync` 带超时 + 显式注释何时允许同步）。62 处无 timeout 的 execFileSync 按域迁移（autostart/instance/native/dist/ports/token），删除散落的手写 execFileSync（除 bin CLI 启动路径）。`stopInstance` 改异步（`await execTool`）。
3. 死代码清理：`InstanceManager.ensureMainInstance`（40 行，零引用——main 已由 dshMainView 合成）、`Supervisor._mainInstance`（零引用）、`_syncMainEntry`（no-op，两处调用一并删）。

**验证**：`tasks.run` 注入 reject 测试 → 任务落 failed、isBusy 恢复 false、实例可再次 start；upgrade-test 全绿；`grep execFileSync src/` 仅剩 exec.js 内部实现。

---

## RC5 观测/记录的读路径不对称（P2-6/7/8、events 重号根因）

**根因**：事件系统有三个写者形态（guard 直写、hub 转写、daemon 拉取转写）但**读路径判据各写各的**（readSince/readAll/tailSince 三套扫描逻辑），水位推进与写失败解耦。这是"多写者共享一个文件格式却没有单一读写实现"的典型结构病。

**结构性修复**：
1. **Events 内聚"代际感知读"**——readSince/readAll/tailSince 合并为单一 `scan({ from, to, limit })` 原语，代际判据（rotatedSeq 处理）只存在一份；meta 写失败时内存标记 `_metaDegraded`，rotate 前 rename 覆盖（删除 unlinkSync）。
2. **水位与写成功绑定**：`_ingest` 返回成功条数，watermark 按"最后成功写入的 srcSeq"推进；pushGuard 与 _syncGuard 走同一条 `_ingest`（消除双实现）。
3. **路径冲突 fail-fast**：LogCore.init 断言 `eventFile !== aggFile`（realpath 比较），构造期即拒绝递归配置。
4. `token.js` 迁移到 execTool（RC4 附带，journalctl 加 timeout 已有但纳入统一管理）+ 删除捕获函数里重复的第二段 stdout 扫描（死代码）。

**验证**：loghub-test 增补"写失败不推水位""断言路径冲突抛错"用例；core-test 轮转用例保持全绿。

---

## RC6 杂项工程债（随对应结构修复顺带清偿，不单独立项）

| 项 | 随哪个结构修复清偿 |
|---|---|
| acquireLock fail-open（bin:153）| 独立 5 行修复：非 EEXIST fail-closed + 明确报错（结构上锁的正确语义本就只有 fail-closed 一种） |
| bump.sh 字符串版本比较 | 换 verify-versions.js 已有的 semver 逐段比较函数（复用，不新写） |
| CLI events argv[4] off-by-one / 兜底端口 3100 | 对齐 argv[3]；readApiAddress 兜底改读 DEFAULTS.apiPort |
| switcherAutoStart 死迁移 | 按注释本意修复（`raw.routerAutostart === undefined &&`）；persistConfigPatch 的 delete 保留（收敛完成后下次迭代删除） |
| reclaimCfg 引用不存在的 configPath | LanManager 构造时注入 cfgPath（结构上：回收者必须知道自己匹配谁的进程） |
| isDshCmdline 过宽 | 收窄为 bin 精确匹配 + node+dsh 双特征（单一函数，两处调用点不变） |
| `_makeCtlFacade` BANNED 缺 `__proto__` | 词表补齐 + 改用 `Object.create(null)` 语义的显式方法白名单 |
| pidState 每拍双次读 cmdline | monitor 内缓存 (pid→isDsh) 60s |
| smoke/upgrade-test 残留进程污染 | 测试基建统一 afterEach pkill 兜底（smoke.js 已有原型，收敛为共享 helper） |

---

## 实施顺序与验证门（每步可独立回退）

| 阶段 | 内容 | 验证门 |
|---|---|---|
| ① 安全底线（半天） | RC1 + acquireLock + 分派器 try/catch（RC3.1/3.2）| api-fuzz-test 新增；伪造用例三连全拒；既有 api 测试全绿 |
| ② 意图重构（1 天） | RC2 全部（intent.js + 构造契约 + shutdown 契约） | adopt-token-test（去播种版）/upgrade-test/新 SIGTERM 回归 全绿 |
| ③ 执行器归一（1 天） | RC4（tasks.run + exec.js + 死代码删除） | 注入 reject 测试；`grep execFileSync` 收敛验证 |
| ④ 事件系统（半天） | RC5 | loghub-test 增补用例全绿 |
| ⑤ 杂项清偿（半天） | RC6 全表 | npm test 全绿 + smoke 连跑 3 次无残留 |

**总量**：约 6 个文件新建/重写 + 18 个文件修改 + 约 300 行死代码删除；每阶段带专属回归测试，全程 npm test 可验证。

**不做的事**（明确出界）：不改 providers 配额策略/frpmgr toml 生成/ui-react 前端（本轮审计未发现其结构性缺陷）；不引入新依赖；不做"顺手重构"超出上表的任何内容。
