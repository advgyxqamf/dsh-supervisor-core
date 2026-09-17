'use strict';

// 域：镜像源分发 API（/dist/registry*，DistributionManager 统一管理）。
function owns(pathname) {
  return pathname.startsWith('/dist/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    // 全局统一分发：镜像源配置由 DistributionManager 统一管理（DSH 自升级 + 反代共用）——仅 /dist/registry*。
    if (req.method === 'GET' && pathname === '/dist/registry') {
      Promise.resolve(sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 8192, (body) => { try { const j = body ? JSON.parse(body) : {}; Promise.resolve(sup.dist.setRegistryConfig(j)).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message })); } catch (e) { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/dist/registry/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      sup.dist.selectRegistry(true).then(() => sup.dist.registryInfo()).then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    // 同源镜像探活端点。
    //
    // 背景：设置页的「测试」按钮若由浏览器直连用户填写的镜像源，会被本页 CSP
    //   `connect-src 'self'`（见 index.js）在发起前拦截，fetch 立刻 reject，
    //   UI 无法区分「真的不可达」与「被策略阻断」。
    // 做法：走同源后端探活（服务端 fetch 不受页面 CSP 约束），并由 DistributionManager
    //   用与内核选源一致的探测规格（探针路径取自 distribution 的 _probeRegistry）。
    if (req.method === 'POST' && pathname === '/dist/registry/probe') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return collectBody(req, res, 4096, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        const origin = String(j.origin || '').trim();
        if (!/^https?:\/\//.test(origin)) return send(400, { ok: false, error: 'origin 必须以 http(s):// 开头' });
        Promise.resolve(sup.dist.probeOrigin(origin))
          .then((r) => send(200, { ok: true, ...r }))
          .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      });
    }

  // 域内未匹配(方法/子路径)：全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
