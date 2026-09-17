'use strict';

// 端口分配与槽位仲裁（claimSlot / allocate）—— IO 编排层（探测/回收/登记）。
// 纯算法在 core.js；探测/回收在 probe.js。PortAllocator 经构造注入注册表（组合，非 mixin）。

const core = require('./core');
const probe = require('./probe');

class PortAllocator {
  constructor(registry) { this._registry = registry; }

  /** 确定性槽位仲裁（并发下单一互斥，防双分配）。 */
  async claimSlot(rangeKey, owner, opts) {
    const o = opts || {};
    const r = this._registry;
    const range = o.range || r.rangeOf(rangeKey);
    if (!range) throw new Error('ports.claimSlot: 未知端口段 ' + rangeKey);
    await this._acquireAlloc();
    try {
      return await this._claimSlotLocked(rangeKey, owner, range, o);
    } finally {
      r._allocLock = false;
    }
  }

  async _acquireAlloc() {
    const r = this._registry;
    while (r._allocLock) { await new Promise((res) => setTimeout(res, 10)); }
    r._allocLock = true;
  }

  async _claimSlotLocked(rangeKey, owner, range, o) {
    const r = this._registry;
    const bound = r.byOwner(owner);
    if (bound) {
      const got = await this._tryClaim(bound, owner, rangeKey, o);
      if (got) return Object.assign({ owner, segment: rangeKey, binding: true }, got);
      const alt = await this._allocFreeCore(rangeKey, range, owner, o);
      if (alt) {
        this._notifyLost(o, owner, bound, alt.port);
        return Object.assign({ owner, segment: rangeKey, binding: true, bindingLost: true, from: bound }, alt);
      }
      return this._conflict(owner, rangeKey, 'binding-occupied-and-pool-full', bound);
    }
    if (o.preferred) {
      const got = await this._tryClaim(o.preferred, owner, rangeKey, o);
      if (got) return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: !!o.bindingPreferred }, got);
      if (o.bindingPreferred) {
        const alt = await this._allocFreeCore(rangeKey, range, owner, o);
        if (alt) {
          this._notifyLost(o, owner, o.preferred, alt.port);
          return Object.assign({ owner, segment: rangeKey, preferred: true, bindingPreferred: true, bindingLost: true, from: o.preferred }, alt);
        }
        return this._conflict(owner, rangeKey, 'binding-preferred-occupied-and-pool-full', o.preferred);
      }
    }
    const free = await this._allocFreeCore(rangeKey, range, owner, o);
    if (free) return Object.assign({ owner, segment: rangeKey }, free);
    return this._conflict(owner, rangeKey, 'pool-full', null);
  }

  _notifyLost(o, owner, from, to) {
    if (o.onBindingLost) { try { o.onBindingLost({ owner, from, to }); } catch {} }
  }

  /** 显式冲突结构（绝不静默跳号）。 */
  _conflict(owner, rangeKey, reason, port) {
    const cap = this._registry.capacity()[core.SEGMENT_POOL[rangeKey] || 'managed'] || null;
    return Object.assign({ owner, segment: rangeKey, conflict: true, reason, error: 'port-pool-exhausted', capacity: cap }, port ? { port } : {});
  }

  /** 写入一条新登记（已存在则不动）。 */
  _register(port, rangeKey, owner) {
    const r = this._registry;
    if (!r._records.has(port)) {
      r._records.set(port, { port, role: rangeKey, owner, createdAt: Date.now() });
      r._save();
    }
  }

  async _waitFree(port, owner, ms) {
    const r = this._registry;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await r.isTaken(port, owner))) return true;
      await new Promise((res) => setTimeout(res, 200));
    }
    return !(await r.isTaken(port, owner));
  }

  /** 尝试认领单个端口（自听/复用/新占/回收）；不可则 null。 */
  async _tryClaim(port, owner, rangeKey, o) {
    if (!port) return null;
    const r = this._registry;
    const rec = r._records.get(port);
    if (probe.listeningPid(port) === process.pid) { this._register(port, rangeKey, owner); return { port, mode: 'self-listening' }; }
    if (rec && rec.owner !== owner) return null;
    const reused = !!(rec && rec.owner === owner);
    if (!(await r.isTaken(port, owner))) { this._register(port, rangeKey, owner); return { port, mode: reused ? 'reuse' : 'claim' }; }
    const killed = probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
    if (killed > 0 && (await this._waitFree(port, owner, o.waitMs || 6000))) { this._register(port, rangeKey, owner); return { port, mode: 'reclaimed' }; }
    return null;
  }

  /** 池内最小空闲分配（不获取锁；调用方已持 _allocLock）。 */
  async _allocFreeCore(rangeKey, range, owner, o) {
    const r = this._registry;
    const offset = o.range ? 0 : r._anchorOffset(rangeKey);
    for (let n = 0; n < range.count; n++) {
      const p = range.base + ((offset + n) % range.count);
      if (r._records.has(p)) continue;
      if (await r.isTaken(p)) {
        if (o.reclaimCmdMark) {
          probe.reclaimByCmdMark(o.reclaimCmdMark, o.reclaimCfg);
          await new Promise((res) => setTimeout(res, o.waitMs || 2500));
        }
        if (await r.isTaken(p)) continue;
      }
      if (!(await probe.bindable(p))) continue;
      r._records.set(p, { port: p, role: rangeKey, owner, createdAt: Date.now() });
      r._save();
      return { port: p, mode: 'allocated' };
    }
    return null;
  }

  /** 段内最小空闲分配并登记；池满返回 null。 */
  async allocate(rangeKey, owner, opts) {
    const r = this._registry;
    const range = r.rangeOf(rangeKey);
    if (!range) throw new Error('ports.allocate: 未知端口段 ' + rangeKey);
    const o = opts || {};
    const start = (o.range ? 0 : r._anchorOffset(rangeKey)) + (o.skipFirst ? 1 : 0);
    await this._acquireAlloc();
    try {
      for (let n = 0; n < range.count; n++) {
        const p = range.base + ((start + n) % range.count);
        if (r._records.has(p)) continue;
        if (await r.isTaken(p)) continue;
        if (!(await probe.bindable(p))) continue;
        r._records.set(p, { port: p, role: rangeKey, owner: owner || 'dynamic:' + rangeKey, createdAt: Date.now() });
        r._save();
        return p;
      }
      return null;
    } finally {
      r._allocLock = false;
    }
  }
}

module.exports = { PortAllocator };
