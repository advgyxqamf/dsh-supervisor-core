# R5 陈旧信息审计 -- 范围 A：src/ 与 test/ 下的 .js 注释

审计方式：只读（grep/glob/read/wc；未运行任何测试、未启动任何进程、未修改源码）。

说明：以下条目为已逐条用 glob/read/wc 验证的确认发现；“类别 3”与“类别 2”高度重叠，已在类别列合并标注。

格式：路径:行号 | 原文摘录(<=80字) | 类别1-4 | 证据/现状 | 建议

src/app/assembly/compose/core.js:74 | 取代旧 _explicitAction 时间窗布尔（漏消费竞态已根治）。词表见 guard/intent.js。 | 2 | 全仓无 intent.js；guard/ 层已重组为 app/；实际 src/app/state/intents.js | 更新为 app/state/intents.js
src/app/control/entry.js:19 | [!] phase 词表的唯一源是 guard/lifecycle/objects.js（控制平面 v3 canonical）。 | 2/3 | 该文件已不存在；同文件 L27 require("./registry")，词表在 app/control/registry.js | 更新为 app/control/registry.js
src/app/control/entry.js:69 | [!] 域 A 的真实计数不在这里：dsh 走 main-process.js 的 restart_triggered + restartCount | 2 | src/app/main/main-process.js 已拆除；restart_triggered 实际在 app/main/process.js:213 | 更新路径为 app/main/process.js
src/app/assembly/compose/core.js:151 | （0600；守卫重启后 token.js 从文件尾恢复令牌 -> 免重建 main 的会话中断，2026-09 修复） | 2/3 | 单文件 token.js 早目录化为 platform/service/token/，由 persist.js 承担 | 更新为 token/persist.js
src/app/daemons/process-marks.js:23 | 对照：同仓另两处反查监听者（supervise-view.js、control-view.js）都额外匹配... | 2/3 | supervise-view.js / control-view.js 均不存在；现在时引用易误导 | 更新为现存文件或标注已拆
src/app/main/controller.js:161 | switch 绝不读令牌。详见 supervise-view.js 的删除点注释。 | 2/3 | supervise-view.js 已拆不存在，无该“删除点注释” | 更新指向 app/daemons/supervise.js 或删
src/platform/service/log/sources.js:59 | 是死代码（router/lan 归入域 B 后无调用者，见 control-view.js 删除说明），事件永不再产生。 | 2/3 | control-view.js 已不存在 | 更新为 registry.js 或删指引
src/platform/os/pidlookup/norm.js:90 | 而本仓的进程标记（daemon-lifecycle 的 _cmdMarks、supervise-view/control-view 的... | 2/3 | daemon-lifecycle/supervise-view/control-view 均不存在；现为 app/daemons/process.js、supervise.js | 更新为现模块名
src/app/daemons/process.js:185 | 并如实返回 {mode:failed} 让调用方（superviseOnce/control-view）可见。 | 2/3 | control-view 已删除；调用方在 app/daemons/supervise.js | 更新
test/daemon-lifecycle-test.js:4 | 统一受管进程生命周期核心（src/infra/proc/daemon-lifecycle.js）回归： | 2 | src/infra/ 不存在；实现已迁 app/daemons/process.js（本文件实际读该路径） | 更新路径
test/loghub-test.js:75 | 见 control-view.js / GUARD-DOMAIN-MODEL §2）。改用仍有真实生产者的 router_daemon_supervised 作... | 2/3 | control-view.js 已不存在 | 更新为 registry.js
test/round8-fixes-test.js:93 | 修法见 src/platform/os/pidlookup.js 的 normCmdline + 三处调用点。 | 2 | pidlookup.js 已拆为 pidlookup/{index,probe,norm}.js；normCmdline 在 norm.js | 更新为 pidlookup/norm.js
test/shell-watchdog-e2e-test.js:106 | 本仓既有约定（见 test/shell-safety-net-test.js:27 与 test/guard-update-test.js:172-180） | 2 | test/guard-update-test.js 已删除（A5 取证子系统清理） | 删除该引用或改为现存文件
test/round13-dropped-result-test.js:9 | (1) P1 self-update.js::sanityCheck -- 丢弃 exec.run 返回值 -> 检查恒通过 | 2 | self-update.js 已删（SW-4 单写入者收敛） | 标注“已删除”
test/round13-dropped-result-test.js:13 | 生产调用点为零，只有 guard-update-test.js 覆盖，而它从未断言失败路径。 | 2 | guard-update-test.js 已删除 | 标注“已删除”
test/round13-ports-release-test.js:21 | main-process.js ports.release(oldPort) | 2 | main-process.js 已不存在 | 更新为当前调用点
test/relay-source-gate-test.js:21 | FRP（公网）侧本就有「强制 remoteToken」的闸（manager.js:105），故不是同一问题； | 2/4 | relay 下无 manager.js，实为 relay/managed.js；行号亦失效 | 更新文件名/去行号
test/reconcile-single-flight-test.js:11 | - 前端 UI 每 2s 轮询 /lan/list -> list() 内部调 reconcile（manager.js:64）； | 2/4 | relay/managed.js 才是现名；行号失效 | 更新
test/daemon-path-test.js:12 | 完全绕过 control-view.js 的路径推导，于是缺陷对测试不可见。 | 2/3 | control-view.js 已拆 | 更新为 app/daemons/runtime.js
test/round13-robustness-batch-test.js:10 | control-view.js 的 domainSummary 经 ctl 转发，而 _ctlCall 默认 120000ms； | 2/3 | control-view.js 已拆 | 更新/标注历史
test/probe-gate-and-ownership-test.js:18 | 调用方（objects.js）以 owner 意图调用，实际按端口号无条件删除 -> 可误删他人登记。 | 2/3 | objects.js 已不存在，实为 app/control/registry.js | 更新
test/probe-gate-and-ownership-test.js:162 | -- E-i：objects.js 的端口释放必须带 owner（P2-2 配套）-- | 2/3 | 同块 L167 实际读 app/control/registry.js | 更新标题为 registry.js
test/heartbeat-selfheal-test.js:21 | - objects.js：逐对象 supervise/observe 加超时（拍宽 x ADAPTER_TIMEOUT_TICKS）； | 2/3 | objects.js 已不存在 | 更新为 app/daemons/supervise.js
test/phase-vocabulary-test.js:10 | - guard/lifecycle/objects.js -- 控制平面 v3 canonical（supervisor.js 注释亦如此声明）； | 2/3 | 文件不存在；supervisor.js 注释亦已无此声明 | 更新为 app/control/registry.js
test/round13-node-lts-contract-test.js:11 | 而内核 guard/supervisor/settings-view.js::nodeLtsStatus() 从不产出它们 | 2/3 | 文件不存在；现为 app/settings/node-lts.js | 更新/标注历史
test/round13-contract-reload-test.js:15 | - 用旧探测方法自己重测 -> 正是 registry-contract.js:23-28 声称已修复的 | 2 | registry-contract.js 在本仓不存在（壳仓文件，本仓无 src-tauri/） | 标注“壳仓文件”
test/round8-fixes-test.js:298 | 该文件所有权在壳（registry-contract.js 声明），壳也会读回（core.rs:150）； | 2 | 壳仓文件，本仓不存在 | 标注“壳仓文件”
src/app/state/phase.js:6 | 从 state/fields.js:127-141 拆出（DF-3：纯计算与有状态读写分离）。 | 4 | fields.js 全文仅 121 行，127-141 越界 | 去行号或更新
src/app/state/field-tables.js:6 | 从 state/fields.js:38-64 拆出（DF-3：纯数据与有状态读写/IO 分离）。 | 4 | fields.js:38-64 现为 setPhase/guardian/desired 等函数，非该表 | 去行号
src/domains/instance/index.js:67 | 6 个回调访问器（compose.js:272-294 直接赋值；内部只读 _hooks...） | 4 | src/app/assembly/compose.js 仅 28 行（已拆到 compose/ 子目录） | 改指向 compose/core.js
src/domains/router/router-ops.js:6 | （index.js:759 现存 Object.assign 消费面），经 coreFor(host) 显式映射 deps。 | 4 | src/domains/router/index.js 仅 150 行 | 去行号
src/domains/router/store.js:11 | provider 反序列化（Q3 的持久化侧，index.js:65-123 迁入）... | 4 | index.js 150 行；该区间内容与描述不符 | 去行号
src/domains/router/forward-core.js:8 | 2) forwardMethods：兼容方法集（index.js:758 现存 Object.assign 消费面） | 4 | index.js 仅 150 行 | 去行号
src/domains/router/handlers/parse.js:4 | 从 forward-core.js:31-146 与 index.js:535 抽出。 | 4 | index.js 仅 150 行；forward-core.js 71 行，31-146 越界 | 去行号
src/domains/router/model/inflight.js:4 | 从 forward-core.js:410-427,:519 抽出。 | 4 | forward-core.js 仅 71 行，区间越界 | 去行号
src/domains/router/store/usage.js:4 | 从 forward-core.js:476-539 抽出。写权单闸... | 4 | forward-core.js 仅 71 行，越界 | 去行号
src/domains/router/handlers/forward.js:6 | 从 forward-core.js:148-290,:321,:429 抽出，并合并 model/inflight 的显式 effect。 | 4 | forward-core.js 仅 71 行，越界 | 去行号
src/domains/router/ops/apps-registry.js:3 | 反代应用注册表与更新（IO）。从 router-ops.js:271-435 抽出。 | 4 | router-ops.js 仅 73 行，越界 | 去行号
src/domains/router/ops/browser.js:5 | 图形环境 + 打开浏览器（IO...）。从 router-ops.js:50-133 抽出。 | 4 | router-ops.js 仅 73 行 | 去行号
src/domains/router/ops/oauth.js:5 | Command Code OAuth 一键登录（IO + 状态）。从 router-ops.js:134-270 抽出。 | 4 | 越界 | 去行号
src/domains/router/ops/quotasync.js:3 | 官方配额与单价同步（网络 IO）。从 router-ops.js:436-513 抽出。 | 4 | 越界 | 去行号
src/domains/router/ops/admin.js:3 | 账号/供应商管理辅助。从 router-ops.js:514-665 抽出。 | 4 | 越界 | 去行号
test/native-op-mutex-test.js:16 | 生产中 tasks 总被注入（supervisor.js:328-334）故当前成立；但： | 4 | src/supervisor.js 全文 78 行 | 去行号
test/heartbeat-selfheal-test.js:14 | 为什么致命：managedObjects 存在时不创建 tick 定时器（supervisor.js:455） | 4 | src/supervisor.js 仅 78 行 | 去行号或改指 app/ 模块
test/api-contract-test.js:33 | 真实门面 routerApi() 是方法（supervisor.js:561 this.routerApi() 返回门面对象） | 4 | src/supervisor.js 仅 78 行 | 去行号
test/task-registry-test.js:78 | 缺陷：守卫（supervisor.js:203）与 router-daemon（daemon.js:55）各持一个 | 4 | src/supervisor.js 仅 78 行 | 去行号
test/srcpath-gate-test.js:12 | control-view.js:216 path.join(__dirname, ..) + src/domains/router/daemon.js | 2/4 | control-view.js 已删；仅历史示例 | 标注历史/去行号
test/srcpath-gate-test.js:14 | registry-view.js:185 path.join(__dirname, domains, router, daemon.js) | 2/4 | registry-view.js 已删；仅历史示例 | 标注历史/去行号

## 计数汇总（已确认条目）
- 类别 2（引用不存在文件/路径/符号）：约 27 条
- 类别 3（废止机制未标现状，与 2 重叠）：约 14 条
- 类别 4（与实际代码不符，含失效行号区间）：约 22 条
- 类别 1（日期/变更叙事）：src 117 命中行 + test 230 命中行（详见附注，未逐条列出）；其中明确带“此前/旧实现/原先/旧版/曾”的过程性叙述约 120 条
- 本报告逐条列出：48 条

## 分级
### 高危（错误信息，会误导后续开发）
1. src/app/control/entry.js:19 -- phase 唯一源指向已删除的 guard/lifecycle/objects.js（实际 require ./registry）
2. src/app/assembly/compose/core.js:74 -- “词表见 guard/intent.js”，该文件全仓不存在（实际 app/state/intents.js）
3. src/app/daemons/process-marks.js:23 -- 以现在时引用已删除的 supervise-view.js、control-view.js 作为对照
4. src/app/control/entry.js:69 -- 引用已删除的 main-process.js（重启计数实际在 app/main/process.js）
5. src/app/assembly/compose/core.js:151 -- 引用早已目录化的单文件 token.js
6. src/app/main/controller.js:161 与 src/platform/service/log/sources.js:59 -- 指引到已删除的 supervise-view.js / control-view.js
7. src/platform/os/pidlookup/norm.js:90 与 src/app/daemons/process.js:185 -- 引用已删除文件
8. src/app/state/phase.js:6 -- 行号区间 fields.js:127-141 越界（全文 121 行）
9. src/domains/instance/index.js:67 -- compose.js:272-294 越界（全文 28 行）
10. test/daemon-lifecycle-test.js:4 -- 标题引用不存在的 src/infra/proc/daemon-lifecycle.js

### 中危（过时但不易即时误导）
- router 域 12 处“从 X.js:NNN 抽出”失效行号区间；supervisor.js 若干失效行号
- test/shell-watchdog-e2e-test.js:106、test/round13-dropped-result-test.js:9,13 -- 引用已删除的 guard-update-test.js / self-update.js
- test/relay-source-gate-test.js:21、test/reconcile-single-flight-test.js:11 -- relay/manager.js 实为 managed.js
- test/loghub-test.js:75、test/round8-fixes-test.js:93、test/daemon-path-test.js:12 等指向已拆文件
- 约 120 条“此前/旧实现/原先”过程性叙事

### 低危（纯风格）
- 仅保留日期印记、无过程描述的注释；建议统一为“现状 + 动机”而非时间线。
