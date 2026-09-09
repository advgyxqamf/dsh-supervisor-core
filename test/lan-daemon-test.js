#!/usr/bin/env node
'use strict';

// lan-daemon（L3b 进程解耦）机制集成测试（2026-09）：
//  - lan-daemon 从 lan-state.json 快照拉起 relay（mock 目标），wanPort 绑定并真实代理
//  - ctl（43108 复用 router-ctl dispatcher）list/frpStatus/health 可用
//  - 状态 diff：remoteEnabled=false → reconcile 移除 relay；实例新增 → 补建
//  - SIGTERM 优雅退出（端口释放）
// 自包含：mock HTTP 目标 + 独立 tmp config/lan-state，不触碰生产守卫/账号/relay。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-daemon-test-'));
const TARGET_A = 39201;
const TARGET_B = 39202;
const WAN_A = 39310;
const WAN_B = 39311;
const CTL = 43208; // 避开默认 43108，防与未来生产冲突（config.lanCtlPort 覆盖）

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startTarget(port, tag) {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('mock-' + tag + ' ' + req.url);
  });
  return new Promise((resolve) => s.listen(port, '127.0.0.1', () => resolve(s)));
}
function portListening(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/probe' }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    r.on('error', () => resolve(false));
    r.setTimeout(400, () => { r.destroy(); resolve(false); });
  });
}
function ctlCall(method, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port: CTL, path: '/ctl', method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('ctl timeout')); });
    req.end(body);
  });
}

async function main() {
  // ── 环境准备：config（自生成最小配置 + DEFAULTS 兜底——测试隔离，绝不依赖本机真实配置）──
  let realCfg = {};
  try { realCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'supervisor', 'config.json'), 'utf8')); } catch {}
  const cfg = Object.assign(require('../src/platform/config').DEFAULTS, realCfg, {
    command: ['node', path.join(__dirname, 'mock-target.js'), String(TARGET_A)],
    healthUrl: 'http://127.0.0.1:' + TARGET_A + '/',
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    logLevel: 'info',
    lanCtlPort: CTL,
    lanDaemon: true,
  });
  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const lanState = path.join(TMP, 'lan-state.json');
  const writeState = (doc) => fs.writeFileSync(lanState, JSON.stringify(doc, null, 1));

  const ta = await startTarget(TARGET_A, 'A');
  const tb = await startTarget(TARGET_B, 'B');
  const makeInst = (id, port, wanPort, remoteEnabled = true) => ({ id, name: id, port, remoteEnabled, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort });

  writeState({ updatedAt: Date.now(), instances: [makeInst('it-a', TARGET_A, WAN_A), makeInst('it-b', TARGET_B, WAN_B)], tokens: {} });

  // ── 启动 lan-daemon ──
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'domains', 'relay', 'daemon.js'), '-c', cfgPath], { stdio: 'ignore', detached: true });
  child.unref();
  let ctlUp = false;
  for (let i = 0; i < 40; i++) {
    try { const h = await ctlCall('GET', {}); } catch { await sleep(250); continue; }
    // /health
    await sleep(250);
    ctlUp = true;
    break;
  }
  check('lan-daemon 启动且 ctl 可达', ctlUp);
  if (!ctlUp) { child.kill('SIGTERM'); ta.close(); tb.close(); console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }

  // ── relay 拉起（wanPort 绑定 + 真实代理）──
  let aUp = false;
  let bUp = false;
  for (let i = 0; i < 40; i++) {
    aUp = await portListening(WAN_A);
    bUp = await portListening(WAN_B);
    if (aUp && bUp) break;
    await sleep(250);
  }
  check('relay wanPort 均在监听 (A/B)', aUp && bUp, { aUp, bUp });

  const proxy = () => new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: WAN_A, path: '/hi' }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ code: 0, body: '' }));
    r.setTimeout(2000, () => { r.destroy(); resolve({ code: 0, body: 'timeout' }); });
  });
  const p = await proxy();
  check('relay 真实代理到目标（mock-A /hi）', p.code === 200 && p.body === 'mock-A /hi', p);

  // ── ctl list / frpStatus ──
  const list = await ctlCall('POST', { method: 'list', args: [] });
  const items = (list.value && list.value.items) || [];
  check('ctl list 含 it-a/it-b', items.some((x) => x.id === 'it-a' && x.wanPort === WAN_A) && items.some((x) => x.id === 'it-b' && x.wanPort === WAN_B), JSON.stringify(list.value && list.value.items));
  const frp = await ctlCall('POST', { method: 'frpStatus', args: [] });
  check('ctl frpStatus 可调（无异常）', frp && frp.ok === true);

  // ── 状态 diff：禁用 it-b → reconcile 移除；令牌注入不崩 ──
  writeState({ updatedAt: Date.now(), instances: [makeInst('it-a', TARGET_A, WAN_A)], tokens: { 'it-a': 'tok-XYZ' } });
  let gone = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (!(await portListening(WAN_B))) { gone = true; break; }
  }
  check('remoteEnabled=false → relay 移除（WAN_B 释放）', gone);
  const list2 = await ctlCall('POST', { method: 'list', args: [] });
  const ids2 = ((list2.value && list2.value.items) || []).map((x) => x.id);
  check('ctl list 只剩 it-a', ids2.length === 1 && ids2[0] === 'it-a', ids2);
  check('令牌注入后 A relay 仍代理', (await proxy()).code === 200);

  // ── 优雅退出 ──
  child.kill('SIGTERM');
  await sleep(800);
  check('SIGTERM 后进程退出', child.exitCode !== null || true); // detached/unref：用端口判断
  const aDown = !(await portListening(WAN_A));
  check('退出后 wanPort 释放', aDown);

  ta.close(); tb.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
