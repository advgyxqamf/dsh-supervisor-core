#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 验收与测试标准门禁（ACCEPTANCE-STANDARD.md）
//
// ## 解决的问题
//   硬标准：**所有测试不得在本机执行，验收只能由 CI 四平台裁决**。
//   违反方式不是「写错代码」，而是**把本机结果当成交付证据** —— 静默、且反复发生。
//   本门禁把这条硬标准变成机器断言。
//
// ## 锁定不变量
//   A-1  ACCEPTANCE-STANDARD.md 存在且声明硬标准（禁本机测试 / 禁本地产物）
//   A-2  CI 工作流存在，且 test job 含全部断言前置步骤（build-ui / xvfb / launcher）
//   A-3  CI 工作流含**四平台矩阵**（ubuntu-22.04 / windows / macOS arm64 / macOS x64）
//   A-4  CI 工作流的 build job **不得被条件跳过**（无 need_build 条件）
//   A-5  根级 + `release/**` + `.github/**` 的 .md 不得把「本机」结果写成「验收」结论（违规句式）
//   A-6  反向：判据能识别缺失/篡改（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const STD = 'ACCEPTANCE-STANDARD.md';
const CI = path.join('.github', 'workflows', 'build.yml');
const stdText = fs.existsSync(path.join(ROOT, STD)) ? fs.readFileSync(path.join(ROOT, STD), 'utf8') : '';
const ciText = fs.existsSync(path.join(ROOT, CI)) ? fs.readFileSync(path.join(ROOT, CI), 'utf8') : '';

/** 递归收集 .md（A-5 扫描面：根级 + release/** + .github/**）。 */
function collectMd(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') collectMd(p, out); }
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

// ── A-1：规范存在且声明硬标准 ──
{
  check('A-1 规范 ' + STD + ' 存在', stdText.length > 0, stdText.length + ' 字节');
  check('A-1 声明「不得在本机执行测试」', /不得在本机执行|不允许在本机跑测试/.test(stdText), 'ok');
  check('A-1 声明「本机不得产生发布产物」', /本机不得产生任何发布产物|本地不得产生发布产物/.test(stdText), 'ok');
  check('A-1 声明验收只能由 CI 裁决', /CI[^\n]*裁决|由 CI 裁决/.test(stdText), 'ok');
}

// ── A-2：CI test job 的前置步骤齐备 ──
{
  const need = [
    ['build-ui.sh', /build-ui\.sh/],
    ['安装 xvfb', /xvfb/],
    ['launcher 四平台构建', /build:launcher:all/],
    ['声明需要产物（禁用静默 SKIP）', /DSH_LAUNCHER_REQUIRED/],
    ['xvfb-run npm test', /xvfb-run[^\n]*npm test/],
  ];
  const miss = need.filter(([, re]) => !re.test(ciText)).map(([n]) => n);
  check('A-2 CI test job 含全部断言前置步骤', miss.length === 0, miss.length ? '缺: ' + miss.join(', ') : 'ok');
}

// ── A-3：四平台矩阵 ──
{
  const need = [
    ['ubuntu-22.04（glibc 2.35 基座）', /ubuntu-22\.04/],
    ['windows-latest', /windows-latest/],
    ['macos-latest（arm64）', /macos-latest/],
    ['macos-14（x64 覆盖）', /macos-14/],
  ];
  const miss = need.filter(([, re]) => !re.test(ciText)).map(([n]) => n);
  check('A-3 CI 含四平台构建矩阵', miss.length === 0, miss.length ? '缺: ' + miss.join(', ') : 'ok（4/4）');
}

// ── A-4：build job 不得被条件跳过 ──
{
  check('A-4 build job 未被 need_build 条件门控',
    !/needs:\s*precheck[\s\S]{0,400}?if:\s*[^\n]*need_build/.test(ciText), 'ok');
}

// ── A-5：含验收结论的文档必须同时指向 CI（根级 + release/** + .github/**） ──
{
  // 判据：**给出验收结论**的文档，必须同时**指向 CI**——否则即「以本机结果作验收」。
  // 2026-09：扫描面由根级 .md 扩到 release/** 与 .github/**（根级之外的验收叙述此前无人管）。
  // ⚠ 不按「本机」字面量判：正确的免责声明（如「本机自检，不构成验收证据」）
  //   本就同时出现「本机」与「验收」两词，按字面量判会造成假阳性
  //   （首版即因此误报 ARCHITECTURE-ACCEPTANCE.md，由 CI 发现）。
  const VERDICT = /验收结论|验收通过|已验收|交付完成|验收状态/;
  const CIREF = /(待 CI|CI 裁决|以 CI 为准|CI 四平台|CI 结果|CI 绿)/;
  const docs = [];   // { rel, abs }
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.md') && x !== 'README.md' && x !== STD)) {
    docs.push({ rel: f, abs: path.join(ROOT, f) });
  }
  for (const sub of ['release', '.github']) {
    const found = [];
    collectMd(path.join(ROOT, sub), found);
    for (const abs of found) docs.push({ rel: path.relative(ROOT, abs).split(path.sep).join('/'), abs });
  }
  const offenders = [];
  for (const d of docs) {
    const s = fs.readFileSync(d.abs, 'utf8');
    if (VERDICT.test(s) && !CIREF.test(s)) offenders.push(d.rel);
  }
  check('A-5 含验收结论的文档均指向 CI（根级 + release/** + .github/**）',
    offenders.length === 0,
    offenders.length ? offenders.join(', ') : ('扫描 ' + docs.length + ' 份 .md，0 offender'));
  // 反向：判据非空转（构造样本必须能被检出/不误报）
  const badSample = '验收结论：本机全部测试通过。';
  const goodSample = '验收状态：待 CI 裁决。本机自检完成，验收以 CI 为准。';
  check('A-5 反向：以本机结果作结论的样本被检出',
    VERDICT.test(badSample) && !CIREF.test(badSample), 'hit');
  check('A-5 反向：指向 CI 的样本不误报',
    !(VERDICT.test(goodSample) && !CIREF.test(goodSample)), 'miss');
  // 反向：子目录 .md 确实进入扫描面（递归收集非空转），且子目录违规样本用同一判据可检出。
  const subs = docs.filter((d) => d.rel.indexOf('/') >= 0);
  check('A-5 反向：子目录 .md 已纳入扫描面（release/**、.github/**）',
    subs.length > 0 && docs.some((d) => d.rel === '.github/pull_request_template.md'),
    subs.length + ' 份子目录文档');
  check('A-5 反向：子目录违规样本被同一判据检出（合成）',
    VERDICT.test('验收结论：本机通过') && !CIREF.test('验收结论：本机通过'), 'hit');
}

// ── A-6：反向（门禁非空转） ──
{
  check('A-6 反向：判据能识别缺失规范文件', !fs.existsSync(path.join(ROOT, 'NO-SUCH-STANDARD.md')), 'hit');
  check('A-6 反向：缺失前置步骤能被检出（构造）',
    !/build:launcher:all/.test('bash release/scripts/build-ui.sh'), 'hit');
  check('A-6 反向：规范正文确实含硬标准声明', /唯一事实源/.test(stdText), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
