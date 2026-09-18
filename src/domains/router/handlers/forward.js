'use strict';

const parseModule = require('./parse');
const { readUpstreamBody, trackUpstreamBody } = require('./upstream-body');

// 转发 IO 层（网络）：上游响应读取 + 重试循环 + 流式透传。依赖经 ctor 注入
// （deps={log,logger,readBody,canPersist,parse,usage,inflight,switcher,events,getPricing,agents,maskKey}）；
// 本文件只 require ./parse 与 ./upstream-body（纯）。两条结束路径（writeThrough 成功 / 错误中断）统一走 endInflight() 的 effects。

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const HOP_HEADERS = new Set(['connection','proxy-connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createForwarder(deps) {
  const d = deps || {};
  const parse = d.parse || parseModule;
  const log = d.log || (() => {});
  const logger = d.logger || null;
  const maskKey = d.maskKey || ((k) => k);
  const usage = d.usage;
  const inflight = d.inflight;
  const switcher = d.switcher;
  const events = d.events || null;
  const getPricing = d.getPricing || (() => null);
  const readBody = d.readBody || parse.readBody;
  const agents = d.agents || {};

  /** 唯一在途结束执行器：两条路径共用，**全部** effects 都执行（修复漏补重启）。 */
  function endInflight(acc, prov) {
    const inst = parse.instOf(prov, acc);
    const lifecycle = !!(prov && prov.supports && prov.supports('instanceLifecycle'));
    const out = inflight.end(acc, { prov, inst, lifecycle });
    for (const e of out.effects) {
      try {
        if (e.kind === 'retryPendingStop') prov._retryPendingStop(acc);
        else if (e.kind === 'flushRestartPending') prov.flushRestartPending(e.inst);
      } catch {}
    }
  }
  function recordError() { try { inflight.recordError(); } catch {} usage.recordError(); }

  /** 按指定供应商作用域转发（各自 API 地址与账号池，绝不跨池 failover）。 */
  async function proxyFor(prov, req, res) {
    const started = Date.now();
    if (!prov) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'no provider' })); }
    let acc = null;
    log('REQ method=' + req.method + ' path=' + req.url + ' provider=' + prov.name);
    let body;
    try { body = await readBody(req); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'read body failed' })); }
    const pr = parse.parseRequest(req, prov.apiPort, body);
    const model = pr.model, streamRequested = pr.streamRequested, bodyJson = pr.bodyJson;
    const uPath = pr.pathname, uSearch = pr.search;
    try {
      if (logger && logger.debug) {
        const ua = String(req.headers['user-agent'] || '').slice(0, 80);
        const ah = String(req.headers['authorization'] || '');
        const authShape = ah ? (ah.startsWith('Bearer ') ? 'Bearer:' + ah.length : ah.slice(0, 12)) : '(none)';
        const nMsgs = (bodyJson && Array.isArray(bodyJson.messages)) ? bodyJson.messages.length : '?';
        const hasStreamOpts = !!(bodyJson && bodyJson.stream_options);
        logger.debug('[req] model=' + model + ' stream=' + streamRequested + ' msgs=' + nMsgs + ' streamOpts=' + hasStreamOpts + ' ua=' + ua + ' auth=' + authShape);
      }
    } catch {}
    let clientAborted = false;
    const onClientCloseEarly = () => { clientAborted = true; };
    res.once('close', onClientCloseEarly);
    const attempts = Math.max((prov.accounts || []).length, 1);
    let stripInjectionRetried = false, injectedThisAttempt = false;
    const triedKeys = new Set();
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (clientAborted) break;
      acc = switcher.pickFor(prov, { excludeKeys: triedKeys });
      if (!acc || triedKeys.has(acc.key)) break;
      triedKeys.add(acc.key);
      // 按需激活必须在 resolveTarget 之前（实例未启动 port=null，否则死锁）
      const activeProv = prov;
      const curInst = parse.instOf(activeProv, acc);
      if (activeProv && activeProv.kind === 'proxy' && curInst) {
        activeProv.markUsed(curInst);
        if (!curInst.pid || curInst.status !== 'HOT') {
          const sr = await activeProv.startInstance(curInst).catch((e) => ({ ok: false, error: e && e.message }));
          const ok = sr && sr.ok;
          const budgetMs = activeProv.supports('switchBudget') ? activeProv._switchBudgetMs() : 2000;
          const healthy = ok
            ? await Promise.race([
                activeProv._waitHealthy(curInst).catch(() => false),
                new Promise((r) => setTimeout(() => r(false), budgetMs)),
              ])
            : false;
          if (!healthy) {
            log('INST-START-FAIL key=' + maskKey(acc.key) + ' err=' + ((sr && sr.error) || ('未在 ' + budgetMs + 'ms 内就绪')));
            if (curInst && curInst.pid && activeProv.supports('prewarm')) {
              try { activeProv.prewarmAsync(acc); } catch {}
            } else if (curInst && curInst.pid) {
              try { activeProv.stopInstance(curInst); } catch {}
            }
            continue;
          }
        }
      }
      const rt = parse.resolveTarget(acc, prov);
      if (!rt) continue;
      const attemptTarget = parse.joinUpstream(rt.targetBase, uPath, uSearch);
      log('TRY attempt=' + (attempt + 1) + '/' + attempts + ' key=' + maskKey(acc.key));
      let sendBody = body;
      if (streamRequested && !stripInjectionRetried && bodyJson && !bodyJson.stream_options) {
        try { bodyJson.stream_options = { include_usage: true }; sendBody = Buffer.from(JSON.stringify(bodyJson), 'utf8'); injectedThisAttempt = true; } catch {}
      }
      inflight.begin(acc);
      const out = await forwardOnce(attemptTarget, req.method, req.headers, sendBody, acc.key, res);
      if (clientAborted) { endInflight(acc, activeProv); try { if (out.res) out.res.destroy(); if (out.upstreamReq) out.upstreamReq.destroy(); } catch {} return; }
      if (out.phase === 'net-error') {
        endInflight(acc, activeProv);
        const inst = parse.instOf(rt.prov, acc);
        const isTimeout = typeof out.error === 'string' && /timeout/i.test(out.error);
        // 失败归属在下方按 activeProv + inst 收口。此处原有一处 rt.prov.markInstanceNetFail(acc)：
        // proxy 实现要求实参带 pid（acc 无 pid -> 无操作），base 实现直接抛错 —— 冗余死调用，删除。
        log('ERR net fail key=' + maskKey(acc.key) + ' err=' + out.error);
        if (activeProv && activeProv.kind === 'proxy' && inst) {
          if (isTimeout && activeProv.supports && activeProv.supports('instanceLifecycle')) {
            try { activeProv.restartInstance(inst, 'upstream-timeout'); } catch {}
          } else if (activeProv.supports && activeProv.supports('instanceLifecycle')) {
            try { activeProv.markInstanceNetFail(inst); } catch {}
          }
        }
        if (!isTimeout) {
          try { if (inst && inst.pid) { inst.pid = null; inst.healthy = false; } } catch {}
        }
        if (attempt >= attempts - 1) { recordError(); res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'upstream failed', detail: out.error })); }
        continue;
      }
      if (out.phase === 'client-abort') { endInflight(acc, activeProv); return; }
      const ur = out.res;
      const status = ur.statusCode;
      if (status === 400 && injectedThisAttempt && !stripInjectionRetried) {
        endInflight(acc, activeProv);
        stripInjectionRetried = true; ur.resume(); log('RETRY-SANS stream_options key=' + maskKey(acc.key));
        triedKeys.delete(acc.key);
        attempt -= 1; continue;
      }
      if (status >= 400) {
        endInflight(acc, activeProv);
        const text = await readUpstreamBody(ur, 262144);
        const act = switcher.reactToFailure(rt.prov, acc, {
          status, headers: ur.headers, body: text, attempt, attempts,
          method: req.method, path: uPath,
          error: status === 401 ? "401 认证失败" : null,
        });
        if (act.action === "retry") {
          if (act.log) log(act.log + " key=" + maskKey(acc.key));
          if (attempt >= attempts - 1) {
            if (act.transient) { res.writeHead(status, ur.headers); return res.end(text); }
            continue;
          }
          await sleep((act.transient ? 150 : 200) + crypto.randomInt(act.transient ? 300 : 600));
          continue;
        }
        if (act.log) log(act.log);
        res.writeHead(act.status || status, act.headers || ur.headers);
        return res.end(act.body !== undefined ? act.body : text);
      }
      // 2xx 才清零失败计数（请求级熔断）
      const okInst = parse.instOf(activeProv, acc);
      if (activeProv && activeProv.kind === 'proxy' && okInst
          && activeProv.supports && activeProv.supports('instanceLifecycle')) {
        try { activeProv.markRequestOk(okInst); } catch {}
      }
      return writeThrough(req, res, out, acc, rt.prov, { started, model, streamRequested, status });
    }
    recordError();
    log('EXHAUSTED all accounts');
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'all accounts exhausted' }));
  }

  /** 上游->客户端透传：头复制 + 流式转发 + 用量统计（按账号 byKey/byModel）。 */
  function writeThrough(req, res, out, acc, prov, meta) {
    const ur = out.res;
    const status = meta.status;
    const h = { ...ur.headers };
    delete h['transfer-encoding'];
    res.writeHead(status, h);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    let completed = false, bytes = 0, tailText = '';
    const destroyUpstream = () => { try { if (out.upstreamReq) out.upstreamReq.destroy(); } catch {} try { ur.destroy(); } catch {} };
    const finishOK = () => {
      if (completed) return;
      completed = true;
      endInflight(acc, prov);
      if (meta.streamRequested) {
        try {
          const t = tailText || '';
          const noDone = t.indexOf('[DONE]') < 0;
          const tail = t.slice(-180).replace(/\s+/g, ' ');
          if (noDone && logger && logger.warn) logger.warn('[stream] END-NO-DONE key=' + maskKey(acc.key) + ' bytes=' + bytes + ' tail=...' + tail);
        } catch {}
      }
      const usageRec = parse.extractUsage(tailText);
      try {
        const comp = usageRec ? usageRec.completionTokens : null;
        const reasoningOnly = comp !== null && comp < 100;
        if (meta.streamRequested && reasoningOnly && logger && logger.warn) {
          const t = (tailText || '').replace(/\s+/g, ' ').slice(-300);
          logger.warn('[stream] SHORT-OUTPUT key=' + maskKey(acc.key) + ' completionTokens=' + comp + ' bytes=' + bytes + ' tail=...' + t);
        }
      } catch {}
      usage.recordUsage({ ts: new Date().toISOString(), model: meta.model, key: acc.key, promptTokens: usageRec ? usageRec.promptTokens : 0, completionTokens: usageRec ? usageRec.completionTokens : 0, totalTokens: usageRec ? usageRec.totalTokens : 0, cacheMiss: usageRec ? usageRec.cacheMiss : 0, cacheHit: usageRec ? usageRec.cacheHit : 0, durationMs: Date.now() - meta.started, status, streamed: meta.streamRequested, usageMissing: !usageRec, pricing: (prov && prov.kind === 'direct') ? ((prov.officialPricing || null)) : getPricing() });
    };
    const finishAborted = () => {
      if (completed) return;
      completed = true;
      endInflight(acc, prov);
      log('STREAM_ABORTED key=' + maskKey(acc.key) + ' bytes=' + bytes);
      // 归属必须是**实例**而非账号对象：proxy.markInstanceNetFail 只在实参带 pid 时计数，
      // 传 acc 等于不计数 —— 流式中断因此从不进入熔断（P3-F #5）。与 net-error 分支同一解析取实例。
      if (prov && prov.supports && prov.supports('instanceLifecycle')) {
        const inst = parse.instOf(prov, acc);
        if (inst) { try { prov.markInstanceNetFail(inst); } catch {} }
      }
      if (events) events.append('router_stream_aborted', { key: maskKey(acc.key), model: meta.model, bytes });
      try { res.destroy(); } catch {}
    };
    // #2：上游体透传统一走 handlers/upstream-body.js；非流式带总时长上限（流式长流不限）。
    const body = trackUpstreamBody(ur, {
      res, streamRequested: meta.streamRequested,
      onData: (c) => { bytes += c.length; tailText += c.toString('utf8'); if (tailText.length > 131072) tailText = tailText.slice(-65536); return res.write(c); },
      onEnd: () => { finishOK(); res.end(); },
      onAbort: () => finishAborted(),
    });
    res.on('close', () => {
      if (completed) return;
      if (ur.readableEnded) return;
      completed = true;
      body.cancel(); // #2：其它结束路径须清掉非流式体守卫的定时器
      endInflight(acc, prov);
      if (logger && logger.warn) logger.warn('[stream] CLIENT-ABORT key=' + maskKey(acc.key) + ' bytesSent=' + bytes + ' upstreamReadableEnded=' + !!ur.readableEnded + ' content=' + JSON.stringify((tailText || '').slice(0, 400)));
      destroyUpstream();
    });
    return undefined;
  }

  /** 单次上游请求（connectGuard 15s / responseGuard 180s；长流不限）。 */
  function forwardOnce(target, method, srcHeaders, bodyBuf, key, clientRes) {
    return new Promise((resolve) => {
      const startedAtRef = Date.now();
      let settled = false;
      let connectGuard = null;
      let responseGuard = null;
      const settle = (v) => {
        if (settled) return;
        settled = true;
        if (connectGuard) clearTimeout(connectGuard);
        if (responseGuard) clearTimeout(responseGuard);
        resolve(v);
      };
      const headers = {};
      for (const [k, v] of Object.entries(srcHeaders)) {
        const lk = k.toLowerCase();
        if (HOP_HEADERS.has(lk) || lk === 'host' || lk === 'authorization' || lk === 'content-length') continue;
        headers[lk] = v;
      }
      headers.authorization = 'Bearer ' + key;
      const tu = new URL(target);
      headers.host = tu.host;
      if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(bodyBuf.length);
      const agent = tu.protocol === 'https:' ? agents.https : agents.http;
      const mod = tu.protocol === 'https:' ? https : http;
      if (logger && logger.debug) logger.debug('[fw] send ' + maskKey(key) + ' -> ' + String(target).slice(0, 60));
      const req = mod.request(target, { method, headers, agent }, (ur) => { if (logger && logger.debug) logger.debug('[fw] hdrs ' + maskKey(key) + ' status=' + ur.statusCode + ' after ' + (Date.now() - startedAtRef) + 'ms'); settle({ phase: 'ok', res: ur, upstreamReq: req }); });
      req.setTimeout(0);
      connectGuard = setTimeout(() => { const err = new Error('connect timeout after 15s'); req.destroy(err); settle({ phase: 'net-error', error: err.message }); }, 15000);
      responseGuard = setTimeout(() => { const err = new Error('response timeout after 180s'); req.destroy(err); settle({ phase: 'net-error', error: err.message }); }, 180000);
      req.on('socket', (s) => { s.setNoDelay(true); s.setKeepAlive(true, 15000); });
      req.on('error', (e) => settle({ phase: 'net-error', error: e.message }));
      const onClientClose = () => { try { req.destroy(); } catch {} settle({ phase: 'client-abort' }); };
      if (clientRes && typeof clientRes.once === 'function') clientRes.once('close', onClientClose);
      req.on('response', () => clientRes.removeListener('close', onClientClose));
      req.end(bodyBuf);
    });
  }

  return { proxyFor, writeThrough, forwardOnce, endInflight, recordError };
}

module.exports = { createForwarder, readUpstreamBody };
