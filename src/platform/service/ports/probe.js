'use strict';

// 端口探测与旧代进程回收（纯 IO）：TCP 连接探测 / bind 探测 / 监听 pid 反查 / cmdline 回收。

const net = require('node:net');
const probe = require('../../util/probe');
const pidlookup = require('../../os/pidlookup');

/** TCP connect 探测：能连接即视为有进程在监听。 */
function portListening(port) { return probe.portListening('127.0.0.1', Number(port), 300); }

/** bind 探测：能在 127.0.0.1 绑定即可分配；任何 bind 错误（EADDRINUSE 等）即不可分配。 */
function bindable(port) {
  return new Promise((resolve) => {
    let done = false;
    const srv = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { srv.close(); } catch {} resolve(ok); };
    srv.once('error', () => finish(false));
    srv.listen(port, '127.0.0.1', () => finish(true));
  });
}

/** 按端口反查监听进程 pid；不可得返回 null。 */
function listeningPid(port) {
  try { return pidlookup.findListeningPid(port); } catch { return null; }
}

/** 按 cmdline 特征回收「本工程旧代」进程（YAMA 免疫）；返回终止数。 */
function reclaimByCmdMark(cmdMark, cfgStr) {
  if (!cmdMark) return 0;
  let killed = 0;
  try {
    const cfg = cfgStr || '';
    for (const m of pidlookup.pgrepList(cmdMark)) {
      const pid = m.pid;
      if (pid === process.pid) continue;
      const cmd = m.cmdline;
      if (cfg && cmd.indexOf(cfg) < 0) continue;
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
  } catch {}
  return killed;
}

module.exports = { portListening, bindable, listeningPid, reclaimByCmdMark };
