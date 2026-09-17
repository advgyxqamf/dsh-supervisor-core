# AUDIT-r5-instance-plugin-shell

> 范围：src/domains/instance/**、src/domains/plugin/**、src/domains/shell/**（题目：instance/plugin/shell 域业务逻辑正确性）
> 方式：只读代码推理 + 静态检查（node --check / grep / wc / git）。**未运行任何测试、未启动任何 daemon、未改 src/**。
> 结论分级：高（可证数据/安全后果）／中（可证错误语义或资源问题）／低（健壮性/一致性/文档）。
> 基线说明：审计期间 K 组并发对 instance 域做了**注释压缩 + 死导出/死变量删除**（git diff 只有注释、`lifecycle` 返回表去掉 `_cleanStaleUnit/_systemdStart`、`sandbox.js` 去掉 `sandboxCommand/defaultCommand`、`upgrade.js` 删掉 `_latestDshVer/_latestDshVerAt`）。经 grep 确认这些名字无 src/test 外部引用，且未改变任何控制流；本报告行号与结论已按**当前工作树**复核。

---

## 0. 组别与改动说明

本题为 J 组题目（对 src/ 只报告）。因此本轮**未修改任何 src/ 文件**，仅新增本报告。

K 组改动正确性抽查：
- `src/domains/plugin/market.js` 删除局部变量 `const pkgName = meta.name || r.name;`（原死变量）与 `_refreshIfStale(force)` 多余实参 → 语义等价。
- 移除的导出（`CLI_TIMEOUT_MS`/`DEFAULT_REGISTRY`/`RAW_MIRRORS`/`CATEGORIES`/`MAX_JOBS`/`pkgVersion`/`listInstalledNative`/`writeJournal`/`pathExtra`/`_bundleOpQueue`/`scrubPluginLayers`/`cleanupJobs`/`_cleanStaleUnit`/`_systemdStart`/`sandboxCommand`/`defaultCommand`）经全仓 grep（src/ + test/ + ui/）确认无外部引用，安全。
- instance 域 K 组改动为纯注释 + 上述死名删除；无逻辑变化。

---

## 1. 四维审计发现（确认的错误）

### A. 业务逻辑 / 安全（高）

#### F1. 删除实例的「单元仍活跃则保留数据」防线失效，可能不可逆删数据
- 位置：`src/domains/instance/ops.js:72-77`；根因 `src/platform/os/service.js:36-63`（及 `src/platform/util/exec.js:36-55`）。
- 代码：`try { stillActive = service.isUnitActive(unit) === true; } catch { stillActive = true; }`
  但 `exec.run()` **失败/超时一律返回 null 而不抛**（exec.js:38-54），`systemd.isUnitActive` 内部又 `catch { return false; }`（service.js:59-63）。因此：
  1. 外层 `catch { stillActive = true; }` 是**不可达分支**（isUnitActive 从不抛）；
  2. `systemctl --user is-active` 因 dbus 挂起/超时（8s）返回 null 时，isUnitActive 返回 **false（=判定不活跃）**，与「确实 inactive」不可区分；
  3. 后果：`stillActive=false` → ops.js:77 `fs.rmSync(root, { recursive:true, force:true })` 删除沙箱数据目录，而单元可能仍在运行。
- 现有测试 `test/instance-safety-test.js:67-69` 只做正则存在性断言，**不覆盖查询失败这一失败模式**，故 CI 不会拦住。
- 建议：平台层区分「确定不活跃」与「未知」（返回 null / 抛 CapabilityError 或引入 runDetail）；ops 层把「查询失败」按活跃处理（默认拒绝删除）。

#### F2. stopInstance 忽略停止失败并强制置 STOPPED（假成功 + 状态不自洽）
- 位置：`src/domains/instance/lifecycle.js:95-100`；根因 `src/platform/os/service.js:53-57`。
- `lifecycle.stop` 不检查 `service.stopUnit` 返回值，直接 `inst.state.phase='STOPPED'; store.save();` 并返回 `{ok:true}`。
- 而 `systemd.stopUnit` 为 `try { run(...); return true; } catch { return false; }` —— `run` 不抛，故 **stopUnit 永远返回 true**，失败/超时不可观测（catch 也是死分支）。
- 后果：stop 失败时实例可能仍在监听，但内存/接口都报「已停止」；`supervise` 只在 `RUNNING` 相位处理「进程退出」，STOPPED 相位被 default 跳过 → 长期不自洽。
- API 侧 `src/api/domains/instances.js:171` 对 stop 恒 `send(200, ...)`（start 已在 164-170 修成按 ok 映射状态，stop 未同步）。
- 建议：stopUnit 用 `runDetail` 判定失败；stop 在有界复核（isUnitActive）后才置 STOPPED，否则如实报错。

### B. 业务逻辑 / 竞态与失败恢复（中）

#### F3. 安装任务登记失败会把「正在进行的安装」判死并永久卡 FAILED
- 位置：`src/domains/instance/ops/dsh-install.js:44-57, 98-99`；`src/domains/instance/lifecycle.js:129-149`。
- 若 `tasks.begin/start/step` 抛错，installSandbox `catch { task = null; }`（dsh-install.js:52）后**继续真实安装**；而 supervise 的 INSTALLING 分支在 `tasks` 存在但 `tasks.current(...)===null` 时直接 `stateMachine.fail(..., '安装中断（无进行中安装任务）')`（lifecycle.js:138）。
- npm 随后成功时，自愈条件只认 `/安装超时/`（dsh-install.js:98），不匹配「安装中断」→ 相位停在 FAILED（虽然 installOk=true），INSTALLING→RUNNING 的拉起永不发生。
- 建议：任务登记失败时中止安装（或标记可由 supervise 识别的态）；自愈条件放宽为「installOk===true 且 phase===FAILED」；supervise 在 `installAt` 未超时前不要仅凭 current()===null 判死。

#### F4. 升级失败路径 3 的回滚未先停「已启动的新版本单元」
- 位置：`src/domains/instance/upgrade.js:136-159, 160-179`；`src/domains/instance/lifecycle.js:49`。
- 路径 3（新版本已 start、`waitPortHealthy` 判失败）进入 `rollback`：先 npm 装回旧版，再 `lifecycle.start(id,{fromUpgrade:true})`（upgrade.js:152）。而 `_systemdStart` 开头 `if (probe(inst).running) return { ok:false, error:'端口 ... 已被占用' }`（lifecycle.js:49）。
- 若失败的新版本进程仍存活（单元非 active 但端口在听，或健康判定假阴性），回滚**无法重启**，报「回滚后重启也失败」；此时磁盘是旧版文件、内存却跑着新版进程，且无守卫自愈（guardian 只看单元）。
- 建议：rollback 先 `stopUnit` 并有界确认端口释放，再回装/重启。

#### F5. 插件市场后台刷新存在未处理的 Promise rejection（且单个坏包可炸整个索引）
- 位置：`src/domains/plugin/market.js:82-85`（`_refreshIfStale` 只 `.finally` 不 `.catch`）；`market.js:183-196`（npm 批次校验无逐条 try/catch）；`policies/market-entry.js:9-14`、`policies/classify.js:19-28`。
- `getIndex` 命中缓存时 fire-and-forget 调 `_refreshIfStale()`（market.js:74），其 `this._inFlight = this.buildIndex().finally(...)` 无消费者。`buildIndex` 可拒绝：`indexNpm` 的 `await Promise.all(slice.map(...))` 未按条容错，`npmEntry`/`classify` 假设 `description` 为字符串、`keywords` 为数组，一个畸形包即抛 → `_buildIndexInner` 拒绝 → **unhandledRejection**（本仓多处注释明确其会逃逸为进程级异常并触发守卫自重启策略）。
- 对比：社区源 `addCommunityLink` 单条 catch（market.js:37），github 源整段 try/catch（market.js:216-231），唯独 npm 批次缺保护。
- 建议：`_refreshIfStale` 补 `.catch(logger.warn)`；`indexNpm` 的 `Promise.all` 每条包一层 try/catch；`npmEntry/classify` 做类型防御。

#### F6. 实例端口变更后旧 `inst:*` 登记泄漏
- 位置：`src/domains/instance/store.js:75-90`。
- `syncPorts` 只做「缺则补、实例删除则按 owner 清」。若某实例端口被改（instances.json 用户编辑或未来 update 支持端口），旧端口的 `inst:<id>` 记录因「该 id 仍存在」而**永不释放**，长期占用注册表名额、阻塞动态池分配。
- 建议：按 owner 对账——`byOwner('inst:'+id)` 与 `inst.port` 不一致时先 unregister 再 register。

#### F12. API 对 stop/update/remove 恒回 200，未按结果映射状态
- 位置：`src/api/domains/instances.js:162-163, 171`。
- `stopInstance/updateInstance/removeInstance` 均有 `{ok:false}` 分支（实例不存在 / 平台不支持沙箱），但 API 原样 `send(200, ...)`；start 已在 164-170 修成按 ok 映射（注释明确「未验证不得报成功」不变量）。同文件内标准不一致。
- 建议：与 start 对齐，按 `r.ok` 映射 200/400。

### C. 资源 / 健壮性（中低）

#### F7. 死状态与死分支（`_latestDshVer` 已被并发 K 组删除）
- 仍存在：`src/domains/instance/upgrade.js:150,162` 的 `inst.state.version = readInstalledVersion(inst)` —— 赋值后**全仓无读取**（`viewRow` 版本来自 `readInstalledVersion`，非 state.version）。→ 死状态写入，可删。
- 已由 K 组本轮删除：`upgrade.js` 的 `_latestDshVer/_latestDshVerAt`（原 26-27 行）确认为死变量。
- 不可达分支：`src/platform/os/service.js:52`（Linux `daemonReload` 的 catch）与 ops.js:73 的 catch（`run` 从不抛），见 F1/F2。

#### F8. 插件更新检测对失败结果做 6h 负缓存
- 位置：`src/domains/plugin/updater.js:18-24`。
- `ctx.dist.fetchNpmLatest` 返回 null（registry 抖动）时仍写 `{ latest:null, at:now }`（updater.js:23），之后 6h 内命中缓存直接判「无更新」不再重试。instance 侧 `upgrade.checkUpdate`（upgrade.js:68-70）在 `!latest` 时会强制重查，二者不一致。
- 建议：null 结果不写缓存（或显著缩短 TTL）。

#### F9. 看护「陈旧相位」告警只发一次
- 位置：`src/domains/shell/watchdog.js:50-69, 168`。
- `updatePhaseTracking` 离开更新相位时复位 `expectedSince/phaseStale` 却**未复位 `phaseStaleWarned`**，故第二次陈旧只静默判定、不再告警。功能判定（phaseStale）仍正确，仅可观测性退化。

### D. 设计 / 一致性（低）

#### F10. 更新账本 pending 无时效上限，预期缺席可无限延长
- 位置：`src/domains/shell/watchdog.js:72-82`。
- `expectedAbsence()` 只要 `journal.to && !journal.confirmed` 即返回 true，没有与 `phaseMaxAgeMs` 对称的时限。永久 pending 的账本会让看护**始终**使用 `updateGraceMs`（5 分钟）而非 `graceMs`（90 秒），自愈被持续拖慢。
- 建议：给 journal pending 加时效（或结合 identity.version 判定目标版本不可达即视为陈旧）。

#### F13. 平台 Provider 写类命令全部吞掉失败、调用方 try/catch 为死代码
- 位置：`src/platform/os/service.js:52, 55, 83-92`。
- `daemonReload()/stopUnit()/startTransient()` 都以 `run(...)`（失败返回 null）后又 `return true`，或 `catch { return false }` 包裹不抛的 run。故：
  - `_systemdStart` 的 `try { service.startTransient(...) } catch { ...失败... }` **永远不会进入**；systemd-run 真实失败时仍置 STARTING、发 `inst_started`、调 `onInstanceStart`、API 回 `ok:true`，30s 后才由超时转 BACKOFF（假成功）。
  - `_prepareSystemd` 的 `reloaded === false` 在 Linux 上不可达。
- 建议：写类命令改用 `exec.runDetail` 并按 `ok` 返回，恢复调用方的失败分支语义。

#### F14. 重复实现（跨域）
- `src/domains/instance/model.js:13` `taskStateToView` 与 `src/domains/plugin/model.js:38` `taskStateToJobState` 是同一 TaskRegistry→视图映射的**两份实现**（succeeded/skipped→done，failed/canceled→failed，其余 running）。可抽公共纯函数；报告不改，避免影响两域门禁。

#### F15. 注释禁用符号残留（instance 域已被并发 K 组清理）
- 当前工作树仅剩 `src/domains/plugin/layers.js`、`src/domains/plugin/ops.js` 各 1 行，且均为**代码字符串中的 ⚠ 日志文案**（如 `jt.log.push('⚠ 残留提示：'...)`），按规则（代码字符串按需保留）可保留。
- instance 域本轮已被 K 组清理干净（审计初测为 53 行，现已归零）。

---

## 2. 注释前后统计（instance / plugin / shell 三域合计）

| 指标 | HEAD | 审计完成后工作树 |
|---|---|---|
| 总行数 | 3793 | 3482 |
| 注释行数 | 817 | 515 |
| 含禁用符号行数 | — | 2（均为 plugin 代码字符串，规则允许） |

`node --check` 对三域全部 `.js` 文件**全部通过**。

---

## 3. 验证与证据来源

- 静态检查：`node --check` × 全部三域文件（通过）；`grep -rn` 死名/死状态/调用点；`wc -l` 统计；`git diff` 核对并发改动为纯注释 + 死名删除。
- 关键证据：`instance/ops.js:72-77`、`instance/lifecycle.js:49/95-100/129-149`、`instance/upgrade.js:136-179`、`instance/ops/dsh-install.js:44-57/98-99`、`instance/store.js:75-90`、`plugin/market.js:74/82-85/183-196`、`plugin/updater.js:18-24`、`shell/watchdog.js:50-69/72-82`、`platform/os/service.js:52-63/83-92`、`platform/util/exec.js:36-63`、`api/domains/instances.js:162-171`。
- 未做：未运行任何测试、未启动 daemon、未 commit、未改 package.json、未加依赖。

## 4. 建议优先级

1. 高：F1（数据不可逆丢失防线）、F2（假成功/状态不自洽）——根因同为平台 Provider 吞失败（F13），建议一并修（需改 `platform/os/service.js`，不在 K 组「只改分到文件」范围，请指派）。
2. 中：F3、F4、F5、F6、F12。
3. 低：F7、F8、F9、F10、F14（F15 仅剩 2 行可保留的代码字符串）。
