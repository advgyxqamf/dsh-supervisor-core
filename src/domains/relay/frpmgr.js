/**
 * FRP 客户端托管：为远程控制实例提供公网暴露能力。
 * - 自动下载 frpc 二进制（GitHub release + 镜像加速）
 * - 由 lan-instances 中开启 frpEnabled 的实例动态生成 frpc.toml
 * - 托管 frpc 进程生命周期（启动/停止/崩溃重启）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const FRP_VERSION = '0.61.1';

/** FRP 官方发布平台标签（命名规则 frp_<ver>_<os>_<arch>.tar.gz）。
 *  - os: linux | darwin | windows（win32 映射 windows）
 *  - arch: amd64 | arm64
 *  - 二进制名：Windows 为 frpc.exe，其余 frpc
 *  @param platform 可选（默认 process.platform）——纯函数便于跨端映射测试
 *  @param arch 可选（默认 process.arch）
 *  @returns {{ tag:string, exe:boolean }} 或 null（不支持的平台） */
function frpPlatformTag(platform, arch) {
  const pl = platform || process.platform;
  const ar = arch || process.arch;
  const osMap = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const os = osMap[pl];
  const am = archMap[ar];
  if (!os || !am) return null;
  return { os, arch: am, tag: os + '_' + am, exe: pl === 'win32' };
}

// 下载镜像前缀（国内镜像优先，GitHub 官方兜底）。URL 主体按平台动态生成（2026-09 审计修复：
// 原三镜像硬编码 linux_amd64 → macOS/Windows 端 FRP 公网暴露完全不可用）。
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  '', // GitHub 官方直连
];

function downloadUrls(asset) {
  const base = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/' + asset;
  return MIRROR_PREFIXES.map((p) => p + base);
}

class FrpManager {
  constructor(opts) {
    this.dir = opts.dir;               // ~/.dsh/supervisor
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.settingsFile = path.join(this.dir, 'frp.json');
    this.configFile = path.join(this.dir, 'frpc.toml');
    this.binDir = path.join(this.dir, 'bin');
    const tag = frpPlatformTag();
    this.frpTag = tag; // null = 当前平台无 frpc 官方产物（如 32 位）
    this.binPath = path.join(this.binDir, tag ? (tag.exe ? 'frpc.exe' : 'frpc') : 'frpc');
    this.child = null;
    this.logTail = [];
    // 兜底重启（2026-09 修复）：frpc 非预期退出（崩溃/配置错误/OOM）时自动重拉，
    // 与系统其余守护语义一致。loginFailExit=false 已覆盖网络类失败，此处防其余崩溃。
    this._lastCount = 0;      // 最近一次生成的 [[proxies]] 数（决定是否值得重启）
    this._restartTimer = null;
    this._restartAttempts = 0;
    this._intentionalStop = false;
    this._hardenPermissions(); // 历史遗留文件权限加固（见方法说明）
  }

  /** 敏感文件权限加固（2026-09 修复）：`frpc.toml` 含 auth.token 明文、`frp.json` 同含 token。
   *  新写入已用 0600，但**历史遗留文件**可能是早期版本以默认 umask 写出的 0644/0664——
   *  同机其他用户可读（实证：生产 frpc.toml 为 664 且含 49 字符 token）。
   *  此处启动时对两个文件各加固一次（Unix chmod 0600 / Windows icacls，复用平台层）。 */
  _hardenPermissions() {
    try {
      const fp = require('../../platform/os/index').fileProtect;
      for (const f of [this.settingsFile, this.configFile]) {
        try { if (fs.existsSync(f)) fp.protectFile(f); } catch {}
      }
    } catch { /* 平台层不可用时忽略（不阻断 frp 功能） */ }
  }

  /* ── 设置持久化 ── */
  loadSettings() {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return {
        enabled: !!s.enabled,
        serverAddr: String(s.serverAddr || ''),
        serverPort: Number(s.serverPort) || 7000,
        authToken: String(s.authToken || ''),
        user: String(s.user || 'dsh'),
      };
    } catch {}
    return { enabled: false, serverAddr: '', serverPort: 7000, authToken: '', user: 'dsh' };
  }

  saveSettings(s) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.settingsFile);
    try { fs.chmodSync(this.settingsFile, 0o600); } catch {}
  }

  /* ── 状态 ── */
  status() {
    return {
      installed: fs.existsSync(this.binPath),
      running: !!(this.child && this.child.pid),
      pid: this.child ? this.child.pid : null,
      settings: this.loadSettings(),
      logTail: this.logTail.slice(-20),
    };
  }

  /* ── 配置生成：instances 里开启 frpEnabled 的映射到远程端口 ── */
  buildConfig(settings, instances) {
    const lines = [];
    lines.push('serverAddr = "' + (settings.serverAddr || '').replace(/"/g, '') + '"');
    lines.push('serverPort = ' + (Number(settings.serverPort) || 7000));
    if (settings.authToken) lines.push('auth.token = "' + String(settings.authToken).replace(/"/g, '') + '"');
    // 健壮性（2026-09 修复）：frpc 默认 loginFailExit=true —— 首次连不上 frps（对端重启/网络抖动/端口未开）
    // 即**退出且不重试**，隧道就此永久失效（除非再次触发 syncFrpc）。置 false → frpc 自身持续重连，
    // 这是 frp 原生的自愈机制（实测：server 不可达时进程保持存活并每 2s 重试）。
    lines.push('loginFailExit = false');
    lines.push('');
    let count = 0;
    for (const inst of instances || []) {
      // 2026-09 修复：除 frpEnabled/frpRemotePort 外必须校验 wanPort——wanPort 尚未分配（relay
      // 未 claim 到槽位）时原实现写出 localPort=null 的无效 [[proxies]]，frpc 启动即解析失败。
      if (!inst.frpEnabled || !inst.frpRemotePort || !Number.isInteger(inst.wanPort) || inst.wanPort <= 0) continue;
      const name = (settings.user || 'dsh') + '-lan-' + String(inst.id).slice(-8);
      lines.push('[[proxies]]');
      lines.push('name = "' + name.replace(/"/g, '') + '"');
      lines.push('type = "tcp"');
      lines.push('localIP = "127.0.0.1"');
      lines.push('localPort = ' + inst.wanPort);
      lines.push('remotePort = ' + inst.frpRemotePort);
      lines.push('');
      count++;
    }
    return { text: lines.join('\n'), count };
  }

  /** 由守卫在实例变化时调用：重写配置并在运行中时平滑重启 */
  syncFromInstances(instances) {
    const settings = this.loadSettings();
    const { text, count } = this.buildConfig(settings, instances);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.configFile + '.tmp';
    // frpc.toml 含 auth.token 明文：与 frp.json 同级 0600（原实现默认 umask → 同机他用户可读）。
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, this.configFile);
    this._lastCount = count; // 供兜底重启判定「是否还有代理值得拉起」
    if (!settings.enabled || count === 0) {
      this.stop();
      return { ok: true, proxies: count, running: false };
    }
    if (!fs.existsSync(this.binPath)) {
      // 未安装：不阻塞，状态里提示需安装
      return { ok: false, error: 'frpc not installed', needInstall: true, proxies: count };
    }
    return this.restart();
  }

  restart() {
    this.stop();
    return this.start();
  }

  start() {
    if (this.child && this.child.pid) return { ok: true, already: true, pid: this.child.pid };
    this._intentionalStop = false; // 显式启动：清除主动停止标记
    // 稳定运行 60s → 重置重试计数（避免「历史累计 5 次」把后续正常重启永久锁死）
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => { this._restartAttempts = 0; }, 60000);
    if (this._stableTimer.unref) this._stableTimer.unref();
    // 先清理守卫重启后可能残留的孤儿 frpc（防双实例注册同名代理）
    this._cleanupOrphans();
    if (!fs.existsSync(this.binPath)) return { ok: false, error: 'frpc binary missing', needInstall: true };
    try { fs.accessSync(this.configFile, fs.constants.R_OK); } catch { return { ok: false, error: 'no config generated yet' }; }
    const child = spawn(this.binPath, ['-c', this.configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const pushLog = (line) => {
      line = String(line).trim();
      if (!line) return;
      this.logTail.push(new Date().toISOString().slice(11, 19) + ' ' + line);
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
    };
    child.stdout.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.stderr.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.on('exit', (code) => {
      pushLog('[exited code=' + code + ']');
      if (this.child === child) this.child = null;
      // 兜底重启：非我们主动 stop、且配置仍应运行时，按退避重拉（最多 5 次，封顶 60s）。
      if (!this._intentionalStop) this._scheduleRestart();
    });
    if (this.events) this.events.append('frpc_started', { pid: child.pid });
    this.logger.info && this.logger.info('frpc started pid=' + child.pid);
    return { ok: true, pid: child.pid };
  }

  /** 非预期退出后的有界退避重启（防 frpc 崩溃/配置类错误导致隧道长期失效）。 */
  _scheduleRestart() {
    if (this._restartTimer) return;
    const settings = this.loadSettings();
    if (!settings.enabled || !this._lastCount) return; // 已停用或无代理：不重启
    if (this._restartAttempts >= 5) {
      if (this.events) this.events.append('frpc_restart_gaveup', { attempts: this._restartAttempts });
      this.logger.warn && this.logger.warn('[frpc] 连续重启 ' + this._restartAttempts + ' 次仍失败，停止重试（等待下次配置变更触发）');
      return;
    }
    const delay = Math.min(60000, 2000 * Math.pow(2, this._restartAttempts));
    this._restartAttempts += 1;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.logger.warn && this.logger.warn('[frpc] 非预期退出 → ' + Math.round(delay / 1000) + 's 后重启（第 ' + this._restartAttempts + ' 次）');
      try { this.start(); } catch (e) { this.logger.warn && this.logger.warn('[frpc] 重启失败: ' + (e && e.message)); }
    }, delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  stop() {
    this._intentionalStop = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (!this.child) {
      // 本守卫无句柄：可能是守卫重启产生的孤儿 frpc → 按配置特征清理
      const killed = this._cleanupOrphans();
      // 只在确实清理到孤儿时才发停止事件；本就未运行且无孤儿 → 不发
      // （此前每次 syncFromInstances 同步都调 stop() → 无句柄也发 frpc_stopped 刷屏 210+ 条）
      if (killed > 0 && this.events) this.events.append('frpc_stopped', {});
      return { ok: true, already: true };
    }
    const c = this.child;
    this.child = null;
    try { c.kill('SIGTERM'); } catch {}
    // SIGKILL 兜底必须用 exit 事件判定：child.killed 在 kill() 调用后立即为 true（表示已发信号而非已退出），
    // 旧实现 `if (!c.killed)` 永远不触发，忽略 SIGTERM 的 frpc 会永久存活。
    const start = Date.now();
    const guard = setInterval(() => {
      if (c.exitCode !== null) { clearInterval(guard); return; }
      if (Date.now() - start > 3000) {
        clearInterval(guard);
        try { c.kill('SIGKILL'); } catch {}
      }
    }, 250);
    if (this.events) this.events.append('frpc_stopped', {});
    return { ok: true };
  }

  /** 跨平台「按 cmdline 特征找进程」：返回 [{pid, cmdline}]。
   *  - Linux/mac：pgrep -af <pat>
   *  - Windows：wmic process（含 CommandLine）；wmic 弃用时回退 PowerShell CIM
   *  @returns {Array<{pid:number, cmdline:string}>} */
  _findProcessesByCmd(pat) {
    // 跨平台审计 §7.1：统一走平台层 pidlookup.pgrepList —— 它已实现三端语义
    // （Linux pgrep -af / macOS pgrep -f + ps / Windows CIM Win32_Process），
    // 域层不再自行拼 wmic/powershell（原 Windows 分支与 pgrepList 重复，且属分层违规）。
    try {
      const pidlook = require('../../platform/os/pidlookup');
      return pidlook.pgrepList(pat).map((m) => ({ pid: m.pid, cmdline: m.cmdline }));
    } catch { return []; }
  }

  /** 清理非本守卫托管的残留 frpc（cmdline 含本项目配置文件的孤儿进程），防守卫重启后双实例。
   *  @returns {number} 实际清理（发送 SIGTERM）的孤儿进程数 */
  _cleanupOrphans() {
    let killed = 0;
    const procs = this._findProcessesByCmd('frpc');
    for (const p of procs) {
      if (!String(p.cmdline || '').includes(this.configFile)) continue;
      if (p.pid === process.pid) continue;
      try { process.kill(p.pid, 'SIGTERM'); killed++; } catch {}
      if (this.logger && this.logger.warn) this.logger.warn('killed orphan frpc pid=' + p.pid);
    }
    return killed;
  }

  /* ── 安装：从镜像/GitHub 下载 frpc 并解压（按当前平台拉对应产物）── */
  async install(onProgress) {
    fs.mkdirSync(this.binDir, { recursive: true });
    // 安装进度只走 onProgress（前端可实时展示），不写入 logTail——
    // logTail 仅承载运行期 frpc stdout（否则安装完成日志永久残留、前端一直显示）。
    const report = (msg) => { if (onProgress) try { onProgress(msg); } catch {} };
    if (!this.frpTag) {
      if (this.events) this.events.append('frpc_install_failed', { detail: '当前平台无 frpc 官方产物: ' + process.platform + '/' + process.arch });
      return { ok: false, error: '当前平台不支持 FRP（' + process.platform + '/' + process.arch + '），仅 linux/darwin/win32 × x64/arm64' };
    }
    const urls = downloadUrls('frp_' + FRP_VERSION + '_' + this.frpTag.tag + '.tar.gz');
    let lastErr = null;
    for (const url of urls) {
      try {
        report('download: ' + url.slice(0, 60) + '…');
        const tgz = await this._download(url, report);
        report('downloaded ' + Math.round(tgz.length / 1024) + 'KB, extracting…');
        await this._extractFrpc(tgz, this.binDir);
        fs.chmodSync(this.binPath, 0o755);
        report('installed: ' + this.binPath);
        if (this.events) this.events.append('frpc_installed', {});
        return { ok: true, binPath: this.binPath };
      } catch (e) {
        lastErr = e;
        report('failed: ' + e.message + ', trying next mirror…');
      }
    }
    if (this.events) this.events.append('frpc_install_failed', { detail: lastErr ? lastErr.message : '' });
    return { ok: false, error: lastErr ? lastErr.message : 'all mirrors failed' };
  }

  _download(url, report) {
    return new Promise((resolve, reject) => {
      const get = (u, redirectsLeft) => {
        const mod = u.startsWith('https:') ? https : http;
        const req = mod.get(u, { headers: { 'User-Agent': 'dsh-supervisor' }, timeout: 60000 }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return get(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
          const total = Number(res.headers['content-length']) || 0;
          const chunks = [];
          let got = 0;
          res.on('data', (c) => { chunks.push(c); got += c.length; if (total && report) report('progress ' + Math.round(got / total * 100) + '%'); });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
      };
      get(url, 5);
    });
  }

  /** 从 tar.gz 提取 frpc 二进制（纯 Node 实现 gzip+tar 解析）*/
  async _extractFrpc(tgzBuf, destDir) {
    const zlib = require('node:zlib');
    const tarData = await new Promise((resolve, reject) => {
      zlib.gunzip(tgzBuf, (e, d) => e ? reject(e) : resolve(d));
    });
    // tar 解析：512字节头
    let offset = 0;
    while (offset + 512 <= tarData.length) {
      const header = tarData.slice(offset, offset + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.slice(0, 100).toString('utf8').split('\0')[0];
      const sizeStr = header.slice(124, 136).toString('utf8').replace(/[\0 ]/g, '');
      const size = parseInt(sizeStr, 8) || 0;
      const typeFlag = String.fromCharCode(header[156] || 48);
      const dataStart = offset + 512;
      // 平台化：Windows 官方产物内二进制为 frpc.exe；其余平台 frpc。
      const exe = !!(this.frpTag && this.frpTag.exe);
      const wantName = exe ? 'frpc.exe' : 'frpc';
      if ((name.endsWith('/' + wantName) || name === wantName) && (typeFlag === '0' || typeFlag === '\0')) {
        const data = tarData.slice(dataStart, dataStart + size);
        fs.writeFileSync(path.join(destDir, wantName), data);
      }
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
    if (!fs.existsSync(this.binPath)) throw new Error('frpc not found in archive (' + (this.frpTag ? this.frpTag.tag : 'unsupported') + ')');
  }

}

module.exports = { FrpManager, frpPlatformTag, downloadUrls };
