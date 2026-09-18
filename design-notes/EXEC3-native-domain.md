# EXEC3-native-domain —— app/native 最根部拆解（R3-A）

> 范围：src/app/native/**（独占归属 R3-A）。依据 EXECUTION-CONTRACT.md（硬约束 + §7 裁决）、
> DOMAIN-STRUCTURE-DESIGN.md（DF-1..DF-7 + R1..R12）、design-notes/app-orchestration.md。
> 纪律：未启动任何守卫/daemon；未触碰 /tmp/dsh-*、~/.local/state/dsh-supervisor/、~/.dsh；
> 未改 package.json；未 commit；仅改本目录 + 两处钉在源码上的 native 测试指向。

## 1. 完成判据达成

| 判据 | 阈值 | 结果 |
|---|---|---|
| DF-1 门面 | ≤150 | installer.js = 125 行 |
| DF-2 单文件 | ≤300 | installer 125 / ops 239 / upgrade 268 / probe 83 / manifest 67 / npm 66 / policies 65 / command 48 |
| DF-3 纯/IO 分离 | — | policies.js 零 IO；probe/manifest/npm/ops 为 IO；upgrade.js 纯编排 |
| DF-4 零 this 跨文件 | 0 | 仅 installer.js 出现 3 处 this.busy()（同类内）；非门面文件 this.X() = 0 |
| DF-5 域内 DAG / 禁方法集合并 | 0 环 | 见 §3；无 Object.assign(prototype) |
| DF-6 可独立 require | — | 6 个非门面模块均单独 require 加载成功 |
| DF-7 依赖单向 | — | installer → {ops,upgrade} → {npm,manifest,probe,policies} |
| DF-8 require 顶层 | 0 内联 | 扫描内联 require = 0（原 killTree 内联 require 已上移） |
| DF-9 嵌套深度 | ≤6 | 逐文件花括号最大深度 ≤6（ops.js=6，其余 ≤4） |

## 2. 实际结构（原 installer.js 807 行 → 7 文件）

    app/native/
      installer.js  125  门面：NativeManager 组合 + 互斥守卫 + 导出面逐字保持
      ops.js        239  install / startInstall / startUninstall / uninstall / status / checkUpdate
      upgrade.js    268  upgrade / rollbackNative / handleUpgradeFailure（先停后装、验证、回滚）
      npm.js         66  npmExe/npmExeArgs/resolveNpmRoot/checkEnvironment/latestVersion/selectRegistry/runInstall
      manifest.js    67  read/save（原子写 0600）/record/claimDataPaths
      probe.js       83  detected/binPath/installedVersion/targetPort/mainUnit/waitNativeHealthy
      policies.js    65  纯：busy/upgradeBrief/versionInfo/isBareCommand/isValidVersion/isNewer/isUpToDate/needsRollback
      command.js     48  （既有，未改）

## 3. 依赖图（DF-5/DF-7）

    installer.js
      ├─ policies.js  (纯, → shared/version)
      ├─ probe.js     (→ fs/path/os, platform/os/exec-path, policies)
      ├─ manifest.js  (→ fs/path, probe)
      ├─ npm.js       (→ platform/os/exec-path, platform/util/exec)
      ├─ ops.js       (→ fs, platform/os/spawn, platform/os/process, npm, policies)
      └─ upgrade.js   (→ policies)

无环；跨层边全部落在已登记单元（app→platform/os、platform/util、shared/version）。

## 4. 导出面保真

NativeManager 公共方法与属性逐字保持：detected / binPath / installedVersion / status /
versionInfo / checkUpdate / checkEnvironment / install / startInstall / upgrade / startUninstall /
uninstall / busy / upgradeBrief / upgradeStatus，以及状态字段 upgradeState / installing /
uninstalling / installLog / lastInstall / lastUninstall / _npmBin / _npmBinArgs / manifestFile /
stateDir / tasks / events / logger / dist / hooks；私有钩子 _manifest / _saveManifest /
_recordManifest / _claimDataPaths / _runInstall / _latestVersion / _selectRegistry /
_waitNativeHealthy / _targetPort / _mainUnit / _appendInstallLog / _appendUpgradeLog 保留为一行委托
（测试 native-op-mutex 直接 patch 这些私有钩子，必须保留在实例上）。
私有编排 _rollbackNative / _handleUpgradeFailure 下沉 upgrade.js（无外部消费方）。

## 5. 测试改动清单（EXECUTION-CONTRACT §4.5：钉源码断言随搬迁改址，语义不变）

| 文件 | 改动 |
|---|---|
| test/uninstall-timeout-test.js | SRC 由 installer.js 改指 ops.js；锚点 this.→host.；F-b 平台进程树引用改验整文件（require 已上移顶层，不再落在函数体内） |
| test/defects-batch-f-test.js K10 | manifest 清理块改指 ops.js；rm(this.manifestFile) → rm(host.manifestFile) |

其余 native 测试零改动：native-test / native-dsh-binding / native-op-mutex /
uninstall-timeout-behavior 全绿。

## 6. 回归实测（均未启动 daemon）

- native-op-mutex 12/0；native-dsh-binding 12/0；uninstall-timeout-behavior 8/0；
  uninstall-timeout 12/0；native-test 10/0；kernel-update-single-writer 24/0；
  process-tree-kill 10/0；platform-capability-audit 67/0；test-chain-completeness 10/0；
  all-platforms 34/0（T6-a 内核零运行时依赖 PASS）。
- 三结构门禁：directory-structure-gate 16 passed / 0 hard；layering-and-dependency-gate 10/0；
  domain-structure-gate 54 passed / 0 hard。RED 清单中无任何 app/native 文件
  （DS-9 仅 api/index.js、platform/os/index.js；DG-2 仅 platform/service/log/hub.js）。
- 行为级假依赖 harness（require + 假 dist/hooks，无进程）：升级成功 / 验证失败自动回滚 /
  已是最新跳过 / desired=stopped 分支 / install 成/败锁释放，16 项断言通过。

## 7. 偏差与遗留（如实）

1. 目标树未列 upgrade.js。因 upgrade/handleUpgradeFailure/rollbackNative 合计约 350 行，
   若并入 ops.js 会突破 DF-2 ≤300；故按职责独立为 upgrade.js（沿用 instance/upgrade.js 先例）。
2. 协作形态用 app 层既有 host-first 自由函数（EXEC-app-unmix §6 已确立的批 8 级 1 形态），
   而非 ctor 注入：native-op-mutex 的 K-d 行为测试用 Object.create(NativeManager.prototype)
   + 实例级 patch 私有钩子，若改为构造期协作方将不再可达（会直接 TypeError）。
   故本轮达 DF-4 的字面判据（零 this 跨文件），批 9 级 2 ctor 注入留待测试契约同步后。
3. 未运行 upgrade-test：该测试 spawn bin/dsh-supervisor daemon，违反 EXECUTION-CONTRACT §2.1
   「绝不启动守卫/daemon」。以 §6 的假依赖 harness 作等价行为覆盖。
4. precheck-test 当前在 require 阶段被 platform/service/token/index.js 的重复声明阻断
   （R3-C 在途迁移，非本轮引入）；defects-batch-f K7 同理（platform/service/ports/index.js，
   R3-C 在途）。二者均非 app/native 改动面。
