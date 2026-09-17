# WS2-b 报告：N2 心跳两拍重叠 + N11 instances/add command 注入

> 范围（独占）：`src/app/assembly/bootstrap.js`、`src/api/domains/instances.js`（仅此 2 文件）。
> 纪律：未运行任何测试/门禁；仅 `node --check` / `grep` / `read` / `wc` / `git status|diff`（只读）；
> 无任何 git 写操作；未改 `test/**`；未加依赖；未启动 daemon。

---

## 1. 改动文件清单（每行一条理由）

| 文件 | diff | 理由 |
|---|---|---|
| `src/app/assembly/bootstrap.js` | +18 / -4 | N2：加每拍自增代际 `host._heartbeatBeat`，guard 与 `.finally` 都只在「本拍仍是当前代际」时才复位 `_heartbeatBusy`；stall 阈值由 `max(30000, iv*12)` 抬到「最坏整拍上界 + 一拍余量」`max(30000, iv*12, objCount*6*iv + iv)`。 |
| `src/api/domains/instances.js` | +20 / -0 | N11：新增模块内 `commandShapeError()`，在 `POST /instances/add` 调 `addInstance` 之前对 `j.command` 做 fail-closed 结构闸，非法即 400，不把原样 command 数组透传给 systemd-run。 |

两文件 `module.exports` 均未改；改动均为最小侵入，未做结构重构/搬移。

---

## 2. N2 最小改动（diff 级）

位置：`_bootstrap(host)` 心跳装配段（原 `host._lastHeartbeatAt = Date.now();` 起至 `}, heartbeatIv);`）。

```diff
     host._lastHeartbeatAt = Date.now();
     host._heartbeatStalls = 0;
+    // 心跳代际（自增 beat id）：stall 兜底可放行下一拍，而上一拍的 promise 仍在 await；
+    // 若旧拍迟到结算时无条件清 busy，就会清掉新拍的标记 → 第三拍与新拍并发（两拍重叠根因）。
+    // 故 guard 与 .finally 都只在本拍仍是当前代际时才复位 busy。
+    host._heartbeatBeat = host._heartbeatBeat || 0;
     // 拍宽必须在 setInterval 之前求值：它同时用作间隔与超时阈值。
     const heartbeatIv = host.config.probeIntervalMs || 5000;
     host._heartbeatTimer = setInterval(() => {
       if (host._heartbeatBusy) return;
       host._heartbeatBusy = true;
       const iv = heartbeatIv;
+      const beat = ++host._heartbeatBeat; // 本拍代际
       host._lastHeartbeatAt = Date.now();
-      // 兜底释放（阈值 = 拍宽 × 12：远大于任何正常拍，又保证必定恢复）。unref：不拖住进程退出。
-      const stallMs = Math.max(30000, iv * 12);
+      // 兜底释放阈值必须大于「最坏单拍上界」：单对象超时 = iv × ADAPTER_TIMEOUT_TICKS(6)，
+      //   循环串行，故 N 个对象全部卡死的最坏整拍 = N × 6 × iv。阈值低于它会在正常最长拍
+      //   中途误释放 busy，放行第二拍而第一拍仍在 await —— 两拍并发监督/收敛。
+      //   取最坏上界 + 一拍余量，并保底 max(30000, iv × 12)。unref：不拖住进程退出。
+      const objCount = (host.managedObjects && typeof host.managedObjects.count === 'function')
+        ? host.managedObjects.count() : 1;
+      const stallMs = Math.max(30000, iv * 12, objCount * 6 * iv + iv);
       const guard = setTimeout(() => {
-        if (host._heartbeatBusy) {
+        if (host._heartbeatBusy && beat === host._heartbeatBeat) {
           host._heartbeatBusy = false;
           host._heartbeatStalls++;
           if (host.logger && host.logger.warn) {
@@
       Promise.resolve(host.managedObjects ? host.managedObjects.heartbeat(iv) : null)
         .catch(() => {})
-        .finally(() => { clearTimeout(guard); host._heartbeatBusy = false; });
+        .finally(() => {
+          clearTimeout(guard);
+          // 归属判断：仅当代际仍属本拍时才复位，迟到的旧拍不得清掉新拍的标记。
+          if (beat === host._heartbeatBeat) host._heartbeatBusy = false;
+        });
     }, heartbeatIv);
```

根因闭环：旧拍被 stall 兜底放行后，新拍自增代际；旧拍迟到结算时 `beat !== host._heartbeatBeat`，
不再清掉新拍的 busy 标记 → 不会再放行第三拍并发。阈值同时抬到单拍最坏上界之上，
避免「正常长拍中途被误释放」。二者共同根治，FIX-4 只把并发合并在 `heartbeat.js._heartbeatInFlight`（治症状）。

### 行为变更声明（N2）

- 状态码/返回值：无（纯内部定时器逻辑）。
- 日志：`warn` 文案 `[heartbeat] 单拍超过 <stallMs>ms 未结算，强制释放防停摆（第 N 次）` 逐字保留；
  仅 `stallMs` 数值可能变大（`objCount*6*iv+iv` 下限生效时）。触发概率显著下降（正常拍不再误触发）。
- 事件：无新增/删除。
- 新增内部字段：`host._heartbeatBeat`（自增 int，非导出、非持久化、不属公开 API 形态）。
- `_lastHeartbeatAt` / `_heartbeatStalls` 语义与计数逻辑不变。

---

## 3. N11 最小改动（diff 级）

位置：`src/api/domains/instances.js`，新增模块内函数 `commandShapeError()`（`handle` 之前），
并在 `act === 'add'` 分支调用 `addInstance` 之前加闸。

```diff
+// command 字段的 fail-closed 结构闸（N11 / 审计 A2）：command 会被原样经 startTransient
+//   交给 systemd-run，等于「任何能驱动写 API 的客户端可让守卫以自身身份执行任意命令」。
+//   本层只收窄**结构**（数组 / 字符串 / 非空 / 元素数与长度上限 / 拒绝 NUL 与换行）；
+//   非空 command 仍是**操作者特权能力**（UI「启动命令」文本框的合法用途），此处不按可执行
+//   文件白名单进一步收窄，以免误伤自定义 DSH 参数。缺失或空数组 = 用沙箱默认命令。
+function commandShapeError(command) {
+  if (command === undefined || command === null) return null;
+  if (!Array.isArray(command)) return 'command 必须为参数数组';
+  if (command.length > 64) return 'command 参数过多（上限 64）';
+  for (const a of command) {
+    if (typeof a !== 'string') return 'command 每项必须为字符串';
+    if (!a.length) return 'command 不允许空参数';
+    if (a.length > 4096) return 'command 单个参数过长（上限 4096）';
+    if (/[\0\r\n]/.test(a)) return 'command 含非法字符（NUL/换行）';
+  }
+  return null;
+}
+
 function handle(ctx) {
@@
           if (act === 'add') {
+            const cmdErr = commandShapeError(j.command);
+            if (cmdErr) return send(400, { ok: false, error: cmdErr });
             // addInstance 为 async（含端口占用探测）：必须等结果再作答，否则 send 收到的是
             // Promise（r.ok 恒 undefined 导致恒 400，且响应体不可序列化）。
             return Promise.resolve(sup.instances.addInstance(j))
```

合法生产者核验（全仓 grep）：`command` 经 HTTP 进入实例记录的唯一路径是
`ui/src/services/supervisor/client.ts:121` / `InstancesPage.tsx:62-64`（文本框逐行 split，每项一个参数）；
域内默认命令由 `src/domains/instance/sandbox.js` 的 `sandboxCommand/defaultCommand` 生成（传空数组即走此路径）。
合法形态 = 字符串数组（本仓所有生成侧都是 `[node, dshBin, 'web', ...]` 形态的字符串数组）→ 结构闸全部放行；
`/bin/sh`、`bash`、非数组、含 NUL/换行等注入形态被拒。**未删字段**，UI 功能保留（按主控指示）。

### 行为变更声明（N11）

- `POST /instances/add`：
  - `command` 缺失 / `null` / `[]` / 合法字符串数组 → 行为不变（200 按 `r.ok`，与既有 `add` 语义一致）。
  - `command` 非数组、含非字符串、含空串、元素数 >64、单项 >4096、含 `\0`/CR/LF
    → **新增 400** `{ ok:false, error:'...' }`（此前非数组被域层静默当 `[]`，非法数组原样透传）。
- 日志/事件：无新增。
- 返回值：仅新增拒绝分支；成功路径返回体不变。
- 未触碰 `originAllowed` 与其它端点。

---

## 4. 形式钉子保留项

### 4.1 工作单 §6 三条硬钉子（逐字仍在，未动）
| # | 串 | 出处 | 本文件位置 |
|---|---|---|---|
| 1 | `强制释放防停摆` | `test/heartbeat-selfheal-test.js:61` | `bootstrap.js` warn 文案（代码，非注释） |
| 2 | `[shell-watchdog] 启动异常（不影响守卫主循环）` | `test/round13-robustness-batch-test.js:107` | `bootstrap.js` `_bootstrap` catch（未动） |
| 3 | `初始化失败（不影响守卫）` | `test/shell-watchdog-test.js:144` | `bootstrap.js` `_startShellWatchdog` catch（未动） |

grep 证据：三条在 `bootstrap.js` 各命中 1 处（第 69 / 150 / 175 行），逐字未改。

### 4.2 heartbeat-selfheal-test.js 结构钉子（全部保留，形态不变）
`host.`→`this.` 归一后仍逐条命中：
- `/this\._heartbeatBusy = false;/`（guard 与 `.finally` 各一处）
- `/iv \* 12|stallMs/`（新 `stallMs` 行保留 `iv * 12` 字面量）
- `/_heartbeatStalls\+\+/`、`/_heartbeatStalls/`、`/_lastHeartbeatAt/`、`/_lastHeartbeatAt = Date\.now\(\)/`
- `/强制释放防停摆/`、`/clearTimeout\(guard\)/`、`/guard && typeof guard\.unref === 'function'/`
- `const heartbeatIv = this.config.probeIntervalMs` 仍早于 `this._heartbeatTimer = setInterval(`；
  `/\}, heartbeatIv\);/` 与 `const iv = heartbeatIv;`（位于 setInterval 之后）均保留。

### 4.3 被替换注释的 R1 核验（形式钉子，未命中）
N2 唯一被替换的注释是原第 52 行
`// 兜底释放（阈值 = 拍宽 × 12：远大于任何正常拍，又保证必定恢复）…`。
先 `grep test/` 其特征串：
- `远大于任何正常拍` → 0 命中；`保证必定恢复` → 0 命中；
- `拍宽 × 12` → 2 命中，但都在 `test/heartbeat-selfheal-test.js` 自身注释/断言名里，
  其断言正则实为 `/iv \* 12|stallMs/`（匹配源码 **代码**，不是注释文本），故非注释钉子。
该行代码字面量 `iv * 12` 已在新 `stallMs` 中保留 → 断言不受影响。

instances.js 未删改任何既有注释，仅新增注释块 → 无 R1 风险。

---

## 5. 导出增删（全仓核验证据）

- **无导出增删**。
  - `src/app/assembly/bootstrap.js:206` → `module.exports = { _bootstrap, _startShellWatchdog, _registerFixedPorts, _bindNativeDshCommand };`（不变）
  - `src/api/domains/instances.js:222` → `module.exports = { owns, handle, handleOpen, issueOpenWebCode, consumeOpenWebCode };`（不变）
- 新增标识符均为模块内局部（不导出），全仓 grep 仅命中定义/使用处：
  - `commandShapeError` → 2 命中，均在 `src/api/domains/instances.js`（定义 + 调用），无 test/bin 消费者。
  - `_heartbeatBeat` → 4 命中，均在 `src/app/assembly/bootstrap.js`（初始化 + 自增 + guard + finally），无 test/bin 消费者。
- R2 未触发（本次未删任何导出/函数/常量）。

---

## 6. node --check 结果

```
node --check src/app/assembly/bootstrap.js   → 通过（exit 0，无 stderr）
node --check src/api/domains/instances.js    → 通过（exit 0，无 stderr）
```

行数（`wc -l`）：`bootstrap.js` 206、`instances.js` 222 —— 均 < DG-2 单文件 300 行上限。

---

## 7. CI 风险点

1. **heartbeat-selfheal-test.js（绿）**：全部钉住形态逐字保留；B 段行为用例是自包含复现，不读源码，
   不受代际改动影响。D 段「拍宽变量在 setInterval 之前声明」仍成立。
2. **instance-safety-test.js（绿）**：其 API 断言只要求
   `Promise.resolve(sup.instances.addInstance(j))` 仍在、`const r = sup.instances.addInstance(j);` 仍无 ——
   两者均满足（新闸插在该行之前）。
3. **无测试把 command POST 到 /instances/add**（全仓 grep：`test/` 内 `instances/add` 0 命中），
   故新增 400 分支不撞任何既有断言。
4. **其它并行工作区改动**：`git status` 显示大量他人文件同时处于 modified（各 WS 并行），
   本代理只写上述 2 文件，未触碰他人文件；主控提交时请按文件归属切分。
5. **N11 残余安全面（见 §8）**：结构闸只收窄形态，不按可执行文件白名单收窄，仍允许操作者
   （或已获写权限的客户端）指定任意可执行文件；这是按主控指示保留 UI「启动命令」能力的结果。

---

## 8. 需主控裁决（无测试转红；安全范围裁决）

本次改动**不会使任何既有 test/ 断言转红**（静态核对见 §6/§7，未运行测试）。

但 N11 存在一个「按指示保留、仍需主控拍板」的范围决定：当前结构闸**不能**阻止
「合法字符串数组形式的任意可执行文件」（如 `['/bin/sh','-c','...']`），只是把它明确为
**操作者特权能力**。若主控要求彻底堵死任意命令注入，有两个可选修法（均只需继续改
`src/api/domains/instances.js` 一个文件，不碰 originAllowed）：

- **修法甲（最小、误伤可控）**：把 `command` 收窄为 DSH 启动白名单 ——
  `command[0]` 必须是 Node 运行时（`process.execPath` 或 basename `node/node.exe`）或 DSH 入口
  （basename `dsh(.cmd|.exe|.bat)`，或路径含 `node_modules/@deepseek-ai/dsh/` 且 `.js`），
  非空 argv 必须匹配该形态，其余一律 400。UI 占位符 `node\n/usr/local/bin/dsh\nweb` 仍可用。
- **修法乙（更强、彻底 fail-closed）**：HTTP 层**只接受** `command` 缺失/`[]`，任何非空 command 一律 400，
  自定义启动命令改由域内部（默认生成器）承担。代价：UI「启动命令」文本框对该入口失效，需 UI/主控同步。

请主控在聚合时选择是否追加甲/乙；未获指示前不改 originAllowed，也不扩大改动面。
