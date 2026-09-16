'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/daemons/scripts.js —— 受管 daemon 脚本位置（**域名词唯一归属地**）
//
// DIRECTORY-STRUCTURE-DESIGN §4.2「反转法」：
//   platform 只留注册/通用接口，域名词由 app 层持有并注入。
//
// 原 `platform/util/srcpath.js` 固化 `DAEMON_REL = { router, lan }` —— 平台渗入
// 业务域知识（DS-G4 违规）。现将「daemon 种类 → 脚本相对路径」的映射整体上移
// 到本模块；平台侧只保留通用 `resolve(relPath)`。
//
// ⚠ 不变式（行为逐字保持）：脚本相对 `src/` 的位置未变，仍经
//   `srcpath.resolve` 做存在性验证；不存在返回 **null**（调用方据此降级）。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const { resolve } = require('../../platform/util/srcpath');

/** daemon 脚本的相对位置（相对 `src/`）——由 app 层声明并注入 platform。 */
const DAEMON_REL = {
  router: path.join('domains', 'router', 'daemon.js'),
  lan: path.join('domains', 'relay', 'daemon.js'),
};

/**
 * 受管 daemon 脚本的绝对路径。
 *
 * @param {'router'|'lan'} kind
 * @returns {string|null} 存在时返回路径；**不存在时返回 null**（调用方据此降级）
 */
function daemonScript(kind) {
  const rel = DAEMON_REL[kind];
  if (!rel) return null;
  return resolve(rel);
}

module.exports = { daemonScript, DAEMON_REL };
