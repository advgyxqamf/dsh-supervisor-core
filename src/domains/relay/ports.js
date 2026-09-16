'use strict';

// relay 端口槽位仲裁（IO 层）：把 platform 通用池的 claimSlot/回收/占用标记收口为具名函数，
// 使 ops.js 只经本模块操作端口，不直接散落调用 registry 方法。
// require 即申报 relay 段（域知识留在域内，DS-G4 §4.2 反转法）。

require('./port-segments');
const registry = require('../../platform/service/ports').shared;

/** 逻辑段 → 池范围（main 无绑定时的建议槽位派生自池定义，禁止池外硬编码）。 */
function rangeOf(segment) { return registry.rangeOf(segment); }

/** 当前注册表记录（{port, owner, segment}[]）。 */
function list() { return registry.list(); }

/**
 * 确定性申请一个 relay 槽位。
 * @param {string} segment 段名（relay）
 * @param {string} owner   归属（relay:<id>）
 * @param {object} opts    { preferred, bindingPreferred, onBindingLost, configPath }
 * @returns {Promise<{port:number}|{conflict:true,port?:number}|null>}
 */
async function claim(segment, owner, opts) {
  const o = opts || {};
  return registry.claimSlot(segment, owner, {
    preferred: o.preferred,
    bindingPreferred: !!o.bindingPreferred,
    onBindingLost: o.onBindingLost,
    reclaimCmdMark: 'lan-daemon.js',
    reclaimCfg: o.configPath || '',
    waitMs: 8000,
  });
}

/** 按 owner 释放端口注册（端口与 relay 生命周期解绑）。命名避开 PortRegistry.release(port, owner) 的 ownerId 纪律门禁。 */
function releaseOwner(owner) {
  try { registry.unregister(owner); } catch {}
}

/** 删除同一 owner 下除 keepPort 外的重复残留记录（真源唯一）。 */
function purgeDuplicates(owner, keepPort) {
  for (const rec of registry.list()) {
    // ⚠ 带 owner（防 list→release 之间的 TOCTOU 误删他人记录）。
    if (rec.owner === owner && rec.port !== keepPort) {
      try { registry.release(rec.port, rec.owner); } catch {}
    }
  }
}

/** 确保端口已在注册表标记占用（幂等）。 */
function ensureMarked(port, owner) {
  if (!registry.isRegistered(port)) registry.allocateMark(port, 'relay', owner);
}

module.exports = { rangeOf, list, claim, releaseOwner, purgeDuplicates, ensureMarked, registry };
