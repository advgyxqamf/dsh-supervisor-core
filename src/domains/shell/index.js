'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 壳更新安全网（域：shell）—— 门面（组合 + 导出）
//
// 域内拆分（DIRECTORY-STRUCTURE-DESIGN §4.5：index 仅做组合与导出，≤200 行）：
//   · journal.js —— 更新账本 / 状态机 / 健康上报（纯状态 + 本地 JSON 读写）；
//   · restart.js —— 版本检测 / 壳重启（npm 查询 + 进程信号 + spawn）；
//   · watchdog.js —— 壳缺失看护（独立模块，supervisor.js:31 直接引用）。
// 本文件**只**聚合导出，不实现业务 —— 读者从导出面即可定位实现文件。
//
// ⛔ 导出面必须逐字保持（DIRECTORY-STRUCTURE-DESIGN §6 风险）：supervisor.js:28
//   `require('./domains/shell/index')` 消费 status/evaluate/health/markPending/identity/
//   readJournal/shellDir/checkUpdate/restartShell/SHELL_RELEASE_PKG；watchdog 经
//   deps.shell 消费 identity/readJournal/restartShell。少一个即运行期 undefined。
//
// 设计定位、硬约束（D6：绝不触碰内核既有更新机制）与全部论证见 journal.js 顶部注释
//（原 index.js 的整段说明原样迁入实现文件，避免同一设计有两处叙述而分叉）。
// ═══════════════════════════════════════════════════════════════════════════

const {
  shellDir,
  identity,
  readJournal,
  markPending,
  evaluate,
  health,
  status,
} = require('./journal');

const { SHELL_RELEASE_PKG, checkUpdate, restartShell } = require('./restart');

// ⚠ 导出面与原 index.js **逐字一致**（不多不少）：加键虽不破坏现有消费者，但
//   「导出面不变」是本域拆分的安全契约（超集也会让 review 无法用 diff 判定等价）。
module.exports = { status, evaluate, health, markPending, identity, readJournal, shellDir, checkUpdate, restartShell, SHELL_RELEASE_PKG };
