'use strict';

// api/transport/body —— 有界 body 读取（步骤 9：从 index.js 拆出的传输层原语）。
//
// 为什么单列 transport/：
//   这是**传输协议**关注点（读取/限长/超限应答），与安全模型、域分派无关；
//   归入 transport/ 便于后续把 WS 升级等其它传输原语也收拢到同一处。

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

module.exports = { collectBody };
