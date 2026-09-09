#!/usr/bin/env node
'use strict';

// frp 平台映射测试：验证 frpPlatformTag 纯函数对三平台 × 双架构的官方产物命名正确性。
// 独立脚本：node test/frp-platform-test.js（不加入 npm test 链，保持卸载类测试政策外的纯映射断言）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { frpPlatformTag, downloadUrls } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frpmgr'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const cases = [
  ['linux', 'x64', 'linux_amd64', false],
  ['linux', 'arm64', 'linux_arm64', false],
  ['darwin', 'x64', 'darwin_amd64', false],
  ['darwin', 'arm64', 'darwin_arm64', false],
  ['win32', 'x64', 'windows_amd64', true],
  ['win32', 'arm64', 'windows_arm64', true],
];
for (const [p, a, wantTag, wantExe] of cases) {
  const r = frpPlatformTag(p, a);
  check(p + '/' + a + ' -> ' + wantTag + (wantExe ? '(.exe)' : ''), !!(r && r.tag === wantTag && r.exe === wantExe), JSON.stringify(r));
}
check('freebsd 拒绝（无官方产物）', frpPlatformTag('freebsd', 'x64') === null, '');
check('ia32 拒绝（产品不支持 32 位）', frpPlatformTag('linux', 'ia32') === null, '');

// downloadUrls：三源镜像（ghfast/gh-proxy/官方直连）URL 主体指向正确平台资产
const urls = downloadUrls('frp_0.61.1_' + frpPlatformTag('linux', 'x64').tag + '.tar.gz');
check('downloadUrls 三源', urls.length === 3, urls.length);
check('URL 含平台资产名', urls.every((u) => u.indexOf('frp_0.61.1_linux_amd64.tar.gz') >= 0), urls.join(' | '));
check('官方直连为第三源', urls[2] === 'https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz', urls[2]);

const failed = results.filter((x) => !x);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);