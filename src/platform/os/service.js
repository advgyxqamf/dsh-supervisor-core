'use strict';

// 服务管理器抽象（Provider 分派）。
// 铁律：平台无关域（domains/*、supervisor）不得直接调用 systemctl/launchctl/schtasks，一律经本模块；
// 平台差异在此按 Provider 分派，未实现的能力显式抛 CapabilityError（绝不静默失败）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exec = require('../util/exec');

/** 平台不具备该能力时抛出（调用方据此给出明确提示，而非 catch 后误报「启动失败/端口冲突」）。 */
class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

function run(cmd, args, opts) {
  // 经统一执行器（默认 15s 硬超时 + SIGKILL，防 systemd/dbus 挂起时无限阻塞）；调用方 timeoutMs 仍生效。
  // 必须原样透传 opts，不得强制 stdio ignore：否则要读 stdout 的调用（如 isUnitActive 经 runDetail
  // 读单元状态）会拿不到输出，实例就绪判定与「仍活跃则不删」的保护全部失效。
  return exec.run(cmd, args, opts || {});
}

const systemd = {
  kind: 'systemd',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }) !== null; } catch { return false; } },
  stopUnit(unit, opts) {
    const o = opts || {};
    try { return run('systemctl', ['--user', 'stop', unit], { timeoutMs: o.timeoutMs || 15000 }) !== null; }
    catch { return false; } // 停止失败不抛（调用方多为 best-effort 清理）；可经 isUnitActive 复核
  },
  // run() 失败返回 null 而不抛，故原 try/catch 是死代码、恒返回 true（N5）。如实回传成败。
  resetFailed(unit) { return run('systemctl', ['--user', 'reset-failed', unit], { timeoutMs: 10000 }) !== null; },
  /** 单元活跃判定（三态）：确认 active -> true；确认不活跃 -> false；查询未完成 -> null（未知）。
   *  旧实现把「查询未完成」折成 false，而 run() 失败只返回 null，于是
   *  instance/ops.js 删除数据目录前的 null 保护成了不可达死分支，is-active 超时时仍会 rmSync
   *  沙箱数据（FIX-5 A 的根因）。调用方按「!== false 才放行删除」消费本函数。 */
  isUnitActive(unit) {
    if (!unit) return true; // 无单元约束 -> 视为通过（调用方语义）
    try {
      const r = exec.runDetail('systemctl', ['--user', 'is-active', unit], { timeoutMs: 8000 });
      if (r.timedOut) return null; // 超时 -> 查询未完成，未知（绝不当作「不活跃」）
      const state = String(r.stdout || '').trim(); // is-active 把状态打到 stdout（非零退出时同样有）
      if (state === 'active') return true;
      if (state || r.code !== null) return false; // systemctl 已作答 -> 确认不活跃
      return null; // 未能执行（如 ENOENT）-> 未知
    } catch { return null; }
  },
  transientUnitFile(unit) {
    let uid = 0;
    try { uid = os.userInfo().uid; } catch { /* 受限环境：退回 /run/user/0 */ }
    const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    return path.join(rt, 'systemd', 'transient', unit + '.service');
  },
  /** 清理 stale transient 单元：stop/reset-failed/删单元文件/daemon-reload。
   *  必须 reload：删除文件后 systemd 仍缓存该单元为 loaded，否则 systemd-run 拒绝重建同名单元。
   *  返回 {ok, errors}：原实现四步全由 try/catch 包裹，而 run() 失败只返回 null 不抛 —— 四步
   *  全部静默，调用方无条件记「cleaned」日志（N5）。stop/reset-failed 对「从未加载的单元」非零
   *  退出属正常，不计入 ok；真正的硬失败只有删单元文件与 daemon-reload。 */
  cleanTransient(unit) {
    const errors = [];
    exec.runDetail('systemctl', ['--user', 'stop', unit + '.service'], { timeoutMs: 10000 });
    exec.runDetail('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeoutMs: 10000 });
    let unlinkOk = true;
    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch { unlinkOk = false; errors.push('unlink ' + unit + '.service'); }
    if (!exec.runDetail('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }).ok) errors.push('daemon-reload');
    return { ok: unlinkOk && errors.length === 0, errors };
  },
  /** 以 transient 单元启动（独立 cgroup；每实例隔离）。
   *  @param {{unit:string, cmd:string[], env?:object, props?:string[], workingDir?:string, description?:string, timeoutMs?:number}} o
   *    props 为 systemd 属性（如 KillMode=process、MemoryMax=8G），平台层只拼装成 --property，不解释语义。 */
  startTransient(o) {
    const opts = o || {};
    const args = ['--user', '--unit=' + opts.unit];
    if (opts.description) args.push('--description=' + opts.description);
    for (const p of (opts.props || [])) args.push('--property=' + p);
    for (const [k, v] of Object.entries(opts.env || {})) args.push('--setenv=' + k + '=' + v);
    if (opts.workingDir) args.push('--working-directory=' + opts.workingDir);
    args.push('--', ...(opts.cmd || []));
    // run() 失败会吞成 null；这里必须区分成败并抛错，否则 _systemdStart 的 catch 永不进入，
    // systemd-run 真实失败仍被当成启动成功（实例停在 STARTING，30s 后才转 BACKOFF）。
    const r = exec.runDetail('systemd-run', args, { timeoutMs: opts.timeoutMs || 20000 });
    if (!r.ok) throw new Error('systemd-run 失败: ' + (r.error || 'unknown') + (r.stderr ? ' | ' + String(r.stderr).trim() : ''));
    return true;
  },
};

/* 不支持用户单元的 Provider（macOS launchd / Windows 服务 / 未知平台） */
function makeUnsupported(kind, label) {
  return {
    kind,
    supportsUnits: false,
    supportsTransient: false,
    daemonReload() { return false; },
    stopUnit() { throw new CapabilityError(label + '：不支持以用户单元方式管理被管实例'); },
    resetFailed() { return false; },
    isUnitActive(unit) { return unit ? false : true; },
    transientUnitFile() { return null; },
    // 无 transient 单元可清 = 成功；返回形态与 systemd 一致，调用方无需分支（N5）。
    cleanTransient() { return { ok: true, errors: [] }; },
    startTransient() { throw new CapabilityError(label + '：不支持 transient 实例（沙箱需 Linux + systemd-run）'); },
  };
}

const PROVIDERS = {
  linux: systemd,
  darwin: makeUnsupported('launchd', 'macOS launchd'),
  win32: makeUnsupported('windows-service', 'Windows 服务/计划任务'),
};
const NONE = makeUnsupported('none', '当前平台无服务管理器');

function current() { return PROVIDERS[PLATFORM] || NONE; }

module.exports = { current, CapabilityError, kind: () => current().kind, PLATFORM };
