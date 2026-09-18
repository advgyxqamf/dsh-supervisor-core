# EXEC · 文档与登记同步（域内结构归一化）

> **范围**：文档与登记同步。**不改 `src/` 逻辑，不改域内测试**。
> **依据**：`EXECUTION-CONTRACT.md`（接口冻结书）+ `DOMAIN-STRUCTURE-DESIGN.md`（域内 SSOT）。
> **本子代理文件归属**：`DIRECTORY-STRUCTURE-DESIGN.md` / `README.md` / `DOMAIN-STRUCTURE-DESIGN.md` 状态行 /
> `DEVELOPMENT-TRACK.md` / `test/layering-and-dependency-gate-test.js`（仅 CROSS_LAYER）/ 本记录。

## 1. 实际改动

| 文件 | 改动 |
|---|---|
| `DIRECTORY-STRUCTURE-DESIGN.md` | **DS-9 取严**：单文件 ≤450→**≤400**、`index.js` ≤200→**≤150**（§4.5 硬规则 + §5.1 不变量表 + 新增「取严（R3/R11）」说明）；**§5.2 DS-G3 补禁 `Object.assign(X.prototype, ...)`**（右值不限：内联 require / 变量 / 分片 `mod.methods` 一律硬失败；须先剥注释） |
| `README.md` | 文档索引**登记 `EXECUTION-CONTRACT.md`**（`standards-uniqueness-test` U-4 要求根级 md 全部登记）；`DOMAIN-STRUCTURE-DESIGN.md` 条目追注**状态：执行中** |
| `DOMAIN-STRUCTURE-DESIGN.md` | 头部状态行 `v1 定版` → **`执行中`**（2026-09-17 起，12+ 子代理并行，批 0–10）——与 README 条目一致 |
| `DEVELOPMENT-TRACK.md` | 追加 **§8 域内结构归一化阶段记录**：规则来源 / DF-1..DF-7 / 12+ 子代理并行与批 0–10 / 登记维护清单 / 本轮验证门禁 |
| `test/layering-and-dependency-gate-test.js` | **未改** —— 实跑 L-1/L-2/L-2b/L-2c 全绿，无未登记边、无死条目；按契约不得预登记（见 §3） |

## 2. 门禁实跑结果

| 门禁 | 改动前 | 改动后 |
|---|---|---|
| `standards-uniqueness-test.js` | **7/8 — U-4 FAIL**（`EXECUTION-CONTRACT.md` 未登记） | **8/8 PASS** |
| `test-chain-completeness-test.js` | 10/10 PASS | 10/10 PASS |
| `layering-and-dependency-gate-test.js` | 10/10 PASS | 10/10 PASS |
| `directory-structure-gate-test.js` | 12/12 PASS | 12/12 PASS |
| `no-dev-path-test.js` | 8/8 PASS | 8/8 PASS |
| `no-cross-repo-test.js` | 8/8 PASS | 8/8 PASS |

> 运行方式：`node --require ./test/_preload.js test/<file>`（未启动任何守卫/daemon）。

## 3. CROSS_LAYER 复核结论（任务 3）

- **实测**：全 `src/` 跨层边 **186 条**（含工作区未提交的域重构），**全部已登记**；L-2b **无死条目**；L-1 platform 无上层入边。
- **结论：不新增任何 `CROSS_LAYER` 条目。** 域改造**只在同层内搬文件**，理论上不新增跨层边。
- 若提前登记 `app/domain-actions` 一类尚**未被引用**的单元，会立刻触发 **L-2b「死条目」失败**，
  且违反任务约束「补登记必须基于实跑报错，不得凭猜测」——**预登记 = 放宽/注水判据**，故不做。
- **无真违规边**：未见 `domains→app` / `domains→api` / `platform→上层` 等越层边（否则 L-1/L-2 会红）。
- 后续：域改造继续落盘后**再跑一次本门禁**；一旦出现 L-2 未登记边，按报错**逐条**补登记并写理由。

## 4. 与原设计的偏差（如实）

1. **额外对齐了 `DS-7`**：原文只禁 `Object.defineProperties(X.prototype, require(...))`，与 §5.2 新 DS-G3（两种手法、右值不限）自相矛盾。本记录同步改为「`defineProperties` **与** `assign` 均禁」。任务只点名 DS-9 / DS-G3；若主代理判定超范围，可单独回退该行。
2. README「状态」以**附加句**表达（保留 `唯一事实源` 标记以过 U-2），并同时在 SSOT 头部落状态，避免两处漂移。
3. `DEVELOPMENT-TRACK.md §8` 是本轮**追补的阶段记录**，不是 SSOT §7 迁移表的复制（判据与批表按域内 SSOT 摘要）。

## 5. 遗留 / 交接（★ 重要）

1. **文档严于门禁的差口（须门禁属主同步）**：`test/directory-structure-gate-test.js` 当前 DS-G3 只匹配
   `Object.defineProperties(\s*\w+\.prototype\s*,\s*require\(`（**内联 require、窄右值**）。
   文档 §5.2 已要求 DS-G3 **同时硬失败 `Object.assign(X.prototype, ...)`、右值不限、先剥注释、反向自检含变量样本**（R6）。
   该文件**不在本子代理文件归属内，未改**；须由门禁属主同步，否则形成新的静默失效面。
2. **`test/domain-structure-gate-test.js` 尚未存在**（批 0 未落地）：DG-8 三件套
   （`MIXIN_INTO_PROTOTYPE` 硬失败 + 两个 `METHODS_FRAGMENT` 告警 + 剥注释 + 反向自检）需要它承载。
3. **DS-G7 的 `src/supervisor.js ≤200` 未动**：它不是 DS-9 的「门面」阈值（DS-9 只管域内 `index.js`），按任务保留。
4. `standards-uniqueness` U-4 的根级 md 清单现为 **20 份全部已登记**；后续新增根级 md 必须同步 README，否则该门禁会红。
