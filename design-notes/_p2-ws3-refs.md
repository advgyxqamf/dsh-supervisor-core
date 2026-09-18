# WS3 文档子代理报告：悬空引用 + 过期头注（`_p2-ws3-refs.md`）

> 工作区：仓库根（相对路径一律相对仓库根）。只读约束：未运行任何测试/门禁（无 `npm test`、无 `node test/*.js`），
> git 仅用 `status/diff/log`；改动用 read/write/edit，语法用 `node --check`；未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
> 只改独占清单内 6 个文件；报告与改动均不含操作者绝对路径。

## 0. 结论速览

| # | 文件 | 动作 |
|---|---|---|
| A | `GUARD-DOMAIN-MODEL.md` | **无需改动**（`main-process.js`/`control-view.js` 已在提交 b2f3d3d 修为现行路径；已复核语义） |
| B | `KERNEL-DAEMON-CONTRACT.md` | 改 2 处：C2 证据路径 → 目录形态；门禁表 D-1..D-5 → D-1..D-8（与实跑门禁对齐） |
| C | `DIRECTORY-STRUCTURE-DESIGN.md` | 改 2 处（域摘要行内两个不存在的旧名）；其余条目实测全部存在，未动 |
| D | `test/api-contract-test.js`、`test/plugin-change-restart-test.js` | 各改第 4–6 行头注（去掉 ⛔，改为「在 CI 链中、结论只由 CI 裁决」） |
| E | `README.md` | 改第 317 行：去掉已删除文件的 `src/...` 字面量 |
| F | `PLATFORM-CAPABILITY-MATRIX.md` | 改第 95 行：去掉假路径举例里的 `src/` 前缀 |

**改动后，新门禁 `test/docs-reference-gate-test.js` 的 DR-1 判据在 21 份非历史根级 `*.md` 上复扫为 0 offender**（判据复刻见 §4）。

---

## 1. 逐文件改动（旧 → 新 + 理由）

### 1.1 `KERNEL-DAEMON-CONTRACT.md`

**(1) 第 58 行（§3 C2 行）**

- 旧：`| C2 | Windows watchdog 是第二个启动器 | \`src/platform/os/autostart.js\` 建 watchdog 任务并拉起 daemon | D6：保活归壳 |`
- 新：`| C2 | Windows watchdog 是第二个启动器 | \`src/platform/os/autostart/\` 建 watchdog 任务并拉起 daemon | D6：保活归壳 |`
- 理由：`autostart` 已拆为目录，`src/platform/os/autostart.js` 不存在（新门禁会把该字面量判为悬空）；该行是「修复前状态 C2」的审计记录，只换路径形态，语义（内核曾自建 watchdog → 现保活归壳）不变。
- 证据：
  - `test -e src/platform/os/autostart.js` → `MISSING`；`test -d src/platform/os/autostart` → `DIR`；`src/platform/os/autostart/index.js` 存在。
  - `test/kernel-daemon-contract-test.js:100-102` 自述「autostart 已拆为 autostart/{index,win32,darwin,linux}.js」，并以 `readDomain('src/platform/os/autostart')` 按目录聚合读取。

**(2) 第 66–73 行（§4 门禁表）**

- 旧：表列 D-1..D-5，但 §3 引言（第 52 行）已写「各有门禁（**D-1..D-8**）」→ 文档自相矛盾。
- 新：表补齐并逐行对齐为 D-1..D-8（正文见文件 §4），使编号与实跑门禁 `test/kernel-daemon-contract-test.js` 完全一致：

| 新表行 | 对应实跑断言（证据行号） |
|---|---|
| D-1 内嵌 `DEFAULT_CONFIG` 自建 | `test/kernel-daemon-contract-test.js:38-40` |
| D-2 `supervisor-api` 写入 `ports.json` | :42-52 |
| D-3 `/healthz` 2xx | :54-56 |
| D-4 `install` 不写服务定义（反向非空转） | :58-70 |
| D-5 单实例 `guard.lock` 退出非零 | :72-73 |
| D-6 绑定后登记**实际端口** + 同 owner 释放旧登记 | :75-85 |
| D-7 路径经注入 `stateDir`（proxy/router） | :87-97 |
| D-8 Windows 看护所有者=桌面壳（不建 watchdog 任务/不写 `watchdog.ps1`） | :99-115 |

- 理由：门禁表是契约的可执行清单，编号必须与门禁实现一一对应；旧表把 test 的 D-1/D-2/D-6 挤在一行且缺 D-6..D-8。
- 未动：§1 承诺表（D1..D9，无连字符，属另一套编号）、§2 边界图、§3 C1/C3/C4 行。

### 1.2 `DIRECTORY-STRUCTURE-DESIGN.md`（§3 目录树）

先做**全量存在性核实**：§3 树的每个 box 绘制条目（`src/supervisor.js`、`shared/{version,ip,guardian}.js`、`platform/{util,contract,service,os,ctl,distribution,security}` 全部子项、`domains/{router,relay,instance,plugin,shell}`、`app/{assembly,session,state,self,control,main,daemons,ctl,native,settings,facade}`、`api/{index,router-table,security,static,contract,deps,identity}.js + api/domains/`）**逐个 `test -e` 全部存在（FILE/DIR 均命中）**，故树本体未动。仅两处行内摘要点名了不存在的旧模块名：

**(1) 第 107 行**

- 旧：`│   ├── router/                 providers/ + instances/ + index/ops/forward/switch/store/daemon/proxy-apps`
- 新：`│   ├── router/                 providers/ + instances/ + index/ops/forward-core/switch/store/daemon/proxy-apps`
- 理由：`forward` 不是现存文件；现行转发门面为 `src/domains/router/forward-core.js`（IO 子模块是 `handlers/forward.js`）。
- 证据：`ls src/domains/router` 无 `forward.js`，有 `forward-core.js`/`handlers/`；域内 SSOT `DOMAIN-STRUCTURE-DESIGN.md:104,106` 定名 `forward-core.js`（门面）/`handlers/forward.js`（IO）。

**(2) 第 108 行**

- 旧：`│   ├── relay/                  index/gate/ops/frpmgr/daemon`
- 新：`│   ├── relay/                  index/gate/ops/frp/daemon`
- 理由：`frpmgr.js` 已删除，现行 relay 根为 `frp.js`/`frp-install.js`。
- 证据：`git log --oneline --diff-filter=D -1 -- src/domains/relay/frpmgr.js` → 命中提交 `3edd267`；`ls src/domains/relay` 无 `frpmgr.js`，有 `frp.js`/`frp-install.js`；`DOMAIN-STRUCTURE-DESIGN.md §5.2` 列 `frp.js / frp-install.js`。

### 1.3 `PLATFORM-CAPABILITY-MATRIX.md`（仅第 95 行）

- 旧：`| F6 | 假声明注释 / 悬空路径（\`src/infra/platform/…\`）| 更正注释，标注真实能力来源 | A6 |`
- 新：`| F6 | 假声明注释 / 悬空路径（如已被重构掉的 \`infra/platform/…\` 引用）| 更正注释，标注真实能力来源 | A6 |`
- 理由：该格本身在**举例**「悬空路径」，但保留 `src/...` 字面量时新门禁会把它当真实引用（`src/infra/platform` 不存在）→ 去 `src/` 前缀、保留原意。
- 其余 219 行未动。

### 1.4 `README.md`（仅第 317 行）

- 旧：`- 旧 manifest 通道（\`selfUpdateManifestUrl\`/\`selfUpdateDir\` + \`src/domains/dist/self-update.js\`）**已删除**。`
- 新：`- 旧 manifest 通道（\`selfUpdateManifestUrl\`/\`selfUpdateDir\` 与实现它的自更新模块）**已删除**。`
- 理由：`dist` 域已解体、`src/domains/dist/self-update.js` 不存在；去掉 `src/...` 字面量，保留「旧 manifest 通道已删除」语义。
- 证据：`test -e src/domains/dist/self-update.js` → `MISSING`；`src/domains/dist/` 目录不存在；`test/kernel-update-single-writer-test.js:75` 断言该文件已删除。

### 1.5 `test/api-contract-test.js`、`test/plugin-change-restart-test.js`（各仅第 4–6 行）

- 旧（两文件同形，仅主语句不同）：
  - `// ⛔ 卸载类测试（项目政策，2026-08-31）：…`（含卸载断言）
  - `// 已从 npm test 自动测试链排除，仅允许作为独立脚本显式单独调用（node test/<file>.js 或 npm run test:<script>）；`
  - `// 除非用户明确指令，禁止擅自运行。`
- 新（两文件同形）：
  - `// 卸载类测试（项目政策，2026-08-31）：…`（同主语句，仅去 ⛔）
  - `// 已纳入 npm test（CI）自动测试链执行；测试结论只能由 CI 裁决，本地不单独复跑`
  - `// （如需排查，可显式执行 node test/<file>.js 或 npm run test:<script>）。`
- 理由：两文件**实际都在** `package.json#scripts.test` 链中，旧头注「已排除」与事实相反；且项目政策要求测试结论由 CI 裁决。
- 证据：
  - `grep -o 'test/api-contract-test.js' package.json` → 命中；`grep -o 'test/plugin-change-restart-test.js' package.json` → 命中（均在 `scripts.test` 的 `&&` 串联链中）。
  - `package.json:21 \`_uninstallTests\`` 自述：「native-test.js … 未进入 npm test 自动链；**api-contract-test.js 与 plugin-change-restart-test.js 已在链中（不再排除）**。…所有测试（含上述独立脚本）一律不得在本机执行，验收只由 CI 裁决。」——新头注与该声明逐义一致。
  - `git diff -U1` 确认两文件各只改第 4–6 行（各 6 行变更：3 删 3 增），第 7 行空行与原第 8 行起未动。
  - `node --check test/api-contract-test.js` → exit 0；`node --check test/plugin-change-restart-test.js` → exit 0。
- 对照：`test/native-test.js` 头注仍写「已排除」——**该文件确实不在链中**（`test/test-chain-completeness-test.js:40-43` 的 `EXCLUDED` 表唯一成员），故未动（也不在本次授权清单内）。

### 1.6 `GUARD-DOMAIN-MODEL.md`（A：核实后判定无需改动）

- 任务描述的悬空引用（`main-process.js` / `control-view.js`）在本文件**已不存在**：
  - `grep 'main-process|control-view' GUARD-DOMAIN-MODEL.md` → **0 命中**；`git show HEAD:GUARD-DOMAIN-MODEL.md` 同样 0 命中。
  - 第 45 行现为 `src/app/main/process.js`，语义已核实：`src/app/main/process.js:204` 发 `restart_triggered`、`:200 _beginRestart`、`:210 _mSetRestartCount`、`countCrash` @48/92/108/201/209。
  - 第 101 行现为 `src/app/daemons/runtime.js`，语义已核实：全仓 `src/` 已无 `_guardianEvent` 定义/调用（唯一出现是 `src/platform/service/log/sources.js:58` 一句说明性注释，门禁不计注释）；`test/guard-domain-model-gate-test.js:205` 的 GD-2 判据文件正是 `src/app/daemons/runtime.js`。
  - 该引用在提交 `b2f3d3d`（`fix(kernel): 归一化收尾 + FIX-1..8 缺陷修复 + 注释符号清除`）已修复；审计文本 `design-notes/_audit-r5-stale-root.md`、`HANDOFF.md` 记录的是修复前快照。
- 结论：**不改**（避免无谓 churn），按「已现行」登记。

---

## 2. 保留 / 登记项（明确不改 + 理由 + 证据）

| # | 项 | 处置 | 理由与证据 |
|---|---|---|---|
| K1 | `DIRECTORY-STRUCTURE-DESIGN.md` §3 树内 `gate`（relay） | 保留 | `git log --diff-filter=D -- src/domains/relay/gate.js` 无命中 ⇒ 从未作为文件存在，属设计期功能标签；现行「来源闸/令牌闸」在 `relay/proxy.js`、`relay/core.js`，无 1:1 对应名，不猜。 |
| K2 | 同上 `instance/ index/core/ops` 的 `core` | 保留 | `src/domains/instance/core.js` 不存在；`DOMAIN-STRUCTURE-DESIGN.md:174` 明示「`core.js` 是误名」，内容被拆入 `index.js`/`model.js`/`lifecycle.js` 等，**无单一新位置**。 |
| K3 | 同上 `app/assembly` 的 `fixed-ports`/`lifecycle-registration` | 保留 | 两文件不存在（`grep -rn 'fixedPorts|fixed-ports|lifecycleRegistration' src/app/assembly` → 0）；从未作为文件存在（`--diff-filter=D` 无命中）；现行 `assembly/` 为 `compose/`+`{compose,bootstrap,api-rebind,collaborators,facets,log-sources}.js`，无 1:1 对应。 |
| K4 | 同上 `app/state` 的 `config-patch`/`migrate` | 保留 | 两文件不存在（`ls src/app/state`）；`--diff-filter=D` 无命中；无 1:1 对应名。 |
| K5 | 同上 `app/native` 的 `binding` | 保留 | `src/app/native/binding.js` 不存在（在者为 `command/installer/manifest/npm/ops/policies/probe/upgrade.js`）；无 1:1 对应名。 |
| K6 | `src/platform/os/` 行注「（12 文件不动）」 | 保留（计数陈旧） | 实测顶层 11 个文件 + `autostart/`、`pidlookup/` 两目录（`find src/platform/os -type f` = 18）。该注不含 `src/...` 字面量，非门禁对象；改动属计数同步，超出「最小化修悬空引用」。 |
| K7 | `←` 溯源箭头（如 `← platform/exec.js`、`← platform/config.js`、`← domains/router/ctl.js`、`← domains/dist/index.js:36-116`、`← guard/guardian/`、`← api/identity.js`） | 保留 | 明示记录**重构前**位置，是溯源而非现行引用；删改会伪造历史。 |
| K8 | `src/platform/service/log/` 行的 `← … loghub.js` | 保留 | `loghub.js` 为重构前旧名（`--diff-filter=D` 无命中）；现行 `log/` 为 `core/events/hub/logcore/log/sources/tail/watermark`；与 K7 同类，属溯源。 |
| K9 | `CHANGELOG.md`/`ARCHITECTURE-CONTRACT-phase0.md`/`ARCHITECTURE-PLAN-session-lifecycle.md` 内缺失引用 | 保留（门禁已显式排除） | `test/docs-reference-gate-test.js:25-29` 的 `HISTORICAL` 集合显式跳过这三份；它们记录废弃方案/历史，改写即伪造历史。 |
| K10 | `test/native-test.js` 头注「已排除」 | 保留 | 事实正确（唯一排除项），且不在本次授权文件清单内。 |

---

## 3. R1 形式钉子核查（改注释前的 grep 证据）

对将被改动的两段头注特征串，先 grep `test/`（`include: *.js`）确认无测试以其为断言对象：

| 特征串 | test/ 命中 | 判定 |
|---|---|---|
| `自动测试链排除` | 3：`test/native-test.js:5`、`test/api-contract-test.js:5`、`test/plugin-change-restart-test.js:5` | 后两处是**被改文件自身**；前者事实正确且非本文件 ⇒ **无测试断言** |
| `独立脚本显式单独调用` | 同上 3 处（同性质） | **无测试断言** |
| `禁止擅自运行` | 3 处（三份头注自身） | **无测试断言** |
| `卸载类测试` | 4：`test/native-test.js:4`、`test/frp-platform-test.js:5`、本两文件:4 | **无测试断言**（`frp-platform-test.js` 是无关提及） |
| `CI 裁决`（新写入串） | `test/acceptance-standard-gate-test.js:41,82,92` | 该门禁作用域是 `ACCEPTANCE-STANDARD.md` 正文与构造样本，**不读 test/ 注释** ⇒ 安全 |
| `test:api-contract` | `test/test-chain-completeness-test.js:11`（仅为历史注释）、`test/api-contract-test.js:5` | 该门禁 A-1 读 `package.json#scripts.test`，与注释文本无关 ⇒ 安全 |

结论：**未发现相反证据**（即没有任何测试对这一段头注特征串做正则匹配）；可按要求改写。
另：新头注与 `package.json:21 _uninstallTests` 的既有政策声明一致，不新增事实。

---

## 4. 独立复核：新门禁 DR-1 在根级文档上的全量复扫

按 `test/docs-reference-gate-test.js` 的判据**逐字复刻**（`SRC_REF=/src\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g` → `normalizeRef`（剥 `:行号`/`#?`/尾标点/尾 `/`，长度 ≤4 丢弃）→ `resolves`（存在，或补 `.js` 存在）→ `HISTORICAL` 三份排除），对 **21 份非历史根级 `*.md`** 复扫：

- 结果：**0 offender**（13 份含 `src/` 引用）。
- 改动前 offender 恰为本次修掉的 3 处：`KERNEL-DAEMON-CONTRACT.md -> src/platform/os/autostart.js`、`PLATFORM-CAPABILITY-MATRIX.md -> src/infra/platform`、`README.md -> src/domains/dist/self-update.js`。
- 复核通过项（不悬空，无需动）：`NO-CONSOLE-WINDOW-STANDARD.md`、`DSH-TOKEN-CONTRACT.md`、`EXECUTION-CONTRACT.md`、`ARCHITECTURE-ACCEPTANCE.md`、`DEVELOPMENT-TRACK.md`、`DOMAIN-STRUCTURE-DESIGN.md`、`GUARD-DOMAIN-MODEL.md`、`DIRECTORY-STRUCTURE-DESIGN.md`、`HANDOFF.md`、`RELEASE-CHANNEL-CONTRACT.md` + 上表三份被修文件。

### 仅报告、不改：被 `HISTORICAL` 排除的三份历史文档中的缺失引用

- `CHANGELOG.md`：`src/platform/state-root.js`、`src/platform/runtime-contract.js`、`src/platform/registry-contract.js`、`src/platform/os/autostart.js`、`src/domains/dist/self-update.js`、`src/api/shell.js`、`src/supervisor`、`src/infra/config.js`、`src/infra/version.js`、`src/keypool.js`、`src/pidlookup.js`、`src/service-daemon/lan-daemon.js`，以及壳仓路径 `src/bridge.rs`、`src/update.rs`、`src/services/supervisor/*.ts`、`src/features/supervisor/*.tsx`、`src/ui/systemd/release`。
- `ARCHITECTURE-CONTRACT-phase0.md`：`src/api/lifecycle.js`。
- `ARCHITECTURE-PLAN-session-lifecycle.md`：`src/api/lifecycle.js`、`src/guard/intent.js`、`src/guard/lifecycle/objects.js`、`src/platform/loghub.js`、`src/platform/logcore.js`、壳仓 `src/services/supervisor/*.ts`、`src/features/supervisor/*.tsx`。
- 建议：维持 `HISTORICAL` 排除（历史/废弃方案，改写伪造历史）；若主控希望这三份也“零悬空”，需另立「历史文档豁免」的显式说明，而不是改正文。

---

## 5. 验证记录

- `node --check test/api-contract-test.js` → 0；`node --check test/plugin-change-restart-test.js` → 0。
- `git diff --stat`：6 files changed, 18 insertions(+), 15 deletions(-)（`DIRECTORY-STRUCTURE-DESIGN.md` 4、`KERNEL-DAEMON-CONTRACT.md` 13、`PLATFORM-CAPABILITY-MATRIX.md` 2、`README.md` 2、两测试文件各 6）。
- 未运行任何测试/门禁；未做任何 git 写操作。
- 未改清单外文件；`GUARD-DOMAIN-MODEL.md` 保持工作区原状。
