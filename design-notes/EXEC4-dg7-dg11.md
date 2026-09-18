# EXEC4 · DG-7 依赖方向单调 + DG-11 `.instances.instances` 穿透收口

> 范围（派工单）：**DG-7 依赖方向单调**（5 条向上边）+ **DG-11 域外数组穿透**（8 处）。
> 约束：不碰 `platform/**`；不启动守卫/daemon；不 commit；app/** 改前重读；实例活数组身份语义逐字保留。

## 0. 基线 → 终态

| 门禁 | 基线 | 终态 |
|---|---|---|
| DG-7 依赖方向单调 | FAIL(soft) 5 条 | **PASS**（130 边，0 条向上）|
| DG-11 域外 `.instances.instances` | FAIL(soft) 8 处 | **PASS**（0 处）|
| `domain-structure-gate-test` 总计 | 55P/0H/9S | **64P / 0H / 0S** |

> 注：基线中的 `store/usage.js -> handlers/parse.js`、`store/usage.js -> index.js` 两条在施工期间已由
> 并行子代理（RT 系列）以「注入字段加 `_` 前缀」消除（`this._estimateCost/_keyFingerprint/_canPersist`），
> 本轮复核时该两条已不在 RED 清单，未重复改动。

---

## 1. DG-7 修复

### 1.1 plugin：`layers.js` / `store.js` → `policies.js`（rank 3 → 2）

**定性**：真实反向依赖。`layers.js`(rank 3) 与 `store.js`(rank 3) 需要 `policies.js`(rank 2) 里的
**纯谓词**。按 §3 手法「把纯谓词下沉」：将这两个消费者用到的 5 个纯函数迁到 **rank 3 的 `model.js`**。

迁移的纯函数（原样搬移，零行为变更）：
- `isProtectedName` / `isOwnRow` / `isOwnDisabled` / `ownerPackage` / `targetHomePatchPath`

改动：
- `plugin/model.js`：新增 `const path = require('node:path')` + 上述 5 个具名导出（`model.js` 仍无 IO require）。
- `plugin/policies.js`：删除 5 个函数定义，改为 `require('./model')` 后再导出（**保持 policies.js 既有导入面逐字不变**；
  `ops.js` 经 `policies.js` 取 `isProtectedName` 依旧可用）。policies → model 为 rank 2 → 3，合法。
- `plugin/store.js`：`PROTECTED` 与 `ownerPackage/targetHomePatchPath` 合并为一条 `require('./model')`；
  不再 require `./policies`。
- `plugin/layers.js`：改 `require('./model')`；不再 require `./policies`。

结果：`layers.js -> policies.js`、`store.js -> policies.js` 两条边消失（改为 3→3）。

### 1.2 relay：`frp.js` → `frp-install.js`（rank 2 → 1）

**定性**：**rank 归类问题**，非真实反向依赖。
- `design-notes/relay.md:216` 明确「`frp → frp-install` 域内 · 合法」；
- `EXEC-relay-domain.md:38` 把 `frp-install.js` 列为域内叶子（只依赖 `platform/contract/matrix`）；
- `frp.js`/`frp-install.js` 是原 `frpmgr.js`（RANK 记为 2）按副作用二分的两半，二者应同层。
- `design-notes/EXEC-gates.md:128-129` 已预先裁定：此类情形「若属归类，改 RANK 表即可（集中在一处）」。

改动（**唯一一处门禁常数表修正**，单点、集中）：
`test/domain-structure-gate-test.js` 的 `RANK`：`'frp-install.js'` 由 `1` → `2`（附理由注释）。
- 未改任何判据本体 / 阈值 / 反向自检；DG-7 反向自检仍全 PASS。
- 修正后：`frp.js`(2) → `frp-install.js`(2) 合法；`relay/index.js`(0) → frp-install(2) 合法。

---

## 2. DG-11 修复：InstanceManager 查询接口

### 2.1 新增接口（`domains/instance/index.js`）

```js
all()            // 返回 store 当前实例数组（每次取当前引用）
forEach(fn)      // 委托数组 forEach
find(id)         // 按 id 查找（未找到 undefined）
map(fn)          // 委托数组 map
```

**I1 冻结语义逐字保留**：`get instances()` / `set instances()` 原样不动；
`all()` 亦每次返回 `this._store.instances`（**非快照**），store 仍是唯一持有者。
`app/state/store.js` 等既有直读活数组/splice 的持引用方不受影响。

### 2.2 8 处消费方改调接口

| 文件 | 原形态 | 现形态 |
|---|---|---|
| `api/domains/instances.js` | `(sup.instances.instances \|\| []).find(x => x.id===j.id)` | `sup.instances.find(j.id)` |
| `app/assembly/bootstrap.js` | `host.instances.instances \|\| []` 遍历 | `host.instances.all()` |
| `app/audit/orphan-scan.js` | `(this.instances && this.instances.instances) \|\| []` .map | `this.instances ? this.instances.map(...) : []` |
| `app/control/instance-adapter.js` | `(this.instances.instances \|\| []).find(...)` | `this.instances.find(entry.id)` |
| `app/daemons/runtime.js` | `...((this.instances && this.instances.instances) \|\| [])` | `...(this.instances ? this.instances.all() : [])` |
| `app/facade/main.js` | `(this.instances && this.instances.instances) \|\| []` .filter | `(this.instances ? this.instances.all() : []).filter(...)` |
| `app/session/shutdown.js` | `(host.instances && host.instances.instances) \|\| []` | `host.instances ? host.instances.all() : []` |
| `domains/plugin/targets.js` | `.instances.instances` .filter / .find | `ctx.instances.all().filter(...)` / `ctx.instances.find(str)` |

`domains/plugin/targets.js` 为唯一跨域穿透，已按 `instance/contract.js` 的 `PUBLIC_API`
（含 `all/forEach/find/map`，R4-A 已登记）改用查询接口。

### 2.3 测试桩同步（接口变更的必然连锁）

以下测试桩按「消费方只经接口」同步补上查询方法（**未改任何断言语义**）：
- `test/api-contract-test.js`：`instances` 桩补 `find(id)`、`all()`；
- `test/token-contract-gate-test.js`：`sup.instances` 桩补 `all()`（`runtime#_syncLanState` 消费）。

---

## 3. 实跑记录

`node --check` + `require` 加载：全部改动文件通过。

必跑测试（exit 0）：
`instance-state`(10)`instance-safety`(33)`reconcile-instance`(60)`ensure-instance`(8)
`plugin-change-restart`(52)`api-contract`(14)`api-surface`(12)`session-lifecycle`(41)
`managed-registry`(44)`frp-platform`(11)`round13-frpc-integrity`(15)`token-contract-gate`(38)
`graceful-shutdown`(17)`heartbeat-selfheal`(16)`round8-fixes`(59)`round13-router-relay-gaps`(25)
`round13-robustness-batch`(22)`round13-discipline-gaps`(24)`shell-watchdog`(34)`native-dsh-binding`(12) 等。

三结构门禁：
- `domain-structure-gate-test`：**64 passed, 0 failed(hard), 0 failed(soft)** —— DG-7 / DG-11 均 **PASS**；
- `directory-structure-gate-test`：16 passed, 0 hard, 1 soft（DS-9 `api/index.js`(179)/`platform/os/index.js`(194)，非本轮范围）；
- `layering-and-dependency-gate-test`：10 passed, 0 failed。

`smoke` 为真实 daemon 进程 + 固定端口用例，存在并发/时序抖动（单独多次运行 34/34 通过为主，
偶发 `desired=stopped 期间不重新 spawn` 失败）；本轮改动不触及 spawn/生命周期路径。

---

## 4. 偏差与遗留

1. **`frp.js → frp-install.js` 采「RANK 归类修正」而非改代码**：依据 `relay.md:216`、`EXEC-relay-domain.md:38`
   与 `EXEC-gates.md:128-129` 的预设裁定。若上游要求「不动门禁常数」，替代方案是 go through ctor 注入 install 端口
   并同步改 `test/frp-resilience-test.js`/`test/round13-frpc-integrity-test.js`（二者直接 `new FrpManager(...)` 并调 `.install()`），
   代价更高且引入新注入面，故未采用。
2. **仍有 2 处「无前导点的」`instances.instances` 形态**（门禁正则要求 `.instances.instances`）：
   `app/control/adapters.js:103`（`instances && instances.instances`）、`domains/relay/managed.js:22`——
   **未被 DG-11 计入**，本轮未改以免越界到 relay 域（R4 在改）与 adapters 装配面。建议后续统一到查询接口。
3. `app/domain-actions/main.js` 的两处 `this.instances.instances` 仅在注释中（已改为经 `views.exposurePeers()` 注入），
   门禁剥注释后不命中。
4. 其余软红（DG-3/DG-4b/DG-9/DG-10 等 contract 相关）由 R4-A 等并行批已收口，本轮域门禁已 0 soft。
