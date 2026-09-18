'use strict';

// 
// ctl dispatcher —— daemon 的 127.0.0.1 回环控制通道（通用基础设施，L0 平台事实）。
//
// ## 为什么在 platform/ 而不是某个域
//   本模块是**通用**的：内容只有 HTTP 协议、白名单闸、序列化与超时参数，
//   不含任何域知识（没有 router/lan/relay 字样，也没有任何具体方法名）。
//   它此前寄居 `domains/router/ctl.js`，却被 router 与 lan **两个 daemon 共用**，
//   于是 relay/daemon 必须反向 require router 域 -> 凭空造出一条跨域边（DS-2 违规，
//   步骤4 实证）。通用基础设施放 L0，两个域各自**向下**消费，跨域边随之归零。
//
// ## 谁在用（均为 daemon 侧进程入口，各自注入本域白名单）
//   - src/domains/router/daemon.js —— ROUTER_CTL_METHODS
//   - src/domains/relay/daemon.js  —— LAN_CTL_METHODS
//
// ## 不变量（安全面，禁止削弱）
//   1. **白名单必填且 fail-closed**：未注入 allowMethods 直接抛错，绝不回退到
//      "放行全部"或"借用别的域的白名单"——白名单属**域知识**，不该藏在通用层里。
//      旧实现（缺省回退 router 表）会让漏传的调用方拿 router 的表去守 lan 的实例，
//      本实现语义**更严**（直接拒绝启动），不是削弱。
//   2. 内部方法（`_` 前缀）永不可达：唯一入口是 `isMethodAllowed` 的
//      `includes` 闸，而各域白名单按约定只收录公开方法。
//   3. 仅绑定 127.0.0.1（由调用方 listen 决定），与守卫 API 同级信任。
//
// 调用方摘要（一句话即可用）：
//   const { createCtlServer } = require('../../platform/ctl/server');
//   const ctl = createCtlServer({ target: svc, allowMethods: MY_METHODS, logger, events });
//   ctl.listen(port, '127.0.0.1');
// 

const http = require('node:http');

/** 白名单闸的唯一判据（导出以便单测**直接**断言"未登记/内部方法不可达"这一安全属性，
 *  无需起真实 HTTP server 也能锁住 PG-5）。 */
const isMethodAllowed = (allowMethods, method) =>
  Array.isArray(allowMethods) && typeof method === 'string' && allowMethods.includes(method);

/**
 * 创建 ctl HTTP server。
 * @param {object} o
 *   - target:       被控制的实例（RouterService / LanManager ...）。方法经 `target[method]` 调用。
 *   - allowMethods: **必填**域白名单（数组）。缺省/非法直接抛错（fail-closed）。
 *   - logger:       可选，{debug,warn,error}
 *   - events:       可选；存在且 `eventsTail` **在白名单内**时，暴露内置
 *                   eventsTail(afterSeq)（守卫 EventHub 增量拉事件，不依赖 target 实例方法）。
 * @returns {http.Server}
 */
function createCtlServer({ target, allowMethods, logger, events } = {}) {
  // 重点 fail-closed：白名单是安全面的根，缺了就拒绝启动，而不是给个"宽容缺省"。
  if (!Array.isArray(allowMethods) || allowMethods.length === 0) {
    throw new Error('createCtlServer: allowMethods（域方法白名单）必填且不能为空——白名单不可缺省（安全面 PG-5）');
  }
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      let body;
      try { body = JSON.stringify(obj); } catch { body = JSON.stringify({ ok: false, error: 'response not serializable' }); }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/ctl') {
      return send(404, { ok: false, error: 'not found' });
    }

    let body = '';
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      body += c;
      if (body.length > 1 << 20) { // 1MB 上限
        settled = true;
        send(413, { ok: false, error: 'payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      let m = null;
      try { m = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      const method = m && typeof m.method === 'string' ? m.method : null;
      const args = Array.isArray(m && m.args) ? m.args : [];
      // 系统日志框架（P1b）：内置 eventsTail(afterSeq) 供守卫 EventHub 增量拉取事件。
      // 注意 内置特例**不等于**无条件放行：它同样要过白名单（调用方白名单里写了才可达）。
      if (method === 'eventsTail' && isMethodAllowed(allowMethods, method)
          && events && typeof events.tailSince === 'function') {
        const afterSeq = Number(args[0]) || 0;
        let list = [];
        try { list = events.tailSince(afterSeq); } catch (e2) { return send(200, { ok: false, error: (e2 && e2.message) || String(e2) }); }
        return send(200, { ok: true, value: { seq: events.seq, events: list } });
      }
      // 重点 白名单闸（PG-5）：未登记的方法一律拒绝——不对调用方透露"存在与否"。
      //   内部方法（_ 前缀）不在各域表内，故永不可达。
      if (!isMethodAllowed(allowMethods, method) || !target || typeof target[method] !== 'function') {
        if (logger && logger.warn && method) logger.warn('[ctl] 拒绝未登记方法: ' + method);
        return send(404, { ok: false, error: 'method not allowed: ' + method });
      }
      const started = Date.now();
      Promise.resolve()
        .then(() => target[method].apply(target, args))
        .then((value) => {
          if (logger && logger.debug) logger.debug('[ctl] ' + method + ' ok in ' + (Date.now() - started) + 'ms');
          send(200, { ok: true, value });
        })
        .catch((e) => {
          if (logger && logger.warn) logger.warn('[ctl] ' + method + ' error: ' + ((e && e.message) || e));
          send(200, { ok: false, error: (e && e.message) || String(e) });
        });
    });
    req.on('error', () => { try { res.end(); } catch {} });
  });
  server.on('error', (e) => { if (logger) logger.error('[ctl] server error: ' + e.message); });
  // 2026-09 复检根治：守卫(Node≥19 globalAgent keepAlive=true 连接池化)复用长连调用 ctl；
  // Node http server 默认 keepAliveTimeout=5s 会回收空闲池化连接 -> 守卫下次复用已关 socket ->
  // 间歇 'socket hang up' -> routerProviders 回退守卫陈旧本地视图 -> 前端账号状态与 daemon 分裂闪烁
  //（实测 3100 /router/providers 在 daemon 真值 与 陈旧副本 间交替，Kbobt7/MxULq9 旧态复现）。
  // 与 router 供应商端点对齐（index.js server.keepAliveTimeout=65000），长连不因空闲被服务端回收。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
  return server;
}

module.exports = { createCtlServer, isMethodAllowed };
