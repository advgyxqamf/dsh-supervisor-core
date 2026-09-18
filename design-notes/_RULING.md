# 主代理裁决（R1–R5）—— 2026-09-16，**对所有设计子代理生效**

> 设计过程中 D3/D5 发现了与 BRIEF §0 不符的**实测事实**。以下裁决**覆盖** BRIEF 的相应表述。
> 所有设计文档必须按本裁决修正（已完成的也要补正）。

## R1 §0 更正：router 域 **require 图 0 环**

**实测**（剥注释 + Tarjan SCC）：router 域内 27 条 require 边、**0 个环**；五域全部 0 环。
BRIEF §0 所称 index.js ↔ forward-core.js **不成立**（forward-core 全文零处 require ./index）。

**真实病症是 this 调用图的环**（this 图实测 3 个 SCC）：
- {index.js, forward-core.js, router-ops.js} —— 成因：index.js:758-759 的
  `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)`
  把方法集注入同一 this；方法体反向调 this.readBody()/this.log()/this.canPersist()/this.getProvider()/this._save()；
- {providers/base.js, providers/proxy.js} —— 因 extends + base.js:307 调只在 proxy.js 定义的 this.stopInstance()。
实测 **18 方法 / 48 处**跨文件 this 私调（BRIEF 原写 16 条，以实测为准）。

**由此得出 DF-5 的正确含义**：不是「修 require 环」，而是
**禁止把两个文件的方法合并到同一个 this 上**（Object.assign(X.prototype, require(...))）。
否则改名后 require 图仍是 DAG，而 DF-4/DF-6 依旧被违反 —— 那正是 BRIEF §2 所斥的「文件搬家」。

**取证陷阱**：daemon.js 注释里的 require('.../router/daemon') 是说明文字，
朴素扫描会伪造出「daemon 自环」。**扫描必须先剥注释**（否则会得出错误结论）。

## R2 目录白名单裁决：**放宽 DS-G6**，采纳 BRIEF §4 全集

**冲突**：BRIEF §4 允许 core/ops/store/scheduler/policies/model/handlers 等子目录，
但门禁 test/directory-structure-gate-test.js:170 的 ALLOWED = {providers, instances} 会判违规。

**裁决**：采纳 BRIEF §4（**放宽门禁**）。理由：
- 旧白名单是上一轮「域内未拆分」状态下的**临时约束**（当时确实只有这两个子目录）；
- 本轮目标正是域内分层 —— 若不放宽，6 个域的设计会全部撞门禁。

**新 ALLOWED（统一）**：providers instances policies model store handlers core jobs。
**设计时优先用扁平文件**（core.js/ops.js/store.js/scheduler.js/model.js）；
仅在**确有多个同类文件**时才建子目录（避免过度碎片化）。

## R3 阈值裁决：**取严值**

| 判据 | BRIEF §1 | 旧 SSOT DS-9 | **裁决** |
|---|---|---|---|
| 门面 index.js | ≤150 行 | ≤200 行 | **≤150 行** |
| 单文件 | ≤400 行 | ≤450 行 | **≤400 行** |

理由：旧 SSOT 行数是「未拆分」时的宽松值；本轮既是真正拆分，取严值。
（DS-9 将在合并时同步更新为严值。）

## R4 DS-G3 补判据：**必须同时禁止 Object.assign 形态**

**漏洞**：test/directory-structure-gate-test.js:122 只匹配
Object.defineProperties(X.prototype, require(...))，**漏掉**
Object.assign(X.prototype, require(...)) —— 正是 router/index.js:758-759 用的形态。

**裁决**：H 节（门禁建议）**必须**包含以下判据（写进 test/domain-structure-gate-test.js）：

    /Object\.(defineProperties|assign)\(\s*\w+\.prototype\s*,\s*require\(/

并附**反向自检**（构造样本验证判据能命中）。

## R5 只读裁决：**daemon.js 的 basename 不得改**

router/daemon.js、relay/daemon.js 的**文件名必须保持 daemon.js** —— 有 5 处 cmdline 匹配依赖它：
src/app/daemons/probe.js:27、src/app/daemons/process.js:85、
test/round8-fixes-test.js:88,131,134。
改名会**打断生产 daemon 探活**。

## 附：其他硬约束（重申）
1. **禁止启动任何守卫进程**（guard.lock 取自产品状态根，临时配置不能隔离）；
2. 只写设计，不改 src/；
3. 所有行号来自实际 read；
4. 产出到 design-notes/<主题>.md。
## R6 **修正 R4**（D10 实测发现：原正则假阴性）

**问题**：R4 的正则 `/Object\.(defineProperties|assign)\(\s*\w+\.prototype\s*,\s*require\(/`
要求**右值是内联 require** —— 但现实有两种形态：

| 文件 | 代码 | R4 原正则 | 说明 |
|---|---|---|---|
| `src/domains/router/index.js:758` | `Object.assign(RouterService.prototype, require('./forward-core').forwardMethods)` | ✅ 命中 | 内联 require |
| `src/supervisor.js:160` | `Object.assign(Supervisor.prototype, mod.methods)` | ❌ **漏掉** | 右值是变量 |

且 `supervisor.js` 里**唯一**被 R4 命中的是第 21 行**注释**（`// 这取代了旧的 Object.defineProperties(X.prototype, require(...))`）
—— 即 **R4 会在 supervisor.js 上假阳性/假阴性同时发生**。

**裁决（R6）**：判据替换为**三条组合**（缺一不可），且**必须先剥注释**：

```js
// ① 任何把「外部方法集」挂到原型上的手法（右值不限，变量/内联都要抓）
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
// ② 分片导出形态（module.exports = { methods: ... }）
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
// ③ 反向自检：必须验证判据能命中「变量右值」与「内联 require」两种样本
```

⚠ **必须先剥注释再判**（否则会命中说明文字，D10 已实测）。
⚠ 反向自检**必须包含** `Object.assign(X.prototype, mod.methods)` 这个样本。

## R7 裁决：**facade 的写动作属业务**，须下沉

**问题（D10 实测）**：`app/facade/*.js` 里混了只读视图与**写动作**：
- `facade/router.js` → `setRouterRunning`
- `facade/main.js` → `patchDshMain`
- `facade/lan.js` → `setLanFrp` 等

**裁决**：门面（facade）**只允许只读视图**；写动作（改变系统状态）属业务，
应下沉到 `app/domain-actions/`（或各域自己的 ops）。
理由：门面若可写，则「api → 门面 → 直接改状态」绕过了生命周期/目录/事件记账。

**但**：本裁决只约束 **app/facade/**；各域内部的 `ops.js` 不受影响。
## R8–R11 裁决（D11 提出，主代理定版）

### R8：`app/domain-actions/` 的层归属 —— **建为 app 子目录**

**裁决**：新建 **`src/app/domain-actions/`**（app 层），**不并入各域 ops**。

理由：
- R7 的语义是「**门面只读**」——写动作若并入各域 ops，则 `api → facade(只读) → ???` 就没有承接者；
- 写动作需要**跨域编排**（如 `setRouterRunning` 同时改 config + 持久化 + 生命周期镜像），
  放进任何单一域都会造成域间依赖；
- 放 app 层符合 DS-3（app 可依赖 domains）。

**代价（如实）**：`api/deps.js:82` 等注入表需同步（属「登记表更新」，非放宽）。

### R9：`api/deps.js` —— **本轮只声明，不接线运行期校验**

**裁决**：`api/deps.js` 保持「只声明」状态；**本轮不引入运行期强制校验**。

理由：
- 其自述即「只声明不强制」；
- 与 R7 的下沉**并行推进**时，若现在强制校验，会把「尚未迁移」的中间态全部打红；
- 待域拆分落地后，另起一轮专项收紧。

### R10：`test/directory-structure-gate-test.js:170` 的 ALLOWED —— **本轮同步改为 R2 白名单**

**裁决**：**同步改**。新 `ALLOWED = new Set(['providers','instances','policies','model','store','handlers','core','jobs'])`。

理由：不放宽则 6 个域的设计全部撞门禁（`policies/`/`model/` 会判违规）。
这与 R2 一致，**不是**为了变绿而放宽——是因为「域内分层」正是本轮目标。

### R11：阈值文档同步 —— **DS-9 改为严值**

**裁决**：`DIRECTORY-STRUCTURE-DESIGN.md` 的 DS-9 更新为
**门面 ≤150 行 / 单文件 ≤400 行**（与 BRIEF §1、R3 一致）。

### 附带裁决 R12：**D10 发现的 R6 补强，采纳**

D10 实测：`METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/`
**漏掉 UMD 简写** `module.exports = { methods, accessors, ... }`，
而 `src/app/state/fields.js:200-206` 正是简写（**46 个生成器 helper 的载体，最大单点**）。

**裁决**：门禁 ② 改为**两条并用**：
```js
const METHODS_FRAGMENT       = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
const METHODS_FRAGMENT_SHORT = /module\.exports\s*=\s*\{[\s\S]{0,200}?\bmethods\b\s*[,:}]/;
```
反向自检**必须**含简写样本。⚠ 但 ② **只作告警**（全域 30 个文件命中），**硬失败只用 ①**。
