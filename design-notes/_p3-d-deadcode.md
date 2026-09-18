# P3-D 死代码收尾报告

作业单：`design-notes/_workorder-phase3.md` §6。范围（4 文件，文件独占）：
`src/domains/router/instances/proxy-instance.js`、`src/domains/router/index.js`、
`src/domains/router/ops.js`、`src/domains/instance/upgrade.js`。

全程遵守：未跑任何测试/门禁（仅 `node --check` / `grep` / `read` / `wc`）、无任何 git 写操作、
未改 `test/`、未加依赖、未启 daemon。R1 一律用 `grep -oP '\p{Han}{4,}'`（非 `-E` 区间写法）。

## 0. 分配说明（与 §2「必须再派生 1-3 个下级」的偏离）

本工作流被指派**恰好 4 个文件**，已是文件互斥的最小单元；再切分只会产生跨文件协调成本而无并行收益。
故未派生下级，改为**主控本人对每个删除项做 R2 全仓 grep + R1 反查**（证据见下）。
若需独立复核，建议由 P3-E 的只读复审覆盖本报告的 R2 结论。

## 1. 任务一：删 proxy-instance 过渡 shim —— **已删除**

### 改动
| 文件 | 改动 |
|---|---|
| `src/domains/router/index.js:12` | `require('./instances/proxy-instance')` → `require('./model')` |
| `src/domains/router/instances/proxy-instance.js` | **删除**（1 行 `module.exports = require('../model')`） |
| `src/domains/router/instances/` | **删除空目录**（唯一成员已移除；DS-8「不得为空壳目录」） |

### R2 证据（删前全仓核验）
```
grep -rn "proxy-instance" --exclude-dir=.git --exclude-dir=node_modules .
  src/domains/router/index.js:12:  ← 唯一 require 消费者（已改指 ./model）
  test/provider-gateway-gate-test.js:137: ← 仅**散文注释**，非断言
  src/app/control/entry.js:27:            ← 无关：'proxy-instance' 是 kind 词表枚举值
  src/domains/router/providers/{restart,proxy,probe}.js  ← 无关：`[proxy-instance]` 日志前缀
  design-notes/*.md、HANDOFF.md:148      ← 文档/过程物
```
- `test/` 无任何**读取**该 shim 路径的代码：`PROXY = 'src/domains/router/providers/proxy.js'`
  （`provider-gateway-gate-test.js:42/52`），PG-3 的 `proxySrc` 指 providers/proxy.js，另读 `router/model.js`。
- 无字符串拼接 require、`package.json` 无引用。
- `ProxyInstance` 由 `src/domains/router/model.js:94` 导出（`module.exports = { ProxyInstance, ... }`），
  `providers/proxy.js:9` 早已 `require('../model')` → index.js 改指后解析同一对象。

### 相关门禁静态核验（均不红）
- **DG-7 依赖方向**：index.js(rank 0) → model.js(rank 3)，违反判据 `from.rank > to.rank` = `0 > 3` 假 → 合法。
- **DS-G6 域内子目录白名单**（`directory-structure-gate-test.js:202-210`）：判据只拒绝**不在白名单的子目录**
  （`badDirs`），**不要求白名单目录必须存在** → 删 `instances/` 不红。
- **DS-9 行数**：index.js = 150 行（FACADE_MAX ≤150，未变行数）、ops.js = 162 行（FILE_MAX ≤300）。
- **DR-1 docs-reference**：根级 `*.md` 中无 `src/` 前缀指向该 shim 的路径 → 不红。
- **DG-11 数组穿透**：src 全域仍 0 命中。

### 遗留（不在本工作流文件范围，交主控/P3-B）
1. `DOMAIN-STRUCTURE-DESIGN.md:128` 的目录树仍列 `instances/proxy-instance.js ≤12 re-export shim（过渡）→ 最终删除`
   —— 现应删除该行（该行无 `src/` 前缀，故 DR-1 不会自动检出）。
2. `test/domain-structure-gate-test.js` 的 RANK 表仍有 `'instances': 3`（子目录首段）。
   该键仅用于 `rankOf` 查表，目录消失后成为**空转条目**（零行为影响），可清理；`test/` 不属本工作流。

## 2. 任务二：`releaseProviderPorts` 导出 —— **已删导出键**（函数体保留）

### R2 证据
```
grep -rn "releaseProviderPorts" --exclude-dir=.git --exclude-dir=node_modules .
  src/domains/router/ops.js:6   ← 头注「契约导出」清单
  src/domains/router/ops.js:42  ← 函数定义
  src/domains/router/ops.js:108 ← **内部调用**（removeProvider 内，必须保留函数体）
  src/domains/router/ops.js:162 ← module.exports 键
  HANDOFF.md:147、design-notes/*.md、_workorder-phase3.md  ← 过程物
```
- `src/`（除定义文件自身）、`test/`、`bin/`、`release/`、`ui/` **零消费者**。
- `src/domains/router/contract.js` 的 `PUBLIC_API`（机器校验的域间契约面）**未收录**该名 → 非对外契约。
- 根级 SSOT 文档（`EXECUTION-CONTRACT.md`/`DOMAIN-STRUCTURE-DESIGN.md` 等）**未声明**该导出。

### 改动
| 文件 | 改动 |
|---|---|
| `src/domains/router/ops.js:162` | `module.exports = { createState, createOps, findProvider }`（去 `releaseProviderPorts`） |
| `src/domains/router/ops.js:6` | 头注契约清单同步去除该项（R1：`契约导出` 在 `test/` 0 命中） |

函数体**保留**（`:108` 内部消费）；`createOps` 返回对象**本就未含**该项（`:159`），故无连带改动。

### 更正一条过期审计结论
`design-notes/AUDIT-r5-router-relay-logic.md:46-47` 称「`ops.createOps` **返回对象**里的 `releaseProviderPorts` 包装未被消费」——
实测 `createOps` 返回对象（`ops.js:159`）只含 7 个方法，**不含** `releaseProviderPorts`，该条目**已自然消解**；
本次处理的是**模块级导出**，两者是不同对象。

## 3. 任务三：`upgrade.js` 的 `inst.state.version` —— **保留并登记**（未改）

### 核验结论：写入两处，**全仓零读取**，但**经序列化落盘**
```
grep -rn "state.version" src test bin  →
  src/domains/instance/upgrade.js:156  回滚路径：inst.state.version = readInstalledVersion(inst);
  src/domains/instance/upgrade.js:168  成功路径：inst.state.version = readInstalledVersion(inst);
  （无第三处——无任何读取点）
```
- 视图行的 version **不来自**该字段：`ops.js:19-21` 经 `upgrade.versionInfo(inst)` → `readInstalledVersion(inst)`
  实时读取（`upgrade.js:40-42`），再由 `model.js:60/73` 组装 `viewRow`。故该字段是冗余缓存，且永不被读。
- `model.js` 的 `createRecord`（`:31-56`）声明的 `state` 形状是
  `{ phase, restartCount, backoffLevel, lastProbeOk }` —— **不含 `version`**，即该字段并非记录契约的一部分。
- 无 `...inst.state` 展开、无 API 响应直接回传原始 `state`、无测试断言该字段（`test/` 中 `state.version` 0 命中）。

### 为何仍保留
`store.js:55` 以 `JSON.stringify({ instances: this.instances })` **整对象落盘**，故该字段会写进
`instances.json`。作业单 §6.3 明确：「若发现其实有读取（如经序列化），**保留并登记**」。
且该文件被**仓外**桌面壳读取的可能无法在本仓证伪（壳仓不在本工作区）——
按 R2「宁可保留」，**不在死代码工作流里做持久化文档形状的静默变更**。

### 建议（交主控决策，非本工作流擅动）
若确认要清除，应作为**显式契约变更**处理：删除两处赋值 + 在 `DOMAIN-STRUCTURE-DESIGN`/记录形状处说明
`instances.json` 不再出现 `state.version`，并确认壳仓不依赖该字段。**不建议**把它改为「被读取的字段」
（视图现已实时读盘，改缓存会引入陈旧值风险）。

## 4. `node --check`
```
node --check src/domains/router/index.js  → exit 0
node --check src/domains/router/ops.js    → exit 0
```
（`upgrade.js` 未改，无需检查；删除的 shim 为 1 行纯 re-export。）

## 5. CI 风险点
- 低。改动为「1 处 require 改指 + 1 个导出键删除 + 1 个 1 行 shim 删除」。
- 已静态排除：DG-7 rank、DS-G6 白名单、DS-9 行数（index.js 恰好 150 ≤150，未变）、DR-1 文档引用、DG-11 穿透。
- 唯一需观察项：若存在本仓不可见的动态消费者（如壳仓直接 `require` 该 shim 路径或 ops 导出）——
  但 shim 属域内实现文件、非包入口，且根级 SSOT 未把它列为契约面。
- 最终以 CI 四平台裁决；本报告不作验收结论。
