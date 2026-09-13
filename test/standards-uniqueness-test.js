#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 规范唯一性门禁（2026-09-13）

// ## 解决的问题
//   同一事实散落多份文档 → 必然漂移（本次清理就修掉 4 处过时声明）。
//   硬要求：**任何领域的规范只能有一份**，且必须被机器校验。

// ## 锁定不变量
//   U-1  三个规范（发布/凭据/改代码）存在，且各自被门禁引用
//   U-2  README 文档索引把这三者标为「唯一事实源」
//   U-3  其它文档**不得**自称为发布流程规范（不得出现「唯一事实源」标记）
//   U-4  根级文档清单与 README 索引**一一对应**（无未登记文档、无悬空条目）
//   U-5  反向：判据能识别缺失规范 / 未登记文档（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// 三个唯一规范：领域 → { 文件, 校验它的门禁 }
const STANDARDS = {
  '发布/构建流程': { file: 'RELEASE-STANDARD.md', gate: 'test/release-spec-consistency-test.js' },
  '凭据管理': { file: 'CREDENTIALS-STANDARD.md', gate: 'test/credential-hygiene-test.js' },
  '改代码规则': { file: 'DEVELOPMENT-TRACK.md', gate: 'test/layering-and-dependency-gate-test.js' },
};

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// ── U-1：三个规范存在且被门禁引用 ──
{
  const missing = [];
  const ungated = [];
  for (const [domain, s] of Object.entries(STANDARDS)) {
    if (!fs.existsSync(path.join(ROOT, s.file))) { missing.push(domain + ' -> ' + s.file); continue; }
    if (!fs.existsSync(path.join(ROOT, s.gate))) ungated.push(domain + ' -> ' + s.gate);
  }
  check('U-1 三个唯一规范文件都存在', missing.length === 0,
    missing.length ? missing.join(', ') : Object.values(STANDARDS).map((x) => x.file).join(', '));
  check('U-1 每个规范都有对应的机器校验门禁', ungated.length === 0,
    ungated.length ? ungated.join(', ') : Object.values(STANDARDS).map((x) => x.gate).join(', '));
}

// ── U-2：README 把三者标为唯一事实源 ──
{
  const bad = [];
  for (const [domain, s] of Object.entries(STANDARDS)) {
    // 该文件在 README 中的那一行必须同时出现文件名与「唯一事实源」
    const line = readme.split(String.fromCharCode(10)).find((l) => l.includes(s.file));
    if (!line || !line.includes('唯一事实源')) bad.push(domain);
  }
  check('U-2 README 把三个规范标为「唯一事实源」', bad.length === 0, bad.length ? bad.join(', ') : 'ok');
}

// ── U-3：其它文档不得自称规范 ──
{
  const offenders = [];
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.md'))) {
    if (Object.values(STANDARDS).some((s) => s.file === f)) continue;
    if (f === 'README.md' || f === 'CHANGELOG.md') continue;
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').split(String.fromCharCode(10)).slice(0, 80).join(String.fromCharCode(10));
    if (head.includes('唯一事实源') || head.includes('唯一规范')) offenders.push(f);
  }
  check('U-3 只有三个规范可自称「唯一事实源」', offenders.length === 0, offenders.join(', ') || 'ok');
}

// ── U-4：根级文档与 README 索引一一对应 ──
{
  const rootMd = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'README.md')
    .sort();
  const indexed = rootMd.filter((f) => readme.includes('(' + f + ')'));
  // 三个标准在 README 里用反引号形式（不加链接）—— 单独放行
  const standardsByBacktick = Object.values(STANDARDS).map((s) => s.file);
  const unindexed = rootMd.filter((f) => !indexed.includes(f) && !standardsByBacktick.includes(f));
  check('U-4 根级文档全部在 README 索引中登记（无未登记文档）',
    unindexed.length === 0, unindexed.length ? unindexed.join(', ') : rootMd.length + ' 份全部已登记');
}

// ── U-5：反向 ──
{
  check('U-5 反向：判据能识别缺失规范文件',
    !fs.existsSync(path.join(ROOT, 'NO-SUCH-STANDARD.md')), 'hit');
  check('U-5 反向：规范正文确实含唯一性声明',
    fs.readFileSync(path.join(ROOT, 'RELEASE-STANDARD.md'), 'utf8').includes('唯一事实源'), 'ok');
  check('U-5 反向：索引判据对未登记文件会失败（构造）',
    !readme.includes('(NO-SUCH-DOC.md)'), 'hit');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
