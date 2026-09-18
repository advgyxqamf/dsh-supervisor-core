# 第三波缺陷 N1/N3/N4/N5 最小修复设计（只读分析，未改代码）

> 基线：内核仓根工作区（未提交）。仅静态阅读 + grep，未运行任何测试、未改源码。
> 每项给出：精确 文件:行、最小 patch、风险与影响面。末尾有落地顺序与文件独占提示。

---

## N1 exec 超时参数名不匹配

根因（精准）
- 读取方：src/platform/util/exec.js:22 —— timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS。
- 传参方（src 内唯一违规源）：src/platform/os/service.js:31,34,37,53,54,56 传 { timeout: ... }，键名不被读取，全部回落 DEFAULT_TIMEOUT_MS = 15000。
- 其余约 40 处 exec 调用方（pidlookup/netinfo/file-protect/autostart/env-catalog/versions 等）全部用 timeoutMs，无需改动。

实际后果（不夸大）
- daemonReload 请求 15000 = 默认值 -> 无差异。
- resetFailed/cleanTransient 请求 10000 -> 实际 15000（变长）。
- stopUnit({timeoutMs:20000})（lifecycle.js:101、shutdown.js:113）-> 实际 15000（被截短）。
- 真正的语义受损：15-20s 才停住的单元会被 run() 判 null -> stopUnit 返回 false -> lifecycle 报 {ok:false} 假失败（与 N4 强耦合）。

最小 patch（推荐 A+B 同时做；只做一个则选 A）

A. 边界归一化（1 行，根治未来调用）—— src/platform/util/exec.js:22

~~~diff
-    timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS,
+    // timeout 为历史别名：service.js 曾传 {timeout} 被静默忽略（N1）。两写法都收，timeoutMs 优先。
+    timeout: o.timeoutMs || o.timeout || DEFAULT_TIMEOUT_MS,
~~~

B. 规范化调用点（6 行，消灭双拼写）—— src/platform/os/service.js 31/34/37/53/54/56

~~~diff
-  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }) !== null; } catch { return false; } },
+  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }) !== null; } catch { return false; } },
...
-    try { return run('systemctl', ['--user', 'stop', unit], { timeout: o.timeoutMs || 15000 }) !== null; }
+    try { return run('systemctl', ['--user', 'stop', unit], { timeoutMs: o.timeoutMs || 15000 }) !== null; }
...
-    try { run('systemctl', ['--user', 'stop', unit + '.service'], { timeout: 10000 }); } catch {}
-    try { run('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeout: 10000 }); } catch {}
-    try { run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }); } catch {}
+    // 最终形态见 N5，避免与 N5 重复改行
~~~
（37 行 resetFailed 的最终形态见 N5。）

风险与影响面
- exec.js 是同步子进程唯一入口（门禁 G9-a），改动只放宽键名；killSignal/windowsHide/maxBuffer/DEFAULT_TIMEOUT_MS 全不变。options() 无外部消费者（全仓仅 exec.js 自身引用，已 grep 确认）。
- 仅影响原本传 timeout 的 service.js：stopUnit 真正拿到 20000；resetFailed/cleanTransient 从 15000 收紧到 10000。
- 测试无钉子：test/exec-bounded-gate-test.js 的 G9-d 只断言 DEFAULT_TIMEOUT_MS 存在；test/exec-return-contract-test.js 全用 timeoutMs。
- 不修 N1，则 N4 的 20s 停止预算不生效。

---

## N3 guard 状态码映射

位置：src/api/domains/guard.js:74, 93, 112, 127，均 send(r.ok ? 200 : 500, r)。

不一致证据（同文件 / 同仓）
- guard.js:135 /shutdown：r.ok === false ? 400 : 200
- guard.js:144 /self-update/status：r.ok ? 200 : 400
- FIX-8 B1/B2：api/domains/instances.js:158,159,164,166、api/domains/router.js:34,37 均 r.ok === false -> 400

最小 patch（与 FIX-8 同规）

~~~diff
-        return send(r.ok ? 200 : 500, r);
+        return send(r.ok === false ? 400 : 200, r);
~~~

共 4 处（74 / 93 / 112 / 127）。

语义核对（决定 400 是否恰当）

| 端点 | r.ok=false 含义 | 出处 | 建议 |
|---|---|---|---|
| POST /autostart | 平台启停失败（业务失败） | src/app/settings/autostart.js:23-28 | 400（对齐 FIX-8） |
| POST /settings/lan | 未设访问密钥的前置条件失败 | src/app/settings/lan-panel.js:42-44 | 必须 400 |
| POST /settings/access-key | guard.js:110 已提前回 400；此处仅剩持久化异常 | src/app/settings/access.js:19,24 | 严格应留 500 |
| POST /settings/close-action | 仅剩持久化异常 | src/app/settings/access.js:46 | 严格应留 500 |

结论：lan 语义就是 400；autostart 建议 400；access-key/close-action 统一改 400 会把「落盘异常」由 500 降级为 400。若目标是「与 FIX-8 一致」则 4 处全改；若要严谨则只改 74/93。范围由主控定。

范围外同类（登记不改）：src/api/domains/shell.js:74（/shell/restart，r.ok ? 200 : 500）。restartShell 失败属执行失败，500 更恰当。

风险与影响面
- UI（ui/src/services/supervisor/client.ts:184-190）对所有非 2xx 一律抛错并显示 body.error，400/500 对用户无差别。
- 无测试断言 guard 端点状态码（grep test/、design-notes/ 无 /autostart、/settings/* 状态断言）。
- 属对外可观测行为变更，须按 FIX-8 报告格式记录。

---

## N4 lifecycle stop 忽略 stopUnit

核验结论：已由 FIX-5 缺陷 B 修复，无需再改 lifecycle.stop。
- src/domains/instance/lifecycle.js:101  stopped = service.stopUnit(unit, { timeoutMs: 20000 })
- :103  if (stopped === false) -> 写 lastError、发 inst_stop_failed、返回 {ok:false}，不置 STOPPED
- :112  仅确认停止后 phase='STOPPED'
- 调用链：domains/instance/index.js:86 stopInstance -> lifecycle.stop；API api/domains/instances.js:166 r.ok ? 200 : 400（FIX-8）如实回 400。

剩余缺口（按需纳入本波）
1. 与 N1 耦合（必修）：service.js:34 把 {timeoutMs:20000} 改写成 {timeout:...} -> 实际 15s。N4 的完整修复必须包含 N1，否则 stop 预算不足仍会假 {ok:false}。
2. _cleanStaleUnit（lifecycle.js:40-43）忽略 service.cleanTransient 结果 -> 归 N5。
3. 停止确认语义三种写法并存：lifecycle.js:103 === false、ops.js:74 !== false、shutdown.js:113 === true。当前 systemd Provider 严格返回 boolean，三者等价 -> 不动（风格统一非缺陷）。
4. N4-b（登记，本轮不做）：stopUnit 返回 true 后未像 ops.js:76-82 那样再 isUnitActive 复核；若 systemctl stop 成功但子进程仍占端口，仍会假 STOPPED，且 supervise 的 STOPPED 相位不干预（lifecycle.js:196 default 分支）。加固需二次探测，但会把「端口未及时释放」误报失败，收益/风险不明，建议仅登记。

影响面：本轮无代码改动；文档上 design-notes/FIX-6.md:31「lifecycle.js:99 忽略返回值」已过时，应随报告更正（文档，非代码）。

---

## N5 service.js resetFailed / cleanTransient 吞 null

位置：src/platform/os/service.js:37（resetFailed）、:52-57（cleanTransient）。
机理：run()（exec.js:36-55）永不抛，失败/超时返回 null -> try { run(...) } catch {} 的 catch 是死代码：
- resetFailed 无论成败恒 return true；
- cleanTransient 无论成败恒返回 undefined，四步全静默。

调用方
- resetFailed：src 内零调用方（FIX-6.md:44 已记录；仅 test/cross-platform-test.js:128 存在性检查 + 测试假 Provider）-> 改动无行为影响。
- cleanTransient：唯一调用方 lifecycle.js:41 _cleanStaleUnit，无条件 log「cleaned stale transient unit」-> 失败时日志撒谎。真实失败的下游兜底已由 FIX-6 提供（startTransient 用 runDetail，失败抛错 -> _systemdStart catch），故当前危害是可观测性而非「假成功启动」。

最小 patch

(a) service.js:37

~~~diff
-  resetFailed(unit) { try { run('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 }); return true; } catch { return false; } },
+  resetFailed(unit) { return run('systemctl', ['--user', 'reset-failed', unit], { timeoutMs: 10000 }) !== null; },
~~~

(b) service.js:52-57（最小可观测版）

~~~diff
   cleanTransient(unit) {
-    try { run('systemctl', ['--user', 'stop', unit + '.service'], { timeout: 10000 }); } catch {}
-    try { run('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeout: 10000 }); } catch {}
-    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch {}
-    try { run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }); } catch {}
+    // run() 不抛（失败返回 null），原 try/catch 是死代码、四步全静默。
+    // stop/reset-failed 对「从未加载的单元」会非零退出，属正常；硬失败只有删文件与 daemon-reload。
+    const errors = [];
+    const step = (args, timeoutMs) => { const r = exec.runDetail('systemctl', args, { timeoutMs }); if (!r.ok) errors.push(args.join(' ')); return r.ok; };
+    step(['--user', 'stop', unit + '.service'], 10000);
+    step(['--user', 'reset-failed', unit + '.service'], 10000);
+    let unlinkOk = true;
+    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch { unlinkOk = false; }
+    const reloadOk = step(['--user', 'daemon-reload'], 15000);
+    return { ok: unlinkOk && reloadOk, errors };
   },
~~~

(c) 可选：让结果被消费，消除撒谎日志 —— lifecycle.js:40-43

~~~diff
   function _cleanStaleUnit(unit) {
-    service.cleanTransient(unit);
-    logger.info && logger.info('cleaned stale transient unit: ' + unit);
+    const r = service.cleanTransient(unit);
+    if (r && r.ok === false) logger.warn && logger.warn('clean stale transient unit 未完全生效: ' + unit + (r.errors && r.errors.length ? ' errors=' + r.errors.join(';') : ''));
+    else logger.info && logger.info('cleaned stale transient unit: ' + unit);
   }
~~~

不推荐把 ok 写成 stopped && reset && reloaded：pre-start 路径上单元通常本就不存在，systemd 对未加载单元的非零退出会被误报为失败。

风险与影响面
- 返回类型：resetFailed undefined->boolean；cleanTransient undefined->object。唯一调用方忽略/可选消费 -> 向后兼容。
- 测试：cross-platform-test.js:128 只查存在性；instance-*-test.js 注入假 Provider；platform-layer-portability-test.js:167 只切 stopUnit/startTransient 源码，均不触及 resetFailed/cleanTransient。
- 无新依赖（exec 已是 service.js 顶层依赖；run -> runDetail 不新增子进程，仅多拿 stderr）。
- 采纳 (c) 会在真实清理失败时新增 warn 日志；无 API/事件契约变化。

---

## 落地顺序与文件独占

1. N1（exec.js + service.js 键名）—— 是 N5(a) 的前置，避免重复改同一行。
2. N5（service.js:37/52-57，可与 N1 同批；lifecycle.js:41 为可选 (c)）。
3. N3（guard.js 4 行；范围是否含 access-key/close-action 由主控定）。
4. N4：无代码改动；仅更正 FIX-6.md:31 过时描述；N4-b 登记不做。

文件独占（HANDOFF §4.4 教训）：N1 与 N5 都改 service.js，必须同一执行者串行，不可分派给两个子代理。本轮未改任何文件，未运行任何测试。
