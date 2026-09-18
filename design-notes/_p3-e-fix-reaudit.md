# P3-E 报告一：FIX-1..8 结构性复审

> 只读复审。方法：读 `design-notes/FIX-1..8.md` + 逐项读对应源码 + 对「同一类缺陷」做**全仓同类调用点扫描**
> （这才是判断「结构解 vs 症状补丁」的依据：结构解在**边界**收口，症状补丁在**调用点**各打一个补丁）。
> 未运行任何测试/门禁。证据均为 `grep`/`read` 的 file:line。路径均为仓内相对路径。

## 0. 判定汇总

| FIX | 判定 | 一句话依据 | 未收口残留 |
|---|---|---|---|
| FIX-1 | **结构解（写侧）+ 存疑（执行侧）** | 两条 frp 写路径都走 `core.validateFrpExposure` 单一事实源 | 冷启动磁盘态不经闸；LAN 无 key 的执行侧仍放行 |
| FIX-2 | **结构解** | 三处均为「单一权威来源」修正，非逐点补丁 | 无 |
| FIX-3 | **结构解** | 互斥锁在任何 `await` 前置位 + `finally` 释放；busy 闸与 installer 同文案 | 无 |
| FIX-4 | **结构解** | 容错在加载边界；心跳归属在 heartbeat 层；P2 的 N2 补了 bootstrap 根因 | `registry._loaded` 死字段（低） |
| FIX-5 | **A = 症状补丁**；B/C 结构解 | A 的防线判据建立在「isUnitActive 会返回 null/undefined」的**错误前提**上 | A 的数据丢失形态仍在（更窄） |
| FIX-6 | **结构解**（+P2 N1/N5 补齐） | service.js 6 处调用点已全部如实判定成败 | `isUnitActive` 吞查询失败；`win32.js:33` |
| FIX-7 | **结构解** | 句柄传递 + 所有权比对 + 删 DEAD 跳过 | `frp.js:143/151` 无所有权守卫 |
| FIX-8 | **局部结构解（逐站点约定）** | ok:false→400 与 start 同规；B3 在回调边界 try/catch | `api/domains/relay.js:26` 仍无条件 200 |

---

## 1. FIX-6 专项：吞失败根因是否全域收口

根因：`exec.run()` 失败/超时返回 **null 而不抛**（`src/platform/util/exec.js:36-55`），
调用方若只 `try/catch` 就会恒报成功。

### 1.1 service.js 内 6 处调用点的现状（全部已判定成败）

| 位置 | 写法 | 状态 |
|---|---|---|
| `src/platform/os/service.js:30` daemonReload | `run(...) !== null` | FIX-6 ✅ |
| `:33` stopUnit | `run(...) !== null` | FIX-6 ✅ |
| `:37` resetFailed | `run(...) !== null` | P2 N5 ✅ |
| `:40` **isUnitActive** | `(run(...) || '').trim() === 'active'` + `catch { return false }` | ❌ **仍吞失败** |
| `:56/:57` cleanTransient 的 stop/reset-failed | `exec.runDetail(...)`，**故意不计入 ok**（未加载单元非零退出属正常） | ✅ 设计正确 |
| `:60` cleanTransient 的 daemon-reload | `runDetail(...).ok` 计入 errors | P2 N5 ✅ |
| `:76` startTransient | `runDetail`，`!r.ok` 抛错 | FIX-6 ✅ |

### 1.2 残留 (i)：`isUnitActive` 把「查询失败」与「不活跃」混为一谈（P1）

```
src/platform/os/service.js:38-42
  isUnitActive(unit) {
    if (!unit) return true;
    try { return (run('systemctl', ['--user','is-active',unit], {encoding:'utf8',timeoutMs:8000}) || '')
            .toString().trim() === 'active'; }
    catch { return false; }
  }
```

该函数**只可能返回 true / false**，永不返回 null/undefined：
`run()` 在超时/dbus 挂起时返回 null → `(null || '') === ''` → **false**。

这直接使 FIX-5 缺陷 A 的防线成为不可达分支：

```
src/domains/instance/ops.js:78-80
  // 停止已确认后二次复核：仅显式 false 视为已停；true / null / undefined（查询失败）一律按活跃处理。
  const active = service.isUnitActive(unit);
  stillActive = active !== false;        // 等价于 active === true（null 分支永不发生）
```

后果链：`stopUnit` 已返回 true → `is-active` 查询因超时返回 null → isUnitActive 回 false →
`stillActive = false` → `ops.js:85` `fs.rmSync(root)` **删除沙箱数据目录**。
即 FIX-5 想堵的「查询失败被当成不活跃 → 删数据」**在同一形态下仍可发生**（只是多了 stopUnit 成功这一前提，窗口更窄）。

第二消费者（同类，方向相反 = 假失败）：
```
src/platform/distribution/install.js:169-176
  const unitActive = () => service.isUnitActive(unit);
  if ((await portListening(host, port)) && unitActive()) { ... }
  ...
  return { ok:false, reason:'端口未就绪 或 单元未保持 active' };
```
端口已在监听、但 `is-active` 查询一次超时 → 判定 `ok:false` → 升级健康验证失败 → 触发回滚。

**结构解（推荐）**：把三态化下沉到 provider ——
用 `runDetail` 判定：`timedOut === true` → 返回 `null`（未知）；`ok` 且 stdout==='active' → `true`；
其余（含 systemd 对未知单元 exit 3）→ `false`。这样两个消费者的 `!== false` / `&& unitActive()` 语义立刻正确，
且**不破现有断言**：`test/exec-return-contract-test.js:139` 断言 active 单元 === true、
`:145` 断言不存在的单元 === false（未知单元不会 timedOut，仍回 false）。

**为什么不改调用点**：已有 `ops.js` 一处试图在调用点兜底，结果因前提错误变成死判据 ——
同类第三、第四消费者还会再犯。根因在 provider 的返回值语义。

### 1.3 残留 (ii)：全仓最后一个「丢弃 exec 结果并回报成功」的位置（P1）

```
src/platform/os/autostart/win32.js:32-36
    } else {
      ex.run('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);   // 返回值丢弃
    }
  } catch (e) { errors.push('gui autostart: ' + e.message); }
  return { ok: errors.length === 0, errors, ...status() };                   // 恒 ok:true
```

对照：同一文件的 `on` 分支（`:30-31`）用 `runDetail` 并检查 `r.ok`；`darwin.js:31/35/39` 与
`linux.js:37-41` 全部用 `runDetail` + `.ok`。**只有 win32 的 `off` 分支破坏了这一不变量** ——
关闭 GUI 自启失败时回 `ok:true`，调用方（`app/settings/autostart.js:27`）如实把 `ok:true` 透传给
`POST /autostart`（`api/domains/guard.js:73` → 200），面板显示「已关闭」而计划任务仍在。

全仓扫描确认这是**唯一**剩余位置（见 §4 表）。

---

## 2. FIX-1 专项：公网暴露闸是否全域收口

### 2.1 写侧：已收口（结构解）

`validateFrpExposure` 定义于 `src/domains/relay/core.js:161-164`（空 token 即拒，另含端口合法性/占用）。

frp 状态只有两条**权威写入路径**，两条都过闸：
1. `src/app/domain-actions/main.js:19-46`（patchDshMain，FIX-1 A 改按生效态 `!!meta.frpEnabled` 判闸，闸在 `writeMainMeta` 之前）；
2. `src/domains/relay/ops.js:91-105`（`setFrp`，`:96` 过同一函数，`:104-105` 才写 `inst`）。

`src/domains/relay/ops.js:190-196`（`syncProxy` 热换 `existing.frpEnabled`）**不是**独立写入口：
它把已过闸的 `inst.frpEnabled` 传播到 relay 的内存 `lanInstances`，不写权威实例记录。判定：无绕过。

### 2.2 执行侧：未收口（存疑 → 结构缺口，P1）

闸只装在**写入口**，没装在**执行边界**。冷启动路径：
`daemon.js:109-114` 从 `instances.json` 快照读入 `frpEnabled/remoteToken` →
`ops.js:190-196` 直接 `existing.frpEnabled = wantFrp; ...; this.syncFrpc()` → 启动 frpc。
全程**不调用** `validateFrpExposure`。若磁盘上已有 `frpEnabled:true + remoteToken:''`（旧版本写入的形态，
FIX-1.md 自述该残留「需要用户补设令牌」），则公网零认证暴露**在冷启动后立即重现**。

另注意读取侧的归一不一致：`src/app/state/main-store.js:35` 与 `src/app/state/store.js:77` 用
`frpEnabled: j.frpEnabled === true` 归一 —— 磁盘上的 `frpEnabled: 1` 会被读成 **false**（安全方向），
但 `frpEnabled: true` 保留，故上述冷启动缺口真实存在。

**结构解（推荐）**：在 `syncFrpc`/`frpmgr` 组装 frpc 配置**之前**，对每个启用项跑 token 校验
（复用 `core.validateFrpExposure` 的令牌分支或抽出的纯函数），失败则不建隧道 + `warn` + 事件。
即「写入口拦 + 执行边界再拦」双闸；否则任何绕过写入口的路径（磁盘、手改、未来新调用方）都会重现缺陷。

### 2.3 B2（LAN 需访问密钥）：写侧已收口，**执行侧未收口（P1，本次最高影响项）**

写侧：`src/app/settings/lan-panel.js:40-43` 拒绝未配置 key 的开 LAN（P2 的 N3 又把 `/settings/lan` 的
该失败从 500 精确映射为 400，`api/domains/guard.js:93`）。判定：写入口覆盖。

但执行边界是**「未配置 key 就整层跳过」**：
```
src/api/transport/server.js:78-82
  const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
  if (accessKey && !identity.loopback && req.method !== 'OPTIONS' && !requestHasAccessKey(req, accessKey)) { 401 }
```
`accessKey` 为 null 时第三层鉴权**被完全跳过**。而 CSRF 闸对无 Origin 请求放行：
`src/api/security.js:88` `if (!o) return true;`（为 curl/CLI 设计）。`isLocalOrLanHost` 允许 RFC1918 Host。

因此当 `apiHost === '0.0.0.0'` 且无 `apiAccessKey` 时，局域网内任意主机
`curl -H 'Host: <局域网IP>:<apiPort>' http://<局域网IP>:<apiPort>/instances/add ...`
可通过全部三层（身份层只查 socket 回环性；CSRF 因无 Origin 放行；key 层被跳过）→ **零认证驱动特权写 API**。

两条到达该状态的路径都不经 `setLanPanel` 的闸：
1. `setAccessKey('')` 清除密钥（`src/app/settings/access.js:20-21` 只改 config，**不触 apiHost**）→ 已开的 LAN 留在无密钥态；
2. 冷启动时磁盘 `apiHost: '0.0.0.0'`（直接编辑 config.json，或历史遗留）。

**结构解（推荐，两处一起）**：
- **执行边界 fail-closed**：`transport/server.js:79` 改为
  `if (!identity.loopback && req.method !== 'OPTIONS' && (!accessKey || !requestHasAccessKey(req, accessKey))) → 401`
  （未配置 key 时非回环一律拒，而不是放行）。这是把「可选密钥」从**开放默认**改成**关闭默认**。
- **状态收敛**：`setAccessKey('')` 时若 `apiHost` 非回环则强制回写 `127.0.0.1` + warn；
  或在绑定阶段（`api-rebind`/`startApi`）发现非回环且无 key 时拒绝绑定并回环 + warn。
- 兼容性：回环豁免不变（CLI/同机面板）；LAN 用户在配置 key 后行为不变。会**新增**一个可观测结果：
  未配 key 时局域网请求从「放行」变「401」——属安全方向修正，需在报告/契约中声明。

### 2.4 B1（Host===Origin）：结构解

`src/api/security.js:98` 主机一致性比对（`normalizeHostname`），壳源 `:91` 先行豁免。
判定：结构解（在身份/CSRF 的唯一边界 `originAllowed` 内收口，非在各路由补丁）。

---

## 3. 其余 FIX 的判定要点

- **FIX-2**：`api-rebind.js:41/77` 的 `ports` → `portsShared` 是**单一权威来源**修正；
  `bootstrap.js:10` 的裸 `ports` 是合法别名（`require(...).shared`），故全仓无同类未覆盖点。
  `controller.js` 改为消费 `applyPort` 返回值，与既有 `process.js:183` 同规 → 结构解。
- **FIX-3**：`ops.js` 的 `uninstalling` 在任何 `await` 前置位并在 `finally` 释放，
  `startInstall` 补 `policies.busy()` 闸（与 installer 同文案）；`store.js` 改用真实 `upgradeHold.enter()`。
  互斥语义收口在**单一入口**（ops 的 4 个操作），非逐调用点 → 结构解。
- **FIX-4**：`registry.js _load` 的 per-entry try 落在**加载边界**（单条坏 entry 不再截断整份）→ 结构解；
  `heartbeat.js` 的 `_heartbeatInFlight` 归属 + 快照遍历 + 回写前 `get(id) !== e` 校验 → 结构解；
  其根因（bootstrap 的 stall 阈值与 `.finally` 无代际）已由 **P2 N2** 在正确边界修复 → 收口。
  `shutdown.js` 消费 `stopUnit` 返回值 → 结构解。
- **FIX-5**：A 见 §1.2（**症状补丁**）；B 消费 `stopUnit` 结果、与 `start` 同规 → 结构解；
  C1 的 `INSTALLING` 不再无据判死 + 新增 `FAILED` 自愈、C2 回滚前先 `lifecycle.stop` → 局部结构解。
- **FIX-7**：`waitFrpcExit(frpc)` 改为**传句柄**（消除「读已置空字段」这类根因）→ 结构解；
  probe 的 `inst.pid === child.pid` 所有权比对（与 `frp.js:144/151` 同款）→ 结构解；
  删 DEAD 跳过使 kill 重拉分支可达 → 结构解。残留见 §4。
- **FIX-8**：A1/A2 加 `force`（重启必须先真停）→ 结构解；B1/B2 的 `ok:false → 400` 与 `start` 同规，
  但为**逐站点**约定（无共享 helper）→ 局部结构解，故同类站点会漏（§4）；B3 在回调边界 try/catch → 结构解。
  `guard.js:73/112/127` 的 `? 200 : 500` 经 P2 N3 裁定为**正确**（internal failure → 500），登记为不适用。

---

## 4. 同型未覆盖调用点清单（跨 FIX 的「同一类缺陷」扫描结果）

扫描方式：对每个 FIX 提炼其**缺陷类**，再全仓（`src/`）grep 该类形态，不局限于该 FIX 的文件。

| # | 缺陷类 | 位置 | 证据 | 优先级 | 最小修法 |
|---|---|---|---|---|---|
| 1 | 未配置 key 时鉴权层整层跳过 | `src/api/transport/server.js:79` | `if (accessKey && ...)` | **P1** | 改 fail-closed：非回环且（无 key 或不匹配）→ 401 |
| 2 | `is-active` 查询失败被当成不活跃 | `src/platform/os/service.js:38-42` | 只返回 boolean，null→false | **P1** | 用 `runDetail`/`timedOut` 三态化，返回 null 表未知 |
| 3 | 丢弃 exec 结果并回报成功 | `src/platform/os/autostart/win32.js:33` | `ex.run(...)` 结果丢弃，`return {ok: errors.length===0}` | **P1** | 改 `runDetail` + `if (!r.ok) errors.push(...)` |
| 4 | 未消费操作结果即回 200 | `src/api/domains/relay.js:26` | `send(200, r)` 无条件；同文件 `:23` 已按 `r.ok !== false` 映射 | **P1** | `send(r && r.ok !== false ? 200 : 400, r)`（与同文件 :23 同规） |
| 5 | 写入口有闸、执行边界无闸 | `src/domains/relay/ops.js:190-196` → `syncFrpc()` | 冷启动传播 `frpEnabled` 不过 `validateFrpExposure` | **P1** | frpc 组装前对启用项复校令牌，失败不建隧道 + warn |
| 6 | 退出回调无所有权守卫即重启 | `src/domains/relay/frp.js:143` 与 `:151` | `this.child === child` 只用于置 null，`_scheduleRestart()` 在外 | P2 | 加 `if (this.child === child && !this._intentionalStop) this._scheduleRestart()`... 或先判代际 |
| 7 | 清密钥不回关 LAN（状态分叉） | `src/app/settings/access.js:20-21` | 只改 `apiAccessKey`，不触 `apiHost` | P2 | 清空 key 时若非回环则强制回环 + warn |

（#1/#5 合起来即「FIX-1 的执行侧残留」；#3 是 FIX-6 类最后一处；#2 是 FIX-5 A 的根因；#4 是 FIX-8 类漏点；
#6 是 FIX-7 B1 同型；#7 是 FIX-1 B2 的状态面残留。均已给出本仓 file:line 证据。）

### 4.1 「强制 ok:true」端点：**复核后基本排除**（记录以免后人误报）

初查时把若干 `send(200, { ok: true, ...r })` 列为可疑，**逐条读实现后否掉**，理由值得固化：

`{ ok: true, ...r }` 中 **spread 在后会覆盖前面的 `ok`**，故它是「可覆盖的默认值」而非「强制 true」。
逐条核验：

| 位置 | 实现事实 | 结论 |
|---|---|---|
| `dist.js:41` `/dist/registry/probe` | `probeOrigin` 返回体**自带 `ok`**（`registry.js:110` 非法 origin → `{ok:false}`；`:112` → `ok: !!p.ok`） | `...r` 覆盖 `ok:true` → **正确，勿改** |
| `dist.js:18` `/dist/registry/set` | `setRegistryConfig`（`registry.js:203-217`）**从不返回 `ok:false`**（失败走 throw → 500；非法 origin 被静默过滤） | 与域层行为一致 → 非 FIX-8 类；**真正的小问题是「静默过滤」**（见下 P2-A） |
| `dist.js:23` `/dist/registry/refresh` | `selectRegistry` 失败走 throw → catch 500 | 无实质问题 |
| `router.js:70` `/router/proxy/update/check` | 失败走 throw → 500；成功体为 `{ok:true, versions:r}`（r 不覆盖 ok） | 非缺陷（同一对 apply 分支 `:75` 已正确映射 `r.ok ? 200 : 400`） |
| `instances.js:232` `upgrade` | `send(200, r)` **原样透传 r**（不强制 ok）；`r.ok:false` 时 body 如实为 false | 仅**状态码一致性**问题（FIX-8 覆盖了 remove/update/stop/start，未覆盖 upgrade）→ P3/存疑，非「谎报成功」 |

**明确正确、勿改**（读视图「永远可用」设计，失败也回 200 + 降级体）：
`router.js:18` portsView、`router.js:22` routerStatusView、`router.js:42` routerProviders、
`relay.js:12` frpStatus、`relay.js:33` listLan、`guard.js:53/176/181`、`plugins.js:19/24` 列表类、
`instances.js:166` `/lan/list` 视图、`instances.js:231` `check-update`（只读）。
`plugins.js:51/53/55`（install/uninstall/update）与 `router.js:75`（apply）**已**按 `r.ok` 映射，正确。

**P2-A（新增，真实但轻）**：`src/platform/distribution/registry.js:209-210` 对 `origins` 数组
`filter((x) => policies.isValidOrigin(x))` —— 非法镜像源被**静默丢弃**，API 回 `ok:true`，
UI 无从得知自己填的源被拒。最小修法：过滤后若 `list.length !== origins.length`，
在返回体带 `rejected: [...]`（只加字段，不改状态码）。

## 5. 建议主控下一步（按性价比排序）

1. **P1-#1（server.js fail-closed）+ #7（清 key 回环）**：最小、无测试钉子、直接关闭「局域网零认证写」这一类；
   属安全方向修正，需在报告中声明新增 401 行为。**最推荐先做这一对。**
2. **P1-#3（win32.js off 分支）**：1 行改动，与同文件 on 分支、darwin/linux 全面一致。
3. **P1-#4（relay.js expose 映射）**：1 行改动，与同文件 :23 同规；无测试钉子。
4. **P1-#2（isUnitActive 三态）**：改动面稍大（provider 契约 + 2 个消费者），但它是 FIX-5 A 的**根因**；
   建议与 `ops.js` 的注释/判据同步（三态后 `!== false` 才真正成立）。注意 `makeUnsupported.isUnitActive`
   （`service.js:91`）与假 Provider（多个 test）无需改，但需确认 `test/exec-return-contract-test.js:139/145` 仍绿。
5. **P1-#5（frpc 执行边界复校）+ P2-#6**：防御纵深，可随后。
6. `guard.js:73/112/127` 与 `shell.js:74` 的 `? 200 : 500`：经裁定**不适用**，勿改。
---

## 6. 与 P3-E-1《AUDIT 积压清单》的交叉核对（`design-notes/_p3-e-audit-backlog.md`）

两份报告由两个代理独立产出，本节省略重复项，只列**一致结论、我的补充、以及一处实质分歧**。

### 6.1 一处实质分歧（建议主控采信本节证据，或指派一人复核这 3 行）

P3-E-1 在「已修证据举例」中把**数据不可逆删除防线**判为已修，依据是
`src/domains/instance/ops.js:75-80` 的 `active !== false`。

**我的判定不同**：该判据的**形状**已加，但**语义不成立**（见本文 §1.2）——
`service.isUnitActive`（`src/platform/os/service.js:38-42`）**只可能返回 true/false**（`run()` 失败返回 null
→ `(null||'')==='active'` → false），永不返回 null/undefined，故 `active !== false` 恒等于 `active === true`，
注释宣称的「查询失败按活跃处理」是不可达死分支。

证据链（可直接复核 3 行）：
`ops.js:79-80`（`const active = service.isUnitActive(unit); stillActive = active !== false;`）
+ `service.js:40`（`(run(...) || '').trim() === 'active'`，布尔）
+ `service.js:41`（`catch { return false; }`，布尔）。

→ 结论：**P3-E-1 的「已修」应降级为「部分修」**；根因项（本文 §4 #2）仍在。两份报告在
「`ops.js` 有防线代码」上无分歧，分歧只在**该防线对本类故障是否有效**。

### 6.2 我对 P3-E-1 P1#1（熔断实参）的精确化

P3-E-1 指 `forward.js:132/:229` 传 `acc` 给 `markInstanceNetFail`，而 `proxy.js:177` 因账号无 `pid` 返回。
我逐行复核后**精确化为**：

- `:229`（`finishAborted`，**流式中断**路径）：确为唯一调用，传 `acc` → `proxy.js:177-178` 直接 return
  → **流式中断永不计入请求级熔断**。这是**真实功能缺口**。
- `:132`（net-error 路径）：虽也传 `acc`（死调用），但**同一分支的 `:138` 传的是正确的 `inst`**
  （`activeProv.markInstanceNetFail(inst)`），故 net-error 仍会计入熔断 → `:132` 是**冗余死调用**，非功能缺口。
- 测试盲区**已复核**：`test/router-circuit-breaker-test.js:61-62` 只断言 `/markInstanceNetFail/.test(strip(fwd))`
  即「字符串出现过」，**不校验实参** → 传 `acc` 也绿。这正是本仓反复踩的「断言钉在字符串形态上 → 静默失覆盖」。

### 6.3 我补充、P3-E-1 未列的项（4 项，见本文 §4 #1/#3/#4/#5）

`transport/server.js:79` 未配 key 时鉴权整层跳过、`autostart/win32.js:33` 丢弃 exec 结果、
`api/domains/relay.js:26` expose 无条件 200、`relay/ops.js:190-196` frpc 执行边界不过闸。
P3-E-1 聚焦 AUDIT 文档条目，这 4 项属「FIX 自身未收口的同类点」，两边清单互补、无重复冲突。

### 6.4 合并后的 P1 优先序（去重，主控可直接排期）

| 顺序 | 项 | 位置 | 成本 |
|---|---|---|---|
| 1 | 未配 key 时鉴权 fail-closed（+清 key 回环） | `api/transport/server.js:79`、`app/settings/access.js:20-21` | 1-2 行 ×2 |
| 2 | win32 关闭自启丢弃 exec 结果 | `platform/os/autostart/win32.js:33` | 1 行 |
| 3 | frp expose 端点无条件 200 | `api/domains/relay.js:26` | 1 行 |
| 4 | 流式中断不计熔断（+把字符串断言升级为行为断言） | `router/handlers/forward.js:229`、`test/router-circuit-breaker-test.js:62` | 1 行 + 测试 |
| 5 | isUnitActive 三态化（治 FIX-5 A 根因） | `platform/os/service.js:38-42` | provider + 2 消费者 |
| 6 | frpc 执行边界复校令牌 | `domains/relay/ops.js:190-196` → `syncFrpc` | 中 |
| 7 | P3-E-1 清单 §P1 余项（registry ownership 合并、projection BACKOFF healthy、entry.stop 落 desired 等） | 见其报告 | 批量 |

无 P0。**前 4 项合计约 6 行改动**，建议作为「P3-F 安全与假成功小批」一次提交。

