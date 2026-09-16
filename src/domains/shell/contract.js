'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// shell 域契约声明（DOMAIN-STRUCTURE-DESIGN §10；纯数据，零 require）
//
// exports    ← src/domains/shell/index.js 的 module.exports 字面量键（DG-9；逐字冻结 10 项）
// PUBLIC_API ← 对外契约面（supervisor.js:28 消费 status/evaluate/health/markPending/identity/
//              readJournal/shellDir/checkUpdate/restartShell/SHELL_RELEASE_PKG；DG-10）
// pure       ← core.js（零 require 汇点：DEFAULTS/isShellProcess/decide/isUpdatePhase/
//              exeFromCmdline/deriveState）
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  domain: 'shell',

  exports: [
    'status', 'evaluate', 'health', 'markPending', 'identity',
    'readJournal', 'shellDir', 'checkUpdate', 'restartShell', 'SHELL_RELEASE_PKG',
  ],

  PUBLIC_API: [
    'status', 'evaluate', 'health', 'markPending', 'identity',
    'readJournal', 'shellDir', 'checkUpdate', 'restartShell', 'SHELL_RELEASE_PKG',
  ],

  classApi: {},

  deps: {
    logger: '日志器',
    events: '事件账本',
    dist: '统一分发（npm 版本查询）',
  },

  hooks: {},

  pure: ['domains/shell/core.js'],

  exempt: {},
};
