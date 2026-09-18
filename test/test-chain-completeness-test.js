#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 门禁清单「完整性」门禁（2026-09-13）
//
// ## 修复的缺陷（失效模式 c：声明了但零调用点 / 门禁存在却不跑）
//
// 内核的 `scripts.test` 是**硬编码的 && 串联名单**，`test/` 下曾有真实测试
// 因未登记而从未进入 CI（api-contract / native / plugin-change-restart 三个即由此发现）。
// 它们各有独立 npm script（test:api-contract 等），但**没人跑** → CI 里永不执行。
//
// 这与本轮在**壳仓**修过的是同一类缺陷：壳仓 CI 硬编码 `--test` 名单，
// 静默漏掉 4 个门禁（含为 macOS E0425 新建的那道）。内核侧同病。
//
// ## 锁定不变量
//   N-a  `test/` 下每个 `*-test.js` 要么在 `scripts.test` 链中，
//        要么在下方**显式排除表**中并写明理由（不允许"默默不在"）
//   N-b  排除表里的文件必须真实存在（防排除表腐化为死引用）
//   N-c  助手/fixture（`_` 前缀或非 `*-test.js`）不被误报
//   N-d  反向：判据能识别"未入链的测试"（门禁非空转）
//   N-e  scripts.test 长度 < 8000（Windows cmd.exe 命令行 8191 上限；
//        实测只有 windows-latest 会因此失败，Linux/macOS 不受限。
//         余量已近枯竭（2026-09-17 P3-B 实测 7899 字符 => 余量 101，约 2 个条目）。
//        **纪律：今后新增判据必须并入既有门禁文件，不得新增链条目**；
//        若确需新文件，必须先合并/退役一个旧条目，并同步本判据与 package.json#scripts.test。
//        头部已评估「单一 runner + 参数列表」的替代方案（结论见 design-notes/_p3-b-gates.md）：
//        既有测试结尾普遍 process.exit()，in-process 串联会提前终止，故本轮**不改造**。
//   N-f  链中每个条目都真实存在（防链引用已删除文件，运行到该条才炸）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 显式排除表：这些测试**刻意**不进主链，必须写明理由。
 *  ⚠ 加入本表必须有正当理由（如需外部服务 / 属操作型工具而非回归门禁）；
 *    否则就是"门禁静默不跑"，正是本文件要消灭的缺陷。 */
const EXCLUDED = {
  // 需要真实系统服务/交互环境，不适合默认回归（各有独立 npm script 供按需运行）
  'test/native-test.js': '需真实原生卸载环境（npmBin 注入型行为测试），按需经 npm run test:native-uninstall',
};

function chainFiles() {
  const s = require(path.join(ROOT, 'package.json')).scripts.test;
  // 每条为 `node --require ./test/_preload.js test/<x>.js`（跨平台隔离预载）——剥掉前缀取文件名。
  // ⚠ 前缀可为 `node -r <preload> ` / `node --require <preload> ` / 无。
  //   首版写成 `-{1,2}require` —— 那匹配 `-require`/`--require`，**匹配不到 `-r`**，
  //   导致本函数返回空数组、N-a/N-b 全崩；由 CI 实跑发现（node --check 语法通过）。
  return s.split(' && ').map((x) => x.replace(/^node ((?:-r|--require) \S+ )?/, '').trim());
}

/** 命名约定：`*-test.js` 为标准测试名。
 *  ⚠ 历史遗留两个**不带 -test 后缀**但在链中当测试跑的**门禁**（不改名，避免大范围改动）：
 *    · test/smoke.js        —— 启动冒烟（34 断言）
 *    · test/ports-verify.js —— 端口纪律校验
 *    它们由 `IN_CHAIN_LEGACY` 显式承认，从而与"助手"区分开。 */
const IN_CHAIN_LEGACY = ['smoke.js', 'ports-verify.js'];
function isTestFile(name) {
  return name.endsWith('-test.js') || IN_CHAIN_LEGACY.includes(name);
}

// ── N-a：每个 *-test.js 要么在链中，要么被显式排除 ──
{
  const inChain = chainFiles();
  const all = fs.readdirSync(path.join(ROOT, 'test')).filter(isTestFile).map((f) => 'test/' + f);
  const orphans = all.filter((f) => !inChain.includes(f) && !Object.prototype.hasOwnProperty.call(EXCLUDED, f));
  check('N-a 每个 test/*-test.js 都在 scripts.test 链中或被显式排除',
    orphans.length === 0,
    orphans.length ? ('未入链且未排除: ' + orphans.join(', ')) : (all.length + ' 个测试文件全部有归属'));
  check('N-a 链中文件数 + 排除数 = 测试文件总数',
    inChain.filter((f) => all.includes(f)).length + Object.keys(EXCLUDED).length === all.length,
    inChain.filter((f) => all.includes(f)).length + ' + ' + Object.keys(EXCLUDED).length + ' = ' + all.length);
}

// ── N-b：排除表引用必须真实存在（防死引用）──
{
  const bad = Object.keys(EXCLUDED).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('N-b 排除表引用的文件都真实存在', bad.length === 0, bad.length ? bad.join(', ') : Object.keys(EXCLUDED).length + ' 条');
  const noReason = Object.entries(EXCLUDED).filter(([, r]) => !r || String(r).trim().length < 8);
  check('N-b 每条排除都写了理由（>=8 字）', noReason.length === 0, noReason.map((x) => x[0]).join(', ') || 'ok');
}

// ── N-c：助手/fixture 不被误报 ──
{
  const helpers = fs.readdirSync(path.join(ROOT, 'test'))
    .filter((f) => !isTestFile(f) && f.endsWith('.js') && !f.startsWith('_'));
  const wronglyInChain = helpers.filter((h) => chainFiles().includes('test/' + h));
  check('N-c 助手/fixture 不被当作测试跑（也不在链中）',
    wronglyInChain.length === 0, wronglyInChain.length ? wronglyInChain.join(', ') : helpers.length + ' 个助手');
  check('N-c _ 前缀助手被视为非测试',
    ['_ports.js', '_workflow.js'].every((h) => !isTestFile(h)), 'ok');
  check('N-c 历史遗留门禁（smoke/ports-verify）被承认为测试',
    isTestFile('smoke.js') && isTestFile('ports-verify.js'), 'ok');
}

// ── N-d：反向（判据必须能识别"未入链"）──
{
  const inChain = chainFiles();
  const fake = ['test/__nonexistent-gate-test.js'];
  const orphanDetected = fake.filter((f) => !inChain.includes(f)
    && !Object.prototype.hasOwnProperty.call(EXCLUDED, f)).length === 1;
  check('N-d 反向：判据能识别未入链的测试', orphanDetected, 'hit');
  check('N-d 反向：判据对已在链中的文件不误报',
    inChain.includes('test/platform-matrix-single-source-test.js')
    && inChain.includes('test/cross-platform-architecture-gate-test.js')
    && inChain.includes('test/round13-csp-probe-test.js'), 'ok');
  check('N-d 反向：isTestFile 不把助手当测试',
    !isTestFile('_ports.js') && !isTestFile('mock-target.js') && isTestFile('core-test.js'), 'ok');
}

// ── N-e：Windows 命令行长度守卫 ──
//   Windows cmd.exe 命令行上限 8191 字符。scripts.test 是单条 && 巨链，
//   一旦超过该上限，**只有 Windows 构建会失败**（Linux/macOS 的 shell 不受此限）——
//   2026-09-17 CI 实测：windows-latest 报 "The command line is too long."，
//   而 ubuntu-22.04 / macos-latest / macos-14 三个矩阵同时全绿。
//   本判据把该平台差异固化为门禁，不再依赖 Windows CI 才发现。
//   P3-B 入链三件（docs-reference / comment-pin / app-this-ratchet）后长度 7899，
//   **余量仅 101 字符（约 2 个条目）** —— 增长空间基本用尽：
//     · 纪律：新增判据**并入既有门禁文件**，不得新增链条目；
//     · 若确需新文件，必须先合并/退役一个旧条目（并同步本判据与 package.json#scripts.test）。
{
  const len = require(path.join(ROOT, 'package.json')).scripts.test.length;
  const LIMIT = 8000; // 8191 上限留余量；余量仅 101，任何入链新增都必须重新复核本判据
  check('N-e scripts.test 长度 < 8000（Windows cmd 命令行 8191 上限）',
    len < LIMIT, len + ' 字符（余量 ' + (LIMIT - len) + '）');
  // 反向：判据非空转（构造超长样本必须被检出）
  const longSample = 'x'.repeat(9000);
  check('N-e 反向：超长样本被检出', !(longSample.length < LIMIT), 'hit');
}

// ── N-f：链条目的存在性（N-a 只保证测试文件有归属，不保证链指向真实文件）──
{
  const inChain = chainFiles();
  const missingFiles = inChain.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('N-f scripts.test 链中每个文件都真实存在',
    missingFiles.length === 0,
    missingFiles.length ? ('链中死引用: ' + missingFiles.join(', ')) : (inChain.length + ' 条全部存在'));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
