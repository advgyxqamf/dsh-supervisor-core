'use strict';

// 局域网反向代理：把 0.0.0.0:<lanPort> 的流量转发到本机回环的 DSH Web。
// 设计要点：
//  - DSH 本体保持只监听 127.0.0.1，不改动其任何源码/配置/插件（硬边界）；
//  - 回环呈现：把 /api 与 WebSocket 升级请求的 Origin/Referer 改写为回环权威，
//    使 DSH 的浏览器信任围栏（api-request-trust）将其视为本机流量，
//    特权方法面（settings/agentPreset/credentials/host.*）因此完整可用；
//    该语义与官方生态插件 authorizeApiAsLoopback 一致，但执行位置在我们的
//    反代进程，令牌等访问控制也因此全部留在反代层，不进入 DSH；
//  - 可选令牌门卫：配置 lanToken 后，所有请求须携带 ?token= 或 Cookie
//    （首次用 ?token= 自动种 HttpOnly Cookie），常数时间比较；
//  - DSH 浏览器会话桥：新版 DSH（0.1.2+）对根 URL 强制浏览器会话认证——
//    无签名 cookie 的请求一律 401（"dsh web authentication required"）。
//    relay 在持有 DSH 启动令牌（dshToken，来自 dsh web 打印的 ?token=）时，
//    自动向回环 DSH 换取签名会话 cookie（dsh-auth-*），并注入到每一个转发
//    请求（HTTP + WebSocket 升级），使局域网客户端无需感知 DSH 认证即可访问；
//    令牌轮换（实例重启）后经 setDshToken() 热更新，无需重建 relay。
//  - 轮转与日志由守卫统一管理。

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 校验请求是否携带有效令牌（URL ?token= 或 Cookie）。 */
function hasValidToken(req, token) {
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      return safeEqual(decodeURIComponent(m[1]), token);
    } catch {
      return false;
    }
  }
  return false;
}

/** 令牌门卫（HTTP 响应路径）：通过返回 true；否则已直接应答（401 或 302 种 Cookie）。 */
function tokenGate(req, res, token) {
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      if (safeEqual(decodeURIComponent(m[1]), token)) return true;
    } catch {}
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) {
    // 首次凭 URL 令牌进入：种 HttpOnly Cookie 后跳到干净路径
    res.writeHead(302, {
      Location: url.pathname,
      'Set-Cookie': 'dsh_lan_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax',
    });
    res.end();
    return false;
  }
  res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要访问令牌：在 URL 后附加 ?token=<lanToken>（只需一次，之后凭 Cookie 访问）');
  return false;
}

// 非回环 HTTP 源上 crypto.randomUUID 不存在（secure-context-only），
// 而 DSH 客户端用它生成每个 RPC 的 id —— 缺失即所有请求抛错、WS 就绪握手失败。
// 反代在 HTML 注入此 polyfill，使局域网源的客户端获得等价能力。
const POLYFILL_SCRIPT = `<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += (i === 4 || i === 6 || i === 8 || i === 12 ? '-' : '') + ('0' + b[i].toString(16)).slice(-2);
    return h;
  };
}
</script>`;

/**
 * 用 DSH 启动令牌向回环 DSH 换取浏览器会话 cookie（dsh-auth-*）。
 * DSH 的令牌交换协议：GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-<hash>=<v1...>。
 * @returns Promise<string> 完整的 "name=value" cookie 对；失败返回 null（由调用方降级/重试）。
 */
function bootstrapDshCookie(targetHost, targetPort, dshToken) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      resolve(cookie);
    };
    const req = http.get(
      {
        hostname: targetHost,
        port: targetPort,
        path: '/?token=' + encodeURIComponent(dshToken),
        headers: { host: targetHost + ':' + targetPort },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
          const pair = String(raw[0]).split(';')[0]; // 取第一个 Set-Cookie 的 name=value
          if (pair && /^dsh-auth-/.test(pair)) finish(pair);
          else finish(pair || null); // 无 dsh-auth 前缀也回传，让上游自行判定
        } else {
          finish(null);
        }
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    req.on('error', () => finish(null));
  });
}

/** 提取传入 Cookie 头中给定名字的值（不做通用 Cookie 解析，只按分号切段）。 */
function cookieByName(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return null;
}

/**
 * 创建局域网反向代理。
 * @param {string} targetHost 回环目标主机（127.0.0.1）
 * @param {number} targetPort 回环目标端口（DSH Web 端口）
 * @param {object} opts
 *   - token: 局域网访问令牌（lanToken；空 = 不设门卫）
 *   - dshToken: DSH 启动令牌（新版 DSH 浏览器会话认证）；缺省时旧版 DSH（无认证）照常转发
 *   - logger: 可选日志器
 * @returns http.Server（附加 setDshToken 方法用于热更新令牌）
 */
function createRelay(targetHost, targetPort, opts) {
  const o = opts || {};
  const token = o.token || '';
  const logger = o.logger || null;
  const log = (lv, msg) => { if (logger && logger[lv]) { try { logger[lv]('[relay] ' + msg); } catch {} } };
  const authority = targetHost + ':' + targetPort;

  let dshToken = o.dshToken || '';
  let dshCookie = null; // "name=value"（dsh-auth-*）
  let bootstrapping = null; // 进行中的换取 Promise（防并发重复换取）
  const relayId = o.id || '';
  const events = o.events || null;
  const emit = (type, data) => { try { if (events && events.append) events.append(type, Object.assign({ id: relayId }, data || {})); } catch {} };
  // 注入状态（可诊断层，docs/token-management.md §可观测）：tokenSet=有令牌、cookieReady=已换到 dsh-auth cookie、
  // lastOkAt/lastError/lastErrorAt——经 server.status() 暴露，LAN 面板据此显示「远程就绪/正在注入/令牌缺失」。
  const state = { tokenSet: !!o.dshToken, cookieReady: false, lastAttemptAt: null, lastOkAt: null, lastError: null, lastErrorAt: null };
  const recordOk = (c, via) => {
    state.lastAttemptAt = Date.now();
    if (c) { state.cookieReady = true; state.lastOkAt = Date.now(); state.lastError = null; }
    else { state.cookieReady = false; if (!state.lastError) state.lastError = '令牌换取 cookie 未返回（DSH 无认证/未就绪/令牌过期）'; state.lastErrorAt = Date.now(); }
  };
  const recordFail = (why) => {
    state.lastAttemptAt = Date.now();
    state.cookieReady = false;
    if (!state.lastError || state.lastErrorAt === null || Date.now() - state.lastErrorAt > 30000) {
      state.lastError = why;
      state.lastErrorAt = Date.now();
    }
    emit('lan_cookie_failed', { error: why });
  };
  const recordReady = (c, via) => {
    recordOk(c, via);
    if (c) { emit('lan_cookie_exchanged', { via: via || 'refresh' }); log('info', 'DSH 浏览器会话 cookie 已换取' + (via ? '(' + via + ')' : '') + ' (' + c.split('=')[0] + ')'); }
    else log('warn', 'DSH 令牌换取 cookie 失败（可能是旧版无认证或令牌过期）');
  };

  /** 令牌变化时重置并重新换取 cookie。 */
  function refreshDshSession(newToken) {
    dshToken = newToken || '';
    state.tokenSet = !!dshToken;
    dshCookie = null;
    state.cookieReady = false;
    bootstrapping = null;
    if (dshToken) {
      bootstrapDshCookie(targetHost, targetPort, dshToken).then((c) => {
        if (c) dshCookie = c;
        recordReady(c, 'refresh');
      }).catch((e) => { recordFail('令牌换取异常: ' + (e && e.message)); });
    }
  }

  /** 确保已持有 DSH cookie；未持有且配置了 dshToken 时尝试换取（懒加载，幂等）。 */
  function ensureDshCookie() {
    if (dshCookie) return Promise.resolve(dshCookie);
    if (!dshToken) return Promise.resolve(null);
    if (!bootstrapping) {
      bootstrapping = bootstrapDshCookie(targetHost, targetPort, dshToken).then((c) => {
        dshCookie = c;
        bootstrapping = null;
        recordReady(c, 'lazy');
        return c;
      }).catch((e) => { bootstrapping = null; recordFail('令牌换取异常: ' + (e && e.message)); return null; });
    }
    return bootstrapping;
  }


  /** 流式转发 + 断线保持（2026-09 修复：远程浏览器断开不应导致 DSH 取消 agent）。
   *  浏览器(res)断开时：不 destroy 上游(ur)——改为继续读丢弃，保持 DSH 侧连接存活：
   *  DSH 前端认为客户端仍在接收 → agent 不被取消；agent 完成后消息存 DSH 会话，
   *  浏览器重连拉历史即可见完整结果。HOLD_MS 上限后清理（防无限挂起）。
   *  注意：WebSocket/SSE 流无法续接，此机制保护的是「agent 后台跑完、结果落会话」场景。 */
  function pipeWithHold(ur, res, clientReqPath) {
    // 长连绝对稳定：浏览器断开后保持上游连接直到 DSH 响应自然结束（ur end/error），
    // 不做定时清理——无法靠超时值判断连接是否还有效，只有自然结束才可信（2026-09 用户定稿）。
    let clientGone = false;
    ur.on('data', (c) => {
      if (clientGone) return; // 浏览器已断：丢弃数据但保持读取（DSH 连接不阻塞、不被判死）
      if (!res.write(c)) ur.pause();
    });
    res.on('drain', () => ur.resume());
    ur.on('end', () => {
      if (clientGone) log('info', 'relay: 上游响应自然结束（agent 完成，消息已落 DSH 会话）' + (clientReqPath ? ' ' + clientReqPath : ''));
      try { if (!clientGone) res.end(); } catch {}
    });
    ur.on('error', () => {
      try { if (!clientGone) res.end(); } catch {}
      try { ur.destroy(); } catch {}
    });
    res.on('close', () => {
      if (ur.readableEnded || ur.destroyed) return; // 正常结束后的 close
      // 浏览器中途断开：进入保持模式——继续读上游丢弃，等 DSH 自然结束（不取消 agent、不清理）
      clientGone = true;
      log('warn', 'relay: 客户端连接断开，保持上游连接直到响应结束（agent 不受影响）' + (clientReqPath ? ' ' + clientReqPath : ''));
    });
  }

  /** 合并转发 Cookie：保留客户端携带的 cookie，注入 DSH 会话 cookie。 */
  async function mergedCookieHeaders(reqHeaders) {
    let cookie = reqHeaders.cookie || '';
    const dshC = await ensureDshCookie();
    if (dshC) {
      const name = dshC.split('=')[0];
      // 客户端若已带同名 DSH cookie（如先前经 relay 种下的）则优先保留（值相同，避免重复段）
      if (cookieByName(cookie, name) === null) {
        cookie = cookie ? cookie + '; ' + dshC : dshC;
      }
    }
    return cookie;
  }

  const server = http.createServer((req, res) => {
    if (!tokenGate(req, res, token)) return;
    mergedCookieHeaders(req.headers).then((cookie) => {
      const headers = { ...req.headers };
      if (cookie) headers.cookie = cookie;
      else delete headers.cookie;
      headers.host = authority;
      // 强制上游不压缩：HTML 注入 polyfill 需要明文 body；否则 gzip 流被字符串替换破坏，
      // 浏览器收到损坏 body 报 ERR_CONTENT_DECODING_FAILED 页面空白
      headers['accept-encoding'] = 'identity';
      // 回环呈现：围栏要求 Origin 与 Host 权威一致
      if (headers.origin !== undefined) headers.origin = 'http://' + authority;
      if (headers.referer !== undefined) headers.referer = 'http://' + authority + '/';
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers },
        (ur) => {
          // 会话自愈：上游 401/403 且我们正注入 DSH cookie → 清 cookie，下次请求以 dshToken 重新换取
          // （cookie 过期后 LAN 访问曾一直 401 直到实例重启轮换令牌）
          if ((ur.statusCode === 401 || ur.statusCode === 403) && dshCookie) {
            dshCookie = null;
            state.cookieReady = false;
            state.lastError = '上游 ' + ur.statusCode + '：cookie 已清，下次请求用令牌重换';
            state.lastErrorAt = Date.now();
            log('warn', '上游 ' + ur.statusCode + '，清 DSH cookie 下次请求重换');
            emit('lan_cookie_invalidated', { status: ur.statusCode });
          }
          const h = { ...ur.headers };
          const isHtml = String(h['content-type'] || '').includes('text/html');
          if (isHtml) {
            // HTML 文档禁缓存：局域网设备永远拿到最新前端，避免陈旧壳加载失败态
            h['cache-control'] = 'no-store';
            // 防御：若上游仍带压缩头（异常路径），移除以免浏览器按 gzip 解码明文注入后的 body
            delete h['content-encoding'];
            // 移除长度约束：注入脚本后体积变化，改用分块传输
            delete h['content-length'];
            h['transfer-encoding'] = 'chunked';
          }
          res.writeHead(ur.statusCode || 502, h);
          if (!isHtml) { pipeWithHold(ur, res, req.url); return; }
          // 注入 secure-context polyfill（在 </head> 前执行，先于所有客户端 bundle）
          const chunks = [];
          let done = false;
          ur.on('data', (c) => chunks.push(c));
          ur.on('end', () => {
            if (done) return;
            done = true;
            let body = Buffer.concat(chunks).toString('utf8');
            if (body.includes('</head>')) body = body.replace('</head>', POLYFILL_SCRIPT + '</head>');
            res.end(body);
          });
          ur.on('error', () => {
            if (done) return;
            done = true;
            try { res.end(); } catch {}
          });
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('dsh-supervisor relay: 上游不可达');
      });
      req.pipe(upstream);
    }).catch(() => {
      // 换取 cookie 意外异常：仍按无 cookie 转发（旧版 DSH 可用），绝不吞请求
      const headers = { ...req.headers };
      headers.host = authority;
      headers['accept-encoding'] = 'identity';
      if (headers.origin !== undefined) headers.origin = 'http://' + authority;
      if (headers.referer !== undefined) headers.referer = 'http://' + authority + '/';
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers },
        (ur) => {
          const h = { ...ur.headers };
          const isHtml = String(h['content-type'] || '').includes('text/html');
          if (isHtml) {
            h['cache-control'] = 'no-store';
            delete h['content-length'];
            h['transfer-encoding'] = 'chunked';
          }
          res.writeHead(ur.statusCode || 502, h);
          if (!isHtml) { pipeWithHold(ur, res, req.url); return; }
          const chunks = [];
          let done = false;
          ur.on('data', (c) => chunks.push(c));
          ur.on('end', () => {
            if (done) return;
            done = true;
            let body = Buffer.concat(chunks).toString('utf8');
            if (body.includes('</head>')) body = body.replace('</head>', POLYFILL_SCRIPT + '</head>');
            res.end(body);
          });
          ur.on('error', () => { if (done) return; done = true; try { res.end(); } catch {} });
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-supervisor relay: 上游不可达');
      });
      req.pipe(upstream);
    });
  });

  // WebSocket / 任意 Upgrade：重建原始请求头（含回环呈现 + DSH cookie）后建立双向 TCP 隧道
  server.on('upgrade', (req, socket, head) => {
    // 升级握手无法做 302 种 Cookie：凭 ?token= 或既有 Cookie 放行，否则原始 401
    if (!hasValidToken(req, token)) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {}
      try { socket.destroy(); } catch {}
      return;
    }
    ensureDshCookie().then((dshC) => {
      let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      let cookie = req.headers.cookie || '';
      if (dshC) {
        const name = dshC.split('=')[0];
        if (cookieByName(cookie, name) === null) cookie = cookie ? cookie + '; ' + dshC : dshC;
      }
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host') continue;
        if (k === 'origin') { raw += 'origin: http://' + authority + '\r\n'; continue; }
        if (k === 'cookie') continue; // 已合并到 cookie 变量统一输出
        raw += k + ': ' + v + '\r\n';
      }
      if (cookie) raw += 'cookie: ' + cookie + '\r\n';
      raw += 'host: ' + authority + '\r\n\r\n';

      const upstream = net.connect(targetPort, targetHost, () => {
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      const kill = () => {
        try { socket.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
      };
      upstream.on('error', kill);
      socket.on('error', kill);
    }).catch(() => {
      // 换取失败仍按无 DSH cookie 转发（旧版 DSH 场景）
      let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      let fcookie = req.headers.cookie || '';
      if (dshCookie) {
        const name = dshCookie.split('=')[0];
        if (cookieByName(fcookie, name) === null) fcookie = fcookie ? fcookie + '; ' + dshCookie : dshCookie;
      }
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host') continue;
        if (k === 'origin') { raw += 'origin: http://' + authority + '\r\n'; continue; }
        if (k === 'cookie') continue;
        raw += k + ': ' + v + '\r\n';
      }
      if (fcookie) raw += 'cookie: ' + fcookie + '\r\n';
      raw += 'host: ' + authority + '\r\n\r\n';
      const upstream = net.connect(targetPort, targetHost, () => {
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      const kill = () => {
        try { socket.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
      };
      upstream.on('error', kill);
      socket.on('error', kill);
    });
  });

  // 初始 dshToken：配置即换取（尽早拿到 cookie，避免首个请求等待）
  if (dshToken) refreshDshSession(dshToken);

  /** 热更新 DSH 启动令牌（实例重启后令牌轮换）。 */
  server.setDshToken = (t) => { refreshDshSession(t); return server; };

  /** 注入状态快照（远程就绪诊断；不含任何令牌/cookie 明文）。 */
  server.status = () => ({ ...state });

  return server;
}

module.exports = { createRelay };