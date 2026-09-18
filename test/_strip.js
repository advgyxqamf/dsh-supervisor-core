'use strict';

// test/_strip.js —— test/ 下所有「注释剥离」的**唯一实现**（阶段六统一为单一字符级词法）。
//
// ## 为什么需要它（本仓三次同源事故）
//   1) CP 门禁的 distinctive 阈值把 2/5 条已登记钉子永久滤掉；
//   2) U-1b 的剥离**顺序**错误（先块后行）把行注释里的 glob 当成块注释开符；
//   3) 阶段五 4 道门禁同因此**吞掉代码致门禁失明**（实测吞 174/80/47/29/17 行）。
//   根因同一个：**正则无法区分「真注释」与「字符串/正则字面量里的同形字符」**。
//   故统一为**逐字符词法**：跟踪字符串（单引号/双引号/反引号）与正则字面量
//   （用「前一个有意义字符」启发式区分正则与除号 —— 标准做法），只在真注释处剥离。
//   块注释以换行占位，**保持行结构**（多处判据依赖行号/行数）。
//
// ## 本文件是助手，不是测试
//   · test-chain-completeness-test.js：N-a 只要求 `*-test.js` 入链（本文件不匹配）；
//     N-c 的 helper 计数显式排除 `_` 前缀 ⇒ 本文件既不占链条目也不触发 N-c。
//   · test-port-discipline-test.js / workflow-parse-test.js 的枚举也显式跳过 `_` 前缀。
//   ⇒ 新增本文件**不消耗链条余量**（依然 7899/8000），也不需要 `scripts.test` 改动。
//
// ## 三个产物（按各门禁**原有语义**选用，不得一律改成「全剥」）
//   · stripComments(src)     删除式：注释整段删除（块注释换行保留）。原「剥块+行注释」的门禁用。
//   · blankComments(src)     空格式：被剥字符逐个替换为空格，**长度与列号保持**。
//                             原「用空格占位以保偏移」的门禁用。
//   · dropCommentLines(src)  只丢「整行都是注释」的行（行结构保留）。
//                             原「只滤 // 行 / 块注释续行」的门禁用 —— 语义等价但**字符串/正则感知**。

const LF = String.fromCharCode(10);
const BT = String.fromCharCode(96); // 反引号

/** 正则字面量起点启发式：前一个有意义字符属于这些时，'/' 更可能是正则起点而非除号。 */
function isRegexStart(prev) { return prev === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(prev) >= 0; }

/**
 * 单次字符级扫描。
 * @param {string} src 源码文本
 * @param {{blank?: boolean}} [opts] blank=true 时用空格占位（长度保持），否则删除
 * @returns {{code: string, regexes: Array<{body: string, flags: string}>}}
 */
function scan(src, opts) {
  const blank = !!(opts && opts.blank);
  const s = String(src == null ? '' : src);
  let code = '';
  const regexes = [];
  let i = 0;
  const n = s.length;
  let prev = '';
  while (i < n) {
    const c = s[i], d = s[i + 1];
    // 行注释：到行尾（换行不在此消费，交由主循环原样保留）
    if (c === '/' && d === '/') {
      while (i < n && s[i] !== LF) { if (blank) code += ' '; i++; }
      continue;
    }
    // 块注释：整段剥离；换行原样保留以维持行结构
    if (c === '/' && d === '*') {
      if (blank) code += '  ';
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] === LF) code += LF; else if (blank) code += ' ';
        i++;
      }
      if (blank) { if (i < n) code += '  '; }
      i += 2;
      continue;
    }
    // 字符串 / 模板串：原样保留（其中的同形字符不是注释）
    if (c === '"' || c === "'" || c === BT) {
      const q = c; code += c; i++;
      while (i < n) {
        const e = s[i]; code += e; i++;
        if (e === '\\') { if (i < n) { code += s[i]; i++; } continue; }
        if (e === q) break;
      }
      prev = q; continue;
    }
    // 正则字面量：原样保留（其中的同形字符不是注释）
    if (c === '/' && isRegexStart(prev)) {
      let body = '', j = i + 1, inClass = false, closed = false;
      while (j < n) {
        const e = s[j];
        if (e === '\\') { body += e + (s[j + 1] || ''); j += 2; continue; }
        if (e === '[') inClass = true;
        else if (e === ']') inClass = false;
        else if (e === LF) break;
        else if (e === '/' && !inClass) { closed = true; break; }
        body += e; j++;
      }
      if (closed) {
        let k = j + 1, flags = '';
        while (k < n && /[a-z]/i.test(s[k])) { flags += s[k]; k++; }
        regexes.push({ body, flags });
        code += s.slice(i, k);
        prev = 'x'; i = k; continue;
      }
    }
    code += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return { code, regexes };
}

/** 删除式剥离：注释整段删除（块注释的换行保留）。 */
function stripComments(src) { return scan(src).code; }

/** 空格式剥离：被剥字符用空格占位，长度/列号保持（供需要偏移稳定的门禁）。 */
function blankComments(src) { return scan(src, { blank: true }).code; }

/** 只丢「整行都是注释」的行：用 blank 产物判定（一行被空格替换后无实义字符 ⇒ 整行是注释）。
 *  行结构保持；字符串/正则感知（字符串里的同形字符不会让该行被误丢）。 */
function dropCommentLines(src) {
  const s = String(src == null ? '' : src);
  const blanked = blankComments(s).split(LF);
  const orig = s.split(LF);
  const out = [];
  for (let i = 0; i < orig.length; i++) {
    if (blanked[i] !== undefined && blanked[i].trim() !== '') out.push(orig[i]);
  }
  return out.join(LF);
}

/** 多语言安全的「丢整行 `//` 与 `#` 注释 + 去块注释 + 清星号续行」（**不套用 JS 字符级词法**）。
 *  用于扫描面含 .sh/.yml/.bash 的门禁：那里 `//` 可能是 URL、`#` 才是注释，JS 词法会误伤。
 *  行注释先丢整行 ⇒ 行注释里的 glob 不会开假块注释（本类缺陷的根因），与原手写实现逐字等价。 */
function stripLineAndBlocks(src) {
  const noLine = String(src).split(LF)
    .map((l) => { const t = l.trim(); return (t.startsWith('//') || t.startsWith('#')) ? '' : l; })
    .join(LF);
  const noBlock = noLine.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.split(LF).map((l) => (l.trim().startsWith('*') ? '' : l)).join(LF);
}

/** CP 门禁原用形态：{ stripped, regexes }。保留该名字以免改动其调用点语义。 */
function scanText(src) { const r = scan(src); return { stripped: r.code, regexes: r.regexes }; }

module.exports = { scan, scanText, stripComments, blankComments, dropCommentLines, stripLineAndBlocks, isRegexStart, LF, BT };
