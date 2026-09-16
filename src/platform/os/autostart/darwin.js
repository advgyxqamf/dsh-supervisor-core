'use strict';

// autostart/darwin.js —— macOS 自启策略（launchctl enable/disable + bootstrap/bootout）。
//
// 设计：**内核只做 enable/disable + bootstrap/bootout，绝不写/删守卫的 plist**
//   （守卫定义归桌面壳，见 index.js 文件头所有权矩阵）。
//   launchctl enable/disable 会持久化到 launchd 覆盖库 —— 这正是「关闭自启」能生效的机制；
//   而旧实现用 unlink 删文件，壳下次启动即重建并 bootstrap，导致关闭不生效。
//   GUI（桌面壳）的 LaunchAgent 是**内核所有**的产物，故其 plist 由本文件创建/删除。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ex = require('../../util/exec');
const { shellDir } = require('../../service/state-root');

const GUARD_LABEL = 'com.dsh.supervisor';
const GUI_LABEL = 'com.dsh.supervisor.gui';
const MAC_T = 8000;

function laFile(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', name + '.plist');
}

function macUid() { return (typeof process.getuid === 'function') ? process.getuid() : 0; }

/** 服务是否已被 launchd 载入（RunAtLoad 服务载入即运行）。 */
function macLoaded(label) {
  try {
    return ex.runDetail('launchctl', ['print', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok;
  } catch { return false; }
}
function macSetEnabled(label, on) {
  try { return ex.runDetail('launchctl', [on ? 'enable' : 'disable', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}
function macBootstrap(file) {
  try { return ex.runDetail('launchctl', ['bootstrap', 'gui/' + macUid(), file], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}
function macBootout(label) {
  try { return ex.runDetail('launchctl', ['bootout', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}

/** XML 文本节点转义（plist 是 XML）。
 *
 *  ⚠ 2026-09-12（P3）：原实现套用了 JSON/字符串转义，对 XML **无效且不必要**：
 *    XML 里双引号在文本节点中本就合法；而真正会让 XML 非法的 &、<、> 完全没处理。
 *    家目录含 & 时 plist 非法 → launchctl bootstrap 失败，上层降级为「已建立未加载」→
 *    壳自启静默失效。注意 & 必须**最先**替换，否则会把后续插入的实体二次转义。
 */
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 桌面壳（GUI）的 LaunchAgent plist —— **内核所有**（面板开关创建/删除）。
 *
 *  ⚠ 关键设计：不加保活。壳的崩溃恢复由「守卫看护」（domains/shell/watchdog）负责；
 *    再加保活会互相争抢拉起。本 plist 只表达「**登录时启动**」这一件事。
 *  LimitLoadToSessionType=Aqua：只在实际图形会话中加载。
 */
function macGuiPlist(guiExe) {
  const log = path.join(shellDir(), 'gui-stdio.log');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + '  <key>Label</key><string>' + xmlEscape(GUI_LABEL) + '</string>\n'
    + '  <key>ProgramArguments</key>\n'
    + '  <array><string>' + xmlEscape(guiExe) + '</string></array>\n'
    + '  <key>RunAtLoad</key><true/>\n'
    + '  <key>LimitLoadToSessionType</key><string>Aqua</string>\n'
    + '  <key>ProcessType</key><string>Interactive</string>\n'
    + '  <key>StandardOutPath</key><string>' + xmlEscape(log) + '</string>\n'
    + '  <key>StandardErrorPath</key><string>' + xmlEscape(log) + '</string>\n'
    + '</dict></plist>\n';
}

/** 守卫（com.dsh.supervisor）与 GUI（com.dsh.supervisor.gui）的自启状态。
 *  守卫定义**由桌面壳建立**（service.rs）—— 内核只读其存在性 + 查询载入状态。 */
function status() {
  const guardDefined = fs.existsSync(laFile(GUARD_LABEL));
  const guardLoaded = guardDefined && macLoaded(GUARD_LABEL);
  const guiFile_ = laFile(GUI_LABEL);
  const guiDefined = fs.existsSync(guiFile_);
  return {
    kind: 'launchagent',
    on: guardLoaded,
    gui: guiDefined && macLoaded(GUI_LABEL),
    guardDefined,                // 供面板解释「定义缺失 → 请先启动一次桌面壳」
    guardLabel: GUARD_LABEL,
    guiLabel: GUI_LABEL,
  };
}

/** 守卫服务自启开关。⚠ 内核**不写、不删**守卫 plist（定义归桌面壳）。 */
function setAutostart(on, deps) {
  const errors = [];
  try {
    const file = laFile(GUARD_LABEL);
    if (on) {
      if (!fs.existsSync(file)) {
        errors.push('守卫服务定义缺失（' + file + '）：定义由桌面壳建立，请先启动一次桌面壳');
      } else {
        if (!macSetEnabled(GUARD_LABEL, true)) errors.push('launchctl enable 失败');
        if (!macLoaded(GUARD_LABEL) && !macBootstrap(file)) errors.push('launchctl bootstrap 失败');
      }
    } else {
      if (macLoaded(GUARD_LABEL)) macBootout(GUARD_LABEL);
      if (!macSetEnabled(GUARD_LABEL, false)) errors.push('launchctl disable 失败');
      // 刻意**不删除 plist**：定义属壳；删掉会被壳重建 → 关闭不生效。
    }
  } catch (e) { errors.push('launchagent: ' + e.message); }
  const g = setGuiAutostart(on, deps);
  if (!g.ok) errors.push(g.error || 'GUI 自启设置失败');
  return { ok: errors.length === 0, errors, ...status() };
}

/** GUI（桌面壳）登录自启 —— 独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad，无保活）。 */
function setGuiAutostart(on, deps) {
  try {
    const file = laFile(GUI_LABEL);
    if (on) {
      const gui = deps.guiCommand();
      if (!gui || !fs.existsSync(gui)) {
        // 不盲写一个指向不存在文件的 plist（否则登录时 launchd 静默失败）。
        return { ok: false, platform: 'darwin', enabled: false,
                 error: '未定位到桌面壳可执行文件，无法配置自启：' + gui };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const atmp = file + '.tmp';
      fs.writeFileSync(atmp, macGuiPlist(gui));
      fs.renameSync(atmp, file);            // 原子写
      macSetEnabled(GUI_LABEL, true);
      const loaded = macLoaded(GUI_LABEL) || macBootstrap(file);
      return { ok: true, platform: 'darwin', enabled: true, via: 'launchagent',
               label: GUI_LABEL, file, exe: gui, loaded };
    }
    if (macLoaded(GUI_LABEL)) macBootout(GUI_LABEL);
    macSetEnabled(GUI_LABEL, false);
    try { fs.unlinkSync(file); } catch {}   // GUI 产物属内核 → 关闭即删除是干净的
    return { ok: true, platform: 'darwin', enabled: false, via: 'launchagent', label: GUI_LABEL };
  } catch (e) {
    return { ok: false, platform: 'darwin', enabled: false, error: e.message };
  }
}

module.exports = {
  GUARD_LABEL, GUI_LABEL, laFile, xmlEscape, macGuiPlist,
  macLoaded, macSetEnabled, macBootstrap, macBootout,
  status, setAutostart, setGuiAutostart,
};
