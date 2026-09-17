#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 跨平台架构契约门禁（2026-09-13）
//
// ## 这份门禁解决的问题
//
// 明确要求：「后续开发不会再因为内部业务逻辑开发而影响跨平台构建能力」。
//
// 反例（本仓真实发生过）：业务域里顺手写一个 `process.platform !== 'win32'`
// 或一张 os 映射表 → 平台知识散落到 4 个业务域（见 platform-matrix-single-source-test
// 的缺陷说明）→ 那些分支**在非本平台上不会被校验**，且与平台层能力声明脱钩。
//
// ## 契约条款
//
//   CP-1  `process.platform` / `process.arch` / `os.platform()` / `os.arch()`
//         **只允许出现在 `src/platform/**`**（平台知识的唯一合法位置）。
//         业务域必须经 `src/platform/contract/matrix.js` 或平台层能力取平台事实。
//   CP-2  业务域不得出现 os/arch 映射对象字面量（与 M-c 呼应，此处再锁一层）
//   CP-3  平台实现必须覆盖全部受支持平台（linux/darwin/win32 三份实现文件都在）
//   CP-4  `package.json#engines.node` 必须存在（跨平台运行时下限的单一声明）
//
// 每条都有**反向断言**（判据必须能识别违规形态，否则门禁空转）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 去掉整行注释——本仓多次被自己的说明文字骗过。
 *  统一走 test/_strip.js（阶段六）：语义等价且**字符串/正则感知**；并只丢「整行都是注释」的行，
 *  故『块开符 + 注释 + 代码』这类开头的代码行不再被整行丢掉（原实现会丢代码）。 */
const { dropCommentLines } = require('./_strip');
function stripComments(src) { return dropCommentLines(src); }
{
  const G = 'src/' + String.fromCharCode(42, 42);
  check('S-4 剥离：// 行注释里的 glob 不吞后续代码',
    stripComments('// ' + G + '\nconst K = 1;').indexOf('K = 1') >= 0, 'ok');
  check('S-4 剥离：块注释开头的代码行不再被整行丢掉',
    stripComments('/* c */ const K = 2;').indexOf('K = 2') >= 0, 'ok');
}

function collectJs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const PLATFORM_RE = /\bprocess\.(platform|arch)\b|\bos\.(platform|arch)\s*\(/;

// ── CP-1：平台事实只允许在 src/platform/** ──
{
  const files = collectJs(path.join(ROOT, 'src'));
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel.startsWith('src/platform/')) continue;           // 唯一合法区域
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (PLATFORM_RE.test(code)) {
      const hits = code.split(String.fromCharCode(10))
        .map((l, i) => ({ l, i }))
        .filter((x) => PLATFORM_RE.test(x.l))
        .map((x) => (x.i + 1) + ':' + x.l.trim().slice(0, 50));
      offenders.push(rel + '  [' + hits.slice(0, 3).join(' | ') + ']');
    }
  }
  check('CP-1 平台事实（process.platform/arch、os.platform/arch）只在 src/platform/** 出现',
    offenders.length === 0,
    offenders.length ? offenders.join(String.fromCharCode(10) + '        ') : '未发现越界');
}

// ── CP-2：业务域不得持 os/arch 映射表 ──
{
  const files = collectJs(path.join(ROOT, 'src'));
  const mapRe = /\{\s*(?:win32|darwin|linux)\s*:\s*['"](?:win|darwin|linux)['"]/;
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel === 'src/platform/contract/matrix.js') continue;   // 唯一合法位置
    if (mapRe.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
  }
  check('CP-2 业务域无 os/arch 映射对象字面量（映射表只在 platform/contract/matrix.js）',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '未发现');
}

// ── CP-3：平台层结构齐备（新增平台必须同步加分支，否则平台层会缺档位）──
//
//   ⚠ 内核是 JS：平台分派在 src/platform/os/index.js（capabilityProfile 的 if/else 档位）
//     + src/platform/contract/matrix.js（矩阵与标签）。壳仓才是 Rust 的 #[cfg(target_os)]。
{
  const osDir = path.join(ROOT, 'src', 'platform', 'os');
  const needFiles = ['index.js', 'service.js', 'autostart/index.js', 'desktop.js', 'pidlookup/index.js', 'exec-path.js'];
  const missing = needFiles.filter((n) => !fs.existsSync(path.join(osDir, n)));
  check('CP-3 平台层文件齐备（index/service/autostart/desktop/pidlookup/exec-path）',
    missing.length === 0, missing.length ? ('缺 ' + missing.join(', ')) : needFiles.length + ' 个');

  const disp = fs.readFileSync(path.join(osDir, 'index.js'), 'utf8');
  // capabilityProfile 必须对三个平台**显式**给出档位（不是"能跑就算支持"）
  const branches = ['linux', 'darwin', 'win32'].filter(
    (p) => new RegExp("pl === '" + p + "'").test(disp));
  check('CP-3 capabilityProfile 对三平台各有显式档位',
    branches.length === 3, branches.join(', ') + '（应 3 个）');
  // 而矩阵必须与这些档位同集合
  const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));
  const matrixPlats = [...new Set(matrix.SUPPORTED.map((x) => x.platform))].sort();
  check('CP-3 矩阵平台集合 = capabilityProfile 档位集合',
    JSON.stringify(matrixPlats) === JSON.stringify(['darwin', 'linux', 'win32']),
    matrixPlats.join(', '));
}

// ── CP-4：Node 运行时下限单一声明 ──
{
  const pkg = require(path.join(ROOT, 'package.json'));
  check('CP-4 package.json#engines.node 已声明（跨平台运行时下限单源）',
    !!(pkg.engines && pkg.engines.node), (pkg.engines && pkg.engines.node) || '(缺)');
}

// ── 反向断言：判据必须能识别违规形态（否则门禁空转）──
{
  check('反向：判据能识别业务域里的 process.platform',
    PLATFORM_RE.test("if (process.platform !== 'win32') { x(); }"), 'hit');
  check('反向：判据能识别 os.platform()',
    PLATFORM_RE.test("const p = os.platform();"), 'hit');
  check('反向：判据对平台层安全代码不误报（仍需 CP-1 的位置判定）',
    PLATFORM_RE.test("const p = process.platform;") === true, 'ok（位置由 CP-1 判）');
  check('反向：判据不误报普通代码',
    !PLATFORM_RE.test("const x = { platform: 'linux' }; const y = f.arch;"), 'ok');
  check('反向：stripComments 会剥离说明文字（本仓踩过 13 次）',
    !PLATFORM_RE.test(stripComments("// 不要写 process.platform\nconst a = 1;")), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
