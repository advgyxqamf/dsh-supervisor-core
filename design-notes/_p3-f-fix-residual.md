# P3-F 报告：同型缺陷的未覆盖调用点（6 项）

> 范围：6 个独占文件。全流程未跑任何测试/门禁（只 `node --check` / grep / read / wc / 只读 git），
> 未做 git 写操作，未改 `test/`，未加依赖。逐项独立最小改动 + 独立 `node --check`。

## 0. 汇总

| # | 文件 | 改动 | 行为变更 | 既有断言 |
|---|---|---|---|---|
| 4 | `platform/os/service.js` | isUnitActive 三态化（runDetail + timedOut/code 判定） | 查询失败由 false 改 **null** | A6 两条仍绿（见 §1） |
| 3 | `platform/os/autostart/win32.js` | off 分支先查再删 + runDetail | 真正删除失败时 ok:false（原恒 ok:true） | A8/P4 不受影响 |
| 5 | `domains/relay/ops.js` | syncFrpc 建隧道前复校暴露闸 | 不过闸的启用项**不建隧道** + warn + `lan_frp_blocked` 事件 | 门禁①仍绿 |
| frp | `domains/relay/frp.js` | error/exit 事件加所有权守卫 | 陈旧子进程事件不再排期重启 | R2/R3/R4 语义不变 |
| #5 | `domains/router/handlers/forward.js` | :229 实参改实例；删 :132 冗余死调用 | 流式中断**计入熔断** | R-a/b/c/e 全绿（见 §5） |
| #6 | `platform/distribution/registry.js` | 非法镜像源不再静默丢弃 | 新增 warn + 返回 `rejectedOrigins` | round8 J-j 不受影响 |

`node --check` 6/6 通过。

---

## 1. #4 isUnitActive 三态化（最高优先）

**改动**：由 `run(...)`（失败仅返回 null）改为 `exec.runDetail`，返回：
- `r.timedOut` → **null**（查询未完成 = 未知）
- stdout `active` → **true**
- 有状态输出，或 `r.code !== null`（systemctl 已作答，含非零退出）→ **false**（确认不活跃）
- 两者皆无（未能执行，如 ENOENT）→ **null**
- 抛异常 → **null**（保持「绝不抛」契约）

**行为变更声明**：
- **删除路径**：`domains/instance/ops.js:79` 的 `stillActive = active !== false` 现在真正生效 ——
  is-active 超时（dbus 挂起）时不再被当成「不活跃」，`fs.rmSync` 沙箱数据的不可逆删除被阻止，
  并改为 warn + `inst_remove_data_preserved` 事件。**这正是 FIX-5 A 的根因修复**。
- **健康等待**：`install.js:169` 的 `unitActive()` 在未知时返回 null（falsy），与旧行为（false）等效，
  该路径**行为不变**。
- **不支持平台的 Provider**（`makeUnsupported.isUnitActive`）**未改**：具名单元仍恒 false。
- 无状态码/日志文案变更（新增的只是三态取值）。

**既有断言为何仍绿**：
- `exec-return-contract-test.js:139`「确实 active 的单元 === true」→ stdout `active` ✓
- `:145`「不存在的单元 === false」→ systemctl 对未知单元仍会给出状态并/或非零退出码 →
  走「`state || r.code !== null` → false」分支，**不依赖 stdout 是否为空**，故跨 systemd 版本稳健 ✓
- `platform-layer-portability-test.js:178`「不支持平台具名单元 = false」→ 未改该 Provider ✓
- `cross-platform-test.js:128`、`instance-safety-test.js:67` 为存在性/源码形态断言 ✓

**R1**：同时更正 service.js 文件头一处过时说明（原举 isUnitActive 传 encoding，现经 runDetail 读状态），
不变量不变；新注释 token 在 test/ 零命中（§R1 证据）。

## 2. #3 win32.js off 分支

**改动**：把 `status()` 内的 `has` 闭包提为模块级 `hasTask(tn)`（行为等价的纯重构），
off 分支改为「先查再删」：
`if (hasTask('DSH-Supervisor-GUI')) { const r = ex.runDetail(...Delete...); if (!r.ok) errors.push('schtasks gui delete: ' + (r.error || '执行失败')); }`

**行为变更声明**：
- 真的发起删除且失败 → 现在 `ok:false` + errors（原来无条件 `ok:true`）—— 这就是本项要修的「丢结果报成功」。
- 任务本就不存在（幂等关闭）→ 不发起删除、不报错。**这是对任务书「失败即 errors.push」的一处有意收窄**：
  schtasks 对不存在任务返回非零且文案随语言变化，若照搬同文件 on 分支/darwin/linux 的无条件 push，
  会把「关掉一个本就没开的自启」报成失败（假红）。故用一次 `/Query` 做语言无关的幂等判定。
  **若主控要求与 darwin/linux 逐字同形，可改为无条件 push**（代价：上述假失败）。
- 返回结构 `{ok, errors, ...status()}` 不变。

**既有断言为何仍绿**：`kernel-daemon-contract` D-8 的「所有者…桌面壳」注释未动（grep=1）；
`platform-capability-audit` A2 只查源码含 `schtasks` 与 `/Create` ✓；
`autostart-ownership` P4 走的是 `setGuiAutostart`（本文件未改该函数）✓。

## 3. #5 relay/ops.js：冷启动 frp 执行边界

**改动**：`syncFrpc()` 在建隧道前对每个 `frpEnabled` 项复用 **同一事实源** `core.validateFrpExposure`
（`remoteToken: inst.remoteToken || inst.token`，`peers: lanInstances`，`selfId: inst.id`）：
不过闸的实例从传给 `syncFromInstances` 的清单中剔除，并 warn + `lan_frp_blocked` 事件。
非 frp 项原样透传；`this.frp` 契约与返回形态不变；写入口的既有闸未动。

**行为变更声明**：冷启动（或任何直接读磁盘态的路径）下，「`frpEnabled` 为真但远程令牌为空/端口非法/端口与他例冲突」
**不再生成隧道** —— 消除 FIX-1 自述的执行侧残留（公网零认证暴露在冷启动后重现）。
新增一条 warn 日志与 `lan_frp_blocked` 事件；无状态码变更。

**既有断言为何仍绿**：`round13-router-relay-gaps` 门禁①要求 relay 侧出现 `validateFrpExposure(` → 仍满足（现 5 处）；
`frp-resilience-test` 直接调 `FrpManager.syncFromInstances/buildConfig`（不经 `LanManager.syncFrpc`），
且其夹具 `frpEnabled:false` → 不受影响；`lan-daemon-test` 的 `makeInst` 为 `frpEnabled:false` ✓；
`domain-structure-gate` 的 WRITE_TARGET_CALL 判据只针对方法名，未新增写目标。

## 4. frp.js：`_scheduleRestart` 所有权守卫

**核验结论**：守卫**确实缺失**（`this.child === child` 只用于置 null，`_scheduleRestart()` 在其外），语义适用 → 按同规补。

**改动**：error 与 exit 两个处理器改为「先记日志，再判所有权」：
`if (this.child !== child) return; this.child = null; if (!this._intentionalStop) this._scheduleRestart();`

**行为变更声明**：陈旧子进程（已被新进程取代）迟到的 error/exit 不再排期重启 ——
原实现会让 `_restartAttempts` 被无谓递增，到 5 次即「连续重启失败，停止重试」，
使**真实崩溃**的自愈被提前禁用（FIX-7 B1 同型）。当前子进程的事件路径完全不变；
`stop()` 已先置 `this.child = null`，故主动停止仍不重启。

**既有断言为何仍绿**：`frp-resilience-test` R2（外部 SIGKILL → 排期重启 → 退避后重拉）、
R3（主动 stop 清定时器/不重启）、R4（不可执行 → child 清空、不崩）在被 kill 的子进程**仍是当前进程**时
所有权判定通过，语义与原先一致 ✓。

## 5. #5 forward.js：流式中断的熔断归属

**改动**：
(a) `:229`（`finishAborted`，上游 `aborted/error/close` 三条路径）把 `markInstanceNetFail(acc)` 改为
    `const inst = parse.instOf(prov, acc); if (inst) prov.markInstanceNetFail(inst)`（try/catch 保留）。
(b) 删除 `:132` 的冗余死调用 `rt.prov.markInstanceNetFail(acc)`（未加 try/catch；proxy 实现要求带 pid，
    传 acc 无操作；`base.js:62` 的实现会**抛错** —— 删除同时消除一条未捕获抛出路径）。
    net-error 的归属仍由 `:138` 的 `activeProv.markInstanceNetFail(inst)` 承担。

**新行为（供 P3-B 断言对齐，逐条）**：
1. **谁计入**：仅**上游侧**流式中断（`ur` 的 `aborted`/`error`/`close` 且未 `readableEnded`）→
   对 `parse.instOf(prov, acc)` 取到的代理实例调用一次熔断计数。
2. **计入条件**：该实参必须带 `pid`（`proxy.markInstanceProblem` 的既有前置）；无 pid 时不计数（静默，与实现一致）。
3. **触发阈值**：同一实例连续累计 2 次（可与 net-error 计数混合）→ `restartInstance(inst, 'req-net-error x2')` 并清零。
4. **不计入**：客户端中断（`res` 的 `close` → CLIENT-ABORT 分支）**不**计数 —— 客户端离开不是上游故障；
   该分支不调用熔断（保持原设计）。
5. **不会重复计数**：`writeThrough`（流式路径）只在 `out.phase === 'ok'` 时进入，net-error 在尝试循环内处理，
   两者互斥；同一次中断只由 `finishAborted` 计一次。
6. 非 `instanceLifecycle` 的 Provider 仍经 `supports()` 跳过；`base` 的实现若被调用仍在 try/catch 内。

**既有/新增断言为何仍绿**：`router-circuit-breaker-test` 升级后的硬判据以「非注释行抽取熔断调用实参」为判据 ——
现两处实参均为 `inst`（`BARE_ACC` 不命中、`INST_SHAPED` 命中）；`.`+`markNetFail(` 在代码中 0 处；
`markInstanceNetFail` 仍在；`endInflight(acc, prov)` 仍 4 处（≥2）。注释里出现的缺陷形态 `markInstanceNetFail(acc)`
由该测试的 `strip`（滤 `//` 行）排除。

## 6. #6 registry.js：非法镜像源可见化

**改动**：`setRegistryConfig` 收集 `rejected = raw.filter(x => x && !isValidOrigin(x))`；
若有：经 `state.logger.warn` 记录（前 3 条 + 总数），并在返回的 info 上加 `rejectedOrigins`（仅非空时）。
「全部非法则保留既有 origins」的原行为不变。

**行为变更声明**：POST `/dist/registry` 的响应新增 `rejectedOrigins` 字段（**加性**，UI 可见）；
新增 warn 日志。无状态码/持久化格式变更。

**既有断言为何仍绿**：`round8-fixes` J-j 读的是 `saveRegistryConfig` 的 `doc.mode/origins/manualOrigin` 写法（未改）；
`round13-contract-reload` 断言 `registryInfo` 函数体首行是 `reloadContractIfStale(state)`（未改）；
两处函数签名均未变。

## 7. R1 / R2 证据

- **R1**：对本批全部新增/改写注释行切 token —— CJK ≥4 共 70 个 token，在 `test/` **零命中**；
  ASCII ≥6 的命中项逐条核对均为**代码标识符**（`inst`/`markInstanceNetFail`/`instOf`/`runDetail`/
  `validateFrpExposure`/`schtasks`/`timeoutMs` 等），其断言目标仍在**代码**中（未进注释），
  故不构成注释钉子、CP 门禁不会被触发。
- **P2 §7.1 五条真钉子**复查在位：config.js `最小兜底`=1、deploy.js `不再是 SEA`=1、
  entry.js `静默丢弃`=2、instance/ops.js `探测失败不阻断创建`=1、win32.js `所有者…桌面壳`=1。
- **R2**：本批**未删除任何导出/函数/常量**（唯一删除是 forward.js 一处无操作调用表达式）。

## 8. CI 风险点（按可疑度排序）

1. **forward.js 的实参改法与 P3-B 断言同批**：该测试为硬判据，必须与本改动同批提交（已按 P3-B 的判据逐条自证）。
2. **isUnitActive 的 `false` 分支依赖「systemctl 已作答」**：A6 反向断言在 stdout 为空的未知单元上
   靠 `r.code !== null` 兜住；若某 systemd 版本对未知单元既空输出又无退出码（极罕见），该断言会转红 ——
   届时把 `state || r.code !== null` 放宽为「非超时即 false」即可（语义退化一档，但不丢数据防线）。
3. **win32.js 的幂等收窄**：见 §2 的取舍说明，主控可一键改为无条件 push。
4. **relay/ops.js 的剔除可能减少 frpc 代理数**：这是**期望**行为（不过闸不建隧道）；
   若某测试夹具用「frpEnabled:true 且无令牌」并断言代理数，会转红 —— 静态核对未见此类夹具。
5. 本批无新增装饰符号、无新增依赖、无 `scripts.test` 链改动。
