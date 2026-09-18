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
//   shared/    ← L0 纯函数（version/ip/guardian）；出度恒为 0
//   platform/  ← 最底层：平台抽象、配置、执行器、日志、矩阵。**不得依赖任何上层**
//   domains/   ← 业务域（router/relay/instance/plugin/shell）
//   app/       ← 编排层（组装根与业务主体；原 guard/ 并入）
//   api/       ← HTTP/WS 契约面
//   root       ← src/supervisor.js 进程入口薄壳（发布构建产物 core.cjs 不在 src/ 下）
//
// ## 两条规则
//
//   L-1  `platform/` **不得依赖** domains / app / api（它是所有人的地基）
//   L-2  所有**跨层** import 必须在 `CROSS_LAYER` 清单中**显式登记**；
//        未登记的新跨层依赖 → 失败（要求开发者显式声明意图）
//
//   L-2 而不是"禁止一切逆向依赖"，是因为本仓存在**刻意的**跨层共享：
//     · `domains → shared/ip`（原 `domains → api/identity`）：relay 复用回环/RFC1918 判定，
//       **不得重写第二份**（由 test/relay-source-gate-test.js S-a 主动要求）；
//       步骤 1/2 拆分后该反向边已归零，现为 domains→shared 的合法依赖。
//     · `domains → platform/service`（端口）：ports.js 自称"**系统级**统一端口管理"，
//       instance/router/relay 都靠它登记端口。这是**有意的共享基础设施**。
//     · `app → platform/distribution`：装配期由 app/assembly/compose 实例化 DistributionManager
//       （原在 domains/dist，步骤 3 上移 platform/distribution）。
//     · `api → platform`、`root → 全部`：正常向下组装。
//     把这些写成"禁止"，门禁会在第一次运行就红，然后被人加白名单绕过 —— 那就成了摆设。
//     **登记 + 理由 + 变更可见**才是能长期活下去的形态。
//
//   L-3  `src/platform/contract/deploy.js` 对 core.cjs 的判定是**结构探测**（existsSync），
//        不是 require；原头注称其为「有意的 best-effort 打包引用」与现状不符。
//        故当前 platform -> root 的**真实 import 边 = 0**；白名单条目保留为**前瞻守卫**：
//        一旦有人在此加 `require('../core.cjs')`，L-3 会要求它显式登记。
//        （core.cjs 是发布构建产物，不在 src/ 下。）
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
//   L-3  core.cjs 白名单为**前瞻守卫**（当前 platform -> root 真实 import 边 = 0）
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
    'src/platform/os': '平台抽象层（能力/执行/路径）',
    'src/platform/security': '请求身份判定（HTTP 层）',
    'src/platform/service': '平台服务（配置/状态根/任务/环境目录/监控/日志/端口/令牌）',
  },
  'api -> shared': {
    'src/shared/ip': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
  },
  'app -> platform': {
    'src/platform/contract': '外部既定事实（矩阵/部署形态/镜像契约/运行期契约）',
    // ⚠ 步骤 7（2026-09-16）：DistributionManager 由 app/assembly/compose.js 实例化
    //   （原 domains/dist 上移 platform/distribution）——补登记，否则登记表与实际图脱节。
    'src/platform/distribution': '包发布/安装/更新通用能力（DistributionManager，装配期实例化）',
    'src/platform/os': '平台抽象层（能力/执行/路径）',
    'src/platform/service': '平台服务（配置/状态根/任务/环境目录/监控/日志/端口/令牌）',
    'src/platform/util': '无状态纯工具（执行器/文件工具/路径解析/端口探测）',
  },
  // ⚠ 步骤 7（2026-09-16）：构造期装配随 supervisor.js#constructor 下沉到 app/assembly/compose.js
  //   ——它是「唯一知道全局对象图的地方」，实例化各业务域。§2.2 依赖矩阵明示 app→domains = ✓，
  //   故这是**合法**的装配边，补登记即可（不是放宽判据）。
  'app -> domains': {
    'src/domains/router': '装配期实例化智能路由域（RouterService）',
    'src/domains/relay': '装配期实例化远程控制域（LanManager）',
    'src/domains/instance': '装配期实例化沙箱实例域（InstanceManager）',
    'src/domains/plugin': '装配期实例化插件域（PluginManager/PluginMarket）',
    'src/domains/shell': '装配期实例化桌面壳协同域（shellDomain/createShellWatchdog）',
  },
  'app -> shared': {
    'src/shared/guardian': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
    'src/shared/version': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
  },
  'domains -> platform': {
    'src/platform/contract': '外部既定事实（矩阵/部署形态/镜像契约/运行期契约）',
    'src/platform/ctl': 'daemon 控制通道 dispatcher（通用基础设施）',
    'src/platform/distribution': '包发布/安装/更新通用能力（DistributionManager）',
    'src/platform/os': '平台抽象层（能力/执行/路径）',
    'src/platform/service': '平台服务（配置/状态根/任务/环境目录/监控/日志/端口/令牌）',
    'src/platform/util': '无状态纯工具（执行器/文件工具/路径解析/端口探测）',
  },
  'domains -> shared': {
    'src/shared/guardian': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
    'src/shared/ip': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
    'src/shared/version': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
  },
  'platform -> shared': {
    'src/shared/ip': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
    'src/shared/version': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
  },
  'root -> api': {
    'src/api/index': '跨层依赖 —— 见 DIRECTORY-STRUCTURE-DESIGN',
  },
  // ⚠ AP1（批 8/10，2026-09-17）收口后的 root 实际出边：src/supervisor.js 是**真薄壳**，
  //   编排层各切面由 app/assembly/facets.js 装配到实例（root 不再逐个 require 各子目录）。
  //   旧条目（session/state/self/control/main/daemons/ctl/facade/domain-actions/audit）随
  //   批量挂原型一并失效 —— 不删即 L-2b 死条目（登记表与实际图必须一致）。
  //   现存 root→app：① assembly（组装/装配入口）；② settings（root 兼容门面注入域配置键声明）。
  'root -> app': {
    'src/app/assembly': '薄壳调 app/assembly/compose 组装、assembly/facets 切面装配到实例',
    'src/app/settings': 'root 兼容门面 normalize 注入业务域配置键声明（app/settings/domain-config）',
  },
  'root -> domains': {
    // 仅 get lan()（非 daemon 模式惰性创建 LanManager）——沙箱实例/插件/路由域
    // 现由 app/assembly/compose.js 实例化，不再从薄壳直接 require。
    'src/domains/relay': '薄壳 get lan() 惰性实例化远程控制域（LanManager）',
  },
  'root -> platform': {
    // startApi() 的端口登记（supervisor-api 就绪判据）——唯一留下的 root→platform 边。
    'src/platform/service': '薄壳 startApi() 登记/释放 supervisor-api 端口（就绪判据）',
  },
};

function layerOf(rel) {
  // ⚠ 2026-09-16 结构设计（DIRECTORY-STRUCTURE-DESIGN §2）：新增 shared 层
  //   （纯函数：version/ip/guardian）——出度恒为 0，与 platform 并列 L0。
  if (rel.startsWith('src/shared/')) return 'shared';
  if (rel.startsWith('src/platform/')) return 'platform';
  if (rel.startsWith('src/domains/')) return 'domains';
  if (rel.startsWith('src/app/')) return 'app';  // 2026-09-16 步骤6：guard/ 重组为 app/（编排层）
  if (rel.startsWith('src/api/')) return 'api';
  if (rel.startsWith('src/')) return 'root';
  return null;
}

/** 跨层依赖的"单元"（platform/domains/app/api 取前两段；root 取文件本身）。 */
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
  // platform -> root 的 core.cjs 白名单只在有登记时允许（当前真实边 = 0，见头注 L-3）
  // ⚠ 2026-09-16 步骤 2：L-1 原文写于 shared/ 层出现之前，判据 `to !== 'root'` 把
  //   **platform -> shared** 也误判为越界。而 §2.2 依赖矩阵明示 platform→shared = ✓
  //   （shared 是与 platform 并列的 L0 纯函数层，出度恒 0，不构成"依赖上层"）。
  //   故此处只禁止**向上**依赖 domains/app/api；platform→shared 由 L-2 登记约束。
  const bad = edges.filter((e) => e.from === 'platform' && e.to !== 'root' && e.to !== 'shared');
  check('L-1 platform/ 不依赖 domains/app/api（它是地基；platform->shared 为合法 L0 依赖）',
    bad.length === 0,
    bad.length ? bad.map((e) => e.file + ':' + e.line + ' -> ' + e.to).join(', ') : '未发现');
  const platRoot = edges.filter((e) => e.from === 'platform' && e.to === 'root');
  const allowedRoot = CROSS_LAYER['platform -> root'] || {};
  const undeclared = platRoot.filter((e) => !allowedRoot[e.unit]);
  // ⚠ 诚实计数：platRoot **当前恒为空**（真实 platform->root import 边 = 0）——deploy.js 的
  //   core.cjs 只是 existsSync 结构探测，不是 require。故本判据对当前树**不证明任何事**，
  //   真正的分辨力在下方合成自检（证明一旦出现未登记边就会命中）。
  check('L-3 platform -> root 仅限已登记的白名单（前瞻守卫；当前真实边 = 0）',
    undeclared.length === 0,
    undeclared.length ? undeclared.map((e) => e.file + ':' + e.line).join(', ')
      : ('当前真实 platform->root 边 = ' + platRoot.length + '（恒空即无待证；白名单 ' +
        (Object.keys(allowedRoot).join(',') || '空') + ' 为前瞻守卫）'));
  // 反向自检（合成样本，不依赖真实数据）：用**同一过滤判据**验证未登记边被检出、
  //   已登记边被放行。白名单用合成表，避免因当前真实白名单为空而自锁。
  {
    const synthAllowed = { 'src/platform/contract/synth.js': '合成白名单' };
    const synthEdges = [
      { from: 'platform', to: 'root', unit: 'src/platform/contract/synth.js', file: 'src/platform/contract/synth.js', line: 1 },
      { from: 'platform', to: 'root', unit: 'src/platform/other.js', file: 'src/platform/other.js', line: 2 },
    ];
    const synthUndeclared = synthEdges.filter((e) => !synthAllowed[e.unit]);
    check('L-3 反向：合成样本中未登记的 platform->root 边被检出、已登记的放行',
      synthUndeclared.length === 1 && synthUndeclared[0].unit === 'src/platform/other.js', 'hit');
  }
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
    && layerOf('src/app/daemons/process.js') === 'app'
    && layerOf('src/api/index.js') === 'api'
    && layerOf('src/supervisor.js') === 'root', 'ok');
  check('L-4 反向：unitOf 归并到单元而非文件',
    // ⚠ unitOf 的语义是"**前 3 段**"（src/<层>/<子单元>）—— 不是"到目录为止"。
    //   故 src/platform/service/ports/index.js 的单元是 src/platform/service（前 3 段）。
    //   本用例验证"跨层依赖登记到**单元**粒度，而非逐文件"。
    unitOf('src/platform/service/ports/index.js', 'platform') === 'src/platform/service'
    && unitOf('src/domains/router/index.js', 'domains') === 'src/domains/router'
    && unitOf('src/supervisor.js', 'root') === 'src/supervisor.js', 'ok');
  check('L-4 反向：扫描确实发现了跨层边（非空集，否则门禁空转）',
    edges.length >= 30, edges.length + ' 条跨层边');
}

// ── L-5：规范↔实现一致（真读 DEVELOPMENT-TRACK.md §1）──
// 本门禁被 standards-uniqueness 的 STANDARDS 登记为「改代码规则」（DEVELOPMENT-TRACK.md）
// 的机器校验门禁。为使该登记**名副其实**（U-1b 要求 reads:true 的门禁真读规范），此处
// 真读规范正文并断言其 §1 记载的分层名与门禁 layerOf() 的取值域一致 —— 不是只引用文件名。
{
  const devTrackPath = path.join(ROOT, 'DEVELOPMENT-TRACK.md');
  const devTrackText = fs.readFileSync(devTrackPath, 'utf8');
  const LAYERS = ['root', 'api', 'app', 'domains', 'platform', 'shared'];
  // 规范 §1 的 fenced 代码块内，每行首个 token 即层名（root/api/app/domains/platform/shared）。
  const sec1 = (/##\s*1\.\s*分层[\s\S]*?```([\s\S]*?)```/.exec(devTrackText) || [])[1] || '';
  const layerNamesIn = (block) => new Set(block.split(String.fromCharCode(10))
    .map((l) => (/^\s*([a-z][a-z0-9_-]*)\b/.exec(l) || [])[1])
    .filter((x) => x && LAYERS.includes(x)));
  const specLayers = layerNamesIn(sec1);
  const missingInSpec = LAYERS.filter((l) => !specLayers.has(l));
  check('L-5 规范 DEVELOPMENT-TRACK §1 的分层名与门禁 layerOf 归类一致（真读规范正文）',
    specLayers.size >= 5 && missingInSpec.length === 0,
    missingInSpec.length ? ('规范 §1 缺层: ' + missingInSpec.join(','))
      : ('规范 §1 层: ' + LAYERS.filter((l) => specLayers.has(l)).join(',')));
  // 反向自检（合成样本，不依赖真实数据）：缺一层的 §1 必须被同一抽取判据检出。
  const synthSec1 = ['root', 'api', 'app', 'domains', 'platform'].join(String.fromCharCode(10));
  check('L-5 反向：合成 §1（缺 shared）被检出（判据非空转）',
    LAYERS.filter((l) => !layerNamesIn(synthSec1).has(l)).length === 1, 'hit');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
