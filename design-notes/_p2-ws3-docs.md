# WS3 文档子代理报告（`_p2-ws3-docs`）

> 范围：A2 残留收敛（测试只能由 CI 裁决）+ `NO-CONSOLE-WINDOW-STANDARD.md` 悬空路径。
> 约束遵守：未运行任何测试/门禁（无 `npm test`、无 `node test/*.js`）；无任何 git 写操作；只做 read/grep/glob/edit/write；
> 未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`；只改派工单列出的 3 个文件；
> 改动文本与本报告均不含操作者绝对路径。

## 1. 改动文件清单（旧 → 新）

### 1.1 A2 残留：本机实跑测试 → 测试一律由 CI 裁决

| # | 文件:行 | 理由 | 旧 → 新 |
|---|---|---|---|
| A2-1 | `EXECUTION-CONTRACT.md` §2 第 5 条（原 :34） | 原文要求本机「实跑相关测试」，与 `ACCEPTANCE-STANDARD.md` §0「所有测试一律不得在本机执行」冲突 | `node --check` + `require` 加载 + **实跑相关测试**； → `node --check` + `require` 加载；**测试一律由 CI 裁决，本机不得跑测试**（见 `ACCEPTANCE-STANDARD.md` §0）； |
| A2-2 | `EXECUTION-CONTRACT.md` §4 第 6 条（原 :103） | 原文要求本机「跑该域全部相关测试 + 两个门禁」 | `**实跑**：改完必须跑该域全部相关测试 + …` → `**测试裁决**：改完推送后，该域全部相关测试 + `directory-structure-gate` + `layering-and-dependency-gate` 一律由 CI 裁决（本机不得跑测试）。` |
| A2-3 | `DOMAIN-STRUCTURE-DESIGN.md` §7（原 :275） | 原文迁移纪律含本机「跑相关测试」 | `先 `node --check` → require 加载 → 跑相关测试 → 再提交。` → `先 `node --check` → require 加载 → 再提交（推送后相关测试一律由 CI 裁决，本机不得跑测试）。` |

### 1.2 `NO-CONSOLE-WINDOW-STANDARD.md` 悬空路径

| # | 文件:行 | 理由 | 旧 → 新 |
|---|---|---|---|
| B-1 | `NO-CONSOLE-WINDOW-STANDARD.md` :27 | 注记称「诊断时位置 / `guard/` 已重构」；路径更新后该表述过期 | `> 以下路径为**诊断时位置**；`guard/` 等目录其后已重构为 `app/`，当前实现以 §4 门禁的实际扫描为准。` → `> 以下路径为**当前实现位置**；早期行号已随重构失效，故主进程与 daemon 两项不再钉行号，具体以 §4 门禁的实际扫描为准。` |
| B-2 | `NO-CONSOLE-WINDOW-STANDARD.md` :29 | `src/guard/supervisor/main-process.js` 全仓不存在；主 DSH 进程现由 `src/app/main/process.js` 启动 | `src/guard/supervisor/main-process.js:46` → `src/app/main/process.js`（去掉过期行号） |
| B-3 | `NO-CONSOLE-WINDOW-STANDARD.md` :30 | `src/guard/proc/daemon-lifecycle.js` 全仓不存在；受管 daemon 进程 spawn 在 `src/app/daemons/process.js`，监督拍在 `src/app/daemons/supervise.js` | `src/guard/proc/daemon-lifecycle.js:224` → `src/app/daemons/process.js`（受管进程 spawn）/ `src/app/daemons/supervise.js`（监督）（去掉过期行号） |

## 2. 未改而登记的问题（不猜，仅登记）

### 2.1 `NO-CONSOLE-WINDOW-STANDARD.md` :33-35 —— 整段「其余缺 windowsHide」路径与论断均已过期

该段每条同时存在三个问题：① 旧相对路径已不存在；② 行号已漂移/越界；③ 现代码经统一封装 `src/platform/os/spawn.js` 后 `windowsHide` 已固定，故「缺 windowsHide」这一论断已不成立。**只替换路径会让整句仍然错误**，需要一次独立的语义重写（不在本轮 A2/B 授权的最小改动内），故原样保留。逐条证据：

| 旧引用 | 现状（glob/read 证据） |
|---|---|
| `domains/dist/index.js:522`（npm 安装） | `dist` 域已解体；`glob src/platform/distribution/*.js` = {index,policies,registry,install,release}.js；npm 安装 `runNpmInstall` 在 `src/platform/distribution/install.js:86`。`index` 与 `install` 二义，不猜。 |
| `domains/relay/frpmgr.js:188` | `frpmgr.js` 不存在；frpc 进程托管现为 `src/domains/relay/frp.js`，安装/解压为 `frp-install.js`；`frp.js:12` 已含 `windowsHide`。 |
| `domains/shell/index.js:256/269` | 现 `src/domains/shell/index.js` 仅 24 行（纯门面）；spawn/重启在 `src/domains/shell/restart.js:55`（已含 `windowsHide`）。 |
| `guard/native/manager.js:736`（npm 卸载） | `guard/native/` 不存在；npm 卸载现为 `src/app/native/ops.js:194`（经 `spawnOS.piped`，封装固定 `windowsHide`）。 |
| `guard/proc/daemon-lifecycle.js:76` | 同 B-3，现为 `src/app/daemons/process.js`。 |
| `platform/os/browser.js:30/39/113` | 现 `src/platform/os/browser.js`，经 `spawnOS.detachedIgnored`（`spawn.js` 固定 `windowsHide:true`）。 |
| `platform/os/notify.js:69` | 现 `src/platform/os/notify.js` 仅 66 行，`:69` 越界；经 `spawnOS` 封装固定 `windowsHide`。 |

说明：这些旧引用**不带 `src/` 前缀**，新门禁 `test/docs-reference-gate-test.js` 的 DR-1 只匹配 `src/...` 字面量，故不检查它们；保留不会使 DR-1 变红。

### 2.2 `NO-CONSOLE-WINDOW-STANDARD.md` :31 —— 按指令保留，但行号/语义已漂移

- 任务指定 `src/domains/router/providers/proxy.js:272`「已存在可保留」，故未改路径与行号。
- 登记：`proxy.js:272` 现为 `markBanned`（非 spawn）；反代实例 spawn 现为 `src/domains/router/providers/probe.js:80`（`spawnOS.piped` + `detached:true`，封装固定 `windowsHide`）。若后续收紧，建议改为 `probe.js` 并去行号。

### 2.3 `EXECUTION-CONTRACT.md` 其余「测试」表述（不改，登记）

- §6 :116 「该域（或子块）的全部相关测试通过」与 :118 两个门禁「不退化」是**完成判据**（由 CI 裁决），非本机执行指令；保留原意，未改。建议后续补一句「由 CI 裁决」以免误读。
- §5 :111 「你自己负责最终验证」指静态自检 + 推送后 CI，非本机跑测试；保留。
- §8 :101「同步改测试」指迁移时修改测试源码指向（编辑测试文件），非本机执行；保留。

## 3. grep / glob 证据

1. `grep`（`*.md`，模式 `实跑|跑相关测试|跑该域全部相关测试|实跑相关测试|本机.*测试|测试一律`）：三个目标文件内命中的本机执行指引只有
   `EXECUTION-CONTRACT.md:34`、`EXECUTION-CONTRACT.md:103`、`DOMAIN-STRUCTURE-DESIGN.md:275`；其余命中均为 `design-notes/` 过程记录或其它文档（不在本任务文件范围内）。
2. `glob src/app/main/*.js` → 含 `process.js`；`glob src/app/daemons/*.js` → 含 `process.js`、`supervise.js`。确认候选路径真实存在。
3. `grep spawn\(` over `src/`：`src/app/main/process.js:45` = `spawnOS.piped(..., { detached: true })`；`src/app/daemons/process.js:156` = `spawnOS.detached(...)`；`src/app/daemons/supervise.js` **无** spawn（仅有监督拍 `_daemonSuperviseOnce`）。
4. `read src/platform/os/spawn.js`：`detached`/`piped`/`detachedIgnored` 三个入口均把 `windowsHide: true` 固定为不可覆盖项（:25/:42/:57）。
5. `grep windowsHide` over `src/`：`src/platform/os/browser.js:7`、`src/platform/os/notify.js:8`、`src/domains/relay/frp.js:12`、`src/app/daemons/process.js:155` 均已存在 → 佐证 2.1 的「论断过期」。
6. `read test/docs-reference-gate-test.js`（未跟踪新文件）：DR-1 = 根级 `*.md` 中每个 `src/...` 字面量必须可解析（允许省略 `.js` 与 `:行号`）；`design-notes/`、`CHANGELOG.md` 等排除。
7. 以与 DR-1 相同的静态算法（read + `fs.existsSync`，非执行测试）检查三个目标文件：
   - 改前：`NO-CONSOLE-WINDOW-STANDARD.md` 有 2 处 MISS —— `src/guard/supervisor/main-process.js`、`src/guard/proc/daemon-lifecycle.js`；
   - 改后：三个文件 0 处 MISS；`src/domains/router/providers/proxy.js`、`src/app/assembly/compose.js`、`src/supervisor.js`、`src/app/ctl/facades.js`、`src/app/domain-actions` 均存在。
8. 改动文本绝对路径扫描：三个文件与本报吿均无 `/home/<name>` 或 `C:\\Users\\<name>` 形态。

## 4. 约束与未执行项

- 未运行任何测试/门禁（含未执行上述任何 `test/*.js`，也未执行 `test/docs-reference-gate-test.js`）；本报告第 3.7 条为等价的静态存在性复核，非 CI 结论。
- 未做任何 git 写操作；未改 3 个列出的文件之外的任何文件。
- 本次改动全部为 Markdown，无 JS 变更，故无 `node --check` 目标。
