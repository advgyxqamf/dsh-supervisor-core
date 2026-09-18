'use strict';

// app/state/phase.js —— 守卫 legacy phase（大写）与目录 canonical（小写）的纯映射。
// 词表权威：canonical 全表见 app/control/registry.js PHASES（唯一源）：
//   STOPPED->stopped / STARTING->starting / RUNNING->running / RESTARTING->restarting /
//   BACKOFF->backoff / OBSERVED->stopped（+process.observedOnly+adopted 位合成呈现）。
// 沙箱域(instance state)映射在 _syncSandboxRegistryEntry：INSTALLING->installing / FAILED->failed。

/** OBSERVED 由 process.observedOnly 表达，phase 归 stopped。 */
function legacyToEntryPhase(ph) {
  return { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', RESTARTING: 'restarting', BACKOFF: 'backoff', OBSERVED: 'stopped' }[ph] || 'stopped';
}

function entryToLegacyPhase(ph) {
  return { stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', restarting: 'RESTARTING', backoff: 'BACKOFF' }[ph] || 'STOPPED';
}

module.exports = { legacyToEntryPhase, entryToLegacyPhase };
