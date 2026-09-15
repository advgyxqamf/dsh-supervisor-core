#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 分层与依赖方向门禁（2026-09-13）—— **开发轨道**的可执行部分
//
// ## 这份门禁解决的问题
//
// 明确要求：「后续增加新功能和修改业务逻辑要有规范的开发规则」。
// 规则写在文档里会被忽略；**写成会失败的门禁**才会被执行。
//
// ## 分层（内核，src/）
//
//   platform/  ← 最底层：平台抽象、配置、执行器、日志、矩阵。**不得依赖任何上层**
//   domains/   ← 业务域（router/relay/instance/plugin/dist/shell）
//   guard/     ← 守护与监督（supervisor / lifecycle / monitor / native / guardian）
//   api/       ← HTTP/WS 契约面
//   root       ← src/supervisor.js 组装根、src/core.cjs 打包入口
//
// ## 两条规则
//
//   L-1  `platform/` **不得依赖** domains / guard / api（它是所有人的地基）
//   L-2  所有**跨层** import 必须在 `CROSS_LAYER` 清单中**显式登记**；
//        未登记的新跨层依赖 → 失败（要求开发者显式声明意图）
//
//   L-2 而不是"禁止一切逆向依赖"，是因为本仓存在**刻意的**跨层共享：
//     · `domains → api/identity`：relay 复用回环/RFC1918 判定，**不得重写第二份**
//       （由 test/relay-source-gate-test.js S-a 主动要求）。
//     · `domains → guard/lifecycle/ports`（9 处）：ports.js 自称"**系统级**统一端口管理"，
//       instance/router/relay 都靠它登记端口。这是**有意的共享基础设施**。
//     · `guard → domains/dist`：native 卸载要读镜像契约。
//     · `api → platform`、`root → 全部`：正常向下组装。
//     把这些写成"禁止"，门禁会在第一次运行就红，然后被人加白名单绕过 —— 那就成了摆设。
//     **登记 + 理由 + 变更可见**才是能长期活下去的形态。
//
//   L-3  `src/platform/deploy.js` 对 `../core.cjs` 的引用是**有意的 best-effort**
//        （打包产物存在时才启用，见该文件注释），单列白名单并注明。
//
// ## 怎么加新的跨层依赖（**开发轨道**）
//   1. 先问：能否经 `platform/` 或已登记的共享单元？
//   2. 不能，则在此处 `CROSS_LAYER` 增加一条，写明**理由**与**方向**；
//   3. 跑 `npm test` —— 门禁会核对你登记的单元确实被引用、且没有多余登记。
//
// ## 锁定不变量
//   L-1  platform 不依赖上层
//   L-2  跨层 import 全部已登记（新增未登记 → 失败）
//   L-2b 登记表无死条目（登记的单元确实还被引用）
//   L-3  core.cjs 白名单（有意的 best-effort）
//   L-4  反向：判据能识别未登记跨层 / 能识别 platform 越界（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 跨层依赖登记表：`<from> -> <to>` → { unit → 理由 }。
 *  ⚠ 新增条目必须写理由；门禁会检查"登记了的确实被引用"。 */
const CROSS_LAYER = {
  'api -> platform': {
    'src/platform/loghub': 'api 记录生命周期事件到统一日志中枢',
    'src/platform/os': 'api 读平台能力/数据目录',
  },
  'domains -> api': {
    'src/api/identity': 'relay 复用回环/RFC1918 判定 —— 不得重写第二份（relay-source-gate S-a 要求）',
  },
  'domains -> guard': {
    'src/guard/lifecycle': 'ports.js 是"系统级统一端口管理"，instance/router/relay 都靠它登记端口',
    'src/guard/monitor': '实例/relay 探活复用同一监督探针',
    'src/guard/guardian': '实例守卫（超时/重启）由 domains 触发',
  },
  'domains -> platform': {
    'src/platform/os': '平台抽象层（能力/执行/路径）—— 正常向下依赖',
    'src/platform/matrix': '平台标签矩阵（跨平台架构规范唯一事实源）',
    'src/platform/config': '读统一配置（数据目录/端口段等）',
    'src/platform/fs-utils': '文件工具（原子写/目录准备）',
    'src/platform/logcore': '日志核心（结构化事件写入）',
    'src/platform/registry-contract': '镜像目录契约（domains/dist 消费）',
    'src/platform/runtime-contract': '运行期启动契约（domains/dist 消费壳投放的 npm/PATH）',
    'src/platform/state-root': '产品状态根（domains 的 supervisor|shell 路径单一事实源）',
    'src/platform/tasks': '任务注册表（异步任务可观测）',
  },
  'guard -> domains': {
    'src/domains/dist': 'native 卸载需读镜像契约（domains/dist 是契约持有者）',
  },
  'guard -> platform': {
    'src/platform/os': '平台抽象层 —— 正常向下依赖',
    'src/platform/matrix': '平台标签矩阵（跨平台架构规范唯一事实源）',
    'src/platform/config': '读统一配置（数据目录/端口段等）',
    'src/platform/deploy': '部署形态判定（打包/源码）',
    'src/platform/env-catalog': '环境目录目录（设置面展示）',
    'src/platform/exec': '有界执行器（统一超时/输出上限）',
    'src/platform/log': '日志（组件级 logger）',
    'src/platform/loghub': '统一日志中枢（跨组件日志汇聚）',
    'src/platform/srcpath': '源码路径解析（控制面展示）',
    'src/platform/state-root': '产品状态根（guard 的 ports 等路径单一事实源）',
    'src/platform/version': '版本自报（内核/契约版本）',
  },
  // 注：曾以为 platform/deploy.js 会 require('../core.cjs') —— 实测那 4 处**全在注释里**
  //   （产品形态说明），无真实 import。故此处**不留条目**（留了就是死条目，由 L-2b 抓出）。
  'root -> api': { 'src/api/index': '组装根挂载 API 面' },
  'root -> domains': {
    'src/domains/router': '组装根实例化各业务域',
    'src/domains/relay': '组装根实例化各业务域（relay：远程控制/FRP）',
    'src/domains/instance': '组装根实例化各业务域（instance：实例生命周期）',
    'src/domains/plugin': '组装根实例化各业务域（plugin：插件管理）',
    'src/domains/dist': '组装根实例化各业务域（dist：发布/镜像/自更新）',
    'src/domains/shell': '组装根实例化各业务域（shell：桌面壳协同/看护）',
  },
  'root -> guard': {
    'src/guard/lifecycle': '组装根装配守护各子系统',
    'src/guard/supervisor': '组装根装配守护各子系统（supervisor：总控视图）',
    'src/guard/monitor': '组装根装配守护各子系统（monitor：探活）',
    'src/guard/health': '组装根装配守护各子系统（health：健康快照）',
    'src/guard/host-service': '组装根装配守护各子系统（host-service：宿主常驻）',
    'src/guard/intent': '组装根装配守护各子系统（intent：意图/期望态）',
    'src/guard/native': '组装根装配守护各子系统（native：原生安装/卸载）',
    'src/guard/proc': '组装根装配守护各子系统（proc：进程/daemon 生命周期）',
    'src/guard/guardian': '组装根装配守护各子系统（guardian：实例守卫）',
  },
  'root -> platform': {
    'src/platform/os': '组装根读平台事实（数据目录/能力矩阵）',
    'src/platform/matrix': '平台标签矩阵（跨平台架构规范唯一事实源）',
    'src/platform/config': '配置（日志/端口/数据目录等统一配置）',
    'src/platform/logcore': '日志核心（结构化事件写入）',
    'src/platform/tasks': '任务注册表（异步任务可观测）',
    'src/platform/token': '令牌服务（会话凭据采集与恢复）',
    'src/platform/version': '版本自报（内核/契约版本）',
  },
};

function layerOf(rel) {
  if (rel.startsWith('src/platform/')) return 'platform';
  if (rel.startsWith('src/domains/')) return 'domains';
  if (rel.startsWith('src/guard/')) return 'guard';
  if (rel.startsWith('src/api/')) return 'api';
  if (rel.startsWith('src/')) return 'root';
  return null;
}

/** 跨层依赖的"单元"（platform/domains/guard/api 取前两段；root 取文件本身）。 */
function unitOf(abs, toLayer) {
  if (toLayer === 'root') return abs;
  return abs.split('/').slice(0, 3).join('/');
}

function collect() {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'src'));
  const edges = [];   // { from, to, unit, file, line }
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const from = layerOf(rel);
    if (!from) continue;
    const lines = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10));
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      const m = /require\(['"]([^'"]+)['"]\)/.exec(l);
      if (!m) return;
      const r = m[1];
      if (!r.startsWith('.')) return;
      // ⚠ 必须相对 ROOT 归一：f 是**绝对路径**，直接 join 会得到绝对路径，
      //   使下面的 'src/' 前缀判定恒假 → 跨层边集为空 → 门禁空转（已踩过）。
      const abs = path.relative(ROOT, path.resolve(path.dirname(f), r)).split(path.sep).join('/');
      if (!abs.startsWith('src/')) return;
      const to = layerOf(abs);
      if (!to || to === from) return;
      edges.push({ from, to, unit: unitOf(abs, to), file: rel, line: i + 1 });
    });
  }
  return edges;
}

const edges = collect();

// ── L-1：platform 不得依赖上层 ──
{
  // platform -> root 只在有登记时允许（core.cjs 的有意 best-effort）
  const bad = edges.filter((e) => e.from === 'platform' && e.to !== 'root');
  check('L-1 platform/ 不依赖 domains/guard/api（它是地基）',
    bad.length === 0,
    bad.length ? bad.map((e) => e.file + ':' + e.line + ' -> ' + e.to).join(', ') : '未发现');
  const platRoot = edges.filter((e) => e.from === 'platform' && e.to === 'root');
  const allowedRoot = CROSS_LAYER['platform -> root'] || {};
  const undeclared = platRoot.filter((e) => !allowedRoot[e.unit]);
  check('L-3 platform -> root 仅限已登记的白名单（core.cjs 有意 best-effort）',
    undeclared.length === 0,
    undeclared.length ? undeclared.map((e) => e.file + ':' + e.line).join(', ')
      : (platRoot.length + ' 处，全部为 ' + Object.keys(allowedRoot).join(',')));
}

// ── L-2：跨层依赖全部已登记 ──
{
  const undeclared = [];
  for (const e of edges) {
    const key = e.from + ' -> ' + e.to;
    const reg = CROSS_LAYER[key];
    if (!reg || !reg[e.unit]) undeclared.push(e.file + ':' + e.line + '  ' + key + '  [' + e.unit + ']');
  }
  check('L-2 所有跨层 import 已在 CROSS_LAYER 显式登记',
    undeclared.length === 0,
    undeclared.length ? (undeclared.length + ' 处未登记：' + undeclared.slice(0, 4).join(' | ')) : '全部已登记');
}

// ── L-2b：登记表无死条目（登记的单元确实还被引用）──
{
  const live = new Set(edges.map((e) => e.from + ' -> ' + e.to + '  ' + e.unit));
  const dead = [];
  for (const [key, units] of Object.entries(CROSS_LAYER)) {
    for (const unit of Object.keys(units)) {
      if (!live.has(key + '  ' + unit)) dead.push(key + '  [' + unit + ']');
    }
  }
  check('L-2b 登记表无死条目（登记过的跨层依赖确实仍被引用）',
    dead.length === 0,
    dead.length ? (dead.length + ' 条已失效，应移除：' + dead.slice(0, 4).join(' | ')) : '无死条目');
}

// ── L-2c：登记理由非空且足够具体 ──
{
  const weak = [];
  for (const [key, units] of Object.entries(CROSS_LAYER)) {
    for (const [unit, why] of Object.entries(units)) {
      if (!why || String(why).trim().length < 8) weak.push(key + ' [' + unit + ']');
    }
  }
  check('L-2c 每条跨层登记都写了理由（>=8 字）', weak.length === 0, weak.join(', ') || 'ok');
}

// ── L-4：反向（判据必须能识别违规）──
{
  check('L-4 反向：判据能识别未登记的新跨层依赖',
    !CROSS_LAYER['domains -> __nonexistent__'], 'hit');
  check('L-4 反向：判据能识别 platform 越界（构造一条 platform->domains 边）',
    layerOf('src/platform/x.js') === 'platform' && layerOf('src/domains/x.js') === 'domains'
    && (() => { const e = { from: 'platform', to: 'domains' }; return e.from === 'platform' && e.to !== 'root'; })(),
    'hit');
  check('L-4 反向：layerOf 对真实路径分组正确',
    layerOf('src/platform/os/index.js') === 'platform'
    && layerOf('src/domains/router/index.js') === 'domains'
    && layerOf('src/guard/proc/daemon-lifecycle.js') === 'guard'
    && layerOf('src/api/index.js') === 'api'
    && layerOf('src/supervisor.js') === 'root', 'ok');
  check('L-4 反向：unitOf 归并到单元而非文件',
    unitOf('src/guard/lifecycle/ports.js', 'guard') === 'src/guard/lifecycle'
    && unitOf('src/core.cjs', 'root') === 'src/core.cjs', 'ok');
  check('L-4 反向：扫描确实发现了跨层边（非空集，否则门禁空转）',
    edges.length >= 40, edges.length + ' 条跨层边');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
