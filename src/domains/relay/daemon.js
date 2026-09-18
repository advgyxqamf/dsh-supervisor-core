'use strict';

const stateRoot = require('../../platform/service/state-root');
const { normalize } = require('../../platform/service/config');
const { LanManager } = require('./ops');
const ports = require('../../platform/service/ports').shared;
const { createCtlServer } = require('../../platform/ctl/server');
const hub = require('../../platform/service/log/hub');
const logcore = require('../../platform/service/log/logcore');

// lan-daemon：远程控制（relay/frpc）独立进程（L3b 进程解耦）。LanManager 从守卫进程解耦为独立
// 生命周期，守卫只做监测与按策略拉起；守卫重启/停止不影响本进程已有的 relay/frpc（只短暂影响
// 新增/变更对账）。运行：node src/domains/relay/daemon.js -c <configPath>（config.lanDaemon=true 时
// 由守卫 spawn detached，或手动调试）。数据流（松耦合）：守卫写 <stateDir>/lan-state.json（原子
// 0600），本进程每 2s 轮询 diff，实例增删/启停/remoteEnabled 变化触发 reconcile，令牌变化经
// lan.applyToken 热换 cookie；frp.json/frpc.toml 由本进程独占写，守卫经 ctl 委托读写；端口用独立
// 注册表 <stateDir>/ports-lan.json，避免与 router/守卫并发写；ctl 在 127.0.0.1:43108，白名单只含本域方法。

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_CTL_PORT = 43108;
const POLL_MS = 2000;

// lan 域的 ctl 控制面白名单。白名单是域知识，必须由本域自带：通用 dispatcher 不再内置 router 的表，
// 否则本进程 ctl 端口能调到 router 的方法（反之亦然），既非必要也扩大攻击面（PG-5）。
// eventsTail 须显式登记（dispatcher 内置特例，守卫 EventHub 增量拉事件）。
const LAN_CTL_METHODS = Object.freeze([
  'list', 'setFrp', 'frpStatus', 'frpAction', 'syncFrpc',
  'eventsTail',
]);

function loadConfig() {
  const cfgPath = process.argv.indexOf('-c') >= 0
    ? process.argv[process.argv.indexOf('-c') + 1]
    : (process.env.DSH_SUPERVISOR_CONFIG || path.join(stateRoot.supervisorDir(), 'config.json'));
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // DS-G4（§4.2 反转法）：platform 的 DEFAULTS 不含业务域键（lanCtlPort 等），本进程以域常量
  // DEFAULT_CTL_PORT 兜底；domains 到 app 属非法依赖边（L-2），域侧不得反向依赖编排层。
  return { cfgPath, ...normalize(raw) };
}

function main() {
  // 通用 dispatcher（POST /ctl {method,args}），白名单按域注入：lan 只暴露自己的方法面，
  // 不得因共用 dispatcher 调到 router 域的方法（PROVIDER-GATEWAY-ARCHITECTURE §5.3 PG-5）。

  const config = loadConfig();
  const swDir = config.stateFile ? path.dirname(path.resolve(config.stateFile)) : stateRoot.supervisorDir();
  const stateFile = path.join(swDir, 'lan-state.json');
  // 每进程唯一 LogCore（自有独立文件，单例 init 幂等）。本进程自己声明日志汇聚源，域名词留在域内：
  // 不能 require app/assembly/log-sources（那是 domains 到 app 的上行依赖，契约 DS-3 禁止）；
  // 注入方向是每个进程注册自己那一个源，守卫进程（compose.js）再注册全部源做汇聚。
  hub.registerSource("lan-daemon", { key: "lan" });
  const core = logcore.init({
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

  // 文件快照到 LanManager 的实例源：{ instances, save:noop }。wanPort 绑定权威在端口注册表
  // （syncProxy 先查 byOwner），inst.wanPort 仅展示/兜底。
  let snapshot = { instances: [], tokens: {}, mtime: 0, textHash: '' };
  const lanSource = {
    instances: [],
    save() { /* binding 只活在注册表，不回写守卫的 instances.json */ },
    // 与 instance 域契约同形的查询接口：relay/managed.js 只经 all() 取受管清单（DG-11），
    //   不直读内部数组。all() 返回的就是下面这个活数组，reload 的就地替换语义不变。
    all() { return this.instances; },
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
      // 令牌 diff：热换既有 relay cookie（无 relay 时仅刷新 tokenOf 供后续会话使用）
      if (snapshot.tokens) {
        for (const id of Object.keys(snapshot.tokens)) {
          try { lan.applyToken(id); } catch {}
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

  const ctl = createCtlServer({ target: lan, allowMethods: LAN_CTL_METHODS, logger, events });
  const ctlPort = Number(config.lanCtlPort) || DEFAULT_CTL_PORT;
  ctl.listen(ctlPort, '127.0.0.1', () => logger.info('[lan-daemon] ctl listening on 127.0.0.1:' + ctlPort));
  ctl.on('error', (e) => logger.error('[lan-daemon] ctl 监听失败(' + ctlPort + '): ' + e.message));

  events.append('lan_daemon_started', { pid: process.pid });
  logger.info('[lan-daemon] started pid=' + process.pid + ' state=' + stateFile);

  // 优雅停机必须等 SIGKILL 兜底窗口走完再退出：lan.shutdown() 到 frp.stop() 是同步函数，只发
  // SIGTERM 就返回，SIGKILL 兜底由内部 250ms 轮询在 3s 后执行；若紧接着 process.exit() 会终止该
  // 定时器，忽略 SIGTERM 的 frpc 永久存活成孤儿并占用公网隧道端口。故等 frpc 真正退出（或 3.5s 兜底）再 exit。
  // child 句柄由调用方在 lan.shutdown() 前捕获后传入：frp.stop() 会先置 this.child=null，此处再调
  // lan.frpChild() 只能取到 null，等待会立即 resolve 而成为空操作。
  const waitFrpcExit = (child) => new Promise((resolve) => {
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
    try { frpc = lan && lan.frpChild ? lan.frpChild() : null; } catch {}
    try { lan.shutdown(); } catch {}
    // 等 frpc 真正退出（SIGTERM 后 3s 发 SIGKILL 兜底），再落事件并退出。
    void waitFrpcExit(frpc).then(() => {
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

// 入口守卫：require 时不得启动真实 daemon（与 router/daemon 一致）。
if (require.main === module) main();
