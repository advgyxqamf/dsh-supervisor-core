'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// app/daemons/process-marks.js —— cmdline 标记派生（**纯**：无 IO / 无 this）。
//
// 从 app/daemons/process.js 构造器拆出（R3 严值 DF-2：process.js ≤300；
// DF-3：纯派生与进程生命周期分离；DF-6：可独立 require 单测）。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 script 派生权威 cmdline 标记。
 *
 * ⚠ P0-2 修复（2026-09-12）：`cmdMark` 与实际命令行**永不匹配**。
 *
 *   缺陷：daemon 由 `spawn(process.execPath, [this.script, ...this.args])` 拉起，
 *     故真实 cmdline 形如 `node <pkg>/src/domains/router/daemon.js -c <cfg>`；
 *     而调用方传的 `cmdMark` 是 `'router-daemon'` —— 该子串**不在** cmdline 里
 *     （实测 indexOf = -1）。于是 `_ctlOwnerPid()` 恒 null：
 *       · 换代分支（旧代占 ctl 时 TERM + 等端口释放）**永不执行**；
 *       · `classify()` 的 external / reclaiming 状态**永不可达**
 *         →「ctl 被外部进程占用，不接管不拉起」这条红线形同不存在。
 *
 *   对照：同仓另两处反查监听者（supervise-view.js、control-view.js）**都**额外
 *     匹配 `/domains/router/daemon.js` 路径形态 —— 只有本核心这一条路径失明，
 *     属「同一纪律在多条路径中只在一处执行」的反面（此处是唯一漏的那处）。
 *
 *   修法：**从 `script` 派生权威标记**（它就是 spawn 时真正写进 cmdline 的那个路径），
 *     与调用方给的语义标记**并列**匹配。这样不依赖调用方记住传路径，
 *     且脚本位置演进（src/ 移动）时自动跟随。
 *
 * @param {string} script spawn 的脚本绝对路径
 * @param {string} [cmdMark] 调用方给的语义标记
 * @returns {string[]} 全部标记（语义名 + 绝对路径 + 相对包根尾段）
 */
function deriveCmdMarks(script, cmdMark) {
  const norm = (s) => String(s || '').replace(/\\/g, '/');
  const marks = [];
  if (cmdMark) marks.push(String(cmdMark));
  if (script) {
    // ① 绝对路径原样（spawn 用的就是它）
    marks.push(norm(script));
    // ② 相对包根的尾段（处理 cwd/相对调用差异）
    const m = /[/\\](src[/\\][^\s]+|domains[/\\][^\s]+)$/.exec(norm(script));
    if (m) marks.push(m[1]);
  }
  return marks;
}

module.exports = { deriveCmdMarks };
