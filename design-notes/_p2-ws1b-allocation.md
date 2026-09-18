# WS1-b 分片分配表（`src/domains/**` 注释精简 + 死代码普查）

> 由 WS1-b 负责人生成，供三个下级子代理读取。本文件是工作指令，不是规范。
> 上级作业单：`design-notes/_workorder-phase2.md`（**必读全文**）。

## 共同约束（与作业单 §0/§1/§2/§5 同源，违反即整批作废）

1. 严禁在本机运行任何测试/门禁；只允许 `node --check`、`grep`、`read`、`wc`、`git status/diff/log`（只读）。
2. 严禁任何 git 写操作（`add/commit/push/stash/checkout/restore`）；改动留在工作区，主控统一提交。
3. 严禁改 `test/` 下任何文件。严禁启动守卫/daemon；不碰 `/tmp/dsh-*`、状态根。
4. **R1（形式钉子）**：改写/删除任何注释前，先 `grep` 在 `test/` 搜该注释里的特征串（中文短语、标识符、特殊符号）。
   若被任何测试匹配，**该注释行原样保留**，并在报告中记为「形式钉子，未动」。
5. **R2（死代码）**：删除任何导出/函数/常量前，在**全仓** grep 该符号（`src test bin release ui *.md design-notes .github app`，排除 `node_modules`、`.git`）。
   `test/` 或 `bin/` 有消费者就**不得删除**；宁可保留。
6. §2 口径：删复述代码的 WHAT、日期与变更史、「本轮/之前/原来/曾」过程记录、逐行解释、与代码重复的 JSDoc 参数表；
   保留非显然的 WHY、契约不变量、陷阱与事故教训、跨平台差异、对外 API 契约、安全语义。优先整段删除，不做同义改写，不确定就保留。
   **代码零变化**：绝不改动任何非注释字符；不写回 emoji/框线/箭头/带圈数字。不做结构重构、不改文件名、不移动代码。
7. 报告**不得**出现操作者绝对路径（`/home/<name>`、`C:\Users\<name>`）；只用相对路径或 `/home/user` 一类占位。
8. 只写自己那一个报告文件；不要碰他人的报告。

## WS2 独占文件（WS1-b 全体**不得触碰**，它们归 WS2）

```
src/domains/relay/session.js
src/domains/relay/frp-install.js
src/domains/router/providers/probe.js
src/domains/router/providers/quota-strategies.js
src/domains/router/handlers/forward.js
```

## 分片 A —— WS1-b-1：router 内部实现（providers/handlers/policies/instances/model/store/ops）+ shell 全域

文件数 29。报告：`design-notes/_p2-ws1b-domains-router-a.md`

```
src/domains/router/handlers/parse.js
src/domains/router/instances/proxy-instance.js
src/domains/router/model/inflight.js
src/domains/router/ops/admin.js
src/domains/router/ops/apps-registry.js
src/domains/router/ops/browser.js
src/domains/router/ops/oauth.js
src/domains/router/ops/quotasync.js
src/domains/router/policies/failure.js
src/domains/router/policies/switch.js
src/domains/router/providers/base.js
src/domains/router/providers/command.js
src/domains/router/providers/direct.js
src/domains/router/providers/instance-lifecycle.js
src/domains/router/providers/model.js
src/domains/router/providers/pkg-cache.js
src/domains/router/providers/policies/freeze.js
src/domains/router/providers/policies/quota.js
src/domains/router/providers/pool.js
src/domains/router/providers/proxy.js
src/domains/router/providers/restart.js
src/domains/router/providers/store.js
src/domains/router/store/usage.js
src/domains/shell/contract.js
src/domains/shell/core.js
src/domains/shell/index.js
src/domains/shell/journal.js
src/domains/shell/restart.js
src/domains/shell/watchdog.js
```

## 分片 B —— WS1-b-2：router 顶层编排 + relay 全域（不含 WS2 的 session.js/frp-install.js）

文件数 29。报告：`design-notes/_p2-ws1b-domains-router-b.md`

```
src/domains/relay/contract.js
src/domains/relay/core.js
src/domains/relay/daemon.js
src/domains/relay/frp.js
src/domains/relay/index.js
src/domains/relay/managed.js
src/domains/relay/ops.js
src/domains/relay/ops/lan-servers.js
src/domains/relay/ops/reconcile.js
src/domains/relay/port-segments.js
src/domains/relay/ports.js
src/domains/relay/proxy.js
src/domains/relay/tunnel.js
src/domains/router/config.js
src/domains/router/contract.js
src/domains/router/daemon.js
src/domains/router/endpoint.js
src/domains/router/forward-core.js
src/domains/router/index.js
src/domains/router/model.js
src/domains/router/ops.js
src/domains/router/port-segments.js
src/domains/router/ports-bootstrap.js
src/domains/router/proxy-apps.js
src/domains/router/router-ops.js
src/domains/router/scheduler.js
src/domains/router/store.js
src/domains/router/switch.js
src/domains/router/views.js
```

## 分片 C —— WS1-b-3：plugin 全域 + instance 全域

文件数 28。报告：`design-notes/_p2-ws1b-domains-plugin-instance.md`

```
src/domains/instance/contract.js
src/domains/instance/index.js
src/domains/instance/lifecycle.js
src/domains/instance/model.js
src/domains/instance/ops.js
src/domains/instance/ops/dsh-install.js
src/domains/instance/sandbox.js
src/domains/instance/state-machine.js
src/domains/instance/store.js
src/domains/instance/upgrade.js
src/domains/plugin/cli.js
src/domains/plugin/contract.js
src/domains/plugin/index.js
src/domains/plugin/jobs.js
src/domains/plugin/layers.js
src/domains/plugin/market-net.js
src/domains/plugin/market-sources.js
src/domains/plugin/market.js
src/domains/plugin/model.js
src/domains/plugin/ops.js
src/domains/plugin/policies.js
src/domains/plugin/policies/classify.js
src/domains/plugin/policies/market-entry.js
src/domains/plugin/restart.js
src/domains/plugin/store.js
src/domains/plugin/store/market-cache.js
src/domains/plugin/targets.js
src/domains/plugin/updater.js
```

## 覆盖自检

WS1-b 拥有 86 个文件（`src/domains/**` 共 91 个，扣除 WS2 的 5 个 = 86）。
三个分片互斥且无遗漏（A/B/C 两两无交集，并集 = 86）。
