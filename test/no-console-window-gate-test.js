#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 无控制台窗口门禁（内核侧）—— SSOT: NO-CONSOLE-WINDOW-STANDARD §4
//
// ## 背景（真机取证）
//   壳启动内核时弹出终端窗口。内核 platform/util/exec.js 的**同步** execFileSync
//   已设 windowsHide:true（门禁 G9-d），但**异步 spawn 无统一封装**：
//   SSOT §1 记录 src 下 14 处裸 spawn、其中 13 处缺 windowsHide。
//
// ## 断言（SSOT §4）
//   K-W1 src/platform/os/spawn.js 的 detached / piped / detachedIgnored
//        三入口的 options 均含 windowsHide: true（不变量 W-1）。
//   K-W2 src/** 下裸 spawn( 调用点 = 0（只允许经统一封装；spawn.js 自身豁免）。
//   K-W3 反向：判据必须能识别旧形态（无 windowsHide 的裸 spawn）→ 门禁非空转。
//
// 说明：本文件只**读**源码做静态分析，不执行被测代码。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const SPAWN_MODULE = 'src/platform/os/spawn.js';
const ENTRY_FNS = ['detached', 'piped', 'detachedIgnored'];
const HIDE_RE = /windowsHide\s*:\s*true/;
const BT = String.fromCharCode(96); // 反引号

/** 剥离注释（行注释 + 块注释），保留换行以维持行号；字符串字面量原样保留。 */
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（空格占位，保长度/行号）。
const { blankComments } = require('./_strip');
function stripComments(src) { return blankComments(src); }

/** 收集 src/ 下全部 .js 文件（排除 node_modules/.git）。 */
function jsFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(ROOT, 'src'));
  return out;
}

/** K-W2 / K-W3 共用判据：逐行找裸 spawn( 调用点。
 *  · 跳过含 child_process 的行（require / 解构导入本身不是调用点）；
 *  · \bspawn\( 不会命中 respawn( 或 spawnSync(。 */
function bareSpawnCallSites(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bspawn\s*\(/.test(line)) continue;
    if (/child_process/.test(line)) continue;
    hits.push({ line: i + 1, text: line.trim() });
  }
  return hits;
}

/** K-W2：扫描 src/**，返回全部裸 spawn( 调用点（spawn.js 自身豁免）。 */
function scanBareSpawns() {
  const offenders = [];
  for (const f of jsFiles()) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === SPAWN_MODULE) continue; // 统一封装自身允许调用底层 spawn
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    for (const h of bareSpawnCallSites(code)) offenders.push(rel + ':' + h.line + '  ' + h.text);
  }
  return offenders;
}

/** 提取函数体（从 name 之后第一个 { 起做括号配对）。找不到返回 null。 */
function functionBody(src, name) {
  const re = new RegExp('\\b' + name + '\\b');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

/** 一条声明的文本段（到匹配的右括号或顶层分号为止）。 */
function declSegment(src, idx) {
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth <= 0) return src.slice(idx, i + 1);
    } else if (c === ';' && depth === 0) {
      return src.slice(idx, i + 1);
    }
  }
  return src.slice(idx);
}

/** 同文件内「携带 windowsHide: true」的常量/工厂名 —— 允许入口经共享 opts 间接设置。 */
function hiddenCarriers(src) {
  const names = [];
  const re = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const seg = declSegment(src, m.index);
    if (seg && HIDE_RE.test(seg)) names.push(m[1]);
  }
  return names;
}

// ── K-W1：spawn.js 三入口均隐藏控制台 ──
console.log('== K-W1 spawn.js 三入口 windowsHide ==');
{
  const abs = path.join(ROOT, SPAWN_MODULE);
  if (!fs.existsSync(abs)) {
    check('K-W1 ' + SPAWN_MODULE + ' 存在且三入口含 windowsHide: true', false,
      SPAWN_MODULE + ' 不存在（SSOT §3 统一封装尚未落地）');
  } else {
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    const carriers = hiddenCarriers(src);
    for (const fn of ENTRY_FNS) {
      const body = functionBody(src, fn);
      let ok = false;
      let how = '';
      if (body) {
        if (HIDE_RE.test(body)) { ok = true; how = 'literal'; }
        else {
          for (const c of carriers) {
            if (c === fn) continue;
            if (new RegExp('\\b' + c + '\\b').test(body)) { ok = true; how = 'via ' + c; break; }
          }
        }
      }
      check('K-W1 ' + fn + '() 的 options 含 windowsHide: true', ok,
        body ? (ok ? how : '函数体内未见 windowsHide: true') : '未找到 ' + fn + ' 函数体');
    }
  }
}

// ── K-W2：src 下裸 spawn 计数 = 0 ──
console.log('== K-W2 src 下裸 spawn( 调用点 ==');
{
  const offenders = scanBareSpawns();
  check('K-W2 src/** 裸 spawn( 调用点 = 0', offenders.length === 0,
    offenders.length ? (offenders.length + ' 处: ' + offenders.slice(0, 5).join(' | ')) : 'ok');
}

// ── K-W3：反向 —— 判据必须能识别旧形态 ──
console.log('== K-W3 反向（门禁非空转）==');
{
  const legacy = [
    "const { spawn } = require('node:child_process');",
    "function launch() {",
    "  const child = spawn(process.execPath, ['x'], { detached: true, stdio: 'ignore' });",
    "  return child;",
    "}",
  ].join('\n');
  const hits = bareSpawnCallSites(legacy);
  check('K-W3 判据把无 windowsHide 的裸 spawn 判为违规', hits.length === 1,
    hits.length ? ('命中 1 处（line ' + hits[0].line + '）') : '❌ 未命中（门禁空转）');
  check('K-W3 判据不把 child_process 导入行当调用点',
    !hits.some((h) => /child_process/.test(h.text)), 'ok');
  // 正向：经统一封装的调用点（spawnMod.detached 形态）不应被误报
  const wrapped = "const child = spawnMod.detached(cmd, args, { env });";
  check('K-W3 判据不误报经封装的调用', bareSpawnCallSites(wrapped).length === 0, 'ok');
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
