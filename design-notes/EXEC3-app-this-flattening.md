# EXEC3-app-this-flattening —— 批 9：app 跨文件 `this` 扁平依赖消除

> 范围（R3-E 独占）：`src/app/**` **除 `src/app/native/**`（R3-A）**。
> 依据：`EXECUTION-CONTRACT.md` §1/§4/§5、`DOMAIN-STRUCTURE-DESIGN.md` §5.6 / §6 R1/R7/R8。
> 纪律：未启动任何守卫/daemon（只用 `require()` + 既有测试的临时目录沙箱）；未 commit；
> 未碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`、已安装包；未改 `package.json`。

## 1. 完成判据达成

| 判据 | 结果 |
|---|---|
| **app 内跨文件 `this.X()` = 0** | **0**（改造前 **235**；扫描口径 = 域结构门禁 DG-4 同款：剥注释 + 方法名跨文件归属） |
| app 内 `this.X()` 总量 | 604 → **295**（余下为文件内自调用与生成式 `_mXxx` 字段 helper，无跨文件归属） |
| 具名协作方调用点 | **243** 处（`this.state.*` / `this.main.*` / `this.daemons.*` / …） |
| 相关测试 | 32 条 app 相关测试 **32/0**；三结构门禁不退化（见 §4） |
| 公共面保真 | `api-surface-test` 12/0、`api-contract-test` 14/0；host 成员集合未变（只增协作方） |
| 产出本文件 | ✔ |

## 2. 实际改动

### 2.1 新增 `src/app/assembly/collaborators.js`（112 行）
把跨文件消费的方法按 **10 个切面** 收敛为具名协作方，并固化一张
`协作方.公开名 → host 既有方法名` 的**显式接口表**：

| 协作方 | 覆盖切面 | 成员数 |
|---|---|--:|
| `state` | F8 State 基座（fields/store/main-record/main-store/desired） | 14 |
| `session` | F2 会话机 | 3 |
| `ctl` | F9-a ctl 客户端 | 5 |
| `daemons` | F5 受管常驻进程 | 15 |
| `control` | F6/F7 控制平面 | 6 |
| `main` | F3/F4 主收敛与元数据 | 19 |
| `views` | F9-b 只读视图门面 | 5 |
| `audit` / `ui` | 低频自检 / 通知 | 1 / 1 |

`installCollaborators(host, { validate })` 把协作方落到 host 实例；
`{ validate: true }`（生产装配路径）先跑 `assertCollaboratorTargets` —— 接口表任一项指向
不存在的方法即**装配期抛错**，防接口表腐化。

### 2.2 `src/app/assembly/facets.js`（122 → 127 行）
在 40 个切面装毕后调用 `installCollaborators(host, { validate: true })`
（协作方是对既有切面方法的薄委托，故必须在全部成员装毕之后）。

### 2.3 24 个消费文件：`this._mPhase()` → `this.state.phase()`（共 242 处机械替换）
替换规则（codemod，剥注释后判定）：**仅当被调方法在本文件未定义**（真跨文件）时替换；
本文件自调用保持原样（保护 `daemons/process.js`/`control/entry.js` 等 class 内部调用）。

按替换量：`main/controller` 53、`main/process` 45、`state/fields` 30、`daemons/supervise` 19、
`daemons/runtime` 14、`domain-actions/router` 11、`audit/orphan-scan` 7、`control/scheduler` 7、
`domain-actions/lan` 6、`domain-actions/main` 6、`state/store` 6、`control/specs` 5、
`control/instance-adapter` 4、`control/projection` 4、`facade/lan` 4、`main/shadow` 4、
`facade/router` 3、`main/decide` 3、`main/health-gate` 3、`daemons/probe` 2、`facade/main` 2、
`settings/access` 2、`ctl/facades` 1、`settings/env` 1。

### 2.4 同步改指向的测试（6 个，均为「断言钉在源码内容上」的门禁）
| 测试 | 改动 |
|---|---|
| `test/daemon-path-test.js` | 手工 ctx 加 `installCollaborators(ctx)`（`ctl.routerPort` 委托到 `_routerCtlPort`） |
| `test/round13-router-relay-gaps-test.js` | 手工 host 加 `installCollaborators`；源码指针 `this._writeDshMain(meta)` → `this.state.writeMainMeta(meta)` |
| `test/round13-robustness-batch-test.js` | ctl 调用形态指针 → `this.ctl.call(this.ctl.routerPort(), 'domainSummary', …)` |
| `test/probe-gate-and-ownership-test.js` | 兜底调用指针 → `this.daemons.disableRouterPersist()` |
| `test/adopt-token-reclaim-test.js` | phase switch 定位键 `this._mPhase()` → `this.state.phase()`（含反向样本） |
| `test/guard-domain-model-gate-test.js` | lan 分支入口定位 → 兼容 `this.daemons.enabled()` |

## 3. 与原设计的偏差（如实）

1. **级 2 未走完**：协作方当前是**薄委托**（`host[既有方法]`），单一实现仍在各切面模块；
   尚未把模块改为 ctor 工厂 + `deps` 入参。本步交付的是「消除跨文件裸 `this` +
   把 10 个切面公共接口固化成表」；真正的依赖注入需后续批（届时应把 host 只留兼容外壳）。
2. **4 个 app 文件仍 >300 行（本轮 DF-2 严值）**：`assembly/compose.js(375)`、
   `control/registry.js(355)`、`daemons/process.js(353)`、`main/process.js(311)`。
   本轮聚焦 `this` 扁平化，未做行数再切分；`app/native/installer.js(806)` 归 R3-A。
3. **`state/fields.js` 的 46 helper**：按授权保留为 host 薄委托（`_mXxx`），未逐一改为
   `state.xxx()`；协作方表已覆盖高频原语（phase/desired/field/procField/store/dshEntry）。
4. **app 不在域门禁覆盖内**：`domain-structure-gate` 的 DOMAINS 仅扫 `src/domains/*`，
   **DG-4 计的是 router（当前 4 处），app 改动不会使其变化**；本文件的 0 系自建同口径扫描。

## 4. 验证

- 三结构门禁：`layering` 10/0；`directory-structure-gate` 16 passed/0 hard；
  `domain-structure-gate` 54 passed/0 soft-except-RED。
- app 相关 32 条测试全部 exit 0（含 smoke、session-lifecycle、lifecycle-mirror、
  heartbeat-selfheal、managed-registry、daemon-lifecycle、adopt-token-reclaim、api-surface/contract…）。
- `node --check` 全部改动文件通过；`require('./src/app/assembly/collaborators')` 加载通过。

### ⚠ 需主代理裁决的两条环境项（**非本轮引入**）
- `domain-structure-gate-test` 现有 **HARD 失败**：`DG-2 反向：真实超限 ≥1（非空转）count=0`。
  因其他代理已把 platform 的超 400 行文件全部修掉，门禁「反空转」自检恒假。
  归 **R3-J**（该测试独占）；与 app 改动无关（app 最大文件 375 ≤ 400）。
- `smoke.js` 在与其他测试**同批次连续运行**时偶发 2 项 FAIL（daemon 未达 RUNNING）；
  单独运行连续 2 次均 **34/0**，判定为固定端口 3900/3901 的测试间时序占用，非本轮回归。

## 5. 涉及文件清单

新增：`src/app/assembly/collaborators.js`
修改（源码）：`src/app/assembly/facets.js` + §2.3 的 24 个消费文件
修改（测试）：§2.4 的 6 个文件
