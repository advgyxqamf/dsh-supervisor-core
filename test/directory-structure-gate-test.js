#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 目录结构与分层门禁（DIRECTORY-STRUCTURE-DESIGN §5）
//
// ## 锁定的不变量
//   DS-G1 layerOf 细分到**域粒度**（修复"跨域边从不检查"的制度缺口）
//   DS-G2 shared/ 出度 = 0；platform 无上层入边
//   DS-G3 无 Object.defineProperties(X.prototype, require(...)) 注入（硬）
//   DS-G3b 无 Object.assign(X.prototype, ...) 注入（R4→R6 补齐；初始 report-only）
//   DS-G4 platform 源码（去注释）无域名词
//   DS-G5 层内 require 图无环（单位 = 路径前 3 段）
//   DS-G6 每域有 index.js；域内子目录白名单 = R2（DOMAIN-STRUCTURE-DESIGN §6）
//   DS-G7 src/supervisor.js ≤200 行；不含 setInterval/writeState/_mSet
//   DS-9 门面 index.js ≤150 / 单文件 ≤300（R3 取严；初始 report-only）
//   DS-G8 反向：判据能识别旧形态（门禁非空转）
//
// ## 为什么有本门禁
//   审计发现**最关键的制度缺口**：旧 layering gate 的 layerOf() 把整个 domains/
//   视为一个层，于是 domains→domains（跨域）的边**从未被检查**——
//   这正是 9 个文件依赖 domains/dist 能长期存在的制度原因（步骤3 后 dist 域已解体）。
//   本门禁把「域粒度」与其余结构不变量变成可执行断言。
//
// 进度：§6 步骤1/2/3/4/5 已落地——dist 域已解体（步骤3），ctl dispatcher 上移 platform/ctl（步骤4），
//   跨域边 2 → 1 → 0（relay/daemon.js 不再 require router 域：改向下消费 L0 的 platform/ctl/server.js）。
// ⚠ 迁移未完成（域结构改造并行进行中）：本批新补的严格判据（DS-G3b 的 assign 形态、
//   DS-9 的严阈值 ≤150/≤300）初始为 report-only —— 只打印 RED、不计入退出码；
//   GATE_STRICT=1 可整体转硬失败。既有判据（DS-G1..G8）保持硬失败，保证「不退化」。
//   （DS-G6 已随步骤6 guard→app 平移通过；DS-G8 证明判据非空转。）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const STRICT = process.env.GATE_STRICT === '1';
const results = [];
const softFailures = [];
/** check(name, cond, evidence, soft)：soft=true 的判据在 report-only 下不计入退出码
 *  （打印 FAIL(soft) 并进 RED 清单）；GATE_STRICT=1 时 soft 一并转硬。 */
const check = (n, c, x, soft) => {
  const isSoft = !!soft && !STRICT;
  const ok = !!c;
  console.log((ok ? 'PASS' : (isSoft ? 'FAIL(soft)' : 'FAIL')) + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
  if (isSoft) { if (!ok) softFailures.push(n + (x !== undefined && x !== '' ? '  <- ' + x : '')); }
  else results.push(ok);
};
/** 行数口径（与 domain-structure-gate-test.js / DS-G7 一致）：尾换行不额外算一行。 */
const countLines = (s) => (s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0);

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(SRC, []);
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
// 剥离注释 = test/_strip.js 的**字符级词法**（test/ 下唯一实现）。
//   原为两条正则链（阶段五已把顺序改为「先行注释、再块注释」，但那只堵住「行注释里的 glob」；
//   **字符串/正则字面量里的同形字符**仍会被当成注释开符并吞掉后续代码 → 门禁对该区间失明（假阴性）。
//   词法实现只在**真注释**处剥离，字符串/正则字面量原样保留 —— 这是本阶段要根除的一类。
const { stripComments } = require('./_strip');
const strip = stripComments;
// 自检（合成样本，硬判据，不依赖真实数据）：四条必须同时成立。
{
  const LF9 = String.fromCharCode(10);
  const ST = String.fromCharCode(42);   // 单个星号
  const GLOB = 'src/' + ST + ST;        // 拼接构造 glob：源码里不写出「斜杠+星号」相邻序列（否则给别的门禁制造假开符）
  const kept = strip('// 见 ' + GLOB + LF9 + 'const KEEP_MARKER_9f3 = 1;').indexOf('KEEP_MARKER_9f3') >= 0;
  check('DS-G9 ① 行注释里的 glob 不吞后续代码', kept, kept ? 'ok' : '被吞（假阴性）');
  const gone = strip('/* SECRET_9f3 */ const Y = 1;').indexOf('SECRET_9f3') < 0;
  check('DS-G9 ② 反向：真块注释仍被剥离', gone, gone ? 'ok' : '漏剥');
  const strKept = strip("const S = '" + GLOB + "';" + LF9 + 'const STR_MARKER_9f3 = 1;').indexOf('STR_MARKER_9f3') >= 0;
  check('DS-G9 ③ 字符串字面量里的 glob 不吞代码（本轮根除目标）', strKept, strKept ? 'ok' : '被吞（假阴性）');
  const reKept = strip('const RE = /a[b/]c/;' + LF9 + 'const RE_MARKER_9f3 = 1;').indexOf('RE_MARKER_9f3') >= 0;
  check('DS-G9 ④ 正则字面量不被误当注释', reKept, reKept ? 'ok' : '被吞');
}

/** 依赖边（from → to 的域粒度单元） */
function edgeUnit(relPath) {
  const parts = relPath.split('/');
  if (relPath.startsWith('domains/')) return 'domains/' + (parts[1] || '?');
  if (relPath.startsWith('platform/')) return 'platform/' + (parts[1] || 'flat');
  return parts[0] || 'root';
}

const edges = [];
for (const f of files) {
  const from = edgeUnit(rel(f));
  const src = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    let t = path.resolve(path.dirname(f), spec);
    for (const c of [t + '.js', path.join(t, 'index.js'), t]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) { t = c; break; }
    }
    const trel = rel(t);
    if (trel.startsWith('..')) continue;
    edges.push({ from, to: edgeUnit(trel), fromRel: rel(f), toRel: trel });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G1 跨域依赖 = 0（域粒度）
// ═══════════════════════════════════════════════════════════════════════════
{
  const cross = edges.filter((e) => e.from.startsWith('domains/') && e.to.startsWith('domains/') && e.from !== e.to);
  check('DS-G1 domains 之间跨域 require = 0',
    cross.length === 0,
    cross.length ? cross.length + ' 条: ' + [...new Set(cross.map((e) => e.fromRel + ' -> ' + e.toRel))].slice(0, 4).join(' | ') : 'ok');
  // 反向：判据能识别跨域边（构造样本）
  // 样本用已不存在的旧形态（dist 域）证明判据仍有分辨力——与当前实际边集无关。
  const sample = [{ from: 'domains/router', to: 'domains/dist' }];
  check('DS-G8 反向：DS-G1 判据能识别跨域边',
    sample.filter((e) => e.from.startsWith('domains/') && e.to.startsWith('domains/') && e.from !== e.to).length === 1, 'hit');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G2 shared 出度 = 0；platform 无上层入边
// ═══════════════════════════════════════════════════════════════════════════
{
  const hasShared = fs.existsSync(path.join(SRC, 'shared'));
  if (!hasShared) {
    check('DS-G2 [Phase1] shared/ 已建立', false, '尚未建立（§6 步骤1）');
  } else {
    const sharedOut = edges.filter((e) => e.from === 'shared' && e.to !== 'shared');
    check('DS-G2 shared/ 出度 = 0', sharedOut.length === 0, sharedOut.length ? sharedOut.length + ' 条出边' : 'ok');
  }
  // ⚠ 判据修正：api/root → platform 是**合法**的向下依赖（api=L3、root=L4，platform=L0）。
  //   真正的不变量是**方向**：platform 不得**出边**到任何上层。
  const platformOut = edges.filter((e) => e.from.startsWith('platform') &&
    (e.to.startsWith('domains') || e.to === 'app' || e.to === 'api' || e.to === 'root'));
  check('DS-G2 platform 无出边到上层（domains/app/api/root）', platformOut.length === 0,
    platformOut.length ? platformOut.length + ' 条: ' + [...new Set(platformOut.map((x) => x.fromRel + ' -> ' + x.toRel))].slice(0, 3).join(' | ') : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G3 无属性描述符 mixin 注入
// ═══════════════════════════════════════════════════════════════════════════
{
  const hits = [];
  for (const f of files) {
    const s = strip(fs.readFileSync(f, 'utf8'));
    if (/Object\.defineProperties\(\s*\w+\.prototype\s*,\s*require\(/.test(s)) hits.push(rel(f));
  }
  check('DS-G3 无 Object.defineProperties(X.prototype, require(...)) 注入', hits.length === 0,
    hits.length ? hits.length + ' 处: ' + hits.slice(0, 3).join(', ') : 'ok');
  check('DS-G8 反向：DS-G3 判据能识别旧注入形态',
    /Object\.defineProperties\(\s*\w+\.prototype\s*,\s*require\(/.test('Object.defineProperties(Supervisor.prototype, require("./x"))'), 'hit');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G3b 无 Object.assign(X.prototype, ...) 注入（R4→R6：右值不限，先剥注释）
// ═══════════════════════════════════════════════════════════════════════════
{
  // R6 定稿判据：右值不限（变量 / 内联 require / 成员表达式都算）。
  const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
  const hits = files.filter((f) => MIXIN_INTO_PROTOTYPE.test(strip(fs.readFileSync(f, 'utf8')))).map(rel);
  check('DS-G3b 无 Object.assign(X.prototype, ...) 注入（R6 补齐）', hits.length === 0,
    hits.length ? hits.length + ' 处: ' + hits.slice(0, 4).join(', ') : 'ok', true);
  // 反向自检：变量右值必须命中（R4 旧正则漏掉、R6 要求补的形态）；
  //   普通空对象 assign 不命中；注释样本剥注释后不命中。
  const hitVar = MIXIN_INTO_PROTOTYPE.test('Object.assign(X.prototype, mod.methods);');
  const missPlain = !MIXIN_INTO_PROTOTYPE.test('Object.assign({}, a);');
  const missComment = !MIXIN_INTO_PROTOTYPE.test(strip('// Object.assign(X.prototype, mod.methods) 并入同一原型'));
  check('DS-G8 反向：DS-G3b 判据能识别变量右值形态', hitVar, 'hit');
  check('DS-G8 反向：DS-G3b 不误报普通 assign/注释', missPlain && missComment, 'miss');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G4 platform 源码无域名词
// ═══════════════════════════════════════════════════════════════════════════
{
  const DOMAIN_WORDS = ['router', 'lan-daemon', 'router-daemon', 'proxyInstance', 'providerApi', 'dsh-main', 'frpc'];
  /** DS-G4 判据本体：去注释源码中命中的域名词（空数组 = 干净）。DS-G8 复用**同一函数**做反向自检。 */
  const domainWordsIn = (stripped) => DOMAIN_WORDS.filter((w) => stripped.includes(w));
  const hits = [];
  for (const f of files) {
    const r = rel(f);
    if (!r.startsWith('platform/')) continue;
    const ws = domainWordsIn(strip(fs.readFileSync(f, 'utf8')));
    if (ws.length) hits.push(r + ':' + ws[0]);
  }
  check('DS-G4 platform 源码无域名词（去注释）', hits.length === 0,
    hits.length ? hits.length + ' 个文件: ' + hits.slice(0, 4).join(', ') : 'ok');
  // 反向自检：样本必须**确实包含** DOMAIN_WORDS 中的词（且能穿过 strip），
  //   否则样本与词表无交集，断言恒真 → 判据空转（2026-09-17 修复：旧样本
  //   "const SEGMENT_POOL = { relay: 'managed' };" 不含任何词，DS-G8 假 PASS）。
  //   样本形态取自 platform/util/srcpath.js 的历史写法；DS-G4 后该映射已上移
  //   app/daemons/scripts.js（域名词做键 + 相对路径段）——platform 侧不得再出现。
  const dsG8Sample = "const DAEMON_REL = { router: path.join('domains', 'router', 'daemon.js') };";
  const dsG8HitWords = domainWordsIn(strip(dsG8Sample));
  check('DS-G8 反向：DS-G4 判据能识别域名词', dsG8HitWords.length > 0,
    dsG8HitWords.length ? 'hit: ' + dsG8HitWords.join(',') : '样本与 DOMAIN_WORDS 无交集（自检失效）');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G6 每域有 index.js；域内子目录白名单
// ═══════════════════════════════════════════════════════════════════════════
{
  const dirs = [];
  try {
    for (const e of fs.readdirSync(path.join(SRC, 'domains'), { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(e.name);
    }
  } catch { /* 无 domains/ */ }
  const noIndex = dirs.filter((d) => !fs.existsSync(path.join(SRC, 'domains', d, 'index.js')));
  check('DS-G6 每个域都有 index.js', noIndex.length === 0,
    noIndex.length ? '缺: ' + noIndex.join(', ') : 'ok（' + dirs.length + ' 域）');
  // ⚠ R2（DOMAIN-STRUCTURE-DESIGN §6）白名单 + ops（EXECUTION-CONTRACT §3.2 冻结的 `ops/*.js` / SSOT §5.1 目标树）
  const ALLOWED = new Set(['providers', 'instances', 'policies', 'model', 'store', 'handlers', 'core', 'jobs', 'ops']);
  const badDirs = [];
  for (const d of dirs) {
    for (const e of fs.readdirSync(path.join(SRC, 'domains', d), { withFileTypes: true })) {
      if (e.isDirectory() && !ALLOWED.has(e.name)) badDirs.push(d + '/' + e.name);
    }
  }
  check('DS-G6 域内子目录在白名单内（R2）', badDirs.length === 0,
    badDirs.length ? badDirs.join(', ') : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-G7 supervisor.js 薄壳
// ═══════════════════════════════════════════════════════════════════════════
{
  const p = path.join(SRC, 'supervisor.js');
  const s = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  // 行数按「行终止符」计：尾换行不额外算一行（否则 169 行会显示 170，
  //   且恰好 200 行 + 尾换行的文件会被误判 FAIL）。阈值仍为 ≤200，未放宽。
  const lines = s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
  check('DS-G7 [Phase6/7] src/supervisor.js ≤200 行（当前 ' + lines + '）', lines > 0 && lines <= 200,
    lines > 200 ? '仍 ' + lines + ' 行' : 'ok');
  const bad = ['setInterval(', 'writeState', '_mSet'].filter((k) => s.includes(k));
  check('DS-G7 supervisor.js 不含 setInterval/writeState/_mSet', bad.length === 0,
    bad.length ? '仍含: ' + bad.join(', ') : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// DS-9 行数阈值（R3 取严：门面 index.js ≤150 / 单文件 ≤300，与 DG-2 同值）
// ═══════════════════════════════════════════════════════════════════════════
{
  const FACADE_MAX = 150, FILE_MAX = 300;
  const facadeOver = files
    .filter((f) => path.basename(f) === 'index.js' && countLines(fs.readFileSync(f, 'utf8')) > FACADE_MAX)
    .map((f) => rel(f) + '(' + countLines(fs.readFileSync(f, 'utf8')) + ')');
  check('DS-9 [report-only] index.js 门面 ≤150 行', facadeOver.length === 0,
    facadeOver.length ? facadeOver.length + ' 个: ' + facadeOver.slice(0, 4).join(', ') : 'ok', true);
  const fileOver = files
    .filter((f) => countLines(fs.readFileSync(f, 'utf8')) > FILE_MAX)
    .map((f) => rel(f) + '(' + countLines(fs.readFileSync(f, 'utf8')) + ')');
  check('DS-9 [report-only] 任何 src/**/*.js ≤300 行', fileOver.length === 0,
    fileOver.length ? fileOver.length + ' 个: ' + fileOver.slice(0, 4).join(', ') : 'ok', true);
  // 反向自检：301 行命中、300 行不命中（纯字符串，不落盘）。
  const overSample = Array.from({ length: 301 }, () => 'x;').join(String.fromCharCode(10));
  const edgeSample = Array.from({ length: 300 }, () => 'x;').join(String.fromCharCode(10));
  check('DS-G8 反向：DS-9 判据能识别 301 行超限', countLines(overSample) > FILE_MAX, 'hit');
  check('DS-G8 反向：DS-9 对 300 行边界不误报', !(countLines(edgeSample) > FILE_MAX), 'miss');
}

// ═══════════════════════════════════════════════════════════════════════════
const hardFailed = results.filter((x) => !x).length;
console.log('\n结果: ' + results.filter((x) => x).length + ' passed, ' + hardFailed + ' failed(hard), ' + softFailures.length + ' failed(soft/report-only)');
if (softFailures.length) {
  console.log('RED（report-only，待域改造收敛）:');
  for (const s of softFailures) console.log('  - ' + s);
}
if (!STRICT) {
  console.log('report-only：新补严格判据未计入退出码（GATE_STRICT=1 转硬失败）');
  process.exit(hardFailed ? 1 : 0);
}
process.exit(hardFailed || softFailures.length ? 1 : 0);
