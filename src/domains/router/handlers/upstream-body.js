'use strict';

// 上游响应体读取/透传（#2）：forwardOnce 在 req.on('response') 时即 settle 并清掉
// connectGuard(15s)/responseGuard(180s)；此后响应体读取原本不受任何时限约束 ——
// 上游发完响应头后挂起即永久悬挂（客户端连接与在途计数一起泄漏）。
//
// 本模块集中承接上游体 -> 客户端的透传与有界读取（无 IO require，依赖经参数注入；
// 结束语义由调用方回调决定，本文件不感知 inflight/用量/熔断）。

/** 非流式上游响应体总时长上限（ms）：收到响应头后的体读取原本无任何时限，上游挂起即永久悬挂。
 *  300s 远大于正常非流式响应时长，仅作「发完头后不再有进展」的兜底，不影响正常大响应。 */
const NONSTREAM_BODY_MAX_MS = 300000;

/** 有界读上游响应体（字节 + 时间上限；超时带部分内容 resolve，不悬挂调用方）。 */
function readUpstreamBody(ur, maxBytes, timeoutMs) {
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve(text); };
    const timer = setTimeout(() => { try { ur.destroy(); } catch {} finish(); }, timeoutMs || 15000);
    if (timer.unref) timer.unref();
    ur.on('data', (c) => { if (text.length < (maxBytes || 65536)) text += c; });
    ur.on('end', finish);
    ur.on('error', finish);
    ur.on('close', finish);
  });
}

/** 上游体 -> 客户端透传（含背压）。opts={ res, streamRequested, onData, onEnd, onAbort, timeoutMs }：
 *   · onData(chunk) 返回 false 即暂停上游，客户端 'drain' 时恢复；
 *   · 非流式（streamRequested 非真）设总时长上限，到期 destroy 上游并走 onAbort；
 *   · onEnd/onAbort 各只触发一次（内部 done 闸）。
 *  返回 { cancel }：调用方在其它结束路径（如客户端断开）清除定时器。 */
function trackUpstreamBody(ur, opts) {
  const o = opts || {};
  const res = o.res;
  const onData = o.onData || (() => {});
  let timer = null, done = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const finish = (fn) => { if (done) return; done = true; cancel(); if (fn) fn(); };
  if (!o.streamRequested) {
    timer = setTimeout(() => { try { ur.destroy(); } catch {} finish(o.onAbort); }, o.timeoutMs || NONSTREAM_BODY_MAX_MS);
    if (timer.unref) timer.unref();
  }
  ur.on('data', (c) => { if (onData(c) === false) ur.pause(); });
  if (res && typeof res.on === 'function') res.on('drain', () => ur.resume());
  ur.on('end', () => finish(o.onEnd));
  ur.on('aborted', () => finish(o.onAbort));
  ur.on('error', () => finish(o.onAbort));
  ur.on('close', () => { if (!ur.readableEnded) finish(o.onAbort); });
  return { cancel };
}

module.exports = { readUpstreamBody, trackUpstreamBody };
