# CI 风险核查：FIX-1..8 行为变更 vs test/ 既有断言

> 方法：**只读静态核查**（grep/read/glob）。未运行任何测试、未改任何源码。
> 范围：`test/` 全部 136 个文件 × FIX-1..8 的 8 份报告所列「可观测行为变化」。
> 日期：本次会话。

## 0. 结论（先读）

1. **未发现「断言钉在 FIX 前旧行为上、必然让 CI 变红」的用例。**
   唯一被实现形态钉住、且确实需要随 FIX 同步的判据是
   `test/kernel-daemon-contract-test.js` 的 D-2 / D-6（`ports.register` → `portsShared.register`），
   **FIX-2 已同步**（现为 `ports(?:Shared)?\.register\('supervisor-api'`，3 处）。
2. 其余 FIX 的行为变更**要么无任何断言**，要么既有断言的预期**恰好就是 FIX 后的新行为**
   （属「先写测试、后修实现」形态），故不会红。
3. 真正值得主代理注意的是**反向问题**：FIX-1 / FIX-5 / FIX-8 的对外契约变更
   **零测试覆盖** —— 改错或回退，CI 不会拦。下面逐条列出（含建议补的断言）。

---

## 1. 逐条核对

| # | test 文件:行 | 断言内容 | 旧行为（FIX 前） | FIX 后新行为 | 裁决 / 建议修法 |
|---|---|---|---|---|---|
| 1 | `test/kernel-daemon-contract-test.js:52,80,83-85` | D-2/D-6：`/ports(?:Shared)?\.register\('supervisor-api'` / `…, port\)`；反向用例 `!registersActual("ports.register('supervisor-api', this.config.apiPort);")` | `api-rebind.js` 只绑定 `portsShared` 却调用未定义的 `ports.register` → 端口登记整体丢失 | 两处改 `portsShared.register`（FIX-2 A） | **绿（已同步）**。不改。若要更严，可加断言 `require('.../ports').shared` 的绑定名。 |
| 2 | `test/round13-router-relay-gaps-test.js:60-66,85-95` | ① `patchDshMain` 必调 `validateFrpExposure` 且在 `this.state.writeMainMeta(meta)` 之前；行为：空 token 开 frp → `ok:false` 且未落盘；非法端口 → 拒；令牌+合法端口 → 通过；关 frp 不被拦 | `if (p.frpEnabled === true)` 判闸：非布尔真值（1/"true"）绕过闸；已开启后单改 `remoteToken:''` / `frpRemotePort` 也绕过 | `if (!!meta.frpEnabled)` 按「写入生效后状态」判闸（FIX-1 A） | **绿**（该用例本就按修复后行为写）。**风险**：FIX-1 的真实缺陷形态（`frpEnabled:1`/`"true"`、已开启后改空 token）**无用例**。建议改断言侧补 2 条行为用例。 |
| 3 | `test/defects-batch-f-test.js:41-61`（K6-a/b） | `originAllowed`：evil.com Host/Origin 拒；回环/LAN/壳 放行；异端口拒；无 Origin 放行；畸形 Origin 拒 | Origin 闸只比端口，不校验 Origin 主机 == 实际 Host | FIX-1 B1 追加 `Origin 主机 === Host 主机`（`security.js:100`） | **绿**（K6-b 用例均不带 Host，FIX-1 明确「Host 缺失时维持原语义」）。风险：**Host≠Origin 同私网**（FIX-1 B1 的核心防线）**无回归用例**。建议补。 |
| 4 | `test/lan-access-boundary-test.js:47-78`（E-a..E-f） | LAN/RFC1918/回环/壳 → ALLOW；evil.com / 公网 IP / 非私有边界 → DENY | 同上 | 同上（B1） | **绿**（Host/Origin 同源或 Origin 缺失）。风险与 #3 同。 |
| 5 | **无对应用例**（`grep setLanPanel test/` = **0 命中**） | —— | `setLanPanel(true)` 直接置 `apiHost='0.0.0.0'` 并恒 `{ok:true}` | FIX-1 B2：未配置 `apiAccessKey` 时返回 `{ok:false,error}`，不由 guard.js 改状态码 → HTTP **500**（guard.js 既有 `r.ok ? 200 : 500`） | **无红（零覆盖）**。这是**对外契约变更**（`POST /settings/lan {enabled:true}` 可能变 500）。建议补：无 key → 非 2xx + `ok:false`；有 key → 200。 |
| 6 | `test/uninstall-timeout-test.js:37-56` | 以「`host.uninstalling = true;` → `module.exports`」为区间，断言区间内有 `UNINSTALL_TIMEOUT_MS`/`setTimeout`/`clearTimeout`/`if (done) return`/`killTree`/`} finally {`，且该 finally 后 220 字符内 `host.uninstalling = null` | 锁在 `await host.hooks.stopForUpgrade()` **之后**置位（TOCTOU） | FIX-3 A1：锁前置到任何 await 之前 + 全程 try/finally | **绿**（重排后区间与首个 finally 仍成立）。**脆弱**：若在锁置位与 finally 之间插入别处 try/finally 会假红。建议改为「uninstall 函数体内 try/finally 且 finally 释放锁」的语义判据。 |
| 7 | `test/round13-discipline-gaps-test.js:117-121,160-170`（②/②-b） | ② `stopUnit→true, isUnitActive→false` → `removeInstance` 返回 `ok:true`；②-b `stopUnit` 抛 → 不崩且 `ok:true` | `stillActive = isUnitActive(unit) === true`；查询失败被当成不活跃 → 删数据 | FIX-5 A：以「停止确认（`stopUnit !== false`）」为唯一放行条件；`true/null/undefined`（查询失败）一律按活跃 | **绿**（两条用例在新逻辑下都删数据、`ok:true`）。风险：**FIX-5 的核心新行为无覆盖** —— `stopUnit` 返回 `false`、或 `isUnitActive` 返回 `null/true` 时必须 **保留目录 + `dataPreserved:true`**（数据丢失防线）。建议补 2 条反向用例。 |
| 8 | `test/instance-safety-test.js:55,60-63,67-69,122-133`（L-a/L-b/L-h） | `await rollback(` ×3；`version: oldVersion` ×1；`const rollback = async` ×1；`isUnitActive(unit)`；`!stillActive`；`stillActive ? { ok: true, dataPreserved: true` | 同一份回滚内联 3 处；删除前不复核单元活跃 | FIX-5 收敛回滚到一处；删除前以停止确认为闸；FIX-5 C2 在 `rollback` 开头新增 `await lifecycle.stop(id)` | **绿**（逐条命中，已实测 src）。新增的 `lifecycle.stop` 不计入 L-a 的 `await rollback(` 计数，无冲突。 |
| 9 | `test/round8-fixes-test.js:269-271` | `shutdown.js` 含 `r.ok === false` 与 `shutdown_daemon_stop_incomplete` | —— | FIX-4 C 在同文件新增 `shutdown_sandbox_stop_incomplete`（**不同事件名**） | **绿**。不改。 |
| 10 | `test/graceful-shutdown-test.js:87,91` | `relay/daemon.js` 含 `waitFrpcExit` 与 `setTimeout(resolve, 4000)` | `waitFrpcExit()` 读 `frp.child`（已置 null）→ 空等待 | FIX-7 A：`waitFrpcExit(frpc)` 接收句柄 | **绿**（按名字断言）。风险：签名/语义变更无行为用例。建议补「有 frpc 子进程时 shutdown 真等待」。 |
| 11 | `test/round13-router-relay-gaps-test.js:128-142`（③） | 删除路径 `stopInstance(x, true)` 计数 `>= 3`；反向 `!/removed\.instances \|\| \[\]\) removed\.stopInstance\(i\)/` | `applyProxyUpdate` 用不带 force 的 `stopInstance` | FIX-8 A1：`stopInstance(inst, true)`（计数只增） | **绿**。 |
| 12 | `test/api-contract-test.js:113-114,119-125` | `POST /instances/stop` → 200 且 `ok:true`（stub `stopInstance → {ok:true}`） | `remove/update/stop` 恒 `send(200, r)`（`ok:false` 也 200） | FIX-8 B1：与 start 同规 `r && r.ok ? 200 : 400` | **绿**（stub 恒 `ok:true`）。风险：**对外契约变更零覆盖** —— 无任何用例断言失败时 400。建议补 `{ok:false}` → 期望 400 的用例（3 条路由）。 |
| 13 | `test/p2p-api-test.js:87-88,197-198` | `/router/start` → 200 `running:true`；`/router/stop` → 200 `running:false` | 同上恒 200 | FIX-8 B2：`ok === false` → 400 | **绿**（真实调用返回 `ok:true`）。 |
| 14 | `test/round13-dropped-result-test.js:44-68`（B/D） | `router.js` 每个 `.then(` 行必须有 `.catch(` 且在链尾；无 `send(...).catch` | 第 33/36 行 `setRouterRunning` 链无 `.catch` | FIX-8 B2 改写为 `.then(...).catch(...)` | **绿**（改写后两行带 catch 且在链尾）。 |
| 15 | `test/probe-gate-and-ownership-test.js:102` | `setProviderKeys` 体内含 `/p\.stopInstance\(/` | —— | FIX-8 A2 改的是 `endpoint.js::deactivateProvider`（`stopInstance(i, true)`） | **绿**（不同文件）。 |
| 16 | `test/managed-registry-test.js:108-166`、`test/round13-robustness-batch-test.js:120-124` | 心跳：观测收集/节流/逐对象超时(`iv*6`)/`derivePhase`；`registry.js` 有 `e._nextTickAt = null;`，`heartbeat.js` 有 `e._nextTickAt = Date.now() + tickEvery * iv;` | 直接迭代活数组；同 registry 可并发两拍 | FIX-4 B：`_objects.slice()` 快照 + `_heartbeatInFlight` 单飞 + 回写前归属校验 | **绿**（用例为顺序 await；两处字面量保留：registry.js:211 / heartbeat.js:74）。 |
| 17 | `test/heartbeat-selfheal-test.js:58-63` | `bootstrap.js`（`host.`→`this.` 归一后）含 `this._heartbeatBusy = false;`、`iv * 12|stallMs`、`_heartbeatStalls++`、`强制释放防停摆` | —— | FIX-4 未改 `bootstrap.js`（FIX-2 B 只删 daemon 分支的提前 `return;`） | **绿**。N2（stall 阈值/无条件清 busy）仍在范围外，未被 FIX-4 改动。 |
| 18 | `test/main-port-rederive-test.js:44-52` | 直调 `sup._applyMainPort(found.port, found.pid)` 后 `config.targetPort === realPort` | controller 忽略 `applyPort` 返回值并强制写 `config.targetPort` | FIX-2 C：改 `if (this.main.applyPort(...)) { this.config.targetPort = ... }`（仅 controller 调用点） | **绿**（该用例直调 `_applyMainPort`，不经 controller；且本机 register 成功返回 true）。风险：controller 侧无用例。 |
| 19 | `test/exec-return-contract-test.js:107-116`（A4） | `service.js` 无 `Object.assign({stdio:'ignore'})` 且含 `exec.run(cmd, args, opts \|\| {})` | `daemonReload/stoptUnit/startTransient` 忽略 `run()` 返回值恒 `return true` | FIX-6：改为 `run(...) !== null` / `exec.runDetail` | **绿**（`run()` 包装与 A4 判据未被改动，service.js:23 仍匹配）。 |
| 20 | `test/platform-layer-portability-test.js:162-179`、`test/cross-platform-test.js:131-135` | 不支持平台 `stopUnit/startTransient` 抛错且带平台标签；`isUnitActive(具名)=false` | —— | FIX-6 只改 Linux systemd Provider 的 3 处 | **绿**（`makeUnsupported` 未改）。 |

---

## 2. 与 FIX 无关但会叠加的相邻风险（供主代理判断，不在本次范围内）

- **门禁的「非空转自检」总量阈值**：`test/domain-structure-gate-test.js:867-868` 的 DG-12
  要求扫描集非空（文件 ≥140 / 字节 ≥500000 / `this.X()` ≥400）。该计数被
  **297 个未提交改动里的架构归一化**（`Object.assign(prototype)` 归零、`this.` 减少）影响，
  与 FIX-1..8 的语义无关。本次只读工具无法给出精确计数，**需 CI 实跑确认**。
- FIX 报告自身声明的「残留/超出范围」项（FIX-1 的旧盘上「frp 开 + 空 token」、
  FIX-2 N2 的 stall 阈值、FIX-5 N4/N5 同型缺陷）都**没有**测试覆盖，也不会因现有断言变红。

## 3. 建议（给主代理）

1. **可以直接提交并跑 CI**：预期 FIX-1..8 相关断言**不会**因「旧行为」变红。
2. CI 若变红，先看 **#5 / #12 / #13** 的邻域（对外契约变更）与 **§2 的门禁计数**，
   再怀疑 FIX 语义本身。
3. 建议顺带补 4 处零覆盖回归（都不改实现，只加断言）：
   - FIX-1 A：`patchDshMain({frpEnabled: 1})` 空 token → 拒；已开启后 `{remoteToken:''}` → 拒。
   - FIX-1 B1：`originAllowed({host:'192.168.1.5:P', origin:'http://192.168.1.6:P'})` → false。
   - FIX-1 B2：`setLanPanel(true)` 无 `apiAccessKey` → `ok:false`；有 → `ok:true`。
   - FIX-5 A：`stopUnit→false` 与 `isUnitActive→null` → `removeInstance` 返回
     `{ok:true, dataPreserved:true}` 且**目录未删**。
   - FIX-8 B1：`instances` stub 返回 `{ok:false}` → `/instances/{remove,update,stop}` 期望 400。
