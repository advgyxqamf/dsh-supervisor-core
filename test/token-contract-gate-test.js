#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// DSH 令牌契约门禁（TK-G1..TK-G8）—— SSOT: DSH-TOKEN-CONTRACT.md §1/§2/§4/§5/§6
//
// 为什么需要这道门禁：令牌正在从「散落各模块」收敛为 src/platform/service/token/ 基础组件，
//   且由多个分片并行施工。契约若只活在文档里，分片各自「改完即绿」会让铁律 TK-1..TK-8
//   静默退化——历史上 adopt 令牌接管（_maybeReclaimAdoptToken）正是把「令牌拿不到」
//   当成故障去重启进程（TK-2 的反例），并且 token.js 用 rmSync 清空了唯一持久链路（TK-6 反例）。
//   故把 §6 的八条断言落成**可执行判据**：读源码 / 真实构造，逐条 PASS/FAIL。
//
// 为什么大多用源码级判据：「缓存字段 / 清空式删除 / 令牌进 argv」这三种退化在运行期
//   极难观测（要么不触发、要么已被日志脱敏），静态判据最可靠；唯独 TK-G4（lan-state.json
//   的 tokens 段）有确定的落点，故用真实构造做行为级判定。
//
// 判据与反向共用同一批函数（TK-G8）：判据若空转，反向断言会先失败——门禁不允许自证清白。
//
// ⚠ 分片并行改造期间，依赖尚未落地的门禁（如 G5 的 relay 按需读改造）可能 FAIL：
//   这是**如实报告**，绝不放宽断言去「变绿」。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
// DS-G4（§4.2 反转法）：§1 全部 kind 的**声明**已上移到 app/settings/token-kinds.js ——
//   platform/service/token/kinds.js 现为「空注册表 + 注册接口」。本门禁判的是**最终登记结果**
//   （与生产装配一致），故须先 require 注入声明（require 即注入），再读 kinds.js。
//   ⚠ 这不是放宽断言：7 类 kind 仍须全部登记，缺一即 FAIL（同测另有反向自检）。
require(path.join(ROOT, 'src', 'app', 'settings', 'token-kinds'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail !== undefined && detail !== '' ? '  <- ' + detail : ''));
}

/* ═════════════════════ 扫描工具 ═════════════════════ */

// 去注释（行/块/字符串/模板/正则字面量）。
// 为什么必须识别正则字面量：本仓有大量「引号 + 斜杠」混合的正则；朴素扫描器会把正则里的引号
//   当成字符串起点，于是其后整段代码被误判为字符串——门禁会因此**漏报**（exec-bounded 的教训）。
// 正则字面量在**两种模式下都抹平**：正则是「模式」不是代码，里面的 token= / lanToken 字面
//   会骗过 G5/G7（本仓 relay 的 /dsh_lan_token=/ 即实例）。
// blankStrings=false（codeOf）：保留字符串内容——G6 需要看字符串里的 ?token=（令牌 URL 是字面量）。
// blankStrings=true （structOf）：把字符串/模板内容抹成空格但**长度与换行不变**，供
//   大括号配平（methodBody/switchBlocks/enclosingFnRange）与标识符级判定（G5/G7）使用。
//   ⚠ 需要看字符串内容时（如 G6）必须用 codeOf，否则判据会假绿。
// 已知限制：模板内的插值表达式按「模板内容」整体抹平（本门禁定位的两个方法不含嵌套模板）。
function stripSource(src, blankStrings) {
  var BT = String.fromCharCode(96);
  var out = '';
  var i = 0;
  var state = 'code'; // code | line | block | sq | dq | tpl | regex | regexClass
  var prev = '';
  while (i < src.length) {
    var c = src[i];
    var n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; prev = c; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; prev = c; continue; }
      if (c === BT) { state = 'tpl'; out += c; i++; prev = c; continue; }
      if (c === '/') {
        // 正则 vs 除号：只看前一个有意义字符（正则只能出现在运算符/语句开头之后）
        var regexOk = prev === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0;
        if (regexOk) { state = 'regex'; out += c; i++; continue; }
      }
      if (!/\s/.test(c)) prev = c;
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n'; } else { out += ' '; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n') ? '\n' : ' '; i++; continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { out += blankStrings ? '  ' : (c + (n || '')); i += 2; continue; }
      var closer = (state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === BT);
      out += blankStrings ? ((c === '\n') ? '\n' : ' ') : c;
      if (closer) { state = 'code'; prev = c; }
      i++; continue;
    }
    if (state === 'regex' || state === 'regexClass') {
      // 正则字面量内容**两种模式都抹平**：正则是「模式」不是代码，里面的 token= / lanToken 字面
      //   会骗过 G5/G6/G7——本仓 relay 的 /dsh_lan_token=/ 与 token.js 的解析正则就是实例。
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (state === 'regex' && c === '[') state = 'regexClass';
      else if (state === 'regexClass' && c === ']') state = 'regex';
      else if (state === 'regex' && c === '/') { state = 'code'; prev = '/'; }
      out += (c === '\n') ? '\n' : ' ';
      i++; continue;
    }
    out += c; i++;
  }
  return out;
}

var _structCache = {};
var _codeCache = {};
function codeOf(rel) {
  if (!_codeCache[rel]) _codeCache[rel] = stripSource(fs.readFileSync(path.join(ROOT, rel), 'utf8'), false);
  return _codeCache[rel];
}
function structOf(rel) {
  if (!_structCache[rel]) _structCache[rel] = stripSource(fs.readFileSync(path.join(ROOT, rel), 'utf8'), true);
  return _structCache[rel];
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

function walkJs(dir, out) {
  var ents = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < ents.length; i++) {
    var e = ents[i];
    if (e.name === 'node_modules' || e.name === '.git') continue;
    var p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
}
var SRC_FILES = (function () { var o = []; walkJs(path.join(ROOT, 'src'), o); return o; })();

// 「令牌组件」= §3 目标目录 src/platform/service/token/**。TK-4/TK-5 只允许该范围内持有令牌存储。
//   ⚠ 2026-09-16 复检清理：原先还兼容"过渡期的单文件 src/platform/service/token.js" ——
//     该文件已随组件目录化**删除**，兼容分支随之成为死代码（留着会让后来者以为它仍可能存在）。
function isTokenComponent(rel) { return rel.indexOf('src/platform/service/token/') === 0; }

function parenClose(code, openIdx) {
  var d = 0;
  for (var i = openIdx; i < code.length; i++) {
    if (code[i] === '(') d++;
    else if (code[i] === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

// 取原型方法体（含大括号）。必须传入 structOf 的产物（字符串已抹平，大括号配平可靠）。
function methodBody(structCode, name) {
  var re = new RegExp('(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{');
  var m = re.exec(structCode);
  if (!m) return null;
  var open = m.index + m[0].length - 1; // 指向方法体开括号
  var d = 0;
  for (var i = open; i < structCode.length; i++) {
    if (structCode[i] === '{') d++;
    else if (structCode[i] === '}') { d--; if (d === 0) return structCode.slice(open, i + 1); }
  }
  return null;
}

// 取代码中所有 switch 块（含偏移，便于回到「字符串可见」的版本里判定）。
function switchBlocks(code) {
  var out = [];
  var re = /\bswitch\s*\(/g;
  var m;
  while ((m = re.exec(code))) {
    var openP = code.indexOf('(', m.index);
    var closeP = parenClose(code, openP);
    if (closeP < 0) continue;
    var openB = code.indexOf('{', closeP);
    if (openB < 0) continue;
    var d = 0;
    for (var i = openB; i < code.length; i++) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') {
        d--;
        if (d === 0) { out.push({ start: openB, end: i + 1 }); re.lastIndex = i + 1; break; }
      }
    }
  }
  return out;
}

/* ═════════════════════ 判据集（G8 反向复用同一批函数） ═════════════════════ */

// ── TK-G2：令牌不得驱动生命周期（TK-2）──
// 旧形态的四个特征：接管回收函数名 + 两个观察窗状态字段 + 触发重启的事件原因串。
// 只查函数名不够（改名即可绕过），故把「重启原因串」也纳入——它是耦合的最终落点。
var G2_MARKERS = ['_maybeReclaimAdoptToken', '_tokenReclaimAt', '_tokenReclaimTried', 'adopt_token_reclaim'];
function reclaimMarkerHitsIn(code) {
  var hits = [];
  for (var i = 0; i < G2_MARKERS.length; i++) {
    var re = new RegExp('\\b' + G2_MARKERS[i] + '\\b', 'g');
    var m;
    while ((m = re.exec(code))) hits.push(G2_MARKERS[i] + '@' + lineOf(code, m.index));
  }
  return hits;
}

// 在 _dshConverge 的 phase 迁移 switch 内**任何** token 字样都算违规：
// 令牌状态与进程健康正交（TK-2），phase 迁移决策里出现令牌读取即为耦合。
// 返回 null 表示结构没定位到（要让门禁显式报「需人工核对」，不能默默通过）。
function phaseSwitchTokenHitsIn(structCode, visibleCode) {
  var body = methodBody(structCode, '_dshConverge');
  if (body === null) return null;
  var base = structCode.indexOf(body);
  var blocks = switchBlocks(body);
  if (!blocks.length) return null;
  var hits = [];
  for (var i = 0; i < blocks.length; i++) {
    // 回到「字符串可见」的版本取同一偏移：防止令牌读取藏在字符串参数里（如 _beginRestart('adopt_token_reclaim')）
    var seg = visibleCode.slice(base + blocks[i].start, base + blocks[i].end);
    var re = /[Tt]oken/g;
    var m;
    while ((m = re.exec(seg))) {
      hits.push(lineOf(visibleCode, base + blocks[i].start + m.index) + ':' + seg.slice(m.index, m.index + 28).split('\n')[0]);
    }
  }
  return hits;
}

// ── TK-G3：持久化无清空式删除（TK-6）──
// 判据只认「**整文件级**清空式删除」：rmSync / rmdirSync。
//   · 为什么排除 unlinkSync：原子写必须能清理自己的 .tmp 临时文件、轮转必须能删**过旧备份**
//     ——这些都是「清理附属物」，不是「清空唯一持久链路」。旧 token.js 的反例是 fs.rmSync(fp)
//     删掉 primary 本体；用「是否删除 primary」辨别才不会误伤轮转实现（判据必须精确，不能为空转放宽）。
//   · 命中会连所在语句一并回报，供人核对落点（rmSync(tmp) 与 rmSync(fp) 是不同语义）。
function clearingDeleteHitsIn(code) {
  var hits = [];
  var re = /\b(?:rmSync|rmdirSync)\b/g;
  var m;
  while ((m = re.exec(code))) hits.push(lineOf(code, m.index) + ':' + code.slice(m.index, m.index + 44).split('\n')[0].trim());
  return hits;
}
// TK-6 的另一半（正向）：超限必须**轮转**而不是丢内容。只断言「无删除」不足以锁住语义——
//   若实现把超限逻辑整段删掉，无删除断言照样通过（门禁空转）。故同时要求轮转设施在场。
function hasRotationFacilityIn(code) {
  return /\brotate\w*\s*\(/.test(code) || /\bfunction\s+\w*[Rr]otate/.test(code);
}

// ── TK-G5：除令牌组件外无令牌缓存成员（TK-4）──
// 违规形态 = 「**持久**存值」的令牌标识符赋值：
//   · 成员字段：this.dshToken = / proxy.dshToken = （跨调用存活 = 缓存）
//   · 箭头/函数**形参默认值**：onChange((id, token = '') …)（遮蔽并缓存服务值）
//   · 非函数作用域内的**裸变量**：relay 单文件实现里的 let dshToken = o.dshToken || ''（闭包内跨请求存活）
// 排除三类**合法**赋值（判据要精确，否则会误伤业务逻辑，而不是放宽门禁）：
//   · 用户配置类字段 remoteToken/frpRemoteToken（§1 #4/#6：本来就持久化在配置里，不是 DSH 令牌缓存）；
//   · set/has/on/get 开头的**访问器/入口函数定义**（赋值的是函数，不是令牌值）；
//   · 函数体内的**局部变量**：requestToken / queryToken 等按请求现取现用，是「按需读取」的正面实现。
// 负向样例（G8）与判定共用本函数，防止判据退化成空转。
var G5_ALLOW_NAMES = { remoteToken: 1, frpRemoteToken: 1 };
function lineIndent(line) {
  var m = /^[ \t]*/.exec(line);
  return m ? m[0].length : 0;
}
// 该「块首行」是不是函数头（而非 if/for/try 等控制块）：控制块绝不能被当成函数作用域。
function isFnHeader(lineText) {
  var t = String(lineText).trim();
  if (/^(?:if|for|while|switch|catch|do|else|try|finally)\b/.test(t)) return false;
  return /(?:\bfunction\b|=>|\)\s*\{|\w\s*:\s*(?:async\s*)?(?:function|\())/.test(t);
}
// 语句索引 idx 所在的**最内层函数体**区间；不在任何函数内（模块/类体顶层）返回 null。
// 为什么要定位作用域：同名局部变量在**不同函数**里各出现一次是完全正常的按需读取
// （relay 里 hasValidToken 与 tokenGate 各有一个 queryToken）；只有「同一函数内多次赋值」
// 或「顶层裸变量」才是跨调用存活的缓存。按文件计数会把正常代码误判（判据要精确）。
function enclosingFnRange(code, idx) {
  var d = 0;
  var open = -1;
  for (var i = idx - 1; i >= 0; i--) {
    if (code[i] === '}') d++;
    else if (code[i] === '{') {
      if (d > 0) { d--; continue; }
      var lineStart = code.lastIndexOf('\n', i) + 1;
      // 取到 '{' 本身：函数头判定依赖 `) {` / `=>`，切掉花括号会漏判普通方法
      if (isFnHeader(code.slice(lineStart, i + 1))) { open = i; break; }
      // 控制块：继续向外找函数头
    }
  }
  if (open < 0) return null;
  var dd = 0;
  for (var j = open; j < code.length; j++) {
    if (code[j] === '{') dd++;
    else if (code[j] === '}') { dd--; if (dd === 0) return { start: open, end: j + 1 }; }
  }
  return null;
}
// 同一标识符在**同一函数作用域内**的赋值次数（声明 + 后续重赋值）。
// 判据核心：按需读取的请求局部变量只赋一次；缓存必然「建时赋一次、轮换再赋一次」。
function assignCount(code, name, range) {
  var code2 = range ? code.slice(range.start, range.end) : code;
  var re = new RegExp('(?:^|[^\\w$.])' + name + '\\s*=(?!=)', 'g');
  var n = 0;
  while (re.exec(code2)) n++;
  return n;
}
function tokenCacheHitsIn(code) {
  var hits = [];
  var re = /(?:^|[^\w$.])(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*[Tt]oken)\s*=(?!=)/g;
  var m;
  while ((m = re.exec(code))) {
    var name = m[2];
    if (G5_ALLOW_NAMES[name]) continue;
    if (/^(?:set|get|has|on|is|with)[A-Z_]/.test(name)) continue;
    var isMember = !!m[1];
    if (!isMember) {
      var stmt = code.slice(code.lastIndexOf(';', m.index) + 1, m.index);
      if (/\([^;]*$/.test(stmt)) continue;          // 形参默认值：作用域仅限该次调用
      // 只赋一次的请求局部变量 = 按需读取（正面实现）；同作用域多次赋值 / 顶层裸变量 = 缓存
      var fnRange = enclosingFnRange(code, m.index);
      if (fnRange && assignCount(code, name, fnRange) <= 1) continue;
    }
    hits.push(lineOf(code, m.index) + ':' + (m[1] ? m[1] + '.' : '') + name + ' =');
  }
  return hits;
}

// ── TK-G6：令牌不进 argv/URL（browser.js 调用点）──
// browser.js 的 open/launchIsolated 会把 url 原样塞进 spawn argv——?token= 一进 argv，
// 同机任意进程都能经 ps 看到会话令牌（浏览器打开 URL 属「令牌进 URL」，见 SSOT §6 TK-G6）。
// 取函数头文本（方法/函数声明所在行，含左花括号）。
function fnHeaderOf(code, range) {
  var lineStart = code.lastIndexOf('\n', range.start) + 1;
  return code.slice(lineStart, range.start + 1);
}
// 从函数头取函数名（声明式 / 对象方法 / 赋值式三种写法）。
function fnNameOf(header) {
  var m = /\bfunction\s+([A-Za-z_$][\w$]*)/.exec(header);
  if (m) return m[1];
  m = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/.exec(header);
  if (m) return m[1];
  m = /([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{?\s*$/.exec(header);
  return m ? m[1] : null;
}
// 从函数头取形参名（简单拆分；形参默认值里的嵌套括号不在本门禁需要覆盖的形态内）。
function fnParamsOf(header) {
  // 允许尾部左花括号：函数头形态是 `name(params) {`，用 [^{]*$ 会因尾部的 '{' 匹配失败
  var m = /\(([^()]*)\)\s*\{?\s*$/.exec(header);
  if (!m) return null;
  return m[1].split(',').map(function (s) { return s.trim().split('=')[0].trim(); }).filter(Boolean);
}
// 顶层逗号切分实参（忽略括号/引号内的逗号）。
function splitTopLevelArgs(text) {
  var out = [];
  var depth = 0;
  var quote = null;
  var cur = '';
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += (text[i + 1] || ''); i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.indexOf(c) >= 0) depth++;
    else if (')]}'.indexOf(c) >= 0) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}
// 找出「把某个形参原样转交给 browser.open/launchIsolated」的中间函数。
// 为什么要跨这一跳：令牌只要经中间函数最终进了 spawn argv，危害与直接拼接相同；
// 只看调用点文本会被「先存变量、再交给 helper」绕过（api/domains/instances.js 的真实形态）。
function tokenForwardersIn(code) {
  var out = [];
  var re = /browser\s*\.\s*(?:open|launchIsolated)\s*\(/g;
  var m;
  while ((m = re.exec(code))) {
    var openP = code.indexOf('(', m.index);
    var closeP = parenClose(code, openP);
    if (closeP < 0) continue;
    var arg = code.slice(openP + 1, closeP).trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(arg)) continue; // 只认「原样转交单个标识符」
    var range = enclosingFnRange(code, m.index);
    if (!range) continue;
    var header = fnHeaderOf(code, range);
    var params = fnParamsOf(header);
    var name = fnNameOf(header);
    if (!name || !params) continue;
    var idx = params.indexOf(arg);
    // headerStart：函数头行首。反查调用方时必须连**声明本身**一起排除，
    // 否则 `function name(...)` 里的函数名会被当成一次调用（令牌误算到声明行）。
    var headerStart = code.lastIndexOf('\n', range.start) + 1;
    if (idx >= 0) out.push({ name: name, paramName: arg, index: idx, range: range, headerStart: headerStart });
  }
  return out;
}

// 返回 { sites, hits }：sites = 扫描到的「令牌可进入 browser argv」的路径数（供非空转断言），
// hits = 违规明细。
// ⚠ 必须传**字符串可见**的源码（codeOf）：令牌 URL 是字符串字面量，用抹平字符串的版本扫描
//   会一律看不到 ?token= —— 门禁会假绿（本门禁初版即踩此坑，由 G8 反向断言抓出）。
//
// 覆盖两层路径：
//   ① 直接调用 platform.browser.open/launchIsolated 且实参含令牌；
//   ② 经中间封装转交（本仓真实形态 api/domains/instances.js）：
//        const url = '...?token=' + tok;  openInSystemBrowser(url);
//        function openInSystemBrowser(url) { return platform.browser.open(url); }
//      此时违规发生在**封装的调用点**，故须反查每个调用方传进来的实参。
function browserTokenScanIn(rel, code) {
  var hits = [];
  var sites = 0;
  var forwarders = tokenForwardersIn(code);
  var re = /browser\s*\.\s*(?:open|launchIsolated)\s*\(/g;
  var m;
  while ((m = re.exec(code))) {
    var openP = code.indexOf('(', m.index);
    var closeP = parenClose(code, openP);
    if (closeP < 0) continue;
    var args = code.slice(openP + 1, closeP);
    var ln = lineOf(code, m.index);
    var owner = enclosingFnRange(code, m.index);
    var ownerName = owner ? fnNameOf(fnHeaderOf(code, owner)) : null;
    var isForwarder = forwarders.some(function (f) { return f.name === ownerName && f.range.start === (owner && owner.start); });
    if (isForwarder) continue; // ② 由下方 tokenForwardersIn 反查调用方；此处不重复计
    sites++;
    if (/\?token=/.test(args)) { hits.push(rel + ':' + ln + ' 实参直接含 ?token='); continue; }
    var ids = args.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
    var bad = [];
    for (var i = 0; i < ids.length; i++) {
      var declLine = findDeclWithToken(code, ids[i]);
      if (declLine) bad.push(ids[i] + '(第 ' + declLine + ' 行声明含令牌)');
    }
    if (bad.length) hits.push(rel + ':' + ln + ' 经令牌值 ' + bad.join(',') + ' 进入 browser argv');
  }
  // ② 中间封装的调用点：把含令牌的实参传进去，最终仍进 browser argv
  forwarders.forEach(function (f) {
    var callLines = forwarderCallSitesWithToken(code, f);
    callLines.forEach(function (cl) {
      sites++;
      hits.push(rel + ':' + cl + ' 经 ' + f.name + ' 第 ' + (f.index + 1) + ' 个实参把令牌带入 browser argv');
    });
  });
  return { sites: sites, hits: hits };
}
// 中间封装的每个调用点：若传给 f.index 位置实参的值含令牌，返回该调用点行号。
function forwarderCallSitesWithToken(code, f) {
  var out = [];
  var re = new RegExp('(?<![\\w$.])' + f.name + '\\s*\\(', 'g');
  var m;
  while ((m = re.exec(code))) {
    if (m.index >= f.headerStart && m.index <= f.range.end) continue; // 跳过声明本身（含函数头）
    var openP = code.indexOf('(', m.index);
    var closeP = parenClose(code, openP);
    if (closeP < 0) continue;
    var parts = splitTopLevelArgs(code.slice(openP + 1, closeP));
    var passed = parts[f.index] || '';
    if (/\?token=/.test(passed)) { out.push(lineOf(code, m.index)); continue; }
    var names = passed.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
    for (var i = 0; i < names.length; i++) {
      var dl = findDeclWithToken(code, names[i]);
      if (dl) { out.push(lineOf(code, m.index)); break; }
    }
  }
  return out;
}
// 标识符是否在某处被赋值为含 ?token= 的表达式；返回该行号或 0。
function findDeclWithToken(code, id) {
  var re = new RegExp('(?:\\b(?:const|let|var)\\s+|\\b)' + id + '\\s*=\\s*([^;]*)', 'g');
  var m;
  while ((m = re.exec(code))) { if (/\?token=/.test(m[1])) return lineOf(code, m.index); }
  return 0;
}

// ── TK-G7：幽灵键零引用 ──
// 判在**去注释后**的代码上：历史注释会解释「lanToken 已废弃」，那不算引用（否则门禁永远红）。
// 键名以 kinds.js 的 GHOST_KEYS 为权威（幽灵键在唯一分类表里显式登记）——
// 这样分类表新增幽灵键时门禁自动覆盖，不会留下没人守的幽灵键。
function ghostKeyHitsIn(rel, code, keys) {
  var hits = [];
  (keys && keys.length ? keys : ['lanToken']).forEach(function (key) {
    var re = new RegExp('\\b' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    var m;
    while ((m = re.exec(code))) hits.push(rel + ':' + lineOf(code, m.index) + ':' + key);
  });
  return hits;
}

// ── TK-G4：lan-state.json 的 tokens 段只含 DSH 侧令牌（TK-7）──
// tokens 段是 daemon 用来换 dsh-auth cookie 的 DSH 会话令牌通道；
// 用户配置类（remoteToken/frpAuth/apiAccessKey）走 instances[] 配置通道，绝不能混入此段。
function lanTokensProblems(tokens, managedIds, userConfigValues) {
  var problems = [];
  var keys = Object.keys(tokens || {});
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (managedIds.indexOf(k) < 0) problems.push('tokens 键非 DSH 侧目标: ' + k);
    if (userConfigValues.indexOf(String(tokens[k])) >= 0) problems.push('tokens 值来自用户配置: ' + k);
  }
  return problems;
}

// 登记表读取：优先 require（权威，不依赖写法）；加载失败退回源码「键名: {」形态。
function readRegisteredKinds(abs, rel) {
  if (!fs.existsSync(abs)) return { keys: [], how: '文件不存在' };
  try {
    var mod = require(abs);
    var set = {};
    var harvest = function (o) {
      if (!o || typeof o !== 'object') return;
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        // 只收「kind -> 描述对象」形态，且 kind 名为小写短横线式，避免把包装名当 kind
        if (v && typeof v === 'object' && !Array.isArray(v) && /^[a-z][a-z0-9-]*$/.test(k)) set[k] = 1;
      });
    };
    harvest(mod);
    if (mod && mod.KINDS) harvest(mod.KINDS);
    if (mod && mod.kinds) harvest(mod.kinds);
    var keys = Object.keys(set);
    if (keys.length) return { keys: keys, how: 'require' };
  } catch (e) { /* 语法/加载失败：仍要给出门禁判定，不因依赖未完成而崩 */ }
  var code = codeOf(rel);
  var set2 = {};
  var re = /['"]([a-z][a-z0-9-]*)['"]\s*:\s*\{/g;
  var m;
  while ((m = re.exec(code))) set2[m[1]] = 1;
  return { keys: Object.keys(set2), how: '源码正则回退' };
}

// 幽灵键清单（§1 末行）从 kinds.js 读取：分类表是唯一权威，门禁不自行硬编码第二份。
function readGhostKeys() {
  try {
    var mod = require(path.join(ROOT, 'src/platform/service/token/kinds.js'));
    var g = (mod && mod.GHOST_KEYS) || null;
    if (Array.isArray(g) && g.length) return g.slice();
  } catch (e) { /* 依赖未落地：回退到 SSOT §1 的已知键，门禁仍须判定 */ }
  return ['lanToken'];
}

/* ═════════════════════ TK-G1 ═════════════════════ */
console.log('== TK-G1 kinds.js 存在且登记 §1 全部 kind ==');
var KINDS_REQUIRED = ['dsh-main', 'dsh-instance', 'dsh-auth', 'remote-token', 'api-access-key', 'frp-auth', 'lan-gate'];
var KINDS_FORBIDDEN = ['lanToken']; // §1 末行：幽灵键，必须清除全部引用，更不得登记为 kind
{
  var KINDS_REL = 'src/platform/service/token/kinds.js';
  var kindsAbs = path.join(ROOT, KINDS_REL);
  var kindsExist = fs.existsSync(kindsAbs);
  check('TK-G1 kinds.js 存在（§3 目标结构）', kindsExist, KINDS_REL);
  var km = readRegisteredKinds(kindsAbs, KINDS_REL);
  var missing = KINDS_REQUIRED.filter(function (k) { return km.keys.indexOf(k) < 0; });
  check('TK-G1 登记 §1 的全部 7 类 kind', kindsExist && missing.length === 0,
    missing.length ? ('缺 ' + missing.join(', ')) : (km.keys.length + ' 类（' + km.how + '）'));
  var ghostKinds = KINDS_FORBIDDEN.filter(function (k) { return km.keys.indexOf(k) >= 0; });
  check('TK-G1 幽灵键未被登记为 kind', ghostKinds.length === 0, ghostKinds.join(', ') || 'ok');
}

/* ═════════════════════ TK-G2 ═════════════════════ */
console.log('== TK-G2 令牌不得驱动进程生命周期（TK-2）==');
{
  var G2_FILES = ['src/app/daemons/probe.js', 'src/app/main/controller.js'];
  var g2a = [];
  G2_FILES.forEach(function (rel) {
    if (!exists(rel)) { g2a.push(rel + ':不存在'); return; }
    reclaimMarkerHitsIn(codeOf(rel)).forEach(function (h) { g2a.push(rel + ':' + h); });
  });
  check('TK-G2a supervise/converge 无 _maybeReclaimAdoptToken 式接管形态', g2a.length === 0,
    g2a.slice(0, 4).join(' | ') || 'clean');

  var CV2 = 'src/app/main/controller.js';
  var g2b = exists(CV2) ? phaseSwitchTokenHitsIn(structOf(CV2), codeOf(CV2)) : null;
  // 覆盖率（防空转）：必须真的定位到含 case 的 phase switch——否则「switch 内无 token」
  //   可能只是因为压根没扫描到 switch（判据空转却报绿）。
  var g2body = exists(CV2) ? methodBody(structOf(CV2), '_dshConverge') : null;
  var g2blocks = g2body ? switchBlocks(g2body) : [];
  check('TK-G2b 定位到含 case 的 phase switch（判据非空转）',
    g2blocks.some(function (b) { return /\bcase\b/.test(g2body.slice(b.start, b.end)); }),
    g2blocks.length + ' 个 switch 块');
  check('TK-G2b phase 迁移 switch 内不出现令牌池读取', g2b !== null && g2b.length === 0,
    g2b === null ? '未定位到 _dshConverge 的 phase switch（结构变化，需人工核对）'
      : (g2b.slice(0, 4).join(' | ') || 'clean'));
}

/* ═════════════════════ TK-G3 ═════════════════════ */
console.log('== TK-G3 无静默销毁：持久化必须轮转（TK-6）==');
{
  var PERSIST_REL = 'src/platform/service/token/persist.js';
  var persistExist = exists(PERSIST_REL);
  check('TK-G3 persist.js 存在（§3 单一落盘点）', persistExist, PERSIST_REL);
  var dels = persistExist ? clearingDeleteHitsIn(codeOf(PERSIST_REL)) : [];
  check('TK-G3 persist.js 不含整文件清空式 rmSync/rmdir', persistExist && dels.length === 0,
    !persistExist ? '文件不存在（依赖未落地）' : (dels.slice(0, 4).join(' | ') || 'clean'));
  // 正向：必须存在轮转设施，否则「无删除」是因为根本没实现超限处理（门禁空转）
  check('TK-G3 persist.js 具备轮转设施（超限不得丢内容）',
    persistExist && hasRotationFacilityIn(codeOf(PERSIST_REL)),
    persistExist ? 'found rotate*' : '文件不存在（依赖未落地）');
  // （2026-09-16 复检清理）原先此处探测"旧单文件 token.js 的清空式删除残留"——
  //   该文件已删除，探测恒为"无"，属死代码。持久化的清空式删除检查已由上方
  //   persist.js 的判定覆盖（那里才是现存的唯一持久化实现）。
}

/* ═════════════════════ TK-G4 ═════════════════════ */
console.log('== TK-G4 lan-state.json 的 tokens 段只含 DSH 侧令牌（TK-7）==');
{
  // ⚠ 步骤 7（2026-09-16）：_syncLanState 已随 daemon 运行时辅助从 control-view.js 下沉到
  //   src/app/daemons/runtime.js（facade/router.js 只剩门面方法）——判据改读新模块。
  var CV4 = 'src/app/daemons/runtime.js';
  var syncBody = exists(CV4) ? methodBody(structOf(CV4), '_syncLanState') : null;
  check('TK-G4a 定位到 app/daemons/runtime.js#_syncLanState', syncBody !== null,
    syncBody ? 'ok' : '未找到（结构变化，需人工核对）');
  if (syncBody !== null) {
    // 源码级辅证：tokens 段的赋值不得取用户配置字段（行为级见 G4c）
    var fedFromUserCfg = /\btokens\s*\[[^\]]*\]\s*=\s*[^;]*(?:remoteToken|frpAuth|apiAccessKey)/.test(codeOf(CV4));
    check('TK-G4b tokens 段不由用户配置字段填充', !fedFromUserCfg,
      fedFromUserCfg ? 'tokens[...] 取了用户配置字段' : 'ok');
  }
  var probe = runLanStateProbe();
  check('TK-G4c 真实构造：tokens 键仅为 DSH 侧目标、值来自令牌服务',
    probe.ok && probe.problems.length === 0,
    probe.ok ? (probe.problems.join(' | ') || 'clean') : ('构造失败: ' + probe.error));
  check('TK-G4c 行为判定确实覆盖到 DSH 令牌（防空转）',
    probe.ok && probe.tokens && probe.tokens['main'] === 'DSH_MAIN_TOK' && probe.tokens['inst-a'] === 'DSH_INST_TOK',
    probe.ok ? JSON.stringify(probe.tokens) : ('构造失败: ' + probe.error));
}

// 真实构造守卫并写一次 lan-state.json：这是 tokens 段唯一的实际产出路径，行为级判定最可靠。
// 全部外部依赖（lanDaemonEnabled/instances/dshMainView/tokenService）用夹具覆写，
// 不触碰真实 daemon/账号/网络（与 token-boundary-test 同一隔离纪律）。
function runLanStateProbe() {
  var TMP = null;
  try {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-gate-'));
    var Supervisor = require(path.join(ROOT, 'src', 'supervisor')).Supervisor;
    var cfg = {
      command: ['node', '/nonexistent/bin/dsh', 'web'],
      healthUrl: 'http://127.0.0.1:28210/',
      apiHost: '127.0.0.1', apiPort: 28211,
      stateFile: path.join(TMP, 'state.json'),
      logFile: path.join(TMP, 'events.log'),
      supervisorLogFile: path.join(TMP, 'sup.log'),
      dshLogFile: path.join(TMP, 'dsh.log'),
      upgradeLogFile: path.join(TMP, 'upg.log'),
      logLevel: 'error',
    };
    var cfgPath = path.join(TMP, 'cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    var sup = new Supervisor(cfg, cfgPath);
    var USER = ['USERCFG_MAIN_TOKEN', 'USERCFG_REMOTE_A', 'USERCFG_FRP_A'];
    sup.lanDaemonEnabled = function () { return true; };
    sup.instances = {
      // DG-11 查询接口：runtime#_syncLanState 经 all() 取用，不再直读内部活数组。
      all() { return this.instances; },
      instances: [{
        id: 'inst-a', name: 'a', port: 28221, remoteEnabled: true,
        remoteToken: USER[1], frpEnabled: true, frpAuth: USER[2], frpRemotePort: 7000,
      }],
    };
    sup.dshMainView = function () {
      return { id: 'main', name: '主实例', port: 28220, remoteEnabled: true, remoteToken: USER[0], frpEnabled: false, frpRemotePort: null };
    };
    sup.tokenService = {
      get: function (id) { return id === 'main' ? 'DSH_MAIN_TOK' : (id === 'inst-a' ? 'DSH_INST_TOK' : ''); },
    };
    sup._syncLanState();
    var doc = JSON.parse(fs.readFileSync(path.join(TMP, 'lan-state.json'), 'utf8'));
    var tokens = (doc && doc.tokens && typeof doc.tokens === 'object') ? doc.tokens : {};
    return { ok: true, tokens: tokens, problems: lanTokensProblems(tokens, ['main', 'inst-a'], USER) };
  } catch (e) {
    return { ok: false, tokens: {}, problems: [], error: (e && e.message) || String(e) };
  } finally {
    try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
  }
}

/* ═════════════════════ TK-G5 ═════════════════════ */
console.log('== TK-G5 除 token 组件外无令牌缓存成员（TK-4）==');
{
  var g5 = [];
  SRC_FILES.forEach(function (rel) {
    if (isTokenComponent(rel)) return;
    // structOf：字符串/正则字面量已抹平——令牌缓存判定只看真实可执行标识符
    tokenCacheHitsIn(structOf(rel)).forEach(function (h) { g5.push(rel + ':' + h); });
  });
  check('TK-G5 无 this.dshToken / relay 式令牌缓存字段', g5.length === 0,
    g5.slice(0, 6).join(' | ') || ('扫描 ' + SRC_FILES.length + ' 个 src 文件，零命中'));
}

/* ═════════════════════ TK-G6 ═════════════════════ */
console.log('== TK-G6 令牌不进 argv/URL：browser.js 调用点 ==');
{
  var g6 = [];
  var browserSites = 0;
  SRC_FILES.forEach(function (rel) {
    if (rel === 'src/platform/os/browser.js') return;
    var sc = browserTokenScanIn(rel, codeOf(rel));
    browserSites += sc.sites;
    sc.hits.forEach(function (h) { g6.push(h); });
  });
  // browser.js 自身也不得引入 ?token=（它只做平台差异，绝不参与令牌拼接）
  if (exists('src/platform/os/browser.js') && /\?token=/.test(codeOf('src/platform/os/browser.js'))) {
    g6.push('src/platform/os/browser.js 自身含 ?token=');
  }
  check('TK-G6 定位到 browser 调用点（判据非空转）', browserSites > 0, browserSites + ' 处调用点');
  check('TK-G6 browser 调用点不得拼接 ?token=', g6.length === 0, g6.slice(0, 6).join(' | ') || 'clean');
}

/* ═════════════════════ TK-G7 ═════════════════════ */
console.log('== TK-G7 幽灵键在 src/ 中零引用（键名以 kinds.js GHOST_KEYS 为权威）==');
{
  var ghostKeys = readGhostKeys();
  var g7 = [];
  SRC_FILES.forEach(function (rel) {
    // 对**全部** src 文件判定（含令牌组件）——SSOT §1 要求「src/ 中零引用」。
    // structOf 已抹平字符串字面量：kinds.js 的 GHOST_KEYS=['lanToken'] 是**数据登记**，
    // 不是把幽灵键当活键使用，故不计为引用；真正危险的是 obj.lanToken / let lanToken 这类代码引用。
    ghostKeyHitsIn(rel, structOf(rel), ghostKeys).forEach(function (h) { g7.push(h); });
  });
  check('TK-G7 幽灵键在 src/ 中零引用', g7.length === 0,
    g7.slice(0, 6).join(' | ') || ('扫描 ' + SRC_FILES.length + ' 个 src 文件，键=[' + ghostKeys.join(',') + ']，零命中'));
}

/* ═════════════════════ TK-G8 反向（门禁非空转） ═════════════════════ */
console.log('== TK-G8 反向：判据能识别旧形态 ==');
{
  check('TK-G8 G2 判据识别 _maybeReclaimAdoptToken 旧片段',
    reclaimMarkerHitsIn("function f() { this._maybeReclaimAdoptToken(); }").length > 0, 'hit');
  var fakeConverge = "async _dshConverge() { switch (this._mPhase()) { case 'RUNNING': { var t = this.tokenService.get('main'); break; } } }";
  check('TK-G8 G2 判据识别 phase switch 内令牌读取',
    (function () { var h = phaseSwitchTokenHitsIn(fakeConverge, fakeConverge); return h !== null && h.length > 0; })(), 'hit');
  check('TK-G8 G3 判据识别清空式 rmSync 片段',
    clearingDeleteHitsIn("if (size > 262144) { try { fs.rmSync(fp); } catch (e) {} }").length > 0, 'hit');
  check('TK-G8 G3 轮转判据不误报无轮转实现',
    !hasRotationFacilityIn('function append(file, line) { fs.appendFileSync(file, line); }'), 'ok');
  check('TK-G8 G3 轮转判据识别 rotateByBackup 形态',
    hasRotationFacilityIn('if (size > max) rotated = rotateByBackup(fp, opts);'), 'hit');
  check('TK-G8 G3 判据不误伤临时文件清理（原子写必需）',
    clearingDeleteHitsIn("try { fs.unlinkSync(tmp); } catch (e) {}").length === 0, 'ok');
  check('TK-G8 G5 判据识别 this.dshToken 缓存片段',
    tokenCacheHitsIn("this.dshToken = 'x';").length > 0, 'hit');
  check('TK-G8 G5 判据识别 relay 式裸变量缓存片段',
    tokenCacheHitsIn("let dshToken = o.dshToken || ''; dshToken = newToken || '';").length > 0, 'hit');
  check('TK-G8 G5 判据不误报令牌服务引用', tokenCacheHitsIn('this.tokenService = new DshTokenService({});').length === 0, 'ok');
  check('TK-G8 G5 判据不误报用户配置字段', tokenCacheHitsIn("inst.remoteToken = 'u';").length === 0, 'ok');
  check('TK-G8 G6 判据识别 browser 调用点拼接令牌',
    browserTokenScanIn('(snippet)', "var url = 'http://127.0.0.1:1/?token=SECRET'; platform.browser.open(url);").hits.length > 0, 'hit');
  check('TK-G8 G6 判据识别实参直拼令牌',
    browserTokenScanIn('(snippet)', "platform.browser.open('http://127.0.0.1:1/?token=S');").hits.length > 0, 'hit');
  check('TK-G8 G6 判据对无令牌调用点不误报（但仍计入站点数）',
    (function () { var r = browserTokenScanIn('(snippet)', 'platform.browser.open(cleanUrl);'); return r.hits.length === 0 && r.sites === 1; })(), 'ok');
  check('TK-G8 G5 判据不误报函数内局部变量（按需读取）',
    tokenCacheHitsIn("function h(req) { const queryToken = new URL(req.url).searchParams.get('token'); return queryToken; }").length === 0, 'ok');
  check('TK-G8 G5 判据不误报不同函数中的同名局部变量',
    tokenCacheHitsIn("function a(req){ const queryToken = q(req); return queryToken; }\nfunction b(req){ const queryToken = q(req); return queryToken; }").length === 0, 'ok');
  check('TK-G8 G5 判据不误报形参默认值（作用域仅限该次调用）',
    tokenCacheHitsIn("svc.onChange((id, token = '') => { use(token); });").length === 0, 'ok');
  check('TK-G8 G5 判据识别顶层裸变量多次赋值（跨调用缓存）',
    tokenCacheHitsIn("let dshToken = ''; function r(t) { dshToken = t; } function g() { return dshToken; }").length > 0, 'hit');
  check('TK-G8 G7 判据识别幽灵键片段', ghostKeyHitsIn('(snippet)', 'var lanToken = 1;').length > 0, 'hit');
  check('TK-G8 G7 判据识别任意登记的幽灵键', ghostKeyHitsIn('(snippet)', 'obj.lanToken = 1;', ['lanToken']).length > 0, 'hit');
  check('TK-G8 G4 判据识别用户配置混入 tokens 段',
    lanTokensProblems({ 'inst-a': 'USERCFG' }, ['main'], ['USERCFG']).length > 0, 'hit');
  check('TK-G8 G4 判据不误报纯 DSH 令牌',
    lanTokensProblems({ main: 'DSH_MAIN_TOK' }, ['main'], ['USERCFG']).length === 0, 'ok');
}

var failed = results.filter(function (r) { return !r; });
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
