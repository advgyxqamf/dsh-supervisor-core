# 验收与测试标准（Acceptance & Test Standard）

> **本文件是「验收与测试」领域的唯一事实源。**
> 任何其它文档不得自行声明该领域的规范；与本文冲突者一律以本文为准。
> 机器校验门禁：test/acceptance-standard-gate-test.js。

---

## 0. 硬标准（不可协商）

> **所有测试一律不得在本机执行；验收只能由推送后的 GitHub CI 裁决。**
> **本机不得产生任何发布产物。**

这条标准与 .github/workflows/build.yml 文件头第 6 行同源：

    硬标准（2026-09-13，不可协商）：所有平台构建与发布必须经 GitHub CI 完成；
      本地不得产生发布产物。

以及同文件 139-142 行：

> 原条件为 needs.precheck.outputs.need_build == 'true'，理由是「已全量发布则无需再构建
> （**本地已用同一份代码产出，幂等**）」—— **那是本地构建时代的理由；硬标准既已禁止本地构建**。

---

## 1. 为什么（真实故障）

1. **本机是单一平台**：本机只有 Linux。Windows 的 spawn / macOS 的 launchctl /
   systemd / schtasks 原生行为，本机**结构上无法验证**。
2. **本机环境不可复现**：例如 test/release-auth-test.js 的 R4-c 断言「无 token 时不误报成功」，
   其前件是「运行机 $HOME/.npmrc 无 token」。开发机 ~/.npmrc 通常**有** token →
   本机必失败，而 CI 干净 runner 上**必通过**。**本机 FAIL 不是产品缺陷**。
3. **本机可能富集前置条件**：本机常有 X11/Wayland socket，CI runner 无头 →
   守护看护（按设计）拒绝拉起 GUI 壳 → shell-watchdog-e2e 在本机绿、在 CI 需装 Xvfb 才绿。
4. **断言前置条件会被漏掉**：CI 的 test job 明确先 build-ui.sh（否则面板安全头断言返回 503），
   再 npm run build:launcher:all 且 DSH_LAUNCHER_REQUIRED=1（否则 all-platforms 的
   T6-d/T6-e **静默 SKIP = 该断言在 CI 永不检查**）。本机跑 npm test **不含这些步骤**。

5. **平台原生的命令行上限**（2026-09-17 CI 实证）：`scripts.test` 是单条 `&&` 巨链，
   增长到 8593 字符后，**`windows-latest` 报 `The command line is too long.`**
   （cmd.exe 上限 8191），而同一提交的 `ubuntu-22.04` / `macos-latest` / `macos-14`
   **三个矩阵同时全绿**，且 `test` job 也全绿。
   本机 Linux 跑一万遍**都不可能**发现这条 —— 修法是 `--require` → `-r` 缩短到 7711，
   并把该平台差异固化为门禁 **N-e**（`test-chain-completeness-test.js`），
   使其不再依赖 Windows CI 才发现。

**结论：本机 npm test 的绿/红都不构成任何交付证据。**

---

## 2. 唯一合法的验收流程

1. 推送到远端（分支 / tag / PR）；
2. CI 触发条件（on:）：push 到 branches: [master]、push tags: ['v*']、
   pull_request、workflow_dispatch；
   ⚠ **推送非 master 分支不会触发 CI** —— 必须开 PR 或 workflow_dispatch；
3. 以 CI 的**四平台矩阵**结果为准。

### CI 实际执行的内容（.github/workflows/build.yml）

**test job（ubuntu-latest）**

| 步骤 | 说明 |
|---|---|
| bash release/scripts/build-ui.sh | 面板安全头断言的前置条件 |
| apt-get install -y xvfb | 提供图形会话（runner 无头） |
| npm run build:launcher:all | 真实产物（DSH_LAUNCHER_REQUIRED=1） |
| xvfb-run -a npm test | 内核回归 |

**build job（四平台矩阵，每次 push/PR 都跑，不得条件跳过）**

| os | artifact |
|---|---|
| ubuntu-22.04（glibc 2.35 基座） | linux-x64 |
| windows-latest | win-x64 |
| macos-latest | darwin-arm64 |
| macos-14（DSH_ARCH_OVERRIDE=x64） | darwin-x64 |

---

## 3. 「逻辑门禁」与「原生行为」的边界

仓库内的跨平台测试（cross-platform-architecture-gate、four-platform-behavior-matrix、
platform-layer-portability、platform-parsers-and-commands）证明的是**逻辑**
（映射 / 档位 / 解析 / 命令构造 / 分层）。

它们**不能**证明**平台原生行为**（真能跑 systemd/launchctl/schtasks、真能 spawn Windows 可执行、
真能出 MSI）。**后者只能由真实四平台 CI 构建裁决。两者互补，不可互相替代。**

---

## 4. 禁止事项

- ❌ 以本机测试结果作为交付结论、发布依据或「已完成」的证据；
- ❌ 在本机执行 npm run build:launcher / build:launcher:all（产生发布产物）；
- ❌ 把本机 FAIL 直接当成产品缺陷上报（必须先判断是否为环境前件不满足）；
- ❌ 把本机 PASS 当作 CI 会绿。

## 5. 允许事项

- ✅ 语法自检（node --check）——**不是测试**，仅作者自校；
- ✅ 只读检查（git status、grep、wc）与静态审阅；
- ✅ 推送后**读取 CI 结果**（GitHub API / Actions 页面）。

---

## 6. 违规判定

在 CI 绿之前，任何「已验收 / 已完成 / 通过」的表述都必须降级为
「**待 CI 裁决**」。文档中不得把本机结果写成验收结论（由
test/acceptance-standard-gate-test.js 机器校验）。
