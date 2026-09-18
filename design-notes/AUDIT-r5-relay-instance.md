# AUDIT-r5 relay + instance 域（独占范围）

范围：`src/domains/relay/**` + `src/domains/instance/**`（共 25 个 js 文件）。
本机仅执行只读与静态检查（node --check、grep、git diff/status）；未运行任何测试、未启动
daemon、未 commit/push、未改 package.json、未加依赖。验收由 CI 裁决。

## 一、改动清单

23 个文件被修改（全部在独占范围内）：

| 文件 | 改动类别 |
|---|---|
| relay/index.js | 注释精简、去框线/箭头/历史叙事 |
| relay/port-segments.js | 注释精简、去框线/箭头/乘号 |
| relay/ports.js | 注释精简、去警示符；删未用导出 registry |
| relay/contract.js | 注释精简、去框线/箭头/星号 |
| relay/tunnel.js | 注释精简、去历史叙事；删未用导出 buildRawRequest |
| relay/frp-install.js | 注释精简、去箭头；删未用导出 FRP_VERSION/MIRROR_PREFIXES/expectedSha256/extractFrpc |
| relay/core.js | 注释精简、去警示符/箭头/乘号；删未用导出 safeEqual |
| relay/proxy.js | 注释精简、去警示符/箭头/历史叙事 |
| relay/daemon.js | 注释大幅精简（56 行注释到 29 行）、去警示符/箭头/框线/日期叙事 |
| relay/frp.js | 注释精简、去警示符/箭头/框线 |
| relay/ops.js | 注释精简、去警示符/箭头；删死方法 _handleRelayListenFail |
| relay/ops/lan-servers.js | 注释去箭头；删未用导出 handleRelayListenFail |
| relay/ops/reconcile.js | 注释去箭头 |
| relay/session.js | 注释精简、去箭头 |
| instance/contract.js | 注释精简、去框线/圆点/箭头/警示符 |
| instance/index.js | 注释精简、去框线/箭头/警示符 |
| instance/lifecycle.js | 注释精简、去框线/箭头；删未用返回成员 _cleanStaleUnit/_systemdStart |
| instance/model.js | 注释精简、去框线/箭头 |
| instance/ops.js | 注释精简、去箭头/警示符（保留门禁断言的字符串） |
| instance/sandbox.js | 注释精简、去框线/箭头；删未用导出 sandboxCommand/defaultCommand |
| instance/state-machine.js | 注释精简、去框线/箭头 |
| instance/store.js | 注释精简、去框线/箭头/日期叙事 |
| instance/upgrade.js | 注释精简、去箭头/警示符；删死变量 _latestDshVer/_latestDshVerAt |

`git diff --stat`：23 files changed, 185 insertions(+), 280 deletions(-)。
非注释行的改动只有上表的删除项与内联尾注释（见下「等价性复核」）。

## 二、死代码删除依据（任务一）

先做全仓 grep（含 test/、app/、字符串形态，排除 node_modules/design-notes/CHANGELOG），
再逐个删除；不确定者只报告。

1. **孤儿文件**：无。25 个文件均在 require 图中可达（daemon.js 为入口、contract.js 为门禁读取，
   均按要求保留）。
2. **未用导出**（删前全仓零消费点）：
   - relay/ports.js `registry`：无 `portsvc.registry` / `ports.registry` / 解构引用。
   - relay/tunnel.js `buildRawRequest`：仅 tunnel.js 内部调用；test/ 无 `relay/tunnel` require。
   - relay/frp-install.js `FRP_VERSION`、`MIRROR_PREFIXES`、`expectedSha256`、`extractFrpc`：
     仅本文件内部使用；test/frp-platform-test.js 只 require `{ frpPlatformTag, downloadUrls }`。
     `MIRROR_PREFIXES` 常量保留（内部使用），仅去掉导出；test/round13-frpc-integrity-test.js:143
     断言的是某 URL 行「不含 MIRROR_PREFIXES 字样」，与导出无关。
   - relay/core.js `safeEqual`：仅 core.js 内部调用。
   - relay/ops/lan-servers.js `handleRelayListenFail`：仅本文件内部调用（line 34）。
   - instance/sandbox.js `sandboxCommand`、`defaultCommand`：仅 `effectiveCommand` 内部调用。
   - instance/lifecycle.js 返回对象成员 `_cleanStaleUnit`、`_systemdStart`：index.js 只使用
     `_prepareSystemd`；test/ 无 require 该返回对象。
3. **死成员**：relay/ops.js `LanManager._handleRelayListenFail`（全仓仅此一处定义、无调用；
   内部实际调用的是 lan-servers.js 的局部函数）。
4. **死变量**：instance/upgrade.js 顶部 `_latestDshVer` / `_latestDshVerAt`（同文件内只声明、
   从不读写；真正的 30s 缓存与这两行同名，位于 ops/dsh-install.js:12-13）。
5. **不可达/废弃死分支、重复实现**：未发现可安全删除的死分支。重复实现见第四节（只报告）。

删除后复核：`grep` 显示 `_handleRelayListenFail` 0 处；`_latestDshVer` 仅存在于
ops/dsh-install.js；`buildRawRequest`/`extractFrpc`/`expectedSha256` 仅作为本文件内部定义与调用。

## 三、注释精简与符号清理（任务二/三）

- 删除：复述代码的 WHAT、日期与版本叙事（如「P1（2026-09-13）」「2026-09 修复」「历史遗留」
  「原实现…」的过程记录）、逐行解释、框线分隔行、顶部大横幅收成 2-6 行。
- 保留：非显然的 WHY（如 loginFailExit=false 的自愈原因、回环呈现与令牌闸边界、
  SIGKILL 兜底窗口、单飞不加 async 的原因、删除前复核 isUnitActive、安全闸单一事实源）、
  契约不变量、跨平台差异（path.delimiter、Windows frpc.exe、fileProtect）、安全与并发约束。
- 符号清理：范围内注释已无 ⚠ / ★ / 制表框线（═ ─ │）/ 箭头（→ ← ⇒）/ 圆点（· ）/
  带圈数字 / emoji。恢复为纯文本（注意、则、到、后、与 等）。
  代码字符串按需保留 3 处（非注释，属日志/错误文案）：frp.js:174 与 ops.js:27 的日志箭头、
  frp-install.js:124 错误文案乘号。
- 为守门禁而刻意保留：instance/ops.js 内联注释「探测失败不阻断创建」
  （test/instance-safety-test.js:155 直接对该注释做源码级断言）。

注释前后统计（按纯注释行与字符计，基线为 git HEAD）：

- 注释行：531 -> 444（-16.4%）
- 注释字符：26228 -> 22076（-15.8%）
- 逐文件注释行变化（部分）：daemon.js 56->29、relay/index.js 9->3、contract.js 11->6、
  port-segments.js 10->6、instance/contract.js 30->22、state-machine.js 19->14、store.js 20->15；
  有 6 个文件行数不变（仅替换为等长文字或去掉符号），故行数未减而内容已精简。

## 四、等价性复核

`git diff` 非注释行仅包含：删除的未用导出/死成员/死变量，以及 4 处内联尾注释改写
（index.js ctx.install、lifecycle 四个 case 注释、ops.js 探测注释、sandbox/lifecycle 返回行）。
无逻辑改动。全部 25 个文件 `node --check` 通过。

## 五、四维审计发现（任务四）

### 架构设计
- A1（已改）：relay/ops.js 死成员 `_handleRelayListenFail` 与其导出，删除，公共面收窄。
- A2（已改）：instance/upgrade.js 死缓存变量，与 ops/dsh-install.js 真缓存构成同名影子，易误读。
- A3（报告）：relay/core.js 的 `hasValidToken`（WS 布尔判定）与 `tokenGateDecision`（HTTP 决策，
  含 302 种 Cookie）各自解析同一 cookie/query，属部分重复。合并会改变返回语义，未改。
- A4（报告）：instance/upgrade.js 的 `jobView` 与 `upgradeStatus` 重复「TaskRegistry current 优先、
  否则回退 _updJobs」的查找逻辑，可抽一处公共函数；为保等价未改。

### 业务逻辑
- B1（报告，可能缺陷）：instance/ops.js `updateInstance` 对 `patch.memoryMax/cpuQuota` 直接写
  `inst.sandbox.memoryMax`；若记录缺 `sandbox` 字段（历史/原生记录）会抛异常。建议
  `inst.sandbox = inst.sandbox || {}`。属行为变更，未擅自改。
- B2（报告）：instance/store.js `load()` 在 instances.json 解析失败时静默 `_replace([])`，无日志、
  无备份，损坏文件会被无声清空。建议至少记 logger.warn。
- B3（报告）：relay/daemon.js `reload()` 仅比较 `mtimeMs`，同一毫秒内的写入可能被漏读一轮
  （2s 后会补）。低概率。
- B4（报告）：relay/ops/lan-servers.js `startLanServer` 在 listen 成功前即写入 `_lanServers`
  （用于防重入）；若 `server.listen` 同步抛出，error 事件不会触发，残留条目无清理。低概率。

### 规范标准
- C1（报告）：instance/contract.js 的 `classApi` 未列 `sandboxSupported` getter 与 `instances`
  访问器（`PUBLIC_API` 已列）。门禁只校验 exports 双向一致与「消费 ⊆ PUBLIC_API」，故不影响
  门禁；属文档面不全。
- C2（已改）：relay/index.js 顶部残留历史入口叙事（manager.js/index.js 的来历）已删，与
  DOMAIN-STRUCTURE-DESIGN §10 现状一致。
- C3（已达标）：范围内注释不再含禁止符号；DG/DF/DS/TK 等门禁编号引用保留。

### 功能设计
- D1（已改）：删除未用导出不影响任何调用路径（删除前已确认零消费点）。
- D2（报告）：relay/frp.js `frpAction('toggle')` 在全局 settings.enabled=false 时仍直接
  `frp.start()`，可能拉起没有代理的 frpc；是否符合「手动 toggle 绕过开关」的意图待确认。
- D3（报告）：relay/core.js `validateFrpExposure` 端口占用校验用严格相等
  `x.frpRemotePort === port`；若 peers 中该字段为字符串（外部来源）会漏判。relay 侧 setFrp
  写入的是 number，故当前调用路径无碍。

## 六、未改但需后续确认（汇总）

B1、B2、B3、B4、A3、A4、C1、D2、D3 均只报告，未改代码，以免在无 CI 裁决的情况下引入行为变更。

## 七、门禁影响自查

- test/instance-safety-test.js 的 L-a/L-b/L-c/L-d/L-e/L-f/L-g/L-h 断言均为代码级，
  且已保留其所需字符串与调用形态（含注释串「探测失败不阻断创建」）。
- test/relay-source-gate-test.js 断言的 isTrustedSource、复用 shared/ip、
  `localIP = "127.0.0.1"` 均未改动。
- test/reconcile-single-flight-test.js、test/ports-capacity-test.js、
  test/round13-frpc-integrity-test.js 断言的代码行未改动。
- 本机未执行上述测试，最终由 CI 裁决。
