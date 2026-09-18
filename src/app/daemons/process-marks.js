'use strict';

// app/daemons/process-marks.js —— cmdline 标记派生（纯模块：无 IO、无 this）。
// 从 process.js 构造器拆出，纯派生与进程生命周期分离，可独立 require 单测。

/**
 * 从 script 派生权威 cmdline 标记：cmdMark 与实际命令行永不匹配。
 *
 * daemon 由 spawn(process.execPath, [script, ...args]) 拉起，真实 cmdline 形如
 * `node <pkg>/src/domains/router/daemon.js -c <cfg>`，而调用方传的 cmdMark 'router-daemon'
 * 不在 cmdline 里，导致 _ctlOwnerPid() 恒 null：换代分支永不执行，classify() 的
 * external/reclaiming 状态永不可达。故从 script（真正写进 cmdline 的路径）派生权威标记，
 * 与语义标记并列匹配，不依赖调用方记住传路径，脚本位置演进时自动跟随。
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
    // 绝对路径原样（spawn 用的就是它）
    marks.push(norm(script));
    // 相对包根的尾段（处理 cwd/相对调用差异）
    const m = /[/\\](src[/\\][^\s]+|domains[/\\][^\s]+)$/.exec(norm(script));
    if (m) marks.push(m[1]);
  }
  return marks;
}

module.exports = { deriveCmdMarks };
