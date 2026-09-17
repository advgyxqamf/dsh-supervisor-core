# 作业单：第四阶段（清空 AUDIT 积压）

> 主控生成。**所有 P4 子代理必读**。承接 P2/P3 作业单（其 R1/R2 铁律与 `grep -oP '\p{Han}{4,}'` 工具陷阱仍然有效）。
> 工作面板 = `design-notes/_p3-e-audit-backlog.md`（唯一完整积压清单：未修 36 = P1 12 / P2 19 / 门禁制度债 5）。
> 主控统一提交推送；子代理只改工作区。

## 0. 硬约束（违反即整批作废）

1. **禁本机跑任何测试/门禁**：只可 `node --check` / `bash -n` / `grep` / `read` / `wc` / 只读 git。
   **禁止 `require` 产品模块并执行、禁止内存冒烟**（P3 有代理越界，已明确纠正；需要此类验证时改为静态判据 + 反查消费点，实测交 CI）。
2. **禁一切 git 写操作**。
3. 不启 daemon；不碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
4. 不给 `package.json#dependencies` 加包。
5. **文件独占**：只改分配给你的文件；需跨界先报告。
6. 新增/修改 .md 不得含操作者绝对路径（X-2 扫全树 .md）。
7. **链条余量只剩 101 字符（7899/8000）**：新增判据必须**并入既有门禁文件**，不得新增 `scripts.test` 条目；若必须新增文件，先合并/退役一个旧条目。

## 1. 两条铁律

- **R1（注释）**：删/改注释前把该行切成 ≥4 字 CJK 与 **≥6 字符 ASCII** 串，逐 token 在 `test/` grep（CJK 必须 `grep -oP '\p{Han}{4,}'`）。命中即保留并登记。**不得改 `test/`**（除 P4-D）。
- **R2（死代码）**：删任何导出/函数/常量前，**原始 `grep -rn` 全仓核验**（含 `test/`、`bin/`、**根级 *.md 与 design-notes**）。**有消费者即不得删**。
  ⚠ **`release/scripts/export-consumers.sh` 在修复前不可作为删除依据**（P4-C 发现、主控复现）：它的定义行判据含**裸子串**匹配 `sym( ... ) {`，无词边界，于是门面转发器
  `_sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }` 被判为**定义行**（`_sandboxTarget(inst) {` 含 `sandboxTarget(inst) {` 子串）→ 该文件内**真实生产消费点被藏进"定义文件"** → 误报「可删」。
  实测：`sandboxTarget --defs` 把 `plugin/index.js` 列为定义文件，而它 :44 正是**生产注入消费点**。同型 4 例（`sandboxTarget/allSandboxTargets/targetRunning/applyPluginChange`）。
  ⇒ 纪律：**每个「可删」候选必须原始 grep 复核 + 查同文件内 `this.<名>` 间接消费**；复核量太大时**只交付候选清单+证据、零删除**（本轮 P4-A 的 #29 删除数就是 0，完全可接受）。
  **工具侧的正确原则（已派 P4-D 修）**：不确定时按「消费者」处理 —— 假"可删"会删活代码（`rc.file` 式转红），假"不可删"只多一次人工确认，**代价不对称，必须向安全侧失败**。
  ⚠ **必须额外比对契约表**（P4-B 实战发现，本作业单原 R2 漏了这条）：`EXECUTION-CONTRACT.md` 的「**必须导出**」表是**硬契约**，表内符号即使"代码里零调用"也**不得删**。
  实例：积压 #23 想删 `router/model.js` 的 `stateContainer`，但 `EXECUTION-CONTRACT.md:61` 逐字列它为必须导出 → **误判，已回退**。
  正确路径：**同批修订契约表**（属 P4-D 的根级 .md 面）才可删；不得由 src 侧单方删。这与 `f410a3a`（`contract/runtime.js` 的 `file`，漏了测试消费者）是**同一类失误：R2 的扫描面不完整**。
  ⚠ **`{methods}` 门面：EX 的"定义文件之外消费者=0"是假阳性**（P4-A 实战发现）。门面方法常被**同文件内**的兄弟方法以 `this.<名>()` 调用，而 `this` 是宿主、方法由门面统一安装 —— EX 只看「其它文件」故会误判可删。
  实例：`settings/versions.js` 的 `_vcsRoot()`（:77 定义）被 `:91`/`:112` 以 `this._vcsRoot()` 调用，EX 报「可删」。**删了会让两个调用点运行时失效**（`rc.file` 式转红）。
  ⇒ 对门面文件，必须**另查同文件内 `this.<名>` 的间接消费**；EX 结论对 `{methods}` 面只作参考。
   **泛型名不可用裸 grep 判定**：`has`/`any`/`cancel`/`_loaded`/`isAlive` 这类名字全仓有大量**同名但在别的文件、别的语义**的命中（如 `pool.js` 的 `_loaded` 是**活字段**、`pidlook.isAlive` 是**另一个实现**）。必须按「**文件 + 符号 + 该文件的调用形态**」核验，不得按名字计数。
  ⚠ **#29「63 条未用导出」不得照抄旧清单**：P2/P3 已删过一批，必须**重新枚举当前树**再逐条核验。
  ⚠ **#29「63 条未用导出」不得照抄旧清单**：P2/P3 已删过一批，必须**重新枚举当前树**再逐条核验。

## 2. 已完成、不要再做（主控已复核）

积压 P1 #1（熔断实参）、#7（registry ownership 合并）、#8（projection BACKOFF healthy）、#9（entry.stop 落 desired）
已于 P3（`fa470bb`/`5be724e`）修复并经 CI。**不要重复修改**；若发现修复不完整，报告指出而非重做。

## 3. 独占分区与任务

### P4-A：instance + settings（owns `src/domains/instance/**`、`src/app/settings/**`）
| 积压# | 条目 | 要点 |
|---|---|---|
| 4 | 实例端口变更后旧 `inst:*` 登记永久泄漏 | `instance/store.js:71-85` 只做「缺则补 + 实例删除则清」；补按 owner 对账：`byOwner('inst:'+id)` 与 `inst.port` 不一致则先 unregister 再 register |
| 11 | instances.json 解析失败静默清空 | `instance/store.js:29` `catch { this._replace([]); }` → 先 `logger.warn` + 备份损坏文件再清空 |
| 10 | `inst.sandbox` 未 guard | `instance/ops.js:116-117` 直接 `inst.sandbox.memoryMax = ...` → 先 `inst.sandbox = inst.sandbox || {}` |
| 6 | 密钥/关闭行为持久化失败仍回 `ok:true` | `settings/access.js:21-23/:42-44` 无条件 `return { ok: true }` → `persistConfigPatch` 返回成败并透传，失败回 `{ok:false,error}` |
| 30(部分) | `instance/model.js` 的 `taskStateToView` 与 `plugin/model.js`、`ops/apps-registry.js` 三份平行实现 | 低风险做法：加注释说明「有意平行」并交叉引用；抽公共函数需三处同批（本仓跨域，慎重） |
| 29(部分) | `src/domains/instance/**` 的零消费者导出 | 用 EX 工具重枚举后逐个核验再删 |

⚠ #6 会改变返回契约（原来恒 ok:true）：**必须写行为变更声明**，并 grep `test/` 确认无断言钉住「持久化失败仍 ok:true」。`settings/access.js` 是 P3-A 刚改过的文件（lanClosed），**不要回退该逻辑**。

### P4-B：router + relay + api/dist（owns `src/domains/router/**`、`src/domains/relay/**`、`src/api/domains/dist.js`）
| 积压# | 条目 | 要点 |
|---|---|---|
| 2 | 非流式响应体收到头后无任何超时（可永久悬挂） | `forward.js:68` 有 streamRequested；对非流式 `ur` 设总时长上限，或 writeThrough 加读超时 |
| 5 | 应用更新步骤集是创建时快照，常驻实例静默空转 | `ops/apps-registry.js:98/106` 直接用 `insts[i]` → 执行时按 keyId 重取 |
| 12 | `/dist/registry/probe` 目标 host 由请求体控制（盲 SSRF） | `api/domains/dist.js:39` 只校验 `^https?://` → host 白名单 + 禁止重定向 |
| 17 | `startProviderServer` 未在 listen 前占位 | `router/endpoint.js:59/63` 仅在 listen 回调写 map → 并发二次 listen/漏 close |
| 20 | 只读视图内发生写副作用 | `router/views.js:83` 调 `p._ensureLimit(a)`（会写 `acc.limit`） |
| 16 | OAuth 重新发起对上一 Promise reject 可能 unhandledRejection | `router/ops/oauth.js` 仅 `reject(err)` → reject 前 `.catch(()=>{})` 自吞 |
| 23 | `router/model.js` 的 `stateContainer` 导出零消费者 | 删导出键（函数体留给 ProxyInstance 内部） |
| 15 | credits 冻结维持分支不补 `nextResetAt`（探测风暴） | `providers/policies/freeze.js` 维持分支写 `nextResetAt` |
| 18 | frp 启用但 `serverAddr` 为空仍 start frpc | `relay/frp.js:55` → settings 归一校验非空，否则拒绝启用 |
| 19 | 受管清单 main 优先级与注释不符 | `relay/managed.js:24` `[...sandboxes, main]` 而 `findManaged` 从左取首 → main 放头部或修正注释 |
| 30(部分) | `ops/apps-registry.js` 的平行实现 | 见 P4-A #30 口径 |
| 29(部分) | router/relay 的零消费者导出 | 同 P4-A |

⚠ #1 已修，**不要再动 forward.js 的熔断实参**；#2 是同文件另一件事。`relay/managed.js` 刚被 P2 加过 `all()`（DG-11），不要回退。

### P4-C：platform + plugin + shell + app-state/control（owns `src/platform/**`、`src/domains/plugin/**`、`src/domains/shell/**`、`src/app/state/**`、`src/app/control/**`、`src/app/assembly/bootstrap.js`、`src/plugins?` 无）
| 积压# | 条目 | 要点 |
|---|---|---|
| 3 | 插件市场后台刷新无 `.catch` → unhandledRejection | `plugin/market.js:78/85` 均 `buildIndex().finally(...)` → 加 `.catch(warn)` |
| 13 | 插件更新检测对失败结果做 6h 负缓存 | `plugin/updater.js:23` → 仅 `latest !== null` 才写 `_updCache` |
| 14 | journal pending 无时效上限 | `shell/watchdog.js:78-80` → 加时效，或与 `phaseMaxAgeMs` 对称 |
| 21 | `platform/os/process.js` 的 `isAlive` 导出零消费者 | `process.js:10/41` → 删函数体与导出（唯一生产实现是 pidlookup/probe） |
| 22 | `TaskRegistry.cancel` 零调用 | `platform/service/tasks.js:215` → 删除或接入真实取消路径（**接入优先**：若 canceled 态有价值则接入） |
| 24 | 令牌恢复文件名注入写而不读 | `platform/service/token/persist.js:153/161-170` + `app/settings/token-kinds.js` → 删 `configureTokenFileName/tokenFileName/_tokenFileName/DEFAULT_TOKEN_FILE_NAME` 与调用点 |
| 27 | `log/logcore.js` 的 `LineBuffer` 未使用 | `logcore.js:10` → 从解构去掉 |
| 28 | `app/assembly/bootstrap.js` 的 `registerAll` 未使用 | `bootstrap.js:11` 全文件仅此一处（真正调用在 compose/observers.js） |
| 25 | `state/intents.js` 的 `has()`/`any()` 零调用 | `intents.js:36/41` → 删两方法（注释声称的用法不存在） |
| 26 | `control/registry.js` 的 `_loaded` 只写不读 | :49/:88 仅赋值（`_loadedFromDisk` 是另一个、**有读**，不要误删） |
| 30(部分) | `plugin/model.js` 的平行实现 | 见 P4-A #30 |
| 29(部分) | platform/plugin/shell/app 的零消费者导出 | 同 P4-A |

⚠ `bootstrap.js` 有 6 条心跳结构钉子（R1），只删 :11 的 require 行、不动心跳代码。`control/registry.js` 刚被 P3-A 改过 ownership 合并，不要回退。

### P4-D：门禁 + 制度债 + release + 文档（owns `test/**`、`.github/**`、`release/**`、根级 `*.md`）
| 积压# | 条目 | 要点 |
|---|---|---|
| 31 | 发布脚本死分支/死变量 | `ci-core.sh:21/41`（`ALL_PLATFORMS` 恒 0）、`publish-core.sh:111`（BIN_NAME）、`verify-versions.js:18`、`cred.sh idx()/backup`；⚠ `publish-core.sh` 的 ALL=1 块须先改 `test/all-platforms-test.js` T2-j |
| 32 | standards-uniqueness U-1 只断言「文件存在」（真空转） | 加「门禁源码须引用规范文件名/正文」的判据；`layering` 门禁根本不提 DEVELOPMENT-TRACK（名义映射，属登记表错误） |
| 33 | acceptance A-5 只扫根级 .md | 扩到 `release/**`、`.github/**` 的 .md（**注意**：扩扫会命中 `release/README.md`、runbooks、PR 模板里的「本机 npm test」指引 → 必须**同批**修正它们，见下） |
| 34 | build.yml precheck 注释称「四平台齐备后不再运行」 | `.github/workflows/build.yml:97-98` → 改为「need_build 只作用于 release 与 --publish 步骤」 |
| 35 | RELEASE-STANDARD §4 残留「条件 job（build/release）」 | `RELEASE-STANDARD.md:131` → 限定为 release |
| 36 | layering 头注记载不存在的 `guard/dist/core.cjs`；L-3 `\|\| {}` 空转 | `layering-and-dependency-gate-test.js:15/16/204` |
| 部分修 | `release/README.md`、`release/runbooks/*`、`.github/pull_request_template.md` 仍要求本机 `npm test`/`ci-core` | 收敛到 ACCEPTANCE-STANDARD 硬标准 |
| 部分修 | `DIRECTORY-STRUCTURE-DESIGN.md` §3 树内 `fixed-ports/lifecycle-registration/binding` 等与现状不符 | 逐条核对当前树后更正 |

⚠ `test/` 由你独占，但**不得为凑绿而放宽既有判据**（假绿门禁比没有更坏）。每处放宽/加严都要写清理由与反向自检。
⚠ 你改 `test/` 时链条不得新增条目（余量 101 字符）。

### P4-E：存疑 7 项「逐路径确认」（**只读**，仅写 `design-notes/_p4-e-uncertain.md`）
积压 §3.2 的 7 项：F9（看护陈旧相位告警只发一次）、D9（`install()` 是否缺 try/finally 释放 installing）、D10（daemon 异主判定未用 classify）、D11（guardian 语义不一致）、D12（stopProcess「停止落空」）、ARCHITECTURE-ACCEPTANCE 数字漂移、§5 域内目标超限 8 文件。
要求：**逐调用链走查**给出「真缺陷 / 非缺陷 / 需运行期证据」定性 + file:line 证据 + 若为真缺陷给最小修法。真实数字类（文件行数/链长）请**实测当前树**并给出数值。
**你只读**：不改任何 src/test，修法由主控另派。

## 4. 纪律

- 每项独立最小改动 + 独立 `node --check`/`bash -n`。
- **行为变更必须声明**（状态码/返回/日志/持久化形状）。
- 交付报告 `design-notes/_p4-<工作流>.md`：逐项 改动/证据/行为变更/CI 风险；**不得含操作者绝对路径**。
- 每个工作流**必须派生 1-3 个下级**做文件互斥切分，分配表落报告（P4-E 除外，它派 1 个下级分担走查）。
