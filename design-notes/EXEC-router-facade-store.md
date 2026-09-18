# EXEC · router 域 门面与状态层（RT1）

> 范围：把 `src/domains/router/index.js`（旧 763 行）的 ②持久化 / ③维护定时器 / ④HTTP 端点 /
> ⑤状态查询 / ⑥供应商 CRUD 全部切出，只留薄门面。依据 `EXECUTION-CONTRACT.md §3.2`、
> `DOMAIN-STRUCTURE-DESIGN.md`、`design-notes/router-facade-store.md`。
> 未启动任何守卫/daemon；未 commit；只改本域归属文件。
>
> ⚠ **并行施工实况**：本轮有多个子代理同时改 router 域。`model.js`、`policies/*`、
> `handlers/*`、`store/usage.js`、`forward-core.js`、`router-ops.js`、`ops/*` 由兄弟代理产出；
> 本文件只记录**我（RT1）实际落盘**的改动。

## 1. 实际改动

| 文件 | 行数 | 职责（Q 块） | 来源 |
|---|---:|---|---|
| `index.js` | **150**（≤150） | Q1 组合根：ctor 显式组装 + 薄委托，零业务 | 旧 :22-62 + 758-763 |
| `store.js` | **169**（≤170） | Q4 providers.json + Q5 用量读写 + Q6 **写权单闸** + provider 反序列化 | 旧 :65-144 + forward-core 用量 IO |
| `views.js` | 146（≤200） | Q13 status/domainSummary/portsView/listProviders（纯，deps 显式） | 旧 :544-680 |
| `scheduler.js` | 216（≤290） | Q10 定时器 + Q11 账号探测；纯判据具名导出 | 旧 :210-429 |
| `endpoint.js` | 135（≤140） | Q8 激活与端点启停 + Q9 请求分派/HTTP 装配 | 旧 :431-542 |
| `ops.js` | 165（≤260） | Q7 注册表 CRUD + Q12 生命周期 + 端口释放 + Q2 域状态容器 | 旧 :156-208 + 682-756 |

- **门面零隐式 this**：旧 `index.js:758-759` 的两行
  `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` /
  `...auxMethods` **已删除**；改为 ctor 内显式工厂注入
  `createForwardCore(deps)` / `createAuxCore(deps)`，各公开方法一行薄委托。
  全域 `Object.assign(X.prototype, ...)` = **0 处**。
- **Ctor 组装顺序**（消除环）：state → store(load+deserialize) → switcher → forward → aux →
  scheduler → endpoint(注入 scheduler) → ops(注入 endpoint+scheduler)。
- **依赖方向**（DF-7）：`index → {ops,endpoint,views,scheduler,forward-core,router-ops} →
  {store,providers,platform,shared}`；新模块之间零 require，协作者全经 ctor/闭包注入。
- 门面不含 `setInterval(` / `http.createServer` / `fs.writeFile` / `JSON.stringify` /
  `require('node:fs'|'node:http'|'node:https')` / `findIndex`（RG-3）。

## 2. 三个必修缺陷

1. **写权闸收敛为 store.js 唯一闸**：`RouterStore.setPersistEnabled(v)`（服务级）与
   `loadedOk`（文件级）合成 `canPersist() = _writable !== false && loadedOk === true`；
   `save()/writeUsage()` **方法体内自查**该闸，调用方不再各自判断。
   门面 `canPersist()/setPersistEnabled()` 仅薄委托；转发用的 `UsageLedger` 也经注入
   `canPersist: () => store.canPersist()` 走同一闸 → `forward-core.js:508` 式「只查服务级」不再可能。
   `_persistEnabled` 字段已从门面删除。
2. **用量读写归口**：`store.js` 提供 `readUsage()/writeUsage()`，`.tmp` 命名统一为
   `<file>.tmp.<pid>.<ts>`（与 `save` 及兄弟模块 `store/usage.js` 一致）。
   门面 `views.loadTotals` 消费 `store.readUsage()`；转发侧记账由兄弟模块
   `store/usage.js#UsageLedger` 承担（`writeUsage` 保留为冻结接口，供 RT3 直用）。
3. **端点归属**：`endpoint.js` 承接 `handleForProvider/newServer/readBody/activateProvider/
   deactivateProvider/start|stopProviderServer/startActivatedProviders`；
   转发经注入 `forward.proxyFor`，实例保障经注入 `scheduler.ensureProviderInstances`，
   文件内不 require 实现。

## 3. 验证（实跑，离线）

| 测试 | 结果 |
|---|---|
| `router-test` | 19/0 |
| `p2p-router-test`（真实 spawn mock） | **43/0** |
| `ensure-instance-test`（真实 spawn mock） | 8/0 |
| `router-ctl-test` | ALL PASS |
| `router-e2e-test` | 4/0 |
| `core-test` | 37/2（2 项为 UI 未构建的**既有**失败，非本改动） |
| `provider-gateway-gate-test` | 23/0（PG-7 已由兄弟改为读 `store/usage.js`） |
| `round13-robustness-batch-test` | 22/0 |
| `kernel-daemon-contract-test` | 23/0 |
| `api-contract-test` | 14/0 |
| `directory-structure-gate-test` | exit 0（DS-G3b 报 supervisor.js；DS-9 report-only 报域外文件） |
| `layering-and-dependency-gate-test` | 9/1（FAIL 为 `supervisor.js` require `app/domain-actions` 未登记，属 F1 在途） |

每个新文件均 `node --check` + `require()` 加载通过；`require` 新模块不读盘/不监听/不起定时器（DF-6）。

## 4. 与设计的偏差（需知悉）

1. **`model.js` 非本代理产出**：兄弟代理已按契约把 `model.js` 用作**实例模型**
   （`INSTANCE_STATES/stateContainer/...`，`instances/proxy-instance.js` 已改为其 shim）。
   故原设计归 `model.js` 的 **provider 反序列化**改放 `store.js`（与派工单「store.js 来源 :65-144」
   及 `kernel-daemon` 改指向 store.js 的指示一致）；**Q2 域状态容器**改放 `ops.js#createState`。
   代价：`store.js` 同时含 IO 与一个纯映射函数，DF-3「纯/副作用不混文件」在此有张力——
   这是并行归属冲突下的取舍，若后续新增 `provider-model.js` 可无损迁出。
2. **`round13-robustness:151-152` 与 `kernel-daemon-contract:78-79` 的改指向已由兄弟代理完成**
   （前者改为 `readDomain('src/domains/router')` 整域聚合；后者同样整域聚合 + 容忍
   `(d.config && d.config.stateFile)` 形态）。本代理**未再编辑测试文件**，避免并发覆盖。
3. **`forward-core.js` / `router-ops.js` 的兼容方法集（`forwardMethods`/`auxMethods` +
   `coreFor(host)`）仍由兄弟代理保留导出**，但门面**不再消费**（改走 `createForwardCore`/
   `createAuxCore`）。是否删除兼容面由对应代理/主代理裁决。

## 5. 遗留（非本代理文件，交由责任代理）

- `probe-gate-and-ownership-test` 当前 21/12：其 `ops` 常量仍读 `router-ops.js`，而
  `setProviderKeys/addProxyKey/removeProxyKey/discardAccount` 已下沉 `ops/admin.js` →
  E-d/E-f/E-g 静态定位失败。属 `router-ops` 重构代理/F1 的改指向（主代理 D-2 已指派）。
  **行为未回归**（`svc.setProviderKeys/switchToKey/discardAccount` 实测均为函数且经 `createAuxCore` 装配）。
- `layering-and-dependency-gate` 唯一 FAIL = `src/supervisor.js:70-72` 的
  `root -> app [src/app/domain-actions]` 未登记 → F1（D-2 第 4 项）。
- `round13-router-relay-gaps` 的 `patchDshMain` 失败属 R1 relay 改名中间态（主代理 D-5：R1 负责）。

## 6. 结论

index.js 六类职责已全部切出，门面 150 行、零 prototype 合并、零隐式 this、单向依赖；
写权单闸唯一化、用量 IO 归口、端点点独立成文件；本域相关行为测试全绿（p2p 43、ensure 8、ctl、e2e、router 19）。
