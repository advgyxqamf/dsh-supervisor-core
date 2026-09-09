'use strict';

// 域：镜像源分发 API（/dist/registry*，DistributionManager 统一管理）。
function owns(pathname) {
  return pathname.startsWith('/dist/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;

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
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
