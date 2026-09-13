'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 跨仓门禁的**壳仓定位**（2026-09-13）
//
// ## 为什么需要它
//
// 内核有多条门禁要读**壳仓**源码来验证跨仓契约（服务定义模板、identity 的 exe 字段、
// 版本向量一致、update-journal 未被消费……）。它们原先一律写死
// `path.join(ROOT, '..', 'dsh-supervisor-launcher')`（假定两仓同级），于是：
//
//   · 本地（两仓并排）→ 断言真的执行；
//   · **CI（只检出内核仓）→ 一律走 SKIP 分支、静默通过** →
//     跨仓契约在产线上**从未被检查**，回归不会被拦住（典型的「假门禁」）。
//
// 实测：内核 CI 首次运行 master push 时，R10 的**反向断言**（扫描非空转）失败，
// 而其余 4 处跨仓断言全部静默 SKIP 通过。
//
// ## 设计
//
// `DSH_SHELL_REPO` 环境变量可显式指定壳仓根目录；CI 检出壳仓后设置它。
// 未设置时回退到「两仓同级」的既有约定（本地开发无感）。
//
// **关键**：一旦设置了 `DSH_SHELL_REPO`（= 调用方声明「壳仓应当可用」），
//   缺失即视为**失败**而不是跳过 —— 否则 CI 里一次检出失败又会退化成静默通过。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 壳仓根目录：优先 `DSH_SHELL_REPO`，否则回退到同级目录约定。 */
function shellRepoPath() {
  const env = process.env.DSH_SHELL_REPO;
  if (env && String(env).trim()) return String(env).trim();
  return path.join(ROOT, '..', 'dsh-supervisor-launcher');
}

/** 调用方是否**声明了壳仓应当存在**（CI 会设置该变量）。 */
function strict() {
  return !!(process.env.DSH_SHELL_REPO && String(process.env.DSH_SHELL_REPO).trim());
}

/** 壳仓内的文件路径。 */
function pathIn(...rel) {
  return path.join(shellRepoPath(), ...rel);
}

/** 壳仓文件是否存在。 */
function exists(...rel) {
  try { return fs.existsSync(pathIn(...rel)); } catch { return false; }
}

/** 读壳仓文件；不存在返回 null。 */
function read(...rel) {
  try { return fs.readFileSync(pathIn(...rel), 'utf8'); } catch { return null; }
}

/** 供 SKIP 分支使用：返回「是否应硬失败」的诊断串（null = 可以跳过）。 */
function skipReason(what) {
  if (strict()) {
    return '跨仓门禁「' + what + '」无法执行：DSH_SHELL_REPO 已设为 ' + process.env.DSH_SHELL_REPO +
      ' 但对应文件缺失 —— 不得静默跳过（否则该契约在 CI 中永不检查）';
  }
  return null;
}

module.exports = { shellRepoPath, pathIn, exists, read, strict, skipReason, ROOT };
