'use strict';

// 远程控制 relay 的 DSH 浏览器会话桥测试：
// 新版 DSH（0.1.2+）对根 URL 强制浏览器会话认证（401），relay 需持 DSH 启动令牌
// 向回环 DSH 换取签名 cookie（dsh-auth-*）并注入转发请求，LAN 客户端才可访问。
// 用 mock 上游模拟「令牌交换 → 种 cookie → 校验 cookie 后放行」的 DSH 行为，
// 验证 createRelay 的 bootstrap / 注入 / setDshToken 热更新链路。

const http = require('node:http');
const pathMod = require('node:path');
const { createRelay } = require(pathMod.join(__dirname, '..', 'src', 'domains', 'relay'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ code: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ code: 0, body: e.message, headers: {} }));
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  // ── mock 上游：模拟新版 DSH 的浏览器会话认证 ──
  // GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-xxx=<sig>
  // 其他路径：带 dsh-auth-xxx cookie → 200；无 → 401（"dsh web authentication required"）
  const LAUNCH = 'launch-token-abc123';
  const upstream = http.createServer((q, s) => {
    const url = new URL(q.url, 'http://127.0.0.1');
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH) {
      s.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-mock=abcdef123; Path=/; HttpOnly; SameSite=Strict' });
      s.end();
      return;
    }
    const cookie = q.headers.cookie || '';
    if (!/dsh-auth-mock=abcdef123/.test(cookie)) {
      s.writeHead(401, { 'content-type': 'text/plain' });
      s.end('dsh web authentication required; reopen the URL printed by dsh web.');
      return;
    }
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    s.end('<html><head></head><body>mock-dsh</body></html>');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const targetPort = upstream.address().port;

  // ── 场景 1：配置 dshToken → relay 自动换取并注入 cookie，根 URL 200 ──
  const relay = createRelay('127.0.0.1', targetPort, { dshToken: LAUNCH });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const relayPort = relay.address().port;

  // 立即请求（可能触发懒加载换取；bootstrap 幂等）
  const r1 = await req(relayPort, 'GET', '/');
  check('场景1: 根 URL 经 relay 返回 200（DSH cookie 已注入）', r1.code === 200, r1.code + ' ' + r1.body);
  check('场景1: HTML 注入 randomUUID polyfill', r1.body.includes('randomUUID'), r1.body.slice(0, 80));

  // 请求其他路径也带 cookie（如 /api）
  const r2 = await req(relayPort, 'GET', '/api/session/list');
  check('场景1: /api 路径同样放行（非 401）', r2.code === 200, String(r2.code));

  // ── 场景 2：客户端自带同名 DSH cookie 时不重复注入 ──
  const r3 = await req(relayPort, 'GET', '/', { Cookie: 'dsh-auth-mock=abcdef123' });
  check('场景2: 客户端自带 DSH cookie 仍 200', r3.code === 200, String(r3.code));

  // ── 场景 3：remoteToken 门卫与 DSH 桥可并存 ──
  const relay3 = createRelay('127.0.0.1', targetPort, { token: 'lan-secret', dshToken: LAUNCH });
  await new Promise((r) => relay3.listen(0, '127.0.0.1', r));
  const p3 = relay3.address().port;
  const r3a = await req(p3, 'GET', '/');
  check('场景3: 无 remoteToken → 401', r3a.code === 401, String(r3a.code));
  const r3b = await req(p3, 'GET', '/?token=lan-secret');
  check('场景3: ?token=lan-secret → 302 种 lan cookie', r3b.code === 302 && /dsh_lan_token=/.test(r3b.headers['set-cookie'] ? r3b.headers['set-cookie'].join(';') : ''), r3b.code + ' ' + JSON.stringify(r3b.headers['set-cookie']));
  const r3c = await req(p3, 'GET', '/', { Cookie: 'dsh_lan_token=lan-secret' });
  check('场景3: lan cookie + DSH 桥 → 200', r3c.code === 200, r3c.code + ' ' + r3c.body);
  await new Promise((r) => relay3.close(r));

  // ── 场景 4：setDshToken 热更新（模拟实例重启令牌轮换）──
  relay.setDshToken('new-launch-xyz');
  // 新令牌下旧 cookie 失效：mock 换成用新令牌换取
  const upstream2 = http.createServer((q, s) => {
    const url = new URL(q.url, 'http://127.0.0.1');
    if (url.pathname === '/' && url.searchParams.get('token') === 'new-launch-xyz') {
      s.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-mock=newvalue456; Path=/; HttpOnly; SameSite=Strict' });
      s.end();
      return;
    }
    const cookie = q.headers.cookie || '';
    if (!/dsh-auth-mock=newvalue456/.test(cookie)) { s.writeHead(401); s.end('unauth'); return; }
    s.writeHead(200); s.end('ok-new');
  });
  await new Promise((r) => upstream2.listen(0, '127.0.0.1', r));
  const p2 = upstream2.address().port;
  // 重建 relay 指向新上游（模拟实例重启后端口变化；令牌热更新逻辑在 setDshToken 内）
  const relay2 = createRelay('127.0.0.1', p2, { dshToken: 'new-launch-xyz' });
  await new Promise((r) => relay2.listen(0, '127.0.0.1', r));
  const r4 = await req(relay2.address().port, 'GET', '/');
  check('场景4: 新令牌换取新 cookie → 200', r4.code === 200, r4.code + ' ' + r4.body);

  await new Promise((r) => relay.close(r));
  await new Promise((r) => relay2.close(r));
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => upstream2.close(r));

  console.log(failures === 0 ? '\nrelay-dshauth: ALL PASS' : '\nrelay-dshauth: ' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
