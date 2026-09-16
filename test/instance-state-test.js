#!/usr/bin/env node
'use strict';

// 沙箱实例状态机纯转移测试（state-machine.js 的 setRunning/restart/fail/setStopped）：
// 覆盖 restartCount 稳定窗归零（2026-09 修复）与 20 次上限 FAILED 语义。
// ⚠ 域改造后状态转移已是**纯函数**（deps 显式入参）→ 本测试只 require 叶子模块 + 假依赖，
//   不构造整个域对象、不触碰 systemd/npm/真实进程（DF-6 可独立单测）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const sm = require(path.join(ROOT, 'src', 'domains', 'instance', 'state-machine'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
let saves = 0;
const deps = {
  events: { append() {} },
  logger: { info() {}, warn() {}, error() {} },
  save() { saves++; },
  tokens: null,
};
function makeInst() {
  return { id: 't1', name: '测试', domain: 'sandbox', state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null } };
}
const now = Date.now();

// 1. restart 累计 + 退避
const i1 = makeInst();
sm.restart(deps, i1, '启动失败');
check('restart: 进入 BACKOFF', i1.state.phase === 'BACKOFF' && i1.state.restartCount === 1, JSON.stringify(i1.state));
check('restart: backoffUntil 已设（>=5s）', typeof i1.state.backoffUntil === 'number' && i1.state.backoffUntil >= now + 5000, String(i1.state.backoffUntil));

// 2. 稳定运行后 restartCount 归零（5min 窗）
const i2 = makeInst();
i2.state.restartCount = 3; i2.state.backoffLevel = 2; i2.state.lastFailAt = now - 6 * 60 * 1000; // 6 分钟前失败
sm.setRunning(deps, i2, { pid: 123 }, now);
check('稳定窗(>5min)后 restartCount 归零', i2.state.restartCount === 0 && i2.state.backoffLevel === 0, JSON.stringify(i2.state));
check('稳定窗后 phase=RUNNING', i2.state.phase === 'RUNNING', i2.state.phase);

// 3. 短期内多次重启不清零（<5min 窗）
const i3 = makeInst();
i3.state.restartCount = 3; i3.state.backoffLevel = 1; i3.state.lastFailAt = now - 60 * 1000;
sm.setRunning(deps, i3, { pid: 456 }, now);
check('未过稳定窗(<5min) restartCount 保留', i3.state.restartCount === 3 && i3.state.backoffLevel === 1, JSON.stringify(i3.state));

// 4. 重试上限（attempts > 20，即第 21 次判定）→ FAILED
const i4 = makeInst();
for (let k = 0; k < 21; k++) sm.restart(deps, i4, '崩溃' + k);
check('超过 20 次后 FAILED', i4.state.phase === 'FAILED' && /重试超限/.test(i4.state.lastError || ''), i4.state.phase + ' ' + i4.state.lastError);
const i4b = makeInst();
for (let k = 0; k < 20; k++) sm.restart(deps, i4b, '崩溃' + k);
check('恰 20 次仍 BACKOFF（未超限）', i4b.state.phase === 'BACKOFF' && i4b.state.restartCount === 20, i4b.state.phase + ' count=' + i4b.state.restartCount);

// 5. fail / setStopped
const i5 = makeInst();
sm.fail(deps, i5, '安装失败');
check('failInstance → FAILED + reason', i5.state.phase === 'FAILED' && i5.state.lastError === '安装失败', JSON.stringify(i5.state));
const i6 = makeInst();
sm.setStopped(deps, i6);
check('setStopped → STOPPED', i6.state.phase === 'STOPPED', i6.state.phase);
check('副作用经 deps.save 显式发出（非隐式 this）', saves > 0, 'saves=' + saves);

const failed = results.filter((x) => !x);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
