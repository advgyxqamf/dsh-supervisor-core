'use strict';

// app/main/process.js —— 主进程生命周期（spawn/接管/重启/停止）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');
const { LineBuffer } = require('../../platform/service/log/log');
const native = require('../../app/native/command');
// 端口运行时再推导已拆到 main/port-rederive.js（独立切面）。
const { findManagedDshPort, applyMainPort } = require('./port-rederive');

module.exports = {
  methods: {
  spawnCommand() {
    return native.nativeCommand(this.config, this.pluginManager);
  },

  async _startProcess() {
    this.main.actNote('start', 'spawn');
    this._crashHalted = false; // 主动拉起 = 清除崩溃停靠（进入运行流程）
    // 前置条件：原生 DSH 必须已安装才尝试启动。未安装则进入「未安装」状态：
    // 不启动、不重试、不计数崩溃；一次性通知引导安装（与"启动失败"严格区分）。
    const nst = this.nativeManager ? this.nativeManager.status() : { installed: true };
    if (!nst.installed) {
      this.events.append('dsh_not_installed', { bin: nst.binPath });
      if (!this._mMissingNotified()) {
        this._mSetMissingNotified(true);
        this.ui.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
      }
      this._mSetSpawnBlockedUntil(Date.now() + 60000); // 冷静期：装好前不再无谓重试
      this.state.setPhase('STOPPED');
      this._mSetFailStreak(0);
      this.state.write();
      return;
    }
    this.events.append('spawn', { command: this.spawnCommand() });
    const [cmd, ...args] = this.spawnCommand();
    let child;
    try {
      // detached：独立进程组，便于按组发信号（DSH 派生的子进程一并收到）。
      // 插件 --patch 覆盖层由 spawnCommand()/native.nativeCommand() 统一附加（顶层位置），此处不再拼接。
      // stdio 必须保持 ['ignore','pipe','pipe']（下方要读 stdout 里的令牌），故用 piped 而非 detached；
      // 进程组语义经 opts.detached:true 保持。
      child = spawnOS.piped(cmd, args, { env: process.env, detached: true });
    } catch (err) {
      this.events.append('spawn_failed', { message: err.message });
      this.logger.error('spawn failed: ' + err.message);
      this._beginRestart('spawn_error', { countCrash: true });
      return;
    }
    this.logger.info('spawn pid=' + child.pid + ' cmd=' + this.spawnCommand().join(' '));
    this._mSetChild(child);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this.state.setPhase('STARTING');
    this._mSetStartDeadline(Date.now() + this.config.startTimeoutMs);
    // DSH 输出落盘专用日志（行缓冲还原完整行），同时镜像 stderr 供 journald 收敛
    // 先捕获令牌（原文），落盘前对启动 URL 的 ?token= 段脱敏——dsh.log/journald 不复留会话令牌明文
    const sanitizeToken = (l) => String(l).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    const outBuf = new LineBuffer((line) => {
      this.tokenService.feedLine('main', line); // 唯一令牌节点：stdout 源逐行推送（最新行优先）

      const clean = sanitizeToken(line);
      this.dshWriter.write(clean);
      // 实时镜像同样走脱敏后的完整行，dsh-supervisor 单元 journald 不再残留 token 明文。
      process.stdout.write('[dsh] ' + clean + '\n');
    });
    const errBuf = new LineBuffer((line) => {
      const clean = sanitizeToken('[stderr] ' + line);
      this.dshWriter.write(clean);
      process.stderr.write(clean + '\n');
    });
    child.stdout.on('data', (d) => { outBuf.push(d); });
    child.stderr.on('data', (d) => { errBuf.push(d); });
    child.on('error', (err) => {
      this.events.append('spawn_error', { message: err.message });
      if (this._mChild() === child && this.state.phase() === 'STARTING') {
        this._mSetChild(null);
        if (err.code === 'ENOENT') {
          // 命令不存在（如 DSH 未安装）：进入冷静期，等面板一键安装，不刷崩溃
          this.events.append('dsh_command_missing', { command: this.config.command[0] });
          this.logger.warn('command missing: ' + this.config.command.join(' ') + ' — 60s 冷静期内不再尝试');
          if (!this._mMissingNotified()) {
            this._mSetMissingNotified(true);
            this.ui.notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
          }
          this._mSetSpawnBlockedUntil(Date.now() + 60000);
          this.state.setPhase('STOPPED');
          this.state.write();
          return;
        }
        this._beginRestart('spawn_error:' + (err.code || 'unknown'), { countCrash: true });
      }
    });
    child.on('exit', (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      if (this._mChild() !== child) return; // 已被 stopProcess 接管
      this.events.append('dsh_exited', { code, signal, phase: this.state.phase() });
      this._mSetChild(null);
      if (this._stopping) return;
      if (this.state.desired() !== 'running') return;
      if (this.state.phase() === 'RUNNING' || this.state.phase() === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        // 守护语义（与 RUNNING 收敛分支同 gate）：RUNNING 崩溃看守护开关——
        // guardian=false 不自动拉起（转 STOPPED 等用户手动）；STARTING(用户启动流程)保留重试。
        if (this.state.phase() === 'STARTING' || this.state.guardian()) {
          this._beginRestart('exit:' + why, { countCrash: true });
        } else {
          this._crashHalted = true; // 未守护崩溃：停靠等待显式启动（阶段 2 意图单源）
          this.events.append('guardian_off_exit', { reason: 'child_exit:' + why + ' 未守护，保持停止' });
          this.state.setPhase('STOPPED');
        }
      }
    });
    this.events.append('spawned', { pid: child.pid });
    this.state.write();
  },

  _enterRunning() {
    this.main.actNote('enterRunning', 'healthy');
    const wasRunning = this.state.phase() === 'RUNNING';
    this.state.setPhase('RUNNING');
    this._mSetAdopted(false);
    // 只在真正「进入/恢复到运行中」时重置崩溃窗口/退避并记一次事件；稳态(RUNNING)不再每探测周期重置/刷屏
    if (!wasRunning) {
      this._mSetFailStreak(0);
      this._mSetBackoffLevel(0);
      this._mSetBackoffUntil(null);
      this._mSetCrashWindowStart(null);
      this._mSetCrashWindowRestarts(0);
      const pid = this._mChild() ? this._mChild().pid : null;
      this.events.append('running', { pid });
      this.logger.info('RUNNING pid=' + pid);
      // 进入运行：统一令牌服务按源（spawn=stdout）退避重试捕获最新令牌，
      // 有变化即经 onChange 下发 relay 热换 cookie（覆盖重启后令牌轮换/旧令牌未清空的边界）。
      this.tokenService.scheduleCapture('main');
    }
    this.state.write();
  },

  /** 期望停止下发现无主健康实例：仅观测（拿 pid、如实展示），不强杀不拉起。 */
  _adoptObserved() {
    this.main.actNote('adoptObserved', 'observe');
    this.state.setPhase('OBSERVED');
    this._mSetAdopted(true);
    this._mSetObservedOnly(true);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    if (this._mAdoptPid() === null) {
      const found = findManagedDshPort(this.config);
      if (found && found.port && found.port !== this.config.targetPort && applyMainPort(this, found.port, found.pid)) {
        this.config.targetPort = found.port;
        this._mSetAdoptPid(found.pid);
      }
    }
    this.events.append('adopted_observed', { pid: this._mAdoptPid() });
    this.logger.info('observed unmanaged instance pid=' + this._mAdoptPid() + ' (desired=stopped)');
    this.state.write();
  },

  _adopt() {
    this.main.actNote('adopt', 'adopt');
    this.state.setPhase('RUNNING');
    this._mSetAdopted(true);
    this._mSetObservedOnly(false);
    this._mSetChild(null);
    this._mSetFailStreak(0);
    this._mSetBackoffLevel(0);
    this._mSetBackoffUntil(null);
    // 发现接管目标的 pid：使 stop/升级/存活观测对既有实例同样生效
    this._mSetAdoptPid(pidlook.findListeningPid(this.config.targetPort));
    // 原生 DSH 端口可被用户改动（config 默认只是默认），配置端口无监听时从受管 DSH 进程
    // 推导真实端口并更正注册，再以其 pid 接管。
    if (this._mAdoptPid() === null) {
      const found = findManagedDshPort(this.config);
      if (found && found.port && found.port !== this.config.targetPort) {
        if (applyMainPort(this, found.port, found.pid)) {
          this.config.targetPort = found.port;
          this._mSetAdoptPid(found.pid);
        }
      }
    }
    // 校验：接管目标必须是我们管理的进程（启动命令匹配），否则不接管、只告警
    if (this._mAdoptPid() === null || !this.main.isManagedProcess(this._mAdoptPid())) {
      this._mSetAdoptPid(null);
      this.state.setPhase('STOPPED');
      this.daemons.warnOccupied();
      this.state.write();
      return;
    }
    this.events.append('adopted', { pid: this._mAdoptPid() });
    this.logger.info('adopted existing instance pid=' + this._mAdoptPid());
    // 接管既有实例：统一令牌服务从已登记源（journald / stdout 行缓冲）取最新令牌并下发
    this.tokenService.scheduleCapture('main');
    this.state.write();
  },

  _beginRestart(reason, opts) {
    const countCrash = !!(opts && opts.countCrash);
    this._mSetLastFailure(reason);
    this._mSetLastRestartAt(new Date().toISOString());
    this.events.append('restart_triggered', { reason });
    this.logger.warn('restart triggered: ' + reason);
    // 实例重启 = DSH 启动令牌轮换：清空已捕获令牌，进入运行后统一令牌服务重新捕获新令牌。
    // 旧令牌随旧进程失效，relay 若继续持有只会换取失败；先清空避免新旧令牌混淆。
    this.tokenService.clear('main');
    if (countCrash) {
      this._mSetRestartCount(this._mRestartCount() + 1);
      this.main.bumpCrashWindow();
    }
    this.state.setPhase('RESTARTING');
    this._mSetFailStreak(0);
    this._mSetRestartAt(Date.now() + this.config.portReleaseWaitMs);
    const child = this._mChild();
    if (child && child.exitCode === null) this.main.killSequence(child);
    // 重启前停掉仍运行中的目标，保证 RESTARTING 到重拉路径畅通：
    //  spawn 托管下被接管的存活实例（如假死触发 http_unhealthy 时进程还活着）杀其 pid；
    //  adopted_exit 场景 adopted 已死，此处 isAlive 为 false 自然跳过，不误杀。
    if (this._mAdoptPid() && pidlook.isAlive(this._mAdoptPid())) {
      try { this.main.killAdopted(this._mAdoptPid()); } catch (e) { this.logger.warn('adopt kill during restart: ' + e.message); }
    }
    this.main.actNote('restart', reason); // 退避记账不改变 restart 动作
    this.state.write();
  },

  stopProcess(reason) {
    this.main.actNote('stop', reason);
    this.events.append('stop', { reason });
    this.logger.info('stop: ' + reason);
    const child = this._mChild();
    const adoptedPid = this._mAdoptPid();
    // 相位裁定（D12）：即便 kill 未能确认成功，仍置 STOPPED —— controller 的
    //   portUp → adoptObserved 语义依赖 STOPPED；失败经 stop_failed 事件如实上报，
    //   而不是把相位停在一个既非运行也非停止的中间态。
    this.state.setPhase('STOPPED');
    this._mSetChild(null);
    this._mSetAdopted(false);
    this._mSetAdoptPid(null);
    this._mSetFailStreak(0);
    // kill 派遣可能同步抛错（平台 signalProcess/killTree 实现抛）：原实现会让异常逃出
    //   本方法、跳过 state.write()，且没有任何失败事件 —— 停止半执行而静默（D12）。
    try {
      if (child && child.exitCode === null) this.main.killSequence(child);
      else if (adoptedPid) this.main.killAdopted(adoptedPid);
    } catch (e) {
      this.events.append('stop_failed', {
        reason,
        pid: adoptedPid || (child && child.pid) || null,
        error: (e && e.message) || String(e),
      });
      if (this.logger && this.logger.warn) this.logger.warn('[main] stop 派遣失败: ' + ((e && e.message) || e));
    }
    this.state.write();
  }
  },
};
