# P6-B B-1 报告：facade / daemons **原地去 this**（惰性 deps，保留 `{methods}` 外壳）

> 对应作业单 `_workorder-phase6.md` §3 的 B-1 分片（facade + daemons）。由主控实施并自验
> （P6-B 与 P4-C 两个执行者均未交付实现）。未跑测试/门禁、未 require 产品模块；只
> `node --check` / grep / read / wc / 只读 git。全部路径为仓库相对路径。

## 0. 结论（棘轮真实下降）

| 目录 | 改前 `this.X(`（raw） | 改后 | 说明 |
|---|---|---|---|
| `src/app/facade` | 13（router 7 / main 5 / ports 1；lan/status 0） | **0** | 三个文件的实现体改走 deps |
| `src/app/daemons` | 43（process 29 / runtime 8 / identity 6） | **29** | identity/runtime 归零；process 是类，不属治理面 |

- `test/app-this-ratchet-gate-test.js` 的 `BASELINE_BY_DIR` 已按纪律**下调**：
  `daemons 43->29`、`facade 13->0`，`BASELINE_TOTAL 264->237`（剥注释实测 235，松弛量 2）。
  收紧记录已写入常量旁注释（含每文件归属与 process.js 为何保留）。

## 1. 做法（为什么是「原地」而不是 createX + 委托壳）

作业单 §3.4 的**最高风险**是：多道门禁会**从模块源码里抽取真实方法体**，委托壳会让它们抽到空壳：

| 门禁 | 读取形态 |
|---|---|
| `token-contract-gate-test.js` TK-G4 | `methodBody(structOf('src/app/daemons/runtime.js'), '_syncLanState')` |
| `srcpath-gate-test.js` G10-d | runtime.js 顶层 `require('./scripts')` + `daemonScript(...)` 调用 |
| `guard-domain-model-gate-test.js` GD-2 | 拼接 router+supervise+runtime+lan 后 `methodBody(..., '_daemonSuperviseOnce')` |
| `domain-structure-gate-test.js` DG-14 | `methodBodies` / `unsupportedMethodForms` 扫 `app/facade/*.js` 全文 |

故采用**原地去 this**：方法仍定义在 `module.exports = { methods: {...} }` 中、**名字/形参/实现逐字保留**，
只把方法体内对 `this` 的隐式访问改为经**按 host 缓存的惰性 deps**：

`@js
const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) { d = { config() { return host.config; }, /* ... */ }; DEPS.set(host, d); }
  return d;
}
module.exports = { methods: {
  someMethod() { const d = depsOf(this); /* 原方法体，this.config -> d.config() */ },
} };
`@

- 每个方法体**唯一**出现的 this 是 `depsOf(this)`（只作 WeakMap 键）；不再有 `this.X(` 形态。
- deps 全为**惰性**成员（getter/forwarder 每次读 host 实时值），装配期 host 未就绪也安全；
  测试运行时覆写 host 上的方法/字段仍即时生效（与 `collaborators.js` 的既有范式一致）。
- **不新增 host 面**：沿用 `facets.js` 的 `installMethods(host, mod.methods)`，无 `host.facade`/
  `host.daemons` 新对象（避免重犯 P3-A 撤掉 `host.domainActions` 的错误）。

## 2. 改动清单与 deps 映射

### facade/router.js（128 行）
deps：`config()`、`daemons()`、`router()`、`logger()`、`managedObjects()`、`ctl()`；
兄弟方法转发 `routerDaemonActive()`/`routerApi()`/`routerStatus()`；可变字段
`readRouterFacade()`/`writeRouterFacade(v)`。

### facade/main.js（`methods` 常量）
deps：`state()`、`config()`、`instances()`、`mChild()`、`mAdoptPid()`、`mPhase()`。

### facade/ports.js（94 行）
deps：`logger()`、`portActives(list)`（兄弟方法）、`readPortActivesCache()`/`writePortActivesCache(v)`。

### daemons/identity.js（58 行）
deps：`config()`、`lanLockPath()`/`routerDaemonLockPath()`（兄弟方法）。6 处 `this.X(` -> 0。

### daemons/runtime.js（254 行，DG-2 上限 300 内）
deps：`configPath`/`config`/`ctl`/`logger`/`events`/`name`/`daemons`/`instances`/`views`/
`tokenService`/`router`（值成员）；`dshMainView`/`daemonLifecycle`/`daemonEnsureResult`/
`disableRouterPersist`（兄弟方法转发）；`readLc`/`writeLc`、`readLastLanStateJson`/
`writeLastLanStateJson`、`readLastOccupiedWarn`/`writeLastOccupiedWarn`（可变字段）。8 处 -> 0。
顶层 `require('./scripts')` 与 `scripts.daemonScript(...)` 调用形态未变（G10-d 绿）。

## 3. 自验（主控独立核对，非采信自报）

1. **语法**：5 个源文件 + 1 个门禁文件 `node --check` 全通过。
2. **AT 口径复算**：逐文件 `grep -oE 'this.[A-Za-z_$][A-Za-z0-9_$]*[ 	]*('` 得
   facade 0、daemons 29（process 29，其余 0）；全 app raw 237。基线下调值与之一致。
3. **R1**：抽取新增注释行的 CJK(>=4,`grep -oP '\p{Han}{4,}'`)/ASCII 串在 `test/` 反查；
  命中项（如「测试覆写」「不受影响」）已改写为不与他门禁断言字面撞车的措辞，最终只剩测试自身注释里的泛词。
4. **DG-14 约束**（`app/facade/*.js`）：deps 成员全为**方法简写块体**，无 `name: (...) => expr`
   （`unsupportedMethodForms` 零命中）；无写动词方法名、无 `WRITE_TARGET_CALL` 命中。
5. **行为等价**：改动是机械替换（`this.X()` -> `d.X()`、`this.<字段>` -> deps getter/`readX`/`writeX`），
   兄弟调用经 host 上的既有安装转发；`_syncLanState`/`_daemonSuperviseOnce` 的真实体仍在 `methods` 内
   （TK-G4 / GD-2 抽取不受影响）；`daemon-path-test` 依赖的 `{ methods }` 形态与缓存语义不变
   （`d.readLc()` 每次读 host.`_lc`，同 host 二次调用返回同一实例）。

## 4. 明确的残余（登记，不硬推）

1. **`main` 目录仍 141 处**（B-2）：作业单明示为最高风险热路径，要求按文件切分并在被形态钉住时停止；
   本批未动，保持基线 141。
2. **@property 访问未全部消除**：`facade/lan.js`、`facade/status.js`、`daemons/probe.js`、
   `daemons/supervise.js` 的 `this.X(` 计数原为 0，未改动；它们仍在方法体内使用 `this.config`/
   `this.daemons` 等**属性访问**（不进入 AT 计数）。若要追求「模块可不依赖隐式 host」，需下一轮
   全属性 deps 化。
3. **`host.daemons` / `host.main` 仍是 `installThin` 的转发器**：本批只做了实现体去 this，
   未新建真 ctor 覆盖（作业单 §3 的「覆盖为真工厂对象」）。原因是这两者是薄委托接口表 `THIN_SPEC` 的
   声明出处，覆盖需同批重构协作方装配；且**无任何门禁要求**，贸然改会扩大热路径风险面。

## 5. CI 风险

**低**。所有改动是机械等价替换且保持了被门禁抽取的方法体形态；AT 基线为下调（只收紧不放松）；
R1/DG-14 已前置自检；无装配/导出面变化。最终由 CI 四平台裁决。
