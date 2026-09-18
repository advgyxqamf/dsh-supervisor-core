# EXEC4 · 将 DF-8 / DF-9 接入门禁为 DG-15 / DG-16

> 收口任务：`test/domain-structure-gate-test.js` 原实现 **DG-1..DG-14**，
> 本轮把 **DF-8（require 必须顶层）/ DF-9（函数嵌套 ≤6）** 接入为 **DG-15 / DG-16**，
> 使 `DOMAIN-STRUCTURE-DESIGN.md` 声称的 DF-1..DF-9 与门禁实现一致。
> 实现**直接采用** `design-notes/EXEC3-df8-df9-scan.md` **§1** 的零第三方依赖方案；
> **未用 acorn/espree，未新增任何依赖，未启动任何 guard/daemon 进程。**

## 0. 结论速览

| 项 | 结果 |
|---|---|
| DG-15（DF-8）函数体内内联 `require()` | **PASS / 0 处**（全仓仅 `src/supervisor.js` 的 `get lan()` 1 处，显式白名单豁免） |
| DG-16（DF-9）函数嵌套深度 ≤6 | **PASS / 0 处超限**（256 文件；实测最大 **5**，位于 `src/domains/instance/upgrade.js` 等） |
| `DG_STRICT=1` 域结构门禁 | **exit 0**（76 passed, 0 failed(hard), 0 failed(soft)） |
| 接入前基线 | 64 passed（无 DG-15/16） |
| 新增 | 2 条 judge + 10 条 selfcheck = 12 条 |
| `package.json` dependencies | **仍为 `{}`**（T6-a 零运行时依赖 PASS） |

## 1. 判据实现（复用既有基建，不另建扫描器）

门禁既有 `strip()` 已剥注释（字符串整体跳过，保留换行、行号不漂移），
故 DG-15/16 **直接消费 `ENTRIES[].src`（已 strip）**，仅在需要「函数体花括号」时引入
`functionBodyBraces(src)`。新增两个**纯函数**（放在既有纯函数区，与反向自检共用同一函数）：

- `functionBodyBraces(src)` —— 标出三类「函数体开括号 `{`」：
  ① `function` 关键字（跳到形参右括号后首个 `{`）；
  ② 箭头函数块体（`=>` 后首个 `{`）；
  ③ 方法简写 / class 方法 / getter / setter（排除 `if/for/while/switch/catch` 等控制关键字）。
- `functionScan(src)` —— 一次遍历同时求：
  - `inlineRequires`：`require(` 落在**任一函数体花括号仍打开**时记违规（行号仅作证据）；
  - `maxFn`：当前打开的**函数体**花括号数最大值。

**关键设计（防假阳性）**：DF-8 **不能**用朴素「花括号深度 > 0」——
顶层对象/数组字面量（`FACETS` 数组、`module.exports = { ... }`）会把顶层
`require` 计成「函数内」而误报。DF-9 亦**不以原始 `{}` 净值**计（`oauth.js` 净值 13
但函数深度仅 4），只用**函数体**括号计，与处置手段「把深层回调提为具名函数」一致。

**显式白名单（不得放宽为「任意文件豁免」）**：

```js
// ENTRIES.rel 相对 src/，故 key 为 supervisor.js；repoPath 仅作证据显示
const INLINE_REQUIRE_ALLOW = new Map([
  ['supervisor.js', { repoPath: 'src/supervisor.js', max: 1, site: 'get lan()',
    reason: '有意的惰性 require：daemon 模式结构性排除，relay 域经 app 层装配' }],
]);
```

- 白名单**逐文件、唯一**，且带 `max` 条数上限：`src/supervisor.js` 若被塞入更多内联
  `require` 会被判违规；其它任何文件一律不豁免。
- 源文件 `src/supervisor.js:35-44` 自带同款注释，白名单与源码注释互为出处。

## 2. 反向自检（每条判据：命中 + 边界 + 顶层对象字面量不误报）

### DG-15（DF-8）
| 自检 | 样本 | 期望 | 实测 |
|---|---|---|---|
| 命中 | `function a() { const x = require("./y"); return x; }` | 1 | **PASS hit** |
| 边界不命中 | `const x = require("./y");`（模块顶层） | 0 | **PASS miss** |
| 顶层对象字面量不误报 | `module.exports = { x: require("./y") };` | 0 | **PASS miss** |
| 非空转 | 方法体 + 箭头**块体**各 1 处 `require` | 2 | **PASS hit=2** |
| 白名单显式唯一 | `Map.size === 1` 且 key `supervisor.js` / `repoPath === 'src/supervisor.js'` | true | **PASS** |
| 白名单非腐化 | 真实源码内联 `inlineTotal >= 1` 且扫描集非空 | true | **PASS inlineTotal=1 files=256** |

### DG-16（DF-9）
| 自检 | 样本 | 期望 | 实测 |
|---|---|---|---|
| 命中 | 7 层块体箭头嵌套 `const f0=()=>{...}` | maxFn=7 | **PASS hit=7** |
| 边界不命中 | 6 层块体箭头嵌套 | maxFn=6 | **PASS miss=6** |
| 顶层对象字面量不误报 | `module.exports = { a: { b: { c: { d: 1 } } } };` | maxFn=0 | **PASS maxFn=0** |
| 非空转 | `class A { m() { new Promise((res) => { res(() => {}); }) } }` | maxFn=3 | **PASS hit=3** |

### 既有判据未放宽
未改动任何 DG-1..DG-14 的判据本体、阈值、豁免表或执行分支；
仅在文件头补 DG-15/16 行、新增纯函数与新增执行块。DG_STRICT=1 全量 76 passed / 0 hard。

## 3. 测试结果（全部命令）

```
DG_STRICT=1 node --require ./test/_preload.js test/domain-structure-gate-test.js
  -> PASS DG-15 require() 必须在模块顶层（函数体内 0 处；唯一白名单 src/supervisor.js）
     <- ok（256 文件；内联 1 处，均落入白名单 src/supervisor.js）
  -> PASS DG-16 函数（回调/闭包）嵌套深度 ≤6  <- ok（256 文件；实测最大 5）
  -> 结果: 76 passed, 0 failed(hard), 0 failed(soft/report-only)   EXIT=0

node --require ./test/_preload.js test/layering-and-dependency-gate-test.js
  -> 10 passed, 0 failed                                          EXIT=0（未退化）

GATE_STRICT=1 node --require ./test/_preload.js test/directory-structure-gate-test.js
  -> 19 passed, 0 failed(hard), 0 failed(soft)                    EXIT=0

node --require ./test/_preload.js test/standards-uniqueness-test.js
  -> 8 passed, 0 failed                                           EXIT=0

node --require ./test/_preload.js test/test-chain-completeness-test.js
  -> 10 passed, 0 failed                                          EXIT=0

node --require ./test/_preload.js test/all-platforms-test.js
  -> PASS T6-a 内核零运行时依赖（无原生模块风险）  <- []
  -> 结果: 34 passed, 0 failed                                    EXIT=0
```

## 4. 文档更新

- `test/domain-structure-gate-test.js` 文件头判据清单由 `DG-1..DG-14` 更新为
  **`DG-1..DG-16`**，并补 DG-15/16 两行说明。
- `DOMAIN-STRUCTURE-DESIGN.md` **§9「门禁清单」**表补两行（仅加行，未改既有行语义）：

  ```
  | DG-15 | 函数体内无内联 require()（先剥注释；唯一显式白名单 src/supervisor.js 的 get lan()） | DF-8 |
  | DG-16 | 函数（回调/闭包）嵌套深度 ≤6（按函数体花括号计数，非原始净值） | DF-9 |
  ```

  > **偏差说明（如实报告）**：任务书写「§8 门禁表」，但本仓
  > `DOMAIN-STRUCTURE-DESIGN.md` 的 **§8 是「迁移时必须同步改的既有门禁」**
  > （列为测试文件/断言对象，无 DG 编号），真正的 DG 门禁表在 **§9「门禁清单」**。
  > 故 DG-15/16 行加在 §9；未改动 §8 既有内容（符合「只加行」）。

## 5. 约束遵守

- 未使用 acorn/espree；判据只依赖 `node:fs`/`node:path`；
- `package.json` 的 `dependencies`/`devDependencies` **仍为空 `{}`**（未加任何包）；
- **未启动任何 guard/daemon 进程**；门禁仅 `require()` + 纯函数/假依赖；
- 未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；未 commit。
