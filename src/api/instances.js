'use strict';

// 域：实例管理 API（沙箱实例 CRUD/启停/open-web/版本更新）。
function owns(pathname) {
  return pathname === '/instances' || pathname.startsWith('/instances/');
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;
  const platform = require('../platform/os/index');
  function openInSystemBrowser(url) { return platform.browser.open(url); }

    if (req.method === 'GET' && pathname === '/instances') {
      // 附加打开链接：本机直连（带 DSH 认证 token）与局域网 relay（免认证）。
      // token 一律从唯一令牌节点按实例解析（见 tokOf）：原生与沙箱同源。
      // L3b：sup.listLan() 在 lan-daemon 监督模式为异步（ctl 委托），统一 Promise.resolve 兼容。
      // ── 概念清分（2026-09-06）──
      //   instances[] = 沙箱实例（管理对象：CRUD/启停/升级全属沙箱 API）
      //   native      = 原生主干 main（唯一；其生命周期/升级不属 /instances 沙箱 API——
      //                启停 /lifecycle/dsh/*、安装/升级/卸载 /native/*。此处仅提供只读条目供
      //                横切视图（如远程控制）取端口/开关；对象上不带沙箱 CRUD 语义）
      const decorate = (it, lanItems, lanAddrs) => {
        const lan = lanItems.find((x) => x.id === it.id) || null;
        const tok = tokOf(it.id);
        const lanAddr = lanAddrs[0] || '127.0.0.1';
        const out = Object.assign({}, it);
        const loopback = identity.loopback;
        out.authUrl = (tok && loopback)
          ? ('http://127.0.0.1:' + it.port + '/?token=' + encodeURIComponent(tok))
          : ('http://127.0.0.1:' + it.port + '/');
        out.tokenPresent = loopback && !!tok;
        const wan = lan && lan.wanPort;
        out.lanUrl = wan ? ('http://' + lanAddr + ':' + wan + '/') : null;
        out.lanRunning = !!(lan && lan.running);
        return out;
      };
      const render = (ll) => {
        const lanItems = (ll && ll.items) || [];
        const lanAddrs = (ll && ll.addresses) || [];
        // 概念清分：沙箱来自 InstanceManager；原生主干(main)来自守卫核心 dshMainView()（不再混存沙箱数组）
        const sandboxes = (sup.instances.list() || []).filter((i) => i.domain === 'sandbox');
        const main = (sup.dshMainView && typeof sup.dshMainView === 'function') ? sup.dshMainView() : null;
        return send(200, {
          instances: sandboxes.map((it) => decorate(it, lanItems, lanAddrs)),
          native: main ? decorate(main, lanItems, lanAddrs) : null,
        });
      };
      return Promise.resolve(sup.listLan()).then(render).catch(() => render({ items: [], addresses: [] }));
    }
    if (req.method === 'POST' && pathname.startsWith('/instances/')) {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/instances/'.length);
      collectBody(req, res, 65536, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (act === 'add') {
            const r = sup.instances.addInstance(j);
            return send(r.ok ? 200 : 400, r);
          }
          // ── 沙箱/原生清分护栏：main（原生主干）的生命周期/更新不属沙箱实例 API ──
          // 原生主干唯一操作渠道：启停 /lifecycle/dsh/*、安装/升级/卸载/版本 /native/*。
          // 此处拦截一切落到 main 的管理动作（防双轨：守卫 spawn 语义 vs systemd-run 沙箱语义）。
          if (j.id) {
            const target = (sup.instances.instances || []).find((x) => x.id === j.id);
            if (target && target.domain === 'native' && act !== 'open-web') {
              const hint = (act === 'start' || act === 'stop' || act === 'restart')
                ? '原生主实例请经 /lifecycle/dsh/start|stop 启停'
                : '原生主实例请经 /native/* 管理（安装/升级/卸载/版本检测）';
              return send(400, { ok: false, error: hint });
            }
          }
          if (act === 'remove' && j.id) return send(200, sup.instances.removeInstance(j.id));
          if (act === 'update' && j.id) return send(200, sup.instances.updateInstance(j.id, j));
          if (act === 'start' && j.id) return Promise.resolve(sup.instances.startInstance(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'stop' && j.id) return send(200, sup.instances.stopInstance(j.id));
          // 用系统默认浏览器打开该实例的 DSH Web（带认证连接；解决 Tauri/WebView 中 window.open 被拦）
          if (act === 'open-web' && j.id) {
            try {
              // 概念清分：main 走守卫核心视图；沙箱走实例列表
              const it = (j.id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function')
                ? sup.dshMainView()
                : ((sup.instances.list() || []).find((x) => x.id === j.id) || null);
              if (!it) return send(404, { ok: false, error: '实例不存在' });
              const tok = tokOf(j.id);
              const url = tok ? ('http://127.0.0.1:' + it.port + '/?token=' + encodeURIComponent(tok)) : ('http://127.0.0.1:' + it.port + '/');
              // 安全校验：只允许本机回环 + 该实例真实端口（防开放重定向）
              const expectPrefix = 'http://127.0.0.1:' + it.port + '/';
              if (url !== expectPrefix && !url.startsWith(expectPrefix + '?token=')) return send(400, { ok: false, error: '非法地址' });
              const ok = openInSystemBrowser(url);
              return send(ok ? 200 : 500, { ok, url });
            } catch (e) { return send(500, { ok: false, error: e.message }); }
          }
          // 沙箱实例版本更新：检查 / 升级（job 模型，前端轮询 upgrade/status）
          if (act === 'check-update' && j.id) return Promise.resolve(sup.instances.checkUpdate(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade' && j.id) return Promise.resolve(sup.instances.upgradeInstance(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade/status' && j.id) return send(200, sup.instances.upgradeStatus(j.id));
          return send(404, { error: 'not found' });
        } catch (e) { return send(500, { ok: false, error: e.message }); }
      });
      return;
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
