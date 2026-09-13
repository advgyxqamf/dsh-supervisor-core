#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// shell 脚本可移植性门禁（2026-09-14）

// ## 起源：两个只在 mac/win 暴露、被跳过矩阵长期掩盖的缺陷

//   **①  `$VAR` 紧跟非 ASCII 字符**（如 `$m（应为 600）`）：
//     macOS 自带 **bash 3.2** 会把后续多字节字节并进变量名 →
//     `m: unbound variable` / `STORE: unbound variable` —— 脚本直接报错。
//     修法：写成 `${m}（应为 600）`（花括号显式界定名字）。
//   **②  把文件路径插进 JS 源码字符串**（如 `require('$INDEX')`）：
//     Windows 路径含反斜杠，在 JS 单引号串里是**无效转义**（\U \A 被吃）
//     → require 失败或路径错乱。修法：经 `export` + `process.env.X` 传参。

// ## 为什么需要本门禁
//   上述两类缺陷在 **Linux/macOS 本地**都不报错（本地 bash 5 + 正斜杠路径），
//   只有 mac/win runner 才暴露 —— 而这正是「完整构建必须每次都跑」的原因。
//   本门禁把这两类**静态可判**的问题拉回本地即可拦截。

// ## 锁定不变量
//   S-1  release/scripts/*.sh 中不得有 `$VAR` 紧跟非 ASCII 字符（须 ${VAR}）
//   S-2  release/scripts/*.sh 的 node 片段不得把 shell 变量插进 JS 字符串字面量
//   S-3  反向：判据能识别这两类违规（构造样本）
//   S-4  反向：判据不误报合法写法（${VAR}、process.env.X、非 ASCII 前的普通文本）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'release', 'scripts');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'));

// ── S-1：$VAR 紧跟非 ASCII ──
// 判据：$ 后跟 名称字符，且紧接着是一个非 ASCII 字节（多字节 UTF-8 的首字节 >= 0x80）
const UNSAFE_VAR = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;
{
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(SCRIPTS, f), 'utf8').split(String.fromCharCode(10));
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('#')) return;
      if (UNSAFE_VAR.test(l)) offenders.push(f + ':' + (i + 1) + '  ' + t.slice(0, 60));
    });
  }
  check('S-1 release/scripts/*.sh 无「$VAR 紧跟非 ASCII」（bash 3.2 致命）',
    offenders.length === 0, offenders.length ? offenders.slice(0, 3).join(' | ') : files.length + ' 个脚本均合规');
}

// ── S-2：node 片段里的 JS 字符串插值 shell **路径**变量 ──
// 判据：require('$X') / ='$X' / ('$X' 形态，且变量名**属于路径类**。
//   ⚠ 只查路径类：值/名字类（`$want` / `$name` / `$1`）插进 JS 是安全的 ——
//     它们的取值不含反斜杠；把它们一并拦下属**误报**（首版即如此，会让人绕过门禁）。
const PATHISH = /(?:PATH|INDEX|STORE|DIR|ROOT|FILE|HOME|NPMRC|CRED|SCRIPTS|REPO)/;
const JS_INTERP = /(?:require\(|[=(,]\s*)'\$([A-Za-z_][A-Za-z0-9_]*)/;
{
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    // 只看含 node -e 的文件
    if (!/node -e/.test(src)) continue;
    src.split(String.fromCharCode(10)).forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('#')) return;
      const m = JS_INTERP.exec(l);
      // 仅当被插值的变量名属于**路径类**才算违规（值/名字类安全）
      if (m && PATHISH.test(m[1])) offenders.push(f + ':' + (i + 1) + '  $' + m[1] + '  |  ' + t.slice(0, 50));
    });
  }
  check('S-2 node 片段不把 shell 变量插进 JS 字符串字面量（Windows 反斜杠安全）',
    offenders.length === 0, offenders.length ? offenders.slice(0, 3).join(' | ') : '未发现');
}

// ── S-3 / S-4：反向 ──
{
  check('S-3 反向：判据能识别 $m 紧跟全角括号', UNSAFE_VAR.test('echo "权限 $m' + String.fromCharCode(0xFF08) + '应为 600' + String.fromCharCode(0xFF09) + '"'), 'hit');
  check('S-3 反向：判据能识别 require(\'$INDEX\')', JS_INTERP.test("const j=require('$INDEX');"), 'hit');
  check('S-4 反向：不误报 ${VAR} 形态', !UNSAFE_VAR.test('echo "权限 ${m}' + String.fromCharCode(0xFF08) + '应为 600' + String.fromCharCode(0xFF09) + '"'), 'ok');
  check('S-4 反向：不误报 process.env.X', !JS_INTERP.test('const j=require(process.env.INDEX);'), 'ok');
  check('S-4 反向：不误报 $VAR 后跟 ASCII', !UNSAFE_VAR.test('echo "$f done"; [ -f "$f" ]'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
