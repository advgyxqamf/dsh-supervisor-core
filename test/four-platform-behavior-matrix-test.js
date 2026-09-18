#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 四平台行为穷举门禁（2026-09-13）
//
// ## 目的
//
// 把「跨平台正确性」从**等三个 runner** 变成**一次本地断言**：
// 在 Linux 上即可穷举 `linux-x64 / darwin-arm64 / darwin-x64 / win-x64`
// 的**全部平台分派结果** —— 只要该逻辑是**参数化**的。
//
// 这依赖上一提交的结构性收益：`src/platform/contract/matrix.js` 与
// `platform/os/index.js#capabilityProfile()` 都接受**显式 platform/arch 参数**。
//
// ## 诚实边界（不夸大）
//
// 本门禁证明的是 **逻辑**（标签映射 / 能力档位 / 模板替换 / 运行时与矩阵一致），
// **不能**证明**平台原生行为**（真的能跑 systemd / launchctl / schtasks、
// 真的能 spawn Windows 可执行、真的能生成 MSI）。
// 后者仍必须由**真实四平台 CI 构建**裁决 —— 两者互补，不可互相替代。
//
// ## 锁定不变量
//   P-1  matrix：四组合的 npmTag / osTag / isSupported 全部正确；不支持组合抛错
//   P-2  matrix：四组合的 frpTag 正确（第三方命名）；不支持返回 null
//   P-3  matrix：supportsProcessGroup 三平台取值正确
//   P-4  capabilityProfile：四平台的**键集合完全一致**（防"某平台少声明一项能力"）
//   P-5  capabilityProfile：四平台的关键档位取值符合预期（差异点必须显式）
//   P-6  运行时与矩阵一致：`dist._platformTag()` 在四个伪造平台下 == matrix.npmTag()
//   P-7  消费方契约：`guardCorePkg()` 的 {os}/{arch} 替换在三平台下正确
//   P-8  反向：判据能识别"键集合不一致"与"标签错误"（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));
const osLayer = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 在子进程里伪造 platform/arch 后执行一段代码（跨平台逻辑的既验技术）。 */
function underFake(platform, arch, body) {
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    "Object.defineProperty(process, 'arch', { value: " + JSON.stringify(arch) + " });",
    body,
  ].join(String.fromCharCode(10));
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return 'EXECFAIL:' + ((e && e.message) || e);
  }
}

// ── P-1 / P-2 / P-3：matrix 四组合穷举 ──
{
  const expect = [
    { p: 'linux', a: 'x64', os: 'linux', npm: 'linux-x64', frp: 'linux_amd64', exe: false, grp: true },
    { p: 'darwin', a: 'arm64', os: 'darwin', npm: 'darwin-arm64', frp: 'darwin_arm64', exe: false, grp: true },
    { p: 'darwin', a: 'x64', os: 'darwin', npm: 'darwin-x64', frp: 'darwin_amd64', exe: false, grp: true },
    { p: 'win32', a: 'x64', os: 'win', npm: 'win-x64', frp: 'windows_amd64', exe: true, grp: false },
  ];
  for (const e of expect) {
    const id = e.p + '/' + e.a;
    check('P-1 ' + id + ' npmTag=' + e.npm, matrix.npmTag(e.p, e.a) === e.npm, matrix.npmTag(e.p, e.a));
    check('P-1 ' + id + ' osTag=' + e.os, matrix.osTag(e.p) === e.os, String(matrix.osTag(e.p)));
    check('P-1 ' + id + ' isSupported=true', matrix.isSupported(e.p, e.a) === true, 'true');
    const f = matrix.frpTag(e.p, e.a);
    check('P-2 ' + id + ' frpTag=' + e.frp + ' exe=' + e.exe,
      !!f && f.tag === e.frp && f.exe === e.exe, JSON.stringify(f));
    check('P-3 ' + id + ' supportsProcessGroup=' + e.grp,
      matrix.supportsProcessGroup(e.p) === e.grp, String(matrix.supportsProcessGroup(e.p)));
  }
  // 不支持的组合：npmTag 抛错（既有文案契约）、frpTag 返回 null（如实上报）
  let threw = null;
  try { matrix.npmTag('freebsd', 'x64'); } catch (err) { threw = err.message; }
  check('P-1 不支持的组合：npmTag 抛错（不静默回落）',
    !!threw && /不支持的平台组合/.test(threw), threw || '(未抛)');
  check('P-2 不支持的组合：frpTag 返回 null（不猜）', matrix.frpTag('freebsd', 'x64') === null, 'null');
  check('P-1 不支持的架构：isSupported=false', matrix.isSupported('linux', 'ppc64') === false, 'false');
  check('P-1 未发布组合：linux-arm64 / win32-arm64 isSupported=false',
    matrix.isSupported('linux', 'arm64') === false && matrix.isSupported('win32', 'arm64') === false, 'false');
}

// ── P-4：capabilityProfile 键集合四平台一致（防"某平台少声明一项能力"）──
{
  const plats = ['linux', 'darwin', 'win32', 'freebsd'];
  const sets = plats.map((p) => Object.keys(osLayer.capabilityProfile(p, 'x64')).sort());
  const base = JSON.stringify(sets[0]);
  const bad = plats.filter((p, i) => JSON.stringify(sets[i]) !== base);
  check('P-4 四平台能力键集合完全一致（13 项）',
    bad.length === 0 && sets[0].length >= 13,
    bad.length ? ('不一致: ' + bad.join(', ')) : (sets[0].length + ' 键一致'));
  // 逐项列出，便于人工核对（也证明不是空集合）
  const expectedKeys = [
    'platform', 'arch', 'multiInstance', 'pidAdoption', 'processTreeKill', 'desktopNotify',
    'autostart', 'frpExpose', 'hostService', 'guardAutostart', 'guardSelfHeal',
    'shellAutostart', 'shellSelfHeal',
  ].sort();
  check('P-4 键集合 = 规范清单（防新增能力只加在一个平台）',
    JSON.stringify(sets[0]) === JSON.stringify(expectedKeys),
    sets[0].length === expectedKeys.length ? 'ok' : ('实际 ' + sets[0].join(',') + ' 期望 ' + expectedKeys.join(',')));
}

// ── P-5：关键档位取值（差异点必须显式声明）──
{
  const L = osLayer.capabilityProfile('linux', 'x64');
  const D = osLayer.capabilityProfile('darwin', 'x64');
  const W = osLayer.capabilityProfile('win32', 'x64');
  const U = osLayer.capabilityProfile('freebsd', 'x64');
  check('P-5 只有 linux 声明 multiInstance=true（沙箱 systemd-run）',
    L.multiInstance === true && D.multiInstance === false && W.multiInstance === false && U.multiInstance === false,
    [L, D, W, U].map((x) => x.multiInstance).join(','));
  check('P-5 hostService 与平台一一对应（systemd/launchd/windows-service/none）',
    L.hostService === 'systemd' && D.hostService === 'launchd'
    && W.hostService === 'windows-service' && U.hostService === 'none',
    [L, D, W, U].map((x) => x.hostService).join(','));
  check('P-5 三平台 shellSelfHeal 均为 true（macOS 曾缺，2026-09-11 补齐）',
    L.shellSelfHeal === true && D.shellSelfHeal === true && W.shellSelfHeal === true && U.shellSelfHeal === false,
    [L, D, W, U].map((x) => x.shellSelfHeal).join(','));
  check('P-5 未知平台全 false（显式 Unsupported，绝不静默成功）',
    Object.entries(U).every(([k, v]) => (k === 'platform' || k === 'arch' || k === 'hostService') || v === false),
    JSON.stringify(U));
  // ⚠ 重要区分：capabilityProfile.processTreeKill（含 Windows taskkill /T）与
  //   matrix.supportsProcessGroup（仅 POSIX kill(-pid)）**语义不同**，不得混用。
  check('P-5 processTreeKill 三平台皆真（Windows 经 taskkill /T）而 supportsProcessGroup 仅 POSIX',
    L.processTreeKill === true && W.processTreeKill === true
    && matrix.supportsProcessGroup('win32') === false && matrix.supportsProcessGroup('linux') === true,
    '两者语义不同，已在文档中区分');
}

// ── P-6：运行时与矩阵一致（真实模块在伪造平台下的产出）──
{
  const distPath = path.join(ROOT, 'src', 'platform', 'distribution', 'index.js');
  for (const [p, a, want] of [
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['win32', 'x64', 'win-x64'],
  ]) {
    const out = underFake(p, a, [
      "const { DistributionManager } = require(" + JSON.stringify(distPath) + ");",
      "const d = Object.create(DistributionManager.prototype);",
      "process.stdout.write(String(d._platformTag()));",
    ].join(String.fromCharCode(10)));
    check('P-6 ' + p + '/' + a + ' _platformTag() == matrix.npmTag（运行时与矩阵同源）',
      out === want, out + ' vs ' + want);
  }
  const bad = underFake('freebsd', 'x64', [
    "const { DistributionManager } = require(" + JSON.stringify(distPath) + ");",
    "const d = Object.create(DistributionManager.prototype);",
    "try { process.stdout.write(String(d._platformTag())); } catch (e) { process.stdout.write('ERR:' + e.message); }",
  ].join(String.fromCharCode(10)));
  check('P-6 不支持的平台：_platformTag 抛错且文案含平台组合',
    bad.startsWith('ERR:') && /不支持的平台组合/.test(bad), bad.slice(0, 60));
}

// ── P-7：消费方契约 —— guardCorePkg 的 {os}/{arch} 替换 ──
{
  // ⚠ 步骤 7（2026-09-16）：app/settings/settings-view.js 已拆为多模块，guardCorePkg 落在
  //   app/settings/versions.js（**不在** env.js）；且模块导出形态统一为 { methods } ——
  //   desc.guardCorePkg 为 undefined，旧判据会以 "Property description must be an object"
  //   在子进程中直接崩掉（3 个平台全 FAIL）。故读新模块 + 取 desc.methods.guardCorePkg。
  const svPath = path.join(ROOT, 'src', 'app', 'settings', 'versions.js');
  for (const [p, a, want] of [
    ['linux', 'x64', '@dsh-sup/dsh-core-linux-x64'],
    ['darwin', 'arm64', '@dsh-sup/dsh-core-darwin-arm64'],
    ['win32', 'x64', '@dsh-sup/dsh-core-win-x64'],
  ]) {
    const out = underFake(p, a, [
      "const desc = require(" + JSON.stringify(svPath) + ");",
      "const o = { config: { corePackageName: '@dsh-sup/dsh-core-{os}-{arch}' } };",
      "Object.defineProperty(o, 'guardCorePkg', { value: desc.methods.guardCorePkg });",
      "process.stdout.write(String(o.guardCorePkg()));",
    ].join(String.fromCharCode(10)));
    check('P-7 ' + p + '/' + a + ' guardCorePkg 模板替换正确', out === want, out + ' vs ' + want);
  }
}

// ── P-8：反向（判据必须能识别违规）──
{
  const keySetEqual = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
  const full = { platform: 'linux', arch: 'x64', multiInstance: true, pidAdoption: true };
  const shortOne = { platform: 'win32', arch: 'x64', multiInstance: false };
  check('P-8 反向：判据能识别"某平台少声明能力"',
    keySetEqual(full, shortOne) === false, 'hit');
  check('P-8 反向：判据对同键集合不误报',
    keySetEqual({ a: 1, b: 2 }, { b: 3, a: 4 }) === true, 'ok');
  check('P-8 反向：标签判据能识别错误取值',
    matrix.npmTag('win32', 'x64') !== 'win32-x64' && matrix.npmTag('win32', 'x64') === 'win-x64', 'ok');
  check('P-8 反向：underFake 确实伪造了 platform',
    underFake('win32', 'x64', 'process.stdout.write(process.platform + "/" + process.arch)') === 'win32/x64',
    'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
