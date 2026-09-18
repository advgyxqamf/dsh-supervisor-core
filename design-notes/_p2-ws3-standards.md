# WS3 报告：规范/文档/门禁收敛与悬空引用（第二阶段）

> 作业单：design-notes/_workorder-phase2.md。WS3 负责人报告。
> 约束遵守：**未运行任何测试/门禁**（只 node --check / grep / read / wc / git 只读）；**无任何 git 写操作**；
> 未启动守卫/daemon；未碰 /tmp/dsh-* 与状态目录；未加依赖；**未改任何 src/** 文件。

---

## 0. 下级分配（文件独占，互斥无遗漏）

| 下级 | 独占文件 | 状态 |
|---|---|---|
| ws3-docs（9798b189） | EXECUTION-CONTRACT.md、DOMAIN-STRUCTURE-DESIGN.md、NO-CONSOLE-WINDOW-STANDARD.md | 完成 |
| ws3-refs（3b0f273f） | GUARD-DOMAIN-MODEL.md、KERNEL-DAEMON-CONTRACT.md、DIRECTORY-STRUCTURE-DESIGN.md、README.md:317、PLATFORM-CAPABILITY-MATRIX.md:95、两个测试文件头注 | 完成 |
| 本人（门禁与测试类） | test/directory-structure-gate-test.js、test/docs-reference-gate-test.js（新增）、test/test-chain-completeness-test.js、package.json#scripts.test、DEVELOPMENT-TRACK.md、test/domain-structure-gate-test.js（主控单独授权） | 完成 |

报告：_p2-ws3-docs.md、_p2-ws3-refs.md、本文件。

---

## 1. 改动清单（每文件一行理由）

| 文件 | 理由 |
|---|---|
| EXECUTION-CONTRACT.md | A2 残留：:34/:103「实跑相关测试」→ 测试一律由 CI 裁决 |
| DEVELOPMENT-TRACK.md | A2 残留：:375「按实跑报错补登记」→「按 CI 实跑报错补登记」（本机不得跑门禁） |
| DOMAIN-STRUCTURE-DESIGN.md | A2 残留：:275「跑相关测试 → 再提交」→ 推送后由 CI 裁决 |
| NO-CONSOLE-WINDOW-STANDARD.md | 悬空路径：两处 src/guard/... 换成 src/app/main/process.js 与 src/app/daemons/process.js（spawn 主路径）+ supervise.js（监督） |
| KERNEL-DAEMON-CONTRACT.md | :58 autostart.js → autostart/（已拆目录）；§4 门禁表 D-1..D-5 补齐为 D-1..D-8，消除与 §3 引言的矛盾 |
| DIRECTORY-STRUCTURE-DESIGN.md | §3 树内两处过时条目：forward → forward-core、frpmgr → frp |
| PLATFORM-CAPABILITY-MATRIX.md | :95 去掉 src/infra/platform/… 字面量（保留「悬空路径举例」原意） |
| README.md | :317 去掉已删除文件的 src/domains/dist/self-update.js 字面量，保留原意 |
| test/api-contract-test.js | 过期头注：不再声称「已从链排除」，改为「已在 npm test（CI）链中，结论只由 CI 裁决」 |
| test/plugin-change-restart-test.js | 同上 |
| test/directory-structure-gate-test.js | DS-9 实跑值 400 → 300，同步头注与反向自检样本（401/400 → 301/300） |
| test/docs-reference-gate-test.js | **新增**：校验根级 SSOT 文档引用的 src/... 路径真实存在（E1/J6） |
| test/test-chain-completeness-test.js | N-e 判据：入链新增后复核长度的注记（阈值不变） |
| package.json | scripts.test 链尾追加 docs-reference-gate-test.js（唯一被授权改 scripts.test 的任务） |
| test/domain-structure-gate-test.js | 主控单独授权：DG-11 判据覆盖别名/调用形态；DG-7 RANK 登记 contract.js |

---

## 2. 各项交付详情

### 2.1 阈值 300（DS-9）
先确认：DS-9 是 **report-only**（第 4 参数 soft=true，仅 GATE_STRICT=1 转硬），故改值本身不改退出码。
- test/directory-structure-gate-test.js: FACADE_MAX=150, **FILE_MAX 400 → 300**；头注两处同步；反向自检样本 401/400 → **301/300**。
- 静态求证不红：`find src -name '*.js' | wc -l` 取最大文件 = **src/domains/router/handlers/forward.js 294 行** → 距 300 仅 6 行余量，仍绿。
- 与文档一致：DIRECTORY-STRUCTURE-DESIGN.md:213 早已写「单文件 ≤300 / index.js ≤150」，DS-9 现与 DG-2 同值。
- 无跨文件钉子：grep 全 test/ 无 FILE_MAX 引用，无门禁读 DS-9 阈值文本（仅 domain-structure-gate-test.js:875 读该文件源码，判据是「不得硬编码行号」，与本改动无关）。

### 2.2 新增 docs-reference 门禁（E1/J6）
判据（test/docs-reference-gate-test.js）：
- **DR-1** 根级 *.md 中每个 `src/...` 字面量必须可解析（文件 / 目录 / 补 .js 后存在；容忍 :行号后缀）；
- **DR-2** 反向自检：能识别不存在路径、不误报存在路径/目录/带行号形态/glob 形态。
- 范围：只扫根级 *.md（design-notes/ 是过程记录，不扫）；整份排除三份历史文档：CHANGELOG.md、ARCHITECTURE-CONTRACT-phase0.md、ARCHITECTURE-PLAN-session-lifecycle.md（改写会伪造历史）。

**静态自证（用与判据逐字等价的副本外跑，未执行门禁本体）：**
- 扫描 21 份文档 / 13 份含 src 引用 / 46 条引用 → **DR-1 offender = 0**；
- 反向三条：RV1 识别缺失=true、RV2 存在路径不误报=true、RV3 glob 不产生引用=true。
- 改动前的 offender 恰为 5 条，其中修复 3 条（NO-CONSOLE 两处、KERNEL-DAEMON 一处）+ 表述改写 2 条（README、PLATFORM-CAPABILITY-MATRIX）。

### 2.3 scripts.test 入链 + N-e 同步
- 链尾追加 ` && node -r ./test/_preload.js test/docs-reference-gate-test.js`；
- 长度 **7711 → 7774**（< 8000 上限，余量 226）；链条目 126 → 127；链中文件全部存在（N-f 成立）。
- test/test-chain-completeness-test.js 的 N-e 阈值**不变**，新增注记：入链新增必须复核本判据。
- 入链后 N-a：新文件以 `-test.js` 结尾，且已入链 → 不产生 orphan；无需改 EXCLUDED 表。

### 2.4 DG-7 / DG-11 复核（主控授权改动）
**DG-11 判据漏检（真实缺口）**：原 `/\.instances\s*\.\s*instances\b/` 要求字面点号前缀，漏掉别名与调用两种写法。
- 改为 `/\binstances\s*(?:\(\s*\))?\s*\.\s*instances\b/`；
- 新增两条反向自检（别名形态、`instances()` 调用形态），并保留原两条；
- 静态自证（逐字复刻判据 + 复刻 gate 的 strip 实现）：
  - sup.instances.instances.find() → 1（命中）；sup.instances.list() → 0（不误报）；
  - 别名形态 → 1；调用形态 → 1。
  - 现存实盘命中：`app/control/adapters.js:98`、`app/control/specs.js:90`（**WS1-c 待修**）；`domains/relay/managed.js` 分析期间已被 WS1-b 改为 `instances.all()`，现不再命中。
- **这正是 DG-7/DG-11「复核」的价值：光放宽判据会让门禁变红，必须与源码收口同批。**

**DG-7 rank 归类（惰性缺口）**：5 个域契约文件 rank=null（domains/{instance,plugin,relay,router,shell}/contract.js）。
- 现无域内消费者故 DG-7 仍绿，一旦有人 `require('./contract')` 会以「未归类文件」报错而非做方向检查；
- 在 RANK 表加 `'contract.js': 3`（纯数据、零 require，与 model/store 同层）；
- 静态自证：91 个域文件 → **null rank = 0**。零行为变更（只把 null→3）。

### 2.5 悬空引用（下级交付，已复核）
- NO-CONSOLE-WINDOW-STANDARD.md：主进程 → src/app/main/process.js；daemon spawn → src/app/daemons/process.js（spawn 主路径）+ supervise.js（监督）。下一级指出候选 supervise.js 只有监督拍、无 spawn，实际 spawn 在 process.js:156（spawnOS.detached，windowsHide 已固定）——已按语义并列两路径，DR-1 均可解析。
- KERNEL-DAEMON-CONTRACT.md：D-1..D-8 表补齐；静态核对 test/kernel-daemon-contract-test.js 实含 D-1..D-8 全部编号，行名一致。
- DIRECTORY-STRUCTURE-DESIGN.md §3：forward → forward-core、frpmgr → frp（树内条目逐个 test -e 实测，其余全部存在）。
- GUARD-DOMAIN-MODEL.md：**无需改**（grep main-process|control-view 零命中，:45/:101 已是现行路径）。

---

## 3. 形式钉子保留项（R1）

| 项 | 处置 |
|---|---|
| test/kernel-daemon-contract-test.js:100-107 以**目录**聚合读 src/platform/os/autostart | 保留；KERNEL-DAEMON 文档相应写成 autostart/，两者一致（未改该测试） |
| NO-CONSOLE-WINDOW-STANDARD.md:31 proxy.js:272 | 原样保留（路径存在，DR-1 可解析）；其行号漂移（:272 现为 markBanned）仅登记 |
| 两个测试文件正文 | **只改第 4-6 行头注**，其余一律未动（git diff 确认） |
| DS-9 反向自检样本 301/300 | 属**阈值自身的边界样本**，非外部钉子：已全仓确认无 FILE_MAX/DS-9 跨文件引用 |
| 门禁源码不得硬编码行号（DG-13 读 directory-structure-gate-test.js 源码） | 我的改动未引入 `.line === <数字>` 形态 |

---

## 4. 新增/删除的导出

**无。** WS3 未触碰任何 src/** 源码文件，未新增/删除任何导出或函数。
- 新增文件 test/docs-reference-gate-test.js 是测试脚本，不导出符号；
- 依赖证据：package.json#dependencies 未改（零运行时依赖不变）。

---

## 5. node --check 结果

| 文件 | 结果 |
|---|---|
| test/directory-structure-gate-test.js | exit 0 |
| test/docs-reference-gate-test.js | exit 0 |
| test/test-chain-completeness-test.js | exit 0 |
| test/domain-structure-gate-test.js | exit 0 |
| test/api-contract-test.js | exit 0（下级执行） |
| test/plugin-change-restart-test.js | exit 0（下级执行） |
| package.json | JSON.parse 通过；scripts.test len=7774 |

所有改动文件均无操作者绝对路径（grep 复核 0 命中）。

---

## 6. CI 风险点（按严重度）

1. **DG-11 会红 —— 必须与 WS1-c 同批提交（最高）**：判据放宽后现有实盘命中 `app/control/adapters.js:98`、`app/control/specs.js:90`。**若单独提交本门禁改动，CI 必红**。relay/managed.js 已由 WS1-b 收口。请确认 WS1-c 两处已改后再提交，或把两处源码改动一并纳入本批。
2. **docs-reference DR-1 的脆弱面**：任何其它工作流在**根级** *.md 里新增 `src/...` 引用（含 src 开头的目录树）都会触发。当前 0 offender；若 WS1 精简注释时改动了根级文档，需重跑该判据（我未授权 WS1 改根级 *.md，风险低）。
3. **DS-9 余量仅 6 行**：当前最大 src 文件 294 行（forward.js）。WS1 只减不增，风险低；但若任一工作流**新增**代码行导致 >300，GATE_STRICT=1 下会红（report-only 下仅打印）。
4. **scripts.test 长度余量 226**：再入链一个新测试即可能逼近 8000（N-e 转红）。后续新增测试前必须复核。
5. **KERNEL-DAEMON-CONTRACT §4 表**：纯文档，无门禁校验其与测试编号一致；已静态核对 D-1..D-8 全部存在，无红风险。
