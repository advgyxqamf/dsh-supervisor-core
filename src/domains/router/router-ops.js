'use strict';

// 辅助能力（适配新 provider 结构）：OAuth 登录 / 反代应用更新 / 官方配额与价格同步。
// 以 RouterService 方法集形式混入（this 绑定 RouterService）。

const ports = require('../../guard/lifecycle/ports').shared;
const { PROXY_APPS } = require('./proxy-apps');
const { semverCompare } = require('../dist/index');

/**
 * 防风控调起浏览器（OAuth 一键登录专用）——审计后最强方案。
 *
 * 审计结论（两轮）：
 *  第一轮：仅「无痕 + 随机 profile」只隔离持久数据，UA/屏幕/时区/语言等环境指纹不变，需增强；
 *  第二轮（实测修正）：随机 UA 与浏览器真实 TLS 指纹（JA3/JA4）不匹配——
 *  Cloudflare/Turnstile 检测到「UA 声称系统 A、TLS 指纹却是系统 B」→ 验证不可用
 *  （Verification unavailable / disable your content blocker）。
 *  因此移除 UA 伪造（真实 UA 与 TLS 指纹一致才不会被风控检测标记）。
 *
 * 最终方案（防关联 + 不触发风控检测）：
 *  - --incognito + --user-data-dir=<随机临时 profile>：持久数据完全隔离；
 *  - --window-size=<随机宽x高>：屏幕指纹随机化（不影响验证码）；
 *  - --lang=<随机> + LANG/TZ 环境变量：语言 / 时区指纹随机化（不影响验证码）；
 *  - 30 分钟兜底清理 + 登录完成后 60s 及时清理（见 commandcodeLoginWait）。
 *
 * 已知边界（纯命令行无法覆盖，如实说明）：
 *  - Canvas/WebGL 指纹受硬件限制，无痕/profile 隔离不能改变（需浏览器自动化注入，超出零依赖约束）；
 *  - 出口 IP 不变（同一 NAT），IP 维度关联需代理方案，不在本工具范围；
 *  - UA 不伪造（保持真实浏览器，避免 TLS 指纹不匹配触发风控验证）。
 *
 * @param {function} [onExit] 浏览器进程退出回调（用户关闭浏览器 → 调用方取消登录、复位状态）。
 * @returns {string|null} 成功返回临时 profile 路径（供登录后及时清理）；失败返回 null。
 */
/**
 * 图形会话环境注入（修复：systemd user 常驻守卫拉起浏览器失败）。
 *
 * 背景：守卫若由 systemd --user 启动，进程环境不含 DISPLAY/WAYLAND_DISPLAY 等图形变量，
 * 此时 spawn microsoft-edge/chrome/xdg-open 连不上显示服务器 → 主进程秒退、只剩 crashpad 孤儿，
 * 一键登录“不弹浏览器”。而守卫又必须常驻（重启/自启后仍在桌面会话之外）。
 *
 * 做法：进程环境缺图形变量时，从用户会话常见落点探测并注入：
 *  - X11：    /tmp/.X11-unix/X<n> → DISPLAY=:<n>（优先取编号最小的可用 socket）
 *  - Wayland：$XDG_RUNTIME_DIR/wayland-* → WAYLAND_DISPLAY
 *  - XAUTHORITY=~/.Xauthority（X11 认证）；DBUS_SESSION_BUS_ADDRESS=$XDG_RUNTIME_DIR/bus
 * 进程环境已含图形变量（桌面内直接拉起）→ 返回 {} 零开销；注入值绝不覆盖进程已有值。
 */
function graphicalEnv() {
  const out = {};
  try {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const uid = process.getuid ? String(process.getuid()) : '';
    const xdgRun = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      const x11 = '/tmp/.X11-unix';
      try {
        if (fs.existsSync(x11)) {
          const socks = fs.readdirSync(x11).filter((f) => /^X\d+$/.test(f)).map((f) => parseInt(f.slice(1), 10)).sort((a, b) => a - b);
          if (socks.length > 0) {
            out.DISPLAY = ':' + socks[0];
            const xauth = path.join(os.homedir(), '.Xauthority');
            if (fs.existsSync(xauth)) out.XAUTHORITY = xauth;
          }
        }
      } catch {}
      if (!out.DISPLAY) {
        try {
          if (fs.existsSync(xdgRun)) {
            const wl = fs.readdirSync(xdgRun).filter((f) => f.startsWith('wayland-')).sort();
            if (wl.length > 0) out.WAYLAND_DISPLAY = wl[0];
          }
        } catch {}
      }
    }
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(path.join(xdgRun, 'bus'))) {
      out.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + path.join(xdgRun, 'bus');
    }
  } catch {}
  return out;
}

function openInBrowser(url, onExit) {
  try {
    const crypto = require('node:crypto');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const tmpProfile = path.join(os.tmpdir(), 'dsh-oauth-' + crypto.randomBytes(8).toString('hex'));
    // 图形变量注入：守卫在 systemd 无桌面环境下也能拉起浏览器（无显示时注入为 {}）
    const sysEnv = Object.assign({}, process.env, graphicalEnv());

    // 环境指纹随机池（每次登录随机组合；不含 UA——UA 必须保持真实，
    // 否则与 TLS 指纹不匹配会被 Cloudflare/Turnstile 判为异常环境，验证不可用）
    const TZ_POOL = ['Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
    const LANG_POOL = ['zh-CN', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'zh-TW'];
    const SIZE_POOL = [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1680, 1050], [1920, 1080], [1024, 768], [1152, 864], [1280, 720]];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const [w, h] = pick(SIZE_POOL);
    const lang = pick(LANG_POOL);
    const tz = pick(TZ_POOL);
    const antiArgs = [
      '--incognito',
      '--user-data-dir=' + tmpProfile,
      '--window-size=' + w + ',' + h,
      '--lang=' + lang,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      url,
    ];
    const antiEnv = Object.assign({}, sysEnv, { TZ: tz, LANG: lang });

    if (process.platform === 'darwin') {
      const p = spawn('open', ['-na', 'Google Chrome', '--args', ...antiArgs], { detached: true, stdio: 'ignore', env: antiEnv });
      p.on('error', () => {});
      p.unref();
      setTimeout(() => { try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 30 * 60 * 1000);
      return tmpProfile;
    }
    if (process.platform === 'win32') {
      // cmd start 对复杂参数转义脆弱：仅传 incognito + 独立 profile
      const p = spawn('cmd', ['/c', 'start', '', 'chrome', '--incognito', '--user-data-dir=' + tmpProfile, url], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
      setTimeout(() => { try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 30 * 60 * 1000);
      return tmpProfile;
    }
    // Linux：候选按「防风控强度 + 可用性」排序：Edge（本机默认）→ Chrome → Chromium → Firefox 无痕 → xdg-open 兜底
    const candidates = [
      { bin: 'microsoft-edge', args: antiArgs, env: antiEnv },
      { bin: 'microsoft-edge-stable', args: antiArgs, env: antiEnv },
      { bin: 'google-chrome', args: antiArgs, env: antiEnv },
      { bin: 'chromium', args: antiArgs, env: antiEnv },
      { bin: 'chromium-browser', args: antiArgs, env: antiEnv },
      { bin: 'firefox', args: ['--private-window', url], env: sysEnv },
      { bin: 'xdg-open', args: [url], env: sysEnv }, // 兜底：普通浏览器（无隔离，最后手段）
    ];
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return null;
      const c = candidates[idx++];
      let child;
      try { child = spawn(c.bin, c.args, { detached: true, stdio: 'ignore', env: c.env || sysEnv }); }
      catch { return tryNext(); }
      child.on('error', () => { tryNext(); }); // bin 不存在 → 下一个候选
      // 浏览器主进程退出监测：用户关闭浏览器 → 通知调用方取消登录（防 loginWait 干等超时）
      if (c.bin !== 'xdg-open') {
        child.on('exit', () => { if (typeof onExit === 'function') { try { onExit(); } catch {} } });
      }
      child.unref();
      if (c.bin !== 'xdg-open' && c.bin !== 'firefox') {
        // 兜底清理（30min；登录完成后的及时清理由 commandcodeLoginWait 执行）
        setTimeout(() => { try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 30 * 60 * 1000);
      }
      return tmpProfile; // 返回 profile 路径（登录完成后及时清理）
    };
    return tryNext();
  } catch { return null; }
}

const auxMethods = {
  /* ---- Command Code OAuth 一键登录 ---- */
  async commandcodeLoginStart() {
    const { createServer } = require('node:http');
    const crypto = require('node:crypto');
    const STUDIO_BASE = 'https://commandcode.ai';
    const state = crypto.randomBytes(32).toString('base64url');
    if (this._ccLogin && this._ccLogin.server) {
      const oldState = this._ccLogin.state;
      try { this._ccLogin.server.close(); } catch {}
      if (oldState) { try { ports.unregister('oauth:' + oldState); } catch {} } // 释放旧登录端口
      this._ccLogin = null;
    }
    // 兜底：若上一轮登录 promise 仍 pending（如上次超时/浏览器关闭未及时复位），先取消之
    if (this._ccLoginReject) { try { this._ccLoginReject(new Error('登录已取消（重新发起）')); } catch {} }
    this._ccLoginPromise = null;
    this._ccLoginResolve = null;
    this._ccLoginReject = null;
    let port = null;
    let server = null;
    let base = await ports.allocate('oauthCallback', 'oauth:' + state);
    for (let i = 0; i < 5 && !server && base !== null; i++) {
      port = base + i;
      try {
        const callbackJson = (obj) => JSON.stringify(obj);
        const corsOrigin = (origin) => { const allowed = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai']; return allowed.includes(origin) ? origin : allowed[0]; };
        const s = createServer((req, res) => {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin(req.headers.origin));
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
          // 回调路径按 pathname 匹配（兼容合法回调携带 ?state=… / #… 等 query/片段）；
          // 旧实现 req.url !== '/callback' 会把带参回调误判 404（本地回环服务器，必要防御保留）
          const cbPath = String(req.url || '').split('?')[0].split('#')[0];
          if (cbPath !== '/callback') { res.writeHead(404); res.end(callbackJson({ success: false, error: 'Not found' })); return; }
          if (req.method !== 'POST') { res.writeHead(405); res.end(callbackJson({ success: false, error: 'Method not allowed. Use POST.' })); return; }
          let b = '';
          req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
          req.on('end', () => {
            try {
              const j = JSON.parse(b || '{}');
              if (j && typeof j === 'object' && 'error' in j) {
                res.writeHead(200); res.end(callbackJson({ success: true }));
                if (this._ccLoginReject) { this._ccLoginReject(new Error(j.error_description || j.error || 'Authorization denied')); this._ccLoginReject = null; }
                return;
              }
              const valid = j && typeof j.apiKey === 'string' && typeof j.state === 'string' && typeof j.userId === 'string' && typeof j.userName === 'string' && typeof j.keyName === 'string';
              if (!valid) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Missing required fields' })); return; }
              if (j.state !== state) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Invalid state parameter' })); if (this._ccLoginReject) { this._ccLoginReject(new Error('Invalid state parameter')); this._ccLoginReject = null; } return; }
              res.writeHead(200); res.end(callbackJson({ success: true }));
              if (this._ccLoginResolve) { this._ccLoginResolve({ apiKey: j.apiKey, userId: j.userId, userName: j.userName, keyName: j.keyName }); this._ccLoginResolve = null; }
            } catch (e) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'bad request' })); }
          });
        });
        await new Promise((resolve, reject) => {
          const onErr = (err) => { try { s.removeListener('listening', onOk); } catch {}; reject(err); };
          const onOk = () => { try { s.removeListener('error', onErr); } catch {}; resolve(); };
          s.once('error', onErr);
          s.once('listening', onOk);
          s.listen(port, '127.0.0.1');
        });
        server = s;
      } catch {}
    }
    if (!server) return { ok: false, error: '无法启动本地回调端口（oauthCallback 段已满）' };
    const callbackUrl = 'http://localhost:' + port + '/callback';
    const authUrl = STUDIO_BASE + '/studio/auth/cli?callback=' + encodeURIComponent(callbackUrl) + '&state=' + encodeURIComponent(state);
    // 先建立登录 promise（浏览器 exit 回调需要 Resolve/Reject 就绪）
    const promise = new Promise((resolve, reject) => { this._ccLoginResolve = resolve; this._ccLoginReject = reject; });
    this._ccLoginPromise = promise;
    // 调起浏览器并监测其进程退出：浏览器被关闭 → 立即取消登录（而非干等 180s 超时），
    // 前端随即收到「浏览器已关闭」，按钮恢复，可重新发起一键登录。
    const tmpProfile = openInBrowser(authUrl, () => {
      if (this._ccLoginReject) {
        const r = this._ccLoginReject;
        this._ccLoginReject = null;
        this._ccLoginResolve = null;
        try { r(new Error('浏览器已关闭，登录已取消')); } catch {}
      }
    });
    if (!tmpProfile) {
      // 无可用浏览器：清理回调服务与 promise，明确报错（附手动打开链接）
      this._ccLoginPromise = null;
      this._ccLoginResolve = null;
      this._ccLoginReject = null;
      try { server.close(); } catch {}
      try { ports.unregister('oauth:' + state); } catch {} // 释放本轮登录端口
      this._ccLogin = null;
      return { ok: false, error: '无法调起浏览器（未找到可用浏览器），请手动打开: ' + authUrl };
    }
    this._ccLogin = { state, port, server, tmpProfile };
    return { ok: true, authUrl, state, port, waitMs: 180000 };
  },

  async commandcodeLoginWait(timeoutMs) {
    const p = this._ccLoginPromise;
    if (!p) return { ok: false, error: '未在登录中' };
    // 提前保存临时 profile（后续 _ccLogin 会被置 null，finally 需要它做清理）
    const tmpProfile = this._ccLogin ? this._ccLogin.tmpProfile : null;
    const timeout = timeoutMs || 180000;
    try {
      const cred = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('登录超时')), timeout))]);
      if (this._ccLogin && this._ccLogin.server) { const s = this._ccLogin.state; try { this._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } this._ccLogin = null; }
      this._ccLoginPromise = null;
      this._ccLoginResolve = this._ccLoginReject = null;
      return { ok: true, apiKey: cred && cred.apiKey, userId: cred && cred.userId, userName: cred && cred.userName, keyName: cred && cred.keyName };
    } catch (e) {
      if (this._ccLogin && this._ccLogin.server) { const s = this._ccLogin.state; try { this._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } this._ccLogin = null; }
      this._ccLoginPromise = null;
      return { ok: false, error: e.message };
    } finally {
      // 登录结束（成功/失败/超时）：60s 后清理本次登录的临时 profile（浏览器可能仍开着，延迟清理）
      if (tmpProfile) {
        setTimeout(() => { try { require('node:fs').rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 60 * 1000);
      }
    }
  },

  /* ---- 反代应用注册表与更新 ---- */
  proxyApps() {
    return Object.values(PROXY_APPS).map((a) => {
      const c = this.proxyUpdateCache[a.id] || {};
      // 实例已装版本：取所有该 app 实例探活到的最高版本（semver 比较，非字符串）
      const instVers = [];
      for (const p of this.providers || []) {
        if (p.kind === 'proxy' && p.proxyAppId === a.id) {
          for (const inst of (p.instances || [])) if (inst.version) instVers.push(inst.version);
        }
      }
      let installed = null;
      for (const v of instVers) if (!installed || semverCompare(v, installed) > 0) installed = v;
      // 更新判断：semver 严格比较（修复字符串比较误判 0.10.0<0.3.1 等）
      const updateAvailable = !!(c.latest && installed && semverCompare(c.latest, installed) > 0);
      return { id: a.id, name: a.name, pkg: a.pkg, healthPath: a.healthPath, modelPath: a.modelPath, real: !!a.real, upstream: a.upstream, repo: a.repo, registry: a.registry || null, latest: c.latest || null, installed: installed || null, updateAvailable, checkedAt: c.checkedAt || null, error: c.error || null };
    });
  },

  async refreshProxyUpdateInfo(force) {
    const results = {};
    for (const a of Object.values(PROXY_APPS)) {
      if (!a.registry) { results[a.id] = null; continue; }
      const cache = this.proxyUpdateCache[a.id] || {};
      const now = Date.now();
      if (!force && cache.latest && cache.checkedAt && (now - cache.checkedAt) < (a.versionRefreshMs || 6 * 3600 * 1000)) { results[a.id] = cache.latest; continue; }
      let ver = null;
      try { if (this.dist) ver = await this.dist.fetchNpmLatest(a.registry); } catch {}
      const prev = cache.latest || null;
      this.proxyUpdateCache[a.id] = { pkg: a.registry, latest: ver, checkedAt: Date.now(), error: ver ? null : 'query failed' };
      // 仅当存在旧基线且版本真实变化才发事件：prev=null（守卫重启后缓存冷启动首查）
      // 不视为「新版本」（此前每次守卫重启都误报一条 from:null→latest 的假更新）
      if (ver && prev && ver !== prev && this.events) this.events.append('proxy_update_available', { appId: a.id, pkg: a.registry, from: prev, to: ver });
      results[a.id] = ver;
    }
    return results;
  },

  /** 反代更新（job 模型，有状态跟踪）：立即返回 jobId，异步执行 stop→start 各实例，
   *  前端经 proxyUpdateStatus(appId) 轮询进度——消除「黑盒等待」。
   *  job = { state: running|done|failed, steps: [{name, state, ts}], restarted, errors, startedAt, finishedAt } */
  async applyProxyUpdate(appId) {
    const a = PROXY_APPS[appId];
    if (!a) return { ok: false, error: 'unknown app ' + appId };
    const targets = this.providers.filter((p) => p.kind === 'proxy' && p.proxyAppId === appId && (p.instances || []).length);
    if (!targets.length) return { ok: false, error: 'no running ' + a.name + ' instances' };
    // 并发去重：同一 app 更新中则复用
    if (this._proxyUpdateJobs && this._proxyUpdateJobs[appId] && this._proxyUpdateJobs[appId].state === 'running') {
      return { ok: true, jobId: appId, already: true };
    }
    const insts = targets.flatMap((provider) => (provider.instances || []).map((i) => ({ provider, inst: i })));
    const job = {
      state: 'running', startedAt: Date.now(), finishedAt: null, restarted: 0, errors: 0,
      steps: insts.map(({ inst }) => ({ name: inst.maskedKey, state: 'pending', ts: null })),
    };
    this._proxyUpdateJobs = this._proxyUpdateJobs || {};
    this._proxyUpdateJobs[appId] = job;
    // 统一任务：proxy-app/update
    let task = null;
    if (this.tasks) {
      task = this.tasks.begin('proxy-app', 'update', { id: appId, name: a.name }, { to: a.registry, createdBy: 'user' });
      this.tasks.start(task.id);
      this.tasks.log(task.id, '更新 ' + a.name + '（' + a.registry + '）');
      job.taskId = task.id;
    }
    (async () => {
      // 0) 清除该 app 的 npx 缓存——强制重新拉取最新版（否则 startInstance 用旧缓存版本，更新无效）
      try {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const npxDir = path.join(os.homedir(), '.npm', '_npx');
        if (fs.existsSync(npxDir)) {
          for (const d of fs.readdirSync(npxDir)) {
            if (!/^[0-9a-f]{8,}$/i.test(d)) continue;
            const pkgDir = path.join(npxDir, d, 'node_modules', a.pkg);
            if (fs.existsSync(pkgDir)) {
              try { fs.rmSync(path.join(npxDir, d), { recursive: true, force: true }); } catch {}
            }
          }
        }
        // 同步清 ProxyProvider 的缓存定位（其 _cachedPkgBin 读磁盘，删除后自然失效）
      } catch {}
      // 1) 停止全部实例
      for (let i = 0; i < insts.length; i++) {
        const { provider, inst } = insts[i];
        job.steps[i].state = 'stopping'; job.steps[i].ts = Date.now();
        try { provider.stopInstance(inst); } catch (e) { job.errors++; job.steps[i].state = 'failed'; }
      }
      await new Promise((r) => setTimeout(r, 600));
      // 2) 逐个启动
      for (let i = 0; i < insts.length; i++) {
        const { provider, inst } = insts[i];
        if (!inst.key) { job.errors++; job.steps[i].state = 'failed'; continue; }
        job.steps[i].state = 'starting'; job.steps[i].ts = Date.now();
        const r = await provider.startInstance(inst);
        if (r.ok) {
          job.restarted++;
          // 探活拿新版本（刷新 version，避免前端显示旧版本误报「需更新」）
          await provider._waitHealthy(inst).catch(() => false);
          job.steps[i].state = 'done';
        }
        else { job.errors++; job.steps[i].state = 'failed'; }
      }
      for (const provider of targets) provider.proxyRunning = true;
      this._save();
      job.state = job.errors === 0 ? 'done' : 'failed';
      job.finishedAt = Date.now();
      if (this.events) this.events.append('proxy_update_applied', { appId, restarted: job.restarted, errors: job.errors });
      this.proxyUpdateCache[appId] = Object.assign({}, this.proxyUpdateCache[appId], { appliedAt: Date.now() });
      if (task && this.tasks) {
        if (job.state === 'done') { this.tasks.log(task.id, '更新完成，重启 ' + job.restarted + ' 个实例'); this.tasks.succeed(task.id); }
        else this.tasks.fail(task.id, '更新失败（' + job.errors + ' 个实例错误）');
      }
    })().catch((e) => {
      // 兜底：意外 rejection 不得让 job 永卡 running（否则该 app 后续更新被并发去重永久挡死）
      job.state = 'failed'; job.finishedAt = Date.now(); job.errors++;
      if (this.logger && this.logger.warn) this.logger.warn('applyProxyUpdate 异常: ' + e.message);
      if (task && this.tasks) this.tasks.fail(task.id, '更新异常: ' + (e && e.message));
    });
    return { ok: true, jobId: appId };
  },

  /** 反代更新进度查询（前端轮询；兼容视图，优先读统一任务）。
   *  优先返回该 appId 最近一次任务（含已完成），保证前端完成态可见；
   *  无历史任务时回退 _proxyUpdateJobs。 */
  proxyUpdateStatus(appId) {
    const t = this.tasks ? this.tasks.list('proxy-app').find((x) => x.target.id === appId) : null;
    if (t) {
      return {
        // 任务状态→前端契约映射：前端判定 done/failed（succeeded/skipped→done，failed/canceled→failed）
        state: (t.state === 'succeeded' || t.state === 'skipped') ? 'done' : (t.state === 'failed' || t.state === 'canceled') ? 'failed' : 'running',
        restarted: (t.steps.filter((s) => s.state === 'done')).length,
        errors: t.state === 'failed' ? 1 : 0,
        startedAt: t.startedAt, finishedAt: t.finishedAt,
        steps: t.steps.map((s) => ({ name: s.name, state: s.state })),
        taskId: t.id,
      };
    }
    const job = this._proxyUpdateJobs && this._proxyUpdateJobs[appId];
    if (!job) return { error: 'no update job for ' + appId };
    return {
      state: job.state, restarted: job.restarted, errors: job.errors,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      steps: job.steps.map((s) => ({ name: s.name, state: s.state })),
    };
  },

  /* ---- 官方配额与价格同步（直连供应商）---- */
  async refreshOfficialUsageAll() {
    for (const p of this.providers) {
      if (p.kind !== 'direct') continue;
      for (const acc of p.accounts || []) {
        if (!acc.key) continue;
        try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {}
      }
    }
  },

  async refreshProviderQuota(providerId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (p.kind === 'direct') {
      for (const acc of p.accounts || []) { if (!acc.key) continue; try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {} }
    } else {
      for (const inst of p.instances || []) {
        try { const det = await p.detectInstanceQuota(inst); const acc = p.accountOf(inst); if (acc) p.applyDetection(acc, det); } catch {}
      }
    }
    this._save();
    if (this.events) this.events.append('provider_quota_refreshed', { provider: providerId });
    return { ok: true };
  },

  /* ---- 官方单价同步（models.dev）：直连供应商按 adapter.pricing 源抓权威单价 + 全局模型定价索引（反代模型计费）----
   *  反代供应商（如 Command Code 反代）暴露的模型均为官方模型（Claude/GPT 系）——
   *  按模型名从 models.dev 的 anthropic/openai 等索引精确取价，供费用估算。 */
  async refreshOfficialPricingAll() {
    const sources = new Map(); // 直连供应商的 models.dev provider
    for (const pr of this.providers) {
      if (pr.kind !== 'direct') continue;
      const ps = pr.adapter && pr.adapter.pricing;
      if (ps && ps.type === 'models-dev' && ps.provider) sources.set(ps.provider, ps.provider);
    }
    try {
      const j = await (await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })).json();
      // 直连：按 provider 抓官方价
      let directModels = 0;
      for (const provKey of sources.values()) {
        const go = j[provKey];
        const models = (go && go.models) ? go.models : (go || {});
        const pricing = {};
        for (const [mk, mv] of Object.entries(models)) {
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            pricing[mk] = { input: (c.input !== undefined) ? Number(c.input) : 0, output: (c.output !== undefined) ? Number(c.output) : 0, cache_read: (c.cache_read !== undefined) ? Number(c.cache_read) : 0 };
            directModels++;
          }
        }
        for (const pr of this.providers) {
          if (pr.kind !== 'direct') continue;
          const ps = pr.adapter && pr.adapter.pricing;
          if (ps && ps.type === 'models-dev' && ps.provider === provKey) pr.officialPricing = pricing;
        }
      }
      // 全局模型定价索引：全量抓取 models.dev 所有供应商（207 provider / 7482 模型）——
      // 反代/直连转发的任意官方模型（deepseek/claude/gpt 系）按模型名查价
      const index = {};
      for (const [provKey, go] of Object.entries(j || {})) {
        const models = (go && go.models) ? go.models : (go || {});
        for (const [mk, mv] of Object.entries(models)) {
          if (index[mk]) continue; // 已收录（首个命中为准）
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            const input = (c.input !== undefined) ? Number(c.input) : 0;
            const output = (c.output !== undefined) ? Number(c.output) : 0;
            if (input > 0 || output > 0) index[mk] = { input, output };
          }
        }
      }
      this.modelPriceIndex = index;
      this._save();
      return { ok: true, models: directModels, indexModels: Object.keys(index).length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  /* ---- 账号/供应商管理辅助 ---- */
  setProviderKeys(id, opts) {
    const p = this.getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    const rm = new Set((opts && opts.removeMasked) || []);
    const before = (p.accounts || []).length;
    p.accounts = (p.accounts || []).filter((a) => !rm.has(a.maskedKey));
    const removed = before - p.accounts.length;
    let added = 0;
    for (const k of (opts && opts.add) || []) {
      const t = String(k).trim();
      if (t && !p.accounts.some((a) => a.key === t)) {
        // 直连：直接注册（异步检测由前端触发）；反代：走 addAccount 启动检测
        p.addAccount(t).catch(() => {});
        added++;
      }
    }
    this._save();
    return { ok: true, keys: p.accounts.length, added, removed };
  },

  async setSelectedProxyKey(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const acc = (p.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return { ok: false, error: '账号不存在' };
    // 锁收敛（2026-09 A）：锁只对可用账号有意义——冻结/额度用尽账号拒绝锁定（防死锁落盘/UI 死锁徽标）
    if (acc.status !== 'ready' || (typeof p.isAccountUsable === 'function' && !p.isAccountUsable(acc))) {
      return { ok: false, error: '账号当前不可用（' + (acc.status === 'ready' ? '额度用尽' : acc.status) + '），无法锁定' };
    }
    // 记录原状态：激活失败时回滚（避免「提交后失败 → 坏账号粘滞 → 本供应商 429 循环」）
    const prevSelected = p.selectedAccountKeyId || null;
    // 账号选定是供应商内语义（独立端点按各自供应商账号池选号，无全局激活供应商概念）
    p.selectedAccountKeyId = keyId;
    this._save();
    // 切换即确保目标实例拉起（即时反馈，避免「切到未就绪实例 → 502 循环」）：
    // 实例未运行 → 异步激活；启动/探活失败 → 返回明确错误（不改选中，可换账号）
    if (p.kind === 'proxy' && acc.instance && !acc.instance.pid) {
      const sr = await p.startInstance(acc.instance).catch((e) => ({ ok: false, error: e && e.message }));
      const ok = sr && sr.ok;
      const healthy = ok ? await p._waitHealthy(acc.instance).catch(() => false) : false;
      if (!healthy) {
        if (acc.instance.pid) { try { p.stopInstance(acc.instance); } catch {} }
        // 回滚已提交的 selected（保持状态一致；文案同步为真实语义）
        p.selectedAccountKeyId = prevSelected;
        this._save();
        const errMsg = '实例启动失败（' + ((sr && sr.error) || '探活超时') + '），已取消切换并回滚';
        if (this.logger && this.logger.warn) this.logger.warn('[select] ' + errMsg + ' key=' + (acc.maskedKey || keyId) + ' sr=' + JSON.stringify(sr));
        return { ok: false, error: errMsg };
      }
    }
    return { ok: true, selected: keyId };
  },

  async switchToKey(providerId, keyId) {
    // 临时切换也确保实例拉起（激活失败 → 明确错误，避免 502 循环）
    return this.setSelectedProxyKey(providerId, keyId);
  },

  removeProxyKey(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const idx = (p.accounts || []).findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    if (p.kind === 'proxy' && p.accounts[idx].instance) {
      try { p.stopInstance(p.accounts[idx].instance); } catch {}
      // 删除账号：释放持久化端口绑定（registry 登记 + inst.port）
      try { ports.unregister('proxy:' + keyId); } catch {}
      p.accounts[idx].instance.port = null;
    }
    p.accounts.splice(idx, 1);
    if (p.kind === 'proxy') p.instances = (p.instances || []).filter((i) => i.keyId !== keyId);
    this._save();
    return { ok: true };
  },

  addProxyKey(providerId, key) {
    const p = this.getProvider(providerId);
    if (!p || p.kind !== 'proxy') return { ok: false, error: '供应商不存在或非反代' };
    return p.addAccount(key);
  },

  /* ---- review 账号人工裁决：入池 / 作废（状态前置原则的收口） ---- */
  confirmAccount(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    return p.confirmAccount(keyId);
  },

  discardAccount(providerId, keyId) {
    const p = this.getProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    return p.discardAccount(keyId);
  },
};

module.exports = { auxMethods };