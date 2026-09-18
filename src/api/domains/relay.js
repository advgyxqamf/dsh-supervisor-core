'use strict';

// 域：远程控制/中继 API（lan frp / lan-access）。
function owns(pathname) {
  return pathname === '/lan-access' || pathname.startsWith('/lan/frp/') || pathname === '/lan/frp';
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/lan/frp') {
      return Promise.resolve(sup.frpStatus()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname.startsWith('/lan/frp/')) {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/lan/frp/'.length);
      collectBody(req, res, 65536, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        // frp 操作统一经 lan 门面（presentation 不直连 frpmgr）
        if (act === 'settings' || act === 'install' || act === 'toggle') {
          return sup.lanFrpc(act, j).then((r) => send(r && r.ok !== false ? 200 : (r && r.needInstall ? 400 : 500), r)).catch((e) => send(500, { ok: false, error: e.message }));
        }
        if (act === 'expose') {
          if (!j.id) return send(400, { ok: false, error: 'need id' });
          // 与 :21 的 settings/install/toggle 同规：结果 {ok:false}（如空令牌被暴露闸拒绝）不得回 200，
          //   否则 UI 显示「已开启」而实际未开（FIX-1 暴露闸的可观测面收口）。
          return Promise.resolve(sup.setLanFrp(j.id, !!j.frpEnabled, j.remotePort)).then((r) => send(r && r.ok !== false ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: e.message }));
        }
        return send(404, { error: 'not found' });
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/lan-access') {
      return Promise.resolve(sup.listLan()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
  // 域内未匹配(方法/子路径)：全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
