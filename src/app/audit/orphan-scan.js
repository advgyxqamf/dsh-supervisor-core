'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 游离对象自检（orphan-scan）—— 步骤 7 拆分自 app/control/supervise-view.js。
//
// 职责：R5 低频（~60s）游离对象自检，只写日志 + orphan_audit 事件（同指纹 10min 抑制），
//   绝不强杀/释放（异主隔离红线）。方法内一律经 this 协作（本步骤不做 ctor 注入）。
//
// 导出形态（STEP7-INTERFACE-CONTRACT §2）：module.exports = { methods: {...} }。
// ═══════════════════════════════════════════════════════════════════════════

const ports = require('../../platform/service/ports').shared;

module.exports = {
  methods: {
    /** R5 游离对象自检（低频只告警，不自动处理；异主隔离红线：绝不强杀/释放）。
     *   覆盖：① daemon 族(router ctl 43107 / lan ctl 43108) 被监听但本守卫期望停止且无管理锁（异主/残留）；
     *   ② 端口登记 owner=inst:* 但实例已不存在（正常应被 _syncInstancePorts 即时清理的残留）；
     *   ③ 目录项期望 running/starting 但观测长期失联（幽灵/死登记——监督介入前的观测线索）。
     *   结果只写日志 + orphan_audit 事件（同指纹 10min 抑制），供审计排查。 */
    _orphanAudit() {
      if (this._stopping) return;
      const now = Date.now();
      const reg = this.managedObjects;
      const issues = [];
      try {
        // ① daemon 族：在监听但目录/期望不认可（异主 daemon 或残留进程）
        const daemons = [
          { kind: 'router-daemon', port: this.ctl.routerPort(), active: () => this.daemons.routerActive(), managed: () => this.daemons.managed(), want: () => this.config.routerAutostart === true || !!(reg && reg.get('router-daemon') && reg.get('router-daemon').desired === 'running') },
          { kind: 'lan-daemon', port: this.ctl.lanPort(), active: () => this.daemons.lanActive(), managed: () => this.daemons.lanManaged(), want: () => this.daemons.enabled() || !!(reg && reg.get('lan-daemon') && reg.get('lan-daemon').desired === 'running') },
        ];
        for (const d of daemons) {
          if (!d.active()) continue;
          if (!d.want() && !d.managed()) {
            issues.push({ kind: d.kind, port: d.port, why: '端口被监听但本守卫期望停止且无管理锁（异主/残留 daemon）' });
          }
        }
        // ② 端口登记残留（owner=inst:* → 实例已不存在）
        try {
          const ids = new Set(this.instances ? this.instances.map((i) => i.id) : []);
          for (const rec of ports.list()) {
            if (!String(rec.owner || '').startsWith('inst:')) continue;
            const id = String(rec.owner).slice(5);
            if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
          }
        } catch {}
        // ③ 幽灵登记观测线索：期望运行但实然长期失联（main 由收敛接管，跳过避免噪声）
        try {
          const staleMs = Math.max(3 * (this.config.probeIntervalMs || 5000), 30000);
          for (const e of (reg && typeof reg.list === 'function') ? reg.list() : []) {
            if (e.id === 'main') continue;
            if (e.phase !== 'running' && e.phase !== 'starting') continue;
            const ob = e.lastObserved;
            if (ob && ob.ok === false && ob.at && now - new Date(ob.at).getTime() > staleMs) {
              issues.push({ kind: e.kind, id: e.id, why: '期望运行但观测长期失联（幽灵登记）' });
            }
          }
        } catch {}
        if (issues.length === 0) return;
        const key = issues.map((i) => i.kind + ':' + (i.id || i.port || i.owner)).join('|');
        if (this._lastOrphanKey === key && this._lastOrphanAt && now - this._lastOrphanAt < 10 * 60 * 1000) return; // 同指纹抑制
        this._lastOrphanKey = key;
        this._lastOrphanAt = now;
        if (this.events && this.events.append) { try { this.events.append('orphan_audit', { issues, at: new Date().toISOString() }); } catch {} }
        const detail = issues.map((i) => i.kind + (i.id ? ':' + i.id : '') + (i.port ? ':' + i.port : '') + (i.owner ? ':' + i.owner : '') + ' ' + i.why).join(' | ');
        this.logger && this.logger.warn && this.logger.warn('[orphan] 游离对象自检: ' + detail);
      } catch (e) {
        this.logger && this.logger.warn && this.logger.warn('[orphan] 自检异常: ' + ((e && e.message) || e));
      }
    },
  },
};
