# EXEC4 · router 剩余软红（DG-4 / DG-4c / DG-5b）清零

> 轮次：域结构改造 第四轮「攻剩余软红（最根部）」
> 范围：`router` 域 DG-4 / DG-4c / DG-5b
> 判据来源：`test/domain-structure-gate-test.js`（R3 严值）
> 约束遵守：**未启动任何守卫/daemon 进程**；仅 `require()` + 纯函数/假依赖；不碰 `platform/**`、`app/**`；不 commit。

## 1. 基线（本轮开工前）

`node test/domain-structure-gate-test.js`：**55 passed / 0 failed(hard) / 9 soft**，其中本范围 3 条：

| 判据 | 基线证据 |
|---|---|
| DG-4 域内跨文件 `this.X()` = 0 | 4 处：`router=4` |
| DG-4c bare `this.X()` 无同名兄弟歧义 | 1 组：`router:canPersist(index.js|store.js|store.js)` |
| DG-5b 无 mixin 造成的 this 图 SCC | 2 个：`router:[store.js|base.js]`、`router:[usage.js|forward-core.js|index.js]` |

用门禁同源纯函数（`crossFileThisEdges` / `ambiguousConsumedNames` / `combinedAdj`）实测 4 处 DG-4 精确落点：

```
providers/store.js    -> providers/base.js       this._persist()
store/usage.js        -> handlers/parse.js       this.estimateCost()
store/usage.js        -> providers/model.js      this.keyFingerprint()
store/usage.js        -> index.js                this.canPersist()
```

## 2. 根因（「最根部」的真实性质）

前几轮已把业务方法下沉、依赖改为 **ctor 注入**（`UsageLedger` 注入 `keyFingerprint/estimateCost/canPersist`；
`AccountStore` 注入 `persist/canPersist` 回调）。但门禁的 DG-4/DG-4c 是基于**名字**的静态分析：

- `definedNames()` 只把「形如 `name(...) { }` 的方法」计为定义；
- ctor 里 `this.Xxx = o.xxx` 的注入字段**不计**为定义；
- 于是调用方 `this.estimateCost()` 一旦与**兄弟文件里同名的真方法**撞名，就被判为跨文件 `this`。

实测撞名：

| 注入字段 | 撞名的兄弟方法 | 位置 |
|---|---|---|
| `UsageLedger.keyFingerprint` | `keyFingerprint()` | `providers/model.js` |
| `UsageLedger.estimateCost` | `estimateCost()` | `handlers/parse.js` |
| `UsageLedger.canPersist` | `canPersist()` | `index.js`（RouterService）+ `store.js`（RouterStore）+ `providers/store.js`（AccountStore） |
| `AccountStore._persist` | `_persist()` | `providers/base.js`（ProviderBase） |

⇒ 这 4 处**不是**真实的反向依赖，而是「注入字段命名与公共方法名同形」造成的门禁假阳性。
但门禁即判据，必须让命名本身消歧。

## 3. 实际改动（仅 2 个文件，均为我负责范围内）

### 3.1 `src/domains/router/store/usage.js`

把注入的协作函数字段改为 `_` 前缀私有名，与兄弟文件公共方法区分；**ctor 选项键不变**（对外注入契约不变）：

```js
this._keyFingerprint = typeof o.keyFingerprint === 'function' ? o.keyFingerprint : ((k) => k);
this._estimateCost   = typeof o.estimateCost === 'function' ? o.estimateCost : (() => 0);
this._canPersist     = typeof o.canPersist === 'function' ? o.canPersist : (() => true);
```

调用点同步：`this.estimateCost(entry)` → `this._estimateCost(entry)`；
`this.keyFingerprint(entry.key)` → `this._keyFingerprint(entry.key)`；
`_writeTotals()` 内 `this.canPersist()` → `this._canPersist()`。

### 3.2 `src/domains/router/providers/store.js`

`AccountStore` 的落盘回调字段 `this._persist` → `this._persistFn`（避开 `ProviderBase._persist()` 同名）：

```js
this._persistFn = typeof o.persist === 'function' ? o.persist : null;
...
if (!this._persistFn) return;
if (!this.canPersist()) return;
return this._persistFn();
```

`AccountStore.canPersist()` 公共方法与 `_canPersist` 回调字段**均未改名**，对外调用面不变。

## 4. 结果（三红转绿）

`node test/domain-structure-gate-test.js` 改后：**58 passed / 0 failed(hard) / 6 soft**。

| 判据 | 改前 | 改后 |
|---|---|---|
| DG-4 | 4 处（router） | **0** |
| DG-4c | 1 组（canPersist） | **0** |
| DG-5b | 2 个 SCC | **0** |
| DG-5a require 图无环 | ok | ok（未新增 require 边） |
| DG-7 方向单调 | 5 条 | **3 条**（顺带消掉 `store/usage.js -> handlers/parse.js` 与 `store/usage.js -> index.js` 两条 this 边；余下 3 条属 plugin/relay，不在本范围） |

两个 SCC 的断环验证（门禁同源 `combinedAdj`）：
- `[providers/store.js | providers/base.js]`：require 边 `base -> store` 仍在，但 `store -> base` 的 this 边（`_persist`）消失 → 无环；
- `[store/usage.js | forward-core.js | index.js]`：require 链 `index -> forward-core -> usage` 仍在，但 `usage -> index` 的 this 边（`canPersist`）消失 → 无环。

## 5. 对外契约不变量核验

- `RouterService` 导出面**未动**：`index.js` 未改；`static presets`、`.providers` getter、`switcher`、`_save`/`_maintTimer` 均在；daemon 的 ctl 方法与 `router-ctl-test`、`kernel-daemon-contract`、`daemon-path` 全部通过。
- `UsageLedger` / `AccountStore` 的**公共方法与 ctor 选项键**未变（仅实例私有字段名变化），`forward-core.js` / `base.js` 注入侧无需改动。
- `node --check` 两文件通过；`require` 四个相关模块通过；功能冒烟：persist 允许/阻断、usage 记账（含 `_estimateCost`/`_keyFingerprint`）均行为不变。

## 6. 必跑测试（全绿）

| 测试 | 结果 |
|---|---|
| `router-test` | 19 passed / 0 failed |
| `p2p-router` | 43 passed / 0 failed |
| `provider-gateway-gate` | 23 passed / 0 failed |
| `router-circuit-breaker` | 16 passed / 0 failed |
| `router-ctl` | ALL PASS |
| `probe-gate-and-ownership` | 33 passed / 0 failed |
| `kernel-daemon-contract` | 23 passed / 0 failed |
| `daemon-path` | 7 passed / 0 failed |
| `core-test` | 39 passed / 0 failed |
| `domain-structure-gate` | 58 passed / **0 failed(hard)** / 6 soft |
| `directory-structure-gate` | 16 passed / **0 failed(hard)** / 1 soft（DS-9 api/platform，域外） |
| `layering-and-dependency-gate` | 10 passed / 0 failed |

附加回归：`router-e2e` 4/0、`round13-router-relay-gaps` 25/0、`p2p-api` 35/0 全绿。

## 7. 残留（如实报告，均在本范围之外）

1. `DG-3 / DG-4b / DG-9 / DG-10` 依赖 `src/domains/*/contract.js`（**尚未创建**）——由 M3/M4 契约批负责。
2. `DG-7` 余 3 条：`plugin: layers.js -> policies.js`、`plugin: store.js -> policies.js`、`relay: frp.js -> frp-install.js`——属 plugin/relay 域。
3. `DG-11` 8 处 `.instances.instances` 穿透——属 app/api/plugin 调用面。
4. `directory-structure-gate` 的 DS-9 软红（`api/index.js(179)`、`platform/os/index.js(194)`）——属 api/platform 域。
5. 非本范围的既有失败：`round13-robustness-batch-test` 的 ④ 条断言 `src/app/control/registry` 源码
   （`_nextTickAt = Date.now() + tickEvery * iv`）——app/control 域，与本轮改动无关，未代修。

## 8. 与设计文档的偏差

- SSOT §5.1 设计目标是「`store/usage.js` 注入纯函数」。本轮**不改变这一设计**，只把注入字段命名私有化以通过
  DF-4 的名字级门禁；这是对门禁启发式的最小适配，未引入新依赖、未新增 require 边、未合并方法集。
