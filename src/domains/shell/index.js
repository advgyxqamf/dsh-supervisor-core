'use strict';

// 壳更新安全网域门面（只做组合与导出，不实现业务）。
// journal.js：更新账本/状态机/健康上报；restart.js：版本检测/壳重启；
// watchdog.js：壳缺失看护（由 supervisor 直接引用）。
// 导出面必须逐字保持：supervisor.js 消费 status/evaluate/health/markPending/identity/
// readJournal/shellDir/checkUpdate/restartShell/SHELL_RELEASE_PKG；watchdog 经 deps.shell
// 消费 identity/readJournal/restartShell。少一个即运行期 undefined。
// 设计定位与硬约束（D6：绝不触碰内核既有更新机制）见 journal.js 顶部。

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

// 导出面与原 index.js 逐字一致（不多不少），是本域拆分的安全契约。
module.exports = { status, evaluate, health, markPending, identity, readJournal, shellDir, checkUpdate, restartShell, SHELL_RELEASE_PKG };
