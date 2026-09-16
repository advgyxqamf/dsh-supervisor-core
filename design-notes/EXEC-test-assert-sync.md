# EXEC · 把断言钉在源码内容上的既有门禁同步（test/*.js）

> 状态：完成（2026-09-17）。范围：SSOT DOMAIN-STRUCTURE-DESIGN.md §8 列出的
> 「断言钉在源码内容上」的既有门禁，以及域改造过程中新暴露的同类漂移面。
> 权威依据：EXECUTION-CONTRACT.md §1–§4 + SSOT §5（目标结构）/§8（须同步清单）/§9（DG 判据）。

## 1. 目标与手法

域改造把方法搬到新文件后，源码级断言必须同步改**读取面**，否则静默假绿或误报 FAIL。
通用手法（写进每处改动）：

1. **读取面随文件搬移同步更新**：优先改为**读整个域**（递归全部 .js）或「候选文件整组」，
   域内再拆分也不丢覆盖面（既有门禁已使用该范式，本次沿用）。
2. **不钉单文件形态**：能改行为/语义判据的，改为行为/语义；不能的，用形态无关的结构判据。
3. **不放宽阈值/不变量**：只改读取面，阈值、计数下界、判据语义逐字保持。
4. **判据先剥注释**：防注释里的同名字样造成假绿（R6 / R1 要求）。

## 2. 逐项改动（SSOT §8 清单）

| # | 文件 | 原判据 | 改后 | 说明 |
|---|---|---|---|---|
| 1 | test/round13-robustness-batch-test.js | 读 router/index.js 找 canPersist() | **整域**读 src/domains/router | 写权闸收敛到 store.js（实测 store.js:60），_save 编排落 ops.js |
| 2 | test/provider-gateway-gate-test.js | forward-core.js 的 _writeTotals 函数体含 canPersist() | store/usage.js + forward-core.js 整组，判「用量落盘模块内含落盘且过闸」 | _writeTotals 实测在 store/usage.js:89-97（含 canPersist + writeFileSync）；函数体正则形态敏感，改结构不变量 |
| 3 | test/kernel-daemon-contract-test.js | 读 router/index.js 的 stateDir: this.config… | 整域读 + 剥注释 + 形态容忍正则 | 实测新家在 router/store.js:112-116（(d.config && d.config.stateFile)），正则容忍 this.config / d.config |
| 4 | test/round13-router-relay-gaps-test.js | 读 index.js 的 removed.stopInstance(i,true) | 「删除路径所在文件整组」读 index/router-ops/ops/ops-admin/ops-apps-registry | 实测新家 router/ops.js:109（与 SSOT 表一致）。只改 ③；① 属 F1（见 §4/§6） |
| 5 | test/relay-source-gate-test.js | 断言**注释串** api/identity | **语义判据**：闸文件 require 的 IP 实现与 src/shared/ip.js **同一对象**（===）+ 整域读 | 注释一精简即假绿；判据改为「绝不重写第二份 RFC1918」的真实证明 |
| 6 | test/native-dsh-binding-test.js | 读 plugin/ops.js 的 target.runtime | 整域读 src/domains/plugin | 实测新家 plugin/cli.js:67（**与 SSOT 表所写 targets.js 不同**，见 §3） |
| 7 | test/round13-discipline-gaps-test.js | 读私有字段 pm._bundleOpQueue | **行为判据**：内层挂起 + 跨路径互斥（set→scrub 串行） | 队列随 layers.js 搬移后私有字段不再稳定；行为判据直接验证「共用同一串行队列」 |
| 8 | test/instance-safety-test.js | _prepareSystemd(){…} 函数体正则 | **整域结构判据**（形态无关）：renameSync 让位 / 无 unlink / 时间戳后缀 / 无 rmSync(aside / while existsSync | 行为级由 test/instance-systemd-aside-behavior-test.js 真实调用承担；整域聚合已在文件顶部 |
| 9 | test/instance-upgrade-test.js | owner 打补丁 mgr._prepareSystemd/_ensureSandboxDirs | **I1 已改**：构造期注入假 service + systemdDir | 本代理只**核对**（R-2 迁移硬前置） |
| 10 | test/platform-capability-audit-test.js | 只读 shell/watchdog.js | **S1 已改**：读 core.js + watchdog.js 整组 | 实测 decide 在 shell/core.js；本代理只**核对** |

## 3. 与设计的偏差（如实报告）

SSOT §5 目标位置与**实测落地位置**有两处不符（本代理按实测整组读取，未迁就）：

1. **relay 来源闸**：SSOT §5.2 写「proxy.js 承载来源闸」，实测 isTrustedSource 在
   src/domains/relay/core.js。relay-source-gate 按**整域聚合**读取，两处都能覆盖。
2. **plugin runtime 目标解析**：SSOT §8 表写 plugin/targets.js，实测 target.runtime
   在 src/domains/plugin/cli.js:67。native-dsh-binding 按**整域聚合**读取，两处都能覆盖。

其余清单项落地位置与 SSOT 表一致（router/store.js、router/store/usage.js、router/ops.js）。

## 4. 迁移中新暴露的同类漂移面（表外，已同步）

域改造推进后，以下**不在 §8 表内**的源码级断言也开始静默/假红，已按同一手法同步：

- **provider-gateway PG-2 / PG-4**：转发逻辑从 forward-core.js 拆到 handlers/forward.js
  → 读取面从单文件扩为「forward 层整组」，否则 PG-2（能力 typeof 猜测）与 PG-4（双预算使用）
  会**静默假绿**（实测 _switchBudgetMs / prewarmAsync 已在 handlers/forward.js:99/109）。
- **round13-discipline ②/②-b**：tasks/service 改为**构造期注入**（createOps/createLifecycle
  捕获 ctx）→ 原「后置赋值 mgr.tasks=」失效。改为 ctor 注入 tasks + **假 service**，
  避免真跑 systemctl --user（与 §5.3 迁移硬前置同因）。
- **instance-safety L-g**：addInstance 从 class 方法搬为 ops.js 的模块函数
  async function addInstance(payload) → 判据容忍 async [function] addInstance(payload) {。

## 5. 验证（实跑，node --require ./test/_preload.js）

| 测试 | 结果 |
|---|---|
| round13-robustness-batch-test | 22 passed, 0 failed |
| provider-gateway-gate-test | 23 passed, 0 failed |
| kernel-daemon-contract-test | 23 passed, 0 failed |
| relay-source-gate-test | 17 passed, 0 failed |
| native-dsh-binding-test | 12 passed, 0 failed |
| round13-discipline-gaps-test | 24 passed, 0 failed |
| instance-safety-test | 33 passed, 0 failed |
| instance-upgrade-test（核对 I1） | 6 passed, 0 failed |
| instance-systemd-aside-behavior-test（核对 I1） | 13 passed, 0 failed |
| platform-capability-audit-test（核对 S1） | 66 passed, 0 failed |
| standards-uniqueness-test | 8 passed, 0 failed |
| directory-structure-gate-test | hard 16 passed / 0 failed（exit 0；3 项 soft/report-only） |
| layering-and-dependency-gate-test | 9 passed, 1 failed（**F1 的 D-2 未登记 app/domain-actions**） |
| round13-router-relay-gaps-test | ③ 本代理块全绿；① 4 项 FAIL（**F1 的 patchDshMain 搬迁**） |
| test-chain-completeness-test | 8 passed, 2 failed（**switch-policies-test.js 未入链**） |

## 6. 遗留 / 非本代理范围（已如实上报主代理）

- **round13-router-relay-gaps ①**：patchDshMain 已按 R7 从 app/facade/main.js
  下沉 app/domain-actions/main.js（实测），该组断言须由 **F1** 按 D-2 改指向。
- **test-chain-completeness N-a**：test/switch-policies-test.js（router 侧新门禁）未登记进
  package.json#scripts.test → **其所有者**需补链（本代理范围仅 test/*.js，不动 package.json）。
- **layering-and-dependency-gate L-2**：src/app/domain-actions 未登记进 CROSS_LAYER 的 root -> app
  → **F1** 按 D-2 第 4 项补登记。
- **directory-structure-gate soft**：DS-G3b（supervisor.js 的 Object.assign）归 **G0**；
  DS-9 为 report-only（4 个 index >150、6 个文件 >400，属各域收口未完成）。
