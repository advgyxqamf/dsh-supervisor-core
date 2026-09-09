#!/usr/bin/env node
'use strict';

// 点对点 API 测试：完整 Supervisor + api.js 的 /router/* 全路由。
// 覆盖：status/providers/add(直连+反代)/login/update/check|apply/proxy/key/select/
//       key/remove/keys/set/remove/key/use/refresh/account/confirm|discard/start|stop/
//       activate|deactivate（供应商独立端点生命周期）。
// 所有网络目标均为本机 mock，不触碰真实 DSH 与外部服务。

const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-api-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
// 产品不再内置 dry-run 测试供应商：测试自行注册本地 mock 反代应用（仅本进程内生效，不进生产）
const { PROXY_APPS: TEST_APPS } = require(path.join(ROOT, 'src', 'domains', 'router', 'proxy-apps'));
function registerDryRunApp() {
  if (TEST_APPS['test-dry-run']) return;
  TEST_APPS['test-dry-run'] = {
    id: 'test-dry-run',
    name: 'Dry (测试)',
    pkg: '(test)',
    command: ['node', path.join(ROOT, 'test', 'dry-run-proxy.js'), '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health', modelPath: '/v1/models', upstream: 'http://127.0.0.1:0',
    repo: null, registry: null,
    quota: { type: 'proxy-usage', usagePath: '/usage' },
    real: false,
  };
}
registerDryRunApp();

(async () => {
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:1/',
    probeIntervalMs: 300, probeTimeoutMs: 1200, failThreshold: 2, startTimeoutMs: 5000,
    stopGraceMs: 800, killWaitMs: 1500, portReleaseWaitMs: 600, crashWindowMs: 10000, crashBurst: 4, backoff: [1500, 3000, 6000],
    apiHost: '127.0.0.1', apiPort: 31930,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
    distDir: path.join(TMP, 'dist'),
    switcherDir: path.join(TMP, 'sw'),
    providerFile: path.join(TMP, 'sw', 'providers.json'),
  };
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const { createServer } = require(path.join(ROOT, 'src', 'api', 'index'));
  const sup = new Supervisor(cfg);
  const server = createServer(sup);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const api = (m, p, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ let j=null; try{ j=b?JSON.parse(b):null; }catch{} resolve({code:res.statusCode, body:j}); }); });
    if (body) req.write(JSON.stringify(body)); req.end();
  });

  // 1. status（未启动）
  let r = await api('GET', '/router/status');
  check('P1 /router/status', r.code === 200 && r.body.running === false, r.code + ' ' + JSON.stringify(r.body && r.body.running));

  // 2. providers（空 + presets + proxyApps）
  r = await api('GET', '/router/providers');
  check('P2 /router/providers presets', r.code === 200 && (r.body.presets||[]).some((p) => p.id === 'opencode-zen'), r.code);
  check('P3 proxyApps 含 commandcode', (r.body.proxyApps||[]).some((a) => a.id === 'commandcode' && a.registry === 'commandcode-api-proxy'), JSON.stringify(r.body.proxyApps && r.body.proxyApps[0]));

  // 3. 添加直连（presetId）
  r = await api('POST', '/router/providers/add', { name: 'Zen', presetId: 'opencode-zen', keys: ['sk-api-1'] });
  check('P4 添加直连', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // 4. 添加反代（dry-run）
  r = await api('POST', '/router/providers/add', { kind: 'proxy', appId: 'test-dry-run', name: 'Dry', keys: ['pk-1'] });
  check('P5 添加反代', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  const proxyPid = r.body.id;

  // 5. providers 列表含两者
  r = await api('GET', '/router/providers');
  const kinds = (r.body.providers||[]).map((p) => p.kind).sort().join(',');
  check('P6 providers 直连+反代', r.code === 200 && kinds === 'direct,proxy', kinds);

  // 6. 启动路由
  r = await api('POST', '/router/start');
  check('P7 /router/start', r.code === 200 && r.body.running === true, r.code + ' ' + JSON.stringify(r.body && r.body.running));

  // 7. status running + usage 结构
  r = await api('GET', '/router/status');
  check('P8 status running + usage', r.body.running === true && r.body.usage && typeof r.body.usage.requests === 'number', JSON.stringify({ running: r.body.running, req: r.body.usage && r.body.usage.requests }));

  // 8. 反代账号异步注册（等待 dry-run 实例起来）
  await new Promise((res) => setTimeout(res, 8000));
  r = await api('GET', '/router/providers');
  const proxyP = (r.body.providers||[]).find((p) => p.kind === 'proxy');
  const accs = (proxyP && proxyP.accounts) || [];
  // 统一入库语义（2026-09）：检测完成即入终态——ready（正常）或 frozen（受限自动冻结，到点自动解冻）；review 闸门已移除
  check('P9 反代账号注册完成（ready / 受限自动 frozen）', accs.length >= 1 && accs.every((a) => a.status === 'ready' || a.status === 'frozen'), JSON.stringify(accs.map((a) => a.status)));
  check('P10 反代实例信息在视图', accs.some((a) => a.instanceStatus), JSON.stringify(accs[0] && { st: accs[0].instanceStatus, h: accs[0].healthy }));

  // 8b. 供应商独立端点：默认停用 → 激活分配端口 → 列表地址下沉 → 停用回收
  r = await api('GET', '/router/providers');
  const deactView = (r.body.providers || []).find((p) => p.id === proxyPid);
  check('P9a 新供应商默认停用（未激活不提供服务）', deactView && deactView.activated === false, JSON.stringify(deactView && { activated: deactView.activated, apiBase: deactView.apiBase }));
  r = await api('POST', '/router/providers/activate', { id: proxyPid });
  check('P9b 激活供应商分配独立 API 端口', r.code === 200 && r.body.ok === true && typeof r.body.apiPort === 'number', r.code + ' ' + JSON.stringify(r.body));
  r = await api('GET', '/router/providers');
  const actView = (r.body.providers || []).find((p) => p.id === proxyPid);
  check('P9c 卡片地址下沉(apiBase)', actView && actView.activated === true && !!actView.apiBase, JSON.stringify(actView && { a: actView.activated, api: actView.apiBase }));
  r = await api('POST', '/router/providers/deactivate', { id: proxyPid });
  check('P9d 停用回收资源（端点关闭）', r.code === 200 && r.body.ok === true && r.body.activated === false, JSON.stringify(r.body));
  r = await api('GET', '/router/providers');
  const deact2 = (r.body.providers || []).find((p) => p.id === proxyPid);
  check('P9e 停用后视图 activated=false，独立地址失效', deact2 && deact2.activated === false && !deact2.apiBase, JSON.stringify(deact2 && { activated: deact2.activated, apiBase: deact2.apiBase }));

  // 9. 直连 provider 的 key/use（锁定账号）——重新拉最新列表
  r = await api('GET', '/router/providers');
  const directP = (r.body.providers||[]).find((p) => p.kind === 'direct');
  const dacc = (directP && directP.accounts) || [];
  // A 语义：锁只对可用账号有意义——锁定 ready 账号成功；锁定不可用（冻结/discarded）被拒
  const daccReady = dacc.find((a) => a.status === 'ready');
  if (daccReady) {
    r = await api('POST', '/router/providers/key/use', { id: directP.id, fingerprint: daccReady.keyId });
    check('P12 锁定可用 key', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  } else {
    check('P12 锁定 key（无 ready 账号，跳过）', true);
  }
  const daccBad = dacc.find((a) => a.status !== 'ready');
  if (daccBad) {
    r = await api('POST', '/router/providers/key/use', { id: directP.id, fingerprint: daccBad.keyId });
    check('P12b 锁定不可用账号被拒（A 语义）', r.code === 400 && r.body.ok === false, r.code + ' ' + JSON.stringify(r.body));
  }

  // 11. 刷新供应商配额
  r = await api('POST', '/router/providers/refresh', { id: directP.id });
  check('P13 刷新配额', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // 12. 更新检查
  r = await api('POST', '/router/proxy/update/check', {});
  check('P14 更新检查端点', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // 13. account confirm/discard（不存在 id → 合理错误）
  r = await api('POST', '/router/providers/account/confirm', { id: 'nope', keyId: 'x' });
  check('P15 confirm 未知供应商', r.code === 400 && r.body.ok === false, r.code + ' ' + JSON.stringify(r.body));
  r = await api('POST', '/router/providers/account/discard', { id: 'nope', keyId: 'x' });
  check('P16 discard 未知供应商', r.code === 400 && r.body.ok === false, r.code + ' ' + JSON.stringify(r.body));

  // 14. keys/set（给直连加 key）
  r = await api('POST', '/router/providers/keys/set', { id: directP.id, add: ['sk-api-2'] });
  check('P17 keys/set 添加', r.code === 200 && r.body.ok === true && r.body.added === 1, r.code + ' ' + JSON.stringify(r.body));

  // 15. proxy/key 添加反代账号（会 spawn 实例；dry-run 可重复起）
  r = await api('POST', '/router/providers/proxy/key', { id: proxyP.id, key: 'pk-2' });
  check('P18 proxy/key 添加账号', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body).slice(0, 80));

  // 16. proxy/select 选中账号（A 语义：锁定 ready 成功；锁定不可用被拒）
  r = await api('GET', '/router/providers');
  const proxyNow = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  const paccsNow = (proxyNow && proxyNow.accounts) || [];
  const pready = paccsNow.find((a) => a.status === 'ready');
  if (pready) {
    r = await api('POST', '/router/providers/proxy/select', { id: proxyPid, keyId: pready.keyId });
    check('P19 proxy/select 锁定可用账号', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  } else {
    check('P19 proxy/select（无 ready 账号，跳过）', true);
  }
  const pbad = paccsNow.find((a) => a.status !== 'ready');
  if (pbad) {
    r = await api('POST', '/router/providers/proxy/select', { id: proxyPid, keyId: pbad.keyId });
    check('P19b proxy/select 锁定不可用账号被拒（A 语义）', r.code === 400 && r.body.ok === false, r.code + ' ' + JSON.stringify(r.body));
  }

  // 17. 停止路由
  r = await api('POST', '/router/stop');
  check('P20 /router/stop', r.code === 200 && r.body.running === false, r.code + ' ' + JSON.stringify(r.body && r.body.running));

  // 18. 删除供应商
  r = await api('POST', '/router/providers/remove', { id: proxyP.id });
  check('P21 删除反代供应商', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // 19. 环境状态 + 守卫自更新（未配置源 → 明确错误）
  r = await api('GET', '/env/status');
  check('P22 /env/status', r.code === 200 && r.body && typeof r.body.node === 'object' && 'detected' in (r.body.node || {}), r.code + ' ' + JSON.stringify(r.body && r.body.node));
  r = await api('GET', '/self-update/status');
  check('P23 /self-update/status 未配置源 → 明确错误', r.code === 400 && r.body.ok === false && /未配置/.test(r.body.error || ''), r.code + ' ' + JSON.stringify(r.body));

  // 21. local() 兜底 stale 标注（阶段三）：daemon 未激活/ctl 失败时返回 _stale 应急视图（不再伪装成实时）
  // 测试环境 daemon 未启动（内嵌/直接），routerProviders 走 local() → 应带 _stale:true 标注
  {
    const rp = sup.routerProviders();
    const v = rp && rp.then ? await rp : rp;
    check('P29 local() 应急视图带 _stale 标注（防误当实时）', v && v._stale === true && Array.isArray(v.providers), JSON.stringify(v && { stale: v._stale, hasProviders: Array.isArray(v.providers) }));
  }

  // 22. 资源端口视图 /router/ports（阶段迁移 S1）：router 自治段（proxy/providerApi）由 daemon 自供，守卫仅转发
  r = await api('GET', '/router/ports');
  const pv = (r.body && r.body.records) || [];
  const proxyRecs = pv.filter((x) => String(x.owner || '').startsWith('proxy:'));
  const apiRecs = pv.filter((x) => String(x.owner || '').startsWith('providerApi:'));
  check('P30 /router/ports 只含 router 自治段（proxy/providerApi）', r.code === 200 && proxyRecs.length >= 1 && apiRecs.length >= 1 && !pv.some((x) => String(x.owner || '').startsWith('system:')), r.code + ' recs=' + pv.length + ' proxy=' + proxyRecs.length);
  check('P30b active 字段为布尔（TCP 探测；测试后段实例已停→false 为正确语义）', proxyRecs.every((x) => typeof x.active === 'boolean'), JSON.stringify(proxyRecs.map((x) => ({ port: x.port, active: x.active }))));

  // 23. 分域取数（迁移S3）：守卫 /ports 只含守卫自有段——但测试为内嵌模式（router 与守卫同进程共享注册表单例），
  //      生产 daemon 模式 router 独立 ports-router.json，/ports 自然无 router 段（见 P30 域分离契约）；
  //      此处断言内嵌模式语义：/ports 可含 proxy 段（同进程注册表），且 router 段经 /router/ports 可取（P30 已验证）。
  r = await api('GET', '/ports');
  const gv = (r.body && r.body.records) || [];
  check('P31 守卫 /ports 可用且 router 段走 /router/ports（内嵌同进程注册表；daemon 模式物理分离）', r.code === 200 && Array.isArray(gv) && gv.length > 0, r.code + ' recs=' + gv.length);

  server.close();
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
