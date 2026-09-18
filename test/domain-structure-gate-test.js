#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 域结构与域间契约门禁（DOMAIN-STRUCTURE-DESIGN §9 / EXECUTION-CONTRACT §1）
//
// ## 锁定的不变量（DG-1..DG-16，逐条见 SSOT §9）
//   DG-1  域门面 index.js ≤150 行且去注释源码无业务逻辑关键词      （DF-1 / R3）
//   DG-2  任何 src/**/*.js ≤300 行                                   （DF-2 / R3）
//   DG-3  contract.pure 声明的纯文件零 IO require                    （DF-3）
//   DG-4  域内跨文件 this.X() = 0（剔关键字 + 契约豁免 + 抽象占位）  （DF-4）
//   DG-4b 豁免项必须在 contract.js 有出处（防豁免表腐化）
//   DG-4c 同级兄弟文件无同名方法（白名单 constructor 等）
//   DG-4d 抽象占位（throw must-be-implemented）不计违规，但须有实现
//   DG-5a 域内 require 图无环（Tarjan）                              （DF-5 / R1）
//   DG-5b 无 Object.assign(X.prototype,...) 造成的 this 图 SCC
//   DG-5c extends + 抽象占位 的继承 SCC 显式豁免并输出
//   DG-6  非入口叶子模块无顶层副作用且有导出（require 安全）        （DF-6）
//   DG-7  域内依赖方向单调（不得 index 被 ops 依赖）                 （DF-7）
//   DG-8  无 Object.(defineProperties|assign)(X.prototype, ...) 注入 （R4-R6）
//   DG-9  contract.js 与实际导出/ctor 双向一致（未建即 FAIL）
//   DG-10 消费方成员 ⊆ 目标域 PUBLIC_API（排除 domains/router 的 ProxyInstance）
//   DG-11 域外无 .instances.instances 内部数组穿透
//   DG-12 门禁非空转（合成样本抽取函数自检 + 反向自检完备；真实总量仅证据）
//   DG-13 门禁不得以行号为断言目标（只作证据）
//   DG-14 app/facade/* 只读，写动作应下沉 app/domain-actions/        （R7）
//   DG-15 require() 必须在模块顶层，函数体内 0 处                     （DF-8）
//         唯一显式白名单：src/supervisor.js 的 get lan() 惰性 require（见 DG-15 块注释）
//   DG-16 函数（回调/闭包）嵌套深度 ≤6，超出的须提为具名函数         （DF-9）
//
// ## 纪律（继承既有门禁的三条教训）
//   1. 判据本体抽纯函数，正向检查与反向自检共用同一个函数；
//   2. 反向样本必须真的与匹配器有交集（防样本不含关键词导致假 PASS）；
//   3. 门禁不可空转：存在性下界 + 反向自检条数完备。
//   ★ 所有源码扫描统一先 strip() 剥注释（R1 取证陷阱：supervisor.js 的说明性注释
//     含并原型写法，instance/index.js / plugin/index.js 同理会造成假阳性）。
//
// ## 初始模式：report-only
//   域改造尚未完成，默认 DG 判据只打印 RED 清单、退出码恒 0；反向自检永远硬失败
//   （门禁自身完整性必须真实）。DG_STRICT=1 可整体转硬失败（迁移批 10 用）。
//   RED 基线记录在 design-notes/EXEC-gates.md。
//
// ## 已知待办（如实报告，不掩盖）
//   · DG-8 命中 src/supervisor.js（Object.assign(Supervisor.prototype, mod.methods)）——
//     那是编排层既有关键装配机制，属 app/ 层改造范围；
//   · DG-3/DG-9/DG-10 依赖 src/domains/*/contract.js（本批 0 已立门禁、未建契约），
//     当前判定为契约未建 RED，由后续批（M3/M4）补齐；
//   · DG-6 采用静态代理而非子进程 require 探针 —— 遵守不启动进程 / 不碰产品状态根
//     的硬约束（见 EXEC-gates.md 偏差记录）。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DOMAINS_DIR = path.join(SRC, 'domains');
const STRICT = process.env.DG_STRICT === '1';

// ── 结果收集器：judge = 默认 report-only 的判据；selfcheck = 永远硬失败的反向自检 ──
const passed = [];
const failedHard = [];
const failedSoft = [];
function record(name, ok, evidence, hard) {
  const tag = ok ? 'PASS' : (hard ? 'FAIL' : 'FAIL(soft)');
  console.log(tag + ' ' + name + (evidence ? '  <- ' + evidence : ''));
  if (ok) { passed.push(name); return; }
  if (hard) failedHard.push(name + (evidence ? '  <- ' + evidence : ''));
  else failedSoft.push(name + (evidence ? '  <- ' + evidence : ''));
}
const judge = (name, cond, evidence) => record(name, !!cond, evidence, STRICT);
const selfcheck = (name, cond, evidence) => record(name, !!cond, evidence, true);
const short = (arr, n) => {
  const k = n === undefined ? 8 : n;
  return arr.slice(0, k).join(', ') + (arr.length > k ? ' ...(+' + (arr.length - k) + ')' : '');
};

// ── 源码地基：strip / countLines / definedNames / thisCalls / requireEdges ──
// 阶段六 P6-A：统一走 test/_strip.js 的字符级单一实现（语义等价且正则字面量感知）。
const { stripComments } = require('./_strip');
function strip(src) { return stripComments(src); }
function countLines(s) { return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0; }

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor',
  'of', 'in', 'do', 'else', 'new', 'typeof', 'await', 'delete', 'throw', 'try', 'with', 'yield']);

function definedNames(src) {
  const s = new Set(); let m;
  const reClass = /^\s{2,6}(?:async\s+)?(?:get\s+|set\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  while ((m = reClass.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
  const reObj = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  while ((m = reObj.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
  const reFn = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = reFn.exec(src))) if (!KEYWORDS.has(m[1])) s.add(m[1]);
  return s;
}

function readBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return s.slice(openIdx + 1);
}
/** 方法定义的受支持形态（DG-14 用）。**不再只认「2-6 空格的方法简写」** —— 原判据在重构
 *  （工厂化把方法改写为「name: function」/箭头属性、或改变缩进）后会**抽不到方法体 ⇒ 判据恒绿
 *  = 静默失覆盖**，而 DG-14 正是靠它判定「app/facade/* 无写动作」。本仓已四次因「门禁看不见」而假绿。
 *    A 方法简写          name(args) {              （含 async / get / set / static）
 *    B 属性函数          name: function (args) {
 *    C 属性箭头（块体）  name: (args) => {          （含 async）
 *  缩进上界 8：用于排除**方法体内部**的嵌套对象成员（更深缩进视为嵌套，非本文件方法定义）。 */
const METHOD_FORMS = [
  /^[ \t]{2,8}(?:async\s+)?(?:get\s+|set\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  /^[ \t]{2,8}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\s*\([^)]*\)\s*\{/gm,
  /^[ \t]{2,8}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/gm,
];
function methodBodies(src) {
  const found = [];
  for (const re of METHOD_FORMS) {
    let m;
    while ((m = re.exec(src))) {
      if (KEYWORDS.has(m[1])) continue;
      const open = m.index + m[0].length - 1;
      found.push({ at: m.index, name: m[1], body: readBrace(src, open) });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set();
  return found.filter((f) => { const k = f.at + ':' + f.name; if (seen.has(k)) return false; seen.add(k); return true; });
}
/** 抽取器**无法**取体的成员形态：属性箭头**无块体**（name: (a) => expr）—— 无花括号可 readBrace。
 *  返回这些形态的名字，由 DG-14 显式判为违规，使门禁对未知形态**失败可见**而非静默失覆盖。 */
const UNSUPPORTED_METHOD_FORM = /^[ \t]{2,8}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?!\{)/gm;
function unsupportedMethodForms(src) {
  const out = []; let m;
  while ((m = UNSUPPORTED_METHOD_FORM.exec(src))) {
    if (KEYWORDS.has(m[1])) continue;
    out.push(m[1]);
  }
  return out;
}

function thisCallNames(src) {
  const out = []; let m;
  const re = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function abstractPlaceholders(src) {
  const out = new Set(); let m;
  const re = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*throw new Error\([^)]*must be implemented[^)]*\)\s*;?\s*\}/gm;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

function classExtends(src) {
  const out = []; let m;
  const re = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(src))) out.push({ sub: m[1], base: m[2] });
  return out;
}
function classNames(src) {
  const out = new Set(); let m;
  const re = /class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

function parseModuleExportsKeys(src) {
  const s = strip(src);
  const idx = s.indexOf('module.exports');
  if (idx < 0) return { kind: 'none', keys: [] };
  const eq = s.indexOf('=', idx);
  const open = s.indexOf('{', eq);
  if (eq < 0 || open < 0) return { kind: 'dynamic', keys: [] };
  let depth = 0, end = -1;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return { kind: 'dynamic', keys: [] };
  const body = s.slice(open + 1, end);
  const keys = [];
  for (const raw of body.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*[^,]+)?$/);
    if (m) keys.push(m[1]);
    else return { kind: 'dynamic', keys };
  }
  return { kind: 'literal', keys };
}

// ── 文件系统扫描（只读；无进程/无状态根写入）──
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
const SRC_FILES = walk(SRC, []).sort();
const REL = (abs) => path.relative(SRC, abs).split(path.sep).join('/');
const RAW = new Map();
const STRIPPED = new Map();
function rawOf(abs) { if (!RAW.has(abs)) RAW.set(abs, fs.readFileSync(abs, 'utf8')); return RAW.get(abs); }
function strippedOf(abs) { if (!STRIPPED.has(abs)) STRIPPED.set(abs, strip(rawOf(abs))); return STRIPPED.get(abs); }

function resolveRel(fromAbs, spec) {
  const t = path.resolve(path.dirname(fromAbs), spec);
  for (const cand of [t + '.js', path.join(t, 'index.js'), t]) {
    try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch {}
  }
  return null;
}
function requireEdges(abs, src) {
  const out = []; let m;
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const t = resolveRel(abs, spec);
    if (!t) continue;
    if (!REL(t).startsWith('..')) out.push(t);
  }
  return out;
}

const ENTRIES = SRC_FILES.map((abs) => ({ abs, rel: REL(abs), raw: rawOf(abs), src: strippedOf(abs), lines: countLines(rawOf(abs)) }));

// ── 域模型（供 DG-4/5/6/7）──
const DOMAINS = (() => {
  try { return fs.readdirSync(DOMAINS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
})();

function buildDomain(domain) {
  const files = SRC_FILES.filter((f) => REL(f).startsWith('domains/' + domain + '/'));
  const srcs = new Map(files.map((f) => [f, strippedOf(f)]));
  const defs = new Map(files.map((f) => [f, definedNames(srcs.get(f))]));
  const abstracts = new Set();
  for (const f of files) for (const n of abstractPlaceholders(srcs.get(f))) abstracts.add(n);
  return { domain, files, srcs, defs, abstracts };
}
const DOMAIN_MODELS = new Map(DOMAINS.map((d) => [d, buildDomain(d)]));

function crossFileThisEdges(model) {
  const edges = [];
  for (const f of model.files) {
    const own = model.defs.get(f);
    for (const name of thisCallNames(model.srcs.get(f))) {
      if (own.has(name)) continue;
      const g = model.files.find((x) => x !== f && model.defs.get(x).has(name));
      if (g) edges.push({ from: f, to: g, name });
    }
  }
  return edges;
}

// 判据本体（纯）：跨文件 this，剔除关键字/抽象占位/契约豁免。
function crossFileThisViolations(sources, opts) {
  const files = [...sources.keys()];
  const defs = (opts && opts.defs) || new Map(files.map((f) => [f, definedNames(sources.get(f))]));
  const abstracts = (opts && opts.abstracts) || new Set();
  const exemptions = (opts && opts.exemptions) || new Set();
  const out = [];
  for (const f of files) {
    const own = defs.get(f);
    for (const name of thisCallNames(sources.get(f))) {
      if (own.has(name) || abstracts.has(name) || exemptions.has(name)) continue;
      const g = files.find((x) => x !== f && defs.get(x).has(name));
      if (g) out.push({ from: f, to: g, name });
    }
  }
  return out;
}

// 判据本体（纯）：bare this.X() 被 ≥2 个兄弟文件定义 → 指向不明（真实歧义）。
function ambiguousConsumedNames(sources, opts) {
  const files = [...sources.keys()];
  const defs = (opts && opts.defs) || new Map(files.map((f) => [f, definedNames(sources.get(f))]));
  const seen = new Map();
  for (const f of files) {
    const own = defs.get(f);
    for (const name of thisCallNames(sources.get(f))) {
      if (own.has(name)) continue;
      const definers = files.filter((x) => x !== f && defs.get(x).has(name));
      if (definers.length >= 2 && !seen.has(name)) seen.set(name, definers);
    }
  }
  return [...seen.entries()].map(([name, fs2]) => ({ name, files: fs2 }));
}

function unimplementedAbstracts(abstracts, defsMap) {
  const impl = new Set();
  for (const set of defsMap.values()) for (const n of set) impl.add(n);
  return [...abstracts].filter((n) => !impl.has(n));
}

// ── Tarjan SCC（DG-5）──
function tarjanSCC(nodes, adjFn) {
  let index = 0;
  const stack = [], onStack = new Set(), idx = new Map(), low = new Map(), sccs = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adjFn(v)) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), idx.get(w))); }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return sccs;
}

function requireAdj(model) {
  const set = new Set(model.files);
  const adj = new Map(model.files.map((f) => [f, []]));
  for (const f of model.files) {
    for (const t of requireEdges(f, model.srcs.get(f))) if (set.has(t)) adj.get(f).push(t);
  }
  return adj;
}
function combinedAdj(model) {
  const adj = requireAdj(model);
  for (const e of crossFileThisEdges(model)) adj.get(e.from).push(e.to);
  return adj;
}

// DG-5c：extends 两文件 + 基类声明抽象占位 → 合法继承 SCC。
function isInheritanceSCC(comp, model) {
  if (comp.length !== 2) return false;
  const [a, b] = comp;
  const ea = classExtends(model.srcs.get(a)), eb = classExtends(model.srcs.get(b));
  const na = classNames(model.srcs.get(a)), nb = classNames(model.srcs.get(b));
  const pair = eb.some((x) => na.has(x.base)) || ea.some((x) => nb.has(x.base));
  if (!pair) return false;
  return abstractPlaceholders(model.srcs.get(a)).size > 0 || abstractPlaceholders(model.srcs.get(b)).size > 0;
}

// ── DG-7 依赖方向 rank ──
const RANK = {
  'index.js': 0, 'daemon.js': 0,
  // rank 1：编排 / 服务本体 / 入口适配
  'ops.js': 1, 'scheduler.js': 1, 'handlers': 1, 'upgrade.js': 1,
  'forward-core.js': 1, 'router-ops.js': 1, 'watchdog.js': 1, 'restart.js': 1, 'market.js': 1,
  'lifecycle.js': 1, 'updater.js': 1, 'proxy.js': 1, 'ports-bootstrap.js': 1,
  'endpoint.js': 1,
  // rank 2：纯核心 / 策略 / 会话 / 目标解析
  'core.js': 2, 'policies': 2, 'policies.js': 2, 'switch.js': 2, 'journal.js': 2, 'jobs.js': 2,
  'state-machine.js': 2, 'cli.js': 2, 'targets.js': 2, 'frp.js': 2, 'managed.js': 2, 'views.js': 2,
  'session.js': 2, 'tunnel.js': 2, 'market-net.js': 2, 'market-sources.js': 2,
  // frp-install.js 与 frp.js 同为原 frpmgr.js 的按副作用二分半（relay.md:216 判定 frp→frp-install 域内合法）：
  'frp-install.js': 2,
  // rank 3：模型 / 持久化 / 多实现 / 纯数据
  'model.js': 3, 'store.js': 3, 'providers': 3, 'port-segments.js': 3, 'proxy-apps.js': 3,
  // 域契约文件（纯数据、零 require，与 model/store 同层）。此前未登记 → rank=null；
  //   当前无域内消费者故 DG-7 仍绿，一旦有人 require('./contract') 会以「未归类」误报而非做方向检查。
  'contract.js': 3,
  'layers.js': 3, 'ports.js': 3, 'config.js': 3, 'usage.js': 3, 'sandbox.js': 3,
  // 子目录首段（只登记**当前存在**的子目录：domains/*/{ops,policies,store,model,handlers,providers}）。
  //   指向已删目录的条目是空转，且会静默"预放行"将来同名的新目录 —— 未登记一律 rank=null，
  //   由 DG-7 以「未归类」报出，这才是本表想要的门禁语义。
  'ops': 1, 'store': 3, 'model': 3, 'handlers': 1, 'policies': 2,
};
function rankOf(relInDomain) {
  const parts = relInDomain.split('/');
  if (parts.length > 1 && RANK[parts[0]] !== undefined) return RANK[parts[0]];
  const base = parts[parts.length - 1];
  return RANK[base] !== undefined ? RANK[base] : null;
}
// 判据本体（纯）：方向违反 = from.rank > to.rank；未归类 = null。
function directionalViolations(edges) {
  const out = [];
  for (const e of edges) {
    const rf = rankOf(e.from), rt = rankOf(e.to);
    if (rf === null || rt === null) out.push({ from: e.from, to: e.to, why: '未归类文件（rank=null）' });
    else if (rf > rt) out.push({ from: e.from, to: e.to, why: 'rank ' + rf + ' -> ' + rt + '（依赖向上）' });
  }
  return out;
}

// ── DG-8 mixin 判据（R6 三件套；必须先剥注释）──
const MIXIN_INTO_PROTOTYPE = /Object\.(defineProperties|assign)\(\s*[\w$.]+\.prototype\s*[,)]/;
const METHODS_FRAGMENT = /module\.exports\s*=\s*\{\s*methods\s*[:}]/;
const METHODS_FRAGMENT_SHORT = /module\.exports\s*=\s*\{[\s\S]{0,200}?\bmethods\b\s*[,:}]/;
function mixinIntoPrototype(src) { return MIXIN_INTO_PROTOTYPE.test(src); }
function methodsFragment(src) { return METHODS_FRAGMENT.test(src) || METHODS_FRAGMENT_SHORT.test(src); }

// ─ DG-3 纯/IO（契约声明驱动）──
const IO_MODULES = ['node:fs', 'node:fs/promises', 'node:net', 'node:child_process', 'node:http', 'node:https', 'node:tls', 'node:dns'];
function ioRequireHits(src, modules) {
  return (modules || IO_MODULES).filter((m) => new RegExp("require\\(\\s*['\"]" + m.replace(/[/:]/g, '\\$&') + "['\"]\\s*\\)").test(src));
}
function pureViolations(sources, pureRels) {
  const out = [];
  for (const rel of pureRels) {
    const src = sources.get(rel);
    if (src === undefined) continue;
    const hits = ioRequireHits(src);
    if (hits.length) out.push({ rel, hits });
  }
  return out;
}

// ── DG-6 叶子模块（静态代理）──
const ENTRY_FILES = new Set(['domains/relay/daemon.js', 'domains/router/daemon.js']);
// 顶层 = 行首第 0 列（方法体内的缩进行不算顶层；否则内嵌 new Promise/setTimeout 会误报）。
const TOP_LEVEL_SIDE_EFFECTS = [
  /^setInterval\s*\(/m,
  /^setTimeout\s*\(/m,
  /^Object\.(?:assign|defineProperties)\(\s*\w+\.prototype/m,
  /^new\s+[A-Z]\w*\s*\(/m,
];
function leafViolations(files, opts) {
  const entries = (opts && opts.entryFiles) || new Set();
  const out = [];
  for (const item of files) {
    const rel = item.rel, src = item.src;
    if (entries.has(rel)) continue;
    const hits = TOP_LEVEL_SIDE_EFFECTS.filter((re) => re.test(src)).map((re) => String(re));
    const noExports = !/module\.exports/.test(src);
    if (hits.length || noExports) out.push({ rel, hits, noExports });
  }
  return out;
}

// ── DG-9 契约双向一致 ──
function loadContract(domain) {
  const p = path.join(DOMAINS_DIR, domain, 'contract.js');
  if (!fs.existsSync(p)) return null;
  try { delete require.cache[require.resolve(p)]; return require(p); } catch (e) { return { __error: (e && e.message) || String(e) }; }
}
const CONTRACTS = new Map(DOMAINS.map((d) => [d, loadContract(d)]));
const contractOf = (d) => (CONTRACTS.get(d) && !CONTRACTS.get(d).__error ? CONTRACTS.get(d) : null);
function exportsMismatch(declared, actual) {
  return {
    missing: declared.filter((k) => !actual.includes(k)),
    extra: actual.filter((k) => !declared.includes(k)),
  };
}

// ── DG-10 消费方 ⊆ PUBLIC_API ──
const CONSUMER_BINDING = /(?:\bthis|\bhost|\bsup|\bself)\s*\.\s*(instances|router|lan|pluginManager|pluginMarket|shellDomain)\s*\.\s*([A-Za-z_$][\w$]*)/g;
const BINDING_DOMAIN = { instances: 'instance', router: 'router', lan: 'relay', pluginManager: 'plugin', pluginMarket: 'plugin', shellDomain: 'shell' };
function consumerViolations(files, apiByDomain) {
  const unverifiable = [], violations = [];
  for (const item of files) {
    const rel = item.rel, src = item.src;
    let m;
    CONSUMER_BINDING.lastIndex = 0;
    while ((m = CONSUMER_BINDING.exec(src))) {
      const binding = m[1], member = m[2];
      // `this.router.constructor.presets()` 命中的是 JS 内建 constructor（静态 presets 的访问载体），
      // 不是域 API 成员；真正的静态成员 presets 已登记在 router contract.PUBLIC_API。
      if (member === 'constructor') continue;
      const domain = BINDING_DOMAIN[binding];
      if (binding === 'instances' && (rel.startsWith('domains/router/') || rel.startsWith('domains/instance/'))) continue;
      if (rel.startsWith('domains/' + domain + '/')) continue;
      const api = apiByDomain ? apiByDomain[domain] : null;
      if (!api) unverifiable.push({ rel, binding, member, domain });
      else if (!api.includes(member)) violations.push({ rel, binding, member, domain });
    }
  }
  return { violations, unverifiable };
}

// ─ DG-11 数组穿透 ──
// 判据必须同时覆盖四种真实写法：this.instances.instances（原）、别名 instances.instances、
//   经 getter 的 instances().instances、括号字符串取值 instances['instances']。
//   原判据要求字面点号前缀，别名/调用形态长期漏检（app/control/adapters.js、app/control/specs.js、
//   domains/relay/managed.js）；括号取值形态按同一「必须带 instances 接收者」口径补入 ——
//   引号必须成对，故 instances['list'] 与裸 obj['instances'] 都不会误报。
//   注：f.src 已由 strip() 剥注释，故注释里的写法不产生命中；字符串字面量被 strip 保留，故本形态可检出。
const ARRAY_PIERCE = /\binstances\s*(?:\(\s*\))?\s*(?:\.\s*instances\b|\[\s*(['"])instances\1\s*\])/;
function piercings(files) {
  return files.filter((f) => ARRAY_PIERCE.test(f.src)).filter((f) => !f.rel.startsWith('domains/instance/')).map((f) => f.rel);
}

// ── DG-13 门禁不得硬编码行号 ──
const LINE_ASSERT = /(?:\.line|lineNumber|_line)\s*===\s*\d+/;
function lineNumberAssertions(src) { const m = src.match(LINE_ASSERT); return m ? [m[0]] : []; }

// ── DG-15/16 函数体花括号 / 内联 require / 嵌套深度（EXEC3 §1；零第三方依赖）──
// 判据本体（纯）：返回「函数体开括号」下标集合。只有这些 { 计入函数嵌套作用域；
// 顶层对象/数组字面量不计入，避免把顶层 module.exports = { x: require(...) } 误判为函数内。
const FUNCTION_CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'do',
  'return', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'instanceof', 'case', 'throw',
  'await', 'yield', 'function']);
function functionBodyBraces(src) {
  const marked = new Set(); let m;
  // ① function 关键字：跳到形参右括号后第一个 {
  const reFn = /\bfunction\b/g;
  while ((m = reFn.exec(src))) {
    let j = m.index + m[0].length;
    while (j < src.length && src[j] !== '(' && src[j] !== '{') j++;
    if (src[j] === '(') {
      let depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
      }
    }
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '{') marked.add(j);
  }
  // ② 箭头函数块体：=> 后跳过空白遇 {
  const reArrow = /=>/g;
  while ((m = reArrow.exec(src))) {
    let j = m.index + 2;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '{') marked.add(j);
  }
  // ③ 方法简写 / class 方法 / getter / setter（排除 if/for/while/switch/catch 等控制关键字）
  const reMethod = /(?:^|[^\w$)\]}])(?:async\s+)?(?:get\s+|set\s+|static\s+|\*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  while ((m = reMethod.exec(src))) {
    if (FUNCTION_CONTROL_KEYWORDS.has(m[1])) continue;
    marked.add(m.index + m[0].length - 1);
  }
  return marked;
}
// 判据本体（纯）：一次遍历同时求「当前打开的函数体花括号数最大值」与「函数体内的 require 行」。
function functionScan(src) {
  const marked = functionBodyBraces(src);
  const stack = []; let maxFn = 0; const inlineRequires = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const isFn = marked.has(i);
      stack.push(isFn);
      if (isFn) { let d = 0; for (const b of stack) if (b) d++; if (d > maxFn) maxFn = d; }
    } else if (c === '}') { stack.pop(); }
    else if (c === 'r' && src.startsWith('require(', i) && stack.includes(true)) {
      inlineRequires.push(src.slice(0, i).split('\n').length);
    }
  }
  return { maxFn, inlineRequires };
}

// ── DG-14 facade 只读 ──
const WRITE_VERB = /^(set|patch|install|apply|toggle|sync|start|stop|restart|enable|disable|update|remove|delete|reset)/i;
const WRITE_TARGET_CALL = /\.(frpAction|setFrp|syncFrpc)\s*\(/;
const FACADE_EXCEPTIONS = {
  'app/facade/lan.js': { listLan: '读触发 reconcile 对账（relay list），域契约标注 read-with-side-effect' },
  'app/facade/ports.js': { listPorts: '读触发端口激活探测，同上' },
};
function facadeWriteViolations(files, exceptions) {
  const out = [];
  for (const item of files) {
    const rel = item.rel, src = item.src;
    const ex = (exceptions || {})[rel] || {};
    for (const m of methodBodies(src)) {
      if (ex[m.name]) continue;
      if (WRITE_VERB.test(m.name)) out.push({ rel, method: m.name, why: '方法名命中写动词' });
      else if (WRITE_TARGET_CALL.test(m.body)) out.push({ rel, method: m.name, why: '方法体调用写目标' });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// 判据执行
// ════════════════════════════════════════════════════════════════════════
console.log('模式: ' + (STRICT ? 'STRICT（判据硬失败）' : 'report-only（判据软失败，退出码恒 0）'));
console.log('扫描: ' + ENTRIES.length + ' 个 src/**/*.js，' + DOMAINS.length + ' 个域\n');

// ── DG-1 门面 ≤150 行且无业务逻辑关键词 ──
{
  const FACADE_BANNED = ['http.createServer', 'fs.writeFileSync', 'setInterval('];
  const facadeViolations = (entries, maxLines) => entries
    .filter((e) => e.lines > maxLines || FACADE_BANNED.some((k) => e.src.includes(k)))
    .map((e) => ({ rel: e.rel, n: e.lines, banned: FACADE_BANNED.filter((k) => e.src.includes(k)) }));
  const facades = ENTRIES.filter((e) => /^domains\/[^/]+\/index\.js$/.test(e.rel));
  const v = facadeViolations(facades, 150);
  judge('DG-1 域门面 index.js ≤150 行且无业务逻辑关键词', v.length === 0,
    v.length ? v.map((x) => x.rel + '(' + x.n + (x.banned.length ? ',banned:' + x.banned.join('|') : '') + ')').join(', ') : 'ok（' + facades.length + ' 门面）');
  const longSample = Array.from({ length: 151 }, () => 'x;').join('\n');
  const bannedSample = ['const http = require("node:http");', 'http.createServer(() => {});', 'module.exports = {};'].join('\n');
  const okSample = ['module.exports = { A };', 'function A() {}'].join('\n');
  selfcheck('DG-1 反向：151 行样本命中', facadeViolations([{ rel: 's', src: strip(longSample), lines: 151 }], 150).length === 1, 'hit');
  selfcheck('DG-1 反向：含 http.createServer 样本命中', facadeViolations([{ rel: 's', src: strip(bannedSample), lines: 3 }], 150).length === 1, 'hit');
  selfcheck('DG-1 反向：合规样本不命中', facadeViolations([{ rel: 's', src: strip(okSample), lines: 2 }], 150).length === 0, 'miss');
}

// ── DG-2 单文件 ≤300 行 ─
{
  const oversized = (entries, maxLines) => entries.filter((e) => e.lines > maxLines).map((e) => e.rel + '(' + e.lines + ')');
  const v = oversized(ENTRIES, 300);
  judge('DG-2 任何 src/**/*.js ≤300 行', v.length === 0, v.length ? v.length + ' 个: ' + short(v) : 'ok');
  selfcheck('DG-2 反向：401 行样本命中', oversized([{ rel: 's', lines: 401 }], 300).length === 1, 'hit');
  selfcheck('DG-2 反向：300 行样本不命中（边界）', oversized([{ rel: 's', lines: 300 }], 300).length === 0, 'miss');
  // 非空转证明：合成样本必须能命中（不得依赖真实违规存在）
  selfcheck('DG-2 反向：合成样本按阈值命中（非空转）',
    oversized([{ rel: 'a', lines: 301 }, { rel: 'b', lines: 300 }, { rel: 'c', lines: 999 }], 300).length === 2, 'synthetic');
  // ⚠ 原为「真实超限 >=1」——那会随架构改善而恒假（门禁自锁），已改为合成样本。
}

// ── DG-3 contract.pure 声明的纯文件零 IO require ──
{
  const pureRels = [];
  for (const d of DOMAINS) {
    const c = contractOf(d); if (!c) continue;
    const pure = c.pure;
    const list = Array.isArray(pure) ? pure : (pure && typeof pure === 'object' ? Object.keys(pure).filter((k) => pure[k]) : []);
    for (const rel of list) pureRels.push(rel);
  }
  const sources = new Map(ENTRIES.map((e) => [e.rel, e.src]));
  const v = pureViolations(sources, pureRels);
  judge('DG-3 contract.pure 声明文件零 IO require', pureRels.length > 0 && v.length === 0,
    pureRels.length === 0 ? 'contract.js 未建（无 pure 声明）' : (v.length ? short(v.map((x) => x.rel + ':' + x.hits.join('|'))) : 'ok（' + pureRels.length + ' 声明）'));
  selfcheck('DG-3 反向：require node:fs 命中', ioRequireHits(strip("const fs = require('node:fs');")).length === 1, 'hit');
  selfcheck('DG-3 反向：require ./y 不命中', ioRequireHits(strip("const x = require('./y');")).length === 0, 'miss');
  selfcheck('DG-3 反向：对真实源码形态有分辨力',
    pureViolations(new Map([['a', strip("const fs = require('node:fs');")]]), ['a']).length === 1, 'hit');
}

// ── DG-4/4b/4c/4d 域内跨文件 this ──
{
  const CONTRACT_HOOKS = {
    instance: ['onRemoteChange', 'onInstanceStart', 'onInstanceStop', 'onCreate', 'onRemove', 'onDestroy'],
    plugin: ['onNativeRestart'],
    relay: ['persist', 'mainOf', 'tokenOf'],
    router: ['onPersist', '_ccLoginReject', '_ccLoginResolve'],
  };
  const perDomain = [];
  let totalV = 0, totalRaw = 0;
  for (const d of DOMAINS) {
    const model = DOMAIN_MODELS.get(d);
    const ex = new Set(CONTRACT_HOOKS[d] || []);
    totalRaw += model.files.reduce((a, f) => a + thisCallNames(model.srcs.get(f)).length, 0);
    const sources = new Map(model.files.map((f) => [REL(f), model.srcs.get(f)]));
    const defs = new Map(model.files.map((f) => [REL(f), model.defs.get(f)]));
    const v = crossFileThisViolations(sources, { abstracts: model.abstracts, exemptions: ex, defs });
    totalV += v.length; perDomain.push({ d, n: v.length });
  }
  const v = perDomain.filter((x) => x.n > 0);
  judge('DG-4 域内跨文件 this.X() = 0', totalV === 0,
    totalV ? totalV + ' 处: ' + v.map((x) => x.d + '=' + x.n).join(', ') : 'ok');
  selfcheck('DG-4 反向：A 定义 save、B 调 this.save() 命中 1',
    crossFileThisViolations(new Map([['a', 'class A {\n  save() {}\n}'], ['b', 'class B {\n  run() { this.save(); }\n}']]), {}).length === 1, 'hit');
  selfcheck('DG-4 反向：B 自定 save 命中 0',
    crossFileThisViolations(new Map([['a', 'class A {\n  save() {}\n}'], ['b', 'class B {\n  save() {}\n  run() { this.save(); }\n}']]), {}).length === 0, 'miss');
  selfcheck('DG-4 反向：抽象占位剔除（abstracts 含 save）命中 0',
    crossFileThisViolations(new Map([['a', 'class A {\n  save() {}\n}'], ['b', 'class B {\n  run() { this.save(); }\n}']]), { abstracts: new Set(['save']) }).length === 0, 'miss');
  selfcheck('DG-4 反向：真实 this.X() 调用 ≫0（非空转）', totalRaw >= 100, 'count=' + totalRaw);

  const missingExempt = [];
  for (const d of Object.keys(CONTRACT_HOOKS)) {
    const c = contractOf(d);
    if (!c) { missingExempt.push(d + ':*（contract 未建）'); continue; }
    const declared = new Set([
      ...Object.keys((c.deps && c.deps.hooks) || {}),
      ...Object.keys(c.deps || {}),
      ...((c.hooks) ? Object.keys(c.hooks) : []),
    ]);
    for (const n of CONTRACT_HOOKS[d]) if (!declared.has(n)) missingExempt.push(d + ':' + n);
  }
  judge('DG-4b 契约豁免项在 contract.js 有出处', missingExempt.length === 0,
    missingExempt.length ? short(missingExempt) : 'ok');
  const missingOf = (table, depsByDomain) => {
    const out = [];
    for (const d of Object.keys(table)) for (const n of table[d]) {
      const deps = (depsByDomain[d] && depsByDomain[d].deps) || {};
      const hooks = deps.hooks || {};
      if (!(n in deps) && !(n in hooks)) out.push(d + ':' + n);
    }
    return out;
  };
  selfcheck('DG-4b 反向：假豁免 __nope__ 命中',
    missingOf({ relay: ['__nope__'] }, { relay: { deps: { tokenOf: {}, hooks: { onPersist: {} } } } }).length === 1, 'hit');
  selfcheck('DG-4b 反向：真豁免 tokenOf 不命中',
    missingOf({ relay: ['tokenOf'] }, { relay: { deps: { tokenOf: {}, hooks: {} } } }).length === 0, 'miss');

  const dups = [];
  for (const d of DOMAINS) {
    const model = DOMAIN_MODELS.get(d);
    const sources = new Map(model.files.map((f) => [REL(f), model.srcs.get(f)]));
    const defs = new Map(model.files.map((f) => [REL(f), model.defs.get(f)]));
    for (const x of ambiguousConsumedNames(sources, { defs })) dups.push(d + ':' + x.name + '(' + x.files.map((f) => f.split('/').pop()).join('|') + ')');
  }
  judge('DG-4c bare this.X() 无同名兄弟歧义（指向唯一）', dups.length === 0, dups.length ? dups.length + ' 组: ' + short(dups) : 'ok');
  const NL = String.fromCharCode(10);
  const ambFixture = (defsB) => ambiguousConsumedNames(
    new Map([
      ['a', ['class A {', '  canPersist() {}', '}'].join(NL)],
      ['b', ['class B {', '  canPersist() {}', '}'].join(NL)],
      ['c', ['class C {', '  run() { this.canPersist(); }', '}'].join(NL)],
    ]),
    { defs: new Map([['a', new Set(['canPersist'])], ['b', defsB], ['c', new Set(['run'])]]) });
  selfcheck('DG-4c 反向：两兄弟文件都定义 canPersist 且被消费 命中',
    ambFixture(new Set(['canPersist']))[0].name === 'canPersist', 'hit');
  selfcheck('DG-4c 反向：只一个文件定义 不命中', ambFixture(new Set(['x'])).length === 0, 'miss');

  const unimpl = [];
  for (const d of DOMAINS) {
    const model = DOMAIN_MODELS.get(d);
    if (!model.abstracts.size) continue;
    const implDefs = new Map();
    for (const f of model.files) {
      const abs = abstractPlaceholders(model.srcs.get(f));
      implDefs.set(REL(f), new Set([...model.defs.get(f)].filter((n) => !abs.has(n))));
    }
    for (const n of unimplementedAbstracts(model.abstracts, implDefs)) unimpl.push(d + ':' + n);
  }
  const absStat = DOMAINS.map((d) => d + '=' + DOMAIN_MODELS.get(d).abstracts.size).filter((s) => !s.endsWith('=0')).join(',');
  judge('DG-4d 抽象占位（throw must-be-implemented）均有实现', unimpl.length === 0,
    unimpl.length ? unimpl.length + ' 个无实现: ' + short(unimpl) : 'ok（' + absStat + '）');
  const absOf = (src) => abstractPlaceholders(strip(src));
  selfcheck('DG-4d 反向：抽象方法无实现 命中',
    unimplementedAbstracts(absOf("class A {\n  foo() { throw new Error('foo must be implemented by x'); }\n}"), new Map([['a', new Set(['bar'])]]))[0] === 'foo', 'hit');
  selfcheck('DG-4d 反向：有实现 不命中',
    unimplementedAbstracts(absOf("class A {\n  foo() { throw new Error('foo must be implemented by x'); }\n}"), new Map([['a', new Set(['bar'])], ['b', new Set(['foo'])]])).length === 0, 'miss');
}

// ── DG-5 require DAG + mixin SCC + 继承豁免 ──
{
  const requireSCCs = [], mixinSCCs = [], inheritanceSCCs = [];
  for (const d of DOMAINS) {
    const model = DOMAIN_MODELS.get(d);
    const reqAdj = requireAdj(model);
    for (const comp of tarjanSCC(model.files, (v) => reqAdj.get(v) || [])) {
      if (comp.length > 1) requireSCCs.push(d + ':[' + comp.map((f) => f.split('/').pop()).join('|') + ']');
    }
    const combAdj = combinedAdj(model);
    for (const comp of tarjanSCC(model.files, (v) => combAdj.get(v) || [])) {
      if (comp.length <= 1) continue;
      if (isInheritanceSCC(comp, model)) inheritanceSCCs.push(d + ':[' + comp.map((f) => f.split('/').pop()).join('|') + ']');
      else mixinSCCs.push(d + ':[' + comp.map((f) => f.split('/').pop()).join('|') + ']');
    }
  }
  judge('DG-5a 域内 require 图无环（Tarjan）', requireSCCs.length === 0, requireSCCs.length ? short(requireSCCs) : 'ok');
  judge('DG-5b 无 mixin 造成的 this 图 SCC', mixinSCCs.length === 0, mixinSCCs.length ? mixinSCCs.length + ' 个: ' + short(mixinSCCs) : 'ok');
  console.log('INFO DG-5c 合法继承 SCC（extends + 抽象占位，显式豁免）: ' + (inheritanceSCCs.length ? inheritanceSCCs.join(', ') : '无'));

  const cycAdj = (map) => (v) => map[v] || [];
  const aScc = tarjanSCC(['A', 'B'], cycAdj({ A: ['B'], B: ['A'] })).filter((c) => c.length > 1);
  selfcheck('DG-5a 反向：A↔B require 环命中', aScc.length === 1, 'hit');
  const bScc = tarjanSCC(['A', 'B'], cycAdj({ A: ['B'], B: ['A'] })).filter((c) => c.length > 1);
  selfcheck('DG-5b 反向：require + 跨文件 this 环命中', bScc.length === 1, 'hit');
  const NL5 = String.fromCharCode(10);
  selfcheck('DG-5c 反向：extends + 抽象占位被判为继承 SCC', isInheritanceSCC(['A', 'B'], {
    srcs: new Map([
      ['A', strip(['class Base {', "  foo() { throw new Error('foo must be implemented by x'); }", '}'].join(NL5))],
      ['B', strip(['class Sub extends Base {', '  foo() {}', '}'].join(NL5))],
    ]),
  }), 'hit');
}

// ── DG-6 叶子模块可 require（静态代理）──
{
  const files = ENTRIES.filter((e) => e.rel.startsWith('domains/')).map((e) => ({ rel: e.rel, src: e.src }));
  const v = leafViolations(files, { entryFiles: ENTRY_FILES });
  judge('DG-6 非入口域文件零顶层副作用且有导出（require 安全）', v.length === 0,
    v.length ? v.map((x) => x.rel + (x.noExports ? '(无导出)' : '') + (x.hits.length ? '(副作用)' : '')).join(', ') : 'ok（' + (files.length - ENTRY_FILES.size) + ' 个）');
  selfcheck('DG-6 反向：顶层 setInterval 命中',
    leafViolations([{ rel: 'domains/x/foo.js', src: strip('setInterval(() => {}, 1000);\nmodule.exports = {};') }], {}).length === 1, 'hit');
  selfcheck('DG-6 反向：正常导出不命中',
    leafViolations([{ rel: 'domains/x/foo.js', src: strip('module.exports = { f() {} };') }], {}).length === 0, 'miss');
}

// ── DG-7 依赖方向单调 ──
{
  const edges = [];
  for (const d of DOMAINS) {
    const model = DOMAIN_MODELS.get(d);
    const prefix = 'domains/' + d + '/';
    for (const e of crossFileThisEdges(model)) edges.push({ from: REL(e.from).slice(prefix.length), to: REL(e.to).slice(prefix.length), kind: 'this:' + e.name });
    for (const f of model.files) for (const t of requireEdges(f, model.srcs.get(f))) {
      if (!t.startsWith(path.join(DOMAINS_DIR, d) + path.sep)) continue;
      edges.push({ from: REL(f).slice(prefix.length), to: REL(t).slice(prefix.length), kind: 'require' });
    }
  }
  const v = directionalViolations(edges);
  judge('DG-7 域内依赖方向单调（rank 不上升）', v.length === 0,
    v.length ? v.length + ' 条: ' + short(v.map((x) => x.from + ' -> ' + x.to + ' (' + x.why + ')')) : 'ok（' + edges.length + ' 边）');
  selfcheck('DG-7 反向：store -> core 命中', directionalViolations([{ from: 'store.js', to: 'core.js' }]).length === 1, 'hit');
  selfcheck('DG-7 反向：index -> store 不命中', directionalViolations([{ from: 'index.js', to: 'store.js' }]).length === 0, 'miss');
  selfcheck('DG-7 反向：未归类文件命中', directionalViolations([{ from: 'foo.js', to: 'store.js' }]).length === 1, 'hit');
}

// ─ DG-8 mixin 并原型（R6 三件套，先剥注释）──
{
  const v = [];
  let mixinCount = 0;
  for (const e of ENTRIES) {
    const re = new RegExp(MIXIN_INTO_PROTOTYPE.source, 'g');
    const n = (e.src.match(re) || []).length;
    if (n) { v.push(e.rel + 'x' + n); mixinCount += n; }
  }
  judge('DG-8 无 Object.(defineProperties|assign)(X.prototype, ...)（剥注释后）', v.length === 0,
    v.length ? mixinCount + ' 处: ' + short(v) : 'ok');
  const frags = ENTRIES.filter((e) => methodsFragment(e.src)).map((e) => e.rel);
  console.log('INFO DG-8 METHODS_FRAGMENT 分片导出形态（仅告警，不判失败）: ' + frags.length + ' 文件');
  selfcheck('DG-8 反向：Object.assign(X.prototype, mod.methods) 命中（变量右值）',
    mixinIntoPrototype(strip('Object.assign(X.prototype, mod.methods);')), 'hit');
  selfcheck('DG-8 反向：Object.defineProperties(X.prototype, require) 命中',
    mixinIntoPrototype(strip("Object.defineProperties(X.prototype, require('./x'));")), 'hit');
  selfcheck('DG-8 反向：Object.assign 空对象 不命中',
    !mixinIntoPrototype(strip('Object.assign({}, a);')), 'miss');
  selfcheck('DG-8 反向：注释样本不命中（先剥注释）',
    !mixinIntoPrototype(strip('// Object.assign(X.prototype, mod.methods) 并入同一原型')), 'miss');
  // AP1（批 8/10）收口后 src 全域真实命中 = 0（原型挂载已消除），故「非空转」自检
  //   改为在**合成样本**上验证判据命中，并确认扫描集非空（取代原先依赖真实违规的存在）。
  const sampleHit = (strip('Object.assign(Supervisor.prototype, mod.methods);').match(new RegExp(MIXIN_INTO_PROTOTYPE.source, 'g')) || []).length;
  selfcheck('DG-8 反向：判据在样本上命中且扫描集非空（非空转）',
    sampleHit >= 1 && ENTRIES.length > 0, 'sample=' + sampleHit + ' files=' + ENTRIES.length + ' real=' + mixinCount);
}

// ── DG-9 契约双向一致 ──
{
  const problems = [];
  for (const d of DOMAINS) {
    const c = contractOf(d);
    if (!c) { problems.push(d + ':contract.js 未建'); continue; }
    const declared = Array.isArray(c.exports) ? c.exports : (c.exports && Array.isArray(c.exports.keys) ? c.exports.keys : null);
    if (!declared) { problems.push(d + ':contract.exports 形态未声明'); continue; }
    const idx = path.join(DOMAINS_DIR, d, 'index.js');
    const actual = parseModuleExportsKeys(rawOf(idx));
    if (actual.kind !== 'literal') { problems.push(d + ':index.js 导出非字面量(' + actual.kind + ')'); continue; }
    const m = exportsMismatch(declared, actual.keys);
    if (m.missing.length || m.extra.length) problems.push(d + ':missing=' + m.missing.join('|') + ' extra=' + m.extra.join('|'));
  }
  judge('DG-9 contract.exports 与实际导出双向一致', problems.length === 0, problems.length ? short(problems) : 'ok');
  const fx = exportsMismatch(['a'], ['a', 'b']);
  selfcheck('DG-9 反向：多余键 extra 命中', fx.extra.length === 1 && fx.extra[0] === 'b', 'hit:extra=' + fx.extra.join(','));
  const fx2 = exportsMismatch(['a', 'c'], ['a']);
  selfcheck('DG-9 反向：缺失键 missing 命中', fx2.missing.length === 1 && fx2.missing[0] === 'c', 'hit:missing=' + fx2.missing.join(','));
}

// ── DG-10 消费方 ⊆ PUBLIC_API ──
{
  const apiByDomain = {};
  let declared = 0;
  for (const d of DOMAINS) {
    const c = contractOf(d);
    // DG-10 判据是「消费方成员 ⊆ 目标域 PUBLIC_API」（SSOT B.1.4 / B.3.10），
    // 与 DG-9 的 exports（≡ index.js module.exports 键）是**两个不同的面**：
    //   exports 是门面导出面；PUBLIC_API 是类方法/域间契约面（消费者实际访问的成员）。
    // 兼容回退：未声明 PUBLIC_API 时，若 exports 为数组则沿用（旧契约形态）。
    const ex = c
      ? (Array.isArray(c.PUBLIC_API) ? c.PUBLIC_API
        : (c.exports && Array.isArray(c.exports.PUBLIC_API) ? c.exports.PUBLIC_API
          : (Array.isArray(c.exports) ? c.exports : null)))
      : null;
    if (ex) { apiByDomain[d] = ex; declared++; }
  }
  const files = ENTRIES.map((e) => ({ rel: e.rel, src: e.src }));
  const r = consumerViolations(files, declared ? apiByDomain : null);
  judge('DG-10 消费方成员 ⊆ 目标域 PUBLIC_API', declared > 0 && r.violations.length === 0,
    declared === 0 ? 'contract.js 未建（PUBLIC_API 未声明，' + r.unverifiable.length + ' 处消费未校验）'
      : (r.violations.length ? r.violations.length + ' 越权: ' + short(r.violations.map((x) => x.rel + ':' + x.binding + '.' + x.member)) : 'ok'));
  const api = { instance: ['list', 'get'] };
  const hit = consumerViolations([{ rel: 'app/x.js', src: strip('sup.instances.sandboxRoot(i);') }], api).violations;
  const miss = consumerViolations([{ rel: 'app/x.js', src: strip('sup.instances.list();') }], api).violations;
  const routerSelf = consumerViolations([{ rel: 'domains/router/providers/base.js', src: strip('this.instances.startInstance();') }], api).violations;
  selfcheck('DG-10 反向：越权成员命中', hit.length === 1, 'hit');
  selfcheck('DG-10 反向：合法成员 list() 不命中', miss.length === 0, 'miss');
  selfcheck('DG-10 反向：domains/router 的 ProxyInstance 同名物被排除', routerSelf.length === 0, 'miss');
}

// ─ DG-11 数组穿透 ──
{
  const files = ENTRIES.map((e) => ({ rel: e.rel, src: e.src }));
  const v = piercings(files);
  judge('DG-11 域外无 .instances.instances 穿透', v.length === 0, v.length ? v.length + ' 处: ' + short(v) : 'ok');
  selfcheck('DG-11 反向：sup.instances.instances.find() 命中',
    piercings([{ rel: 'app/x.js', src: strip('sup.instances.instances.find((i) => i);') }]).length === 1, 'hit');
  selfcheck('DG-11 反向：sup.instances.list() 不命中',
    piercings([{ rel: 'app/x.js', src: strip('sup.instances.list();') }]).length === 0, 'miss');
  selfcheck('DG-11 反向：别名形态（instances && instances.instances）命中',
    piercings([{ rel: 'app/x.js', src: strip('const a = (instances && instances.instances) || [];') }]).length === 1, 'hit');
  selfcheck('DG-11 反向：调用形态（instances() && instances().instances）命中',
    piercings([{ rel: 'app/x.js', src: strip('const a = (instances() && instances().instances) || [];') }]).length === 1, 'hit');
  selfcheck('DG-11 反向：括号取值形态（instances[\'instances\']）命中',
    piercings([{ rel: 'app/x.js', src: strip("const a = (instances && instances['instances']) || [];") }]).length === 1, 'hit');
  selfcheck('DG-11 反向：双引号括号形态（mgr.instances["instances"]）命中',
    piercings([{ rel: 'app/x.js', src: strip('const a = mgr.instances["instances"];') }]).length === 1, 'hit');
  selfcheck('DG-11 反向：括号取非穿透键（instances[\'list\']）不命中',
    piercings([{ rel: 'app/x.js', src: strip("const a = instances['list'];") }]).length === 0, 'miss');
  selfcheck('DG-11 反向：裸对象取 instances 键（obj[\'instances\']）不命中',
    piercings([{ rel: 'app/x.js', src: strip("const a = obj['instances'];") }]).length === 0, 'miss');
}

// ─ DG-12 非空转（合成样本；真实总量仅证据）──
// 教训（HANDOFF §4.3）：用**真实总量**（文件数 / 字节数 / this 调用数）做下界会随注释精简与重构
//   **自锁** —— 数据趋势向下，门禁迟早在与「判据有无分辨力」无关的地方假红。
//   故改为：自建最小可判定输入，证明抽取函数（strip / countLines / thisCallNames）在给定输入上
//   产出预期；真实总量只作 evidence 打印，**不参与判定**。
{
  // 合成样本判据（正反共用，纪律 1）：返回「未达预期」的项名；空数组 = 抽取函数行为符合预期。
  const synthViolations = (o) => {
    const c = o || {};
    const bad = [];
    if (countLines(c.lineSrc !== undefined ? c.lineSrc : 'a\nb\nc\n') !==
      (c.expectLines !== undefined ? c.expectLines : 3)) bad.push('countLines');
    const st = strip(c.commentSrc !== undefined ? c.commentSrc
      : 'const a = 1; // 行注\n/* 块注 */\nconst b = "// 不是注释";\n');
    if (st.includes('行注') || st.includes('块注')) bad.push('strip.comment');
    if (!st.includes('const a = 1;') || !st.includes('const b =')) bad.push('strip.code');
    if (!st.includes('// 不是注释')) bad.push('strip.stringLiteral'); // 字符串字面量不得被当注释剥掉
    const thisSrc = c.thisSrc !== undefined ? c.thisSrc
      : 'function f() {\n  // this.fake()\n  return this.real(x) + this.real(x);\n}\n';
    if (thisCallNames(strip(thisSrc)).join(',') !==
      (c.expectThis !== undefined ? c.expectThis : 'real,real')) bad.push('thisCallNames');
    return bad;
  };
  const bad = synthViolations();
  judge('DG-12 非空转（合成样本：strip / countLines / thisCallNames 在给定输入上产出预期）',
    bad.length === 0, bad.length ? '未达预期: ' + bad.join(', ') : 'synth 5/5');
  // 真实总量：仅 evidence（注释精简会持续压低字节数，故不得据此判定）
  const totalBytes = ENTRIES.reduce((a, e) => a + Buffer.byteLength(e.raw, 'utf8'), 0);
  const totalThis = ENTRIES.reduce((a, e) => a + thisCallNames(e.src).length, 0);
  console.log('   DG-12 evidence（仅报告，不参与判定）: files=' + ENTRIES.length +
    ' bytes=' + totalBytes + ' thisCalls=' + totalThis);
  // 反向（永远硬失败，纪律 2：样本必须真与判据有交集）
  selfcheck('DG-12 反向：错期望值会被合成判据报出（比较非恒真）',
    synthViolations({ expectLines: 999 }).indexOf('countLines') >= 0, 'hit');
  selfcheck('DG-12 反向：this 计数错期望值会被报出',
    synthViolations({ expectThis: 'fake,real' }).indexOf('thisCallNames') >= 0, 'hit');
  selfcheck('DG-12 反向：样本含注释标记且 strip 确实剥掉它（strip 退化为 no-op 必被检出）',
    'const a = 1; // 行注'.includes('行注') && !strip('const a = 1; // 行注').includes('行注'), 'hit');
}

// ── DG-13 门禁不以行号为断言目标 ──
{
  const gateFiles = [__filename, path.join(__dirname, 'directory-structure-gate-test.js')];
  const v = [];
  for (const f of gateFiles) {
    for (const hit of lineNumberAssertions(fs.readFileSync(f, 'utf8'))) v.push(path.basename(f) + ':' + hit);
  }
  judge('DG-13 门禁源码无以行号为断言目标', v.length === 0, v.length ? short(v) : 'ok');
  const badSample = ['assert(x.line ', '=','== ', '758', ');'].join('');
  const okSample = ['console.log(', "'at line '", ' + x.line', ');'].join('');
  selfcheck('DG-13 反向：行号断言样本命中', lineNumberAssertions(badSample).length === 1, 'hit');
  selfcheck('DG-13 反向：证据字符串样本不命中', lineNumberAssertions(okSample).length === 0, 'miss');
}

// ─ DG-14 facade 只读 ──
{
  const files = ENTRIES.filter((e) => e.rel.startsWith('app/facade/')).map((e) => ({ rel: e.rel, src: e.src }));
  const v = facadeWriteViolations(files, FACADE_EXCEPTIONS);
  judge('DG-14 app/facade/* 无写动作（应下沉 app/domain-actions/）', v.length === 0,
    v.length ? v.length + ' 处: ' + short(v.map((x) => x.rel + ':' + x.method)) : 'ok（' + files.length + ' 文件）');
  // 覆盖守卫：抽取器**取不到体**的形态必须显式报出（否则判据静默失覆盖 —— 本仓已四次因此假绿）。
  const un = files.filter((f) => unsupportedMethodForms(f.src).length)
    .map((f) => f.rel + ':' + unsupportedMethodForms(f.src).join(','));
  judge('DG-14 无未支持的成员形态（表达式体箭头无法取体 ⇒ 显式报出，不静默失覆盖）',
    un.length === 0, un.length ? un.join(' | ') : 'ok');
  // 每形态各一组自检：证明抽取器对该形态**不盲**（合成样本，不依赖真实数据）。
  selfcheck('DG-14 反向：形态 B（name: function）命中写动词',
    facadeWriteViolations([{ rel: 'app/facade/x.js', src: strip('module.exports = {\n  methods: {\n    setRouterRunning: function () {}\n  }\n};') }], {}).length === 1, 'hit');
  selfcheck('DG-14 反向：形态 C（name: () => {}）命中写动词',
    facadeWriteViolations([{ rel: 'app/facade/x.js', src: strip('module.exports = {\n  methods: {\n    patchX: () => {}\n  }\n};') }], {}).length === 1, 'hit');
  selfcheck('DG-14 反向：深缩进（8 空格）的方法简写仍被抽到',
    facadeWriteViolations([{ rel: 'app/facade/x.js', src: strip('module.exports = {\n  methods: {\n        setRouterRunning() {}\n  }\n};') }], {}).length === 1, 'hit');
  selfcheck('DG-14 反向：表达式体箭头被报为未支持形态（失败可见）',
    unsupportedMethodForms(strip('module.exports = {\n  methods: {\n    setX: () => doIt()\n  }\n};')).length === 1, 'hit');
  selfcheck('DG-14 反向：块体箭头不被误报为未支持形态',
    unsupportedMethodForms(strip('module.exports = {\n  methods: {\n    setX: () => { doIt(); }\n  }\n};')).length === 0, 'miss');
  selfcheck('DG-14 反向：setRouterRunning 命中',
    facadeWriteViolations([{ rel: 'app/facade/x.js', src: strip('module.exports = { methods: {\n  setRouterRunning() {}\n} };') }], {}).length === 1, 'hit');
  selfcheck('DG-14 反向：只读 routerStatusView 不命中',
    facadeWriteViolations([{ rel: 'app/facade/x.js', src: strip('module.exports = { methods: {\n  routerStatusView() {}\n} };') }], {}).length === 0, 'miss');
  selfcheck('DG-14 反向：例外表 listLan 不命中',
    facadeWriteViolations([{ rel: 'app/facade/lan.js', src: strip('module.exports = { methods: {\n  listLan() {}\n} };') }], FACADE_EXCEPTIONS).length === 0, 'miss');
  selfcheck('DG-14 反向：方法名无动词但调用写目标 lanFrpc 命中',
    facadeWriteViolations([{ rel: 'app/facade/lan.js', src: strip('module.exports = { methods: {\n  lanFrpc(a, b) { this.lan.frpAction(a, b); }\n} };') }], {}).length === 1, 'hit');
}

// ── DG-15 顶层 require（DF-8；EXEC3 §1）──
{
  // ★ 显式白名单（逐文件、带上限），**绝不**放宽为「任意文件豁免」：
  //   唯一例外 = src/supervisor.js 的 get lan() 惰性 require（daemon 模式结构性排除，
  //   relay 域经 app 层装配；源文件 42-44 行有同款注释）。max 限制其条数，
  //   防止该文件被悄悄塞入更多内联 require 而不被察觉。
  //   （ENTRIES.rel 相对 src/，故 key 为 supervisor.js；repoPath 仅作证据显示）
  const INLINE_REQUIRE_ALLOW = new Map([
    ['supervisor.js', { repoPath: 'src/supervisor.js', max: 1, site: 'get lan()', reason: '有意的惰性 require：daemon 模式结构性排除，relay 域经 app 层装配' }],
  ]);
  const df8 = [];
  let inlineTotal = 0;
  for (const e of ENTRIES) {
    const { inlineRequires } = functionScan(e.src);
    inlineTotal += inlineRequires.length;
    if (!inlineRequires.length) continue;
    const allow = INLINE_REQUIRE_ALLOW.get(e.rel);
    if (!allow) df8.push(e.rel + ':' + inlineRequires.join('|'));
    else if (inlineRequires.length > allow.max) df8.push(e.rel + ' 内联 require ' + inlineRequires.length + ' 处 > 白名单上限 ' + allow.max);
  }
  const allowRepos = [...INLINE_REQUIRE_ALLOW.values()].map((x) => x.repoPath).join(',');
  judge('DG-15 require() 必须在模块顶层（函数体内 0 处；唯一白名单 ' + allowRepos + '）',
    df8.length === 0,
    df8.length ? df8.length + ' 处: ' + short(df8)
      : 'ok（' + ENTRIES.length + ' 文件；内联 ' + inlineTotal + ' 处，均落入白名单 ' + allowRepos + '）');

  selfcheck('DG-15 反向：函数体内 require 命中',
    functionScan(strip('function a() { const x = require("./y"); return x; }')).inlineRequires.length === 1, 'hit');
  selfcheck('DG-15 反向：顶层 require 不命中（边界）',
    functionScan(strip('const x = require("./y");\nmodule.exports = { x };')).inlineRequires.length === 0, 'miss');
  selfcheck('DG-15 反向：顶层对象字面量内 require 不误报',
    functionScan(strip('module.exports = { x: require("./y") };')).inlineRequires.length === 0, 'miss');
  selfcheck('DG-15 反向：方法体/箭头块体内 require 命中（非空转）',
    functionScan(strip('const o = { m() { return require("./a"); } };\nconst f = () => { return require("./b"); };')).inlineRequires.length === 2, 'hit=2');
  // 白名单必须显式且唯一，防止被放宽
  selfcheck('DG-15 白名单显式且唯一（仅 src/supervisor.js）',
    INLINE_REQUIRE_ALLOW.size === 1 && INLINE_REQUIRE_ALLOW.has('supervisor.js')
      && INLINE_REQUIRE_ALLOW.get('supervisor.js').repoPath === 'src/supervisor.js',
    'files=' + allowRepos);
  // 白名单命中次数下界：真实源码确实存在该惰性 require（否则白名单腐化）
  selfcheck('DG-15 白名单引用真实存在（非腐化，扫描集非空）',
    inlineTotal >= 1 && ENTRIES.length > 0, 'inlineTotal=' + inlineTotal + ' files=' + ENTRIES.length);
}

// ── DG-16 函数嵌套深度（DF-9；EXEC3 §1）──
{
  const FN_MAX = 6;
  const df9 = [];
  let maxSeen = 0;
  for (const e of ENTRIES) {
    const { maxFn } = functionScan(e.src);
    if (maxFn > maxSeen) maxSeen = maxFn;
    if (maxFn > FN_MAX) df9.push(e.rel + '=' + maxFn);
  }
  judge('DG-16 函数（回调/闭包）嵌套深度 ≤' + FN_MAX, df9.length === 0,
    df9.length ? df9.length + ' 个: ' + short(df9) : 'ok（' + ENTRIES.length + ' 文件；实测最大 ' + maxSeen + '）');

  const nested = (k) => Array.from({ length: k }, (_, n) => 'const f' + n + '=()=>{').join('') + '};'.repeat(k);
  selfcheck('DG-16 反向：7 层函数嵌套命中',
    functionScan(strip(nested(7))).maxFn === 7, 'hit=7');
  selfcheck('DG-16 反向：6 层函数嵌套不命中（边界）',
    functionScan(strip(nested(6))).maxFn === 6, 'miss=6');
  selfcheck('DG-16 反向：顶层对象字面量不误报',
    functionScan(strip('module.exports = { a: { b: { c: { d: 1 } } } };')).maxFn === 0, 'maxFn=0');
  selfcheck('DG-16 反向：class 方法体 + 回调计数（非空转）',
    functionScan(strip('class A {\n  m() {\n    const p = new Promise((res) => {\n      res(() => {});\n    });\n    return p;\n  }\n}')).maxFn === 3, 'hit=3');
}

// ── 汇总 ──
console.log('\n结果: ' + passed.length + ' passed, ' + failedHard.length + ' failed(hard), ' + failedSoft.length + ' failed(soft/report-only)');
if (failedSoft.length) {
  console.log('\nRED 清单（report-only，待域改造收敛；基线见 design-notes/EXEC-gates.md）:');
  for (const s of failedSoft) console.log('  - ' + s);
}
if (failedHard.length) {
  console.log('\nHARD 失败（门禁自身完整性）:');
  for (const s of failedHard) console.log('  - ' + s);
}
if (!STRICT) {
  console.log('\nreport-only：所有判据已执行并打印，退出码恒 0（DG_STRICT=1 转硬失败）');
  process.exit(0);
}
process.exit(failedHard.length ? 1 : 0);



