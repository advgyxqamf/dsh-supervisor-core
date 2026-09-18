'use strict';

// app/audit/collaborator.js —— Orphan scan 协作方工厂（真 ctor 注入）。
//
// createOrphanScan(deps) 组合本切面实现（orphan-scan.orphanAudit），自己持有抑制状态；
// deps 全部为惰性取值函数（装配期 host 尚未就绪），故传 getXxx 而非值。
// 返回对象键 = 本切面公开面，与 assembly/collaborators.js 的 THIN_SPEC.audit 逐字一致：
//   THIN_SPEC.audit = { orphan: '_orphanAudit' }  ->  { orphan }
// facets.js 仍以 { methods } 把 _orphanAudit 装到 host（§1.2 不动），故两路径共用同一实现。
// 可只 require 本模块 + 假 deps 直接断言。

const { orphanAudit } = require('./orphan-scan');

function createOrphanScan(deps) {
  const g = deps || {};
  // 可选：外部提供 get/setLastKey|At 时用外部状态（如 host 字段，与 host 方法共享）；
  // 否则用闭包状态（工厂对象自持）。
  const last = { key: null, at: 0 };
  const getLastKey = typeof g.getLastKey === 'function' ? g.getLastKey : () => last.key;
  const setLastKey = typeof g.setLastKey === 'function' ? g.setLastKey : (v) => { last.key = v; };
  const getLastAt = typeof g.getLastAt === 'function' ? g.getLastAt : () => last.at;
  const setLastAt = typeof g.setLastAt === 'function' ? g.setLastAt : (v) => { last.at = v; };
  return {
    orphan() {
      return orphanAudit({
        getConfig: g.getConfig,
        getLogger: g.getLogger,
        getEvents: g.getEvents,
        getInstances: g.getInstances,
        getManagedObjects: g.getManagedObjects,
        getCtl: g.getCtl,
        getDaemons: g.getDaemons,
        getStopping: g.getStopping,
        getLastKey, setLastKey, getLastAt, setLastAt,
      });
    },
  };
}

module.exports = { createOrphanScan };
