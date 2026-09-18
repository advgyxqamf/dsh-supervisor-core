# EXEC · router 域 providers 功能切分（D2）

> 范围：`src/domains/router/providers/**`。依据：EXECUTION-CONTRACT §3.2 + DOMAIN-STRUCTURE-DESIGN §5.1 + `design-notes/router-providers.md`。
> 行为原则：**纯搬迁 + 显式注入**，接口面（`ProviderBase`/`ProxyProvider` 类与 base 重导出）逐字保持。

## 1. 实际改动（文件 → 行数）

| 文件 | 改前 | 改后 | 职责 | 来源 |
|---|---|---|---|---|
| `providers/model.js` | — | 106 | 账号模型 + keyId/掩码 + 序列化（纯） | base B2 |
| `providers/policies/quota.js` | — | 191 | 额度判定 + 响应分类 + 重置归一（纯） | base:23-185,439-457 |
| `providers/policies/freeze.js` | — | 236 | 冻结/恢复状态机 + applyDetection（provider 注入） | base:383-544,588-682,693-730 |
| `providers/store.js` | — | 30 | `AccountStore` 持久化网关（single write gate） | base:684-686 |
| `providers/command.js` | — | 43 | `buildCommand` argv 拼装（纯） | proxy:116-206 |
| `providers/pool.js` | — | 118 | 实例池纯决策（HOT/WARM/常驻/备胎） | proxy:896-1008,1099-1102 |
| `providers/restart.js` | — | 117 | `createRestartOrchestrator` 重拉 + reconcile 编排 | proxy:655-678,1010-1066 |
| `providers/probe.js` | — | 312 | spawn/探活/生命周期/包缓存/配额探测/等待停 | proxy:208-354,464-590,726-756,857-880 |
| `providers/base.js` | 777 | **199** | 抽象契约 + 账号池 + 检测应用（薄委托） | base:187-777 |
| `providers/proxy.js` | 1111 | **389** | 进程治理入口 + 生命周期钩子 + 委托 | proxy 主体 |
| `providers/quota-strategies.js` | 164 | 163 | 仅 require 指向改 `./policies/quota` | — |

**DF-2（≤400）全绿**：最大文件 probe.js 312、proxy.js 389。

## 2. 依赖图（DAG，单向）

```
proxy ─┬→ base ─┬→ model
       │        ├→ store
       │        └→ policies/{quota,freeze}
       ├→ command (纯)
       ├→ pool → policies/quota (纯)
       ├→ restart → ../model
       └→ probe ─┬→ ../model
                 ├→ quota-strategies → policies/quota
                 └→ policies/quota
quota-strategies → policies/quota
```

- 纯模块（`model/policies/*/command/pool/restart/store`）**零** `node:fs`/`node:net`/`node:child_process` require。
- 无环；`proxy → probe → provider.*` 为运行期回调，**无 require 环**（probe 不 require proxy）。

## 3. 打破的隐式 `this` 反向边（DF-4）

| 旧调用 | 手法 | 新形态 |
|---|---|---|
| `base.js:307 this.stopInstance(acc.instance)`（→ proxy） | **B ctor 注入钩子** | `discardAccount` 调 `this._hooks.onDiscardAccount(acc)`；ProxyProvider 在 ctor 注入（内部走 `this.stopInstance` + `ports.unregister`） |
| `proxy` 调 `this._persist()` | B | `this.store.persist()`（`AccountStore` ctor 注入 `onPersist`；保留 `_persist()` 薄委托） |
| `proxy` 调 `this._isCreditsLow/accountQuotaSummary/...` | A/C | 纯函数 `policies/quota` 具名导出；base 方法委托 |

- `extends` 上溯（`proxy.super.mark*`）与 `base.js` 的 11 个**抽象占位**（抛 'must be implemented by process-pool provider'）**原样保留**（DG-4 豁免）。
- `base.js:243-253` 的 12 个契约占位计数不变（PG-1 仍 ≥12）。

## 4. 与设计的偏差（如实）

1. **新增 `probe.js`**：任务书允许「若超再拆健康探测」。实测单拆健康探测仍不足以让 proxy ≤400，
   故把 **spawn/包缓存/配额探测/waitAllStopped** 一并下沉 probe.js（均为实例运行时 IO）。
   proxy 保留 `_doStart()` 薄委托 —— `reconcile-instance-test` 以 `ProxyProvider.prototype._doStart` 打桩，方法必须在原型上。
2. **`restart.js` 同时承载 reconcile 单飞编排**（原 proxy:`_runReconcile/reconcileInstances/reconcileNow`）。
   属生命周期编排 IO；经 `provider` 显式入参，`restart.js` 自身不 require IO。否则 proxy 超 400。
3. **`providers/store.js` 是持久化网关，不含文件 IO**：原子写 + 锁 + 损坏现场保留由 `router/store.js` 的
   `RouterStore` 唯一持有（PG-7 单写者）。provider 侧只经 ctor 注入的 `onPersist` 触发，第二写者会破坏「守卫只读」。
   故 `AccountStore` 只暴露 `canPersist()/persist()`（未 require platform/util/fs）。
4. **`command.js` 不做凭证剔除**：`buildCommand` 只做 argv 结构与 `{{port}}` 替换（纯）；
   `--api-key` / `{{key}}` 的剔除是 provider 的**凭证纪律**，留在 `proxy._resolveLaunchCommand`（INV：key 只经 env）。
5. **`quota-strategies.js` 未并入 policies/quota.js**：该文件是「取数 + 解析」的 IO 策略表（fetch），
   不是纯判定；仅把其纯依赖 `normalizeResetTs` 指向 `policies/quota`。
6. **`policies/freeze.js` 236 行** 超任务表 ≤200 目标（硬判据 DF-2 ≤400 满足）；按「冻结/恢复」单一职责未再拆，
   以免把状态机切成两处状态。
7. **`proxy.js` 389 行** 超任务表 ≤330 目标（DF-2 满足）。全部方法名/原型面保持，转发层与测试调用零改动。
8. **合同 §3.2 写作 `class BaseProvider`**，实际导出仍为 `ProviderBase`（消费方与 12+ 测试依赖该名；
   §2.6 要求公共导出面不变）——以代码为准。
9. **`base` ctor 新增 `this.config = opts.config || null`**：原 `_limits/_switchBudgetMs` 读 `this.config` 却无人赋值。
   现按传入值生效；`deserializeProvider` 当前未转发 config，故生产默认行为不变（默认上限/预算）。
10. **`discardAccount` 不再 require ports**：端口释放移入 ProxyProvider 注入的钩子；base 去掉 `ports` 依赖。

## 5. 同步改指向的既有门禁（§8）

| 门禁 | 改动 |
|---|---|
| `test/provider-gateway-gate-test.js` | PG-6/PG-4 读**整组** `providerSrc`（proxy+command+pool+probe+restart+base+model）；沿用 forward 组的同款修法。23/0 |
| `test/probe-gate-and-ownership-test.js` | E-a 的 `applyDetection` 实现位置 → `policies/freeze.js`（只动 E-a 块，与并行的 line-135 改动互不重叠）。33/0 |

其余源码内容门禁（`router-circuit-breaker`、`round13-router-relay-gaps`、`kernel-daemon-contract`）
因 `restartInstance/markUsed/markRequestOk/markInstanceNetFail/markInstanceProblem/flushRestartPending`
与 `this.stateDir` **仍留在 proxy.js** 而无需改指向。

## 6. 验证（实跑）

- provider-gateway-gate 23/0；router-test 19/0；p2p-router 43/0；core-test 37/2（仅 UI 未构建，原基线同）；
  platform-capability-audit 66/0；directory-structure-gate 16/0（hard）+ report-only；
  layering-and-dependency-gate 10/0。
- 追加：upstream-credits 75/0、monthly-credits-freeze 8/0、commandcode-quota 14/0、reconcile-instance 60/0、
  reconcile-single-flight 10/0、freeze-recovery 11/0、ensure-instance 8/0、router-circuit-breaker 16/0、
  adopt-token-reclaim 27/0、round13-router-relay-gaps 25/0、round13-robustness-batch 22/0、round13-dropped-result 7/0、
  round13-lifecycle-stop-phase 9/0、lifecycle-mirror 11/0、probe-gate-and-ownership 33/0、router-e2e 4/0、
  router-ctl 全过、graceful-shutdown 17/0、sigterm-desired 4/0、daemon-lifecycle 14/0、p2p-api 35/0。
- `node --check` + `require()` 全部新文件通过；未启动任何守卫/daemon，未碰 `/tmp/dsh-*`、`~/.local/state`、`~/.dsh`。

## 7. 遗留 / 后续轮次

- `proxy.js` 仍持 `addAccount/detectInstanceQuota 委托/_probeAfterResponseFreeze 委托/池与 reconcile 委托`；
  若后续要压到 ≤330，可把「账号入库编排」上收 base（hook 化）或新增 `lifecycle.js`。
- `providers/policies/freeze.js` 的 `normalizeConsistency/reconcileLock` 属「序列化前置守卫/锁收敛」，
  语义上可再归入 model/base；本轮保留以保证状态机单点可读。
- `providers/instances/proxy-instance.js` 过渡 shim 由 switch/instance 批次最终删除；`probe.js` 已指向 `../model`。
