'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// lan-daemon —— 远程控制（relay/frpc）独立进程（L3b 进程解耦，2026-09）。
//
// 定位：LanManager 从守卫进程解耦为独立生命周期，守卫只做监测与按策略拉起。
// 守卫重启/停止不影响本进程 → 远程控制（40000 主 relay + 4000x 实例 relay + frpc 公网暴露）
// 不再随守卫中断（守卫重启只短暂影响新增/变更对账）。
//
// 运行方式（config.lanDaemon=true 时由守卫 spawn detached；或手动调试）：
//   node src/domains/relay/daemon.js -c <configPath>
//
// 数据流（守卫 → lan-daemon，松耦合）：
//   - 实例清单/令牌：守卫写 <stateDir>/lan-state.json（原子、0600），本进程每 2s 轮询 diff：
//       新增/删除/启停/remoteEnabled 变化 → 重建 LanManager 实例快照并 reconcile；
//       令牌变化 → lan.applyToken 热换 relay cookie。
//   - frp 设置/状态：frp.json/frpc.toml 在 stateDir（本进程独占写）；守卫经 ctl 委托读/写。
//   - 端口：本进程独立端口注册表 <stateDir>/ports-lan.json（relay 记录独占写，避免与 router/守卫
//     并发写同一 ports.json）。
//   - ctl：127.0.0.1:43108（复用 router-ctl 通用 dispatcher）——守卫经其委托 list/setFrp/frpStatus/
//     frpAction/syncFrpc；本进程 /health 供守卫探测。
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const HOME = os.homedir();
const DEFAULT_CTL_PORT = 43108;
const POLL_MS = 2000;

function loadConfig() {
  const cfgPath = process.argv.indexOf('-c') >= 0
    ? process.argv[process.argv.indexOf('-c') + 1]
    : (process.env.DSH_SUPERVISOR_CONFIG || path.join(require('../../platform/state-root').supervisorDir(), 'config.json'));
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const { normalize } = require('../../platform/config');
  return { cfgPath, ...normalize(raw) };
}

function main() {
  const { LanManager } = require('./manager');
  const ports = require('../../guard/lifecycle/ports').shared;
  const { createRouterCtlServer } = require('../router/ctl'); // 通用 dispatcher（POST /ctl {method,args}）

  const config = loadConfig();
  const swDir = config.stateFile ? path.dirname(path.resolve(config.stateFile)) : require('../../platform/state-root').supervisorDir();
  const stateFile = path.join(swDir, 'lan-state.json');
  // 系统日志框架（历史设计文档）：lan-daemon 经每进程唯一 LogCore 取日志/事件
  // （自有独立文件，不共享守卫文件；单例 init 幂等）。
  const core = require('../../platform/logcore').init({
    process: 'lan-daemon',
    logFile: config.lanLogFile || path.join(swDir, 'log', 'lan-daemon.log'),
    eventFile: config.lanEventsFile || path.join(swDir, 'events', 'lan.events.log'),
    logLevel: config.logLevel || 'info',
    logMaxBytes: config.logMaxBytes,
    eventsMaxBytes: config.eventsMaxBytes,
  });
  const events = core.events;
  const logger = core.logger;
  // relay 端口记录独占（lan 自己的注册表文件；避免与守卫/router-daemon 并发写同文件）
  try { ports.configureFile(path.join(swDir, 'ports-lan.json')); } catch {}

  // 文件快照 → LanManager 的「实例源」：{ instances:[…], save:noop }
  // 绑定（wanPort）权威在端口注册表（syncProxy 先查 byOwner），inst.wanPort 仅展示/兜底。
  let snapshot = { instances: [], tokens: {}, mtime: 0, textHash: '' };
  const lanSource = {
    instances: [],
    save() { /* binding 只活在注册表，不回写守卫的 instances.json */ },
  };

  const lan = new LanManager({
    configPath: config.cfgPath, // 端口回收精确匹配（RC6）
    stateDir: swDir,
    logger,
    events,
    instances: lanSource,
    tokenOf: (id) => snapshot.tokens[id] || '',
  });

  const reload = () => {
    try {
      const st = fs.statSync(stateFile);
      if (st.mtimeMs === snapshot.mtime) return false;
      const text = fs.readFileSync(stateFile, 'utf8');
      const doc = JSON.parse(text);
      const next = {
        mtime: st.mtimeMs,
        textHash: text,
        instances: Array.isArray(doc.instances) ? doc.instances : [],
        tokens: (doc.tokens && typeof doc.tokens === 'object') ? doc.tokens : {},
      };
      const changed = next.textHash !== snapshot.textHash;
      snapshot = next;
      if (!changed) return false;
      // 替换实例快照（LanManager.reconcile 以 port 关联已有代理：增删/启停经 reconcile 收敛）
      lanSource.instances.length = 0;
      for (const inst of snapshot.instances) {
        lanSource.instances.push({
          id: inst.id,
          name: inst.name || inst.id,
          port: inst.port,
          remoteEnabled: inst.remoteEnabled === true,
          remoteToken: inst.remoteToken || '',
          frpEnabled: inst.frpEnabled === true,
          frpRemotePort: inst.frpRemotePort || null,
          wanPort: inst.wanPort || null,
        });
      }
      // 令牌 diff → 热换既有 relay cookie（无 relay 时仅刷新 tokenOf 供后续会话使用）
      if (snapshot.tokens) {
        for (const [id, tok] of Object.entries(snapshot.tokens)) {
          try { lan.applyToken(id, tok || ''); } catch {}
        }
      }
      return true;
    } catch (e) {
      if (e && e.code !== 'ENOENT') logger.warn('[lan-daemon] 状态读取异常: ' + (e && e.message));
      return false;
    }
  };

  let changedLast = false;
  const tick = () => {
    try {
      const changed = reload();
      lan.reconcile().catch((e) => logger.warn && logger.warn('[lan-daemon] reconcile: ' + ((e && e.stack) || e))); // async（TCP 可达判定）
      if (changed || changedLast) {
        try { lan.syncFrpc(); } catch {}
      }
      changedLast = changed;
    } catch (e) {
      logger.warn('[lan-daemon] tick: ' + (e && e.message));
    }
  };

  // 立即读一次（守卫可能在 spawn 前已写好状态），随后周期性对账
  tick();
  const timer = setInterval(tick, POLL_MS);

  const ctl = createRouterCtlServer({ router: lan, logger, events });
  const ctlPort = Number(config.lanCtlPort) || DEFAULT_CTL_PORT;
  ctl.listen(ctlPort, '127.0.0.1', () => logger.info('[lan-daemon] ctl listening on 127.0.0.1:' + ctlPort));
  ctl.on('error', (e) => logger.error('[lan-daemon] ctl 监听失败(' + ctlPort + '): ' + e.message));

  events.append('lan_daemon_started', { pid: process.pid });
  logger.info('[lan-daemon] started pid=' + process.pid + ' state=' + stateFile);

  // ⚠ 2026-09-12（P1 修复）：优雅停机必须**等 SIGKILL 兜底窗口走完**再退出。
  //
  //   缺陷：`lan.shutdown()` → `frpmgr.stop()` 是**同步**函数 —— 它只发 SIGTERM（立即返回），
  //     SIGKILL 兜底由内部 250ms 间隔轮询在 3s 后执行（frpmgr.js:259-266）。
  //     而此处紧接着 `process.exit()` 会**终止该定时器** → 忽略 SIGTERM 的 frpc
  //     **永久存活成孤儿**，占用公网隧道端口。
  //
  //   `router/daemon.js` 早已是 async 等待式（可对照），本文件是同类缺陷的另一处。
  //
  //   修法：等 frpmgr 的子进程真正退出（或 3.5s 兜底）再 exit。
  const waitFrpcExit = () => new Promise((resolve) => {
    const fm = lan && lan.frpmgr;
    const child = fm && fm.child;
    if (!child || child.exitCode !== null) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null || Date.now() - t0 > 3500) { clearInterval(iv); resolve(); }
    }, 100);
    if (iv.unref) iv.unref();
    // 兜底：即便轮询异常，也不能让进程永不退出
    setTimeout(resolve, 4000).unref();
  });
  let _exiting = false;
  const shutdown = (code) => {
    if (_exiting) { process.exit(code || 0); }
    _exiting = true;
    logger.info('[lan-daemon] shutting down');
    try { clearInterval(timer); } catch {}
    try { ctl.close(); } catch {}
    let frpc = null;
    try { frpc = lan && lan.frpmgr ? lan.frpmgr.child : null; } catch {}
    try { lan.shutdown(); } catch {}
    // 等 frpc 真正退出（SIGTERM → 3s 后 SIGKILL 兜底），再落事件并退出。
    void waitFrpcExit().then(() => {
      if (frpc && frpc.exitCode === null) logger.warn('[lan-daemon] frpc 未在窗口内退出（已发 SIGKILL）');
      try { events.append('lan_daemon_stopped', {}); } catch {}
      process.exit(code || 0);
    });
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', (e) => logger.error('[lan-daemon] uncaughtException: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => logger.error('[lan-daemon] unhandledRejection: ' + ((e && (e.stack || e.message)) || e)));
}

main();
