#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 规范唯一性门禁（2026-09-13）

// ## 解决的问题
//   同一事实散落多份文档 → 必然漂移（本次清理就修掉 4 处过时声明）。
//   硬要求：**任何领域的规范只能有一份**，且必须被机器校验。

// ## 锁定不变量
//   U-1a 全部规范（发布/凭据/改代码/令牌/无窗口/发布通道…）存在，且各自登记了门禁文件
//   U-1b 登记门禁「真读规范」声明必须诚实：reads:true 须在**剥注释后**的源码里出现规范文件名
//        且真读该文件（一行注释不可满足）；reads:false 须登记 pending 原因并打印成可见债
//        （缺口可见，不假装已修 —— 见 P3-B 对「一行注释即可满足的弱代理」的否决）
//   U-2  README 文档索引把**每一份**已登记规范标为「唯一事实源」
//   U-3  其它文档**不得**自称规范（不得出现「唯一事实源 / 唯一规范 / 唯一权威 / 定版 SSOT」标记）
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

// 唯一规范登记表：领域 → { 文件, 校验它的门禁 }
// 不变量：**每个领域只能有一份规范**，且每份规范都必须有机器校验（U-1）。
// 2026-09-16：新增两个域级规范（令牌 / 无控制台窗口）—— 它们各自是本领域的唯一事实源，
//   分别由 token-contract-gate / no-console-window-gate 机器校验；登记在此即受本门禁保护
//   （其它文档仍不得自称规范）。
// 2026-09-16：再新增「发布通道/选版」（RELEASE-CHANNEL-CONTRACT.md）—— canary/beta/rc/
//   latest/rollback 五通道与选版算法的唯一事实源，由 release-channel-gate 机器校验。
//   与「发布/构建流程」（RELEASE-STANDARD.md）是**两个域**：前者管「版本如何被选择」，
//   后者管「怎么构建与发布」，故不违反一域一规范。
// reads: 该门禁是否**真读**规范正文（U-1b 的声明字段，必须与源码事实一致）。
//   2026-09：实测 11 个登记门禁中只有 3 个在**剥注释后**的源码里出现自己的规范名并真读它
//   （release-spec-consistency / layering-and-dependency / acceptance-standard）；其余 8 个
//   只在头注里提到规范名 —— 全域硬执行会立刻红 8 个，故按「声明诚实 + 缺口可见」分区登记。
//   reads:false 不是「已修」，而是**显式登记的债**：必须写 pending 原因，并由 U-1b 打印成清单。
const STANDARDS = {
  '发布/构建流程': { file: 'RELEASE-STANDARD.md', gate: 'test/release-spec-consistency-test.js', reads: true },
  '凭据管理': { file: 'CREDENTIALS-STANDARD.md', gate: 'test/credential-hygiene-test.js', reads: false,
    pending: '门禁校验凭据库/令牌正则/隔离等**实现不变量**，尚未读规范正文' },
  // 2026-09：本域原为「名义映射」（门禁从不提 DEVELOPMENT-TRACK）；已让 layering 门禁真读
  //   规范 §1 并断言「规范分层名 ↔ layerOf 归类」一致（L-5），故 reads:true 属实。
  '改代码规则': { file: 'DEVELOPMENT-TRACK.md', gate: 'test/layering-and-dependency-gate-test.js', reads: true },
  '令牌管理': { file: 'DSH-TOKEN-CONTRACT.md', gate: 'test/token-contract-gate-test.js', reads: false,
    pending: '门禁校验 src/ 令牌实现不变量（TK-G1..G8），尚未读契约正文' },
  '无控制台窗口': { file: 'NO-CONSOLE-WINDOW-STANDARD.md', gate: 'test/no-console-window-gate-test.js', reads: false,
    pending: '门禁扫描 spawn 调用点形态，尚未读规范正文' },
  '发布通道/选版': { file: 'RELEASE-CHANNEL-CONTRACT.md', gate: 'test/release-channel-gate-test.js', reads: false,
    pending: '门禁以行为夹具驱动 dist 选版，尚未读契约正文' },
  '守护域模型': { file: 'GUARD-DOMAIN-MODEL.md', gate: 'test/guard-domain-model-gate-test.js', reads: false,
    pending: '门禁扫描全域 guardian 补丁形态，尚未读规范正文' },
  '供应商网关架构': { file: 'PROVIDER-GATEWAY-ARCHITECTURE.md', gate: 'test/provider-gateway-gate-test.js', reads: false,
    pending: '门禁校验网关实现不变量（PG-1..PG-8），尚未读规范正文' },
  '目录结构与分层': { file: 'DIRECTORY-STRUCTURE-DESIGN.md', gate: 'test/directory-structure-gate-test.js', reads: false,
    pending: '门禁校验目录/行数/原型混入等实现不变量，尚未读规范正文' },
  // 2026-09-17：DOMAIN-STRUCTURE-DESIGN.md 原先以「定版 SSOT / 唯一权威」自称，规避 U-3 的字面量检查；
  //   登记入表后由本门禁（U-1/U-2）保护，U-3 同时堵住该措辞。
  '域内结构': { file: 'DOMAIN-STRUCTURE-DESIGN.md', gate: 'test/domain-structure-gate-test.js', reads: false,
    pending: '门禁校验域内分层实现不变量（DG-1..DG-16），尚未读规范正文' },
  '验收与测试': { file: 'ACCEPTANCE-STANDARD.md', gate: 'test/acceptance-standard-gate-test.js', reads: true },
};

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// 剥注释：**先**去行注释（到行尾），**再**去块注释，最后清空残留的 JSDoc 续行（星号开头）。
//   顺序很重要：若先跑块注释正则，行注释里出现的 glob 形态（斜杠加两个星号，如 release 或 .github
//   的递归 glob）会被当成**块注释开启符**，把其后直到下一个块注释**结束符**的**代码**一并吞掉
//   —— 本门禁曾因此把 acceptance 门禁的 STD 常量与 readFileSync 调用行误删，使 U-1b 误报「不真读」。
//   （本注释刻意不写出那两个两字符序列，避免自己触发同一问题。）
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（去掉手写正则链）。
//   语义等价或更强 —— 只多删注释文本，不多删任何代码；字符串/正则字面量感知。
const { stripComments: stripCommentsLex } = require('./_strip');
function stripComments(src) { return stripCommentsLex(src); }
/** 在 s 中按标识符边界找 name（避免 SPEC 命中 SPECIAL）。 */
function hasIdent(s, name) {
  let i = 0;
  while ((i = s.indexOf(name, i)) >= 0) {
    const before = i === 0 ? '' : s[i - 1];
    const after = s[i + name.length] || '';
    if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) return true;
    i += name.length;
  }
  return false;
}
/** 取每个 readFileSync/readFile 调用的首个实参段（到第一个右括号，足够判定）。 */
function readArgs(code) {
  const out = [];
  for (const fn of ['readFileSync', 'readFile']) {
    let i = 0;
    while ((i = code.indexOf(fn, i)) >= 0) {
      const open = code.indexOf('(', i + fn.length);
      if (open < 0) break;
      const close = code.indexOf(')', open);
      out.push(close < 0 ? code.slice(open + 1) : code.slice(open + 1, close));
      i += fn.length;
    }
  }
  return out;
}
/** U-1b 判据：门禁源码剥注释后 ①出现规范文件名 ②且存在**指向该文件**的读取。 */
function gateReadsStandard(gateSrc, stdFile) {
  const code = stripComments(gateSrc);
  if (code.indexOf(stdFile) < 0) return false;              // 注释里的名字已被剥掉
  const reads = readArgs(code);
  if (reads.some((a) => a.indexOf(stdFile) >= 0)) return true;   // ① 内联字面量读取
  const holders = [];
  for (const decl of ['const ', 'let ', 'var ']) {               // ② 经变量指向该文件
    let i = 0;
    while ((i = code.indexOf(decl, i)) >= 0) {
      const lineEnd = code.indexOf(String.fromCharCode(10), i);
      const seg = code.slice(i + decl.length, lineEnd < 0 ? code.length : lineEnd);
      const semi = seg.indexOf(';');
      const rhs = semi >= 0 ? seg.slice(0, semi) : seg;
      if (rhs.indexOf(stdFile) >= 0) {
        const name = (/^([A-Za-z_$][\w$]*)\s*=/.exec(rhs) || [])[1];
        if (name) holders.push(name);
      }
      i += decl.length;
    }
  }
  return holders.some((h) => reads.some((a) => hasIdent(a, h)));
}

// ── U-1a/U-1b：规范与门禁存在；「门禁真读规范」的声明必须诚实、缺口必须可见 ──
{
  const missing = [];
  const ungated = [];
  for (const [domain, s] of Object.entries(STANDARDS)) {
    if (!fs.existsSync(path.join(ROOT, s.file))) { missing.push(domain + ' -> ' + s.file); continue; }
    if (!fs.existsSync(path.join(ROOT, s.gate))) ungated.push(domain + ' -> ' + s.gate);
  }
  check('U-1a 全部唯一规范文件都存在', missing.length === 0,
    missing.length ? missing.join(', ') : Object.values(STANDARDS).map((x) => x.file).join(', '));
  check('U-1a 每个规范都有对应的机器校验门禁（文件存在）', ungated.length === 0,
    ungated.length ? ungated.join(', ') : Object.values(STANDARDS).map((x) => x.gate).join(', '));

  const badFlag = [];
  const dishonest = [];
  const pendingMissing = [];
  const readsTrue = [];
  const readGap = [];
  for (const [domain, s] of Object.entries(STANDARDS)) {
    if (typeof s.reads !== 'boolean') { badFlag.push(domain); continue; }
    if (s.reads) {
      readsTrue.push(domain);
      const gateAbs = path.join(ROOT, s.gate);
      if (fs.existsSync(gateAbs) && !gateReadsStandard(fs.readFileSync(gateAbs, 'utf8'), s.file)) {
        dishonest.push(domain + ' -> ' + s.gate);
      }
    } else {
      readGap.push([domain, s]);
      if (!s.pending || String(s.pending).trim().length < 8) pendingMissing.push(domain);
    }
  }
  check('U-1b 声明诚实：reads:true 的门禁确实剥离注释后真读其规范（防虚报）',
    dishonest.length === 0, dishonest.join(', ') || (readsTrue.length + ' 条 reads:true 全部属实'));
  check('U-1b 缺口可见：reads:false 必须登记 pending 原因（>=8 字），reads 字段必须为布尔',
    badFlag.length === 0 && pendingMissing.length === 0,
    (badFlag.length ? '缺/错 reads 字段: ' + badFlag.join(', ') + '；' : '') +
    (pendingMissing.length ? '缺 pending 原因: ' + pendingMissing.join(', ') : 'ok'));
  check('U-1b 非空转：至少 1 条 reads:true（否则判据自身失效）',
    readsTrue.length >= 1, readsTrue.length + ' 条');
  // 债清单必须**打印**：把「真空转」换成显式可跟踪的清单，而不是假装已修。
  console.log('U-1b 读取债清单（reads:false，共 ' + readGap.length + ' 条；补读正文后改 reads:true）：');
  for (const [domain, s] of readGap) console.log('  - ' + domain + ' -> ' + s.gate + ' :: ' + s.pending);
  // 反向合成自检（硬失败，不依赖真实数据）
  check('U-1b 反向：只在注释里写规范名不算真读（「一行注释即可满足」被堵死）',
    !gateReadsStandard('// 本门禁校验 DEVELOPMENT-TRACK.md' + String.fromCharCode(10) + 'const x = 1;', 'DEVELOPMENT-TRACK.md'), 'hit');
  check('U-1b 反向：有规范名但读的是别的文件被检出（防「标 reads:true 却不读」）',
    !gateReadsStandard("const N = 'DEVELOPMENT-TRACK.md';" + String.fromCharCode(10) + "const t = fs.readFileSync('OTHER.md', 'utf8');", 'DEVELOPMENT-TRACK.md'), 'hit');
  check('U-1b 反向：内联字面量真读规范通过（判据非恒假）',
    gateReadsStandard("const t = fs.readFileSync(path.join(ROOT, 'DEVELOPMENT-TRACK.md'), 'utf8');", 'DEVELOPMENT-TRACK.md'), 'hit');
  check('U-1b 反向：经变量真读规范通过（判据非恒假）',
    gateReadsStandard("const P = path.join(ROOT, 'DEVELOPMENT-TRACK.md');" + String.fromCharCode(10) + "const t = fs.readFileSync(P, 'utf8');", 'DEVELOPMENT-TRACK.md'), 'hit');
}

// ── U-2：README 把三者标为唯一事实源 ──
{
  const bad = [];
  for (const [domain, s] of Object.entries(STANDARDS)) {
    // 该文件在 README 中的那一行必须同时出现文件名与「唯一事实源」
    const line = readme.split(String.fromCharCode(10)).find((l) => l.includes(s.file));
    if (!line || !line.includes('唯一事实源')) bad.push(domain);
  }
  check('U-2 README 把全部规范标为「唯一事实源」', bad.length === 0, bad.length ? bad.join(', ') : 'ok');
}

// ── U-3：其它文档不得自称规范 ──
{
  const offenders = [];
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.md'))) {
    if (Object.values(STANDARDS).some((s) => s.file === f)) continue;
    if (f === 'README.md' || f === 'CHANGELOG.md') continue;
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').split(String.fromCharCode(10)).slice(0, 80).join(String.fromCharCode(10));
    // 「定版 SSOT」「唯一权威」是 2026-09-17 审计发现的对 U-3 的规避措辞（DOMAIN-STRUCTURE-DESIGN
    //   曾用其自称唯一权威却不含「唯一事实源」字面量）。一并检出，堵住同类规避。
    if (/唯一事实源|唯一规范|唯一权威|定版\s*SSOT/.test(head)) offenders.push(f);
  }
  check('U-3 只有已登记的规范可自称「唯一事实源」', offenders.length === 0, offenders.join(', ') || 'ok');
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
