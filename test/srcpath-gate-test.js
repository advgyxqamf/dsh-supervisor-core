#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// G10：路径引用必须**可解析**（2026-09-11）
//
// ## 为什么需要这条门禁
//
// §7.6 把 `src/supervisor.js` 拆成 `src/guard/supervisor/*.js` 后，
// **两处**路径推导没有跟着更新：
//
//   control-view.js:216   path.join(__dirname, '..') + 'src/domains/router/daemon.js'
//                         → src/guard/src/domains/router/daemon.js（不存在）
//   registry-view.js:185  path.join(__dirname, 'domains', 'router', 'daemon.js')
//                         → src/guard/supervisor/domains/...（不存在）
//
// 后果是**生产级**的：`_daemonLifecycle()` 的 existsSync 恒为假 → 恒返回 null →
// 守卫永远无法自起 router/lan daemon。而既有测试（daemon-lifecycle-test.js、
// lan-daemon-test.js）都**直接构造 / 自行 spawn**，绕过这条路径 →
// **测试全绿，功能全废**。
//
// 教训：`__dirname` 相对推算是**脆弱的**，且「文件不存在」是**静默**的。
// 本门禁把「静默」变成「会失败」。
//
// ## 三条断言
//   G10-a 受管 daemon 脚本路径必须真实存在（经 app/daemons/scripts 声明 + srcpath 通用解析）
//   G10-b 源码中不得再用 `__dirname` + 'src/...' 的跨层推算
//   G10-c srcpath 的解析结果必须落在本包内（防解析到别处）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const srcpath = require(path.join(ROOT, 'src', 'platform', 'util', 'srcpath.js'));
// ⚠ DS-G4（platform 去域名词）：daemon 脚本**域映射**已从 platform/util/srcpath.js 上移到
//   app/daemons/scripts.js（DIRECTORY-STRUCTURE-DESIGN §4.2 反转法）。srcpath 只留通用 resolve。
const scripts = require(path.join(ROOT, 'src', 'app', 'daemons', 'scripts.js'));

// ── G10-a 受管 daemon 脚本必须存在 ──
console.log('== G10-a 受管 daemon 脚本可解析 ==');
{
  for (const kind of ['router', 'lan']) {
    const p = scripts.daemonScript(kind);
    check('G10-a ' + kind + ' daemon 脚本存在', !!p && fs.existsSync(p), p || '(解析失败 → 守卫将无法自起该 daemon)');
  }
  const d = srcpath.describe();
  check('G10-a src 根已解析', !!d.resolved, d.resolved || '(null)');
}

// ── G10-b 禁止跨层 `__dirname` + 'src/...' 推算 ──
console.log('== G10-b 无脆弱的跨层路径推算 ==');
{
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'src'));

  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel === path.join('src', 'platform', 'util', 'srcpath.js')) continue; // 提供者本身豁免
    const lines = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10));
    lines.forEach((l, i) => {
      // ⚠ 同时接受单/双引号（首版只匹配单引号 → 用双引号写的缺陷会漏过；
      //   这正是「门禁必须验证会失败」的价值：注入原始缺陷后实测未抓到，才发现）。
      if (!/__dirname/.test(l)) return;
      // 危险形态：同一行里 __dirname 与跨层目录名同时出现。
      const mentionsCrossLayer = /['"]src['"]|['"]domains['"]/.test(l);
      if (mentionsCrossLayer) {
        offenders.push(rel + ':' + (i + 1) + ' ' + l.trim().slice(0, 70));
      }
    });
  }
  check('G10-b 无 __dirname 跨层推算 src/ 或 domains/', offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'ok');
}

// ── G10-c 解析结果必须在本包内 ──
console.log('== G10-c 解析结果落在本包内 ==');
{
  const d = srcpath.describe();
  if (d.resolved) {
    const real = fs.realpathSync(d.resolved);
    const pkgReal = fs.realpathSync(ROOT);
    check('G10-c src 根位于本包内', real.startsWith(pkgReal), real);
  } else {
    check('G10-c src 根位于本包内', false, '未解析出 src 根');
  }
  const pr = srcpath.resolvePackageRoot();
  check('G10-c 包根已解析且含 package.json',
    !!pr && fs.existsSync(path.join(pr, 'package.json')), pr || '(null)');
}

// ── G10-d 调用点必须经 app/daemons/scripts（其内部再由 srcpath 通用解析；防改回直接推算）──
console.log('== G10-d 受管 daemon 路径经 app/daemons/scripts 解析 ==');
{
  // ⚠ 2026-09-16 步骤7：daemonScript 调用点（_daemonLifecycle）已从 control-view.js → app/daemons/runtime.js。
  // ⚠ DS-G4：daemonScript 现由 app/daemons/scripts.js 提供（platform 不再固化域映射）；
  //   调用方由「srcpath.daemonScript」改为「scripts.daemonScript」。
  const cv = path.join(ROOT, 'src', 'app', 'daemons', 'runtime.js');
  const rv = path.join(ROOT, 'src', 'app', 'control', 'specs.js');
  const cvSrc = fs.readFileSync(cv, 'utf8');
  const rvSrc = fs.readFileSync(rv, 'utf8');
  // ⚠ DF-8（2026-09-17）：函数体内联 require 已上提为模块顶层 require。判据随之放宽为
  //   「顶层 require 了 scripts 模块 + 调用点经其 daemonScript」——内联与顶层两种形态都接受，
  //   否则门禁会因**合规的**结构改造静默失效。
  const importsScripts = (src, rel) => new RegExp("require\\(\\s*['\"]" + rel.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&') + "['\"]\\s*\\)").test(src);
  check('G10-d runtime 经 app/daemons/scripts 解析 daemon 脚本',
    importsScripts(cvSrc, './scripts') && /daemonScript\(/.test(cvSrc), 'scripts.daemonScript(...)');
  check('G10-d specs 经 app/daemons/scripts 解析 router daemon',
    importsScripts(rvSrc, '../daemons/scripts') && /daemonScript\('router'\)/.test(rvSrc), 'scripts.daemonScript(\'router\')');
  check('G10-d specs 经 app/daemons/scripts 解析 lan daemon',
    importsScripts(rvSrc, '../daemons/scripts') && /daemonScript\('lan'\)/.test(rvSrc), 'scripts.daemonScript(\'lan\')');
  // 反证：不得再出现「__dirname + 目录名」的直接拼接
  for (const [label, src] of [['control-view', cvSrc], ['registry-view', rvSrc]]) {
    const bad = src.split(String.fromCharCode(10)).filter((l) =>
      /__dirname/.test(l) && /['"]src['"]|['"]domains['"]/.test(l) && !/^\s*\/\//.test(l));
    check('G10-d ' + label + ' 无 __dirname 直接拼接', bad.length === 0,
      bad.length ? bad[0].trim().slice(0, 60) : 'ok');
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);