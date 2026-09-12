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
const exec = require('../exec');

/** 平台不具备该能力时抛出（调用方据此给出明确提示，而非 catch 后误报「启动失败/端口冲突」）。 */
class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

function run(cmd, args, opts) {
  // ⚠ 经统一执行器（默认 15s 硬超时 + SIGKILL）—— 防 systemd/dbus 挂起时无限阻塞。
  //   调用方传的 timeoutMs 仍生效（exec.options 会用它覆盖默认值）。
  //
  // ⚠ 2026-09-13（P0 修复）：**不再强制 stdio:'ignore'**。
  //
  //   缺陷：本包装曾无条件 `Object.assign({ stdio: 'ignore' }, opts)` ——
  //     于是即便调用方要**读输出**（如 isUnitActive 传 encoding:'utf8'），stdio 也被压成 'ignore'，
  //     execFileSync 便**不捕获 stdout** → 返回 null → isUnitActive 恒得 '' ≠ 'active' → **恒 false**。
  //     实测：对一个确实 active 的 --user 单元调用 isUnitActive() 返回 false。
  //
  //   后果（不止一处）：
  //     · 实例就绪判定要求 unitActive() → 永远不满足 → 升级在稳定期判「未能启动」→ 误回滚；
  //     · 实例域删数据目录前的 isUnitActive 复核恒 false → 「仍活跃则不删」的保护**永不生效**（数据丢失防线失效代）;
  //     · 任何未来「经本包装读输出」的调用都会静默拿到空值。
  //
  //   修法：默认沿用 exec 自己的 stdio（['ignore','pipe','pipe']）—— 不捕获也不丢输出。
  //     写类命令（start/stop/reload）不关心 stdout，piping 只是多几字节，无副作用。
  return exec.run(cmd, args, opts || {});
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
    run('systemd-run', args, { stdio: 'ignore', timeoutMs: opts.timeoutMs || 20000 });
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
