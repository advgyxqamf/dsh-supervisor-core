# EXEC3 · DF-8（顶层 require）与 DF-9（函数嵌套深度）扫描判据 + 执行报告

> 子代理：**R3-F**（横切 DF-8/DF-9）。执行期收到主代理第三轮**独占归属裁决**，
> 裁决后**已停止**对他人独占文件的写入（详见文末「归属与遗留」）。
> 本文件同时是**给 R3-J 的门禁实现**（正则 + 括号计数，**零第三方依赖**，不得用 acorn/espree）。

## 0. 结论速览

| 判据 | 结果 |
|---|---|
| **DF-8** 函数体内不得有内联 `require()` | 全仓 `src/**/*.js` 仅剩 **1 处**：`src/supervisor.js:44` 的 `get lan()` —— **有意的惰性 require**（daemon 模式结构性排除），**保留并注明**。 |
| **DF-9** 函数嵌套深度 ≤ 6 | 全仓最大 **5**（`src/domains/instance/upgrade.js`），**0 处超限**。 |
| 相关测试 | `test-safety-gate` 5/0、`standards-uniqueness` 8/0、`test-chain-completeness` 10/0、`directory-structure-gate` 16/0(hard)、`layering-and-dependency-gate` 10/0、`domain-structure-gate` 54/0(hard)、`all-platforms-test` 34/0（T6-a 内核零运行时依赖 PASS）。 |

## 1. 判据实现（可直接复制进门禁）

设计要点：
- **零依赖**：只 `require('node:fs')` / `require('node:path')`；
- **先剥注释**（字符串整体跳过，避免注释里的 `require(Object.assign(prototype))` 假阳性）；
- DF-8 用「**函数作用域花括号**」判定，**不能**用朴素的「花括号深度 > 0」——
  顶层对象/数组字面量（如 `app/assembly/facets.js` 的 `FACETS` 数组、
  `platform/os/index.js` 的 `module.exports`）会把 `require` 计成「嵌套内」而**假阳性**；
- DF-9 统计「当前打开的**函数体**花括号数」的最大值——即回调/闭包嵌套深度，
  与处置手段「把深层回调提为具名函数」一致。（原始 `{}` 净值会被对象/数组字面量抬高，
  例如 `oauth.js` 净值 13 但函数深度仅 4，故不以净值作 DF-9 判据。）

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 剥注释：字符串整体跳过（保留换行，行号不漂移）。 */
function stripComments(src) {
  let out = '', i = 0; const n = src.length; let mode = null;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (mode) {
      out += c;
      if (c === '\\') { if (d !== undefined) out += d; i += 2; continue; }
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === String.fromCharCode(96)) { mode = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'do',
  'return', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'instanceof', 'case', 'throw',
  'await', 'yield', 'function']);

/** 返回「函数体开括号 {」的下标集合：function / 箭头(块体) / 方法简写。 */
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
  // ③ 方法简写 / class 方法 / getter / setter（排除 if/for/while/switch/catch）
  const reMethod = /(?:^|[^\w$)\]}])(?:async\s+)?(?:get\s+|set\s+|static\s+|\*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g;
  while ((m = reMethod.exec(src))) {
    if (CONTROL_KEYWORDS.has(m[1])) continue;
    marked.add(m.index + m[0].length - 1);
  }
  return marked;
}

/** 一次遍历同时求：函数嵌套深度 + 内联 require 行号。 */
function analyze(src) {
  const marked = functionBodyBraces(src);
  const stack = []; let maxFn = 0; const inlineRequires = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      const isFn = marked.has(i);
      stack.push(isFn);
      if (isFn) {
        let d = 0; for (const b of stack) if (b) d++;
        if (d > maxFn) maxFn = d;
      }
    } else if (c === '}') {
      stack.pop();
    } else if (c === 'r' && src.startsWith('require(', i) && stack.includes(true)) {
      inlineRequires.push(src.slice(0, i).split('\n').length);
    }
  }
  return { maxFn, inlineRequires };
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── 判据结果 ──
const FN_MAX = 6;
const INLINE_ALLOW = { 'src/supervisor.js': 'get lan() 有意的惰性 require：daemon 模式结构性排除，见文件注释' };
const files = walk(path.join(__dirname, 'src'), []);
const df8 = [], df9 = [];
for (const f of files) {
  const rel = path.relative(path.join(__dirname, '.'), f).split(path.sep).join('/');
  const { maxFn, inlineRequires } = analyze(stripComments(fs.readFileSync(f, 'utf8')));
  if (inlineRequires.length && !INLINE_ALLOW[rel]) for (const line of inlineRequires) df8.push(rel + ':' + line);
  if (maxFn > FN_MAX) df9.push(rel + '=' + maxFn);
}

// ── 输出 + 反向自检（门禁自身完整性硬失败）──
let ok = true;
console.log((df8.length ? 'FAIL' : 'PASS') + ' DF-8 函数体内无内联 require  <- ' + (df8.length ? df8.join(', ') : 'ok（仅 supervisor.js 惰性例外）'));
if (df8.length) ok = false;
console.log((df9.length ? 'FAIL' : 'PASS') + ' DF-9 函数嵌套深度 <= 6  <- ' + (df9.length ? df9.join(', ') : 'ok'));
if (df9.length) ok = false;

const nested = (k) => Array.from({ length: k }, (_, n) => 'const f' + n + '=()=>{').join('') + '};'.repeat(k);
const hit = analyze(stripComments(nested(7))).maxFn === 7;
const miss = analyze(stripComments(nested(6))).maxFn === 6;
const inlineHit = analyze(stripComments('function a(){ const x=require("./y"); }')).inlineRequires.length === 1;
const inlineMiss = analyze(stripComments('const x=require("./y");')).inlineRequires.length === 0;
const objMiss = analyze(stripComments('module.exports = { x: require("./y") };')).inlineRequires.length === 0;
console.log((hit ? 'PASS' : 'FAIL') + ' DF-9 反向：7 层样本命中');
console.log((miss ? 'PASS' : 'FAIL') + ' DF-9 反向：6 层样本不命中（边界）');
console.log((inlineHit ? 'PASS' : 'FAIL') + ' DF-8 反向：函数体内 require 命中');
console.log((inlineMiss ? 'PASS' : 'FAIL') + ' DF-8 反向：顶层 require 不命中');
console.log((objMiss ? 'PASS' : 'FAIL') + ' DF-8 反向：顶层对象字面量内 require 不命中（防假阳性）');
if (!hit || !miss || !inlineHit || !inlineMiss || !objMiss) ok = false;
process.exit(ok ? 0 : 1);
```

> `__dirname` 按门禁实际位置调整（`test/` 下为 `path.join(__dirname, '..')`）。

## 2. DF-8 执行明细

### 2.1 上提（模块顶层 `const X = require('...')`）——共 33 个文件
`api/static.js`、`api/domains/instances.js`、`app/assembly/{api-rebind,bootstrap,compose}.js`、
`app/control/specs.js`、`app/ctl/client.js`、`app/daemons/{process,runtime}.js`、
`app/facade/ports.js`、`app/native/installer.js`、`app/settings/{env,versions}.js`、
`domains/instance/sandbox.js`、`domains/plugin/store.js`、`domains/relay/{frp-install,frp,daemon}.js`、
`domains/router/{config,daemon,endpoint}.js`、`domains/router/handlers/forward.js`、
`domains/router/ops/{browser,oauth}.js`、`domains/router/ports-bootstrap.js`、
`domains/shell/{journal,restart}.js`、`supervisor.js`、
`platform/contract/runtime.js`、`platform/os/{index,process}.js`、
`platform/service/env-catalog.js`、`platform/service/ports/index.js`。

做法：把函数体内的 `const X = require('...')` 行删除，在文件顶层插入同一声明；
内联的 `require('...').prop` 改为顶层变量的 `.prop`；重复 `require` 合并（如
`app/daemons/process.js` 的内联 `path`/`net`/`spawnOS`、`api/static.js` 的 7 处 `node:path`）。

### 2.2 保留的惰性 require（如实报告）
- `src/supervisor.js` 的 `get lan()` 内 `require('./domains/relay')`：**有意惰性**，
  daemon 模式下守卫内不创建本地 relay（结构性排除），且 relay 域经 app 层装配；已就地加注释。

### 2.3 无环验证（为何其余都能上提）
用静态 require 图对每个内联 require 做了「目标模块是否可达回本文件」的判定：
**0 处破环型内联 require**，故全部可安全上提。
`src/domains/shell/journal.js` 原注释声称「顶层 require 会在配置注入前固化路径」——
经查 `platform/service/state-root.js` 的 `root()` **每次调用现读 `DSH_SUPERVISOR_HOME`**
（无模块级缓存），该前提不成立，已上提并更正注释。
`platform/service/ports/index.js` 的 `node:net` 原注释「避免顶层依赖 net」同理不成立
（内置模块、无副作用），已上提。

## 3. DF-9 执行明细

- 判据 = **函数作用域嵌套深度**（回调/闭包金字塔），阈值 ≤6。
- 全仓最大 **5**，出现于 `src/domains/instance/upgrade.js`；其余靠前：
  `domains/plugin/cli.js`=5、`domains/relay/frp-install.js`=5、`domains/relay/proxy.js`=5、
  `domains/router/providers/restart.js`=5。**无一处 >6，无需提函数。**
- 任务书列出的优先文件实测函数嵌套：`app/daemons/process.js`≤3、`app/main/process.js`≤3、
  `app/assembly/compose.js`≤3、`app/control/registry.js`≤3、`platform/service/ports/index.js`≤3、
  `platform/util/exec.js`=1 —— **均未达 DF-9 阈值**，做提函数属于无谓改动，按纪律不做。
- 说明：任务书「嵌套 ≥10 层」的扫描口径应是**原始花括号净值**；该口径把对象/数组字面量
  也计入（`oauth.js` 净值 13、`forward.js` 净值 16），而这类深度**无法**靠「把回调提为具名函数」
  降低，且不代表回调金字塔。若 R3-J 需要净值口径，建议阈值另定并单独报告，勿与 DF-9 混用。

## 4. 验证

- 每个改动文件 `node --check` 通过；全部 33 个文件在隔离状态根
  （`DSH_SUPERVISOR_HOME=/tmp/exec3-r3f-home`）下 `require()` 加载通过（无顶层副作用崩溃）。
- 必跑：`test-safety-gate` 5/0、`standards-uniqueness` 8/0、`test-chain-completeness` 10/0、
  `directory-structure-gate` 16 passed/0 hard（2 report-only 既有）、
  `layering-and-dependency-gate` 10/0、`domain-structure-gate` 54 passed/0 hard（既有 RED 未变）、
  `all-platforms-test` 34/0（**T6-a 内核零运行时依赖 = []**，未新增任何依赖）。

## 5. 归属与遗留（★ 主代理第二轮裁决后）

裁决把 `platform/service/**`(R3-C)、`app/**`(R3-E)、`platform/os/**`(R3-D)、
`api/**`(R3-H)、`shared/**`+`platform/contract`+`platform/util`(R3-I)、`domains/**`(R3-G/K)
划给他人。**本报告§2.1 的文件写入发生在裁决到达之前**；裁决到达后 R3-F **已停止**对上述
文件的任何进一步写入。请各 owner 以最新内容为基准核对/覆盖（`platform/service/ports/index.js`
由 R3-C 重建立面时一并收口）。R3-F 其后**仅**改 `src/supervisor.js`（本轮授权）与本文件。

- `package.json` 未新增任何依赖；DF-8/DF-9 判据零第三方依赖。
- 未 commit；未启动任何 guard/daemon；未触碰 `/tmp/dsh-*`、`~/.local/state/dsh-supervisor/`、`~/.dsh`。
