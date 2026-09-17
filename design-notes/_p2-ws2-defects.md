# WS2 报告：第三波缺陷 N2 / N6 / N7 / N8 / N9 / N10 / N11

> 负责人：WS2 主控。作业单：design-notes/_workorder-phase2.md（§0 硬约束、§1 R1/R2、§4 WS2、§5、§6）。
> 分片报告：design-notes/_p2-ws2-relay-router.md（N6-N10，WS2-a）、design-notes/_p2-ws2-app-api.md（N2/N11，WS2-b）。
> 纪律：全流程未运行任何测试/门禁；只用 node --check / grep / read / wc / git status|diff（只读）；
> 无任何 git 写操作；未改 test/**；未加依赖；未启动任何 daemon。所有改动留在工作区，由主控提交。

---

## 1. 文件清单（每行一条理由）

| 文件 | diff | 缺陷 | 理由 |
|---|---|---|---|
| src/domains/relay/session.js | +23 / -15 | N6 | 新增 `bootstrapEpoch` 换代序号与私有 `startBootstrap()`；refresh 换代后旧代在途换取结果一律丢弃，且 refresh 与 ensure 共用同一在途 promise（保留单飞） |
| src/domains/router/providers/probe.js | 0 | N7 | 确认无残留，**未改动**（Unicode 箭头/框线/带圈数字/杂项符号/emoji 扫描 0 命中） |
| src/domains/relay/frp-install.js | +1 / -1 | N8 | 取校验表失败不再写生命周期级 `_sumCache`，离线一次后不再永久跳过 sha256 |
| src/domains/router/providers/quota-strategies.js | +1 / -1 | N9 | `derivedMonthly` 条件加 `hasCredits &&`，credits 缺席时不再伪造月窗口 100%/rate-limited |
| src/domains/router/handlers/forward.js | +2 / -2 | N10 | client-abort 时立即 destroy 上游 req/res，回收 keep-alive socket |
| src/app/assembly/bootstrap.js | +18 / -4 | N2 | 心跳每拍自增代际，guard 与 `.finally` 只在本拍仍是当前代时复位 busy；stall 阈值抬到单拍最坏上界之上 |
| src/api/domains/instances.js | +20 / -0 | N11 | `POST /instances/add` 之前对 `command` 做 fail-closed 结构闸，非法即 400 |

合计 6 个文件改动（probe.js 未改），65 insertions / 23 deletions。文件分区互斥，无跨文件改动。

---

## 2. 逐项最小改动 + 行为变更声明

### N6 src/domains/relay/session.js
- 改动：加 `let bootstrapEpoch = 0`；抽出私有 `startBootstrap(dshToken, via)`（结果仅在 `myEpoch === bootstrapEpoch` 时写入 `dshCookie`/`recordReady`；用 `bootstrapping === pr` 判身份后才清引用）；`refreshDshSession` 先 `bootstrapEpoch += 1` 再起换取；`ensureDshCookie` 改为 `return bootstrapping || startBootstrap(dshToken, 'lazy')`。
- 行为变更：不再出现「旧 cookie 覆盖新值」；不再并发双换取（refresh 与 ensure 共用同一在途 promise）；被换代作废的旧代不再发 `lan_cookie_exchanged`。日志/事件文案、模块导出、函数签名均不变。

### N7 src/domains/router/providers/probe.js
- 结论：无残留，**零改动**。扫描确认仅 3 行 ASCII `->`（17/48/213），系提交 b2f3d3d 把装饰箭头改成的受认可形态；非未覆盖的装饰符号。
- R1：对 test/ 全量 grep 这些注释特征串无匹配 → 无形式钉子。

### N8 src/domains/relay/frp-install.js
- 改动：删除 `catch (e)` 中的 `c[asset] = null;`，改为说明注释（第 84 行）；「校验表已取到但 asset 缺失」的 `c[asset] = sum`（可能为 null，第 77 行）仍缓存。
- 行为变更：取校验表失败时不再污染 `_sumCache` —— 后续再次安装会重新尝试官方校验表，而非在本进程内永久跳过 sha256。单次安装内的 report/warn 文案、返回值（null）不变。

### N9 src/domains/router/providers/quota-strategies.js
- 改动：`derivedMonthly` 条件由 `(monthlyCap !== null && …)` 改为 `(hasCredits && monthlyCap !== null && …)`。
- 行为变更：credits 字段全缺席时，`monthly` 由「由 monthlyRemaining=0 推出的 percent=100 / rate-limited」回退为 `mapW(wm.monthly)`（通常 null）——消除「月窗口假满 → 误冻账号」的输入。credits 正常时数值完全不变；`monthlyRemaining` 的既有 `hasCredits` 守卫不变。

### N10 src/domains/router/handlers/forward.js
- 改动：`forwardOnce` 内 `onClientClose` 改为先 `try { req.destroy(); } catch {}` 再 `settle({ phase: 'client-abort' })`；`proxyFor` 的外层 client-abort 早退（原 :127）补 `destroy out.res / out.upstreamReq`（覆盖「响应已到、内层 close 监听已被 `req.on('response')` 移除」的窄窗口）。
- 行为变更：仅上游 socket 生命周期即时回收（不再等上游自然结束），日志/事件/状态码/返回值不变。

### N2 src/app/assembly/bootstrap.js
- 改动：加 `host._heartbeatBeat = host._heartbeatBeat || 0`；每拍 `const beat = ++host._heartbeatBeat`；guard 条件与 `.finally` 复位都加 `beat === host._heartbeatBeat` 归属判断；stall 阈值 `max(30000, iv * 12)` → `max(30000, iv * 12, objCount * 6 * iv + iv)`（`objCount` 取 `host.managedObjects.count()`，缺失则 1）。
- 根因闭环：旧拍被 stall 兜底放行后新拍自增代际，旧拍迟到结算时不再清掉新拍的 busy → 不再放行第三拍并发；阈值同时压过「对象数 × ADAPTER_TIMEOUT_TICKS(6) × iv」的单拍最坏上界（已核实 registry.js:248 `count()` 与 heartbeat.js:82 每对象`iv*6`超时），避免正常长拍中途被误释放。FIX-4 只在 heartbeat.js 合并并发（治症状），本项治根因。
- 行为变更：状态码/事件/返回无变化；warn 文案逐字保留，仅阈值数值可能变大、误触发概率显著下降；新增非导出内部字段 `_heartbeatBeat`（不持久化、非公开 API）。

### N11 src/api/domains/instances.js
- 改动（**方案甲，已由主控裁决采纳**）：新增模块内 `commandShapeError(command, dshBin)`，在 `act === 'add'` 分支调 `addInstance` 之前做**结构闸 + 入口白名单**：
  - 结构闸：非数组/非字符串/空串/元素数 >64/单项 >4096/含 NUL·CR·LF → 400。
  - 入口白名单（非空数组时）：`basename(command[0])` ∈ { node, node.exe, dsh, dsh.exe, dsh.js, dsh-supervisor, dsh-supervisor.js }（大小写不敏感、两种路径分隔符都切）；或 `command[0]` 与配置的 `sup.instances.dshBin` **严格相等**。
  - 缺失 / `null` / `[]` 放行（走沙箱默认命令，保持既有行为）；缺失或空数组不报错。
  - **未**采用「任意 `*.js` 放行」，**未**把路径存在性作为放行依据。
  - 错误文案：`command[0] 只接受 DSH/node 入口（node、dsh、dsh-supervisor 等）；需要其它可执行请走插件安装通道`。
- 合法生产者核验（全仓 grep，排除 node_modules/.git）：`command` 经 HTTP 进入实例记录的唯一路径是 UI（client.ts:121 / InstancesPage.tsx:62-64，文本框逐行 split）；域内默认命令由 instance/sandbox.js 生成。所有生成侧均为字符串数组 → 结构闸全部放行。
- 行为变更：`POST /instances/add` 新增 400 拒绝分支（此前非数组被域层静默当 `[]`、非法数组与任意可执行原样透传给 systemd-run）；合法 DSH/node 入口数组（含 UI 占位符 `node /usr/local/bin/dsh web`、沙箱默认 `process.execPath dshBin web`）/缺失/空数组行为不变；日志/事件无新增；**未删字段**，UI「启动命令」既有用途（DSH 入口 + 自定义参数）保留；未触碰 `originAllowed`。
- 实现注记：白名单比对大小写不敏感（Windows 文件系统语义，且不超出同一名称族）；`dshBin` 规则按裁决要求为**严格相等**、不折叠大小写。

---

## 3. 形式钉子保留项（R1）

### 3.1 作业单 §6 硬钉子（逐字仍在，grep 各命中 1 处）

| # | 受保护字样 | 钉住它的测试 | 本文件位置 |
|---|---|---|---|
| 1 | `强制释放防停摆` | test/heartbeat-selfheal-test.js:61 | src/app/assembly/bootstrap.js:69（warn 代码，未动） |
| 2 | `[shell-watchdog] 启动异常（不影响守卫主循环）` | test/round13-robustness-batch-test.js:107 | src/app/assembly/bootstrap.js:150（未动） |
| 3 | `初始化失败（不影响守卫）` | test/shell-watchdog-test.js:144 | src/app/assembly/bootstrap.js:175（未动） |

### 3.2 heartbeat-selfheal-test.js 全部正则钉子（保留，形态不变）
`this._heartbeatBusy = false;`（guard 与 finally 各一处）、`iv * 12`（新 stallMs 行保留字面量）、`stallMs`、`_heartbeatStalls++`、`_lastHeartbeatAt`、`_lastHeartbeatAt = Date.now()`、`强制释放防停摆`、`clearTimeout(guard)`、`guard && typeof guard.unref === 'function'`、`const heartbeatIv = this.config.probeIntervalMs` 早于 `this._heartbeatTimer = setInterval(`、`}, heartbeatIv);`、`const iv = heartbeatIv;`（位于 setInterval 之后）。

### 3.3 被替换/被新增注释的 R1 核验
- N2 唯一被替换的注释（原「兜底释放（阈值 = 拍宽 × 12：远大于任何正常拍，又保证必定恢复）」）：特征串「远大于任何正常拍」「保证必定恢复」在 test/ 各 0 命中；「拍宽 × 12」2 命中但均在 heartbeat-selfheal-test.js 自身注释/断言名内，其断言正则实为 `/iv \* 12|stallMs/`（匹配源码代码，非注释文本）→ 非注释钉子，代码字面量 `iv * 12` 已保留。
- N11 仅新增注释块与新增函数，未删改既有注释。
- 未发现新的注释钉子（4 个 relay/router 文件的运行期 error/log 文案一律未改）。

---

## 4. 新增/删除的导出（R2 全仓核验）

- **无导出增删**。逐一核对 7 个文件的 `module.exports` 均未变；无函数/常量删除。
- 新增标识符均为模块内私有，全仓 grep（src test bin release ui *.md design-notes .github app，排除 node_modules/.git）仅命中本文件：
  - `startBootstrap` → 仅 src/domains/relay/session.js（定义 + 调用）
  - `commandShapeError` → 仅 src/api/domains/instances.js（定义 + 调用）
  - `_heartbeatBeat` → 仅 src/app/assembly/bootstrap.js（初始化 + 自增 + guard + finally）
- R2 未触发（本次未删任何导出/函数/常量）。

---

## 5. node --check 结果

```
node --check src/app/assembly/bootstrap.js              → exit 0
node --check src/api/domains/instances.js               → exit 0
node --check src/domains/relay/session.js               → exit 0
node --check src/domains/relay/frp-install.js           → exit 0
node --check src/domains/router/providers/probe.js      → exit 0
node --check src/domains/router/providers/quota-strategies.js → exit 0
node --check src/domains/router/handlers/forward.js     → exit 0
```

行数：bootstrap.js 206、instances.js 222 —— 均 < DG-2 单文件 300 行上限。

---

## 6. CI 风险点

1. **heartbeat-selfheal-test.js**：§3.2 全部形态钉住，逐条保留；B 段行为用例是自包含复现（不读源码），D 段求值顺序仍成立 → 不预期转红。
2. **instance-safety-test.js**：只要求 `Promise.resolve(sup.instances.addInstance(j))` 仍在且无 `const r = sup.instances.addInstance(j);` —— 新闸插在该行之前，两者均满足。
3. **无测试把 command POST 到 /instances/add**（test/ 内 `instances/add` 0 命中）→ 新增 400 分支不撞断言。
4. **round13-frpc-integrity-test.js**：A/B/C 每组都重设 `_sumCache = {}` 且只 install 一次；D 读源码的 `const url` 与 `createHash('sha256')` 行未动 → N8 不撞。
5. **commandcode-quota-test.js**：CC7 只断言 `monthlyRemaining === null`，未断言 `monthly` → N9 不撞。
6. **N6/N10 零测试消费者**（test/ 对 refreshDshSession/ensureDshCookie/dshCookie 与 forward client-abort 的断言 0 命中）。
7. **并行工作区**：本次只写上述 6 个文件；工作区内大量他人文件同时 modified（各 WS 并行），主控提交时请按文件归属切分。
8. **唯一未决项是 N11 的安全范围（非测试转红）**，见 §7。

---

## 7. N11 安全范围裁决（已裁决：采纳方案甲）

主控裁决：**采纳方案甲**（仅改 src/api/domains/instances.js，不碰 UI、不碰 originAllowed）。已按此落地，见 §2 N11。

- 采纳甲：`command[0]` 收窄为 DSH/node 入口白名单 + `dshBin` 严格相等；未采用「任意 `*.js` 放行」；未把路径存在性作为放行依据。
- 未采纳乙（HTTP 层只接受缺失/`[]`）：UI「启动命令」既有用途（DSH 入口 + 自定义参数）保留。
- 残余面：`/instances/add` 经 originAllowed + （LAN 时）access key 鉴权，属**操作者信任边界**；「任意二进制」已不由该端点承担，需要其它可执行走插件安装通道。
- 待主控知悉的实现注记：白名单 basename 比对为大小写不敏感（Windows 语义）。若要求严格区分大小写，需再改同文件一处。
