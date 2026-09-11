'use strict';

// 本地 HTTP API 网关（默认 127.0.0.1:3100；面板「局域网访问」开关可改 0.0.0.0）。
// 安全边界：
//  - 默认仅回环绑定；开启局域网访问后，局域网内设备可访问面板/API；
//  - 只允许本机(回环)与 RFC1918 私有 IP 的 Host/Origin → 外部/公网主机被拒（挡公网）；
//  - 不返回 CORS 头（面板同源托管）→ 其他网站浏览器请求读不到响应；
//  - 带 Origin 的写请求必须来自本机/局域网面板来源 → 外部网页无法驱动 start/stop/upgrade。
// 路由按域拆分至同目录（tasks/lifecycle/native/guard/router/plugins/dist/instances/relay）：
// 每域模块导出 owns(pathname) + handle(ctx)；本网关做安全门卫后按域分派，未归属请求落静态/404。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_DOMAINS = [
  require('./tasks'),
  require('./lifecycle'),
  require('./native'),
  require('./guard'),
  require('./router'),
  require('./plugins'),
  require('./dist'),
  require('./instances'),
  require('./relay'),
  require('./shell'),   // 桌面壳更新安全网（/shell/*）——内核仅做安全网，非更新源
];

// 前端静态资源目录解析（2026-09-02：新 React UI 全面接管，老 vanilla ui/ 已删除退出；
//  2026-09-06 Phase 1 修复：SEA/esbuild 打包后 __dirname 不再等于源码目录，改多候选探测覆盖全部发行形态）。
//  候选（按优先级，命中 supervisor.html 即用）：
//    0) $DSH_UI_DIR                     — 显式注入（测试/特殊部署）
//    1) <__dirname>/ui-react            — Node launcher 统一形态（core.cjs 同目录 ui-react）2026-09 定案
//    2) <exe 同目录>/ui-react            — SEA 单文件分发态（dist/sea 旁放 ui-react）
//    3) <exe>/../ui-react                — npm 子包态（pkg/bin/dsh-supervisor + pkg/ui-react）
//    4) <repo 根>/ui-react               — 源码态发布镜像（release.sh 产物）
//    5) <repo 根>/ui/dist                — 开发态（ui 源码 npm run build 产物）
//  esbuild/launcher 中 __dirname = core.cjs 真实所在目录，1/2/3 覆盖发行态，4/5 覆盖源码态。
function resolveUiDir() {
  const exeDir = (function () {
    try { return require('node:path').dirname(process.execPath); } catch { return __dirname; }
  })();
  const candidates = [
    process.env.DSH_UI_DIR || null,
    require('node:path').join(__dirname, 'ui-react'),         // ① launcher 统一形态（core.cjs 旁）
    require('node:path').join(exeDir, 'ui-react'),
    require('node:path').join(exeDir, '..', 'ui-react'),
    require('node:path').join(__dirname, '..', '..', 'ui-react'),
    require('node:path').join(__dirname, '..', '..', 'ui', 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(require('node:path').join(dir, 'supervisor.html'))) return dir; } catch {}
  }
  return null;
}
const UI_DIR = resolveUiDir();
if (!UI_DIR) {
  console.error('[ui] 未找到新 React UI 产物（期望 supervisor.html；候选：ui-react / ui/dist / $DSH_UI_DIR）。');
  console.error('[ui] 请先执行 release/scripts/build-ui.sh（或开发态在 ui 目录 npm run build）。');
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";


// 安全信任根（P0-1 结构性修复）：访问者身份 = socket 层事实（req.socket.remoteAddress），
// 唯一判定实现见 ./identity.js。请求头（Host/Origin）只做浏览器语义的深化校验，
// 绝不参与身份/鉴权判定——详见 identity.js 头注与 DESIGN.md 安全边界契约。
const { identify } = require('./identity');

/**
 * 本地 HTTP API（默认 127.0.0.1:3100；面板「局域网访问」开关可改为 0.0.0.0）。
 * 安全边界（三层，职责单一）：
 *  1. 身份层（identity.js，socket 事实）：回环/私有网段判定——token 下发、access-key
 *     豁免只消费该层；公网来源连不上（远端地址非 RFC1918/回环）。
 *  2. CSRF 深化层（originAllowed）：带 Origin 的写请求须与本服务同源——防"用户浏览器
 *     里的恶意网页"驱动 API；身份层不覆盖该威胁（浏览器发起的请求源 IP 是合法的）。
 *  3. 访问密钥层（apiAccessKey，可选）：非回环请求须携带 Bearer/?access_key=。
 *  不返回 CORS 头（面板同源托管 + 壳源白名单）→ 其他网站浏览器读不到响应。
 */

/** 有界 body 读取：超过 maxBytes 时先应答 413 再断开连接。
 *  旧实现直接 req.destroy() 且不响应，客户端会永久挂起；这里保证任何输入都有终态应答。 */
function collectBody(req, res, maxBytes, onDone) {
  let body = '';
  let over = false;
  req.on('data', (d) => {
    if (over) return;
    body += d;
    if (body.length > maxBytes) {
      over = true;
      body = '';
      try {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
        }
      } catch {}
      req.destroy();
    }
  });
  req.on('error', () => {});
  req.on('end', () => { if (!over) onDone(body); });
}
// CSRF 深化校验（第二层）：带 Origin 的写请求须与本服务同源。
// 职责单一：只防"用户浏览器里的恶意网页驱动 API"——访问者身份已由 identity.js
// 的 socket 层事实判定，本函数不做（也不需要做）来源可信性判断。
function originAllowed(req, apiPort) {
  const o = req.headers.origin;
  if (!o) return true; // curl / CLI / 同源 GET 无 Origin
  try {
    const u = new URL(o);
    const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return port === String(apiPort);
  } catch {
    return false;
  }
}

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

/** 常数时间字符串比较（防时序侧信道）。 */
function safeKeyEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 请求是否携带正确的出回环访问密钥（apiAccessKey，F2 定案）：
 *  Authorization: Bearer <key> 或 ?access_key=<key> 二选一（常数时间比较）。
 *  无密钥配置时恒放行（本函数不调用：调用侧仅在配置了 key 且非回环请求时才走门卫）。 */
function requestHasAccessKey(req, key) {
  if (!key) return true;
  const ah = req.headers.authorization;
  if (typeof ah === 'string' && ah.startsWith('Bearer ') && safeKeyEqual(ah.slice(7), key)) return true;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('access_key');
    if (q && safeKeyEqual(q, key)) return true;
  } catch {}
  return false;
}

/**
 *   GET  /status              → 状态摘要
 *   GET  /events?after=&limit=→ 增量事件
 *   POST /start               → desired=running
 *   POST /stop                → desired=stopped（停 DSH 并保持不拉起）
 *   POST /restart             → 立即重启一次（不改变 desired）
 *   GET  /version             → 已安装/最新版本
 *   GET  /upgrade/status      → 升级状态机详情
 *   POST /version/check       → 触发一次版本检查
 *   POST /upgrade {version?}  → 一键升级（先停后装，失败自动回滚）
 *   GET  /                    → 控制面板首页（React UI：ui-react 或 ui/dist 的 supervisor.html）
 */
function createServer(sup) {
  return http.createServer((req, res) => {
    // 本地壳源（Tauri asset 页 tauri:// / *.tauri.localhost）CORS 白名单：
    // 壳内 supervisor.html 与 API 不同源但同机，放行其直连（替代 api_proxy 透传，2026-09-07）。
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
    // DshTokenService（原生与沙箱共用同一套获取/分发，见 src/platform/token.js）。生成直连认证 URL
    // 时按目标查取，绝不跨实例借用（主实例令牌套到沙箱实例 → 401 “dsh web authentication required”）。
    const tokOf = (id) => {
      try { if (sup.tokenService && typeof sup.tokenService.get === 'function') return sup.tokenService.get(id) || ''; } catch {}
      return '';
    };

    // ── 访问者身份（第一层，socket 事实）：唯一判定入口见 ./identity.js ──
    // token 下发 / access-key 豁免一律消费 identity.loopback——绝不从请求头推断来源。
    const identity = identify(req);

    // ── 访问密钥门卫（第三层，apiAccessKey 可选配置）──
    // 非回环请求（0.0.0.0 局域网 / FRP 通道）必须携带 Authorization: Bearer <key>
    // 或 ?access_key=<key>；回环豁免——CLI/同机面板语义必需。
    // OPTIONS 预检豁免（浏览器跨源探测不发自定义头，给 204 而非 401）。
    const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
    if (accessKey && !identity.loopback && req.method !== 'OPTIONS' && !requestHasAccessKey(req, accessKey)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>' }));
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


    // 路径段安全解码（单点）：畸形百分号编码 → 400。域 handler 只拿已解码的
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
      const file = pathname.slice(1); // 去掉前导 /
      if (file.startsWith('assets/') || file === 'dsh-logo.svg') {
        return serveStatic(res, file, shellOrigin);
      }
    }

    // 404
    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

function serveStatic(res, file, corsOrigin) {
  if (!UI_DIR) {
    // UI 缺失（未构建/部署裁剪）：显式 503，绝不抛 TypeError 触发守卫自杀重启
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run release/scripts/build-ui.sh or set DSH_UI_DIR');
  }
  const full = path.join(UI_DIR, file);
  // 路径穿越防护：relative 必须落在 UI_DIR 内部
  const rel = path.relative(UI_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    if (corsOrigin) { headers['Access-Control-Allow-Origin'] = corsOrigin; }
    // 面板资源一律不缓存（no-store）：前端改动立即生效——避免浏览器缓存旧版
    // 导致的渲染异常（如卡片锁定状态不显示等）
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(500);
      res.end('internal error');
    }
  }
}

module.exports = { createServer };
