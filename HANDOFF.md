# 交接文档（HANDOFF）

> 生成时间：会话中断时。目的：让新会话能**零上下文**接手未完成工作。
> 本文件是**过程文档**，不是规范。

---

## 0. 一句话现状

仓库 `/home/bowen/develop/plus`，分支 `fix/native-dsh-takeover-beta7`。
**工作区有 297 个未提交改动**（架构归一化 + 8 项缺陷修复 + 注释符号清除）。
最后一次通过 CI 的提交是 `a764f7e`（四平台 + test job 全绿）。
**这 297 个改动尚未提交、尚未经过 CI。**

---

## 1. 必须遵守的硬约束（违反即作废）

1. **绝对禁止在本机运行任何测试**（`npm test` / `node test/*.js` / 门禁）。
   这是仓库硬标准，见 `ACCEPTANCE-STANDARD.md` 与 `.github/workflows/build.yml` 第 6 行。
   只允许：`node --check`（语法自检）、`grep`、`wc`、`git status`。
   **验收只能由 CI（四平台矩阵）裁决。**
2. **绝不启动守卫/daemon 进程**；不碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
   历史事故：`rm -rf /tmp/dsh-*` 曾杀掉用户正在运行的 DSH。清理只按**具名路径**。
3. **不发布新版本**（用户明确要求）；但**可以推送**（推送用于触发 CI）。
4. 不得给 `package.json` 的 `dependencies` 加任何包（内核零运行时依赖，T6-a）。

---

## 2. 已完成（在工作区，未提交）

### 2.1 架构归一化（前几轮，已提交）

- `src/supervisor.js` 1319 行 → 78 行；全域 `Object.assign(X.prototype, ...)` 归零
- 五层结构：`shared` / `platform` / `domains` / `app` / `api`
- 五域 `contract.js` 建立（instance/plugin/relay/router/shell）
- `app` 级 2 真 ctor 注入：`state` / `session` / `control` 工厂化

### 2.2 门禁（已提交）

- `domain-structure-gate-test.js`：DG-1..DG-16（`DG_STRICT=1` 全绿）
- `directory-structure-gate-test.js`：`GATE_STRICT=1` 全绿
- `acceptance-standard-gate-test.js`：A-1..A-6（含 CI 步骤与四平台矩阵校验）

### 2.3 本轮新增（**未提交**）

**A. 8 项缺陷修复**（每项都有 `design-notes/FIX-N.md`）：

| 编号 | 缺陷 | 文件 |
|---|---|---|
| FIX-1 | **frp 公网暴露闸绕过**（`!!p.frpEnabled` 赋值 vs `=== true` 判闸 → 空 token 可公网零认证触达特权 API）+ LAN CSRF + LAN 需 access key | `app/domain-actions/main.js`、`app/settings/lan-panel.js`、`api/security.js` |
| FIX-2 | `api-rebind.js` 用未定义 `ports`（应为 `portsShared`）→ 壳就绪判据永远失败；`bootstrap.js` 提前 return 跳过更新检查与壳看护；端口再推导忽略 `applyPort` 返回值 | `app/assembly/api-rebind.js`、`app/assembly/bootstrap.js`、`app/main/controller.js` |
| FIX-3 | native 卸载锁 TOCTOU；`startInstall` 缺 busy 闸；升级 hold 跨重启调用了**不存在的导出** | `app/native/ops.js`、`app/state/store.js` |
| FIX-4 | 受管目录单条坏 entry 截断整份加载；心跳两拍重叠；关停不校验 `stopUnit` 结果仍写 STOPPED | `app/control/registry.js`、`app/control/heartbeat.js`、`app/session/shutdown.js` |
| FIX-5 | **数据丢失**（查询失败被当成不活跃 → `rmSync` 删沙箱数据）；stop 假成功；安装永久卡 FAILED；回滚未先停新版本 | `domains/instance/ops.js`、`lifecycle.js`、`upgrade.js` |
| FIX-6 | **根因**：`platform/os/service.js` 吞掉 `run()` 失败恒返回 true → `_systemdStart` catch 永不进入 | `platform/os/service.js` |
| FIX-7 | `waitFrpcExit` 空操作 → frpc 孤儿占公网端口；probe 无条件清 `inst.pid` → 同端口双实例 | `domains/relay/daemon.js`、`domains/router/providers/probe.js` |
| FIX-8 | 反代实例假成功重启（非 force 停止）；API 失败恒回 200；`collectBody` 回调越界 | `domains/router/ops/apps-registry.js`、`endpoint.js`、`api/domains/instances.js`、`api/domains/router.js`、`api/transport/body.js` |

**注意：FIX-1 与 FIX-8 都改变了对外可观测行为**（状态码、错误返回、暴露闸要求），详见各自报告。

**B. 注释符号清除**：741 处装饰符号/emoji（框线、箭头、带圈数字、警示符等）已从 41 个文件的注释中清除。
保留中文正文与中文标点（`。，：；（）`）与 `—` 折号（正常标点，非表情）。语法核验：258 文件 0 损坏。

**C. 11 份审计报告**：`design-notes/AUDIT-*.md`（架构/业务×3/规范/文档/测试/plugin-shell/relay-instance/shared 等）。

---

## 3. 未完成（新会话的待办）

### 3.1 最优先：提交并跑 CI

297 个改动**未提交**。`a764f7e` 是最后一个 CI 绿点，之后的全部改动（含 8 项缺陷修复）**未经 CI**。

操作：
```
git add -A
git commit -m "..."          # 不加版本号
git push                     # 触发 CI（PR #20 已开，会重跑）
```
然后轮询 CI：
```
PAT=$(bash release/scripts/cred.sh get kernel)
curl -sS -H "Authorization: Bearer $PAT" \\
  "https://api.github.com/repos/advgyxqamf/dsh-supervisor-core/actions/runs?branch=fix/native-dsh-takeover-beta7&per_page=3"
```
**预期风险**：FIX-1..8 改变了行为，可能有测试断言钉在旧行为上而失败 —— **这正是 CI 的用途**。

### 3.2 注释精简（未做）

只做了**符号清除**，**没有做精简**。现状：src 注释占比仍偏高。
需删：复述代码的 WHAT、变更历史与日期叙事（`// 2026-09-13 修复…`，实测有大量）、
「本轮/之前/原来」过程记录、逐行解释。保留：非显然的 WHY、契约不变量、陷阱、跨平台差异。

### 3.3 死代码普查（J8，未完成）

K1/K4/K5 各清过一批（未用导出、死变量、重复实现）。**跨全仓的系统性普查未做**。
已知候选：
- `forwardMethods`、`auxMethods`（`router/forward-core.js`、`router-ops.js`）—— RT1 后无消费者
- `createOps` 返回的 `releaseProviderPorts` 包装无消费者
- `domains/router/instances/proxy-instance.js` —— 一行 re-export shim（SSOT 注明最终删除）
- `api/identity.js` —— 头注已过时，真实消费者可改指 `shared/ip` 与 `platform/security` 后删除
- `collaborators.js` 的 `SPEC`/`THIN_SPEC`/`THIN_NAMES`/`assertCollaboratorTargets` —— app 内零消费者
- `manager.restart` 死分支

### 3.4 规范收敛（未做）

审计（J5）发现的规范内部矛盾：

1. **A2（最高）**：`ACCEPTANCE-STANDARD.md` 明禁本机测试，但 `DEVELOPMENT-TRACK.md` §2/§5、
   `RELEASE-STANDARD.md` S4、`CREDENTIALS-STANDARD.md` §4 **仍指引本机 `npm test`** → 会直接诱导违规。
   应以上述唯一事实源收敛其余三份。
2. **B1**：`DOMAIN-STRUCTURE-DESIGN.md` 被 README 标为「唯一事实源」但**未登记进**
   `test/standards-uniqueness-test.js` 的 `STANDARDS` 表，且用「定版 SSOT」措辞**绕过 U-3** → 该 SSOT 无门禁保护。
3. **阈值矛盾**：`≤300` 与 `≤400` 在 6 处并存（SSOT、DIRECTORY、EXECUTION-CONTRACT、DEVELOPMENT-TRACK、README、门禁头注）。
   **门禁实跑用 300**，应统一为 300。
4. **E1**：10 份登记规范中只有 `release-spec-consistency-test` 真正读取规范正文；其余门禁不读文档 → 长期漂移根因。
5. **A3**：`package.json#_uninstallTests` 声称 `api-contract-test` / `plugin-change-restart-test`
   已被排除出链，实际两者**都在链中且 CI 通过** → 应删过期政策文本（移出链反而丢覆盖面）。
6. **悬空引用**：`GUARD-DOMAIN-MODEL.md`（引 `main-process.js`/`control-view.js`）、
   `KERNEL-DAEMON-CONTRACT.md`（D-1..D-8 vs 表列 D-1..D-5）、`DIRECTORY-STRUCTURE-DESIGN.md` §3 目录树漂移。

### 3.5 第三波新缺陷（审计与 FIX 报告中发现的，**未修**）

| 编号 | 缺陷 | 位置 |
|---|---|---|
| N1 | **`exec` 超时参数名不匹配**：调用方传 `{timeout: ...}`（或 `{timeoutMs}` 不一致），实现读 `timeoutMs` → **所有超时值失效、回落 15000** | `platform/util/exec.js` 与各调用方 |
| N2 | `bootstrap.js` 心跳 stall 阈值 `max(30000, iv*12)` 与 `.finally` 无条件清 `_heartbeatBusy`（两拍重叠的**根因**，FIX-4 只治了症状） | `app/assembly/bootstrap.js` |
| N3 | `guard.js` 状态码映射（`r.ok ? 200 : 500`）与 FIX-8 的 400 不一致 | `api/*guard*` 或 `app/*guard*` |
| N4 | `instance/lifecycle.js` 的 `stop(id)` 曾忽略 `stopUnit` 返回值（FIX-5 已改 lifecycle 的 stop，需确认覆盖完整） | `domains/instance/lifecycle.js` |
| N5 | `service.js` 的 `resetFailed` / `cleanTransient` 仍是「吞 null 恒返回 true」的同类模式 | `platform/os/service.js` |
| N6 | `relay/session.js` `refreshDshSession` 与在途 bootstrap 竞态，旧 cookie 可能覆盖新值 | `domains/relay/session.js` |
| N7 | `probe.js` 仍有 3 处箭头注释（符号清理后应已清，需确认） | `domains/router/providers/probe.js` |
| N8 | `frp-install.js` 把「取校验和失败=null」缓存进生命周期级 `_sumCache` → 一次离线后**永久跳过 sha256** | `domains/relay/frp-install.js` |
| N9 | `quota-strategies.js` `derivedMonthly` 缺 `hasCredits` 守卫 → credits 缺席时月窗口假 100% → **误冻账号** | `domains/router/providers/quota-strategies.js` |
| N10 | `forward.js` client-abort 不 destroy 上游 req → keep-alive socket 泄漏 | `domains/router/handlers/forward.js` |
| N11 | `instances/add` 原样接受 `command` 数组 → 可经 `systemd-run` 任意执行 | `api/domains/instances.js` |

（上表 N1/N3/N4/N5 是最高优先，N9/N11 涉安全与正确性。）

### 3.6 其他未做

- `app` 剩余 6 个切面（`ctl`/`daemons`/`main`/`views`/`audit`/`ui`）仍是薄委托，未工厂化（DF-5 在 app 层未完全达成）
- `DG-7` 的 rank 归类、`DG-11` 的 `instances.instances` 穿透（部分已由前轮处理，需复核）
- `docs-reference` 门禁（校验 SSOT 文档里的源码路径存在性）—— J6 建议新增，未做

---

## 4. 已知陷阱（踩过的坑）

1. **Windows 命令行长度**：`scripts.test` 是单条 `&&` 巨链，超过 cmd.exe 8191 上限时**只有 Windows 构建失败**。
   已用 `--require`→`-r` 压到 7711，并加门禁 **N-e**（`test-chain-completeness-test.js`）。**新增测试要留意长度。**
2. **测试指针静默失覆盖**：文件搬移后，「断言钉在源码形态/字符串上」的测试会**静默通过但失去覆盖面**。
   修法是改读目录聚合。已处理 30+ 处，但**新增重构时仍要检查**。
3. **门禁自锁**：`DG-2` 曾有「真实超限 ≥1」的非空转自检，全域清零后恒假。反向自检应使用**合成样本**，不依赖真实违规。
4. **子代理并发写同一文件**：必须按文件**独占**分配。本次出现过 K 组与 FIX 组文件重叠，靠中断解决。
5. **`git diff` 归因**：工作区有大量未提交改动，**不要用整文件 diff 判断某个子代理改了什么**。

---

## 5. 关键文件与命令

### 规范（唯一事实源）
- `ACCEPTANCE-STANDARD.md` —— 验收与测试（禁本机测试）
- `DIRECTORY-STRUCTURE-DESIGN.md` —— 目录结构与分层
- `DOMAIN-STRUCTURE-DESIGN.md` —— 域内结构（DF-1..DF-9，**未登记进 STANDARDS**）
- `EXECUTION-CONTRACT.md` —— 执行契约
- `DEVELOPMENT-TRACK.md` —— 改代码规则

### 本轮产物
- `design-notes/FIX-1..8.md` —— 8 项缺陷修复记录（含**行为变更**声明）
- `design-notes/AUDIT-*.md` —— 11 份审计报告（**含未修的完整缺陷清单**，比本文件更详细）

### 门禁
- `test/domain-structure-gate-test.js`（DG-1..16）
- `test/directory-structure-gate-test.js`
- `test/acceptance-standard-gate-test.js`（A-1..6）

### 凭据
- `bash release/scripts/cred.sh get kernel` → GitHub PAT（用于读 CI 状态、开 PR）
- SSH：`GIT_SSH_COMMAND="ssh -i /home/bowen/.ssh/id_ed25519_advgyxqamf -o StrictHostKeyChecking=accept-new" git push`

### PR
- 已开：https://github.com/advgyxqamf/dsh-supervisor-core/pull/20

---

## 6. 建议的接手顺序

1. **先提交 + 推送 + 看 CI**（3.1）。这是最快的价值验证，也能暴露 FIX-1..8 的行为变更是否破坏既有断言。
2. CI 绿后，做**规范收敛**（3.4，A2/B1/阈值 —— 都是文档与门禁常量，风险低）。
3. 再做**第三波缺陷**（3.5，N1/N3/N4/N5 优先）。
4. 最后做**注释精简 + 死代码普查**（3.2/3.3，机械工作，量最大）。

---

## 7. 上一会话的执行故障（供参考）

上一会话在「**在单个代码块里拼接多个长 prompt / 长文本**」这一步反复出现**只输出文本、未真正发起工具调用**的循环，
共发生 5 次以上，导致大量空转。

**规避建议**：
- 一次只发**一个**工具调用，代码块保持简短；
- 派发子代理时，**prompt 要短**（长 prompt 容易触发该故障）；
- 需要长文本时，先用 `write` 写文件，再让子代理读文件，而不是把长文本塞进工具参数；
- 若察觉自己在重复输出同一段文本，**立即停止并只发一条最短命令**（如 `pwd`）。
