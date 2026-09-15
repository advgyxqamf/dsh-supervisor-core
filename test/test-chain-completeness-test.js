#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 门禁清单「完整性」门禁（2026-09-13）
//
// ## 修复的缺陷（失效模式 c：声明了但零调用点 / 门禁存在却不跑）
//
// 内核的 `scripts.test` 是**硬编码的 && 串联名单**（94 条），而 `test/` 下有 104 个文件。
// 实测有三个**真实测试从未进入 CI**：
//   · test/api-contract-test.js         （14 断言，能通过）
//   · test/native-test.js               （10 断言，能通过）
//   · test/plugin-change-restart-test.js（52 断言，能通过）
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
  return s.split(' && ').map((x) => x.replace(/^node (--require \S+ )?/, '').trim());
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

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
