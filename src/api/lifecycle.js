'use strict';

// 域：统一生命周期 API（status/lifecycle/healthz/readyz/events）。
const { isInternalEvent } = require('../platform/loghub');

// R3 C3-5a：旧 /start|/stop|/restart 路由删除（前端已无引用）——main 启停唯一入口 /lifecycle/dsh/{start|stop|restart}。
function owns(pathname) {
  return pathname === '/status' || pathname.startsWith('/lifecycle') || pathname === '/healthz' || pathname === '/readyz' || pathname === '/events' || pathname.startsWith('/logs') || pathname === '/metrics';
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

    // API 路由
    if (req.method === 'GET' && pathname === '/status') {
      return send(200, sup.statusSummary());
    }

    // ══ 统一生命周期接口（2026-09 归一化架构：所有模块生命周期经此，前端不再直调模块对象）══
    // GET /lifecycle/status      → 全部模块生命周期状态一览
    // GET /lifecycle/{id}        → 单个模块状态
    // POST /lifecycle/{id}/start | /stop | /restart
    if (pathname === '/lifecycle' || pathname === '/lifecycle/status') {
      const lm = sup.lifecycleManager;
      return send(200, lm ? { modules: lm.statusAll() } : { modules: [] });
    }
    if (pathname.startsWith('/lifecycle/')) {
      const lm = sup.lifecycleManager;
      if (!lm) return send(503, { error: 'lifecycleManager 未初始化' });
      const rest = pathname.slice('/lifecycle/'.length);
      const parts = rest.split('/');
      const id = parts[0]; // 已由分派器统一安全解码（畸形编码 400），域内不得再 decode
      const action = parts[1] || null;
      if (req.method === 'GET' && !action) {
        const lc = lm.get(id);
        return lc ? send(200, lc.snapshot()) : send(404, { error: '模块未注册: ' + id });
      }
      if (req.method === 'POST' && action) {
        // R3 C3-5a：写动作统一经本入口 → Origin 门禁在此（旧 /start|/stop|/restart 曾各自门禁，已删）。
        if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
        const lc = lm.get(id);
        if (!lc) return send(404, { error: '模块未注册: ' + id });
        // main(dsh) 启停收敛到统一生命周期入口（2026-09 归一化：不再直通 supervisor.setDesired，
        // 经 lm.start/stop/restart → adapters dsh 的 start/stop → setDesired/requestRestart，
        // 动作申报进 lifecycleManager（审计/事件），形状经 snapshot 补 desired/phase 保持一致）。
        if (id === 'dsh' && sup && (action === 'start' || action === 'stop' || action === 'restart')) {
          const act = action === 'start' ? lm.start(id)
            : action === 'stop' ? lm.stop(id, 'user')
            : lm.restart(id);
          return act.then((r) => {
            if (r && r.error) return send(409, { ok: false, error: r.error });
            const snap = sup.statusSummary ? sup.statusSummary() : {};
            return send(200, { ok: r.ok !== false, desired: snap.desired || sup.desired, phase: snap.phase || sup.phase });
          }).catch((e) => send(500, { error: e.message }));
        }
        if (action === 'start') { lm.start(id).then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'stop') { lm.stop(id, 'user').then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'restart') { lm.restart(id).then((r) => send(200, r)).catch((e) => send(500, { error: e.message })); return; }
        return send(400, { error: '未知动作: ' + action + '（start|stop|restart）' });
      }
      return send(400, { error: '非法请求' });
    }

    // 健康 / readiness（infra/health）
    if (req.method === 'GET' && pathname === '/healthz') {
      return send(200, sup.health ? sup.health.live() : { ok: true, pid: process.pid });
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      return send(200, sup.health ? sup.health.ready() : { ok: true, ready: true });
    }

    if (req.method === 'GET' && pathname === '/events') {
      let after = 0;
      let limit = 50;
      let filter = null;
      let showInternal = false;
      try {
        const u = new URL(req.url, 'http://localhost');
        after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
        limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 50) || 50, 1), 500);
        showInternal = u.searchParams.get('internal') === '1' || u.searchParams.get('internal') === 'true';
        const src = u.searchParams.get('source');
        const typ = u.searchParams.get('type');
        if (src || typ) filter = { source: src || undefined, type: typ || undefined };
      } catch {}
      // 系统日志框架（P1b/P2）：/events 对外读守卫 EventHub 聚合流（gseq 全局有序；跨守卫重启连续）。
      // 时间线可读性：默认过滤内部簿记事件（heartbeat 影子 shadow_* / 注册机 managed_object_*，
      // 已在聚合时打 internal 标）——它们只进审计（/logs/export、internal=1）；UI 时间线只显示业务事件。
      // hub 未启用（初始化失败/降级）时退回守卫本地事件流。
      let list = [];
      let seq = 0;
      if (sup.eventHub) {
        seq = sup.eventHub.seq;
        if (showInternal) {
          list = filter ? sup.eventHub.readFiltered(filter, after, limit) : sup.eventHub.read(after, limit);
        } else if (filter) {
          // 检索也排除内部簿记（审计用 internal=1 / /logs/export）
          list = sup.eventHub.readFiltered(filter, after, limit).filter((e) => (e.internal === undefined ? !isInternalEvent(e && e.type) : !e.internal));
        } else {
          // 用户时间线：全窗过滤 internal 后取尾——避免『先 limit 后过滤 → 被内部事件挤空』
          list = sup.eventHub.readVisible(after, limit);
        }
      } else {
        seq = sup.events.seq;
        list = sup.events.readSince(after, limit);
        if (!showInternal) list = list.filter((e) => (e.internal === undefined ? !isInternalEvent(e && e.type) : !e.internal));
      }
      return send(200, { seq, events: list });
    }

    // 系统日志框架（P1b）：/logs/tail?stream=guard|router|lan|dsh|upgrade&n= 排障日志尾部；
    // /logs/events-tail?n= 聚合事件尾部（等价 /events 全量读，供 CLI/调试）。
    if (req.method === 'GET' && pathname === '/logs/tail') {
      const u = new URL(req.url, 'http://localhost');
      const stream = u.searchParams.get('stream') || 'guard';
      const n = Math.min(Math.max(Number(u.searchParams.get('n') || 100) || 100, 1), 2000);
      if (sup.eventHub) {
        return send(200, { stream, lines: sup.eventHub.tailLog(stream, n) });
      }
      return send(200, { stream, lines: [] });
    }
    if (req.method === 'GET' && pathname === '/logs/events-tail') {
      const u = new URL(req.url, 'http://localhost');
      const n = Math.min(Math.max(Number(u.searchParams.get('n') || 100) || 100, 1), 500);
      if (sup.eventHub) {
        return send(200, { seq: sup.eventHub.seq, events: sup.eventHub.eventTail(n) });
      }
      return send(200, { seq: sup.events.seq, events: sup.events.readSince(0, n) });
    }

    // 系统日志框架（P2）：/logs/export?after=&limit= 审计导出（聚合流 JSONL 原文，离线备份）。
    if (req.method === 'GET' && pathname === '/logs/export') {
      const u = new URL(req.url, 'http://localhost');
      const after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 2000) || 2000, 1), 20000);
      if (sup.eventHub) {
        const lines = sup.eventHub.exportLines(after, limit);
        return send(200, { seq: sup.eventHub.seq, exported: lines.length, lines });
      }
      return send(200, { seq: sup.events.seq, exported: 0, lines: [] });
    }

    // 系统日志框架（P2）：/metrics 遥测（事件流派生只读投影，不新增采集通道）。
    if (req.method === 'GET' && pathname === '/metrics') {
      if (sup.eventHub) return send(200, sup.eventHub.metrics());
      return send(200, { gseq: sup.events.seq, events: 0, bySource: {}, topTypes: [], sinceLastMs: null, ts: new Date().toISOString() });
    }

  // R3 C3-5a：旧 /start|/stop|/restart 路由已删除——main 启停唯一入口 /lifecycle/dsh/{start|stop|restart}
  // （语义保持见上方 dsh 直通分支；其它模块启停 /lifecycle/{id}/{action}）。
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
