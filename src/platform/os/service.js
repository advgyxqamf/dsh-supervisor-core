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
  // 必须原样透传 opts，不得强制 stdio ignore：否则要读输出的调用（如 isUnitActive 传 encoding）会
  // 拿不到 stdout，isUnitActive 恒 false，实例就绪判定与「仍活跃则不删」的保护全部失效。
  return exec.run(cmd, args, opts || {});
}

/* Linux：systemd --user */
const systemd = {
  kind: 'systemd',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }) !== null; } catch { return false; } },
  stopUnit(unit, opts) {
    const o = opts || {};
    try { return run('systemctl', ['--user', 'stop', unit], { timeout: o.timeoutMs || 15000 }) !== null; }
    catch { return false; } // 停止失败不抛（调用方多为 best-effort 清理）；可经 isUnitActive 复核
  },
  resetFailed(unit) { try { run('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 }); return true; } catch { return false; } },
  isUnitActive(unit) {
    if (!unit) return true; // 无单元约束 -> 视为通过（调用方语义）
    try { return (run('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeoutMs: 8000 }) || '').toString().trim() === 'active'; }
    catch { return false; }
  },
  /** transient 单元文件路径（systemd 特有布局）。 */
  transientUnitFile(unit) {
    let uid = 0;
    try { uid = os.userInfo().uid; } catch { /* 受限环境：退回 /run/user/0 */ }
    const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    return path.join(rt, 'systemd', 'transient', unit + '.service');
  },
  /** 清理 stale transient 单元：stop/reset-failed/删单元文件/daemon-reload。
   *  必须 reload：删除文件后 systemd 仍缓存该单元为 loaded，否则 systemd-run 拒绝重建同名单元。 */
  cleanTransient(unit) {
    try { run('systemctl', ['--user', 'stop', unit + '.service'], { timeout: 10000 }); } catch {}
    try { run('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeout: 10000 }); } catch {}
    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch {}
    try { run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }); } catch {}
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
    cleanTransient() {},
    startTransient() { throw new CapabilityError(label + '：不支持 transient 实例（沙箱需 Linux + systemd-run）'); },
  };
}

const PROVIDERS = {
  linux: systemd,
  darwin: makeUnsupported('launchd', 'macOS launchd'),
  win32: makeUnsupported('windows-service', 'Windows 服务/计划任务'),
};
const NONE = makeUnsupported('none', '当前平台无服务管理器');

/** 当前平台的服务管理器 Provider。 */
function current() { return PROVIDERS[PLATFORM] || NONE; }

module.exports = { current, CapabilityError, kind: () => current().kind, PLATFORM };