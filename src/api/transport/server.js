'use strict';

// api/transport/server —— 本地 HTTP 网关本体（传输层原语，与 ./body.js 同层）。
// 安全判定见 ../security.js；静态托管见 ../static.js；body 读取 ./body.js；
// 域注册表 ../router-table.js；契约面 ../contract.js；每域依赖 ../deps.js。
// 注：api 契约面扫描只扫 api 顶层 + api/domains/，网关里的静态资源路由字面量不属于契约面。
//
const http = require('node:http');

const { API_DOMAINS } = require('../router-table');
const { collectBody } = require('./body');
const { serveStatic } = require('../static');
const { identify } = require('../identity');
// 安全判定（Host/Origin 闸、访问密钥）——唯一实现在 ../security.js。
const { originAllowed, requestHasAccessKey } = require('../security');

/** 请求级失败的统一兜底：只应答一次（头已发则仅断开），并记录一条错误事件。
 *  绝不把异常抛给进程层（对比：bin 的 uncaughtException 策略是 3 次自杀重启）。 */
function safeFail(res, err, where) {
  try {
    const body = JSON.stringify({ ok: false, error: (err && err.message) || String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    }
    try { res.end(body); } catch {}
  } catch {}
  try { console.error('[api] handler error (' + (where || '?') + '):', (err && err.stack) || err); } catch {}
}

/**
 *   GET  /status             状态摘要
 *   GET  /events?after=&limit= 增量事件
 *   GET  /lifecycle/{id}     统一生命周期视图（main 启停：/lifecycle/dsh/{start|stop|restart}）
 *   GET  /native/status      原生 DSH 版本/升级状态
 *   POST /native/upgrade     一键升级（先停后装，失败自动回滚）
 *   GET  /                   控制面板首页（React UI：ui-react 或 ui/dist 的 supervisor.html）
 */
function createServer(sup) {
  return http.createServer((req, res) => {
    // 本地壳源（Tauri asset 页 tauri:// / *.tauri.localhost）CORS 白名单：
    // 壳内 supervisor.html 与 API 不同源但同机，放行其直连。
    // 其他 Origin 维持零 CORS（防外部网页读取）。
    const shellOrigin = (() => {
      const o = req.headers.origin;
      if (!o) return null;
      try {
        const u = new URL(o);
        const host = u.hostname.toLowerCase();
        if (u.protocol === 'tauri:' && host === 'localhost') return o;
        if ((u.protocol === 'http:' || u.protocol === 'https:') && (host === 'tauri.localhost' || host.endsWith('.tauri.localhost'))) return o;
      } catch {}
      return null;
    })();
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      const hdrs = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (shellOrigin) { hdrs['Access-Control-Allow-Origin'] = shellOrigin; hdrs['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'; hdrs['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'; }
      res.writeHead(code, hdrs);
      res.end(body);
    };

    // 每实例的 DSH 访问令牌（随实例重启轮换）只有一个权威来源：唯一令牌节点
    // DshTokenService（原生与沙箱共用同一套获取/分发，见 src/platform/service/token/）。生成直连认证 URL
    // 时按目标查取，绝不跨实例借用（主实例令牌套到沙箱实例会 401 "dsh web authentication required"）。
    const tokOf = (id) => {
      try { if (sup.tokenService && typeof sup.tokenService.get === 'function') return sup.tokenService.get(id) || ''; } catch {}
      return '';
    };

    // 访问者身份（第一层，socket 事实）：唯一判定入口见 ../identity.js
    // token 下发 / access-key 豁免一律消费 identity.loopback——绝不从请求头推断来源。
    const identity = identify(req);

    // 访问密钥门卫（第三层，apiAccessKey 可选配置）
    // fail-closed：非回环请求（0.0.0.0 局域网 / FRP 通道）必须携带**匹配的** key ——
    //   未配置 key 时同样拒绝，**不再「整层跳过」**。否则 apiHost='0.0.0.0' 且未设 key 时，
    //   局域网任意主机可零认证驱动写 API（配合 security.js 对无 Origin 请求的放行与
    //   Host 允许 RFC1918，构成完整旁路）。回环豁免——CLI/同机面板语义必需。
    // OPTIONS 预检豁免（浏览器跨源探测不发自定义头，给 204 而非 401）。
    const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
    if (!identity.loopback && req.method !== 'OPTIONS' && (!accessKey || !requestHasAccessKey(req, accessKey))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      const why = accessKey
        ? '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>'
        : '未配置访问密钥（apiAccessKey）：非回环请求一律拒绝。请先设置访问密钥，或将 apiHost 收回 127.0.0.1';
      return res.end(JSON.stringify({ error: why }));
    }

    // OPTIONS 预检：壳源放行（含 Allow-*），其余跨站预检不给任何 CORS 头
    if (req.method === 'OPTIONS') {
      if (shellOrigin) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': shellOrigin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Max-Age': '600',
        });
      } else {
        res.writeHead(204);
      }
      return res.end();
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(400, { error: 'bad request' });
    }


    // 路径段安全解码（单点）：畸形百分号编码返回 400。域 handler 只拿已解码的
    // 干净字符串，任何域不得自行 decodeURIComponent（异常边界唯一化的组成部分）。
    let decodedPathname;
    try {
      decodedPathname = pathname.split('/').map((seg) => {
        try { return decodeURIComponent(seg); } catch { throw new Error('bad encoding'); }
      }).join('/');
    } catch (e) {
      return send(400, { error: 'bad request encoding' });
    }

    const ctx = { sup, req, res, pathname: decodedPathname, identity, send, collectBody, originAllowed, tokOf };

    // 按域分派（每域 owns 为粗前缀超集；域内未匹配由该域 handle 兜底 404/405）。
    // 统一异常边界：handler 同步抛错 / 返回的 Promise reject 一律在此兜底为 500——
    // 请求级错误绝不穿透为进程级 uncaughtException（异常处理层级归位，RC3）。
    for (const d of API_DOMAINS) {
      if (d.owns(pathname)) {
        try {
          const out = d.handle(ctx);
          if (out && typeof out.catch === 'function') out.catch((e) => safeFail(res, e, 'handler'));
        } catch (e) { safeFail(res, e, 'handler'); }
        return;
      }
    }

    // 静态文件（新 React UI 产物：assets/ 哈希文件开放）
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/supervisor.html') {
        return serveStatic(res, 'supervisor.html', shellOrigin);
      }
      const file = pathname.slice(1);
      if (file.startsWith('assets/') || file === 'dsh-logo.svg') {
        return serveStatic(res, file, shellOrigin);
      }
    }

    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

module.exports = { createServer };
