'use strict';

// 远程控制子系统：多实例反向代理（relay）+ 公网暴露（frpc）。
// 单一数据源：远程控制配置（remoteEnabled/remoteToken/frpEnabled/frpRemotePort）存于 instances.json；
// lanInstances 只是内存派生缓存（代理端口注册），由 syncProxy 维护，不单独落盘。
// 本模块只做代理/暴露编排，不触碰任何实例生命周期动作。

const os = require('node:os');
const monitor = require('../../guard/monitor/index');
const pidlook = require('../../platform/os/pidlookup');
const ports = require('../../guard/lifecycle/ports').shared;
const { FrpManager } = require('./frpmgr');

class LanManager {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.instances = opts.instances; // InstanceManager（沙箱实例配置单一数据源）
    this.configPath = opts.configPath || ''; // 端口回收 reclaimCfg 精确匹配——防误杀其它配置的 lan-daemon
    this.mainOf = opts.mainOf || null; // 守卫核心服务的原生主干视图（概念清分：main 不在沙箱数组，远程控制合成两者）
    this.persist = opts.persist || null; // 持久化路由：沙箱→instances.save()，main 变更→守卫 dsh-main.json
    this.frpmgr = new FrpManager({
      dir: opts.stateDir,
      logger: this.logger,
      events: this.events,
    });
    this.lanInstances = []; // 内存派生缓存：[{ id, name, dshPort, wanPort, token, dshToken, enabled, frpEnabled, frpRemotePort, localPort }]
    this._lanServers = {};   // id -> http.Server（relay）
    // 令牌只读来源（DshTokenService 注入）：本模块不再持久化令牌副本，只在构建代理/列表时读取，
    // 令牌变化由守卫经 applyToken 通知（relay 热换 cookie）。dshToken 字段仅为展示缓存。
    this.tokenOf = opts.tokenOf || (() => '');
    this._proxyChain = Promise.resolve(); // 代理同步串行队列：一次只同步一个实例（防并发竞态拿同端口）
  }

  localAddresses() {
    const out = [];
    try {
      const ifs = os.networkInterfaces();
      for (const name of Object.keys(ifs)) for (const i of ifs[name] || []) {
        if (i.family === 'IPv4' && !i.internal) out.push(i.address);
      }
    } catch {}
    return out;
  }

  /** 持久化（概念清分 2026-09-06）：优先注入的路由(persist)，否则回退沙箱实例 save。 */
  _saveAll() {
    if (typeof this.persist === 'function') { try { this.persist(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('lan persist: ' + (e && e.message)); } return; }
    if (this.instances && typeof this.instances.save === 'function') { try { this.instances.save(); } catch {} }
  }

  /** 受管 DSH 合成清单（概念清分 2026-09-06）：沙箱实例(instancemgr) + 原生主干 main(守卫核心视图)。 */
  _allManaged() {
    const sandboxes = (this.instances && this.instances.instances) || [];
    const main = (typeof this.mainOf === 'function') ? this.mainOf() : null;
    return main ? [...sandboxes, main] : sandboxes;
  }

  /** 合成查找：main 优先守卫视图，其余走沙箱数组。 */
  _findManaged(id) {
    return (this._allManaged() || []).find((x) => x.id === id) || null;
  }

  list() {
    this.reconcile(); // 对账：剔除孤儿/陈旧远程代理，保证与当前实例远程状态一致
    const addresses = this.localAddresses();
    const insts = this._allManaged();
    const remoteInsts = insts.filter((x) => x.remoteEnabled);
    // 幂等自愈：remoteEnabled=true 且实例在跑的实例 → 异步补建代理（未跑则不建，恢复后由 reconcile 自动接）
    for (const inst of remoteInsts) {
      if (!this.lanInstances.some((p) => p.dshPort === inst.port) && monitor.probeInstance(inst).running) {
        this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('syncProxy failed: ' + e.message));
      }
    }
    const items = remoteInsts.map((inst) => {
      // 找到该实例的代理注册（lanInstances 缓存 wanPort）
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      // 注入状态（可诊断层）：server.status() 由 relay 维护（tokenSet/cookieReady/最近成败）；
      // token/dshToken 仅内部字段——对外呈现一律经 supervisor.listLan 白名单（不泄令牌）。
      const srv = this._lanServers && this._lanServers[inst.id];
      const st = (srv && typeof srv.status === 'function') ? srv.status() : null;
      return {
        id: inst.id, name: inst.name, dshPort: inst.port,
        wanPort: proxy ? proxy.wanPort : null,
        token: inst.remoteToken || '',
        dshToken: this.tokenOf(inst.id) || (proxy ? (proxy.dshToken || '') : '') || '',
        enabled: !!proxy,
        localPort: proxy ? proxy.localPort : null,
        running: !!this._lanServers && !!this._lanServers[inst.id],
        inject: st ? { tokenSet: !!st.tokenSet, cookieReady: !!st.cookieReady, lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, lastErrorAt: st.lastErrorAt || null } : null,
      };
    });
    return { items, addresses };
  }

  /** 设置实例的公网暴露（frp）配置：写回 instance（instances.json 单一数据源）。 */
  setFrp(id, frpEnabled, frpRemotePort) {
    const inst = this._findManaged(id);
    if (!inst) return { ok: false, error: '实例不存在' };
    // 安全闸：公网暴露（frp）无令牌 = 互联网零认证触达 DSH 特权 API（relay 空 token 恒放行 + 回环呈现）。
    // 开启公网暴露前强制要求已设置访问令牌（remoteToken）。
    if (frpEnabled && !String(inst.remoteToken || '').trim()) {
      return { ok: false, error: '开启公网暴露前请先为该实例设置远程访问令牌（remoteToken），否则 DSH 特权接口将对公网完全开放' };
    }
    inst.frpEnabled = !!frpEnabled;
    if (frpEnabled) {
      const port = parseInt(frpRemotePort, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效的公网端口' };
      // 防止两个实例占用同一公网端口
      const clash = (this._allManaged()).find((x) => x.id !== id && x.frpRemotePort === port && x.frpEnabled);
      if (clash) return { ok: false, error: '公网端口 ' + port + ' 已被实例「' + clash.name + '」占用' };
      inst.frpRemotePort = port;
    } else {
      delete inst.frpRemotePort;
    }
    this._saveAll();
    if (this.events) this.events.append('lan_frp_changed', { id, enabled: !!frpEnabled, remotePort: inst.frpRemotePort || null });
    this.syncFrpc();
    return { ok: true, ...this.list() };
  }

  frpStatus() {
    const st = this.frpmgr ? this.frpmgr.status() : { installed: false, running: false };
    const insts = this._allManaged();
    st.instancesExposed = insts.filter((x) => x.frpEnabled && x.frpRemotePort && x.remoteEnabled)
      .map((x) => {
        const proxy = this.lanInstances.find((p) => p.dshPort === x.port);
        return { id: x.id, name: x.name, remotePort: x.frpRemotePort, wanPort: proxy ? proxy.wanPort : null };
      });
    return st;
  }

  /** frpc 操作门面（settings/install/toggle 统一入口，供 supervisor → api 调用，消除 presentation 直连 frpmgr）。
   *  @param action 'settings'|'install'|'toggle'
   *  @param body   请求体（settings 用）
   *  @returns Promise<{ok, ...}> 或 {ok:false,error} */
  async frpAction(action, body) {
    const j = body || {};
    if (action === 'settings') {
      const cur = this.frpmgr ? this.frpmgr.loadSettings() : {};
      const next = {
        enabled: j.enabled !== undefined ? !!j.enabled : cur.enabled,
        serverAddr: String(j.serverAddr !== undefined ? j.serverAddr : cur.serverAddr).trim(),
        serverPort: Number(j.serverPort) || cur.serverPort,
        authToken: String(j.authToken !== undefined ? j.authToken : cur.authToken),
        user: String(j.user || cur.user || 'dsh'),
      };
      if (this.frpmgr) this.frpmgr.saveSettings(next);
      this.syncFrpc();
      return { ok: true, ...this.frpStatus() };
    }
    if (action === 'install') {
      if (!this.frpmgr) return { ok: false, error: 'frpmgr 不可用' };
      return this.frpmgr.install((msg) => { try { this.logger.info('[frpc] ' + msg); } catch {} });
    }
    if (action === 'toggle') {
      if (!this.frpmgr) return { ok: false, error: 'frpmgr 不可用' };
      const st = this.frpmgr.status();
      if (st.running) { this.frpmgr.stop(); return { ok: true, ...this.frpStatus() }; }
      const r = this.frpmgr.start();
      return { ok: !!r.ok, error: r.error, needInstall: r.needInstall, ...this.frpStatus() };
    }
    return { ok: false, error: '未知 frp 操作: ' + action };
  }

  /** 实例变化后同步 frpc 配置与进程（尽力而为，不抛异常影响主流程）。 */
  syncFrpc() {
    if (!this.frpmgr) return;
    try {
      const r = this.frpmgr.syncFromInstances(this.lanInstances || []);
      if (r && r.needInstall) this.logger.info && this.logger.info('frpc not installed; WAN exposure pending install');
    } catch (e) {
      this.logger.warn && this.logger.warn('frpc sync failed: ' + e.message);
    }
  }

  /** 远程代理对账（架构语义）：
   *   - 注册（lanInstances / wanPort）只与「开关」绑定：remoteEnabled=true 保留、false 移除；
   *   - relay 运行 = 目标存活：实例重启/端口短暂 down → 暂停 relay（保留注册与 wanPort）；
   *     实例恢复 → 自动重新 listen（同一 wanPort，无端口重建竞争，绝不出现「开关开着但代理未就绪」）；
   *   - 孤儿注册（实例已删）→ 移除。 */
  reconcile() {
    try {
      const insts = this._allManaged();
      let removed = false;
      const kept = [];
      for (const proxy of this.lanInstances) {
        const inst = insts.find((i) => i.port === proxy.dshPort);
        // 注册移除：实例不存在 / 远程开关已关（开关=反代启停语义）
        if (!inst || !inst.remoteEnabled) {
          this.logger.warn && this.logger.warn('[reconcile] remove proxy ' + proxy.id + ' wanPort=' + proxy.wanPort + ' (inst=' + !!inst + ' remoteEnabled=' + (inst && inst.remoteEnabled) + ')');
          if (this._lanServers && this._lanServers[proxy.id]) this._stopLanServer(proxy.id);
          // 端口与实例绑死：开关关闭只移除 relay——保留 inst.wanPort 绑定（再开复用同一端口），
          // 但清 _allocated 占用标记（否则复用检查会拒绝复用导致重新分配跳号）。
          // 仅实例已删除（stale，无持久化对象）才真正释放。
          try { ports.unregister('relay:' + proxy.id); } catch {} // 按 owner 释放（端口随 relay 移除）
          if (this.events) this.events.append('lan_instance_removed', { id: proxy.id, reason: !inst ? 'stale' : 'disabled' });
          removed = true;
        } else {
          kept.push(proxy);
          // relay 运行 = 目标存活：up → 确保在监听（含实例恢复后自动重接）；down → 暂停（保留注册）
          const targetAlive = monitor.probeInstance(inst).running;
          if (targetAlive && !(this._lanServers && this._lanServers[proxy.id])) {
            if (!proxy.wanPort) {
              // wanPort 被清（监听失败迁移）：重新分配进入串行队列（防 null 空转）
              this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
            } else {
              this._startLanServer(proxy);
            }
          } else if (!targetAlive && this._lanServers && this._lanServers[proxy.id]) {
            this._stopLanServer(proxy.id);
          }
        }
      }
      if (removed) {
        this.lanInstances = kept;
        this.syncFrpc();
        if (this.logger && this.logger.info) this.logger.info('reconcile lan proxies: removed disabled/stale (' + kept.length + ' kept)');
      }
      // 确保 remoteEnabled=true 且实例在跑的实例都有代理注册（新开开关/新实例；串行防竞态）
      for (const inst of insts) {
        if (inst.remoteEnabled && !this.lanInstances.some((p) => p.dshPort === inst.port) && monitor.probeInstance(inst).running) {
          this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
        }
      }
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn('reconcile: ' + e.message);
    }
  }

  /** 删除某实例关联的局域网代理（实例被删除时调用）。 */
  async removeProxyForInstance(instId) {
    const proxy = this.lanInstances.find((p) => p.id === instId);
    if (proxy) {
      this._stopLanServer(proxy.id);
      this.lanInstances = this.lanInstances.filter((p) => p.id !== instId);
      try { ports.unregister('relay:' + instId); } catch {} // 实例删除：端口随对象释放
      if (this.events) this.events.append('lan_instance_removed', { id: instId });
      this.syncFrpc();
    }
  }

  /** 串行执行 syncProxy（队列）：防并发竞态——isTaken/allocate 是异步，并发调用会同时通过检查拿到同一 wanPort。 */
  _syncProxyQueued(inst) {
    const run = this._proxyChain = this._proxyChain.then(() => this.syncProxy(inst)).catch(() => {});
    return run;
  }

  /** 同步某实例的远程控制代理：remoteEnabled=true 且目标在监听时创建，false 删除。
   *  wanPort 持久化到实例记录（inst.wanPort）：守卫重启/实例重建后复用同一端口，绝不重复分配
   *  （防「重启后两个实例同端口 EADDRINUSE」）。 */
  async syncProxy(inst) {
    if (!inst) return;
    if (inst.remoteEnabled) {
      const owner = 'relay:' + inst.id;
      // 已登记且端口有效 → 确保 server 在跑，直接返回（幂等，不做任何重分配）
      const existing = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (existing && existing.wanPort) {
        const srv = this._lanServers && this._lanServers[inst.id];
        if (!srv) this._startLanServer(existing);
        return;
      }
      // 目标必须真的在监听（实例在跑），否则代理无意义且会白占端口
      if (!monitor.probeInstance(inst).running) return;
      // ── 确定性槽位仲裁（2026-09 架构定稿，docs/port-architecture.md）──
      //  一个入口负责：byOwner 复用 → 槽位被旧代占则 cmdline 回收+等待 → main 偏好 40000 → 段内最小空闲；
      //  外部长期占用 → 显式 conflict（不静默跳号，reconcile 下轮重试由事件暴露）。
      // inst.wanPort 是持久化绑定记忆（无论数值）：作为 bindingPreferred 复用；main 无记忆时 advisory 40000
      const hasPersistedBinding = !!(inst.wanPort && Number.isInteger(Number(inst.wanPort)) && inst.wanPort > 0);
      const slot = await ports.claimSlot('relay', owner, {
        preferred: hasPersistedBinding ? inst.wanPort : (inst.id === 'main' ? 40000 : undefined),
        bindingPreferred: hasPersistedBinding,
        onBindingLost: (e) => { if (this.events) { try { this.events.append('lan_binding_lost', e); } catch {} } if (this.logger && this.logger.warn) this.logger.warn('[syncProxy] ' + inst.id + ' 绑定被盗：' + e.from + ' → 迁移 ' + e.to); },
        reclaimCmdMark: 'lan-daemon.js',
        reclaimCfg: this.configPath || '',
        waitMs: 8000,
      });
      if (!slot || slot.conflict) {
        if (this.logger && this.logger.warn) this.logger.warn('[syncProxy] ' + inst.id + ' relay 槽位冲突（' + (slot && slot.port) + ' 被外部占用且无法回收），不静默跳号，等待下轮');
        return;
      }
      const wanPort = slot.port;
      // 换绑/迁移前：关闭该实例旧端口仍在跑的 server（防同进程新旧两族监听并存）
      const oldSrv = this._lanServers && this._lanServers[inst.id];
      if (oldSrv && oldSrv._wanPort && oldSrv._wanPort !== wanPort) {
        try { oldSrv.close(() => {}); } catch {}
        try { if (typeof oldSrv.closeAllConnections === 'function') oldSrv.closeAllConnections(); } catch {}
        delete this._lanServers[inst.id];
        if (this.logger && this.logger.info) this.logger.info('[syncProxy] ' + inst.id + ' 关闭旧端口 ' + oldSrv._wanPort + ' server（换绑 ' + wanPort + '）');
      }
      // 注册表单 owner 单记录：清重复残留（真源唯一）
      for (const rec of ports.list()) {
        if (rec.owner === owner && rec.port !== wanPort) { try { ports.release(rec.port); } catch {} }
      }
      if (!ports.isRegistered(wanPort)) ports.allocateMark(wanPort, 'relay', owner);
      // inst.wanPort 仅镜像（守护快照 save 为 noop 不回写；守卫本地模式有 save 则同步）
      if (inst.wanPort !== wanPort) { inst.wanPort = wanPort; this._saveAll(); }
      const proxyInst = { id: inst.id, name: inst.name, dshPort: inst.port, wanPort, token: inst.remoteToken || '', dshToken: this.tokenOf(inst.id) || '', enabled: true, frpEnabled: !!inst.frpEnabled, frpRemotePort: inst.frpRemotePort || null };
      if (existing) { Object.assign(existing, proxyInst); }
      else this.lanInstances.push(proxyInst);
      this._startLanServer(existing || proxyInst);
      if (this.events) this.events.append('lan_instance_added', { id: inst.id, name: inst.name, dshPort: inst.port, wanPort });
      this.syncFrpc();
    } else {
      // 关闭远程：移除 relay——保留 inst.wanPort 绑定（再开复用同一端口），
      // 清 _allocated 占用标记（复用检查通过）
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (proxy) {
        this._stopLanServer(proxy.id);
        this.lanInstances = this.lanInstances.filter((p) => p.id !== proxy.id);
        try { ports.unregister('relay:' + proxy.id); } catch {} // 按 owner 释放（保留 inst.wanPort 绑定，再开复用）
        if (this.events) this.events.append('lan_instance_removed', { id: proxy.id });
        this.syncFrpc();
      }
    }
  }

  /** 实例启动时联动远程代理：remoteEnabled 且实例在跑→确保对应 relay 在监听。 */
  async instanceStart(inst) {
    if (!inst || !inst.remoteEnabled || !inst.port) return;
    const existing = this.lanInstances.find((p) => p.dshPort === inst.port);
    if (existing) {
      this._startLanServer(existing);
    } else {
      await this._syncProxyQueued(inst);
    }
  }

  /** 实例停止时联动远程代理：停止对应 relay（保留 lanInstances 注册，便于再次启动）。 */
  instanceStop(inst) {
    if (!inst || !inst.port) return;
    const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
    if (proxy) this._stopLanServer(proxy.id);
  }

  _startLanServer(inst) {
    this._lanServers = this._lanServers || {};
    if (this._lanServers[inst.id]) return;
    if (!inst.wanPort) return; // wanPort 被清（监听失败待迁移）：等待 syncProxy 重新分配
    // 防同端口双监听：若该 wanPort 已有 server（其他实例）则跳过（端口冲突保护）
    for (const id of Object.keys(this._lanServers)) {
      if (this._lanServers[id] && this._lanServers[id]._wanPort === inst.wanPort) {
        this.logger.warn && this.logger.warn('wanPort ' + inst.wanPort + ' 已被 ' + id + ' 占用，跳过 ' + inst.id);
        return;
      }
    }
    const { createRelay } = require('./index');
    const server = createRelay('127.0.0.1', inst.dshPort, {
      id: inst.id,
      token: inst.token || '',
      dshToken: inst.dshToken || '',
      logger: this.logger,
      events: this.events,
    });
    server.on('error', (err) => {
      this.logger.warn && this.logger.warn('lan relay error (' + inst.id + '): ' + err.message);
      delete this._lanServers[inst.id];
      // EADDRINUSE（端口被停留连接/外部进程占用）：释放绑定并节流迁移一次，
      // 避免 reconcile 每 tick 对同端口无限重试刷日志（原实现无退避/迁移）
      if (err.code === 'EADDRINUSE') this._handleRelayListenFail(inst);
    });
    server._wanPort = inst.wanPort;
    server.listen(inst.wanPort, '0.0.0.0', () => {
      this._lanServers[inst.id] = server;
      inst.localPort = inst.wanPort;
      if (this.events) this.events.append('lan_instance_started', { id: inst.id, wanPort: inst.wanPort, dshPort: inst.dshPort });
      this.logger.info && this.logger.info('lan ' + inst.name + ' on 0.0.0.0:' + inst.wanPort + ' -> 127.0.0.1:' + inst.dshPort);
    });
    this._lanServers[inst.id] = server;
  }

  /** 监听失败（EADDRINUSE）处理：释放端口绑定并节流（60s/实例），下轮 reconcile 经 syncProxy 重新分配迁移。 */
  _handleRelayListenFail(inst) {
    const now = Date.now();
    this._relayFailThrottle = this._relayFailThrottle || {};
    const last = this._relayFailThrottle[inst.id] || 0;
    if (now - last < 60000) return; // 60s 节流：不每 tick 迁移
    this._relayFailThrottle[inst.id] = now;
    try { ports.unregister('relay:' + inst.id); } catch {}
    // 清缓存条目与实例的 wanPort 绑定 → syncProxy 见 existing.wanPort 为空会重新分配新端口
    const proxy = this.lanInstances.find((p) => p.id === inst.id);
    if (proxy) proxy.wanPort = null;
    inst.wanPort = null;
    this._saveAll();
    if (this.logger && this.logger.warn) this.logger.warn('[relay] ' + inst.id + ' 端口监听失败，已释放绑定，将迁移新端口');
    if (this.events) this.events.append('lan_relay_listen_failed', { id: inst.id });
  }

  _stopLanServer(id) {
    const server = this._lanServers && this._lanServers[id];
    if (server) {
      try { server.close(() => {}); } catch {}
      // 关闭监听后主动断开既有连接：否则长 WS 隧道会让端口滞留 → 重建 EADDRINUSE
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch {}
      delete this._lanServers[id];
      if (this.events) this.events.append('lan_instance_stopped', { id });
    }
  }

  /** 守卫优雅退出时调用：停止全部 relay 与 frpc（防守卫重启后孤儿/双实例）。 */
  shutdown() {
    try {
      for (const id of Object.keys(this._lanServers || {})) this._stopLanServer(id);
    } catch (e) { this.logger.warn && this.logger.warn('lan shutdown relays: ' + e.message); }
    try {
      if (this.frpmgr) { const r = this.frpmgr.stop(); if (r && r.already) this.frpmgr._cleanupOrphans && this.frpmgr._cleanupOrphans(); }
    } catch (e) { this.logger.warn && this.logger.warn('lan shutdown frpc: ' + e.message); }
  }

  /** 令牌变化由统一令牌服务（DshTokenService）经 onChange 下发到本消费方（守卫接线）：
   *  热更新既有 relay 的 DSH 会话 cookie（实例重启轮换后无需重建代理），并刷新展示缓存。
   *  本模块不持久化令牌——读取一律走注入的 tokenOf（唯一权威）。 */
  applyToken(instId, dshToken) {
    if (!instId) return false;
    const proxy = this.lanInstances.find((p) => p.id === instId);
    if (proxy) proxy.dshToken = dshToken || '';
    const server = proxy && this._lanServers && this._lanServers[proxy.id];
    if (server && typeof server.setDshToken === 'function') {
      server.setDshToken(dshToken || '');
      if (this.events) this.events.append('lan_dsh_token_updated', { id: instId });
    }
    return !!server;
  }
}

module.exports = { LanManager };
