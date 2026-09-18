# P6-B 分片分配与不变量（app 工厂化 + domain-actions 去 this）

> 主控（P6-B 负责人）生成。纪律沿用 `_workorder-phase6.md` §0 与 `_workorder-phase4.md` §0/§1。

## 0. 实测事实（改前必读，决定每片怎么做）

**装配现状**（`src/app/assembly/facets.js`）：
- `installMethods(host, mod.methods)` 把 `methods` 逐个**平铺**到 host 实例，调用时 `this` = host。
- `installFacets` 遍历 FACETS 清单；每片形如 `{ name: '<slice>/<mod>', mod: require(...) }`。
- `src/app/assembly/collaborators.js` 另行安装真工厂：`host.state = createStateStore(...)`、
  `host.control = createControlPlane(...)`、`host.ctl = createCtl(...)`（**覆盖 THIN_SPEC 的 ctl 转发器**）、
  `host.audit = createOrphanScan(...)`（覆盖 audit 转发器）。
- `THIN_SPEC` 的键 = **ctl | daemons | main | views | audit | ui** ⇒ `host.daemons`/`host.main` 是**转发器命名空间**；
  **无 facade 键 ⇒ `host.facade` 不存在**（facade 的 5 个模块是平铺安装的）。

**`this.X(` 基线**（`test/app-this-ratchet-gate-test.js` AT-1，按目录）：
facade 13（main.js 5 / router.js 7 / ports.js 1 / lan.js 0 / status.js 0）、
daemons 43（process.js 29 / runtime.js 8 / identity.js 6 / supervise.js 0 / probe.js 0 / process-marks.js 0 / process-wait.js 0 / scripts.js 0）、
main 141（process.js 68 / controller.js 28 / decide.js 25 / health-gate.js 12 / shadow.js 5 / signals.js 3 / port-rederive.js 0）、
control 54 / settings 8 / native 3 / ctl 0 / self 1 / assembly 0。
**工厂化后真实下降 → 报告下降后数值（主控决定是否下调基线）；严禁为消红上调。**

## 1. 不变量（必须写进代码注释与报告）

**保留 host 上既有 `{methods}` 安装** —— 只把 `host.<slice>` 从转发器换成真工厂对象；对外面与
`this.X()` 语义不变、可唯一回退。**行为零变更**：路由/状态码/事件名/日志文案一律不动。

## 2. 三片各自的正确做法（因装配形态不同而不同）

| 片 | 片内文件 | 做法 |
|---|---|---|
| **B-1** | `src/app/facade/**`(5) + `src/app/daemons/**`(8) | **facade**：无 `host.facade` 转发器 ⇒ 为 5 个模块各建 `createXxx(deps)` 工厂，**公开键 = facets.js 当前实际安装到 host 的那组名字**（用 grep/read 静态提取自证逐字相等），实现体不再用 `this.*`（改吃注入的惰性 deps）。**daemons**：有 `host.daemons` 转发器 ⇒ 按 ctl/audit 既有范式，`host.daemons = createDaemons({...})` 覆盖它，deps 用惰性 getter。 |
| **B-2** | `src/app/main/**`(7) | 有 `host.main` 转发器 ⇒ 同 daemons 范式。**按文件逐个转换**，本片内部再切给下级（每文件一个执行者）。**某文件被测试按源码形态钉住且无法在不触碰前提下转换 ⇒ 停止该文件并报告**，其余继续。 |
| **B-3** | `src/app/domain-actions/**`(3) + `test/round13-router-relay-gaps-test.js` + `test/probe-gate-and-ownership-test.js` | 原地去 this（§4 二选一，**不许半改**）。 |
| **主控(P6-B)** | `src/app/assembly/**` | 统一做 facets.js / collaborators.js 的注册与安装接线（**独占**，避免多写者冲突）。各片把需要的**注册片段**报给主控，不要自己改 assembly。 |

## 3. 两条源码形态钉子（B-3 的硬约束，实测上下文）

1. `test/round13-router-relay-gaps-test.js:64`：
   `const act = strip(read('src/app/domain-actions/main.js'));` … `act.indexOf('this.state.writeMainMeta(meta)')`，
   并与 `act.indexOf('validateFrpExposure')` 比较**先后**（闸必须先于落盘）。
2. `test/probe-gate-and-ownership-test.js:151`：
   `const sup = fs.readFileSync(...'src/app/domain-actions/router.js'...);` … `/this\.(?:daemons\.)?disableRouterPersist\(\)/`。

**改钉子的正确方式**：把判据改为**形态无关**（匹配 `writeMainMeta(` / `disableRouterPersist(` 的**调用存在性**），
**判据本意不变**（锁的是"该调用发生且顺序正确"，不是"必须经 this"）。改完必须自证：合成样本仍能命中
（把 `this.` 前缀去掉后判据仍绿，且**缺失该调用**时仍红）。

## 4. 纪律

1. 禁 `require` 产品模块/内存冒烟；只 `node --check`/grep/read/wc/只读 git。禁 git 写。
2. **不得回退** P4 的改动：`daemons/runtime.js` 的 D10 `classify()` 归属判定、`main/controller.js` 的 D11 声明式注释、
   `main/process.js`/`signals.js` 的 D12 `stop_failed` + timer 代际、`daemons/identity.js` 的 `_daemonManaged()` 语义。
3. R1：改/删注释前逐 token grep `test/`（CJK 用 `grep -oP '\p{Han}{4,}'`）。已知真注释钉子 5 条见 P2 §7.1。
4. R2：删任何导出前原始全仓 grep + 同文件 `this.<名>` + `EXECUTION-CONTRACT.md` 必须导出表比对。
5. 报告 `design-notes/_p6-b<n>-*.md`：改动/证据/行为变更/棘轮下降数值/CI 风险；**不得含操作者绝对路径**。
