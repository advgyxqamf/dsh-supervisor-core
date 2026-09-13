#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 版本语义**共享测试向量**回归（2026-09-11）
//
// 背景：壳（Rust）与内核（JS）各自实现版本校验/比较，**实测 3 处分歧** ——
//   `1.0.0+`、`1.0.0+!!!`、`1.0.0+あ` 壳判合法、内核判非法
//   （壳旧实现在验证前 split('+') 丢弃 build 段）。
//
// 跨语言无法共享代码，故共享**行为规格**：`shared/version-vectors.json`
// （壳仓 `shell-release/` 下有逐字节相同的一份）。
//
// 本测试做两件事：
//   V1 逐条断言内核实现（VERSION_RE / semverCompare）符合向量；
//   V2 断言两仓的向量文件**逐字节相同**（防止只改一侧）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const shellRepoHelper = require('./_shell-repo');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'domains', 'dist', 'index.js'));
// VERSION_RE 与 semverCompare 由 dist 导出（内核侧的**唯一**实现）。
const { VERSION_RE, semverCompare } = dist;

const VEC = path.join(ROOT, 'shared', 'version-vectors.json');
const raw = fs.readFileSync(VEC, 'utf8');
const doc = JSON.parse(raw);

// ── V1 逐条断言 ──
console.log('== V1 版本向量（内核实现）==');
{
  let n = 0;
  for (const c of doc.versionValidation) {
    const got = VERSION_RE.test(c.input);
    check('V1 合法性 ' + JSON.stringify(c.input) + ' → ' + c.valid + (c.why ? '（' + c.why + '）' : ''),
      got === c.valid, 'got=' + got);
    n++;
  }
  for (const c of doc.compare) {
    const got = Math.sign(semverCompare(c.a, c.b));
    check('V1 比较 ' + c.a + ' vs ' + c.b + ' → ' + c.expected + (c.why ? '（' + c.why + '）' : ''),
      got === c.expected, 'got=' + got);
    n++;
  }
  check('V1 向量总数充足', n >= 23, 'n=' + n);
}

// ── V2 两仓向量文件逐字节一致 ──
console.log('== V2 两仓向量文件一致 ==');
{
  const shell = shellRepoHelper.pathIn('shell-release', 'version-vectors.json');
  if (fs.existsSync(shell)) {
    const a = crypto.createHash('sha256').update(fs.readFileSync(VEC)).digest('hex');
    const b = crypto.createHash('sha256').update(fs.readFileSync(shell)).digest('hex');
    check('V2 内核与壳的向量文件逐字节相同（改一侧即失败）', a === b, a.slice(0, 12) + ' vs ' + b.slice(0, 12));
  } else {
    console.log('SKIP V2（壳仓不在同级目录；跨仓断言仅本地可见）');
    // 2026-09-13：CI 会检出壳仓并设 DSH_SHELL_REPO；此时缺失必须**响亮失败**，
    // 不得静默跳过（否则该跨仓契约在产线上永不检查 —— 假门禁）。
    const whyMissing = shellRepoHelper.skipReason('V2');
    if (whyMissing) check('V2 壳仓可用（CI 已指定 DSH_SHELL_REPO，不得静默跳过）', false, whyMissing);
  }
  // 自洽：文件必须可解析且含两个数组
  check('V2 向量文件结构完整', Array.isArray(doc.versionValidation) && Array.isArray(doc.compare));
}

// ── V3 与壳的历史分歧必须已闭合 ──
console.log('== V3 历史分歧闭合 ==');
{
  for (const s of ['1.0.0+', '1.0.0+!!!', '1.0.0+あ']) {
    check('V3 ' + JSON.stringify(s) + ' 两侧均判非法', VERSION_RE.test(s) === false);
  }
  check('V3 合法 build 仍被接受', VERSION_RE.test('1.0.0+build5') === true);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);