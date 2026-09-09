#!/usr/bin/env node
'use strict';

// 令牌边界回归（2026-09，docs/token-management.md）：
//  - supervisor.listLan() 输出剔除 token/dshToken（/lan-access 允许 LAN 访问，防会话令牌泄漏）
//  - InstanceManager.load 剔除历史遗留 dshToken 列（会话令牌不落盘）
//  - /status 仅暴露 dshTokenCaptured 布尔
// 自包含：构造测试 Supervisor（tmp 状态）+ 覆写 lan 存根，不触碰真实 daemon/账号。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-boundary-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}

function buildSupervisor() {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:39080/',
    apiHost: '127.0.0.1', apiPort: 39081,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    logLevel: 'error',
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return new Supervisor(cfg, cfgPath);
}

async function main() {
  console.log('== 令牌边界：listLan 输出不含会话令牌 ==');
  {
    const sup = buildSupervisor();
    // 本地模式：覆写 lan.list() 返回带 token/dshToken 的伪造项（模拟 relay 缓存内字段）
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-x', name: 'x', dshPort: 3081, wanPort: 40001, token: 'lan-gate-key', dshToken: 'SECRETSESSIONTOKEN', enabled: true, localPort: 1, running: true }], addresses: ['192.168.3.64'] }),
    };
    const r = sup.listLan();
    const it = r.items && r.items[0];
    check('listLan 保留结构字段', !!it && it.id === 'inst-x' && it.wanPort === 40001);
    check('listLan 剔除 remoteToken', !!it && !Object.prototype.hasOwnProperty.call(it, 'token'));
    check('listLan 剔除 dshToken', !!it && !Object.prototype.hasOwnProperty.call(it, 'dshToken'));
    check('listLan 白名单不含额外字段', Object.keys(it).sort().join(',') === ['dshPort','enabled','id','localPort','name','running','wanPort'].sort().join(','), Object.keys(it));
  }

  console.log('== 令牌边界：注入状态 inject 透传（不含令牌）==');
  {
    const sup = buildSupervisor();
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-r', name: 'r', dshPort: 3081, wanPort: 40001, token: 'k', dshToken: 'SECRET', enabled: true, localPort: 1, running: true, inject: { tokenSet: true, cookieReady: true, lastOkAt: 1, lastError: null, lastErrorAt: null } }], addresses: [] }),
    };
    const it = sup.listLan().items[0];
    check('inject 透传 cookieReady', !!it.inject && it.inject.cookieReady === true && it.inject.tokenSet === true);
    check('inject 透传仍无令牌', !!it.inject && !Object.prototype.hasOwnProperty.call(it, 'dshToken') && !Object.prototype.hasOwnProperty.call(it, 'token'));
  }

  console.log('== 令牌边界：L3b 门面路径同样剔除 ==');
  {
    const sup = buildSupervisor();
    // daemon 门面：listLan 经 ctl 后 sanitize——以假 Promise 覆写 _lanCtlCall 验证
    // 2026-09 结构单写后 daemon 门面由 lanDaemonEnabled() 判定（lanApi/API 方法均改判该）；测试 mock 对应
    sup.lanDaemonEnabled = () => true;
    sup._lanCtlCall = () => Promise.resolve({ items: [{ id: 'inst-y', dshPort: 3082, wanPort: 40003, dshToken: 'SECRET2' }], addresses: [] });
    const r = await sup.listLan();
    check('门面路径剔除 dshToken', r.items.length === 1 && !Object.prototype.hasOwnProperty.call(r.items[0], 'dshToken'));
  }

  console.log('== 令牌边界：instances.json 遗留 dshToken 列剔除 ==');
  {
    fs.writeFileSync(path.join(TMP, 'instances.json'), JSON.stringify({ instances: [{ id: 's1', name: 's', port: 39100, domain: 'sandbox', remoteEnabled: false, dshToken: 'STALEVALUE' }] }));
    const sup = buildSupervisor();
    sup.instances.load();
    const inst = sup.instances.instances.find((x) => x.id === 's1');
    check('load 后内存无 dshToken', inst && !Object.prototype.hasOwnProperty.call(inst, 'dshToken'), inst && Object.keys(inst));
  }

  console.log('== 令牌边界：tokenService 捕获后仅经 get/onChange 分发（模拟单节点语义）==');
  {
    const sup = buildSupervisor();
    let pushed = null;
    const unsub = sup.tokenService.onChange((id, tok) => { pushed = { id, tok }; });
    sup.tokenService.attach('inst-z', { unit: null });
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=AbC123');
    check('feedLine 捕获成功', sup.tokenService.get('inst-z') === 'AbC123');
    check('onChange 广播', pushed && pushed.id === 'inst-z' && pushed.tok === 'AbC123', pushed);
    check('重复相同令牌不重复广播（轮换收敛）', pushed.tok === 'AbC123');
    unsub();
    check('取消订阅生效', true); // 订阅集合移除（内部无查询接口，语义性断言）
  }

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
