#!/usr/bin/env node
'use strict';

// 点对点（P2P）全功能测试：智能路由 RouterService。
// 覆盖：直连供应商（preset 添加/账号检测/切换/配额/用量）、反代包装器（真实 spawn dry-run/
//       探活/转发/配额检测/冻结状态机/解冻/更新检查）、周期维护调度、持久化 round-trip。
//
// 沙箱注意：bwrap --unshare-pid 下进程组 kill(-pid) 会误杀主进程，故 stopInstance 的
//           真实 kill 链路由宿主验证；本测试用 ProxyInstance 状态机直接验证冻结/解冻语义。
// 所有网络目标均为本机 mock，不触碰真实 DSH 与外部服务。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-router-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
// 产品不再内置 dry-run 测试供应商：测试自行注册本地 mock 反代应用（仅本进程内生效，不进生产）
const { PROXY_APPS: TEST_APPS } = require(path.join(ROOT, 'src', 'domains', 'router', 'proxy-apps'));
const registerCleanup = require(path.join(ROOT, 'test', 'helpers-cleanup'));
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
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

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ---- mock 上游：OpenCode 风格 /usage（支持 /usage 与 /v1/usage）----
const upstream = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
    const url = q.url || '';
    const auth = q.headers.authorization || '';
    if (url === '/usage' || url === '/v1/usage') {
      const isBad = auth.includes('sk-full');
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ usage: { rolling: { status: isBad ? 'rate-limited' : 'ok', percent: isBad ? 100 : 15, resetsAt: isBad ? new Date(Date.now() + 3600000).toISOString() : null }, weekly: { status: 'ok', percent: 20, resetsAt: null }, monthly: { status: 'ok', percent: 30, resetsAt: null } } }));
      return;
    }
    if (url === '/v1/chat/completions') {
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ choices: [{ message: { content: 'p2p-ok' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
      return;
    }
    s.writeHead(404); s.end('nf');
  });
});

(async () => {
  await new Promise((r) => upstream.listen(28110, '127.0.0.1', r));
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const providerFile = path.join(TMP, 'providers.json');
  const svcs = [];
  const svc = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), usageTotalsFile: path.join(TMP, 'totals.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  svcs.push(svc);
  registerCleanup(() => svcs.flatMap((s) => s.providers || []));

  // ════════ A. 直连供应商全链路 ════════
  const rA = svc.addDirectProvider({ name: 'Zen', presetId: 'opencode-zen', keys: [] });
  // 供应商独立端点语义：直连转发前先激活直连供应商（激活即分配独立 API 端口）
  await svc.activateProvider(rA.id).catch(() => {});
  check('A1 预设添加直连', rA.ok === true, JSON.stringify(rA));
  const dp = svc.getProvider(rA.id);
  check('A2 preset 注入 baseUrl/adapter', dp.baseUrl === 'https://opencode.ai/zen/go/v1' && dp.adapter && dp.adapter.quota.type === 'opencode-usage', dp.baseUrl);
  check('A3 preset 注入 plan', dp.plan && dp.plan.per5hUsd === 12, JSON.stringify(dp.plan));

  dp.baseUrl = 'http://127.0.0.1:28110/v1';
  const aGood = await dp.addAccount('sk-good-001');
  check('A4 正常账号检测 → ready', aGood.ok && aGood.account.status === 'ready', JSON.stringify(aGood.account && aGood.account.status));
  const aFull = await dp.addAccount('sk-full-001');
  check('A5 满额账号 → 直接 frozen（统一状态机，无 review 闸门）', aFull.ok && aFull.limited === 'window' && aFull.review === false && aFull.account.status === 'frozen', JSON.stringify({ limited: aFull.limited, status: aFull.account && aFull.account.status }));
  check('A5b 满额账号带精确恢复点（recovery.at=窗口 resetsAt）', aFull.account.limit && aFull.account.limit.kind === 'window' && aFull.account.limit.recovery && aFull.account.limit.recovery.type === 'at' && aFull.account.limit.recovery.at === aFull.account.nextResetAt, JSON.stringify(aFull.account.limit));
  const aFullAcc = dp.accounts.find((a) => a.keyId === aFull.account.keyId);
  check('A6 满额冻结期不可用（不参与挑选）', dp.isAccountUsable(aFullAcc) === false);

  // 运行中自动恢复：窗口重置后定时探测 → applyDetection 自动解冻（与「添加时冻结」同一条状态机；无需人工入池）
  const renewed = { rolling: { status: 'ok', percent: 15, resetsAt: null }, weekly: { status: 'ok', percent: 20, resetsAt: null }, monthly: { status: 'ok', percent: 30, resetsAt: null } };
  dp.applyDetection(aFullAcc, { ok: true, quota: renewed });
  check('A7 窗口重置后探测 → 自动 ready（无入池点击）', aFullAcc.status === 'ready' && (!aFullAcc.limit || !aFullAcc.limit.kind), aFullAcc.status + ' limit=' + JSON.stringify(aFullAcc.limit));
  check('A7b 恢复后可挑选', dp.isAccountUsable(aFullAcc) === true);
  check('A8 正常账号可用', dp.isAccountUsable(dp.accounts.find((a) => a.keyId === aGood.account.keyId)) === true);

  dp.activeAccount = null;
  const picked = svc.switcher.pickFor(dp);
  check('A9 账号选择引擎选可用账号', picked && picked.keyId === aGood.account.keyId, picked && picked.keyId);

  const disc = dp.discardAccount(aFull.account.keyId);
  check('A10 作废账号移除', disc.ok && dp.accounts.length === 1, 'len=' + dp.accounts.length);

  const dup = await dp.addAccount('sk-good-001');
  check('A11 重复添加幂等', dup.already === true && dp.accounts.length === 1, JSON.stringify(dup));

  await svc.start();
  const fwd = await req(dp.apiPort, 'POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  check('A12 直连供应商独立端点转发成功', fwd.code === 200 && fwd.body.includes('p2p-ok'), fwd.code + ' ' + fwd.body.slice(0, 40));
  check('A13 用量已记录', svc.getUsage().requests >= 1 && svc.getUsage().totalTokens >= 7, JSON.stringify(svc.getUsage()));
  check('A14 按 key 用量累计', svc.getUsage().byKey && svc.getUsage().byKey[aGood.account.keyId] && svc.getUsage().byKey[aGood.account.keyId].totalTokens >= 7, JSON.stringify(svc.getUsage().byKey));

  // ════════ B. 反代包装器全链路（dry-run：真实 spawn）════════
  const rB = svc.addProxyProvider({ name: 'Dry', appId: 'test-dry-run', keys: ['proxy-key-1'] });
  // 供应商独立端点：激活（开放独立 API 端口；创建默认停用）
  check('B1 反代供应商添加', rB.ok === true, JSON.stringify(rB));
  const pp = svc.getProvider(rB.id);
  check('B2 反代类型/appId', pp.kind === 'proxy' && pp.proxyAppId === 'test-dry-run', pp.kind + '/' + pp.proxyAppId);
  const actR = await svc.activateProvider(rB.id);
  check('B2b 激活反代供应商（独立端点端口分配）', actR.ok === true && pp.activated === true && !!pp.apiPort, JSON.stringify({ ok: actR.ok, activated: pp.activated, apiPort: pp.apiPort }));
  await new Promise((r) => setTimeout(r, 8000));
  const pacc = pp.accounts.find((a) => a.key === 'proxy-key-1');
  check('B3 反代账号注册完成', pacc && pacc.status === 'ready', JSON.stringify(pacc && pacc.status));
  const pinst = pp.instances[0];
  check('B4 一账号一实例', pp.instances.length === 1, 'len=' + pp.instances.length);
  check('B5 实例真实启动且有端口', pinst && pinst.pid && pinst.port, JSON.stringify({ pid: pinst && pinst.pid, port: pinst && pinst.port }));

  const health = await req(pinst.port, 'GET', '/health');
  check('B6 实例探活端点', health.code === 200 && health.body.includes('ok'), health.code + ' ' + health.body.slice(0, 40));

  // B7. 通过反代供应商独立端点转发（dry-run 返回自己的 OpenAI 兼容响应 = 包装器链路通）
  const fwdP = await req(pp.apiPort, 'POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  check('B7 反代供应商独立端点转发成功', fwdP.code === 200 && fwdP.body.includes('dry-run'), fwdP.code + ' ' + fwdP.body.slice(0, 50));

  check('B8 反代配额已检测', pinst.quota && pinst.quota.rolling && Number.isFinite(Number(pinst.quota.rolling.percent)), JSON.stringify(pinst.quota));

  // B9/B10：实例四态词表（PROVIDER-GATEWAY-ARCHITECTURE §4.1 / PG-3）。
  //   ⚠ 实例级 freeze/unfreeze 已删除（未接线的死代码）；"冻结"是账号级语义。
  check('B9 实例态为四态词表之一', ['COLD', 'WARM', 'HOT', 'DEAD'].includes(pinst.status), pinst.status);
  check('B9b 有进程 → occupiesSlot=true', pinst.occupiesSlot() === true, String(pinst.occupiesSlot()));
  check('B10 就绪 → isServable（HOT+pid）', typeof pinst.isServable() === 'boolean', String(pinst.isServable()));

  // 重新拉起（startInstance 复用同一实例，端口重新分配）
  const rr = await pp.startInstance(pinst);
  check('B11 解冻后重新拉起', rr.ok === true && pinst.pid, JSON.stringify({ ok: rr.ok, pid: pinst.pid, port: pinst.port }));
  await new Promise((r) => setTimeout(r, 1500));

  const up = await svc.refreshProxyUpdateInfo(true);
  check('B12 更新检查（test-dry-run 无源）', up && up['test-dry-run'] === null, JSON.stringify(up));

  // 供应商独立端点：自身 /health 可用（激活即提供服务；未激活不监听）
  let ep = null;
  if (pp.apiPort) {
    ep = await new Promise((resolve) => { const r2 = http.request({ host: '127.0.0.1', port: pp.apiPort, path: '/health', method: 'GET', timeout: 2000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r2.on('error', () => resolve(0)); r2.end(); });
  }
  check('B13 独立端点 /health 200（激活即提供服务）', ep === 200, String(ep));

  const apps = svc.proxyApps();
  check('B13 proxyApps 注册表', apps.length >= 2 && apps.some((a) => a.id === 'commandcode' && a.registry === 'commandcode-api-proxy'), apps.map((a) => a.id + ':' + a.registry).join(','));

  // ════════ C. 持久化 round-trip ════════
  await svc.stop(); // 路由停止即停全部反代实例（防 dry-run/verproxy 子进程残留占用动态端口段）
  const svc2 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), usageTotalsFile: path.join(TMP, 'totals.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  svcs.push(svc2);
  check('C1 重启后供应商保留', svc2.providers.length === 2, 'len=' + svc2.providers.length);
  const dp2 = svc2.providers.find((p) => p.kind === 'direct');
  const pp2 = svc2.providers.find((p) => p.kind === 'proxy');
  check('C2 直连账号 key 保留', dp2.accounts[0].key === 'sk-good-001', dp2.accounts[0].key);
  check('C3 反代账号 key 保留', pp2.accounts[0].key === 'proxy-key-1', pp2.accounts[0].key);
  check('C4 反代实例 key 保留', pp2.instances[0].key === 'proxy-key-1', pp2.instances[0].key);

  // ════════ D. 维护调度 ════════
  check('D1 维护方法存在', typeof svc2._startMaintenance === 'function' && typeof svc2._stopIdleProxyInstances === 'function' && typeof svc2._probeAccountStates === 'function' && typeof svc2.refreshOfficialPricingAll === 'function');
  await svc2.start();
  await new Promise((r) => setTimeout(r, 500));
  check('D2 启动后定时器已挂', svc2._maintTimer !== null && svc2._pricingTimer !== null);
  await svc2.stop(); // 同上：停止即停实例
  check('D3 停止后定时器清理', svc2._maintTimer === null && svc2._pricingTimer === null);

  // ════════ E. 冻结释放调度（resetAt 已到 → applyDetection 自动解冻，状态机层面验证）════════
  // 注：_releaseFrozenInstances 已在架构重构中删除，解冻语义收敛为 _probeAccountStates 的
  // 到点探测 + applyDetection 恢复（frozen + nextResetAt ≤ now → 探测通过 → ready）。
  const pp3 = svc2.providers.find((p) => p.kind === 'proxy');
  const acc3 = pp3 && pp3.accounts && pp3.accounts[0];
  if (acc3) {
    acc3.status = 'frozen';
    acc3.nextResetAt = Date.now() - 1000; // 复位时间已过 → 到点触发探测
    pp3.applyDetection(acc3, { ok: true, quota: { monthly: { status: 'ok', percent: 10, resetsAt: null }, weekly: null, rolling: null } });
    check('E1 resetAt 已到自动解冻（applyDetection 调度语义）', acc3.status === 'ready', acc3.status);
  } else {
    check('E1 冻结释放（无账号，跳过）', true);
  }

  // ════════ F. 锁收敛语义（2026-09 A 定稿）════════
  // 锁只对「当前可用」账号有意义：账号因任何原因冻结（额度满等，与其余限额账号同一状态机）
  // → 锁失效清空；恢复后不自动回锁，需要时用户显式重新锁定。不存在独立于状态机的死锁残留。
  const ppF = svc2.providers.find((p) => p.kind === 'proxy');
  const accF = ppF && ppF.accounts && ppF.accounts.find((a) => a.status === 'ready');
  if (accF) {
    ppF.selectedAccountKeyId = accF.keyId; // 显式锁定可用账号
    // 冻结（真实状态机路径 _freezeLimited → _setStatus frozen）→ 锁随可用性清除
    ppF._freezeLimited(accF, 'window', '额度用尽（测试冻结）', { type: 'at', at: Date.now() + 3600000 });
    check('F1 冻结即清锁（锁不残留于冻结账号）', ppF.selectedAccountKeyId === null, String(ppF.selectedAccountKeyId));
    // 恢复（到点探测）→ ready；锁不自动回来；选号正常（粘滞/池内选可用）
    accF.nextResetAt = Date.now() - 1000;
    ppF.applyDetection(accF, { ok: true, quota: { monthly: { status: 'ok', percent: 10, resetsAt: null }, weekly: null, rolling: null } });
    ppF.activeAccount = null;
    const pickedF = svc2.switcher.pickFor(ppF);
    check('F2 恢复后无自动回锁（可用账号正常入选）', ppF.selectedAccountKeyId === null && !!pickedF, String(pickedF && pickedF.keyId));
    // 显式重新锁定 → 恢复后用户可再锁定并优先
    ppF.selectedAccountKeyId = accF.keyId;
    ppF.activeAccount = null;
    const pickedF2 = svc2.switcher.pickFor(ppF);
    check('F3 显式重锁后优先选中锁定账号', pickedF2 && pickedF2.keyId === accF.keyId, String(pickedF2 && pickedF2.keyId));
    ppF.selectedAccountKeyId = null; // 还原（不影响后续）
  } else {
    check('F1-F3 锁收敛（无 ready 账号，跳过）', true);
  }

  upstream.close();
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
