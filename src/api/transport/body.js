'use strict';

// api/transport/body —— 有界 body 读取（传输层原语，与安全模型、域分派无关）。

/** 有界 body 读取：超过 maxBytes 时先应答 413 再断开连接，保证任何输入都有终态应答。 */
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
  // onDone 是延迟回调（'end' 事件内同步调用）：其同步抛出会逃出请求处理的异常边界，
  //   升级为进程级 uncaughtException。必须在本层接住并给出终态应答。
  req.on('end', () => {
    if (over) return;
    try { onDone(body); }
    catch (e) {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {}
    }
  });
}

module.exports = { collectBody };
