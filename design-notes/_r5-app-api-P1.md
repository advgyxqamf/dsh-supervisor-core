## P1 src/api/**（19 个 .js，含 domains/ 与 transport/）

第五轮（死代码清理 / 注释精简 / 注释符号清理 / 四维审计）。约束遵守：未运行任何测试或门禁脚本（未执行 npm test、node test/*.js、任何夹具），只做 node --check、grep、wc、git 只读检查；未 commit/push；未改 package.json；未加依赖；未启动守卫/daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh。改动仅限本分区 19 个文件，git status 已确认无分区外文件被本代理修改。

### 改动清单

| 文件 | 性质 |
| --- | --- |
| src/api/contract.js | 注释精简（头注/分隔线/日期叙事）+ 符号清理 |
| src/api/deps.js | 注释精简（R9 语义保留）+ 符号清理 |
| src/api/identity.js | 注释精简（移除条件保留）+ 符号清理 |
| src/api/index.js | 注释精简 + 符号清理（保留 tauri:// 门禁串） |
| src/api/router-table.js | 注释精简 |
| src/api/security.js | 注释精简 + 删除导出 safeKeyEqual |
| src/api/static.js | 注释精简 + 删除导出 UI_DIR/resolveUiDir |
| src/api/domains/dist.js | 注释精简 + 符号清理 |
| src/api/domains/guard.js | 注释精简 + 符号清理 |
| src/api/domains/instances.js | 注释精简 + 符号清理 + 审计修正（注释与代码不符） |
| src/api/domains/lifecycle.js | 注释精简 + 符号清理 |
| src/api/domains/native.js | 注释精简 + 符号清理 |
| src/api/domains/plugins.js | 符号清理（箭头改纯文本） |
| src/api/domains/relay.js | 符号清理 |
| src/api/domains/router.js | 注释精简（去掉过程/历史叙事）+ 符号清理 |
| src/api/domains/shell.js | 注释精简 + 符号清理 |
| src/api/domains/tasks.js | 注释精简 + 符号清理 |
| src/api/transport/body.js | 注释精简 |
| src/api/transport/server.js | 注释精简 + 符号清理 |

### 死代码与删除依据

对每个 module.exports 符号做全仓 grep（含 test/、design-notes/、README/CHANGELOG、bin/、release/、字符串形态），结论：

删除导出（函数/常量本体仍被内部使用，仅去掉导出项）：
- security.js `safeKeyEqual` -> 全仓仅 security.js（定义 + requestHasAccessKey 内 2 处调用 + 导出），无 test/文档引用 -> 去掉导出，函数体保留。
- static.js `UI_DIR` -> 全仓仅 static.js（定义、serveStatic 使用、导出），无 test/文档 -> 去掉导出，const 保留。
- static.js `resolveUiDir` -> 全仓仅 static.js（定义、第 39 行调用、导出）-> 去掉导出，函数保留。

保留（有文档/门禁/测试面，易误判为死代码）：
- security.js `isLocalOrLanHost`：仅文件内调用，但 DIRECTORY-STRUCTURE-DESIGN.md:130 明列 security.js 导出面（originAllowed/isLocalOrLanHost/isShellOrigin/isLoopbackHost）-> 保留。
- static.js `MIME`：DIRECTORY-STRUCTURE-DESIGN.md:131 明列 -> 保留。
- identity.js `normalizeRemoteAddress`：re-export shim，DIRECTORY-STRUCTURE-DESIGN.md:77 视为 shared/ip 迁出来源；虽无消费者，属兼容门面 -> 保留并登记。
- instances.js `handleOpen` / `issueOpenWebCode` / `consumeOpenWebCode`：全仓 grep 零外部引用（含 test/），唯一支撑是 instances.js:198 的注释「供测试直接做行为断言」。按「测试不确定即保留」保留，登记为注释与代码不符（见四维发现）。
- deps.js `GATEWAY` / `DOMAIN_DEPS`：无任何运行期 require（只声明不强制），design-notes/_RULING.md R9 明示保持 -> 禁止删除，仅登记为死引用。
- contract.js：被 test/api-surface-test.js、test/kernel-update-single-writer-test.js 以 fs 读取，属门禁契约；路由表项与 note 文案一律未动。
- index.js 导出面（createServer/originAllowed/isLoopbackHost/isShellOrigin）逐字保持（defects-batch-f K6、lan-access-boundary 行为断言依赖）。
- `originAllowed/isShellOrigin/isLoopbackHost/requestHasAccessKey/identify/isPrivateIpv4/isLoopbackAddress` 均有生产或测试消费者，未动。

孤儿文件：本分区 19 个 .js 全部有 require 或门禁 fs 读取引用，无孤儿。

等价性（静态）：git diff 显示非注释改动仅 2 行 module.exports（safeKeyEqual、UI_DIR/resolveUiDir）+ 2 处行尾注释（deps.js:78 的 ④、static.js 的 ①）。其余全部落在注释；逐文件 node --check 通过。

### 注释统计

注释行 = 以 //、/*、* 开头的行（读工具 totalLines；改前取自 wc -l）。

| 文件 | 行数 改前/改后 | 注释 改前/改后 |
| --- | --- | --- |
| contract.js | 163 / 147 | 48 / 32 |
| deps.js | 120 / 110 | 47 / 37 |
| identity.js | 37 / 22 | 25 / 10 |
| index.js | 27 / 24 | 19 / 16 |
| router-table.js | 26 / 21 | 9 / 4 |
| security.js | 143 / 117 | 76 / 50 |
| static.js | 95 / 92 | 19 / 16 |
| domains/dist.js | 55 / 51 | 14 / 10 |
| domains/guard.js | 189 / 188 | 18 / 17 |
| domains/instances.js | 207 / 200 | 63 / 56 |
| domains/lifecycle.js | 156 / 156 | 33 / 33 |
| domains/native.js | 77 / 77 | 7 / 7 |
| domains/plugins.js | 66 / 66 | 7 / 7 |
| domains/relay.js | 40 / 40 | 3 / 3 |
| domains/router.js | 162 / 162 | 15 / 15 |
| domains/shell.js | 83 / 83 | 15 / 15 |
| domains/tasks.js | 43 / 43 | 6 / 6 |
| transport/body.js | 33 / 28 | 7 / 2 |
| transport/server.js | 168 / 161 | 51 / 44 |
| 合计 | 1890 / 1788 | 482 / 380 |

lifecycle/native/plugins/relay/router/shell/tasks 注释行数未降但内容已改（多为「箭头/分隔线改纯文本」的行内等价替换）。保留的是非显然 WHY、契约不变量（INV-S2/S4、R9 只声明、TK-G6、信任集合、身份层/CSRF/密钥三层）、陷阱（ctx 无 url 键、路径穿越、413 终态、DNS-rebinding）与跨平台/候选路径；删除的是 WHAT 复述、日期与步骤叙事（步骤 9、P1-E、P3 断点、2026-09-xx 等，仅在无损语义时保留必要背景）。

### 注释符号清理

已清除注释中的禁用字符（警示/箭头/带圈数字/中点/框线，如 ！三角形、圈号等一律转纯文本）。全分区复查仅余 3 处，均在代码字符串（非注释）中，按约定保留：
- src/api/domains/guard.js:24 -> 字符串 `「概览 · 版本与升级」`；且 test/cross-platform-test.js A4-d 断言 guard.js 含该串，必须保留。
- src/api/contract.js:59 -> consumers 字符串 `UI(open-web → 本机系统浏览器一次性码跳转)`。
- src/api/contract.js:133 -> note 字符串 `（壳更新强制，无回退）；⚠ health/update-pending ...`。

### 四维发现

架构设计（无确认缺陷）：
- 依赖方向正确：domains/* 只经 ctx/sup 注入，不 require 其它域；transport/server 单向依赖 router-table/static/identity/security/body；各域只导出 {owns, handle}。未发现越层 require 边。
- api/deps.js 声明面与各域实际 sup.* 读取抽查一致（relay/guard/shell/router/instances/lifecycle/native/plugins/dist/tasks）。R9「只声明不强制」保持，未接线运行期校验。
- 无孤儿文件；无第二份 isPrivateIpv4/身份判定实现。

业务逻辑：
- 确认并已改（注释与代码不符）：instances.js 原注释称 start 的 ok 映射「与同文件 stop 一致」，但 stop（及 remove/update）实际恒 send(200, ...)。已把该句改为「start 应如实映射 HTTP 状态」。行为未改。
- 不确定待裁决：stop/remove/update 若域实现返回 {ok:false}，HTTP 仍为 200，与 start 的 400 不对称（潜在违反「未验证不得报成功」）。需 instances 域实现确认 stopInstance 是否恒 ok，未改。
- 不确定待裁决：plugins.js 用 `req.url.indexOf('refresh=1')` 判强制刷新，`?norefresh=1` 会被误判。UI 实发 `?refresh=1`，未改。

规范标准：
- 注释禁用符号已清（残留仅上述 3 处代码字符串）。
- 跨分区重复实现（未改，登记）：src/api/security.js `safeKeyEqual` 与 src/domains/relay/core.js 的 timing-safe 比较近乎相同（前者 `String(a || '')`，后者 `String(a)`）。建议后续统一到 shared/；属 relay 分区，未动。
- 未用导出登记（保留）：security.js `isLocalOrLanHost`、static.js `MIME`、identity.js `normalizeRemoteAddress`、instances.js 三个 open-web 辅助导出。

功能设计：
- 未发现可确认的功能缺陷。事件读路径 `/events` 的 readVisible 过滤、日志 413 终态、静态 503/403/404 分支均自洽。
- 观察（未改）：lifecycle.js `/logs/export` 直接调用 `sup.eventHub.exportLines(...)`，无空值守卫，而 `/logs/tail`、`/metrics` 有守卫；注释称 eventHub 经 EventReader 适配后永不为 null，故未加守卫（避免行为变更）。

### 门禁静态核对（未运行，仅比对其断言）

以只读方式重放以下判据，全部通过：
- round13-dropped-result：router.js 无「.then( 后无 .catch」链（0 处），无 send(...).catch 错误形态。
- session-lifecycle：lifecycle.js 无 hub/fallback 双分支，仍含 hub.readVisible 与 `const hub = sup.eventHub`。
- kernel-update-single-writer：guard.js 的 410 两写端点、KERNEL_UPDATE_SINGLE_WRITER、只读 status；contract.js 两条 deprecated 正则（同类行未换行）。
- lan-access-boundary E-g：security.js 仍为 `const { isPrivateIpv4 } = require('./identity')`，且 api/ 无第二份 isPrivateIpv4 定义。
- instance-safety：instances.js 仍 `Promise.resolve(sup.instances.addInstance(j))`，无同步读取。
- defects-batch-f K6：api/index.js 仍含 `tauri:`（注释中，gate 断言源码）。故该注释串按门禁保留。
- shell-safety R10：contract.js 去注释后无 /shell/rollback。
- api-surface 双向一致：源码路由集合与 contract.js 登记完全一致（无未登记、无幽灵）。
