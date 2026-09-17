'use strict';
// 单元生命周期：模板让位 + 清理残留 transient 单元 + 启停 + 探测 + 监督拍。
// 协作方经 deps 显式注入；首次安装经 deps.install 注入（不 require upgrade，否则成环）；
// 全部经平台 Provider（deps.service），绝不直接调 systemctl。
const fs = require('node:fs');
const path = require('node:path');
const monitor = require('../../platform/service/monitor');
const guardian = require('../../shared/guardian');
const sandbox = require('./sandbox');
const stateMachine = require('./state-machine');
// 执行边界复校的单一事实源（与 api 形态闸共用同一纯函数；见 exec-path.commandEntryViolation）。
const execPath = require('../../platform/os/exec-path');
function createLifecycle(deps) {
  const { store, service, logger, events, tokens, tasks, systemdDir, systemdTemplatePath, hooks, instancesRoot } = deps;
  const isSandboxSupported = deps.isSandboxSupported;
  // 状态转移的显式副作用集合（落盘/发事件/令牌）——取用点现读 deps，避免快照漂移。
  const stateDeps = () => ({ events, logger, save: () => store.save(), tokens });
  /** 准备 systemd 用户目录并让位历史遗留模板（改名保留，绝不删除，不按内容判归属）。
   *  模板会阻挡 systemd-run transient 单元；改名阻断效果相同但绝不丢数据。 */
  function _prepareSystemd() {
    try {
      fs.mkdirSync(systemdDir, { recursive: true });
      if (fs.existsSync(systemdTemplatePath)) {
        // 让位目标名带 epoch 时间戳（唯一，无需先删；固定名加先 rmSync 会静默删用户文件）。
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
    const r = service.cleanTransient(unit);
    // 清理失败不再无条件记「cleaned」：原实现四步静默，日志对失败撒谎（N5）。
    if (r && r.ok === false) {
      logger.warn && logger.warn('clean stale transient unit 未完全生效: ' + unit +
        (r.errors && r.errors.length ? ' errors=' + r.errors.join(';') : ''));
    } else {
      logger.info && logger.info('cleaned stale transient unit: ' + unit);
    }
  }
  /** 用 systemd 启动实例。**绝不抛**（否则打挂 tick 循环）；失败返回 {ok,error} 交调用方退避。 */
  function _systemdStart(inst) {
    try {
      const cmdArr = sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst);
      if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
      // 执行边界复校（EXECUTION-CONTRACT §8.4）：effectiveCommand 对**用户显式 command** 原样返回，
      //   故在执行前用 realpath 归属复校收口「basename 改名绕过」与「伪包内路径」残留。
      //   允许位置 = 该实例安装根之下，或内核自己解析出的已知 DSH 入口（exec-path 单一事实源）；
      //   ENOENT/不可解析一律 fail-closed（否则「先提交、后由外部创建」可绕过）。
      //   ⚠ **适用范围仅 sandbox**：§8 的 command 覆盖契约是沙箱实例的（值来自 POST /instances/add 的
      //   请求体 = 真正的攻击面，api 侧另有 requireAbsoluteEntry 形态闸）；native/main 的命令来自
      //   **操作者配置文件 cfg.command**（如 ['node', <mock 绝对路径>, port]），不是 API 供给 ——
      //   对配置文件做"执行边界复校"既不必要、也会误拒合法入口（P3-C 设计 §10.3 记「非 sandbox 域
      //   须单独定义」，此处即该定义：排除）。裸名（[node, 裸 dshBin]）另由判据本身放行。
      const boundary = inst.domain === 'sandbox'
        ? execPath.commandEntryViolation(cmdArr, {
            roots: [sandbox.installDir(instancesRoot, inst)],
            files: execPath.knownDshEntries({ dshBin: deps.dshBin }),
          })
        : null;
      if (boundary) {
        const msg = '启动命令未通过执行边界复校：' + boundary;
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_refused', { id: inst.id, name: inst.name, error: msg });
        logger.warn && logger.warn('[' + inst.id + '] ' + msg);
        return { ok: false, error: msg };
      }
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
    const unit = 'dsh-web@' + inst.id;
    let stopped;
    try { stopped = service.stopUnit(unit, { timeoutMs: 20000 }); } // RC4：有界，防 dbus 挂起冻结守卫
    catch (e) { stopped = false; logger.warn && logger.warn('[' + inst.id + '] 停止单元 ' + unit + ' 异常: ' + (e && e.message)); }
    if (stopped === false) {
      // 停止未确认：如实报错并保持原相位，绝不谎报已停止（否则 supervise 不再自愈、用户误以为已停）。
      const msg = '停止实例失败（单元 ' + unit + ' 未确认停止）';
      inst.state.lastError = msg;
      store.save();
      if (events) events.append('inst_stop_failed', { id: inst.id, name: inst.name, error: msg });
      logger.warn && logger.warn('[' + inst.id + '] ' + msg);
      return { ok: false, error: msg };
    }
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
  /** 单实例监督拍（try/catch：单实例异常绝不拖垮心跳循环）。
   *  相位：STOPPED -> INSTALLING -> STARTING -> RUNNING -> BACKOFF(自愈退避) -> FAILED(用户可重试)。 */
  function supervise(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    const now = Date.now();
    try {
      const st = probe(inst);
      inst.state.lastProbeOk = st.running;
      // 令牌回填与 phase 解耦：长驻/孤立实例在守卫重启后不回填令牌，relay 会无 cookie 401。
      if (inst.domain === 'sandbox' && tokens) { try { tokens.ensureCaptured(inst.id); } catch {} }
      const state = inst.state;
      const guarded = guardian.shouldGuard(inst); // 只影响「挂了是否自动拉起」，不影响手动启动
      switch (state.phase) {
        case 'INSTALLING': { // 装完则拉起；装失败/超时则 FAILED；已监听则运行
          if (st.running) { stateMachine.setRunning(stateDeps(), inst, st, now); break; }
          if (state.installOk === true) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
            break;
          }
          if (state.installOk === false) { stateMachine.fail(stateDeps(), inst, state.installError || '安装失败'); break; }
          if (tasks) {
            // 作业在跑则等待。无作业行有两种可能：任务登记本身失败（安装其实仍在进行，dsh-install
            // 的 begin/step 抛错后 task=null），或守卫重启/任务中断的遗留态；前者若立即判死，会把
            // 进行中的安装永久卡 FAILED。故仅在确证作业失败/取消，或已安装超时（10 分钟）时才判死。
            if (!tasks.current('instance', inst.id)) {
              let why = null;
              try {
                const recent = tasks.list('instance').find((t) => t.target && t.target.id === inst.id && t.action === 'install');
                if (recent && (recent.state === 'failed' || recent.state === 'canceled')) why = recent.error || '安装失败';
              } catch {}
              if (!why && state.installAt && now - state.installAt > 10 * 60 * 1000) why = '安装超时(10分钟)';
              if (why) stateMachine.fail(stateDeps(), inst, why);
            }
          } else if (state.installAt && now - state.installAt > 10 * 60 * 1000) {
            stateMachine.fail(stateDeps(), inst, '安装超时(10分钟)'); // 无任务注册表环境的看护兜底
          }
          break;
        }
        case 'STARTING': { // 端口起来则运行；超时(30s)则退避重试
          if (st.running) stateMachine.setRunning(stateDeps(), inst, st, now);
          else if (state.startAt && now - state.startAt > 30000) stateMachine.restart(stateDeps(), inst, '启动超时: DSH 未监听端口');
          break;
        }
        case 'RUNNING': { // 挂了：守护开则退避自愈，否则回到停止
          if (!st.running) {
            if (guarded) stateMachine.restart(stateDeps(), inst, '实例进程退出');
            else stateMachine.setStopped(stateDeps(), inst);
          } else if (inst.domain === 'sandbox' && tokens) {
            tokens.ensureCaptured(inst.id); // 内存令牌空置时周期回填（服务内部 30s 节流）
          }
          break;
        }
        case 'BACKOFF': { // 到期则重试启动；失败继续退避（自愈）
          if (state.backoffUntil && now >= state.backoffUntil) {
            start(inst.id).then((r) => {
              if (!r || (!r.ok && !r.installing)) stateMachine.restart(stateDeps(), inst, '重试失败:' + ((r && r.error) || ''));
            }).catch((e) => stateMachine.restart(stateDeps(), inst, '重试异常:' + (e && e.message)));
          }
          break;
        }
        case 'FAILED': {
          // 安装任务登记失败等会把进行中的安装误判 FAILED；若 npm 实际已成功（installOk===true），
          // 必须自愈拉起，否则永久卡死。重试超限后不再自动拉起，交用户处理。
          if (state.installOk === true && !st.running && !/重试超限/.test(state.lastError || '')) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
          }
          break;
        }
        default: break; // STOPPED：保持，由用户手动 startInstance 重置
      }
      store.save();
    } catch (e) {
      logger.error && logger.error('supervise ' + inst.id + ' error: ' + e.message);
    }
    return { ok: true };
  }
  return { _prepareSystemd, start, stop, probe, probeInstance, supervise };
}
module.exports = { createLifecycle };
