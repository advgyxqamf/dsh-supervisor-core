# router 域 · providers 功能设计（D2，主代理亲撰）

> 依据：`DOMAIN-DESIGN-BRIEF.md` §5 模板 + `design-notes/_RULING.md` R1–R12。
> 所有行号来自本轮实际 read。**只做设计，未改 src/**。

## A. 现状审计

### A.1 文件清单与职责

| 文件 | 行数 | 当前职责 | 问题 |
|---|---|---|---|
| `providers/base.js` | 777 | 抽象基类 + 账号池 + 额度策略 + 实例生命周期 + 持久化 + 检测 | **混杂 6 类**；含 IO（`_persist`）与纯策略 |
| `providers/proxy.js` | 1111 | 反代 provider 实现：命令拼装 + 实例进程治理 + 健康探测 + 重启 | **全仓最大文件**；6 类职责混放 |
| `providers/direct.js` | （读） | 直连 provider（无进程能力） | 依赖 base 正常 |
| `providers/quota-strategies.js` | 164 | 额度判定策略（已是策略模式 ✅） | 仅覆盖部分策略 |

### A.2 域内耦合图（实测）

```
direct.js      → base.js, quota-strategies.js
proxy.js       → base.js, quota-strategies.js
quota-strategies.js → base.js
forward-core.js → base.js
```

`this` 跨文件调用（**已按 R1 分性质**）：

| 方向 | 处数 | 性质 | 是否违规 |
|---|---|---|---|
| `proxy.js → base.js`（`_persist`/`isAccountUsable`/`instanceOf`/`accountQuotaSummary`/`applyDetection`/`_isCreditsLow`） | 6 | **extends 正常上溯** | ❌ 不违规 |
| `base.js → proxy.js`（`stopInstance`） | 1 | **已声明抽象占位**（base.js:247-253 抛 'must be implemented'） | ❌ 不违规（多态） |
| 其余 | — | — | — |

⇒ **DF-4 违规 = 0**（与 D5 精算一致：本对属 extends/虚分派，不计入 11 对/33 处）。

### A.3 病症清单

1. **DF-2 违规（最严重）**：`proxy.js` 1111 行、`base.js` 777 行，**均 > 400 上限**。
2. **DF-3 违规**：`base.js` 的 `_persist()`（:684，IO）与纯策略（`_isCreditsLow` :320、`classifyResponse` :324）同文件；
   `proxy.js` 的命令拼装（纯字符串，~:100-330）与进程 spawn（IO）同文件。
3. **职责错位**：`base.js` **名为基类，实为「基类 + 账号池 + 额度引擎 + 持久化」**；
4. **R12 简写 mixin 载体**：本目录 `module.exports` 用的是 class 形态（非 methods 分片），不受 R12 影响。

## B. 功能切面（★ 核心，不看现有文件）

| 功能块 | 职责 | 输入 | 输出 | 副作用 | 纯? |
|---|---|---|---|---|---|
| **B1 抽象契约** | 声明 provider 必须具备的能力与虚方法 | — | — | 无 | 纯 |
| **B2 账号模型** | 账号结构、keyId、状态字段、序列化形状 | 原始账号 | 规范化账号对象 | 无 | 纯 |
| **B3 额度判定** | 判定 rolling/weekly/credits 是否耗尽、何时重置 | quota + now | 判定结果 + nextResetAt | 无 | 纯 |
| **B4 冻结/恢复策略** | 依据判定结果决定 status 迁移（frozen/limited/banned） | acc + 判定 + now | 新 status | **记事件**（注入） | 近乎纯 |
| **B5 账号池** | 选号/标记使用/可用性/额度摘要 | 账号数组 + keyId | 选中的账号 | 无 | 纯 |
| **B6 响应分类** | 依据 HTTP 响应判定 signal（credits/window/banned） | status+headers+body | signal | 无 | 纯 |
| **B7 检测应用** | 把外部探测结果写回账号状态 | acc + det | 新 acc | **记事件** | 近乎纯 |
| **B8 持久化** | 账号状态落盘（原子写 + 锁） | 账号数组 | 文件 | **IO** | ✗ |
| **B9 命令拼装** | 由账号/配置构造 spawn 命令 | 账号 + 配置 | argv | 无 | 纯 |
| **B10 实例进程治理** | spawn/停/杀/查进程 | 实例 + 命令 | pid | **进程 IO** | ✗ |
| **B11 健康探测** | 探活实例、计数失败、触发重启 | 实例 | healthy | **网络 IO** | ✗ |
| **B12 实例池策略** | HOT/WARM 上限、预热、回收 | 实例数组 | 决策 | 无 | 纯 |
| **B13 重启编排** | 重启流程（停→起→验证） | 实例 | 结果 | **编排** | ✗ |

## C. 目标结构

```
providers/
├── base.js          ≤200  抽象契约（B1）+ 账号池（B5）+ 检测应用（B7）
├── model.js         ≤180  账号模型（B2）+ 序列化形状
├── policies/
│   ├── quota.js     ≤250  额度判定（B3）+ 响应分类（B6）
│   └── freeze.js    ≤200  冻结/恢复策略（B4）
├── store.js         ≤150  账号持久化（B8，原子写 + 锁）
├── command.js       ≤140  命令拼装（B9，纯）
├── proxy.js         ≤330  反代 provider：实例进程治理（B10）+ 健康探测（B11）
├── pool.js          ≤200  实例池策略（B12，纯）
├── restart.js       ≤180  重启编排（B13）
├── direct.js        ≤120  直连 provider（不变）
└── quota-strategies.js ≤164 （保留，并入 policies/quota.js 或留作叶子）
```

⚠ **R2 遵守**：`policies/` 在白名单内；其余扁平。
⚠ **行数临界**：`proxy.js` 目标 ≤330 —— 若实测超 400，把 B11 健康探测再拆 `probe.js`。

## D. 依赖图（DAG）

```
direct.js ─┐
proxy.js  ─┼→ base.js → model.js
           │           → store.js → (platform/util/fs)
           │           → policies/quota.js（纯）
           │           → policies/freeze.js（纯）
           ├→ command.js（纯）
           ├→ pool.js（纯）
           └→ restart.js → probe 逻辑
```

每条边方向 = 数据流方向（无「下游流程 require 上游谓词」）。
跨域边：`base.js → platform/service/*`（合法，向下）。

## E. `this` 隐式耦合消解表

| 旧调用 | 位置 | 手法 | 新形态 |
|---|---|---|---|
| `proxy.js` 调 `this._persist()` | proxy→base | **B（注入）** | `store.persist(accounts)`（store 实例 ctor 注入） |
| `proxy.js` 调 `this.isAccountUsable()` | proxy→base | **A（具名导出）** | `const { isAccountUsable } = require('./base')` |
| `proxy.js` 调 `this.accountQuotaSummary()` | proxy→base | **A** | 同上 |
| `proxy.js` 调 `this.applyDetection()` | proxy→base | **A/C** | 纯化：`applyDetection(acc, det, {events})` |
| `proxy.js` 调 `this._isCreditsLow()` | proxy→base | **A** | 移入 `policies/quota.js` 具名导出 |
| `base.js:307` 调 `this.stopInstance()` | base→proxy | **B（注入钩子）** | ctor 注入 `{ stopInstance }`；**唯一需打破的边** |
| `base.js` 的 `this._persist()` 自调 | base 内 | **B** | 改 `store.persist()` |

⚠ `base.js:247-253` 的 11 个**抽象占位**（抛 'must be implemented by process-pool provider'）
   **保留** —— 它们是**合法契约声明**，且可被静态校验（D11 的 DG-4d）。

## F. 迁移步骤

| 步 | 动作 | 影响文件 | 验证 |
|---|---|---|---|
| 1 | 建 `policies/quota.js`，迁 B3+B6（纯，零行为变更） | 新文件 | `node --check` + 纯函数单测 |
| 2 | 建 `policies/freeze.js`，迁 B4 | 新文件 | `provider-gateway-gate-test` |
| 3 | 建 `model.js`，迁 B2 序列化形状 | 新文件 | `router-test` |
| 4 | 建 `store.js`，迁 B8（含原子写 + 锁） | 新文件 | `round13-robustness-batch-test` |
| 5 | 建 `command.js`（B9，纯） | 新文件 | `p2p-router-test` |
| 6 | `base.js` 瘦身至 ≤200（仅 B1+B5+B7） | base.js | `provider-gateway-gate-test` |
| 7 | 建 `pool.js`（B12）+ `restart.js`（B13） | 新文件 | `router-test` |
| 8 | `proxy.js` 瘦身至 ≤330；`base.js:307` 改注入钩子 | proxy.js | 全 router 测试 |

⚠ 步 8 是**唯一行为敏感步**（注入钩子）；其余为纯搬迁。

## G. 风险与取舍

### G.1 破坏性改动（点名消费方）
- `base.js` / `proxy.js` 的 **导出面**（`ProxyProvider`/`BaseProvider` 类）**必须保持**；
  消费方：`router/index.js`、`router-ops.js`、`forward-core.js`；
- `_persist()` 若改为 `store.persist()`，需保留 `this._persist()` 薄委托（**测试可能调它**）。

### G.2 不做的部分（避免过度设计）
- **不重构 `extends` 继承**（16 处上溯是合法 OOP，D11 已裁决豁免）；
- **不把 `base.js:247-253` 的抽象占位改成 TS interface**（纯 JS 项目，抛出式契约已可静态校验）；
- **不拆 `direct.js`**（已足够小）。

## H. 门禁建议

| 编号 | 判据 | 反向自检 |
|---|---|---|
| PG-D2-1 | `providers/**` 单文件 ≤400 | 构造 401 行样本必须 FAIL |
| PG-D2-2 | `providers/**` 无 `this.X()` 跨文件私调（**排除 extends / 抽象占位**） | 构造变量形式样本必须命中 |
| PG-D2-3 | 纯模块（`policies/*`、`model.js`、`command.js`、`pool.js`）不得 require `node:fs`/`node:net`/`node:child_process` | 构造样本 |
| PG-D2-4 | `base.js` 不得出现 `if (this.kind === 'proxy')` 之外的 proxy 专属逻辑 | — |
| PG-D2-5（R6） | mixin 判据 `/Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/`，**先剥注释** | 含变量右值样本 |

## I. DF 自检

| 判据 | 现状 | 设计后 |
|---|---|---|
| DF-1 门面 | 本目录无门面 | — |
| DF-2 ≤400 | ❌ 1111/777 | ✅ 最大 330 |
| DF-3 纯/IO 分离 | ❌ | ✅ |
| DF-4 零隐式 this | ✅ 已达标（实测 0 违规） | ✅ |
| DF-5 DAG | ✅ | ✅ |
| DF-6 可独立单测 | ❌（策略混在基类） | ✅ policies/model 可单测 |
| DF-7 单向 | ✅ | ✅ |
