#!/usr/bin/env node
'use strict';

// 验证 _ensureProxyInstances：反序列化后 registered 实例自动拉起 → 探活拿到 version。
// 用带 /health version 的 mock 反代（不触碰真实 commandcode 与外部服务）。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

// 带 version 的 mock 反代脚本（写进 TMP）
const mockApp = path.join(TMP, 'verproxy.js');
fs.writeFileSync(mockApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18999'),10);\nhttp.createServer((req,res)=>{ if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok', version:'1.2.3'})); return; } if (req.url === '/usage') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({usage:{rolling:{status:'ok',percent:5,resetsAt:null},weekly:{status:'ok',percent:10,resetsAt:null},monthly:{status:'ok',percent:15,resetsAt:null}}})); return; } res.writeHead(404); res.end('nf'); }).listen(port,'127.0.0.1',()=>console.log('verproxy on '+port));\nprocess.on('SIGTERM',()=>process.exit(0));\n");

(async () => {
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const { PROXY_APPS } = require(path.join(ROOT, 'src', 'domains', 'router', 'proxy-apps'));
  // 把 mock app 注册进 PROXY_APPS（_deserializeProvider 依赖它恢复 app）
  PROXY_APPS['vermock'] = { id: 'vermock', name: 'VerMock', command: ['node', mockApp, '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health', modelPath: '/v1/models', upstream: 'http://127.0.0.1:0', registry: null, quota: { type: 'proxy-usage', usagePath: '/usage' }, real: false };

  const providerFile = path.join(TMP, 'providers.json');
  // 端口注册表隔离：RouterService 不触发 Supervisor 的 configureFile，直接构造会污染生产 ports.json
  const ports = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'ports-router.json'));
  const svc = new RouterService({ config: {}, providerFile, port: 19180, usageTotalsFile: path.join(TMP, 't.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  const app = PROXY_APPS['vermock'];
  const pp = new ProxyProvider({ id: 'prov-vm', name: 'VerMock', kind: 'proxy', proxyAppId: 'vermock', app, logger: { info() {}, warn() {}, error() {} }, events: null, dist: null, onPersist: () => svc._save() });
  pp.activated = true; // 供应商独立端点语义：仅激活供应商常驻/恢复实例（本测试直接走 ensure）
  svc.providers.push(pp);
  svc._save();

  // 添加账号 → 启动 → 探活拿 version
  const r1 = await pp.addAccount('sk-vm-1');
  check('A1 账号注册 ready', r1.ok && r1.account.status === 'ready', JSON.stringify(r1.account && r1.account.status));
  const inst = pp.instances[0];
  check('A2 实例运行且有 version', inst.pid && inst.version === '1.2.3', JSON.stringify({ pid: inst.pid, version: inst.version }));

  // 模拟重启：重建 RouterService（进程态不落盘 → 实例 registered、version 丢失）
  // 先停止第一个 RouterService 的实例：否则 41000 仍被旧进程监听，svc2 复用同端口 spawn → EADDRINUSE
  for (const pp0 of svc.providers) { if (pp0.kind !== 'proxy') continue; for (const ins of (pp0.instances || [])) { try { pp0.stopInstance(ins); } catch {} } }
  await new Promise((r) => setTimeout(r, 400));
  const svc2 = new RouterService({ config: {}, providerFile, port: 19180, usageTotalsFile: path.join(TMP, 't.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  const pp2 = svc2.providers.find((p) => p.kind === 'proxy');
  if (!pp2) { console.log('ERR pp2 not found'); process.exit(1); }
  const inst2 = pp2.instances[0];
  if (!inst2) { console.log('ERR inst2 not found; providers=' + JSON.stringify(svc2.providers.map((p) => ({ kind: p.kind, insts: (p.instances || []).length })))); process.exit(1); }
  check('B1 重启后实例 registered（进程态不落盘）', inst2.status === 'registered' && !inst2.pid, JSON.stringify({ status: inst2.status, pid: inst2.pid }));
  check('B2 重启后 version 保留（供 UI 展示，探活后刷新）', inst2.version === '1.2.3', String(inst2.version));

  // 调用 _ensureProxyInstances → 应拉起并探活拿 version
  await svc2._ensureProxyInstances();
  check('C1 ensure 后实例已拉起', inst2.pid && (inst2.status === 'running' || inst2.status === 'starting'), JSON.stringify({ pid: inst2.pid, status: inst2.status }));
  await new Promise((r) => setTimeout(r, 1500));
  check('C2 ensure 后 version 恢复', inst2.version === '1.2.3', String(inst2.version));
  check('C3 ensure 后 healthy', inst2.healthy === true, String(inst2.healthy));

  // 幂等：再次 ensure 不重复拉起（已在运行）
  const pidBefore = inst2.pid;
  await svc2._ensureProxyInstances();
  check('D1 ensure 幂等（不重复 spawn）', inst2.pid === pidBefore, pidBefore + ' vs ' + inst2.pid);

  await svc2.stop(); // 路由停止即停全部反代实例（防 verproxy 残留）
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
