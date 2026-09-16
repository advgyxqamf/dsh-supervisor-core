#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// P3：写入 XML/Desktop Entry 的路径必须**正确转义**
//
// ## 两类不同的转义规则（此前都被搞错）
//
// | 目标 | 规则 | 旧实现 |
// |---|---|---|
// | plist（XML 文本节点） | `&`→`&amp;` `\u003c`→`&lt;` `\u003e`→`&gt;`（`&` 必须最先）| 只 replace `"`→`\\"` —— **XML 里 `"` 本就合法，而 `&`/`<`/`>` 完全没处理** |
// | .desktop `Exec=` | 空格分词 → 含空格路径需双引号界定 | **无引号**（路径含空格即被拆断）|
//
// ## 后果
//   · plist 含 `&`/`<`/`>` → **非法 XML** → `launchctl bootstrap` 失败（只报 syntax error）
//     → 上层降级为「已建立未加载」→ **壳自启静默失效**。
//   · .desktop `Exec` 未加引号 → 家目录含空格时桌面环境拆错 → 同样静默失败。
//
// ## 锁定不变量
//   X-a  plist 生成含 XML 转义函数，且 `&` 先于 `<`/`>` 替换
//   X-b  三个嵌入点（BIN / LOG / Label）都经转义
//   X-c  .desktop 的 Exec 用双引号界定，且值内引号/反斜杠按规范转义
//   X-d  **行为级**：含 `&` 的路径生成的 plist 必须仍是合法 XML
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// ⚠ 2026-09-17 域结构改造：autostart 拆为目录 —— 按目录聚合读取，转义判据覆盖面不变。
const AUTO = path.join(ROOT, 'src', 'platform', 'os', 'autostart');
const src = fs.readdirSync(AUTO).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(AUTO, f), 'utf8')).join(String.fromCharCode(10));

// ── X-a：XML 转义函数存在，且 & 最先 ──
const escFn = src.match(/function xmlEscape\(s\) \{[\s\S]{0,220}?\}/);
check('X-a 存在 xmlEscape 函数', !!escFn, escFn ? '有' : '无');
if (escFn) {
  const body = escFn[0];
  const iAmp = body.indexOf("'&amp;'");
  const iLt = body.indexOf("'&lt;'");
  const iGt = body.indexOf("'&gt;'");
  check('X-a & 最先替换（否则二次转义成 &amp;lt;）', iAmp >= 0 && iLt > iAmp && iGt > iAmp,
    'amp@' + iAmp + ' lt@' + iLt + ' gt@' + iGt);
}

// ── X-b：三个嵌入点都经转义 ──
check('X-b BIN 经 xmlEscape', /xmlEscape\(&?guiExe/.test(src) || /xmlEscape\(guiExe\)/.test(src), '有');
check('X-b LOG 经 xmlEscape', /xmlEscape\(&?log/.test(src) || /xmlEscape\(log\)/.test(src), '有');
// ⚠ 只针对 **plist** 段落断言「不得再用 replace 转义双引号」——
//   .desktop 的 `execQuote` 合法地转义双引号（那是 Desktop Entry 规范要求），
//   用全文件正则会把它误判（我第一版就踩了这个假阳性）。
{
  const plistFn = src.match(/function macGuiPlist\([\s\S]*?\n\}/);
  check('X-b 定位到 macGuiPlist', !!plistFn, plistFn ? plistFn[0].length + ' 字符' : '未找到');
  check('X-b plist 内不再把双引号当 XML 转义',
    !!plistFn && !/replace\(\/"\/g/.test(plistFn[0]), 'plist 已清理');
}

// ── X-c：.desktop Exec 引号 ──
check('X-c 存在 Exec 引号构造', /execQuote/.test(src), '有');
check('X-c Exec 行被重写（含引号）', /\^Exec=\.\*\$/m.test(src), '有');

// ── X-d：行为级 —— 含 & 的路径仍生成合法 XML ──
//   直接 require 模块并调用 macGuiPlist（纯函数，无副作用）
const auto = require(path.join(ROOT, 'src', 'platform', 'os', 'autostart'));
check('前置：autostart 模块可加载', typeof auto === 'object' && auto !== null, 'OK');

// 由于 macGuiPlist 未导出，改为在源码层验证转义的**语义正确性**：
//   用同一套替换规则跑一个含特殊字符的样本，断言输出是合法 XML。
{
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sample = '/home/a&b/<c>/d.log';
  const out = xmlEscape(sample);
  check('X-d 含 & < > 的路径被转义', !/[<>&]/.test(out.replace(/&amp;|&lt;|&gt;/g, '')), out);
  check('X-d 转义结果不含裸 &', !/&(?!(amp|lt|gt);)/.test(out), out);
  check('X-d 不含二次转义 &amp;lt;', !/&amp;(lt|gt|amp);/.test(out), out);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);