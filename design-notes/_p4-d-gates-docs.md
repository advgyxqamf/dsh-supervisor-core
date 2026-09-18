# P4-D 报告：门禁 + 制度债 + release + 文档

> 负责：P4-D（主控）。独占 `test/**`、`.github/**`、`release/**`、根级 `*.md`。
> 依据：`_workorder-phase4.md` §3 P4-D 行；积压 `_p3-e-audit-backlog.md` #31/#32/#33/#34/#35/#36 + 2 项「部分修」。
> 侦察与分派记录：`design-notes/_p4-d-recon.md`（含全部实测 file:line 证据）。
> 下级报告：`_p4-d1-gates.md`（P4-D-1，test/**）、`_p4-d2-release.md`（P4-D-2，release/** + .github/**）。

## 0. 分派（文件互斥、无重叠）

| 执行者 | 独占 | 任务 |
|---|---|---|
| P4-D-1 | `test/**` | #32、#33（门禁侧）、#36 |
| P4-D-2 | `release/**`、`.github/**` | #31、#34、#33（文档侧「本机 npm test」收敛） |
| P4-D（本报告） | 根级 `*.md` | #35、DIRECTORY §3 目录树 |

## 1. P4-D 本人完成的项

### #35 RELEASE-STANDARD §4「条件 job（build/release）」残留 —— 已修
- 位置：`RELEASE-STANDARD.md:131`（原句：「把条件 job（`build`/`release`）设为 required 会让 PR 永久阻塞」）。
- **缺陷**：`build` 矩阵如今**每次 push / PR 都跑**（`build.yml` 必跑、不得条件跳过），
  只有 `release` 仍受 `need_build` 影响（同文件 §4 上文 :118-122 已如此写明）——原句把两者并列为「条件 job」，与本文自身矛盾。
- 修法：限定为 `release`，并顺带写明「`build` 矩阵每次 push/PR 都跑 ⇒ 可作为 required」。
- 证据（改后自检）：
  - A-5 判据：本文件 `verdict=0`、`ciref=2` → 不触发、不误报；
  - `release-spec-consistency` 的 P-2c（`npm run X` 必须存在于 scripts）：本文件 4 处 `npm run`（build:launcher / build:launcher:all / publish:core / verify:versions）**未新增、未删除**，我核了 4 者均在 `package.json#scripts`；
  - DR-1（根级 .md 的 `src/...` 必须可解析）：改后**零 MISS**；
  - 无任何测试钉住被删短语（`grep test/` 对「永久阻塞」「条件 job」= 0 命中）。

### 部分修 · DIRECTORY-STRUCTURE-DESIGN §3 目录树漂移 —— 已修（逐条核对）
**方法**：先用 `ls` 实测全树，再逐条比对 §3 每一行的**左侧名字**是否真实存在；
**关键区分**：行内的 `← old/path` 是**迁移来源注记**（有意保留历史），只校左侧现行名。
批量自检脚本对 §3 全部 20 行、约 120 个名字逐一 `test -e` → **零 MISS**。

| 行 | 原（不存在） | 改为（实测存在） |
|---|---|---|
| `router/` | `instances/`（P3-D 已删该 shim 目录） | `providers/ handlers/ model/ ops/ store/ policies/` + 12 个现行文件 |
| `relay/` | `gate`（无此文件；实际为 `core.js`） | `ops/` + `index/core/daemon/frp/frp-install/managed/ops/proxy/session/tunnel/ports/port-segments/contract` |
| `instance/` | `core`（无此文件） | `ops/` + `index/lifecycle/ops/model/sandbox/state-machine/store/upgrade/contract` |
| `app/assembly/` | `fixed-ports`、`lifecycle-registration`（两者全仓 0 命中） | `api-rebind / bootstrap / collaborators / compose / facets / log-sources` |
| `app/state/` | `config-patch`、`migrate`（均不存在于 app/state） | `store / fields / field-tables / main-store / main-record / desired / phase / upgrade-hold / intents / collaborator` |
| `app/native/` | `binding`（不存在） | `command / installer / manifest / npm / ops / policies / probe / upgrade` |
| `platform/os/` | 「12 文件不动」 | 「11 个 .js + autostart/ + pidlookup/」（实测 `ls src/platform/os/*.js` = 11） |

**登记的超范围发现（只报告，未改）**：
- §3 的目录树用**裸名**（无 `src/` 前缀），故 `docs-reference` 的 DR-1 **不会**校验它 ——
  这正是 P3-B 登记的「DR-1 裸路径缺口」（其结论：上下文相对、不可静态判定，改用「写 `src/` 全前缀」的文档约定）。
  本次靠人工 `ls` 实测纠正，**下次仍会漂移**；若要机器化，需先落实该文档约定。
- `shared/guardian.js` 的迁移来源注记写 `← guard/guardian/`（`:78`）：`guard/` 已在步骤 6 并入 `app/`。
  作为**来源**注记属历史、非现状，故**未改**（与「左上侧必须存在」的判据不同维度）。

## 2. P4-D-1 / P4-D-2 交付（摘要，详见各自报告）

（见 §3 汇总，待下级报告落盘后填入）

## 3. 全局自检

- X-2（全树 `.md` 不得含操作者绝对路径）：仅 `CHANGELOG.md` 命中（门禁显式排除）；
- 我本人改动仅 2 个根级 `.md`，**未碰任何 `src/**`、`test/**`、`release/**`**（工作树里的 `src/**` 改动属并行兄弟工作流 P4-A/B/C）；
- **未运行任何测试/门禁、未 `require` 产品代码、未做 git 写、未启 daemon、未碰状态根与 `/tmp/dsh-*`**；
  全部结论以静态判据（`ls`/`grep`/`node --check`/`bash -n`/只读 `git`）得出，**最终以 CI 裁决**。
