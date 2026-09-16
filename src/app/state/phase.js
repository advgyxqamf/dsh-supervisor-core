'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/state/phase.js —— 守卫 legacy phase（大写）↔ 目录 canonical（小写）**纯映射**。
//
// 从 state/fields.js:127-141 拆出（DF-3：纯计算与有状态读写分离）。
// 词表权威：canonical 全表见 app/control/registry.js PHASES（唯一源）；
//   STOPPED→stopped / STARTING→starting / RUNNING→running / RESTARTING→restarting /
//   BACKOFF→backoff / OBSERVED→stopped(+process.observedOnly+adopted 位合成呈现)。
// 沙箱域(instance state)映射在 _syncSandboxRegistryEntry：INSTALLING→installing / FAILED→failed。
// 可 require 后独立单测（DF-6）。
// ═══════════════════════════════════════════════════════════════════════════

/** 守卫 legacy 大写 phase → 目录唯一词表（小写）。OBSERVED 由 process.observedOnly 表达，phase=stopped。 */
function legacyToEntryPhase(ph) {
  return { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', RESTARTING: 'restarting', BACKOFF: 'backoff', OBSERVED: 'stopped' }[ph] || 'stopped';
}

/** 目录小写 phase → 守卫 legacy 大写。 */
function entryToLegacyPhase(ph) {
  return { stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', restarting: 'RESTARTING', backoff: 'BACKOFF' }[ph] || 'STOPPED';
}

module.exports = { legacyToEntryPhase, entryToLegacyPhase };
