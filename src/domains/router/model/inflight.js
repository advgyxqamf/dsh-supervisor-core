'use strict';

// 在途计数 + 错误计数（纯状态：无 IO、无 this，可独立单测）。
// 真缺陷修复（行为变更）：旧实现有两条结束路径且 effect 不一致——流式成功只补
// _retryPendingStop，错误/中断两件事都做，导致 2xx 流式成功路径永不补做「在途期间被延后的
// 实例重启」。本模块提供单一 end()：归零时返回显式 effects 描述，调用方
// （handlers/forward.js#endInflight）对两条路径执行同一组 effects。

function createInflight() {
  let begun = 0;
  let ended = 0;
  let errors = 0;

  return {
    begin(acc) {
      if (!acc) return 0;
      begun += 1;
      acc.inflight = (acc.inflight || 0) + 1;
      return acc.inflight;
    },

    /**
     * 唯一在途递减入口。
     * @param {object} acc 账号（在途计数挂在账号对象上）
     * @param {{prov?:object, inst?:object, lifecycle?:boolean}} [ctx]
     * @returns {{ zero:boolean, effects:Array<{kind:string,acc:object,prov:object,inst:object}> }}
     *   effects 仅为**描述**，由调用方执行——两条结束路径共用此结果。
     */
    end(acc, ctx) {
      if (!acc) return { zero: false, effects: [] };
      ended += 1;
      acc.inflight = Math.max(0, (acc.inflight || 0) - 1);
      if (acc.inflight !== 0) return { zero: false, effects: [] };
      const c = ctx || {};
      const effects = [];
      if (c.lifecycle && acc._stopPendingUntilIdle) {
        effects.push({ kind: 'retryPendingStop', acc, prov: c.prov || null, inst: null });
      }
      if (c.lifecycle && c.inst) {
        effects.push({ kind: 'flushRestartPending', acc, prov: c.prov || null, inst: c.inst });
      }
      return { zero: true, effects };
    },

    /** 错误计数（纯内存；持久化由 UsageLedger.recordError 负责）。 */
    recordError() { errors += 1; return errors; },
    errorCount() { return errors; },
    stats() { return { begun, ended, errors, active: begun - ended }; },
  };
}

module.exports = { createInflight };
