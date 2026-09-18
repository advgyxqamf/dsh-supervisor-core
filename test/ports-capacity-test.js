#!/usr/bin/env node
'use strict';

// 动态端口池容量与弹性回归（2026-09 工业标准重构）：
//   1) 大量对象（供应商/实例）可持续分配，远超旧的固定小段上限（如 providerApi 旧 32）；
//   2) 选址避开 OS 动态端口范围（Linux ip_local_port_range 默认 32768-60999）；
//   3) 共享池模型：relay/proxyInstance/oauthCallback 同池不同锚点，互不挤占；
//   4) 池满 → 显式 ErrFull（不再静默 null）；capacity()/available()/isFull() 可观测；
//   5) portPools 可配置覆盖（工业标准：范围是配置项）；
//   6) 保留池拒绝用户实例端口。
// 自包含：独立临时注册表文件 + 大跨度测试池，不触碰生产 ports.json。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-capacity-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { PortRegistry, DEFAULT_POOLS, SEGMENT_POOL } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  // DS-G4 §4.2（反转法）：段名/独立池是**域知识**，platform 不再硬编码 → 测试显式申报
  // （等价于生产由 router/relay 域装配期注入；未申报时未注册段回退通用池 managed）。
  require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments'));
  require(path.join(ROOT, 'src', 'domains', 'relay', 'port-segments'));

  // 1) 选址：默认池必须完全避开 OS 动态端口范围，且在合法端口区间
  console.log('== 1) 池选址（RFC 6335 / 避开 OS ephemeral）==');
  const ephemeral = (() => {
    try {
      const raw = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/);
      const lo = Number(raw[0]), hi = Number(raw[1]);
      return (Number.isInteger(lo) && Number.isInteger(hi)) ? { lo, hi } : null;
    } catch { return null; }
  })();
  check('默认池定义存在且含 managed/providerApi', !!DEFAULT_POOLS.managed && !!DEFAULT_POOLS.providerApi, JSON.stringify(DEFAULT_POOLS));
  const overlaps = (p) => !!ephemeral && !(p.base + p.count - 1 < ephemeral.lo || p.base > ephemeral.hi);
  check('默认池避开 OS 动态端口范围', !Object.values(DEFAULT_POOLS).some(overlaps),
    ephemeral ? ('ephemeral=' + ephemeral.lo + '-' + ephemeral.hi + ' pools=' + JSON.stringify(DEFAULT_POOLS)) : 'no /proc (skip range)');
  check('默认池落在合法端口区间(1024-65535)', Object.values(DEFAULT_POOLS).every((p) => p.base >= 1024 && p.base + p.count - 1 <= 65535));

  // 2) 规模：providerApi 轻松容纳 200+ 供应商（旧实现 32 即满）
  console.log('== 2) 供应商规模弹性（旧固定 32 上限）==');
  const reg = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const N = 200;
  const portsGot = [];
  for (let i = 0; i < N; i++) portsGot.push(await reg.allocate('providerApi', 'providerApi:prov-' + i));
  check('providerApi 连续分配 ' + N + ' 个成功', portsGot.every((p) => Number.isInteger(p) && p > 0), 'got=' + portsGot.filter(Boolean).length);
  check('分配端口互不重复', new Set(portsGot).size === N);
  const cap = reg.capacity();
  check('capacity() 反映真实用量', cap.providerApi.used === N && cap.providerApi.free === cap.providerApi.size - N, JSON.stringify(cap.providerApi));
  check('available()/isFull() 语义正确', reg.available('providerApi') === cap.providerApi.free && reg.isFull('providerApi') === false);

  // 3) 共享池：同池不同锚点，确定性且互不挤占
  console.log('== 3) 共享池（K8s 单一范围思想）==');
  check('relay/proxyInstance/oauthCallback 同池', SEGMENT_POOL.relay === SEGMENT_POOL.proxyInstance && SEGMENT_POOL.proxyInstance === SEGMENT_POOL.oauthCallback);
  const rp = await reg.allocate('relay', 'relay:a');
  const pp = await reg.allocate('proxyInstance', 'proxy:b');
  const op = await reg.allocate('oauthCallback', 'oauth:c');
  check('三段锚点不同（确定性起点）', rp !== pp && pp !== op && rp !== op, JSON.stringify({ rp, pp, op }));
  check('同池分配不互相覆盖（同池共享余量）', [rp, pp, op].every((p) => p >= DEFAULT_POOLS.managed.base && p < DEFAULT_POOLS.managed.base + DEFAULT_POOLS.managed.count));

  // 4) 池满 → 显式错误（绝不静默 null）
  console.log('== 4) 池满显式错误 ==');
  const small = new PortRegistry({ file: path.join(TMP, 'small.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 27000, count: 4 } }) });
  for (let i = 0; i < 4; i++) await small.allocate('providerApi', 's' + i);
  const full = await small.claimSlot('providerApi', 'overflow');
  check('池满 claimSlot 返回显式 conflict/ErrFull', full && full.conflict === true && full.error === 'port-pool-exhausted', JSON.stringify(full));
  check('池满含 capacity（可观测）', full.capacity && full.capacity.free === 0 && full.capacity.used === 4, JSON.stringify(full.capacity));
  check('isFull() 判定为满', small.isFull('providerApi') === true);
  check('allocate 池满返回 null（调用方转显式错误）', (await small.allocate('providerApi', 'overflow2')) === null);

  // 5) 可配置池（工业标准：范围是配置项）
  console.log('== 5) portPools 可配置 ==');
  const custom = new PortRegistry({ file: path.join(TMP, 'custom.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 28000, count: 8 } }) });
  check('configurePools 生效（自定义 base/count）', custom.rangeOf('providerApi').base === 28000 && custom.rangeOf('providerApi').count === 8, JSON.stringify(custom.rangeOf('providerApi')));
  const cp = await custom.allocate('providerApi', 'x');
  check('自定义池内分配正确', cp >= 28000 && cp < 28008, String(cp));

  // 6) 保留池拒绝用户实例端口
  console.log('== 6) 保留池拒用户端口 ==');
  let rejected = false;
  try { reg.registerUser(DEFAULT_POOLS.providerApi.base + 10, 'inst:bad'); } catch { rejected = true; }
  check('providerApi 池内端口被拒为实例端口', rejected);
  // 池外端口（避开所有物理池：providerApi 之上 5000；且避开 OS dynamic）
  const outsidePort = 30000; // 大于 managed(20000-23999) 与 providerApi(24000-25999) 池
  let allowed = true, errMsg = null;
  try { reg.registerUser(outsidePort, 'inst:ok'); } catch (e) { allowed = false; errMsg = e.message; }
  check('池外端口允许为实例端口', allowed, errMsg || ('registered at ' + outsidePort));

  // 7) 回归守卫：relay 的 main 偏好不得硬编码池外端口
  //    背景（2026-09-11，CI 净环境暴露）：relay/manager.js 曾为 main 硬编码 preferred 28120，
  //    而池重构后 relay 段为 20000-23999 → 28120 落在池外，破坏「所有 relay 端口都在池内」的不变量。
  //    本机因 28120 恰被占用而回退到池内、测试侥幸通过；CI 净环境直接失败。
  //    此处做源码级守卫，防止该硬编码回归。
  console.log('== 7) 回归守卫：relay main 偏好不得池外硬编码 ==');
  {
    const mgrSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'ops.js'), 'utf8');
    const codeOnly = mgrSrc
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    check('relay/ops.js 无裸 40000 硬编码（已派生自池 base）', !/\b40000\b/.test(codeOnly), 'ok');
    check('relay/ops.js 的 main 偏好取自 relay 段池', /rangeOf\('relay'\)/.test(codeOnly), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
