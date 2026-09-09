#!/usr/bin/env node
'use strict';

// 平台能力档位纯函数测试：capabilityProfile(platform, arch) 对三平台 + 未知平台的静态判定。
// 独立脚本：node test/capability-profile-test.js（纯映射断言，不触碰真实工具/系统）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { capabilityProfile } = require(path.join(ROOT, 'src', 'platform', 'os'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const cases = [
  ['linux', 'x64', 'systemd', true, true],
  ['darwin', 'arm64', 'launchd', false, true],
  ['win32', 'x64', 'windows-service', false, true],
  ['freebsd', 'x64', 'none', false, false],
];
for (const [pl, ar, host, multi, pid] of cases) {
  const r = capabilityProfile(pl, ar);
  check(pl + '/' + ar + ' hostService=' + host, r.hostService === host && r.multiInstance === multi && r.pidAdoption === pid, JSON.stringify(r));
  check(pl + ' platform/arch 透传', r.platform === pl && r.arch === ar, '');
}

const failed = results.filter((x) => !x);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);