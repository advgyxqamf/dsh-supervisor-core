# P4-D-2 报告：release 侧死代码清理 + #34 注释 + 「本机 npm test」收敛

> 执行者：P4-D-2。独占范围：`release/**`、`.github/**`（`test/**` 归 P4-D-1，根级 `*.md` 归 P4-D）。
> 依据：`design-notes/_p4-d-recon.md`、`design-notes/_workorder-phase4.md` §0/§1/§4、
> `design-notes/_p3-e-audit-backlog.md` §2.2 #31 / §2.3 #34 / §3.1「部分修」。
>
> 纪律：未运行任何测试/门禁；未 `require` 产品模块；未做任何 git 写操作；未启动 daemon；
> 只用 read / grep / wc / `bash -n` / `node --check` / `release/scripts/export-consumers.sh`（R2 工具）/ 只读 git。
> 本报告不含操作者绝对路径。所有结论以 CI 为最终裁决。

---

## 0. 改动总表（仅本工作流 7 个文件）

| 文件 | 行（改前） | 行（改后） | 性质 |
|---|---|---|---|
| `release/scripts/ci-core.sh` | :21、:40-41、:97/:100/:106 | 删除变量/死 if；清理展开 | #31 死代码 |
| `release/scripts/publish-core.sh` | :111 | :111（改注释行） | #31 死变量 |
| `release/scripts/verify-versions.js` | :18 | :18 | #31 死别名 |
| `release/scripts/cred.sh` | :45-49 | （删除） | #31 死函数 |
| `.github/workflows/build.yml` | :96-97 | :96-97 | #34 注释 |
| `release/README.md` | :145、:179、:251、:276、:326 | 同行 | 部分修 |
| `release/runbooks/publish-and-verify.md` | :38-40、:98 | :38-39、:97 | 部分修 |

`git status --porcelain` 显示本工作流只动上述 7 个文件；其余 `src/**`、`test/**`、根级 `*.md` 是 P4-A/B/C/D/E 的改动，本工作流未触碰（文件独占已遵守）。

---

## 1. #31 发布脚本死分支/死变量（逐项，自行复核后删）

### 1.1 `release/scripts/ci-core.sh`

**改动**
- 删除 `ALL_PLATFORMS=0`（原 :21）。
- 删除 `PLAT_ARGS=()` 与 `if [ "$ALL_PLATFORMS" = 1 ]; then PLAT_ARGS=(--all-platforms); fi`（原 :40-41）。
- :93 `npm run build:launcher --`（原 :97，行尾去掉 `${PLAT_ARGS[@]+"${PLAT_ARGS[@]}"}` 展开）。
- :96 `npm run publish:core -s --`（原 :100 同形）。
- :102 `npm run publish:core -- --publish`（原 :106 同形）。

**R2 证据（复核，非照抄 recon）**
- `grep -rn '\bALL_PLATFORMS\b'` 全仓：仅 `ci-core.sh` 原 :21 与 :41（赋值/判据自身），无 `test/`、`bin/`、`src/` 消费者。
- `export-consumers.sh ALL_PLATFORMS`：`release=2`（均在 ci-core.sh 内，即定义块自身），其余为 `design-notes/`（过程文档，不计 R2）。
- `export-consumers.sh PLAT_ARGS`：定义文件之外命中 5 处，**全部在 ci-core.sh 自身**（:40/:41/:97/:100/:106），另 1 处 design-notes；无跨文件消费者。
- 因此该变量恒为 0、`PLAT_ARGS` 恒为空是**结构性**事实：`--all-platforms` 分支在 :24-27 直接 `exit 2`，脚本不可能带着 `ALL_PLATFORMS=1` 继续执行。

**语义不变证明**：`PLAT_ARGS=()` 已设置但空 → 原展开 `+` 词为零个字段，故原命令行的实际 argv 就是 `npm run build:launcher --` / `npm run publish:core -s --` / `npm run publish:core -- --publish`。清理后逐字相同（含尾部 `--` 保留），**无行为变更**。

**必须保留（有测试钉子，已核验保留）**：`--all-platforms)` case 分支、`已废弃` 文案、`exit 2`。
- `test/all-platforms-test.js:74-75` T2-d：`--all-platforms)` + `已废弃` + `exit 2`。
- `test/release-auth-test.js:194` R7-c：`--all-platforms)` + `已废弃`。
- 改后 `grep` 确认 `ci-core.sh:24/26/27` 仍在（见 §7 输出）。

**语法检查**：`bash -n release/scripts/ci-core.sh` → exit 0（`OK-ci`）。

### 1.2 `release/scripts/publish-core.sh:111` `BIN_NAME`

**改动**：删除死变量赋值；**保留其行内说明注释**（改为独立注释行，仍在 :111）。
`BIN_NAME="dsh-supervisor"   # launcher 形态：node 启动脚本（…）`
→ `# launcher 形态：node 启动脚本（win 亦无 .exe——由 npm bin shim 生成）`

**R2 证据**
- `export-consumers.sh BIN_NAME`：`release=1`，即赋值行自身；其余 5 处为 `design-notes/`（不计 R2）；`src/test/bin/ui/docs=0`。
- 定向复核 `grep -rn '\bBIN_NAME\b' --include='*.sh' --include='*.js' --include='*.yml'`：全仓唯一命中 `publish-core.sh:111`（声明即唯一）→ 无消费者，可删。

**保留注释（R1）**：把删除行按 ≥4 字 CJK / ≥6 字符 ASCII 拆 token 后 grep `test/`，
ASCII token `launcher` 命中 `test/round8-fixes-test.js:10/26/48` → **命中即保留**，
故注释文本原样保留（R1 命中登记）。变量本身已删，不影响死代码目标。

**语法检查**：`bash -n release/scripts/publish-core.sh` → exit 0（`OK-pub`）。
**未动**：`ALL` 开关与 ALL=1 块（:26/:57/:102）及 `_platforms.sh` source（:59）——见 §1.5。

### 1.3 `release/scripts/verify-versions.js:18` `--all`

**改动**：`if (mode === '--core' || mode === '--all') {` → `if (mode === '--core') {`。

**R2 证据（调用者）**
- `package.json:17`：`"verify:versions": "node release/scripts/verify-versions.js --core"`。
- `release/scripts/bump.sh:27`：`node release/scripts/verify-versions.js --core`。
- `grep -rn 'verify-versions' --include='*.js' --include='*.sh' --include='*.json' --include='*.yml'`（排除 design-notes）→ 仅上述两处 + bump.sh:21 注释，**无 `--all` 调用者**；`test/` 零命中。

**行为变更声明（必须）**：`verify-versions.js --all` 由「执行 coreCheck、exit 0」变为「打印 `未知模式: --all（本仓只支持 --core…）`、exit 2」。
因仓内无任何调用者、`test/` 无断言，**对 CI 与既有流程零影响**；这正是删除该废弃别名的预期效果。

**语法检查**：`node --check release/scripts/verify-versions.js` → exit 0（`OK-vv`）。

### 1.4 `release/scripts/cred.sh:46` `idx()`

**改动**：删除原 :45 的注释（描述该函数）与 :46-49 的函数体（共 5 行）。

**R2 证据**
- `export-consumers.sh idx` 报「不可删（定义文件之外 15 处）」，但逐条核验后**全部是同名 JS 局部变量**（`src/app/state/store.js`、`src/domains/plugin/ops.js`、`test/domain-structure-gate-test.js` 等），与 cred.sh 的 **bash 函数** `idx` 无任何调用关系（JS 不可能调用 shell 函数；shell 函数亦不跨进程）。
- 定向复核 `grep -rn '\bidx\b' --include='*.sh'` → 全仓唯一命中 `cred.sh:46`（定义自身）→ 无 shell 调用者；`file_of()`（:55）调用的是 `entry_field`，不是 `idx`。
- 故该函数确为死代码，删。

**R1 证据**：删除注释拆 token 后 grep `test/`：`读清单` / `jq` / `纪律一致` / `内核对运行时依赖为` → 全部 NONE。

**语法检查**：`bash -n release/scripts/cred.sh` → exit 0（`OK-cred`）。

### 1.5 按指令**未动**的两处（登记为「不动」）

- `publish-core.sh` 的 `ALL` 开关（:26）与 ALL=1 块（:57-87、:102-107）：**真实开关**，且 `test/all-platforms-test.js:99` T2-j 断言 publish-core 从 `_platforms.sh` 取矩阵——删除会先波及 `test/`（P4-D-1 域），属不必要的跨文件耦合。保留；改后 `grep -n '_platforms.sh'` 仍见 :58/:59。
- `cred.sh:127` `backup)` 子命令：用户可见功能（`cred.sh backup <目录>`、支持 `DSH_CRED_BACKUP_DIR`），非死代码。保留。

---

## 2. #34 `.github/workflows/build.yml` precheck 注释

**改动**（仅注释，:96-97）
- 删：「副作用即「已知边界」：四平台齐备后构建矩阵不再运行 —— 想在 CI 重跑完整构建，必须存在一个**未发布的新版本**。见 release/README.md §1.2。」
- 增：「⚠ 2026-09-14 更正：`need_build` 只作用于 `release` job 与 build 步骤里的 `--publish` 判定（防同版本重发）；`build` 矩阵**每次 push / PR 都跑**，不得条件跳过。见 release/README.md §1.1。」

**未改 workflow 逻辑**：jobs、`needs`、`if`、matrix、steps 全部原样。

**门禁风险核验（注释不被断言钉住）**
- A-4（`test/acceptance-standard-gate-test.js:71-72`）与 T5-d/T5-d2/T5-g（`test/all-platforms-test.js:132-138`）都基于去注释后的代码或 build 段代码判定，注释文本不参与。
- P-8（`test/release-spec-consistency-test.js:165-179`）只查 build 段内的 `^    if:` 与 `needs.precheck.outputs.need_build`；本次改动在 precheck 段，未触及。
- 删/改注释 token（`副作用即` `已知边界` `四平台齐备后` `重跑完整构建` `未发布的新版本`）grep `test/` → NONE。
- 新增的 `release/README.md §1.1` 引用真实存在（该节标题为「1.1 构建与发布一律在 CI」）。

---

## 3. 部分修：release 侧「本机 npm test」收敛（本批重点）

**硬标准依据**：`ACCEPTANCE-STANDARD.md:11`「所有测试一律不得在本机执行；验收只能由推送后的 GitHub CI 裁决」；
`RELEASE-STANDARD.md:64/70`：S4 全量回归**由 CI 执行**（`xvfb-run -a npm test`，本机不得执行），**本地只完成 S0–S3**。

**已改（本机 npm test 指引 → 由 CI 执行）**

| 文件:行（改后） | 改后表述要点 |
|---|---|
| `release/README.md:145` | `CI 的 npm test（test job，ubuntu-latest）`（原「npm test（在 Linux 上）」，去除本机读法） |
| `release/README.md:179` | 本地只允许 S0–S3；**S4 全量回归起一律由 CI 执行**（本机不得执行 `npm test`） |
| `release/README.md:251` | 本地允许做什么 = S0–S3 与 `--dry-run`；**本机不得执行 `npm test`**（全量回归由 CI 的 test job 经 `xvfb-run -a npm test` 执行） |
| `release/README.md:276` | `RELEASE-STANDARD.md`（本地只做 S0–S3，S4 起在 CI） |
| `release/README.md:326` | 全量回归：由 CI 的 `test` job 经 `xvfb-run -a npm test` 执行；**本机不得执行 `npm test`** |
| `release/runbooks/publish-and-verify.md:38-39` | 删除「本地 npm test / bash ci-core.sh」两步，改为「本机不得执行 npm test；全量回归由 CI 的 test job 经 xvfb-run -a npm test 执行（ci-core.sh 内含 npm test 与构建，同样只在 CI 内运行）」 |
| `release/runbooks/publish-and-verify.md:97` | 稳定性 = CI 的 `npm test`（`test` job 经 `xvfb-run -a npm test`）全绿 |

**命令/路径真实性实测**：`npm test`（`package.json:11`）、`verify:versions`（`package.json:17`）、`build-ui.sh`、`ci-core.sh`、`bump.sh`、`RELEASE-STANDARD.md`、`release/runbooks/publish-and-verify.md` 均存在；`xvfb-run -a npm test` 与 `build.yml:91` 的 CI 实跑一致。

**刻意未改的命中行（分类说明，避免误伤「准确描述 CI」的句子）**
- `release/README.md:173/177/189/190/210/215/250/294/304-305` 与 `runbook:28/46/49/52-53`：这些行描述的是 **CI 内的流程/步骤**（`ci-core.sh` 由 build 矩阵运行、test job 的 build-ui→xvfb-run npm test、need_build 作用于发布），**不是本机操作指引**，无需改写。
- `.github/pull_request_template.md`：现 :22 已是「验收状态：待 CI 裁决」，**:无** 本机 `npm test` 指引（与 recon §部分修一致）；未改。

**门禁就绪性**
- A-5 扩扫（P4-D-1 将把 `release/**`、`.github/**` 纳入）：两文件 grep `验收结论|验收通过|已验收|交付完成|验收状态` → **NO VERDICT WORDS**，扩扫不会转红。
- X-2：两文件无操作者绝对路径（以常见 home 绝对前缀扫描，全部 NO）。

---

## 4. 行为变更声明（汇总）

| 变更 | 类别 | 影响 |
|---|---|---|
| `verify-versions.js --all` | **有行为变更**：由 exit 0 变为 `未知模式` + exit 2 | 仓内零调用者、零断言 → CI 无影响 |
| `ci-core.sh` 删 `ALL_PLATFORMS`/`PLAT_ARGS` | 无行为变更（argv 逐字相同） | 无 |
| `publish-core.sh` 删 `BIN_NAME` | 无行为变更（未用变量） | 无 |
| `cred.sh` 删 `idx()` | 无行为变更（未调用函数） | 无 |
| `build.yml` 注释、两个 release .md | 无（仅文本） | 无 |

---

## 5. CI 风险与缓解

1. **测试钉子**：`all-platforms-test.js` T2-d/T5-*/P-8、`release-auth-test.js` R7-c 依赖的字符串（`--all-platforms)`、`已废弃`、`exit 2`、`_platforms.sh`、`needs.precheck.outputs.need_build`）全部保留并已 grep 复核。
2. **build.yml**：只改注释，逻辑未动；A-4（build 不得被 need_build 门控）依旧成立。
3. **文档门禁**：A-5 若扩容到 release/** 亦安全（无 VERDICT 词）；docs-reference 只扫根级 .md，`release/README.md` 引用的 `src/`、`release/` 路径除 §6 登记项外均为真实存在。
4. **发布脚本运行期**：改动均为删除死代码/注释，`bash -n` 全绿；因本批**禁跑**，实际执行由 CI 裁决。

---

## 6. 超范围登记（初版；其中 1-4 已在 §9 追加修复，5-11 保持登记）

1. 【已修·见 §9】`.github/workflows/build.yml:129`：`echo "  → 四平台已齐备，**跳过构建矩阵**（省额度）"` —— 现状 build 矩阵每次都跑，该输出文案已失真（任务限定只改 :95-98 注释，故未动）。
2. 【已修·见 §9】`.github/workflows/build.yml:173-174`：注释仍写「build 受 need_build 门控，版本全发布时不运行」，与 :138-142 的「已移除条件」自相矛盾。
3. 【已修·见 §9】`release/scripts/ci-core.sh:2`：头注称被「build.yml 的 test job 与四平台 build 矩阵**都**调用」——实际 test job 直接 `build-ui.sh` + `build:launcher:all` + `xvfb-run -a npm test`，不调用 ci-core.sh。
4. 【已修·见 §9】`release/README.md:215`：同上，称 ci-core.sh 是「CI 的 test job 与四平台 build 矩阵都跑它」。
5. `release/README.md:7`：自称「本目录是…唯一事实源」，与根 README 索引（`RELEASE-STANDARD.md` 为发布流程唯一事实源）冲突；`release/` 不受 `standards-uniqueness` U-3 扫描。
6. `release/README.md:298-299`：以 `v0.1.5-BETA.2` 的旧 run 作「全绿」实证，而当前 `package.json.version = 0.1.5-BETA.7`。
7. `release/runbooks/publish-and-verify.md:96`：Node 门槛写「v22.12」，与内核 `package.json engines.node>=18` 不一致（且 Node 安装已归壳仓）。
8. `release/runbooks/publish-and-verify.md:100-117`：状态追踪停留在 `@…@0.1.4-BETA.1`，已严重过时。
9. `release/runbooks/publish-and-verify.md:18-21`：注释「一条命令走完：门禁 → 构建 → 派生 4 平台 → tag/push → 直推 npm」，把「门禁/构建」排在 `git push` 之前，易读成本地步骤。
10. `release/README.md:275`：SOP 注释「一键编排 dry-run（…委托 ci-core.sh 全部门禁…）」——ci-core.sh 现已只允许在 CI 内运行，本机编排语义已不成立。
11. 复核说明：`design-notes/_audit-r5-stale-release.md` 所列 `release/runbooks/publish-and-verify.md:14`（`src/api/shell.js`）在当前树已是 `src/api/domains/shell.js`，无需处理；该审计的多条行号已漂移，本报告不照抄。

---

## 7. 验证命令与输出（原文）

```
$ bash -n release/scripts/ci-core.sh && echo OK-ci
OK-ci
$ bash -n release/scripts/publish-core.sh && echo OK-pub
OK-pub
$ bash -n release/scripts/cred.sh && echo OK-cred
OK-cred
$ node --check release/scripts/verify-versions.js && echo OK-vv
OK-vv

$ grep -n 'ALL_PLATFORMS\|PLAT_ARGS\|BIN_NAME' release/scripts/ci-core.sh release/scripts/publish-core.sh
（无输出）

$ grep -n 'idx\|entry_field' release/scripts/cred.sh
45:entry_field() { # <name> <field>
55:file_of() { entry_field "$1" file; }
157:      #   entry_field 依赖的 $INDEX 在子 shell 里仍可用；此处显式再取一次以确保非空。

$ grep -n -- '--all-platforms)\|已废弃\|exit 2' release/scripts/ci-core.sh
7:#   - --all-platforms   = 一律拒绝（已废弃；四平台由 CI 各 runner 各自产出）
24:    --all-platforms)
26:      echo '拒绝：--all-platforms 已废弃（2026-09-13 硬标准：构建与发布均经 GitHub CI）。' >&2
27:      exit 2 ;;
28:    *) echo "未知参数: $1（支持 --publish / --all-platforms）"; exit 2 ;;

$ grep -n '_platforms.sh' release/scripts/publish-core.sh
58:  # shellcheck source=./_platforms.sh
59:  . "$ROOT/release/scripts/_platforms.sh"

$ grep -rn '验收结论\|验收通过\|已验收\|交付完成\|验收状态' release/README.md release/runbooks/publish-and-verify.md
（无输出 → NO VERDICT WORDS）

$ grep -rn '<home-abs-prefix-regex>' release/README.md release/runbooks/publish-and-verify.md .github/workflows/build.yml
（无输出 → NO ABSOLUTE OPERATOR PATHS）
```

**R2 工具输出要点**（`release/scripts/export-consumers.sh`）
- `BIN_NAME`：全仓 6 命中 = 赋值行自身（release 1）+ design-notes 5；定义文件之外计入 R2 的即该赋值行。
- `PLAT_ARGS`：R2 命中全在 `ci-core.sh` 自身（同文件）。
- `ALL_PLATFORMS`：release 2 命中均在 `ci-core.sh` 自身，test/bin/src=0。
- `idx`：15 处「定义文件之外」经逐条核验均为**同名 JS 局部变量**，与 cred.sh 的 bash 函数无调用关系；`*.sh` 全域唯一命中为定义行自身。

---

## 8. 文件清单（本工作流改动）

- `release/scripts/ci-core.sh`
- `release/scripts/publish-core.sh`
- `release/scripts/verify-versions.js`
- `release/scripts/cred.sh`
- `.github/workflows/build.yml`
- `release/README.md`
- `release/runbooks/publish-and-verify.md`

本报告：`design-notes/_p4-d2-release.md`。
---

## 9. 追加（同一批收尾）：#34 同类错误表述 4 处

> 触发：父代理 P4-D 追加要求。理由：#34 的目的是消除「声称 build 受 need_build 门控 / 声称 test job 调 ci-core.sh」
> 这类**同一类**错误表述；只修被命中的单点而留同类，正是 FIX-1..8 的老毛病。
> 本追加只改注释 / echo 文案，**未动任何 workflow 逻辑 / jobs / if / 步骤**。

| # | 文件:行 | 改后要点 |
|---|---|---|
| 1 | `.github/workflows/build.yml:129` | `echo "  → 四平台已齐备：need_build=false（仅影响 release job 与 --publish 判定；precheck 设立初衷为省额度）"`（原「跳过构建矩阵（省额度）」） |
| 2 | `.github/workflows/build.yml:173-174` | 理由改为「矩阵行为变更，需真实构建验证，本批不改动矩阵」；**保留结论**「留待下一次发版评估，由真实构建裁决」 |
| 3 | `release/scripts/ci-core.sh:2` | 「build.yml 的四平台 build 矩阵调用（test job 自跑等价步骤）」（原「test job 与四平台 build 矩阵都调用」） |
| 4 | `release/README.md:215` | 「（单源：四平台 build 矩阵调用；test job 自跑等价步骤）」（原「CI 的 test job 与四平台 build 矩阵都跑它」） |

**验证（追加后重跑）**

```
$ bash -n release/scripts/ci-core.sh && echo OK-ci
OK-ci
$ python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml')); print('YAML OK')"
YAML OK
```

- python3 + PyYAML 可用，`yaml.safe_load` 解析通过；另做等价静态方式（`node -e` 确认文件含 `^jobs:`、共 281 行）亦通过。
- 测试钉子仍在：`--all-platforms)` / `已废弃` / `exit 2`（`ci-core.sh:7/24/26/27/28/36`）；`_platforms.sh`（`publish-core.sh:58/59`）。
- R1：build.yml:129 是 **echo 运行期文案而非注释**，且删除的 `省额度` token 已在新文案中保留；ci-core.sh:2 删除的 `test job` token 在替换文本中保留；`need_build` token 仍存在于 build.yml 的 :96/:102/:209。
- **未新增其它改动**；§6 的 5-11 保持登记。
**并发观察（非本工作流改动）**：收尾时 `git status` 显示 `release/scripts/export-consumers.sh` 处于 modified。
该改动（{methods} 门面假阳性守卫 / 词边界加固 / 「需人工确认」结论，+55/-3）**不是 P4-D-2 所做**，
是同一共享工作区内他代理（疑为 P4-D 主控，其注释自称「主控已复现」）的并发改动；
P4-D-2 未触碰该文件，仅 `bash -n release/scripts/export-consumers.sh` 复核其语法通过（exit 0）。
