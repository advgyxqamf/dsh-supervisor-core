# P4-D 侦察与分派（主控 P4-D 负责人写）

> 依据 `design-notes/_workorder-phase4.md` §0-§4 与 `design-notes/_p3-e-audit-backlog.md` §2.3/§3.1。
> 本文件是我（P4-D）的分派与侦察记录，**不是规范**。

## 0. 已完成的侦察结论（可直接采信，均已实测当前树）

### #31 发布脚本死分支/死变量 —— 逐项定性
| 位置 | 定性 | 证据 |
|---|---|---|
| `ci-core.sh:21` `ALL_PLATFORMS=0` + `:40-41` `if [ "$ALL_PLATFORMS" = 1 ]` | **死**：`--all-platforms` 分支在 `:25-28` 直接 `exit 2`，故该变量恒 0、`PLAT_ARGS` 恒空 | `grep -n ALL_PLATFORMS` 仅 21/41；`:97/:100/:106` 的 `\${PLAT_ARGS[@]+...}` 恒展开为空 |
| `publish-core.sh:111` `BIN_NAME="dsh-supervisor"` | **死**：全仓仅此一行（声明即唯一出现） | `grep -rn BIN_NAME release/scripts` = 1 命中 |
| `verify-versions.js:18` `mode === '--all'` | **死**：唯一调用方 `package.json:17` 与 `bump.sh:27` 都传 `--core`；`--all` 无调用者 | 且 `else` 分支的错误文案已说「本仓只支持 --core」 |
| `cred.sh:46` `idx()` | **死**：定义即唯一出现，无调用 | `grep -cn idx cred.sh` = 1 |
| `cred.sh:127` `backup)` 子命令 | **不是死代码**：用户可见子命令（`cred.sh backup <目录>`）。**不要删** | 有用法文案与 `DSH_CRED_BACKUP_DIR` 支持 |
| `publish-core.sh:26/57/102` `ALL` 与 ALL=1 块 | **不是死代码**：`ALL` 是真实开关；且 `test/all-platforms-test.js:99`（T2-j）断言 publish-core 从 `_platforms.sh` 取矩阵 | **不要动 ALL 块**（删它需先改 T2-j，属不必要的跨文件耦合） |

### #32 standards-uniqueness U-1 真空转
- U-1 现在只 `fs.existsSync`（`standards-uniqueness-test.js:57-68`）：**文件存在 ≠ 门禁真读规范**。
- 实测各登记门禁是否提到自己的规范名（sans `.md`）：**只有 `layering-and-dependency-gate-test.js` = 0 命中**，
  其余 10 个均 ≥1（no-console / provider-gateway / directory / domain / acceptance 等）。
- 候选替代门禁：`test/dev-runtime-safety-gate-test.js:16` **自称**「判据（DEVELOPMENT-TRACK 5.3 铁律 R-2/R-3）」，
  但它只是**注释**里提到，并未读该规范。`DEVELOPMENT-TRACK.md:148` 则把 `layering-and-dependency-gate-test` 记为
  「（**开发轨道**）」门禁、`:375` 引用其 `CROSS_LAYER`。⇒ 登记表映射**有规范侧出处**，但门禁侧不引用规范。

### #33 acceptance A-5 只扫根级 .md
- `acceptance-standard-gate-test.js:84` `fs.readdirSync(ROOT)` 仅根级。
- **实测扩扫影响（重要，纠正作业单的预期）**：`release/README.md`、`release/runbooks/*` 里**没有** A-5 的
  VERDICT 词（验收结论/验收通过/已验收/交付完成/验收状态）→ 扩扫**不会**因此转红。
  `.github/pull_request_template.md:22` 有 `验收状态：待 CI 裁决`，**两词齐全 → 通过**。
  ⇒ A-5 扩容本身安全；「本机 npm test 指引」是**另一件事**（见下「部分修」），不要混为一谈。

### #34 build.yml precheck 注释
`.github/workflows/build.yml:95-98`：注释称「四平台齐备后构建矩阵不再运行」，而 build 矩阵是**每次 push/PR 都跑**的
（必跑，不得条件跳过）；`need_build` 只作用于 release 与 `--publish` 步骤。改注释即可。

### #35 RELEASE-STANDARD §4 残留
`RELEASE-STANDARD.md:131`：「把条件 job（`build`/`release`）设为 required 会让 PR 永久阻塞」——
`build` 现已每次都跑，不该再被称作「条件 job」。限定为 `release`。

### #36 layering 头注与 L-3 空转
- 头注过时引用：`:19` 称 root 为「`src/core.cjs` 打包入口」，但 **`src/core.cjs` 不存在**（`ls` 失败）；
  `:23/:151/:199` 仍写「domains/guard/api」而 `guard/` 已在步骤 6 并入 `app/`（`:145` 自己就这么写）。
- **L-3 空转（已确认机理）**：`CROSS_LAYER['platform -> root']` **不存在**（该键无定义）→
  `allowedRoot = CROSS_LAYER[...] || {}` 得空对象；而 platform→root 的**真实 import 边为空**
  （`deploy.js` 里的 `core.cjs` 只是字符串路径判断，非 require）→ `platRoot.length === 0` →
  `undeclared.length === 0` **恒真**。⇒ 判据当前**不证明任何事**。修法：补**合成样本**反向自检
  （构造一条未登记 platform→root 边必须被检出），并如实登记「当前真实边 = 0」。

### 部分修 · release 侧「本机 npm test」指引（须与本批同改）
实测命中（`grep -rn "npm test\|ci-core"`）：
- `release/README.md`：:145 / :173 / :177 / :189 / :190 / :210 / :215 / :250 / :251 / :275 / :294 / :304 / :305 / :326
- `release/runbooks/publish-and-verify.md`：:28 / :39 / :40 / :46 / :49
- `.github/pull_request_template.md`：**无** `npm test` 指引（仅 :22 的 CI 裁决声明，已合规）

### 部分修 · DIRECTORY §3 目录树漂移
实测可疑行：`:115`（`fixed-ports / lifecycle-registration`）、`:123`（`command / installer / binding`）。
**必须逐条对照当前 `ls` 实测树**再改，不得照抄本行号。

---

## 1. 分派（文件互斥，无重叠）

| 执行者 | 独占 | 任务 |
|---|---|---|
| **P4-D-1** | `test/**` | #32（U-1 加严 + 登记表映射）、#33 门禁侧（A-5 扩扫 `release/**`、`.github/**`）、#36（layering 头注 + L-3 去空转） |
| **P4-D-2** | `release/**`、`.github/**` | #31（`ci-core.sh` ALL_PLATFORMS、`publish-core.sh` BIN_NAME、`verify-versions.js --all`、`cred.sh idx()`）、#34、release 侧「本机 npm test」收敛 |
| **P4-D（我）** | 根级 `*.md` | #35、DIRECTORY §3 目录树逐条核对、本报告 |

## 2. 交付与纪律
- 报告：`design-notes/_p4-d-gates-docs.md`（我汇总；下级各写 `_p4-d1-*.md`、`_p4-d2-*.md`）。
- **链条不得新增条目**（余量 101 字符）：`test/` 改动只能并入既有文件，禁止新建 `*-test.js`。
- **不得为凑绿放宽既有判据**；每处加严/放宽都要写理由 + 反向自检。
- 禁跑测试/门禁、禁 `require`、禁 git 写、禁操作者绝对路径。
