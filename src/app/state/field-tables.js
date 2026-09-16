'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/state/field-tables.js —— main entry/process 字段表（**纯数据，零依赖**）。
//
// 从 state/fields.js:38-64 拆出（DF-3：纯数据与有状态读写/IO 分离）。
// fields.js 仍 re-export 同名常量（ENTRY_FIELDS/PROC_FIELDS），故
// buildFieldHelpers 生成的 46 个 helper 与 9 个访问器的**形态逐字不变**。
// 可 require 后独立单测（DF-6）。
// ═══════════════════════════════════════════════════════════════════════════

const ENTRY_FIELDS = [
  // [读写 helper 后缀, entry 字段]
  ['CrashWindowStart', 'crashWindowStart'],
  ['CrashWindowRestarts', 'crashWindowRestarts'],
  ['BackoffLevel', 'backoffLevel'],
  ['BackoffUntil', 'backoffUntil'],
  ['RestartCount', 'restartCount'],
];

const PROC_FIELDS = [
  // [读写 helper 后缀, process 字段, 是否布尔]
  ['Child', 'child', false],
  ['AdoptPid', 'adoptedPid', false],
  ['Adopted', 'adopted', true],
  ['ObservedOnly', 'observedOnly', true],
  ['FailStreak', 'failStreak', false],
  ['RestartAt', 'restartAt', false],
  ['StartDeadline', 'startDeadline', false],
  ['SpawnBlockedUntil', 'spawnBlockedUntil', false],
  ['MissingNotified', 'missingNotified', true],
  ['LastProbeAt', 'lastProbeAt', false],
  ['LastProbeOk', 'lastProbeOk', false],
  ['LastProbeHttpOk', 'lastProbeHttpOk', false],
  ['LastFailure', 'lastFailure', false],
  ['LastRestartAt', 'lastRestartAt', false],
];

module.exports = { ENTRY_FIELDS, PROC_FIELDS };
