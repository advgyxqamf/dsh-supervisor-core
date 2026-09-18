#!/usr/bin/env node
'use strict';

// API 契约面强制测试（P3 断点修复）：
//   断言「源码中出现的每个路由」都在 src/api/contract.js 登记，且登记的每个路由都真实存在
//   （双向一致）。新增路由若不登记 → 本测试失败；删除路由若不清理清单 → 也失败。
//
// ⚠ 步骤 9（DIRECTORY-STRUCTURE-DESIGN §3）：路由实现已平移至 src/api/domains/，
//   契约面元数据 surface.js 改名为 contract.js。本测试的扫描目录随之扩展为
//   「api/ 顶层 + api/domains/」两处——只扫顶层会让 10 个域的路由**全部漏检**
//   （双向一致退化为空转），那正是本门禁要防的失效模式。
// 目的：把「端点是否有消费者 / 是否属于对外面」从一次性审计升级为**常驻不变量**。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'src', 'api');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

const { SURFACE, PREFIXES, CATEGORIES, summary } = require(path.join(API_DIR, 'contract'));

// ── 从源码提取路由 ──
// 范围：api/ 顶层（排除网关 index.js 与契约 contract.js 自身）∪ api/domains/*.js。
//   其余顶层基础件（security/static/router-table/deps/identity）无路由定义，被扫到也无副作用。
function extract() {
  const exact = new Map();   // path -> Set(file)
  const prefix = new Map();  // prefix -> Set(file)
  const scan = [
    ...fs.readdirSync(API_DIR).filter((x) => x.endsWith('.js') && x !== 'index.js' && x !== 'contract.js').map((x) => path.join(API_DIR, x)),
    ...(() => { try { return fs.readdirSync(path.join(API_DIR, 'domains')).filter((x) => x.endsWith('.js')).map((x) => path.join(API_DIR, 'domains', x)); } catch { return []; } })(),
  ];
  for (const fp of scan) {
    const f = fp;
    const s = fs.readFileSync(fp, 'utf8');
    let m;
    const re = /pathname === '([^']+)'/g;
    while ((m = re.exec(s))) { if (!exact.has(m[1])) exact.set(m[1], new Set()); exact.get(m[1]).add(f); }
    const rp = /pathname\.startsWith\('([^']+)'\)/g;
    while ((m = rp.exec(s))) { if (!prefix.has(m[1])) prefix.set(m[1], new Set()); prefix.get(m[1]).add(f); }
  }
  return { exact, prefix };
}

const { exact, prefix } = extract();
const declaredExact = new Set(SURFACE.map((e) => e.path));
const declaredPrefix = new Set(PREFIXES.map((e) => e.prefix));

console.log('== API 契约面：清单结构 ==');
check('全部条目分类合法', SURFACE.every((e) => CATEGORIES.includes(e.category)) && PREFIXES.every((e) => CATEGORIES.includes(e.category)),
  JSON.stringify(summary()));
check('每个条目声明 methods 与 consumers', SURFACE.every((e) => Array.isArray(e.methods) && e.methods.length > 0 && e.consumers && e.consumers.length > 0),
  'ok');
check('每个条目有 note（说明用途）', SURFACE.every((e) => typeof e.note === 'string' && e.note.length > 0) && PREFIXES.every((e) => typeof e.note === 'string' && e.note.length > 0), 'ok');
check('deprecated 条目必须说明移除条件/替代', SURFACE.filter((e) => e.category === 'deprecated').every((e) => /取代|移除条件|替代/.test(e.note)),
  JSON.stringify(SURFACE.filter((e) => e.category === 'deprecated').map((e) => e.path)));

console.log('== 双向一致：源码 <-> 清单 ==');
const undeclared = [...exact.keys()].filter((p) => !declaredExact.has(p));
check('源码中所有精确路由均已登记', undeclared.length === 0, undeclared.join(', ') || 'clean');
const phantom = [...declaredExact].filter((p) => !exact.has(p));
check('清单中所有精确路由均存在于源码（无幽灵条目）', phantom.length === 0, phantom.join(', ') || 'clean');
const undeclaredPrefix = [...prefix.keys()].filter((p) => !declaredPrefix.has(p));
check('源码中所有前缀路由均已登记', undeclaredPrefix.length === 0, undeclaredPrefix.join(', ') || 'clean');
const phantomPrefix = [...declaredPrefix].filter((p) => !prefix.has(p));
check('清单中所有前缀路由均存在于源码', phantomPrefix.length === 0, phantomPrefix.join(', ') || 'clean');

console.log('== 消费者分类核验（孤儿端点必须显式归类）==');
// public 必须有具体消费者（不能空泛）
check('public 条目均标注具体消费者', SURFACE.filter((e) => e.category === 'public').every((e) => e.consumers.some((c) => /UI|CLI|壳|README/.test(c))),
  'ok');
// operational/internal/deprecated 必须说明为何无一方 UI 消费者
check('operational 条目说明其运维用途', SURFACE.filter((e) => e.category === 'operational').every((e) => /探针|监控|诊断|审计/.test(e.note)),
  JSON.stringify(SURFACE.filter((e) => e.category === 'operational').map((e) => e.path)));
check('internal 条目说明内部消费者', SURFACE.filter((e) => e.category === 'internal').every((e) => /守卫|契约测试|内部/.test(e.consumers.join(''))),
  JSON.stringify(SURFACE.filter((e) => e.category === 'internal').map((e) => e.path)));

console.log('== 已删除的冗余端点不得复活 ==');
const lifeSrc = fs.readFileSync(path.join(API_DIR, 'domains', 'lifecycle.js'), 'utf8');
check('/logs/events-tail 已删除（与 /events 语义重复）', !/pathname === '\/logs\/events-tail'/.test(lifeSrc), 'ok');

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
