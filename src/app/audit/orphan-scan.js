'use strict';

// 游离对象自检（orphan-scan）—— 低频（~60s）自检，只写日志 + orphan_audit 事件
// （同指纹 10min 抑制），绝不强杀/释放（异主隔离红线）。
// 实现主体 orphanAudit(deps) 只经惰性取值函数取用宿主事实（消除隐式 this）；
// module.exports.methods 为 host 兼容外壳，facets.js 的 { methods } 安装逐字保留，
// 其他切面仍可经 host._orphanAudit() 取用。

const ports = require('../../platform/service/ports').shared;

/** 惰性取值：fn 不是函数时回退 dflt（host 兼容外壳与协作方工厂共用同一条实现）。 */
function call(fn, dflt) { return typeof fn === 'function' ? fn() : dflt; }

/** 游离对象自检实现（deps：getConfig/getLogger/getEvents/getInstances/getManagedObjects/
 *  getCtl/getDaemons/getStopping + getLastKey/setLastKey/getLastAt/setLastAt）。
 *   覆盖：daemon 族（router ctl 43107 / lan ctl 43108）被监听但本守卫期望停止且无管理锁；
 *   端口登记 owner=inst:* 但实例已不存在（正常应被 _syncInstancePorts 即时清理的残留）；
 *   目录项期望 running/starting 但观测长期失联（幽灵/死登记，监督介入前的观测线索）。
 *   结果只写日志 + orphan_audit 事件（同指纹 10min 抑制），供审计排查。 */
function orphanAudit(deps) {
  const g = deps || {};
  if (call(g.getStopping, false)) return;
  const now = Date.now();
  const reg = call(g.getManagedObjects, null);
  const issues = [];
  try {
    // daemon 族：在监听但目录/期望不认可（异主 daemon 或残留进程）
    const daemons = [
      { kind: 'router-daemon', port: g.getCtl().routerPort(), active: () => g.getDaemons().routerActive(), managed: () => g.getDaemons().managed(), want: () => g.getConfig().routerAutostart === true || !!(reg && reg.get('router-daemon') && reg.get('router-daemon').desired === 'running') },
      { kind: 'lan-daemon', port: g.getCtl().lanPort(), active: () => g.getDaemons().lanActive(), managed: () => g.getDaemons().lanManaged(), want: () => g.getDaemons().enabled() || !!(reg && reg.get('lan-daemon') && reg.get('lan-daemon').desired === 'running') },
    ];
    for (const d of daemons) {
      if (!d.active()) continue;
      if (!d.want() && !d.managed()) {
        issues.push({ kind: d.kind, port: d.port, why: '端口被监听但本守卫期望停止且无管理锁（异主/残留 daemon）' });
      }
    }
    // 端口登记残留（owner=inst:* 而实例已不存在）
    try {
      const insts = call(g.getInstances, null);
      const ids = new Set(insts ? insts.map((i) => i.id) : []);
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!ids.has(id)) issues.push({ kind: 'port-registration', owner: rec.owner, port: rec.port, why: '端口登记 owner 指向已不存在的实例（残留登记）' });
      }
    } catch {}
    // 幽灵登记观测线索：期望运行但实然长期失联（main 由收敛接管，跳过避免噪声）
    try {
      const staleMs = Math.max(3 * (g.getConfig().probeIntervalMs || 5000), 30000);
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
    const lastKey = call(g.getLastKey, null);
    const lastAt = call(g.getLastAt, null);
    if (lastKey === key && lastAt && now - lastAt < 10 * 60 * 1000) return; // 同指纹抑制
    if (typeof g.setLastKey === 'function') g.setLastKey(key);
    if (typeof g.setLastAt === 'function') g.setLastAt(now);
    const events = call(g.getEvents, null);
    if (events && events.append) { try { events.append('orphan_audit', { issues, at: new Date().toISOString() }); } catch {} }
    const detail = issues.map((i) => i.kind + (i.id ? ':' + i.id : '') + (i.port ? ':' + i.port : '') + (i.owner ? ':' + i.owner : '') + ' ' + i.why).join(' | ');
    const logger = call(g.getLogger, null);
    logger && logger.warn && logger.warn('[orphan] 游离对象自检: ' + detail);
  } catch (e) {
    const logger = call(g.getLogger, null);
    logger && logger.warn && logger.warn('[orphan] 自检异常: ' + ((e && e.message) || e));
  }
}

/** host 兼容外壳：facets.js 的 { methods } 把本函数装到 host（this=host）。
 *  抑制状态仍读写 host 上的 _lastOrphanKey/_lastOrphanAt（与既有初始化点同源）。 */
function hostOrphanAudit() {
  return orphanAudit({
    getConfig: () => this.config,
    getLogger: () => this.logger,
    getEvents: () => this.events,
    getInstances: () => this.instances,
    getManagedObjects: () => this.managedObjects,
    getCtl: () => this.ctl,
    getDaemons: () => this.daemons,
    getStopping: () => this._stopping,
    getLastKey: () => this._lastOrphanKey,
    setLastKey: (v) => { this._lastOrphanKey = v; },
    getLastAt: () => this._lastOrphanAt,
    setLastAt: (v) => { this._lastOrphanAt = v; },
  });
}

module.exports = { methods: { _orphanAudit: hostOrphanAudit }, orphanAudit };
