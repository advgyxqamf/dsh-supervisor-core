'use strict';

// ══════════════════════════════════════════════════════════════════════════
// app/control/heartbeat.js —— 受管目录的**心跳与调度**（IO / 定时 / 监督）。
//
// 从 control/registry.js 拆出（R3 严值 DF-2：registry ≤300；DF-3：三层分离 ——
//   · managed-object.js  纯模型（词表/entry/所有权）
//   · registry.js        目录 CRUD + 持久化
//   · heartbeat.js       心跳驱动（监督单拍 / 节流 / 超时隔离）
//   DF-6：本模块可独立 require）。
//
// 本模块**无 this**：以 registry 显式入参驱动其公开入口
//   （applyObservation / setPhase）与内部簿记（_objects / _adapters / _log）。
// 依赖单向：registry.js -> heartbeat.js（heartbeat 不回 require registry）。
// ══════════════════════════════════════════════════════════════════════════

/** 单对象监督的超时上限（拍宽的倍数）。见 withTimeout。 */
const ADAPTER_TIMEOUT_TICKS = 6;

/** 给单对象的监督 promise 加超时（超时即按失败处理，绝不无限等待）。 */
function withTimeout(registry, p, ms, id) {
  let t = null;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve({ __timedOut: true, ok: false, error: '监督超时(' + ms + 'ms)' }), ms);
    // 不拖住进程退出（守卫优雅停机不被这些计时器拦）
    if (t && typeof t.unref === 'function') t.unref();
  });
  return Promise.race([Promise.resolve(p).finally(() => { if (t) clearTimeout(t); }), timeout])
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
    .then((res) => {
      if (res && res.__timedOut) {
        registry._log('warn', 'heartbeat 监督超时(' + id + ')：已跳过本拍（防心跳停摆）');
      }
      return res;
    });
}

/**
 * 唯一心跳（R3 C3-1 基础设施）：遍历目录项，对已挂 adapter 的对象执行 observe() 并写入实然。
 * 本层做「观测收集」（实然→lastObserved）+ derivePhase 的相位收敛写入（setPhase）；
 * 启停/退避仍由各类型 adapter 的驱动开关决定。节流经 ownership.meta.tickEvery
 * （1=每拍；6≈30s daemon 语义）。单对象异常隔离。
 * @param {object} registry ManagedRegistry 实例（提供 _objects/_adapters/_log/applyObservation/setPhase）
 * @param {number} [intervalMs] 心跳拍宽（默认 5000）
 * @returns {{ observed: string[], errors: string[] }}
 */
async function runHeartbeat(registry, intervalMs) {
  const iv = intervalMs || 5000;
  const now = Date.now();
  const observed = [];
  const errors = [];
  for (const e of registry._objects) {
    const ad = registry._adapters[e.kind];
    if (!ad) continue; // 未挂 adapter：不观测（不驱动）
    // 两形态：supervise = 监督单拍(守卫门控的守护逻辑,如 daemon)；observe = 纯观测
    const fn = (typeof ad.supervise === 'function') ? ad.supervise : ((typeof ad.observe === 'function') ? ad.observe : null);
    if (!fn) continue;
    const tickEvery = ad.tickEvery || (e.ownership && e.ownership.meta && e.ownership.meta.tickEvery) || 1;
    if (tickEvery > 1) {
      if (e._nextTickAt && now < e._nextTickAt) continue; // 节流(daemon 类≈6拍30s)
      // ⚠ 用**本次实际执行时刻**前推（而非 heartbeat 入口的 now）：
      //   本循环是串行的，前面的对象耗时会让 now 变陈旧 → 节流窗被系统性拉长。
      e._nextTickAt = Date.now() + tickEvery * iv;
    }
    try {
      // ⚠ P1 修复（2026-09-13）：**单个 adapter 不得拖死整条心跳**。
      //
      //   缺陷：此处 `await fn(e)` 没有任何超时。心跳是 main 收敛 / 沙箱监督 /
      //     daemon 监督的**唯一周期驱动**（supervisor.js 的 start() 在 managedObjects 存在时
      //     不创建 tick 定时器）。只要任一 adapter 的 promise 永不 settle（ctl 卡死、
      //     子进程无响应、await 了一个不会 resolve 的 I/O），本循环就永久停在这一拍；
      //     而 supervisor 侧以 _heartbeatBusy 防重叠 → **心跳永停**，
      //     表现为「面板开着、服务全死、却没有任何事件」。
      //   修法：每对象加超时（上限 = 拍宽 × ADAPTER_TIMEOUT_TICKS）。超时按**异常**处理
      //     （记 errors + warn，并落一条 {ok:false} 观测），使循环继续推进到下一个对象。
      //     超时值取「拍宽的 6 倍」：远大于正常监督耗时，又保证有界。
      const res = await withTimeout(registry, fn(e), iv * ADAPTER_TIMEOUT_TICKS, e.id);
      // 超时必须进 errors 汇总（否则调用方只看 errors/observed 会以为一切正常）
      if (res && res.__timedOut) errors.push(e.id + ':' + (res.error || '监督超时'));
      if (res && typeof res.ok === 'boolean') {
        registry.applyObservation(e.id, res);
        // derivePhase（daemon 类）：phase 由 应然×观测 收敛——desired running∧在线→running；
        // 失联/期望停止→stopped。消除「daemon desired=running 但 phase 恒 stopped」的目录误导。
        if (ad.derivePhase === true) {
          const want = e.desired === 'running';
          const p = (want && res.ok) ? 'running' : 'stopped';
          if (e.phase !== p) registry.setPhase(e.id, p);
        }
      }
      observed.push(e.id);
    } catch (err) {
      errors.push(e.id + ':' + ((err && err.message) || err));
      registry._log('warn', 'heartbeat ' + (ad.supervise ? 'supervise' : 'observe') + '(' + e.kind + ':' + e.id + '): ' + ((err && err.message) || err));
    }
  }
  return { observed, errors };
}

module.exports = { runHeartbeat, withTimeout, ADAPTER_TIMEOUT_TICKS };
