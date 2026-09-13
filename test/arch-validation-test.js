#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P2：架构判定必须**白名单 + 未支持即报**，不得静默当 x64
//
// ## 缺陷
//
// `domains/dist/index.js::_platformTag()` 原实现：
//     const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
//   即**非 arm64 一律当 x64** —— ppc64le / s390x / ia32 会按 x64 取产物：
//   轻则 404，重则**下载到架构不符的包**（比明确报错更糟）。
//
// 壳侧 `platform/linux.rs::node_artifact()` 同病（非 aarch64 即 x64），
// 而同一仓的 `core.rs::package_name()` 对同一事实是**显式 match + Err** ——
// 两处两种态度，正是「同一事实多处实现」的典型。
//
// ## 锁定不变量
//   A-a  已知架构映射正确（x64 / arm64）
//   A-b  未知架构**必须失败**（抛错/None），不得回落到 x64
//   A-c  平台判定同理（未知 OS 不回落 linux）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'), 'utf8');

// ── A-b/A-c：静态断言「不得有静默回落」──
check('A-b 不再有「非 arm64 即 x64」的静默回落',
  !/process\.arch === 'arm64' \? 'arm64' : 'x64'/.test(src),
  '已移除');
check('A-c 平台判定也不得静默回落 linux',
  !/process\.platform === 'darwin' \? 'darwin' : \(process\.platform === 'win32' \? 'win' : 'linux'\)/.test(src),
  '已移除');
check('A-b 存在白名单映射表 archMap', /archMap\s*=\s*\{/.test(src), '有');
check('A-b 未知架构会抛错', /不支持的平台组合/.test(src), '有');

// ── A-a：行为级 —— 用注入的平台/架构直接验证映射 ──
// 注：_platformTag 读 process.platform/arch（全局），故用子进程改这两个全局再断言。
const { execFileSync } = require('node:child_process');
function tag(platform, arch) {
  // 2026-09-13 修复（P1）：必须对插值做 JS 字符串转义（用 JSON.stringify）。
  //   缺陷：原实现把 path.join(...) 的结果直接拼进单引号字面量 ——
  //     Windows 路径是反斜杠（D:\a\dsh-supervisor-core\...），
  //     拼进 JS 源码后 \a、\d、\s 等成了无效转义（被吃掉），路径损坏 →
  //     require 抛 MODULE_NOT_FOUND → 子进程非 0 退出 → 本文件 6 条断言在 Windows 上全红：
  //       FAIL A-a linux/x64 → linux-x64  <- EXECFAIL:Command failed: ...node.exe -e ...
  //   （Linux/macOS 路径是正斜杠，恰好无此问题 —— 典型的「只在 Windows 暴露」。）
  //   JSON.stringify 产出的是已正确转义的双引号字符串，四平台一致。
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    "Object.defineProperty(process, 'arch', { value: " + JSON.stringify(arch) + " });",
    "const { DistributionManager } = require(" + JSON.stringify(path.join(ROOT, 'src', 'domains', 'dist', 'index.js')) + ");",
    "const d = Object.create(DistributionManager.prototype);",
    "try { process.stdout.write(d._platformTag()); } catch (e) { process.stdout.write('ERR:' + e.message); }",
  ].join(String.fromCharCode(10));
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) { return 'EXECFAIL:' + e.message; }
}

check('A-a linux/x64 → linux-x64', tag('linux', 'x64') === 'linux-x64', tag('linux', 'x64'));
check('A-a linux/arm64 → linux-arm64', tag('linux', 'arm64') === 'linux-arm64', tag('linux', 'arm64'));
check('A-a darwin/arm64 → darwin-arm64', tag('darwin', 'arm64') === 'darwin-arm64', tag('darwin', 'arm64'));
check('A-a win32/x64 → win-x64', tag('win32', 'x64') === 'win-x64', tag('win32', 'x64'));

// ── A-b 行为级：未知架构必须报错，而不是回落到 x64 ──
{
  const r = tag('linux', 'ppc64');
  check('A-b linux/ppc64 → 抛错（不得回落 x64）', r.startsWith('ERR:'), r);
  check('A-b 错误信息含平台组合', /ppc64/.test(r), r.slice(0, 60));
}
check('A-b 未知 OS（freebsd）→ 抛错', tag('freebsd', 'x64').startsWith('ERR:'), tag('freebsd', 'x64'));

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);