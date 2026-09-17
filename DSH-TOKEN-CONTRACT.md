# DSH 令牌契约（DSH-TOKEN-CONTRACT）

> **本文件是「令牌」的唯一事实源（SSOT）**，2026-09-16 立。
> 令牌是内核的**基础组件**（`src/platform/service/token/`），**不是业务域**。

---

## §1 令牌分类（7 类 + 1 个幽灵键）

```js
// src/platform/service/token/kinds.js —— 分类注册表（新增令牌必须在此登记，否则门禁失败）
KINDS = {
  'dsh-main':      { side: 'dsh',        strategy: 'capture+persist', ... },
  'dsh-instance':  { side: 'dsh',        strategy: 'capture+persist', ... },
  'dsh-auth':      { side: 'dsh-derived',strategy: 'exchange',        ... },
  'remote-token':  { side: 'user',       strategy: 'config',          ... },
  'api-access-key':{ side: 'user',       strategy: 'config',          ... },
  'frp-auth':      { side: 'user',       strategy: 'config',          ... },
  'lan-gate':      { side: 'self',       strategy: 'issue+verify',    ... },
}
```

| # | kind | 令牌 | **生成侧** | 我方职责 | 变动时机 | 存储 |
|---|---|---|---|---|---|---|
| 1 | `dsh-main` | 原生 main 会话令牌 | **DSH 进程** | **捕捉 + 持久化 + 跟随** | DSH 每次重启 | 令牌池 + 池文件 |
| 2 | `dsh-instance` | 沙箱实例会话令牌 | **DSH 进程** | 同上（源不同） | 同上 | 令牌池 + 池文件 |
| 3 | `dsh-auth` | 浏览器会话 cookie（`dsh-auth-*`） | DSH 派生（303 换取） | 换取 + 缓存 + 轮换重换 | 跟随 dshToken | relay 内存（不落盘） |
| 4 | `remote-token` | 远程/局域网门卫令牌 | **用户**（UI） | 存储 + 下发 | 用户改动 | **配置存储**（唯一） |
| 5 | `api-access-key` | 出回环访问密钥 | **用户**（config） | 存储 + 校验 | 用户改动 | **配置存储** |
| 6 | `frp-auth` | FRP 认证令牌 | **用户**（UI） | 存储 + 透传 | 用户改动 | **配置存储** |
| 7 | `lan-gate` | `dsh_lan_token` cookie | **我方签发** | 签发 + 校验 | 门卫会话 | 浏览器 |
| — | ~~`lanToken`~~ | **不存在** | — | **必须清除全部引用** | — | — |

### 关键分野（**不得用一套逻辑走全部令牌**）

| 分野 | kinds | 说明 |
|---|---|---|
| **DSH 侧生成** | 1, 2 | 我方**只能捕捉**；链路必须**恒通**；需持久化接管 |
| **派生** | 3 | 由 #1/#2 换得，随其轮换 |
| **用户配置** | 4, 5, 6 | **不是 DSH 令牌**：不捕捉、不进令牌池、不随 DSH 轮换、**不得走 `lan-state.json`** |
| **我方签发** | 7 | 门卫会话 |

---

## §2 铁律

| # | 铁律 |
|---|---|
| **TK-1** | **令牌恒存在**。DSH 侧永远生成并监管令牌；**不存在"令牌不可达"这一状态**——"拿不到"只能是我方捕捉链路的 bug，必须修链路。 |
| **TK-2** | **令牌状态绝不驱动进程生命周期**。凭据维度与进程健康**正交**；任何"令牌缺失 → 重启/杀进程"的逻辑都是错的。 |
| **TK-3** | **分类不统一**。7 类各有策略；禁止用一条逻辑套用全部令牌。 |
| **TK-4** | **单一存储**。令牌池是唯一事实源；消费方**按需读取**，**不得自行缓存**令牌。 |
| **TK-5** | **单一落盘点**。持久化只经 `persist.js`；统一权限（0600）+ 统一脱敏。 |
| **TK-6** | **绝不静默销毁**。持久化超限必须**轮转**，不得 `rmSync` 清空（那是唯一持久链路）。 |
| **TK-7** | **用户配置 ≠ DSH 令牌**。两条通道，互不污染，不共用 `lan-state.json`。 |
| **TK-8** | **变动必须广播**。令牌变更**与失效/清空**都要广播（含 `value=null`）。 |

---

## §3 目标结构

```
src/platform/service/token/  ← 基础组件（分层门禁单元名：src/platform/service）
├── index.js       门面：唯一实例；对外 API（§4 冻结）
├── kinds.js       ★ 分类注册表（§1）
├── pool.js        ★ 令牌池：id → { value, gen, source, at }（含"代"标识）
├── capture.js     ★ 捕捉层（事件驱动）：DSH stdout / DSH journal；
│                    用户配置类**只登记、不捕捉**
├── persist.js     ★ 统一持久化：原子写 + 轮转 + 0600 + 脱敏
├── follow.js      ★ 跟随变动：变更/失效广播
├── exchange.js     dsh-auth 派生令牌换取（§1 exchange 策略）
├── infer.js        源形态 → kind 推断（纯函数；规则由 app 装配期注入）
└── snapshot.js     令牌池快照持久化（纯 IO）
```

**路径不变式**：对外入口为 `require('<...>/platform/service/token')`，解析到 `token/index.js`。
（分层门禁 `unitOf` 取前 3 段 → 单元名为 `src/platform/service`；令牌随 platform/service 一并登记。）

---

## §4 冻结 API（子任务必须共同遵守）

```js
// index.js 导出（保持既有名字，便于渐进迁移）
DshTokenService            // 类：令牌池 + 捕捉
parseDshTokenLine(line)    // 解析 DSH 输出行中的令牌（唯一实现）

// —— 池读取（消费方按需读，禁止缓存）——
pool.get(id)         -> string | null        // 当前令牌值
pool.getRecord(id)   -> { value, gen, source, at } | null   // ★新增：含"代"
pool.list()          -> [{ id, kind, value, gen, source, at }]  // 展示用；**不得**含用户配置类

// —— 源登记（attach）与捕捉 ——
pool.attach(id, { kind, unit, file })   // 登记源；kind 必填（§1）
pool.detach(id)                          // 注销源 + 清令牌（**必须广播 null**）
pool.feedLine(id, line)                  // DSH stdout 行事件（同步命中即入池并广播）
pool.capture(id)                         // 主动捕捉一次（journal 源用）
pool.scheduleCapture(id)                 // 进入 RUNNING 后窗口内退避重试
pool.ensureCaptured(id)                   // 周期兜底（节流）

// —— 变更 ——
pool.clear(id)                           // 清令牌（**必须广播 null**，TK-8）
pool.onChange(fn)                        // fn(id, value|null, record) —— value=null 表示失效/清空
```

**兼容性要求**：`get/onChange/attach/detach/capture/feedLine/scheduleCapture/ensureCaptured/clear`
的名字与返回语义**保持不变**（消费方 `supervisor.js` / `instance` / `relay` / `api` 不需大改）；
`onChange` 的回调**新增第 3 参 record**（向后兼容）。

---

## §5 不变式（可执行断言）

| # | 不变式 |
|---|---|
| TK-1 | `src/` 中不存在把「令牌缺失」当故障并触发重启的代码路径 |
| TK-2 | 令牌池读写**不出现**在 phase 迁移决策（`_decideMainAction`/`_dshConverge` 的 switch）中 |
| TK-3 | `kinds.js` 登记全部令牌类型；新增未登记 → 门禁失败 |
| TK-4 | 除 `src/platform/service/token/**` 外，无模块持有令牌成员字段（`dshToken` 等） |
| TK-5 | 令牌持久化仅经 `persist.js`；落盘权限一律 0600 |
| TK-6 | 持久化无 `rmSync` 清空语义（必须轮转） |
| TK-7 | 用户配置类（remote-token/api-access-key/frp-auth）**不出现**在 `lan-state.json` 中 |
| TK-8 | `clear/detach` 均触发 `onChange(id, null)` |

---

## §6 门禁（`test/token-contract-gate-test.js`）

| 门禁 | 断言 |
|---|---|
| TK-G1 | `kinds.js` 存在且登记 §1 全部 kind |
| TK-G2 | **令牌不得驱动生命周期**：`src/app/daemons/probe.js`/`src/app/main/controller.js` 中无 `_maybeReclaimAdoptToken`，且 phase switch 内不读令牌池 |
| TK-G3 | **无静默销毁**：`persist.js` 不含清空式 `rmSync` |
| TK-G4 | **用户配置类不进 `lan-state.json`**：`src/app/daemons/runtime.js#_syncLanState` 写出的 `tokens` 段只含 `dsh-*` |
| TK-G5 | **单实例令牌获取**：除 token 组件外无 `this.dshToken` 式缓存（relay 改为按需读） |
| TK-G6 | **令牌不进 argv/URL**：`browser.js` 调用点不得拼 `?token=` |
| TK-G7 | 幽灵键 `lanToken` 在 `src/` 中零引用 |
| TK-G8 | 反向：判据能识别旧形态（门禁非空转） |
