'use strict';

// ★ 服务管理器抽象（跨平台审计 §7.1：Provider 分派）★
//
// 铁律（src/platform/os/index.js 已声明，此前未被执行）：
//   平台无关域（domains/*、supervisor）**不得直接调用** systemctl / launchctl / schtasks ——
//   一律经本模块。平台差异在此按 Provider 分派；未实现的能力**显式抛 CapabilityError**（绝不静默失败）。
//
// 背景（2026-09 跨平台审计实测）：域层曾有 8 处裸 `execFileSync('systemctl', ...)`
//   （instance/index.js ×6、supervisor.js ×1、dist/index.js ×1）。它们在「沙箱仅 Linux」的前提下
//   暂不致错，但腐蚀分层契约——一旦 mac/win 支持沙箱，这 8 处就是 8 个必须逐个改的点，
//   而非「换一个 Provider」。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** 平台不具备该能力时抛出（调用方据此给出明确提示，而非 catch 后误报「启动失败/端口冲突」）。 */
class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ stdio: 'ignore' }, opts || {}));
}

/* ── Linux：systemd --user ── */
const systemd = {
  kind: 'systemd',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { try { run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }); return true; } catch { return false; } },
  stopUnit(unit, opts) {
    const o = opts || {};
    try { run('systemctl', ['--user', 'stop', unit], { timeout: o.timeoutMs || 15000 }); return true; }
    catch { return false; } // 停止失败不抛（调用方多为 best-effort 清理）；可经 isUnitActive 复核
  },
  resetFailed(unit) { try { run('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 }); return true; } catch { return false; } },
  isUnitActive(unit) {
    if (!unit) return true; // 无单元约束 → 视为通过（调用方语义）
    try { return execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8', timeout: 8000 }).trim() === 'active'; }
    catch { return false; }
  },
  /** transient 单元文件路径（systemd 特有布局）。 */
  transientUnitFile(unit) {
    let uid = 0;
    try { uid = os.userInfo().uid; } catch { /* 受限环境：退回 /run/user/0 */ }
    const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    return path.join(rt, 'systemd', 'transient', unit + '.service');
  },
  /** 清理 stale transient 单元：stop → reset-failed → 删单元文件 → daemon-reload。
   *  必须 reload：删除文件后 systemd 仍缓存该单元为 loaded，否则 systemd-run 拒绝重建同名单元。 */
  cleanTransient(unit) {
    try { run('systemctl', ['--user', 'stop', unit + '.service'], { timeout: 10000 }); } catch {}
    try { run('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeout: 10000 }); } catch {}
    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch {}
    try { run('systemctl', ['--user', 'daemon-reload'], { timeout: 15000 }); } catch {}
  },
  /** 以 transient 单元启动（独立 cgroup；每实例隔离）。
   *  @param {{unit:string, cmd:string[], env?:object, props?:string[], workingDir?:string, description?:string, timeoutMs?:number}} o
   *    props 为 systemd 属性（如 'KillMode=process'、'MemoryMax=8G'）——由调用方给出业务约束，
   *    平台层只负责拼装成 --property，不解释其语义。 */
  startTransient(o) {
    const opts = o || {};
    const args = ['--user', '--unit=' + opts.unit];
    if (opts.description) args.push('--description=' + opts.description);
    for (const p of (opts.props || [])) args.push('--property=' + p);
    for (const [k, v] of Object.entries(opts.env || {})) args.push('--setenv=' + k + '=' + v);
    if (opts.workingDir) args.push('--working-directory=' + opts.workingDir);
    args.push('--', ...(opts.cmd || []));
    execFileSync('systemd-run', args, { stdio: 'ignore', timeout: opts.timeoutMs || 20000 });
    return true;
  },
};

/* ── 不支持用户单元的 Provider（macOS launchd / Windows 服务 / 未知平台）── */
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
