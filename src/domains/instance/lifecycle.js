'use strict';
// 多实例管理器 —— 单元生命周期（域：instance / lifecycle）
// 「怎么把单元跑起来」：模板让位 + 清理残留 transient 单元 + 启停 + 探测 + 监督拍。
// 协作方经 deps 显式注入；「首次安装」经 deps.install 注入（不 require upgrade，否则成环）。
// 全部经平台 Provider（deps.service），绝不直接调 systemctl。
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../../platform/service/monitor');
const guardian = require('../../shared/guardian');
const sandbox = require('./sandbox');
const stateMachine = require('./state-machine');
function createLifecycle(deps) {
  const { store, service, logger, events, tokens, tasks, systemdDir, systemdTemplatePath, hooks, instancesRoot } = deps;
  const isSandboxSupported = deps.isSandboxSupported;
  // 状态转移的显式副作用集合（落盘/发事件/令牌）——取用点现读 deps，避免快照漂移。
  const stateDeps = () => ({ events, logger, save: () => store.save(), tokens });
  /** 准备 systemd 用户目录并让位历史遗留模板（**改名保留，绝不删除**，不按内容判归属）。
   *  模板会阻挡 systemd-run transient 单元；改名阻断效果相同但绝不丢数据。 */
  function _prepareSystemd() {
    try {
      fs.mkdirSync(systemdDir, { recursive: true });
      if (fs.existsSync(systemdTemplatePath)) {
        // 让位目标名带 epoch 时间戳（唯一 → 无需先删；旧实现固定名 + 先 rmSync 会静默删用户文件）。
        const stamp = Date.now();
        let aside = systemdTemplatePath + '.disabled-by-dsh-' + stamp;
        let n = 1;
        while (fs.existsSync(aside)) { aside = systemdTemplatePath + '.disabled-by-dsh-' + stamp + '-' + (n++); }
        fs.renameSync(systemdTemplatePath, aside);
        logger.info && logger.info('已将阻挡 systemd-run 的模板让位（改名保留，未删除）：' + aside);
        if (events) events.append('systemd_template_moved_aside', { from: systemdTemplatePath, to: aside });
      }
      const reloaded = service.daemonReload();
      if (reloaded === false) logger.warn && logger.warn('systemd daemon-reload 失败（不阻断实例创建）');
      return true;
    } catch (e) {
      logger.error && logger.error('_prepareSystemd: ' + e.message);
      return false;
    }
  }
  /** 清理残留同名 transient 单元（文件残留会让 systemd-run 报 already loaded）。 */
  function _cleanStaleUnit(unit) {
    service.cleanTransient(unit);
    logger.info && logger.info('cleaned stale transient unit: ' + unit);
  }
  /** 用 systemd 启动实例。**绝不抛**（否则打挂 tick 循环）；失败返回 {ok,error} 交调用方退避。 */
  function _systemdStart(inst) {
    try {
      const cmdArr = sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst);
      if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
      if (probe(inst).running) return { ok: false, error: '端口 ' + inst.port + ' 已被占用' }; // 端口被占：不启动
      const props = sandbox.unitProps(inst);
      const { env, workingDir } = sandbox.sandboxEnv(instancesRoot, inst);
      _cleanStaleUnit('dsh-web@' + inst.id);
      try {
        service.startTransient({ unit: 'dsh-web@' + inst.id, cmd: cmdArr, env, props, workingDir });
      } catch (e) {
        const msg = 'systemd 启动失败: ' + (e.message || e);
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_failed', { id: inst.id, name: inst.name, error: msg });
        return { ok: false, error: msg };
      }
      inst.state.phase = 'STARTING';
      inst.state.startAt = Date.now();
      inst.state.lastError = null;
      store.save();
      if (inst.port && hooks.onInstanceStart) hooks.onInstanceStart(inst);
      if (events) events.append('inst_started', { id: inst.id, port: inst.port });
      logger.info && logger.info('started instance ' + inst.name + ' (dsh-web@' + inst.id + ')');
      return { ok: true };
    } catch (e) {
      logger.error && logger.error('_systemdStart error ' + inst.id + ': ' + e.message);
      return { ok: false, error: e.message };
    }
  }
  /** 拉起实例（独立 unit）。async：沙箱首次启动需异步安装 DSH。 */
  async function start(id, opts) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（需 Linux + systemd-run；能力矩阵见 GET /env/status 的 capabilities.multiInstance）' };
    _prepareSystemd(); // 手动启动不受「守护(自动拉起)」开关限制
    // 升级直通（升级恒失败根因）：升级作业自身的重启验证必须真正拉起单元，不被自己的作业挡住。
    if (inst.domain === 'sandbox') {
      const fromUpgrade = !!(opts && opts.fromUpgrade);
      if (!fromUpgrade && tasks && tasks.isBusy('instance', id)) return { ok: true, installing: true, already: true };
      store.ensureDirs(inst);
      const dshEntry = path.join(sandbox.installDir(instancesRoot, inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(dshEntry)) {
        const r = await deps.install(inst);
        if (!r.ok) return { ok: false, error: '沙箱实例安装 DSH 失败: ' + (r.error || 'unknown') };
        return { ok: true, installing: true };
      }
    }
    return _systemdStart(inst);
  }
  function stop(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（需 Linux + systemd-run；能力矩阵见 GET /env/status 的 capabilities.multiInstance）' };
    service.stopUnit('dsh-web@' + inst.id, { timeoutMs: 20000 }); // RC4：有界，防 dbus 挂起冻结守卫
    inst.state.phase = 'STOPPED';
    store.save();
    if (inst.port && hooks.onInstanceStop) hooks.onInstanceStop(inst);
    if (events) events.append('inst_stopped', { id: inst.id });
    return { ok: true };
  }
  /** 在线探测（端口+pid+cmdline）：统一交 platform/service/monitor（原生与沙箱共用）。 */
  function probe(inst) { return monitor.probeInstance(inst); }
  function probeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { pid: null, running: false, isDsh: false, phase: 'STOPPED' };
    return probe(inst);
  }
  /** 单实例监督拍（单实例 try/catch —— 单实例异常绝不拖垮心跳循环）。
   *  STOPPED → INSTALLING → STARTING → RUNNING → BACKOFF(自愈退避) → FAILED(暴露原因,用户可重试)。 */
  function supervise(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    const now = Date.now();
    try {
      const st = probe(inst);
      inst.state.lastProbeOk = st.running;
      // 令牌回填与 phase 解耦：长驻/孤立实例在守卫重启后令牌不回填 → relay 无 cookie 401。
      if (inst.domain === 'sandbox' && tokens) { try { tokens.ensureCaptured(inst.id); } catch {} }
      const state = inst.state;
      const guarded = guardian.shouldGuard(inst); // 只影响「挂了是否自动拉起」，不影响手动启动
      switch (state.phase) {
        case 'INSTALLING': { // 装完 → 拉起；装失败/超时 → FAILED；已监听 → 运行
          if (st.running) { stateMachine.setRunning(stateDeps(), inst, st, now); break; }
          if (state.installOk === true) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
            break;
          }
          if (state.installOk === false) { stateMachine.fail(stateDeps(), inst, state.installError || '安装失败'); break; }
          if (tasks) {
            // 作业在跑 → 等待；无作业且无结果 → 中断恢复（守卫重启/任务中断遗留态）
            if (!tasks.current('instance', inst.id)) {
              let why = '安装中断（无进行中安装任务）';
              try {
                const recent = tasks.list('instance').find((t) => t.target && t.target.id === inst.id && t.action === 'install');
                if (recent && (recent.state === 'failed' || recent.state === 'canceled')) why = recent.error || why;
              } catch {}
              stateMachine.fail(stateDeps(), inst, why);
            }
          } else if (state.installAt && now - state.installAt > 10 * 60 * 1000) {
            stateMachine.fail(stateDeps(), inst, '安装超时(10分钟)'); // 无任务注册表环境的看护兜底
          }
          break;
        }
        case 'STARTING': { // 端口起来 → 运行；超时(30s) → 退避重试
          if (st.running) stateMachine.setRunning(stateDeps(), inst, st, now);
          else if (state.startAt && now - state.startAt > 30000) stateMachine.restart(stateDeps(), inst, '启动超时: DSH 未监听端口');
          break;
        }
        case 'RUNNING': { // 挂了 → 守护开则退避自愈，否则回到「停止」
          if (!st.running) {
            if (guarded) stateMachine.restart(stateDeps(), inst, '实例进程退出');
            else stateMachine.setStopped(stateDeps(), inst);
          } else if (inst.domain === 'sandbox' && tokens) {
            tokens.ensureCaptured(inst.id); // 内存令牌空置时周期回填（服务内部 30s 节流）
          }
          break;
        }
        case 'BACKOFF': { // 到期 → 重试启动；失败继续退避（自愈）
          if (state.backoffUntil && now >= state.backoffUntil) {
            start(inst.id).then((r) => {
              if (!r || (!r.ok && !r.installing)) stateMachine.restart(stateDeps(), inst, '重试失败:' + ((r && r.error) || ''));
            }).catch((e) => stateMachine.restart(stateDeps(), inst, '重试异常:' + (e && e.message)));
          }
          break;
        }
        default: break; // STOPPED / FAILED：保持，由用户手动 startInstance 重置
      }
      store.save();
    } catch (e) {
      logger.error && logger.error('supervise ' + inst.id + ' error: ' + e.message);
    }
    return { ok: true };
  }
  return { _prepareSystemd, _cleanStaleUnit, _systemdStart, start, stop, probe, probeInstance, supervise };
}
module.exports = { createLifecycle };
