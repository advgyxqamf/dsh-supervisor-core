#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 版本语义**共享测试向量**回归（2026-09-11）
//
// 背景：壳（Rust）与内核（JS）各自实现版本校验/比较，**实测 3 处分歧** ——
//   `1.0.0+`、`1.0.0+!!!`、`1.0.0+あ` 壳判合法、内核判非法
//   （壳旧实现在验证前 split('+') 丢弃 build 段）。
//
// 跨语言无法共享代码，故共享**行为规格**：本仓 `shared/version-vectors.json`。
// 内核只对本仓向量断言自己的实现；壳仓持有自己的一份并在其测试里对本实现断言。
// 两仓**不互相读源码** —— 跨仓一致性属契约产物问题（见 RELEASE-STANDARD.md §0）。
//
// 本测试：
//   V1 逐条断言内核实现（VERSION_RE / semverCompare）符合向量；
//   V2 向量文件自身 schema/结构自洽（**不含跨仓读**）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
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

// ── V2 向量文件自身自洽（只读本仓；不含跨仓读）──
console.log('== V2 向量文件自洽 ==');
{
  check('V2 向量文件结构完整', Array.isArray(doc.versionValidation) && Array.isArray(doc.compare));
  check('V2 schema 为正整数且已声明', Number.isInteger(doc.schema) && doc.schema >= 1, 'schema=' + doc.schema);
  check('V2 文件声明了跨仓共享语义（note 非空）', typeof doc.note === 'string' && doc.note.length > 0);
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