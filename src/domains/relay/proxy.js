'use strict';

// 局域网反向代理 server 本体：在 0.0.0.0:<wanPort> 监听，把 LAN 流量转发到 127.0.0.1:<dshPort>，
// 做回环呈现 + HTML polyfill 注入 + 断线保持，并暴露 setToken/setDshToken/hasToken/status 热更新面。
// 硬边界：DSH 本体保持只监听 127.0.0.1，不改动其源码/配置/插件；把 Origin/Referer 改写为回环权威，
// 使 DSH 信任围栏视为本机流量，访问控制（令牌/来源闸）留在反代层；session.js 换 dsh-auth-* 注入 HTTP/WS。

const http = require('node:http');
const { isTrustedSource, tokenGateDecision, POLYFILL_SCRIPT } = require('./core');
const { createSession } = require('./session');
const { createTunnelHandler } = require('./tunnel');

/** 流式转发 + 断线保持。
 *
 *  浏览器(res)断开时不 destroy 上游(ur)，改为继续读丢弃，保持 DSH 侧连接存活：DSH 前端认为客户端
 *  仍在接收，agent 不被取消；agent 完成后消息存 DSH 会话，浏览器重连拉历史可见完整结果。
 *  保持模式不设时限，只等上游自然结束。
 */
function pipeWithHold(ur, res, clientReqPath, logger) {
  let clientGone = false;
  const log = (lv, msg) => { if (logger && logger[lv]) { try { logger[lv]('[relay] ' + msg); } catch {} } };
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
    if (ur.readableEnded || ur.destroyed) return;
    // 浏览器中途断开：进入保持模式——继续读上游丢弃，等 DSH 自然结束（不取消 agent、不清理）
    clientGone = true;
    log('warn', 'relay: 客户端连接断开，保持上游连接直到响应结束（agent 不受影响）' + (clientReqPath ? ' ' + clientReqPath : ''));
  });
}

/** 构造转发到 DSH 的请求头：回环呈现 + 强制 identity 编码（HTML 注入需要明文 body）。 */
function buildForwardHeaders(req, authority, cookie) {
  const headers = { ...req.headers };
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers.host = authority;
  // 强制上游不压缩：HTML 注入 polyfill 需要明文 body；否则 gzip 流被字符串替换破坏。
  headers['accept-encoding'] = 'identity';
  // 回环呈现：围栏要求 Origin 与 Host 权威一致。
  if (headers.origin !== undefined) headers.origin = 'http://' + authority;
  if (headers.referer !== undefined) headers.referer = 'http://' + authority + '/';
  return headers;
}

/** 处理上游响应：HTML 注入 polyfill，其余流式转发（含断线保持）。 */
function handleUpstream(ur, res, clientReqPath, onStatus, logger) {
  if (onStatus) onStatus(ur.statusCode);
  const h = { ...ur.headers };
  const isHtml = String(h['content-type'] || '').includes('text/html');
  if (isHtml) {
    // HTML 文档禁缓存：局域网设备永远拿到最新前端，避免陈旧壳加载失败态。
    h['cache-control'] = 'no-store';
    // 防御：若上游仍带压缩头（异常路径），移除以免浏览器按 gzip 解码明文注入后的 body。
    delete h['content-encoding'];
    // 移除长度约束：注入脚本后体积变化，改用分块传输。
    delete h['content-length'];
    h['transfer-encoding'] = 'chunked';
  }
  res.writeHead(ur.statusCode || 502, h);
  if (!isHtml) { pipeWithHold(ur, res, clientReqPath, logger); return; }
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

/**
 * 创建局域网反向代理。
 * @param {string} targetHost 回环目标主机（127.0.0.1）
 * @param {number} targetPort 回环目标端口（DSH Web 端口）
 * @param {object} opts
 *   - token: 局域网访问令牌（remoteToken；空 = 不设门卫）
 *   - dshToken: DSH 启动令牌初值（兼容旧调用方）
 *   - dshTokenOf: 令牌按需读取函数（TK-4）；签名 () => string
 *   - id/logger/events
 * @returns http.Server（附 setToken/hasToken/setDshToken/status）
 */
function createRelay(targetHost, targetPort, opts) {
  const o = opts || {};
  // 必须用 let：门卫令牌需经 setToken 热更新。
  let token = o.token || '';
  const logger = o.logger || null;
  const authority = targetHost + ':' + targetPort;

  const session = createSession({
    targetHost,
    targetPort,
    id: o.id || '',
    logger,
    events: o.events || null,
    dshTokenOf: o.dshTokenOf,
    dshToken: o.dshToken,
  });

  const server = http.createServer((req, res) => {
    // 来源闸：公网来源一律拒绝 —— 与 config.js 声称的「RFC1918 白名单」一致。
    if (!isTrustedSource(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('仅允许局域网（RFC1918）或本机访问');
    }
    const gate = tokenGateDecision(req, token);
    if (!gate.ok) {
      if (gate.redirect !== undefined) {
        // 首次凭 URL 令牌进入：种 HttpOnly Cookie 后跳到干净路径。
        res.writeHead(302, { Location: gate.redirect, 'Set-Cookie': gate.cookie });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('需要访问令牌：在 URL 后附加 ?token=<remoteToken>（只需一次，之后凭 Cookie 访问）');
    }
    session.mergedCookieHeaders(req.headers).then((cookie) => {
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers: buildForwardHeaders(req, authority, cookie) },
        (ur) => handleUpstream(ur, res, req.url, (status) => {
          // 会话自愈：上游 401/403 时清 cookie，下次请求重换。
          if (status === 401 || status === 403) session.invalidate(status);
        }, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-supervisor relay: 上游不可达');
      });
      req.pipe(upstream);
    }).catch(() => {
      // 换取 cookie 意外异常：仍按客户端原 cookie 转发（旧版 DSH 可用），绝不吞请求。
      const upstream = http.request(
        { hostname: targetHost, port: targetPort, path: req.url, method: req.method, headers: buildForwardHeaders(req, authority, req.headers.cookie) },
        (ur) => handleUpstream(ur, res, req.url, null, logger)
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-supervisor relay: 上游不可达');
      });
      req.pipe(upstream);
    });
  });

  server.on('upgrade', createTunnelHandler({
    session,
    authority,
    targetHost,
    targetPort,
    getToken: () => token,
  }));

  // 初始令牌：池中已有即换取（尽早拿到 cookie，避免首个请求等待）。
  if (session.hasToken()) session.refreshDshSession();

  /** 热更新 DSH 启动令牌（实例重启后令牌轮换）。真实值一律由 dshTokenOf() 按需读取。 */
  server.setDshToken = () => { session.refreshDshSession(); return server; };

  /** 热更新**门卫令牌**（remoteToken 变更时由 LanManager.syncProxy 下发）。 */
  server.setToken = (t) => { token = String(t || ''); return server; };

  /** 当前门卫令牌是否已设置（**只回布尔**，绝不回传令牌明文）。 */
  server.hasToken = () => !!token;

  /** 注入状态快照（远程就绪诊断；不含任何令牌/cookie 明文）。 */
  server.status = () => session.status();

  return server;
}

module.exports = { createRelay };
