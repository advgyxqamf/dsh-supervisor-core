'use strict';

// 产品状态根（与 DSH 的 ~/.dsh 完全独立）。
// 为什么：我们管控 DSH，却曾把全部状态放在被管控对象的数据目录下，DSH 卸载/清理会带走我们，
// 概念错位。现采用自有状态根：覆盖 DSH_SUPERVISOR_HOME；Linux $XDG_STATE_HOME/dsh-supervisor
// 或 ~/.local/state/dsh-supervisor；macOS ~/Library/Application Support/dsh-supervisor；
// Windows %LOCALAPPDATA%\dsh-supervisor。目录为 <root>/supervisor（内核）与 <root>/shell（桌面壳）。
// 单一事实源：本模块是内核侧唯一入口；桌面壳侧在壳仓 src-tauri/src/env.rs，两侧 schema 常量由门禁握手锁定。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 契约 schema（与壳 env.rs 的 STATE_ROOT_SCHEMA 握手；门禁锁定）。 */
const SCHEMA = 1;

/** 产品状态根（绝对路径）。 */
function root() {
  const override = process.env.DSH_SUPERVISOR_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'dsh-supervisor');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-supervisor');
  }
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && String(xdg).trim()
    ? path.join(String(xdg).trim(), 'dsh-supervisor')
    : path.join(os.homedir(), '.local', 'state', 'dsh-supervisor');
}

/** 内核状态目录（config/state/ports/logs/events/契约）。 */
function supervisorDir() {
  return path.join(root(), 'supervisor');
}

/** 桌面壳状态目录（identity/mirrors/shell.log）。 */
function shellDir() {
  return path.join(root(), 'shell');
}

/** 旧位置（DSH 数据目录下）——仅用于一次性迁移。 */
function legacySupervisorDir() {
  return path.join(os.homedir(), '.dsh', 'supervisor');
}
function legacyShellDir() {
  return path.join(os.homedir(), '.dsh', 'shell');
}

/** 前向自愈迁移：旧位置存在、新位置不存在时整目录搬移。不双读、不复制；失败静默（下次启动再试）。 */
function migrateLegacy() {
  const moved = [];
  for (const [from, to] of [
    [legacySupervisorDir(), supervisorDir()],
    [legacyShellDir(), shellDir()],
  ]) {
    try {
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(to, { recursive: true });
      // 按条目合并：目标已存在的文件不覆盖（可能是新写入的契约）。
      for (const name of fs.readdirSync(from)) {
        const src = path.join(from, name);
        const dst = path.join(to, name);
        if (fs.existsSync(dst)) continue;
        try { fs.renameSync(src, dst); moved.push(src + ' -> ' + dst); } catch { /* 跨设备等：跳过该条 */ }
      }
      try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch {}
    } catch { /* 权限等：不阻断启动 */ }
  }
  return moved;
}

// legacy* 仅 migrateLegacy 内部使用，不对外导出（收窄公开面）。
module.exports = { SCHEMA, root, supervisorDir, shellDir, migrateLegacy };
