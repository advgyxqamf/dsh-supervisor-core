
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-verify-'));
const MOCK = path.join(ROOT, 'test', 'mock-target.js');

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? '  ← ' + extra : '')); };

(async () => {
  // 1. 构造 supervisor，验证统一端口管理与 LAN 代理语义
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  // 动态空闲端口：规避固定端口与历史 TIME_WAIT 残留的偶发绑定冲突（EADDRINUSE）
  const freePort = () => new Promise((res) => {
    const srv = http.createServer();
    srv.on('error', () => res(0));
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
  const apiPort = await freePort();
  const targetPort = await freePort();
  const okPort = await freePort();
  const stateDir = path.join(TMP, 'sup');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: 'http://127.0.0.1:' + targetPort + '/',
    apiHost: '127.0.0.1', apiPort,
    stateFile: path.join(stateDir, 'state.json'),
    logFile: path.join(stateDir, 'events.log'),
    supervisorLogFile: path.join(stateDir, 'supervisor.log'),
    dshLogFile: path.join(stateDir, 'dsh.log'),
    upgradeLogFile: path.join(stateDir, 'upgrade.log'),
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const instancesFile = path.join(stateDir, 'instances.json');
  fs.writeFileSync(instancesFile, JSON.stringify({ instances: [
    // 概念清分(2026-09-06)：main 不再存沙箱 instances——由守卫核心 dsh-main.json 持有（下方预置）
    { id: 'inst-down', name: '未运行', port: 39999, domain: 'sandbox', guardian: false, remoteEnabled: true },
    { id: 'inst-ok', name: '正常实例', port: okPort, domain: 'sandbox', guardian: false, remoteEnabled: true },
  ]}));
  // main(原生主干)元数据：守卫核心存储 dsh-main.json（remoteEnabled=true → 允许远程）
  fs.writeFileSync(path.join(stateDir, 'dsh-main.json'), JSON.stringify({ guardian: false, remoteEnabled: true }));
  // 起 mock 在 targetPort（main 的目标）与 okPort（沙箱实例）上
  const mockMain = spawn('node', [MOCK, String(targetPort)], { stdio: 'ignore' });
  const mockOk = spawn('node', [MOCK, String(okPort)], { stdio: 'ignore' });
  // 确定性就绪等待：轮询 mock HTTP 探活（替代固定 900ms——负载下可能未就绪即 syncProxy 导致抖动失败）
  const waitReady = (port) => new Promise((res) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const rq = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (s) => { s.resume(); res(true); });
      rq.on('error', () => { if (Date.now() - t0 > 6000) res(false); else setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
  const [rdyMain, rdyOk] = await Promise.all([waitReady(targetPort), waitReady(okPort)]);
  check('mock 双目标就绪（就绪轮询）', rdyMain && rdyOk, JSON.stringify({ main: rdyMain, ok: rdyOk }));

  const sup = new Supervisor(cfg, cfgPath);
  const insts = sup.instances.instances;
  const instDown = insts.find((i) => i.id === 'inst-down');
  const instOk = insts.find((i) => i.id === 'inst-ok');
  // main 为守卫核心服务：视图经 dshMainView()（不再在沙箱数组）
  const instMain = sup.dshMainView();
  check('沙箱实例按配置加载', !!instDown && !!instOk);
  check('main(守卫核心视图)存在且 remoteEnabled', !!instMain && instMain.remoteEnabled === true && insts.every((i) => i.id !== 'main'), JSON.stringify(instMain && { id: instMain.id, remoteEnabled: instMain.remoteEnabled }));

  // 2. 端口注册表：固定端口登记 + 动态分配避开
  const ports = require(path.join(ROOT, 'src', 'guard', 'lifecycle', 'ports')).shared;
  sup._registerFixedPorts();
  check('固定端口已登记', ports.get('dsh-main') === targetPort && ports.get('supervisor-api') === apiPort);
  const relayPort = await ports.allocate('relay');
  check('relay 端口 40000+（非常用段）', relayPort >= 40000 && relayPort <= 40199);
  check('relay 端口避开固定端口', relayPort !== targetPort && relayPort !== apiPort);

  // 3. syncProxy：只有目标在监听才建代理
  const lan = sup.lan;
  await lan.syncProxy(instDown); // 未在监听 → 不建
  check('未运行实例不建代理', !lan.lanInstances.some((p) => p.dshPort === 39999));
  await lan.syncProxy(instOk); // 在监听 → 建
  check('在运行实例建代理成功', !!lan.lanInstances.find((p) => p.dshPort === okPort));
  await lan.syncProxy(instMain); // main 在监听 → 建（main 开远程是允许的）
  check('main 在监听时建代理', !!lan.lanInstances.find((p) => p.dshPort === targetPort));
  // 代理端口互不冲突
  const wanPorts = lan.lanInstances.map((p) => p.wanPort);
  check('代理端口互不重复', new Set(wanPorts).size === wanPorts.length, JSON.stringify(wanPorts));
  check('代理端口全部非常用段', wanPorts.every((w) => w >= 40000 && w <= 40199));

  // 4. 代理可访问：relay 转发到 mock
  const proxy = lan.lanInstances.find((p) => p.dshPort === okPort);
  if (proxy) {
    await new Promise((r) => setTimeout(r, 300));
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy.wanPort, path: '/', timeout: 2000 }, (res) => { let b=''; res.on('data', c=>b+=c); res.on('end', ()=>resolve(b)); }).on('error', () => resolve('ERR'));
    });
    check('远程控制可访问（relay 转发成功）', body.includes('ok'), body.slice(0, 50));
  }

  // 5. 停止实例 → reconcile「暂停 relay、保留注册」（设计语义：目标恢复后同 wanPort 自动重接，
  //    绝不端口重建竞争）。原断言预期「代理被清理」与 reconcile 语义矛盾（过时断言），修正如下。
  mockOk.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  lan.reconcile();
  const proxyAfter = lan.lanInstances.find((p) => p.dshPort === okPort);
  check('目标停止后代理暂停（注册保留、relay 停止，恢复后自动重接）', !!proxyAfter && !(lan._lanServers && lan._lanServers[proxyAfter.id]), JSON.stringify(proxyAfter && proxyAfter.wanPort));
  check('main 代理保留（目标仍在监听）', !!lan.lanInstances.find((p) => p.dshPort === targetPort));

  // 清理
  try { mockOk.kill('SIGKILL'); } catch {}
  try { mockMain.kill('SIGKILL'); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
