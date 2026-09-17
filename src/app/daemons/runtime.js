'use strict';

const scripts = require('./scripts');

// 受管 daemon 运行时（生命周期实例 / ensure 结果翻译 / lan 保活与状态同步）。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的
// **惰性 deps**（WeakMap；getter 每次读 host 实时值，装配期 host 未就绪也安全）。方法仍以
// { methods } 导出、名字与体逐字保留：装配路径 installMethods(host, mod.methods) 不变，
// 且 TK-G4（读 _syncLanState 体）与 G10-d（读顶层 require('./scripts') 与 daemonScript 调用）
// 等**读源码形态**的门禁覆盖面不变；AT 棘轮的直接方法调用计数归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');
// process.js 导出命名导出 `{ DaemonLifecycle }`，且与本文件同目录。
const { DaemonLifecycle } = require('./process');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      configPath() { return host.configPath; },
      config() { return host.config; },
      ctl() { return host.ctl; },
      logger() { return host.logger; },
      events() { return host.events; },
      name() { return host.name; },
      daemons() { return host.daemons; },
      instances() { return host.instances; },
      views() { return host.views; },
      tokenService() { return host.tokenService; },
      router() { return host.router; },
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用；外部覆写 host 方法仍生效）。
      dshMainView() { return host.dshMainView(); },
      daemonLifecycle(kind) { return host._daemonLifecycle(kind); },
      daemonEnsureResult(lc, writeOwnerLock) { return host._daemonEnsureResult(lc, writeOwnerLock); },
      disableRouterPersist() { return host._disableRouterPersist(); },
      // 可变字段：readX()/writeX(v)（不得以写动词开头命名，避免被门面写动作判据误判）。
      readLc() { return host._lc; },
      writeLc(v) { host._lc = v; },
      readLastLanStateJson() { return host._lastLanStateJson; },
      writeLastLanStateJson(v) { host._lastLanStateJson = v; },
      readLastOccupiedWarn() { return host._lastOccupiedWarn; },
      writeLastOccupiedWarn(v) { host._lastOccupiedWarn = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    /** 统一受管进程生命周期实例（懒加载单例；lan/router 共用 DaemonLifecycle 核心）。
     *  身份文件（owner 连续：守卫重启=接管既有 daemon）+ spawn latch + 换代停旧/等死/等端口释放 全在核心内。 */
    _daemonLifecycle(kind) {
      const d = depsOf(this);
      if (!d.configPath()) return null; // 非守卫实例（测试）绝不管理独立 daemon
      let lc = d.readLc();
      if (!lc) { lc = {}; d.writeLc(lc); }
      if (lc[kind]) return lc[kind];
      const cfgPath = d.configPath();
      const isLan = kind === 'lan';
      // 路径解析必须用单一真源：不能靠 __dirname 相对路径拼 'src/domains/...'
      //   （层级调整后会指向不存在的位置，使 _daemonLifecycle 恒为 null，守卫无法自起 daemon）。
      //   app/daemons/scripts.js 提供域到脚本映射；platform/util/srcpath 只做通用 resolve（存在性验证），
      //   域名词不渗入 platform。
      const script = scripts.daemonScript(isLan ? 'lan' : 'router');
      if (!script) return null;
      const dir = path.dirname(d.config().stateFile);
      lc[kind] = new DaemonLifecycle({
        name: kind,
        script,
        args: ['-c', cfgPath],
        ctlPort: isLan ? d.ctl().lanPort() : d.ctl().routerPort(),
        cmdMark: isLan ? 'lan-daemon' : 'router-daemon',
        identityFile: path.join(dir, kind + '-daemon.identity.json'),
        spawnEnv: () => ({ DSH_SUPERVISOR_CONFIG: cfgPath }),
        logger: d.logger(),
        events: d.events(),
      });
      return lc[kind];
    },
    /** ensure 结果 -> 旧调用方契约翻译（adopted 不带 spawned：避免监督误报“失联重拉”）。 */
    _daemonEnsureResult(lc, writeOwnerLock) {
      const d = depsOf(this);
      const rr = lc.ensureRunning();
      if (rr.mode === 'started' || rr.mode === 'adopted') {
        if (writeOwnerLock) writeOwnerLock();
        return rr.mode === 'started'
          ? { active: true, mode: 'daemon', spawned: rr.pid }
          : { active: true, mode: 'daemon' }; // adopted：既有进程，owner 连续
      }
      if (rr.mode === 'barrier') return { active: false, mode: 'barrier', reason: '生命周期窗口内' };
      if (rr.mode === 'reclaiming') return { active: false, mode: 'reclaiming', stale: rr.stale };
      // spawn 未能启动（脚本不可执行等）时如实上报，不当作「已 started」。
      if (rr.mode === 'failed') return { active: false, mode: 'error', error: rr.error || ('daemon 未启动: ' + d.name()) };
      return { active: false, mode: 'error', error: 'unexpected lifecycle mode: ' + rr.mode };
    },
    /** 实例清单+令牌 -> lan-state.json（原子 0600；daemon 轮询消费）。hash 相同不落盘。 */
    _syncLanState() {
      const d = depsOf(this);
      if (!d.daemons().enabled()) return;
      try {
        const dir = path.dirname(d.config().stateFile);
        const file = path.join(dir, 'lan-state.json');
        // main(原生主干)由守卫核心持有(dsh-main.json)，不再在沙箱数组——lan-state 合成两者(协议不变)
        const inst = d.instances();
        const instances = [
          ...(inst ? inst.all() : []),
          ...(d.dshMainView ? [d.views().dshMain()] : []),
        ];
        const tokens = {};
        for (const i of instances) {
          try {
            const t = d.tokenService() && d.tokenService().get(i.id);
            if (t) tokens[i.id] = t;
          } catch {}
        }
        // 哈希必须用稳定内容（无易变时间戳），否则 30s 监督 tick 每次重写 lan-state，
        // lan-daemon 每轮视为变化并重复 applyToken/重换 cookie。
        // 端口权威：同步实例不含 wanPort，relay 端口唯一权威是端口注册表（ports-lan.json，
        // daemon claimSlot byOwner 复用）；曾含 wanPort 导致守卫把历史写死值传播给 daemon，
        // 与注册表分裂成 ghost 双族。仅当内容真变化才落盘。
        const body = JSON.stringify({ instances: instances.map((i) => ({
          id: i.id, name: i.name, port: i.port, remoteEnabled: !!i.remoteEnabled,
          remoteToken: i.remoteToken || '', frpEnabled: !!i.frpEnabled,
          frpRemotePort: i.frpRemotePort || null,
        })), tokens }, null, 1);
        if (body === d.readLastLanStateJson()) return;
        fs.mkdirSync(dir, { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, file);
        d.writeLastLanStateJson(body);
      } catch (e) {
        d.logger() && d.logger().warn && d.logger().warn('_syncLanState: ' + (e && e.message));
      }
    },
    /** 拉起独立 lan-daemon（detached；幂等：43108 已被本守卫管理 daemon 占用则不重复拉起）。 */
    _ensureLanRuntime(desiredRunning) {
      const d = depsOf(this);
      try {
        const active = d.daemons().lanActive();
        const managed = d.daemons().lanManaged();
        if (desiredRunning !== false && active && managed) return { active: true, mode: 'daemon' };
        if (desiredRunning !== false && active && !managed) return { active: false, mode: 'external' }; // 异主不接管
        if (desiredRunning === false) {
          if (active && managed) {
            const pid = pidlook.findListeningPid(d.ctl().lanPort());
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
            d.daemons().clearLanLock();
            const lcS = d.daemonLifecycle('lan');
            if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
            return { active: false, mode: 'daemon', stopping: true };
          }
          return { active: false, mode: 'none' };
        }
        // 统一进程生命周期：spawn 一次性 + 换代停旧/等死/等端口释放，
        // 身份文件 owner 连续（守卫重启=接管），全部收敛在 DaemonLifecycle，此处只做契约翻译。
        const lc = d.daemonLifecycle('lan');
        if (!lc) return { active: false, mode: 'none', error: 'lan-daemon 脚本缺失' };
        return d.daemonEnsureResult(lc, () => d.daemons().writeLanLock());
      } catch (e) {
        return { active: false, mode: 'error', error: e.message };
      }
    },

    /** 拉起独立 router-daemon（detached 子进程——守卫退出不影响它；幂等：ctl 口已被占则不重复拉起）。
     *  @returns { active:boolean, mode:'daemon'|'embedded'|'error', error? } */
    _ensureRouterRuntime(desiredRunning) {
      const d = depsOf(this);
      try {
        const daemonActive = d.daemons().routerActive();
        const managed = d.daemons().managed();
        // daemon 模式下守卫不得写状态文件：任何返回 daemon 模式的路径都必须关闭写权，
        //   否则守卫会与 daemon 双写 providers.json，后写者覆盖前者。
        if (desiredRunning !== false && daemonActive && managed) {
          // daemon 已在跑且为本守卫管理：监督模式（守卫不再内嵌启动）
          d.disableRouterPersist();
          return { active: true, mode: 'daemon' };
        }
        if (desiredRunning !== false && daemonActive && !managed) {
          // 有 daemon 在跑但非本守卫管理（异主/测试环境）：绝不接管，退回内嵌语义
          // （测试内嵌 RouterService 用独立 TMP 状态，不触碰生产 ctl）
          return { active: false, mode: 'embedded' };
        }
        if (desiredRunning === false) {
          // 停止语义：仅停「本守卫管理」的 daemon；异主 daemon 不碰；否则由调用方停内嵌 router
          if (daemonActive && managed) {
            // 归属校验（D10）：managed 是「本 stateDir 写过管理锁」的**静态授权**，不等于
            //   「ctl 端口占用者就是我」（锁内 pid 从不比对）。若按端口 pid 直接 SIGTERM，
            //   「陈旧锁 + 外来同名 daemon 占同 ctl 口」会误杀外来进程。故 kill 前先用
            //   DaemonLifecycle.classify() 做**动态归属**判定（与 supervise.js 同源判据）。
            //   external（占用者非本守卫代际）=> 拒绝停用且不碰进程/锁/身份。
            //   其余保持既有行为：running/reclaiming 是本守卫或同 cmdMark 残留；barrier 是
            //   换代窗口内刚拉起的本守卫 daemon（stop 请求下本就该停）；absent 无 pid 可杀。
            const lcS = d.daemonLifecycle('router');
            const c = (lcS && typeof lcS.classify === 'function') ? lcS.classify() : null;
            if (c && c.mode === 'external') {
              if (d.logger() && d.logger().warn) {
                d.logger().warn('[router] 停止：ctl ' + d.ctl().routerPort() + ' 被外部进程占用（pid=' + c.owner + '），拒绝停用以免误杀异主 daemon');
              }
              return { active: false, mode: 'embedded', refused: 'external' };
            }
            const pid = pidlook.findListeningPid(d.ctl().routerPort());
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
            d.daemons().clearRouterDaemonLock();
            if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
            return { active: false, mode: 'daemon', stopping: true };
          }
          return { active: false, mode: 'embedded' };
        }
        // 非守卫实例（测试 Supervisor 等无配置文件构造）绝不拉起/接管独立 daemon——纯内嵌语义，
        // 防测试进程在探测不可见宿主 daemon 的环境下把 router-daemon 拉出一堆 stray。
        if (!d.configPath()) {
          return { active: false, mode: 'embedded', reason: 'non-guard' };
        }
        // 统一进程生命周期（与 lan 对称）：见 DaemonLifecycle。
        const lc = d.daemonLifecycle('router');
        if (!lc) return { active: false, mode: 'embedded' };
        const res = d.daemonEnsureResult(lc, () => d.daemons().writeRouterDaemonLock());
        // 本路径也可能返回 daemon 模式（拉起/接管成功），同样关闭守卫写权（见函数顶部说明）。
        if (res && res.mode === 'daemon') d.disableRouterPersist();
        return res;
      } catch (e) {
        return { active: false, mode: 'error', error: e.message };
      }
    },

    /** daemon 模式下关闭守卫对 providers.json 的写权（防双写覆盖）。
     *  _ensureRouterRuntime 有三条返回 daemon 模式的路径，该纪律必须在每条上执行，
     *  集中一处避免新增路径时再漏。幂等：重复调用无副作用。 */
    _disableRouterPersist() {
      const d = depsOf(this);
      const router = d.router();
      if (router && typeof router.setPersistEnabled === 'function') {
        try { router.setPersistEnabled(false); } catch {}
      }
    },

    _warnOccupied() {
      const d = depsOf(this);
      const now = Date.now();
      if (now - d.readLastOccupiedWarn() > 60000) {
        d.writeLastOccupiedWarn(now);
        d.events().append('port_occupied_unhealthy', { host: d.config().targetHost, port: d.config().targetPort });
      }
    },
  },
};
