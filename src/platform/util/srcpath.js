'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 源文件定位器（**单一真源**，2026-09-11）
//
// ## 为什么需要它（一次生产级缺陷）
//
// §7.6 把 `src/supervisor.js` 拆成 `src/guard/supervisor/*.js` 后，
// **两处路径推导没有跟着更新**：
//
//   control-view.js   path.join(__dirname, '..') + 'src/domains/router/daemon.js'
//   registry-view.js  path.join(__dirname, 'domains', 'router', 'daemon.js')
//
// 而 `__dirname` 已从 `src/` 变成 `src/guard/supervisor/`，于是解析结果是
// `src/guard/src/domains/router/daemon.js` —— **不存在**。
//
// 后果：`_daemonLifecycle()` 的 `fs.existsSync` 恒为假 → 恒返回 null →
// **守卫永远无法自起 router/lan daemon**，`lanDaemon=true` 直接退化为
// 「脚本缺失」。且既有测试（daemon-lifecycle-test.js / lan-daemon-test.js）
// 都**直接 new / 自行 spawn**，完全绕过这条路径 → 测试全绿而功能全废。
//
// ## 设计（DS-G4 步骤：platform 去域名词）
//
// 用**存在性验证**代替脆弱的相对路径推算：候选根逐个验证
// 「根下确实存在本模块自身」——第一个通过者胜出。
// 这样任何目录层级调整都不会再静默失效 —— 若所有候选都不成立，
// 则返回 null（调用方据此降级）。
//
// ⚠ 本模块只做**通用**路径能力（`resolve(relPath)`）。业务域名词
//   （router/lan → 脚本）的映射已按 DIRECTORY-STRUCTURE-DESIGN §4.2
//   「反转法」上移到 `app/daemons/scripts.js` —— platform 层不得出现域名词；
//   域名词由 app 侧注入本模块的通用解析。
//
// 门禁 G10 断言本模块解析出的每个脚本路径都真实存在。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

/**
 * 本模块相对 `src/` 的位置——候选根的**通用**存在性判据（不含任何业务域名词）。
 */
const SELF_REL = path.join('platform', 'util', 'srcpath.js');

/**
 * 候选 `src/` 根（按可信度排序）。
 *
 * 本模块位于 `<pkg>/src/platform/util/`，故源码态根 = `__dirname/../..`。
 * 其余候选应对「被 bundle / 目录被搬移 / 开发态 cwd」等布局；判据统一为
 * 「该根下存在 `SELF_REL`」——与实际布局解耦。
 *
 * @returns {{label:string, path:string}[]}
 */
function _candidateRoots() {
  return [
    { label: '__dirname/../..', path: path.join(__dirname, '..', '..') },
    { label: '__dirname/../../../src', path: path.join(__dirname, '..', '..', '..', 'src') },
    { label: 'cwd/src', path: path.join(process.cwd(), 'src') },
  ];
}

let _root = null; // 解析结果缓存（进程内不变）

/**
 * 定位包内 `src/` 目录。
 *
 * 候选逐个**用存在性验证**（见 `_candidateRoots`）。
 *
 * @returns {string|null} `src/` 的绝对路径；全部候选不成立时 null
 */
function resolveSrcRoot() {
  if (_root) return _root;
  for (const p of _candidateRoots()) {
    if (fs.existsSync(path.join(p.path, SELF_REL))) {
      _root = p.path;
      return _root;
    }
  }
  return null;
}

/**
 * 通用路径解析：把相对 `src/` 的路径解析为**真实存在**的绝对路径。
 *
 * 这是 platform 层保留的唯一「脚本定位」能力——域名词映射由 app 侧提供。
 *
 * @param {string} relPath 相对 `src/` 的路径（域名词由 `app/daemons/scripts.js` 注入）
 * @returns {string|null} 存在时返回绝对路径；**不存在时返回 null**（调用方据此降级）
 */
function resolve(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const root = resolveSrcRoot();
  if (!root) return null;
  const p = path.join(root, relPath);
  return fs.existsSync(p) ? p : null;
}

/** 诊断用：所有候选根及其成立情况（供 --self-check 与门禁输出）。 */
function describe() {
  return {
    resolved: resolveSrcRoot(),
    candidates: _candidateRoots().map((p) => ({
      label: p.label,
      path: p.path,
      selfModule: fs.existsSync(path.join(p.path, SELF_REL)),
    })),
  };
}

/**
 * 定位**包根**（含 `package.json` 的目录）。
 *
 * 与 [`resolveSrcRoot`] 同一目的（对抗目录层级变化），但判据不同：
 * 包根用 `package.json` 验证。
 *
 * ⚠ 同类缺陷：`settings-view.js` 的 `_vcsRoot()` 曾用 `path.resolve(__dirname, '..')`
 *   并注释「= dsh-supervisor/」；但 §7.6 拆分后 `__dirname` 变为 `src/guard/supervisor/`，
 *   该表达式实际得到 `src/guard/` —— 注释与行为已经不符，
 *   导致「排除嵌套 .git」的判据作用在错误的目录上。
 *
 * @returns {string|null}
 */
function resolvePackageRoot() {
  // 从本模块位置逐级上溯找 package.json（比固定层数稳健）。
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：cwd（开发态直接 node src/... 运行）
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd();
  return null;
}

module.exports = { resolve, resolveSrcRoot, resolvePackageRoot, describe };
