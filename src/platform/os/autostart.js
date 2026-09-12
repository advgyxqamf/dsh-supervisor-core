'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台化开机自启（三端同一 setAutostart(on) / status()）
//
// ## 所有权矩阵（2026-09-11 定案 —— 此前**没有**矩阵，导致两个写入方争同一文件）
//
// | 产物                          | 唯一所有者        | 依据 |
// |-------------------------------|-------------------|------|
// | 守卫服务**定义**              | **桌面壳**        | 引导顺序：壳是安装器，装内核后立即建立（service.rs）|
// |   · Linux  ~/.config/systemd/user/dsh-supervisor.service
// |   · macOS  ~/Library/LaunchAgents/com.dsh.supervisor.plist
// |   · Windows 计划任务 DSH-Supervisor
// | 守卫自启**开关**（enable/disable）| **内核**（面板）| 用户可见设置项在面板 |
// | 壳（GUI）自启产物              | **内核**          | 同上；与守卫自启同属「整链自启」语义 |
// | 壳崩溃自愈                    | **守卫看护**      | 壳不能自监督（domains/shell/watchdog）|
//
// ### 修复的历史缺陷（本次定案的原因）
//
// 1. **双写冲突**：内核曾与壳**同时写** macOS 的 com.dsh.supervisor.plist ——
//    两个模板各自演进必然漂移；且内核 disable 时 `unlink` 该文件，
//    而壳下次启动会**重建并 bootstrap** → **用户「关闭自启」不生效**。
//    现内核**只做 enable/disable + bootstrap/bootout，绝不写/删该文件**（launchctl enable/disable 持久化到 launchd 覆盖库）。
// 2. **macOS 无壳自启**：旧注释谎称「同 plist 附带」，实测 plist 只含守卫；
//    现新增独立 LaunchAgent com.dsh.supervisor.gui（壳所有者的产物，内核创建）。
//
// ## 平台机制
// - Linux  ：systemd --user enable/disable + linger + XDG autostart .desktop（GUI）
// - macOS  ：launchctl enable/disable + bootstrap/bootout
//            （守卫 plist 由壳建立；GUI 用独立 plist com.dsh.supervisor.gui）
// - Windows：schtasks ONLOGON（GUI）+ MINUTE watchdog（崩溃自拉）+ /Change /ENABLE|/DISABLE（守卫）
//
// 全部外部命令经 platform/exec 统一执行器（有界 + SIGKILL + windowsHide），
// 平台能力缺失时返回明确错误，绝不静默成功。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// ⚠ 统一子进程执行器（2026-09-11）：本文件原有 11 处 execFileSync **无 timeout**，
//   systemctl / schtasks 在 dbus 无响应或服务管理器挂起时即无限期阻塞守卫事件循环。
const ex = require('../exec');
const { resolveExecutable } = require('./exec-path');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const GUARD_LABEL = 'com.dsh.supervisor';
const GUI_LABEL = 'com.dsh.supervisor.gui';

function laFile(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', name + '.plist');
}

// ── macOS launchctl 助手 ──
// 设计：**内核只做 enable/disable + bootstrap/bootout，绝不写/删守卫的 plist**
//   （守卫定义归桌面壳，见文件头所有权矩阵）。
//   `launchctl enable/disable` 会持久化到 launchd 覆盖库 —— 这正是「关闭自启」能生效的机制；
//   而旧实现用 `unlink` 删文件，壳下次启动即重建并 bootstrap，导致关闭不生效。
function macUid() { return (typeof process.getuid === 'function') ? process.getuid() : 0; }
const MAC_T = 8000;

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

/**
 * 桌面壳（GUI）的 LaunchAgent plist —— **内核所有**（面板开关创建/删除）。
 *
 * ⚠ 关键设计：**不加 KeepAlive**。
 *   壳的崩溃恢复由「守卫看护」（domains/shell/watchdog）负责 —— 它会先确认图形会话、
 *   有宽限期、有界重试。若此处再加 KeepAlive，两套机制会互相争抢拉起，
 *   且 launchd 的 KeepAlive 在 GUI 应用上可能造成无退避的重启循环。
 *   故本 plist 只表达「**登录时启动**」这一件事。
 *
 * LimitLoadToSessionType=Aqua：只在实际图形会话中加载（守规矩的做法，
 *   与 domains/shell/watchdog 的 sessionAvailable 判定语义一致）。
 */
/** XML 文本节点转义（plist 是 XML）。
 *
 *  ⚠ 2026-09-12（P3）：原实现只做 `replace(/"/g, '\\"')` —— 那是 **JSON/字符串** 的转义，
 *   对 XML **无效且不必要**：
 *     · XML 里 `"` 在文本节点中本就合法，无需转义；
 *     · 而真正会让 XML 非法的 `&`、`<`、`>` **完全没处理**。
 *   家目录含 `&`（如 `/Users/a&b/...`）时 plist 非法 → `launchctl bootstrap` 失败，
 *   报错只是 syntax error，且上层降级为「已建立未加载」→ **壳自启静默失效**。
 *
 *   注意 `&` 必须**最先**替换，否则会把后续插入的实体二次转义（`&amp;lt;`）。
 */
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function macGuiPlist(guiExe) {
  const log = path.join(os.homedir(), '.dsh', 'shell', 'gui-stdio.log');
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
function guiFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'dsh-supervisor-gui-autostart.desktop');
}

/** 当前自启状态。 */
function status() {
  if (isWindows) {
    // 三个任务的**职责分离**（2026-09-11 架构修正）：
    //   DSH-Supervisor          -> 守卫守护进程（**由桌面壳建立**；壳的 schtasks /Run 指向它）
    //   DSH-Supervisor-GUI      -> 登录时打开桌面壳（本文件的 autostart 开关管理）
    //   DSH-Supervisor-Watchdog -> 每 5 分钟保活（崩溃自拉）
    //
    // ⚠ 旧实现把 DSH-Supervisor 指向 **GUI 壳**，而壳的 start_guard_service() 执行
    //   `schtasks /Run /TN DSH-Supervisor` —— 于是「启动守卫」实际只是再开一次壳
    //   （被单实例插件折回焦点），**守卫永远不会被启动**。现已改名分离，彻底消除该错位。
    let guard = false, gui = false, watchdog = false;
    const has = (tn) => {
      try {
        const out = ex.runOut('schtasks', ['/Query', '/TN', tn], { stdio: ['ignore', 'pipe', 'ignore'] });
        return !!out && out.includes(tn);
      } catch { return false; }
    };
    guard = has('DSH-Supervisor');
    gui = has('DSH-Supervisor-GUI');
    watchdog = has('DSH-Supervisor-Watchdog');
    return { kind: 'schtasks', on: guard || gui || watchdog, gui, watchdog, guard };
  }
  if (isMac) {
    // 守卫定义**由桌面壳建立**（service.rs）—— 内核只读其存在性 + 查询载入状态。
    const guardDefined = fs.existsSync(laFile(GUARD_LABEL));
    const guardLoaded = guardDefined && macLoaded(GUARD_LABEL);
    const guiFile_ = laFile(GUI_LABEL);
    const guiDefined = fs.existsSync(guiFile_);
    return {
      kind: 'launchagent',
      on: guardLoaded,
      gui: guiDefined && macLoaded(GUI_LABEL),
      // ⚠ 2026-09-12：删除 `guiSupported` 字段 —— 它是**死声明**：
      //   · 只有本分支（macOS）产出它，Windows/Linux 两个分支都没有；
      //   · 全仓**零消费者**：前端契约 `AutostartStatus` 只有 {on, unit?, gui?}，
      //     壳（Tauri src）grep 零命中，内核自身也只有那个「恒真断言」的测试在读。
      //   且 macOS 分支恒为 `true`（无信息量）。删除以免读者以为存在跨端能力协商。
      guardDefined,                // 供面板解释「定义缺失 → 请先启动一次桌面壳」
      guardLabel: GUARD_LABEL,
      guiLabel: GUI_LABEL,
    };
  }
  // Linux
  let unit = 'unknown';
  const en = ex.runDetail('systemctl', ['--user', 'is-enabled', 'dsh-supervisor.service']);
  unit = String(en.stdout || en.stderr || 'disabled').trim() || 'disabled';
  return { kind: 'systemd', unit, on: unit === 'enabled', gui: fs.existsSync(guiFile()) };
}

/** 服务链自启（守卫 + 面板）。 */
function setAutostart(on) {
  const errors = [];
  if (isWindows) {
    // Windows 崩溃自拉宿主（2026-09 补齐）：schtasks ONLOGON 只登录启动一次，进程崩溃后不会重启。
    // 方案：双任务——(a) ONLOGON 启动 GUI 壳（用户常驻入口）；(b) Watchdog 每 5 分钟检查守卫
    // API（localhost:apiPort 探测），进程不在则重新拉起 daemon（写 watchdog.ps1 到数据目录，纯 PS 免转义）。
    try {
      const watchdogPs1 = path.join(os.homedir(), '.dsh', 'supervisor', 'watchdog.ps1');
      if (on) {
        const apiPort = process.env.DSH_SUPERVISOR_API_PORT || '36361';
        const daemon = daemonCommand();
        const guiPath = guiCommand();
        const ps = [
          '$ErrorActionPreference = "SilentlyContinue"',
          '$port = ' + JSON.stringify(String(apiPort)),
          '$daemon = ' + JSON.stringify(String(daemon)),
          '$gui = ' + JSON.stringify(String(guiPath)),
          '$up = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue',
          '# ── 守卫保活（仅在守卫不可达时）──',
          'if (-not $up) {',
          '  $p = @(Get-Process -Name dsh-supervisor -ErrorAction SilentlyContinue)',
          "  if (-not $p) { Start-Process -FilePath $daemon -ArgumentList 'daemon' -WindowStyle Hidden }",
          '}',
          '# ── 壳保活（⚠ 必须**独立于守卫状态**）──',
          '#   2026-09-11 审计修复：旧实现把壳检查嵌在上面的 if (-not $up) 内，',
          '#   于是「壳崩、守卫活」时 $up 为真 → 整块跳过 → **壳永远不会被拉起**。',
          '#   而那恰是壳自愈唯一需要生效的场景（守卫由服务管理器保活，壳无人管）。',
          '$g = @(Get-Process -Name dsh-supervisor-gui -ErrorAction SilentlyContinue)',
          'if (-not $g -and (Test-Path $gui)) { Start-Process -FilePath $gui -WindowStyle Hidden }',
          'exit 0',
        ].join(String.fromCharCode(13, 10));
        fs.mkdirSync(path.dirname(watchdogPs1), { recursive: true });
        const atmp = watchdogPs1 + '.tmp'; fs.writeFileSync(atmp, ps); fs.renameSync(atmp, watchdogPs1); // 原子写
        // (a) 登录启动 GUI（任务名与「守卫服务」分离，避免覆盖壳建立的守卫任务）
        { const r = ex.runDetail('schtasks', ['/Create', '/TN', 'DSH-Supervisor-GUI', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + guiCommand() + '"']);
          if (!r.ok) errors.push('schtasks gui: ' + (r.error || '执行失败')); }
        // (c) 守卫任务（DSH-Supervisor）由**桌面壳**建立；这里只负责「开机自启」语义的启用
        ex.run('schtasks', ['/Change', '/TN', 'DSH-Supervisor', '/ENABLE']);
        // (b) 每 5 分钟 watchdog 保活（崩溃自动拉起）
        { const r = ex.runDetail('schtasks', ['/Create', '/TN', 'DSH-Supervisor-Watchdog', '/SC', 'MINUTE', '/MO', '5', '/RL', 'HIGHEST', '/F', '/TR', 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + watchdogPs1 + '"']);
          if (!r.ok) errors.push('schtasks watchdog: ' + (r.error || '执行失败')); }
      } else {
        ex.run('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-Watchdog', '/F']);
        ex.run('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);
        // 守卫任务不删除（它是**服务定义**，删了壳的 /Run 会再次失败）；只停用开机自启。
        ex.run('schtasks', ['/Change', '/TN', 'DSH-Supervisor', '/DISABLE']);
        try { fs.unlinkSync(watchdogPs1); } catch {}
      }
    } catch (e) { errors.push('watchdog setup: ' + e.message); }
    return { ok: errors.length === 0, errors, ...status() };
  }
  if (isMac) {
    // ⚠ 守卫的 plist 由**桌面壳**建立（所有权矩阵见文件头）—— 内核**不写、不删**。
    //   内核只做：`launchctl enable/disable`（持久化到 launchd 覆盖库）+ bootstrap/bootout。
    //   修掉的历史缺陷：旧实现在 disable 时 `unlink` 该文件，而壳下次启动会重建并 bootstrap →
    //   **用户「关闭自启」不生效**。
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
    const g = setGuiAutostart(on, 'darwin');
    if (!g.ok) errors.push(g.error || 'GUI 自启设置失败');
    return { ok: errors.length === 0, errors, ...status() };
  }
  // Linux（systemd --user + linger + GUI desktop）
  { const r = ex.runDetail('systemctl', ['--user', 'daemon-reload']);
    if (!r.ok) errors.push('daemon-reload: ' + (r.error || '执行失败')); }
  { const r = ex.runDetail('systemctl', ['--user', on ? 'enable' : 'disable', 'dsh-supervisor.service']);
    if (!r.ok) errors.push((on ? 'enable' : 'disable') + ': ' + (r.error || '执行失败')); }
  { const r = ex.runDetail('loginctl', [on ? 'enable-linger' : 'disable-linger', os.userInfo().username]);
    if (!r.ok && on) errors.push('enable-linger: ' + (r.error || '执行失败')); }
  const g = setGuiAutostart(on);
  if (!g.ok) errors.push(g.error);
  return { ok: errors.length === 0, errors, ...status() };
}

/** GUI（桌面壳）登录自启 —— **三平台均已实现**（2026-09-11 补齐 macOS）。
 *
 *  linux  —— ✅ XDG autostart .desktop（Exec 按实际安装解析）
 *  darwin —— ✅ 独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad，无 KeepAlive）
 *  win32  —— ✅ schtasks 任务 DSH-Supervisor-GUI（由 setAutostart 建立；本函数不重复实现）
 *
 * ⚠ 历史错误（奠基提交 8867942 起，2026-09-11 审计发现）：
 *   旧注释声称「mac 由 LaunchAgent 一并代管」，而 macPlist 从奠基至今逐字节未变、只含守卫；
 *   旧实现据此对非 Linux 平台直接 `return { ok: true }` —— **静默成功**。
 *   现已实现，且实现方式仍遵循不变量：**未实现的能力必须显式报告**（见下方未知平台分支）。
 */
function setGuiAutostart(on, platform) {
  const pl = platform || process.platform;
  if (pl === 'darwin') {
    // macOS 原生壳自启（**内核所有**的产物；守卫的 plist 归壳，两者标签分离）。
    try {
      const file = laFile(GUI_LABEL);
      if (on) {
        const gui = guiCommand();
        if (!gui || !fs.existsSync(gui)) {
          // 不盲写一个指向不存在文件的 plist（否则登录时 launchd 静默失败）。
          return { ok: false, platform: pl, enabled: false,
                   error: '未定位到桌面壳可执行文件，无法配置自启：' + gui };
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const atmp = file + '.tmp';
        fs.writeFileSync(atmp, macGuiPlist(gui));
        fs.renameSync(atmp, file);            // 原子写
        macSetEnabled(GUI_LABEL, true);
        const loaded = macLoaded(GUI_LABEL) || macBootstrap(file);
        return { ok: true, platform: pl, enabled: true, via: 'launchagent',
                 label: GUI_LABEL, file, exe: gui, loaded };
      }
      if (macLoaded(GUI_LABEL)) macBootout(GUI_LABEL);
      macSetEnabled(GUI_LABEL, false);
      try { fs.unlinkSync(file); } catch {}   // GUI 产物属内核 → 关闭即删除是干净的
      return { ok: true, platform: pl, enabled: false, via: 'launchagent', label: GUI_LABEL };
    } catch (e) {
      return { ok: false, platform: pl, enabled: false, error: e.message };
    }
  }
  if (pl === 'win32') {
    // Windows 的壳自启由 setAutostart 的 schtasks DSH-Supervisor-GUI 承担（职责分离，见本文件顶部注释）。
    return { ok: true, platform: pl, enabled: !!on, via: 'schtasks', task: 'DSH-Supervisor-GUI' };
  }
  if (pl !== 'linux') return { ok: false, unsupported: true, platform: pl, enabled: false, error: '未知平台' };
  try {
    const file = guiFile();
    if (on) {
      const tpl = path.join(__dirname, '..', '..', '..', 'desktop', 'dsh-supervisor-gui-autostart.desktop');
      let entry = fs.readFileSync(tpl, 'utf8');
      // ⚠ Exec 必须指向**解析出的真实路径**（2026-09-11 审计修复）：
      //   模板写死 `@HOME@/.local/bin/dsh-supervisor-gui`，而 deb/rpm 把可执行装在
      //   **/usr/bin/dsh-supervisor-gui**（实测 dpkg -c 确认）。
      //   于是「用安装包」的用户启用开机自启后，登录时 Exec 指向**不存在的文件** ——
      //   桌面环境静默忽略，用户以为已开启。
      //   guiCommand() 已具备跨安装形态的解析能力（PATH/标准目录），此处复用。
      entry = entry.split('@HOME@').join(os.homedir());
      const guiBin = guiCommand();
      const oldExec = os.homedir() + '/.local/bin/dsh-supervisor-gui';
      if (entry.includes(oldExec)) entry = entry.split(oldExec).join(guiBin);
      // ⚠ 2026-09-12（P3）：Desktop Entry 规范的 `Exec=` 也是**空格分词**的——
      //   路径含空格时（家目录如 `/home/john smith`）必须用引号界定，否则
      //   桌面环境把 `/home/john` 当可执行、`smith/...` 当参数 → 自启静默失败。
      //   规范要求（两处，缺一不可）：
      //     ① 值内的双引号用 `\\"` 转义，反斜杠用 `\\\\`；
      //     ② **字面 `%` 必须写成 `%%`** —— 因为 `%` 是字段码前缀，
      //        未转义的 `%u`/`%f`/`%k` 会被桌面环境解释成「传入 URL/文件/图标名」，
      //        Exec 解析失败 → **登录自启静默失效**。
      //
      //   ⚠ 2026-09-12 补 ②：此前只做了 ①（修好「路径含空格」），
      //     而「家目录含 `%`」（如 `/home/100%user`）仍是同一类缺陷的**未修面** ——
      //     注释当时已自称「规范要求」，实际只覆盖了引号与反斜杠。
      //   （与 systemd ExecStart、schtasks /TR 同属一类，三处都需处理。）
      const execQuote = (p) => '"' + String(p)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/%/g, '%%') + '"';
      entry = entry.replace(/^Exec=.*$/m, 'Exec=' + execQuote(guiBin));
      // Icon 同样按实际安装解析（deb 装到 /usr/share，本地装到 ~/.local/share）
      const iconCandidates = [
        path.join(os.homedir(), '.local', 'share', 'icons', 'dsh-supervisor.png'),
        '/usr/share/icons/hicolor/256x256/apps/dsh-supervisor.png',
        '/usr/share/pixmaps/dsh-supervisor.png',
      ];
      const icon = iconCandidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
      if (icon) entry = entry.split(/^Icon=.*$/m).join('Icon=' + icon);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const atmp2 = file + '.tmp'; fs.writeFileSync(atmp2, entry); fs.renameSync(atmp2, file); // 原子写
    } else { try { fs.unlinkSync(file); } catch {} }
    return { ok: true, enabled: !!on, exec: guiCommand() };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 守护进程执行路径（自启/服务定义使用）。
 *  P0 修复：旧实现硬拼 ~/.local/bin/dsh-supervisor —— Windows 上**无 .exe 且目录非标准**，
 *  watchdog 的 Start-Process 静默失败（Windows 崩溃自愈实际不可用）。
 *  现经跨平台解析：PATH（Windows 含 PATHEXT）→ %APPDATA%\npm → ~/.local/bin → ~/.npm-global/bin。
 *  仍无命中时回退「平台规范的安装位置」（Windows 带 .exe），保证路径形态正确。 */
function daemonCommand() {
  const hit = resolveExecutable('dsh-supervisor', { envVar: 'DSH_SUPERVISOR_DAEMON' });
  if (hit) return hit;
  const exe = isWindows ? 'dsh-supervisor.exe' : 'dsh-supervisor';
  return path.join(os.homedir(), '.local', 'bin', exe);
}

/** GUI 壳可执行路径（Windows watchdog 拉起面板用）。
 *  壳由 launcher 安装器部署，位置随安装方式而异——按 env 覆盖 → 常见安装位置解析。 */
function guiCommand() {
  const hit = resolveExecutable(isWindows ? 'dsh-supervisor-gui' : 'dsh-supervisor-gui',
    { envVar: 'DSH_SHELL_EXE' });
  if (hit) return hit;
  const home = os.homedir();
  const exe = isWindows ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui';
  const cands = isWindows
    ? [path.join(home, '.local', 'bin', exe), path.join(home, 'AppData', 'Local', 'Programs', 'dsh-supervisor', exe)]
    : [path.join(home, '.local', 'bin', exe), '/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return cands[0];
}

// ⚠ 守卫的 plist 模板**不在本文件**（2026-09-11 起）：
//   守卫服务定义的**所有权在桌面壳**（`src-tauri/src/platform/{linux,macos,windows}.rs`），
//   内核只做 `launchctl enable/disable`（见文件头所有权矩阵）。
//   此处原有一个 `macPlist()` 模板副本 —— 已删除，因为两个写入方必然漂移；
//   且内核 disable 时 unlink 它、而壳下次启动会重建（「关闭自启」因此不生效）。
//   KeepAlive 的跨仓断言见 `test/platform-capability-audit-test.js`。
//
// 下方 `macGuiPlist()` 是 **GUI** 的 plist（内核所有的产物），故保留在核仓。

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand, guiCommand };
