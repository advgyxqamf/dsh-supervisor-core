'use strict';

// 域：镜像源分发 API（/dist/registry*，DistributionManager 统一管理）。
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');

function owns(pathname) {
  return pathname.startsWith('/dist/');
}

/** #12 盲 SSRF 收口：探测目标策略。返回错误文案，放行返回 null。
 *
 *  原状：/dist/registry/probe 只校验 origin 以 http(s):// 开头，于是**请求体可指定任意主机**
 *  —— 守卫被当成内网可达性/延迟探针（盲 SSRF）。
 *
 *  现策略（两层，保守但保留既有能力）：
 *    ① 已配置镜像源（distribution 的唯一事实源 effectiveOrigins，经 _registryOrigins() 取用）
 *       按 hostname 直接放行 —— 操作者有意配置的内网镜像必须仍可测试；
 *    ② 其余只允许**公网**主机：拒绝回环 / RFC1918 / 链路本地 169.254/16 / CGNAT 100.64/10 /
 *       保留段 0/8 与 224+/4 / localhost 与 .local .internal .home.arpa / IPv6 ::1 :: ULA fc00::/7 与
 *       链路本地 fe80::/10。UI 的「添加自定义镜像前先测活」流程仍然可用（公网地址不受限）。
 *
 *  保留 ^https?: 字面校验作为协议层第一道闸（且 test/round13-csp-probe-test.js:72 以源码形态钉住它）。
 *
 *  重定向（原「已知未覆盖」**已闭环**）：platform/distribution/registry.js 的 probeRegistry 已改为
 *    `redirect: 'manual'` + 显式「非 2xx 即失败」，故公网主机 302 到内网地址不再绕回本策略。
 */
function probeTargetError(origin, sup) {
  let u = null;
  try { u = new URL(origin); } catch { return 'origin 不是合法 URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'origin 必须以 http(s):// 开头';
  if (u.username || u.password) return 'origin 不允许携带用户名或密码';
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'origin 缺少主机名';

  // ① 已配置镜像源：按 hostname 放行
  let configured = [];
  try {
    configured = (sup && sup.dist && typeof sup.dist._registryOrigins === 'function')
      ? (sup.dist._registryOrigins() || []) : [];
  } catch { configured = []; }
  for (const c of configured) {
    try { if (new URL(String(c)).hostname.toLowerCase().replace(/^\[|\]$/g, '') === host) return null; } catch {}
  }

  // ② 其余仅允许公网主机
  const deny = '安全策略：探测目标仅允许公网地址（已配置的镜像源不在此限）';
  // IPv6 字面量一律拒绝：无需枚举分段（URL 会把 ::ffff:127.0.0.1 归一成 ::ffff:7f00:1 这类十六进制形态，
  //   逐段判前缀有绕过面）；镜像源应写域名或 IPv4，且已配置源已在①放行。
  if (host.includes(':')) return deny;
  // 单标签主机名（无点）拒绝：内网 DNS 短名（intranet/metadata/…）会经搜索域解析到内网。
  if (!host.includes('.')) return deny;
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return deny;
  if (isLoopbackAddress(host) || isPrivateIpv4(host)) return deny;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const o = Number(v4[1]), t = Number(v4[2]);
    if (o === 0 || o >= 224) return deny;              // 未指定 / 组播 / 保留
    if (o === 169 && t === 254) return deny;            // 链路本地（含云元数据 169.254.169.254）
    if (o === 100 && t >= 64 && t <= 127) return deny;  // CGNAT
  }
  return null;
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
        const targetErr = probeTargetError(origin, sup);
        if (targetErr) return send(400, { ok: false, error: targetErr });
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
