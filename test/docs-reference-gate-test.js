#!/usr/bin/env node
'use strict';

// 文档源码引用门禁（docs-reference）—— E1/J6
//
// 解决的问题：SSOT 文档与根级说明会引用 src/... 路径，但此前没有任何门禁读文档正文，
//   重构搬移文件后文档里的路径会静默失效。已发生两例：NO-CONSOLE-WINDOW-STANDARD.md
//   长期指向已重构掉的 src/guard/...；KERNEL-DAEMON-CONTRACT.md 指向已拆成目录的
//   src/platform/os/autostart.js。人工审计只能事后发现，故固化为机器判据。
//
// 锁定不变量
//   DR-1 根级 *.md 中出现的每个 src/... 路径字面量必须真实存在（文件或目录；
//        允许省略 .js 后缀，允许带 :行号）。故意举例"不存在路径"的写法必须先改述，
//        不得把悬空路径留在正文里。
//   DR-2 反向：判据能识别不存在的路径，且不误报存在的文件/目录/带行号形态/glob 形态。
//
// 范围与排除：只扫根级 *.md（design-notes/ 是过程记录，不是 SSOT，不扫）。
//   下列文档记录的是当时（已废弃）的方案与目录，改写反而伪造历史，整份跳过；
//   与其它门禁一致，CHANGELOG.md 属历史记录。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const HISTORICAL = new Set([
  'CHANGELOG.md',
  'ARCHITECTURE-CONTRACT-phase0.md',
  'ARCHITECTURE-PLAN-session-lifecycle.md',
]);

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// src/... 字面量。段字符不含 * ? # : ，故 glob（src/**/*.js）与行号后缀不会被吞进来。
const SRC_REF = /src\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g;

/** 归一化原文命中：剥掉 :行号 与行尾标点；无意义片段返回 null。 */
function normalizeRef(hit) {
  let t = String(hit || '');
  t = t.replace(/(?::\d+)+$/, '');
  t = t.replace(/[#?].*$/, '');
  t = t.replace(/[.,;:)\]}>'"\`。，；：）】]+$/, '');
  t = t.replace(/\/+$/, '');
  if (t.length <= 4) return null;
  return t;
}

/** 路径是否存在：真实文件、真实目录，或补 .js 后的文件。 */
function resolves(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) return true;
  if (!/\.[A-Za-z0-9]+$/.test(rel) && fs.existsSync(abs + '.js')) return true;
  return false;
}

/** 抽取一段文本里的 src/... 引用（去重、保序）。 */
function refsOf(text) {
  const out = new Set();
  for (const hit of (text.match(SRC_REF) || [])) {
    const t = normalizeRef(hit);
    if (t) out.add(t);
  }
  return [...out];
}

// ── DR-1：根级文档引用的 src/... 全部可解析 ──
{
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && !HISTORICAL.has(f));
  const offenders = [];
  let withRefs = 0;
  for (const d of docs) {
    const refs = refsOf(fs.readFileSync(path.join(ROOT, d), 'utf8'));
    if (refs.length) withRefs += 1;
    for (const r of refs) if (!resolves(r)) offenders.push(d + ' -> ' + r);
  }
  check('DR-1 根级文档引用的 src/... 路径都存在', offenders.length === 0,
    offenders.length ? offenders.slice(0, 6).join(' | ')
      : (docs.length + ' 份文档 / ' + withRefs + ' 份含 src 引用，零悬空'));
}

// ── DR-2：反向（判据非空转，且不误报）──
{
  check('DR-2 反向：能识别不存在的路径',
    refsOf('见 src/guard/supervisor/main-process.js:46 的说明').some((r) => !resolves(r)), 'hit');
  check('DR-2 反向：存在的文件/目录/带行号形态不误报',
    refsOf('src/platform/os/autostart/ 与 src/platform/util/exec.js:22').every((r) => resolves(r)), 'miss');
  check('DR-2 反向：glob 形态（src/**/*.js）不产生引用',
    refsOf('任何 src/**/*.js 都不超过 300 行').length === 0, 'ok');
  check('DR-2 反向：历史文档被显式排除',
    HISTORICAL.has('CHANGELOG.md') && HISTORICAL.has('ARCHITECTURE-PLAN-session-lifecycle.md'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
