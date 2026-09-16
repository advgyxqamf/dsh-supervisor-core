'use strict';

// pidlookup/index.js —— 门面：平台分派 + 导出面（≤150 行）。
//
// 三端同一接口 findListeningPid(port) → number|null；另导出进程存活/命令行/标记匹配
// 与平台输出纯解析器（parse*）。平台差异全部下沉 probe.js（IO）/ norm.js（纯）。

const {
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine, normCmdline,
} = require('./norm');
const {
  linuxFind, linuxFindSs, macFind, winFind, readCmdline, pgrepList, isAlive,
} = require('./probe');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';

/** 找到监听 port 的进程 pid；找不到或环境不支持返回 null。 */
function findListeningPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  if (isLinux) {
    const a = linuxFind(port);
    if (a !== null && a !== undefined) return a;
    return linuxFindSs(port);
  }
  if (isMac) return macFind(port);
  return winFind(port);
}

/** 判断进程命令行是否匹配 DSH 特征（三平台可用）。 */
function isDshCmdline(pid) {
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  return /(^|\s)(node|.*dsh.*)(\s|$)/i.test(cmd) && /dsh/i.test(cmd);
}

module.exports = {
  findListeningPid, isAlive, readCmdline, normCmdline, isDshCmdline, pgrepList,
  parseProcNetTcpInodes, parseLsofPid, parseNetstatPid, parseSsPid,
  parseWmicCommandLine, parsePowerShellCommandLine,
};
