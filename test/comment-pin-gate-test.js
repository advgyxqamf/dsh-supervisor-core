#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════════
// 注释钉子门禁（comment-pin，P3-B）
//
// ## 解决的问题（本仓已两次因此 CI 转红）
//   测试若把断言**正则**匹配到源码的**注释**文本上，该注释一旦被精简或改写，
//   断言即静默失配 —— 这是「形式钉子」，靠人工 review 覆盖不到 1788 处正则字面量。
//     事故（245585c）：741 处注释符号清除把「所有者 = **桌面壳**」改写成散文，
//       kernel-daemon-contract-test.js 的 D-8 硬正则失配 -> CI 红。
//     同类（f410a3a）：死代码普查按注释里的「仅 read() 内部使用」判定该导出无消费者，
//       删掉 contract/runtime.js 的 file 导出 -> 测试 rc.file is not a function -> CI 红。
//   前者是「断言钉注释」，后者是「注释误导删除」；本门禁固化前者，后者由 R2 纪律覆盖。
//
// ## 锁定的不变量
//   CP-1 内联正则字面量 P 命中目标 src 文件 F 的**原文**、且不命中 F 的**剥注释文本**
//        => P 钉在 F 的注释上 => 违规（实盘判据，默认 report-only）
//   CP-2 反向（合成样本，永远硬失败）：注释命中必被检出；代码/字符串命中必不误报；
//        不具区分度的小模式不参与判定；词法器不因未闭合注释/字符串而崩
//   CP-3 非空转：抽取函数在**给定合成输入**上产出预期，不依赖真实数据总量
//        （DG-12 教训：用真实总量做非空转判据，数据一缩就自锁）
//   CP-4 已登记的真钉子（P2 §7.1 的 5 条）显式豁免；未登记的命中即判据失败
//
// ## 模式与诚实边界
//   · 实盘判据默认 report-only（环境变量 CP_STRICT=1 转硬失败）。理由：「P 在运行时是否
//     真的作用于 F」无法纯静态证明（测试可能引用多个文件而只对其中一个施加 P），
//     故存在跨文件误报的可能；先报告、人工确认后再转硬。**假绿门禁比没有更坏**，
//     故这里不假装它是硬的。
//   · 反向自检**永远硬失败**（本文件自行决定退出码，不依赖 CP_STRICT）。
//   · 覆盖面限于「内联正则字面量 + 具区分度（≥4 汉字 或 ≥6 字符 ASCII）」这一可静态提取子集。
//     已知盲区（不在覆盖面内，见 design-notes/_p3-b-gates.md）：
//       动态构造 new RegExp(A + B)、字符串 includes()/indexOf() 断言注释、
//       以变量中转的正则常量、以及 P 只作用于 F 之一而 F 有二义的多目标场景。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const { scanText } = require('./_strip'); // 单一字符级词法（test/ 下唯一实现）
const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const STRICT = process.env.CP_STRICT === '1';

// 上限：只为约束运行时间；命中截断会打印在情报行里（不静默）。
const MAX_TARGETS = 300;   // 单测试最多检查的目标文件数（src 全域 256，留余量）
const MAX_PATTERNS = 120;  // 单测试最多参与判定的正则数（实测单文件最多 80）
const MAX_PAIRS = 6000;    // 单测试 模式 x 目标 预算（超出则按比例缩减模式集）

const passed = [], failedHard = [], failedSoft = [];
function record(name, ok, evidence, hard) {
  const tag = ok ? 'PASS' : (hard ? 'FAIL' : 'FAIL(soft)');
  console.log(tag + ' ' + name + (evidence ? '  <- ' + evidence : ''));
  if (ok) { passed.push(name); return; }
  if (hard) failedHard.push(name + (evidence ? '  <- ' + evidence : ''));
  else failedSoft.push(name + (evidence ? '  <- ' + evidence : ''));
}
const judge = (n, c, e) => record(n, !!c, e, STRICT);
const selfcheck = (n, c, e) => record(n, !!c, e, true);

// ── 词法地基：走 `test/_strip.js` 的**单一字符级词法**（阶段六统一）──
//   原先此处自持一份 scanText。现统一由 _strip.js 提供，避免 test/ 下并存多份注释剥离实现 ——
//   本仓已三次因「正则剥注释」不准：CP 的 distinctive 阈值滤掉 2/5 登记钉子 / U-1b 的顺序错误 /
//   阶段五 4 道门禁「先块后行」把行注释里的 glob 当块开符而吞掉代码（实测吞 174/80/47/29/17 行）。
//   语义与原实现完全一致：字符串字面量原样保留（故断言命中字符串不算钉注释）；块注释以换行占位
//   保行结构；正则与除号按「前一个有意义字符」启发式区分（标准做法）。

/** 具区分度：≥4 个连续汉字，或 ≥6 字符的 ASCII 标识符。小模式不参与判定（防泛匹配噪音）。
 *  ★ 但**包含任一已登记钉子特征串**的模式必须始终参与判定 —— 否则登记表会静默失覆盖：
 *  实测「不再是 SEA」（SEA 仅 3 字符）与「所有者[^\n]{0,12}桌面壳」（桌面壳仅 3 字）都被
 *  基础阈值滤掉，导致 CP-4 的 5 条登记里有 2 条永不生效（本门禁首版即有此缺陷）。
 *  注意：此处引用 REGISTERED 是安全的 —— distinctive 只在 CP-2 之后被调用，那时常量已初始化。 */
function distinctive(body) {
  return /[\u4e00-\u9fff]{4,}/.test(body) || /[A-Za-z_][A-Za-z0-9_]{5,}/.test(body)
    || REGISTERED.some((p) => String(body).indexOf(p.needle) >= 0);
}
/** 高置信子集的更严阈值（≥6 连续汉字 或 ≥10 字符 ASCII）；配合「单目标测试」用于 CP-5。 */
function strictDistinctive(body) {
  return /[\u4e00-\u9fff]{6,}/.test(body) || /[A-Za-z_][A-Za-z0-9_]{9,}/.test(body);
}

// ── 从测试源码静态提取它引用的 src/ 目标 ──
function extractSrcRefs(testSrc) {
  const refs = new Set();
  for (const m of String(testSrc || '').matchAll(/['"]((?:src\/)[A-Za-z0-9_./-]+)['"]/g)) refs.add(m[1]);
  // path.join(ROOT, 'src', 'a', 'b.js') —— 把引号段拼回相对路径
  for (const m of String(testSrc || '').matchAll(/path\.join\(\s*ROOT\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])/g)) {
    const segs = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (segs[0] === 'src' && segs.length > 1) refs.add(segs.join('/'));
  }
  return [...refs];
}

function relOf(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }
function walkJs(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
}
function expandTargets(refs) {
  const out = [];
  for (const r of refs) {
    const abs = path.join(ROOT, r);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkJs(abs, out);
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

// ── 判据本体（纯函数）：只吃 {rel, raw}，故合成样本与实盘共用同一路径 ──
function commentPins(testName, testSrc, targets) {
  const lit = scanText(testSrc).regexes;
  const pats = [];
  for (const r of lit) {
    if (!distinctive(r.body)) continue;
    try { pats.push({ body: r.body, re: new RegExp(r.body, r.flags.replace(/[gy]/g, '')) }); } catch { /* 非法正则跳过 */ }
  }
  if (!pats.length || !targets || !targets.length) return [];
  const budget = Math.max(1, Math.floor(MAX_PAIRS / targets.length));
  const use = pats.slice(0, Math.min(pats.length, MAX_PATTERNS, budget));
  const found = [];
  for (const t of targets) {
    const stripped = scanText(t.raw).stripped;
    for (const p of use) {
      if (!p.re.test(t.raw)) continue;       // 先便宜拒（原文不中即无涉）
      if (!p.re.test(stripped)) {
        found.push({ test: testName, src: t.rel, pattern: p.body, strict: strictDistinctive(p.body), targets: targets.length });
      }
    }
  }
  // 去重：同一 (测试, 目标文件, 模式) 可能因 refs 重叠被重复展开（如目录与其中单文件同时被引用），
  //   否则同一钉子会被重复计数（首版实测把 win32.js 的 D-8 钉子算了 2 次）。
  const uniq = []; const seen = new Set();
  for (const f of found) { const k = f.test + '|' + f.src + '|' + f.pattern; if (seen.has(k)) continue; seen.add(k); uniq.push(f); }
  return uniq;
}

// ── CP-4：已登记的真钉子（P2 §7.1 五条；命中即豁免，不参与 CP-1）──
const REGISTERED = [
  { src: 'src/platform/service/config.js', needle: '最小兜底', test: 'package-root-test.js' },
  { src: 'src/app/control/entry.js', needle: '静默丢弃', test: 'phase-vocabulary-test.js' },
  { src: 'src/platform/contract/deploy.js', needle: '不再是 SEA', test: 'round8-fixes-test.js' },
  { src: 'src/domains/instance/ops.js', needle: '探测失败不阻断创建', test: 'instance-safety-test.js' },
  { src: 'src/platform/os/autostart/win32.js', needle: '桌面壳', test: 'kernel-daemon-contract-test.js' },
];
function isRegistered(f) { return REGISTERED.some((p) => f.src === p.src && f.pattern.indexOf(p.needle) >= 0); }

// ─ CP-2 / CP-3：合成样本反向自检（永远硬失败）──
console.log('== CP-2/CP-3 合成样本自检（门禁自身完整性）==');
{
  const T = "check('x', /探测失败不阻断创建/.test(code));";
  const at = (rel, raw) => [{ rel, raw }];

  const onlyComment = '// 探测失败不阻断创建：保留既有降级行为\nconst x = 1;';
  const gotHit = commentPins('syn-test.js', T, at('src/syn.js', onlyComment));
  selfcheck('CP-2 反向：注释命中样本被检出', gotHit.length === 1, JSON.stringify(gotHit));

  const inString = "const s = '探测失败不阻断创建';";
  selfcheck('CP-2 反向：字符串字面量命中不误报',
    commentPins('syn-test.js', T, at('src/syn.js', inString)).length === 0, '0');

  selfcheck('CP-2 反向：原文无命中则不计',
    commentPins('syn-test.js', T, at('src/syn.js', 'const z = 3;')).length === 0, '0');

  selfcheck('CP-2 反向：不具区分度的小模式被排除',
    commentPins('syn-test.js', "check('y', /ab/.test(code));", at('src/syn.js', '// ab\nconst a=1;')).length === 0, '0');

  selfcheck('CP-2 反向：词法器容忍未闭合注释与字符串（不抛）',
    (() => { try { scanText('/* 未闭合\nconst a = "未闭合'); return true; } catch { return false; } })(), 'no-throw');

  const two = scanText('const a = /foo/g; const b = x / y; const c = 4 / 2;');
  selfcheck('CP-3 非空转：正则字面量被抽出且除号不被误判为正则',
    two.regexes.length === 1 && two.regexes[0].body === 'foo', JSON.stringify(two.regexes.map((r) => r.body)));

  const st = scanText("const u = 'http://x//y'; /* 所有者 = 桌面壳 */\nconst q = 1;");
  selfcheck('CP-3 非空转：剥注释保留字符串原文、移除块注释',
    st.stripped.indexOf('http://x//y') >= 0 && st.stripped.indexOf('桌面壳') < 0, 'ok');

  const refs = extractSrcRefs("const f = read('src/domains/x/y.js');\nconst g = path.join(ROOT, 'src', 'app', 'control', 'registry.js');");
  selfcheck('CP-3 非空转：src 引用抽取覆盖直接字面量与 path.join 两种形态',
    refs.indexOf('src/domains/x/y.js') >= 0 && refs.indexOf('src/app/control/registry.js') >= 0, JSON.stringify(refs));

  selfcheck('CP-4 豁免：已登记钉子被 isRegistered 过滤',
    isRegistered({ src: 'src/domains/instance/ops.js', pattern: '探测失败不阻断创建' }) === true &&
    isRegistered({ src: 'src/domains/instance/ops.js', pattern: '别的注释' }) === false, 'ok');

  // CP-4 登记表自身完整性（硬自检；只用登记常量，不依赖真实数据）：needle 必须能被
  //   distinctive 放行、src 必须是 src/ 下的 .js —— 否则该条豁免永不命中（登记表装饰化）。
  const regShape = REGISTERED.filter((p) => !distinctive(p.needle) || !/^src\/.+\.js$/.test(p.src));
  selfcheck('CP-4 登记表各条自身可判定（needle 可放行 / src 形态正确）',
    REGISTERED.length >= 1 && regShape.length === 0,
    regShape.length ? ('坏条目: ' + regShape.map((p) => p.test + ' :: ' + p.needle).join(' | ')) : (REGISTERED.length + ' 条'));

  selfcheck('CP-2 反向：空输入不崩、不产出',
    commentPins('syn-test.js', '', []).length === 0 && commentPins('syn-test.js', T, at('src/syn.js', '')).length === 0, 'ok');
}

// ─ CP-1：实盘扫描（默认 report-only；CP_STRICT=1 硬失败）──
console.log('\n== CP-1 实盘扫描 ==');
{
  // 自身排除：本文件含用于自检的正则字面量，自指扫描无意义（显式登记，非静默跳过）
  const SELF = path.basename(__filename);
  const tests = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js')).sort().filter((f) => f !== SELF);
  const rawCache = new Map();
  const raw = (abs) => { if (!rawCache.has(abs)) rawCache.set(abs, fs.readFileSync(abs, 'utf8')); return rawCache.get(abs); };
  const all = [];
  let withRefs = 0, targetsN = 0, litsN = 0, cappedT = 0, cappedP = 0;
  for (const tf of tests) {
    const tsrc = fs.readFileSync(path.join(TEST_DIR, tf), 'utf8');
    const refs = extractSrcRefs(tsrc);
    if (!refs.length) continue;
    withRefs++;
    let tg = expandTargets(refs);
    if (tg.length > MAX_TARGETS) { tg = tg.slice(0, MAX_TARGETS); cappedT++; }
    const targets = tg.map((a) => ({ rel: relOf(a), raw: raw(a) }));
    targetsN += targets.length;
    litsN += scanText(tsrc).regexes.filter((r) => distinctive(r.body)).length;
    const bare = commentPins(tf, tsrc, targets);
    if (bare.length >= MAX_PATTERNS) cappedP++;
    for (const p of bare) all.push(p);
  }
  const reg = all.filter(isRegistered);
  const unreg = all.filter((f) => !isRegistered(f));
  console.log('[CP] 扫描 test/*.js ' + tests.length + ' 个（自身已排除）；含 src 引用 ' + withRefs +
    ' 个；目标文件 ' + targetsN + '；具区分度正则 ' + litsN +
    (cappedT || cappedP ? '；截断：目标 ' + cappedT + ' / 模式 ' + cappedP : ''));
  console.log('[CP] 命中（原文中、剥注释不中）共 ' + all.length + ' 条：已登记 ' + reg.length + ' / 未登记 ' + unreg.length);
  for (const f of unreg.slice(0, 12)) console.log('  · 未登记 ' + f.test + ' -> ' + f.src + ' :: ' + f.pattern);
  if (unreg.length > 12) console.log('  · ...(其余 ' + (unreg.length - 12) + ' 条见报告)');
  // CP-4 复活检查（**硬自检**）：登记表的 5 条必须仍能在实盘被找到。
  //   若全部失配而只作 console.log，豁免表就静默失效（门禁不再豁免任何东西，也无人知道）——
  //   故这里升级为硬失败。失配通常是「注释/断言被有意变更」→ 请在同一次改动里更新 REGISTERED。
  const missingReg = REGISTERED.filter((p) => !reg.some((f) => f.src === p.src && f.pattern.indexOf(p.needle) >= 0));
  selfcheck('CP-4 登记表 5 条真钉子仍在位（防豁免表静默腐化）',
    missingReg.length === 0,
    missingReg.length
      ? ('失配: ' + missingReg.map((p) => p.test + ' -> ' + p.src + ' :: ' + p.needle).join(' | '))
      : (reg.length + '/' + REGISTERED.length + ' 在位：' + reg.map((f) => f.test).join(', ')));

  // CP-5 高置信子集（主控要求评估「能否硬执行」）：
  //   定义 = 「该测试静态引用的 src 目标**恰好 1 个**」且「模式更严（≥6 连续汉字 或 ≥10 字符 ASCII）」。
  //   这类几乎没有跨文件二义空间，故误报率应远低于 CP-1 全量。
  //   **已实测**（用本文件自身的函数在当前树上跑，非门禁本体）：
  //     tests=136 / 含 src 引用=102 / 目标文件=1380 / 具区分度正则=633；
  //     findings=79（已登记 5 / 未登记 73）；**高置信子集未登记 = 0**。
  //   全量那 73 条几乎全是**跨文件误报**（例：api-surface 的 /UI|CLI|壳|README/ 命中 deps.js 等
  //   19 个目标里根本不该看的注释），故 CP-1 全量必须 report-only —— 子集才是可硬执行的那部分。
  const subset = unreg.filter((f) => f.strict && f.targets === 1);
  console.log('[CP] 高置信子集（单目标 + 更严阈值）未登记命中 = ' + subset.length +
    '；全量未登记 = ' + unreg.length + '（子集硬判据；全量见 CP-1 report-only）');
  for (const f of subset.slice(0, 8)) console.log('  · 子集命中 ' + f.test + ' -> ' + f.src + ' :: ' + f.pattern);
  // 子集与已登记项均用 selfcheck（永远硬失败）。子集定义把跨文件二义空间压到最小
  //   （单目标 + 更严阈值），且实测为 0 —— 不是「看着绿不管用」的门禁。
  selfcheck('CP-5 高置信子集无未登记的注释钉子（单目标 + 更严阈值）', subset.length === 0,
    subset.slice(0, 6).map((f) => f.test + ' -> ' + f.src + ' :: ' + f.pattern).join(' | ') || 'ok');

  judge('CP-1 无未登记的注释钉子（全量，含跨文件二义场景）', unreg.length === 0,
    unreg.slice(0, 6).map((f) => f.test + ' -> ' + f.src + ' :: ' + f.pattern).join(' | ') || 'ok');
}

// ─ 退出码：自检永远硬失败；实盘判据仅 CP_STRICT=1 时参与 ──
// 注意：本文件**不**沿用 domain-structure-gate 的 if (!STRICT) exit(0)（那会让自检也失效）。
console.log('\n结果: ' + passed.length + ' passed, ' + failedHard.length + ' failed(hard), ' + failedSoft.length + ' failed(soft/report-only)');
if (failedHard.length) {
  console.log('\nHARD 失败（门禁自身完整性 / 反向自检）:');
  for (const s of failedHard) console.log('  - ' + s);
}
if (!STRICT) console.log('\nreport-only：CP-1 实盘判据已打印但不致命（CP_STRICT=1 转硬失败）；反向自检始终致命。');
process.exit(failedHard.length || (STRICT && failedSoft.length) ? 1 : 0);
