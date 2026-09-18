#!/usr/bin/env node
'use strict';

// 卸载类测试（项目政策，2026-08-31）：本脚本含 POST /native/uninstall（控制面板对 DSH 原生卸载）契约断言，
// 已纳入 npm test（CI）自动测试链执行；测试结论只能由 CI 裁决，本地不单独复跑
// （如需排查，可显式执行 node test/api-contract-test.js 或 npm run test:api-contract）。

// API 契约断言测试：对 createServer 的响应对未来回归设防。
// 覆盖审计修复的关键契约：202 异步受理带 ok、key/use 路由 await（Promise 序列化回归）、
// 实例/插件写操作状态码与 ok 字段。全部用最小 stub Supervisor（Proxy 兜底方法）。

const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const API_PORT = 28010;
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const nativeManager = {
  startInstall: () => ({ ok: true }),
  startUninstall: () => ({ ok: true }),
  upgrade: async () => ({ ok: true }),
  busy: () => false,
  status: () => ({ installed: true, version: '1.0.0', state: 'installed' }),
  versionInfo: () => ({}),
  upgradeStatus: () => ({ state: 'idle' }),
  checkUpdate: async () => ({ ok: true }),
};
// 门面名是 sup.routerApi（api.js 全 router 路由走它）；Proxy get 命中 routerApi 返回此 stub。
// 注：旧 Proxy 曾用 'router' 名——api.js 从未暴露 sup.router，导致 key/use 等路由
// 命中 Proxy 兜底函数 → 400。2026-09 修复：对齐真实门面名。
// 真实门面 routerApi() 是方法（supervisor.js:561 this.routerApi() 返回门面对象）——
// Proxy 必须暴露「调用后返回对象」的函数，否则 api.js 里 sup.routerApi().switchToKey() 抛
// 'routerApi is not a function' → catch → 400。
const routerApi = () => ({ switchToKey: async () => ({ ok: true, selected: 'k1' }) });
const instances = {
  stopInstance: (id) => ({ ok: true, id: typeof id === 'object' ? id.id : null }),
  list: () => [{ id: 'main', port: 3080, name: '主实例', domain: 'native' }],
  // DG-11 查询接口（消费方不再直读 .instances.instances）
  find: (id) => [{ id: 'main', port: 3080, name: '主实例', domain: 'native' }].find((x) => x.id === id),
  all: () => [],
};
const pluginManager = { install: async () => ({ ok: true }) };
const lan = { list: () => ({ items: [], addresses: [] }) };
const tokenService = { get: () => 'dsh-session-token-abc123' };

// Proxy 兜底：任何未 stub 的方法返回 { ok: true }（route 只取所需字段）
const sup = new Proxy({}, {
  get(t, k) {
    if (k === 'config') return { apiPort: API_PORT, apiHost: '127.0.0.1', command: ['node', 'x'], healthUrl: 'http://127.0.0.1:1/' };
    if (k === 'nativeManager') return nativeManager;
    if (k === 'routerApi') return routerApi;
    if (k === 'instances') return instances;
    if (k === 'pluginManager') return pluginManager;
    if (k === 'lan') return lan;
    if (k === 'tokenService') return tokenService;
    if (k === 'events') return { readSince: () => [], seq: 0 };
    if (k === 'tasks') return null;
    if (k === 'dist') return { registryInfo: async () => ({ ok: true }) };
    return function () { return { ok: true }; };
  },
});

const { createServer } = require(path.join(ROOT, 'src', 'api', 'index'));
const server = createServer(sup);

// 本机非回环 IPv4（P0-1 结构修复后的真实 LAN 身份来源：socket 层，不再伪造 Host 头）
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const LAN_IP = (() => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) { if (i.family === 'IPv4' && !i.internal) return i.address; }
  }
  return null;
})();

function req(method, p, body, hostHeader, extraHeaders, via) {
  return new Promise((resolve) => {
    const connectHost = via === 'lan' && LAN_IP ? LAN_IP : '127.0.0.1';
    const hh = hostHeader || (connectHost + ':' + API_PORT);
    const r = http.request({
      host: connectHost, port: API_PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:' + API_PORT, 'Host': hh, 'Content-Length': body ? Buffer.byteLength(body) : 0 }, extraHeaders || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, body: { raw: b } }); } });
    });
    r.on('error', (e) => resolve({ code: 0, body: { error: e.message } }));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(API_PORT, '0.0.0.0', r)); // 绑 0.0.0.0 支持真实 LAN socket 用例

  // 202 异步受理契约（审计 1.5 修复：ok:true 必须存在，前端 if(r.ok===false) 判定）
  let r = await req('POST', '/native/install', JSON.stringify({}));
  check('POST /native/install → 202 且 ok:true', r.code === 202 && r.body.ok === true && r.body.accepted === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/native/upgrade', JSON.stringify({}));
  check('POST /native/upgrade → 202 且 ok:true', r.code === 202 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/native/uninstall', JSON.stringify({}));
  check('POST /native/uninstall → 202 且 ok:true', r.code === 202 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // key/use await 契约（审计修复：async 方法必须 await，防 Promise 序列化 {} 回归）
  r = await req('POST', '/router/providers/key/use', JSON.stringify({ id: 'p1', fingerprint: 'k1' }));
  check('POST key/use → 200 且 selected 透传', r.code === 200 && r.body.ok === true && r.body.selected === 'k1', r.code + ' ' + JSON.stringify(r.body));

  // 写操作 ok 契约
  r = await req('POST', '/instances/stop', JSON.stringify({ id: 'i1' }));
  check('POST /instances/stop → 200 且 ok:true', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/plugins/install', JSON.stringify({ spec: '@x/p' }));
  check('POST /plugins/install → 200 且 ok:true', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // 跨站 Origin 仍拒绝（安全契约不回归）
  r = await req('POST', '/instances/stop', JSON.stringify({ id: 'i1' }));
  const evil = await new Promise((resolve) => {
    const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/instances/stop', method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    rr.on('error', () => resolve(0));
    rr.write(JSON.stringify({ id: 'i1' })); rr.end();
  });
  check('跨站 Origin 写请求拒绝 403', evil === 403, String(evil));

  // F1 授权收口契约（2026-09 审计修复）：/instances 的 authUrl 仅回环 Host 请求带 DSH token，
  // LAN 分支的语义已在 P3-C（fail-closed，FIX-1 B2 执行侧）变更：
  //   原契约「LAN/私网访问 200 放行但不下发 token」是**漏洞形态** —— 未配置 apiAccessKey 时
  //   整层鉴权被跳过，LAN 上任意设备可零认证驱动写 API；现为「LAN 未配置密钥一律 401」。
  //   故 F1 的 LAN 分支断言 401；「token 永不出本机」这条安全属性**转移**到 F2 的已认证 LAN 路径
  //   （带正确 key 请求 /instances → 200 且不下发 token）——覆盖面不因修漏洞而丢失。
  // 概念清分（2026-09-06）：响应拆两级——instances[]=沙箱、native=原生主干 main；F1 对 main（native 字段）断言。
  let instR = await req('GET', '/instances');
  const instLoopback = instR.body.native;
  check('F1 回环 Host /instances 下发含 token authUrl', !!instLoopback && instLoopback.authUrl.indexOf('token=dsh-session-token-abc123') >= 0 && instLoopback.tokenPresent === true, JSON.stringify(instLoopback && instLoopback.authUrl));
  instR = LAN_IP ? await req('GET', '/instances', null, LAN_IP + ':' + API_PORT, null, 'lan') : { code: 0, body: {} };
  check('F1 LAN（真实非回环 socket）未配置密钥 → 401（fail-closed）',
    !LAN_IP || instR.code === 401, LAN_IP ? (instR.code + '') : '（无 LAN 地址，跳过）');

  // F2 出回环访问密钥契约（2026-09 定案）：配置 apiAccessKey 后，LAN/私网 Host 请求必须带
  // Authorization: Bearer <key> 或 ?access_key=<key>（401 否则）；回环 Host 豁免（CLI/面板语义）。
  const KEY = 'test-access-key-123456';
  const KEY_PORT = API_PORT + 1;
  const supKey = new Proxy({}, {
    get(t, k) {
      if (k === 'config') return { apiPort: KEY_PORT, apiHost: '127.0.0.1', command: ['node', 'x'], healthUrl: 'http://127.0.0.1:1/', apiAccessKey: KEY };
      if (k === 'nativeManager') return nativeManager;
      if (k === 'router') return router;
      if (k === 'instances') return instances;
      if (k === 'pluginManager') return pluginManager;
      if (k === 'lan') return lan;
      if (k === 'tokenService') return tokenService;
      if (k === 'events') return { readSince: () => [], seq: 0 };
      if (k === 'tasks') return null;
      if (k === 'dist') return { registryInfo: async () => ({ ok: true }) };
      return function () { return { ok: true }; };
    },
  });
  const serverKey = createServer(supKey);
  await new Promise((res2) => serverKey.listen(KEY_PORT, '0.0.0.0', res2)); // 绑 0.0.0.0 支持真实 LAN socket 用例
  function reqKey(method, p, hostHeader, extraHeaders, via) {
    return new Promise((resolve) => {
      const connectHost = via === 'lan' && LAN_IP ? LAN_IP : '127.0.0.1';
      const hh = hostHeader || (connectHost + ':' + KEY_PORT);
      const r = http.request({
        host: connectHost, port: KEY_PORT, path: p, method,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Host': hh }, extraHeaders || {}),
      }, (res2) => {
        let b = '';
        res2.on('data', (c) => (b += c));
        res2.on('end', () => { try { resolve({ code: res2.statusCode, body: JSON.parse(b) }); } catch { resolve({ code: res2.statusCode, body: { raw: b } }); } });
      });
      r.on('error', (e) => resolve({ code: 0, body: { error: e.message } }));
      r.end();
    });
  }
  let kr = await reqKey('GET', '/status', null, null, 'lan');
  check('F2 LAN（真实非回环 socket）GET 无 key → 401', kr.code === 401, kr.code + ' ' + JSON.stringify(kr.body));
  kr = await reqKey('GET', '/status', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  check('F2 LAN Bearer 正确 → 放行 200', kr.code === 200, kr.code + '');
  kr = await reqKey('GET', '/status', null, { Authorization: 'Bearer wrong-key' }, 'lan');
  check('F2 LAN Bearer 错误 → 401', kr.code === 401, kr.code + '');
  kr = await reqKey('GET', '/status?access_key=' + KEY, null, null, 'lan');
  check('F2 LAN ?access_key= 正确 → 放行 200', kr.code === 200, kr.code + '');
  kr = await reqKey('GET', '/status'); // 默认 127.0.0.1 连接 = socket 回环身份
  check('F2 回环身份豁免（无 key 放行）', kr.code === 200, kr.code + '');
  // 自 F1 转移而来的安全属性：**已认证**的 LAN 路径上，响应仍不得包含 DSH token。
  //   （原断言依赖「LAN 未认证也能 200」这一漏洞前提；现改在带 key 的合法路径上验证。）
  kr = await reqKey('GET', '/instances', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  const instLanAuthed = kr.body && kr.body.native;
  check('F2 已认证 LAN GET /instances → 200 且不下发 token（安全属性转移自 F1）',
    !LAN_IP || (kr.code === 200 && !!instLanAuthed && instLanAuthed.authUrl.indexOf('token=') < 0 && instLanAuthed.tokenPresent === false),
    LAN_IP ? (kr.code + ' ' + JSON.stringify(instLanAuthed && instLanAuthed.authUrl)) : '（无 LAN 地址，跳过）');
  serverKey.close();

  server.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
