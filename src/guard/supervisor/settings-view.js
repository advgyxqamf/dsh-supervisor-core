'use strict';

// §7.6 拆分自 supervisor.js：settings-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { EnvCatalog } = require('../../platform/env-catalog');
const { semverCompare } = require('../../domains/dist/index');
const deploy = require('../../platform/deploy'); // 拆分携带：自更新形态判定（deploy.detect）
const { guardVersion } = require('../../platform/version'); // 拆分携带：守卫版本自报

// 环境目录摘要（随设置块迁移；原为 supervisor.js 模块级函数，仅本块使用）。
function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  extra.selfUpdate = cat.selfUpdateEntry();
  return cat.summary(extra);
}

class SettingsView {
  autostartStatus() {
    return this.hostService.autostartStatus();
  }

  setAutostart(on) {
    return this.hostService.setAutostart(on);
  }

  // ---- 环境状态（Phase1 壳写 runtime.json；EnvCatalog 声明式探测）----
  envStatus() {
    const rt = {};
    try { const f = path.join(path.dirname(this.config.stateFile), 'runtime.json'); if (fs.existsSync(f)) Object.assign(rt, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
    const cat = new EnvCatalog(this.config).probe();
    const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function' ? this.nativeManager.checkEnvironment() : null;
    return {
      node: { detected: cat.node.detail || null, runtime: rt.nodeVersion || null, path: rt.nodePath || null },
      npm: { detected: cat.npm.detail || null },
      git: { detected: cat.git.detail || null },
      installedAt: rt.installedAt || null,
      source: rt.source || null,
      ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
      npmRoot: en ? en.npmRoot : null,
      // EnvCatalog 声明式视图（面板环境卡演进用）
      catalog: (envCatalogSummary(this)),
      // 平台能力矩阵（A1 断点修复）：三平台静态档位 × 实际工具探测。
      // 前端据此做能力感知呈现与降级提示（如 Windows/mac 不支持沙箱实例）——
      // 此前注释已承诺该字段，但实现未暴露，导致 UI 只能在后端报错后才知道。
      capabilities: (() => { try { return require('../../platform/os/index').capabilities(); } catch { return null; } })(),
    };
  }

  /** Node LTS 在线检查（6h 缓存 + 失败降级）：探测当前 node 运行版本并给出 LTS 建议。
   *  实现不做远端查询（避免守卫启动依赖网络）——本地判定 + 可刷新缓存；
   *  失败返回 { ok:false, error } 由前端降级展示，绝不抛异常。 */
  async nodeLtsStatus() {
    try {
      const cacheFile = path.join(path.dirname(this.config.stateFile), 'node-lts-cache.json');
      const now = Date.now();
      let cache = null;
      try { if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
      if (cache && now - (cache.fetchedAt || 0) < 6 * 3600 * 1000) {
        return { ok: true, ...cache, cached: true };
      }
      const ver = process.versions.node || '';
      const major = parseInt(String(ver).split('.')[0], 10) || 0;
      // LTS 建议：Node 偶数主版本为 LTS 线（保守本地判定，不作远端断言）
      const ltsLine = major % 2 === 0;
      const data = {
        current: ver,
        major,
        ltsLine,
        suggested: '当前 ' + ver + (ltsLine ? '（偶数主版本线，通常为 LTS）' : '（奇数主版本非 LTS 线，建议偶数主版本）'),
        fetchedAt: now,
      };
      try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {}
      return { ok: true, ...data, cached: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 守卫自更新「重启生效」衔接：仅当配置 guardRestartAllowed=true 且存在 systemd 用户单元才执行；
   *  否则返回明确指引（避免误杀/误起守卫）。 */
  /** 自更新后的守卫重启（A2）：能力按部署形态自动判定（SEA=systemd 重启闭环；源码形态=拒绝），
   *  去掉 guardRestartAllowed 人工配置门槛。重启前落盘「预期版本」，重启后 /status 校验自报版本
   *  达标才算更新成功——闭环可观测，不再出现"装了没生效"的静默失败。 */
  guardSelfUpdateRestart() {
    const dep = deploy.detect();
    if (!dep.updatable) {
      return { ok: false, error: dep.reason || '当前部署形态不支持自动重启', form: dep.form };
    }
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'dsh-supervisor.service');
    if (!fs.existsSync(unit)) return { ok: false, error: '系统未启用 systemd 用户单元，请手动重启守卫' };
    // 预期版本落盘：最近一次 apply 的目标版本（restart 后 status 校验用）
    const swDir = path.dirname(this.config.stateFile);
    try { fs.writeFileSync(path.join(swDir, 'self-update-expected.json'), JSON.stringify({ expectedVersion: this._selfUpdateExpectedVersion || null, at: Date.now() }), { mode: 0o600 }); } catch {}
    // 契约 §2/§4：守卫所属单元的所有者是外部（systemd + 壳），守卫**绝不 systemctl restart 自己**——
    // restart 内部先 stop（等本进程退出），而本进程正阻塞在 execFileSync → 死锁（与 V2 同源）。
    // 正确做法：守卫进程退出，由 systemd `Restart=always` 拉起新内核（KillMode=process → DSH 不受影响）。
    // 先回执（HTTP 响应发出）再退出，避免响应丢失。
    if (this.events) this.events.append('guard_self_update_restart', { expectedVersion: this._selfUpdateExpectedVersion || null, via: 'exit+systemd-restart' });
    this.logger && this.logger.info && this.logger.info('[self-update] 守卫将退出，由 systemd Restart=always 拉起新内核');
    setTimeout(() => { try { this.shutdown(); } catch {} process.exit(0); }, 500).unref();
    return { ok: true, restarted: true, via: 'exit+systemd-restart' };
  }

  // ---- 守卫自更新（2026-09 收敛：npm 通道取代 manifest/目录翻转）----
  guardSelfUpdateDir() {
    return this.config.selfUpdateDir || null;
  }

  /** 内核 npm 子包名（按当前平台/架构）。corePackageName 可为显式常量或含 {os}/{arch} 占位的模板。 */
  guardCorePkg() {
    const raw = this.config.corePackageName;
    if (!raw) return null;
    const map = { win32: 'win', linux: 'linux', darwin: 'darwin' };
    return String(raw).replace(/{os}/g, map[process.platform] || process.platform).replace(/{arch}/g, String(process.arch)) || null;
  }

  /** 守卫自更新（2026-09 收敛：npm 通道）——查 @dsh-sup/dsh-core-<os>-<arch> 全 tag 最高版本（全更新：
   *  BETA/RC/正式都算更新，任一更高即提示可更新），对本机 guardVersion 比较。 */
  async guardSelfUpdateStatus() {
    const pkg = this.guardCorePkg();
    if (!pkg) return { ok: false, error: '未配置内核自更新包（corePackageName）' };
    if (!this.dist || typeof this.dist.fetchLatestVersion !== 'function') return { ok: false, error: '发布服务未初始化' };
    // 部署形态判定（A1）：npm 自更新仅适用于标准产品形态（SEA 单文件二进制）。
    // 源码开发形态（bin 壳 require 源码目录）装新二进制永远不生效——显式拒绝，面板不再假装成功。
    const dep = deploy.detect();
    if (!dep.updatable) {
      return { ok: false, error: dep.reason, form: dep.form, updatable: false };
    }
    try {
      // authoritative：内核自更新查官方 registry——镜像同步延迟会把新版本误判为『已是最新』
      // （实测：npmmirror 对 @dsh-sup scope 包同步滞后，发布后面板『检查更新』漏报）。
      const latest = await this.dist.fetchLatestVersion(pkg, this.config.releaseChannel || 'npm', { authoritative: true });
      // 双版本口径（A3）：running = 进程启动时固化的编译期常量；disk = 磁盘二进制实况。
      // 运行中进程不可能装后即变——restartRequired/更新待重启以此判定，不再自相矛盾。
      const installed = this.guardVersion;
      if (!latest) return { ok: false, error: '官方源不可达或未查询到版本' };
      const updateAvailable = semverCompare(latest, installed) > 0;
      if (this.events) this.events.append('guard_self_update_checked', { installed, latest, updateAvailable });
      return { ok: true, pkg, installed, latest, updateAvailable, form: dep.form, updatable: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 应用内核更新（npm 通道，全更新强制语义）：`npm i -g <pkg>@<latest>`。
   *  安装后由调用方（壳/面板）据 restartRequired 调 /self-update/restart-guard（或手动重启）生效。 */
  async guardSelfUpdateApply() {
    const pkg = this.guardCorePkg();
    if (!pkg) return { ok: false, error: '未配置内核自更新包（corePackageName）' };
    if (!this.dist || typeof this.dist.runNpmInstall !== 'function') return { ok: false, error: '发布服务未初始化' };
    if (!this.config.installCommandTemplate || !Array.isArray(this.config.installCommandTemplate)) return { ok: false, error: '未配置安装命令模板（installCommandTemplate）' };
    // 部署形态门槛（A1）：status 已含判定；updatable=false 直接拒绝（源码形态装 SEA 永不生效）
    const latest = await this.guardSelfUpdateStatus();
    if (!latest.ok || !latest.latest) return { ok: false, error: (latest && latest.error) || '版本查询失败' };
    if (latest.updatable === false) return { ok: false, error: latest.error || '当前部署形态不支持自更新', form: latest.form };
    if (!latest.updateAvailable) return { ok: true, upToDate: true, version: this.guardVersion }; // 已最新，无需更
    // 全更新语义：latest > 当前即强制安装（无跳过）
    const target = latest.latest;
    try {
      // 下载源强制官方 registry（B）：内核自更新是「真相源+下载源统一」的闭环——
      // 镜像 tarball 曾出现 stale（拉到旧版本二进制），官方源才有版本一致性保证。
      // 沙箱安装等大流量场景仍走 selectRegistry 镜像。
      const registry = 'https://registry.npmjs.org';
      const r = await this.dist.runNpmInstall({
        pkg,
        version: target,
        commandTemplate: this.config.installCommandTemplate,
        registry,
        onLine: (l) => { if (this.logger && this.logger.info) this.logger.info('[self-update] ' + l); },
      });
      if (r && r.ok) {
        // 安装结果校验（A1 闭环）：磁盘上的二进制必须真的变成目标版本——
        // 防「npm i 成功但装到与运行位无关的位置/镜像 stale」类静默失败（本次生产实测）。
        let diskVersion = null;
        try { diskVersion = deploy.detect().runningTarget ? this._readBinarySelfVersion() : null; } catch {}
        const verified = diskVersion === target;
        this._selfUpdateExpectedVersion = verified ? target : null; // 重启后 status 校验用（A3）
        const restartRequired = true;
        if (this.events) {
          this.events.append('guard_self_update_applied', { from: this.guardVersion, version: target, pkg, diskVersion, verified });
        }
        if (!verified) {
          return { ok: true, from: this.guardVersion, version: target, diskVersion, verified: false, restartRequired,
            warn: '已安装但磁盘版本校验未通过（装到非运行位/镜像 stale），请检查部署形态' };
        }
        return { ok: true, from: this.guardVersion, version: target, diskVersion, verified: true, restartRequired };
      }
      return { ok: false, error: (r && r.error) || 'npm 安装失败' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 自更新「已安装待重启生效」判定（A3）：最近一次 apply 落盘的预期版本存在、
   *  且进程运行版本仍低于它 → updatePending=true（面板显示重启提示；重启达标后自动清除）。 */
  _selfUpdatePending() {
    try {
      const swDir = path.dirname(this.config.stateFile);
      const f = path.join(swDir, 'self-update-expected.json');
      if (!fs.existsSync(f)) return false;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const expected = j && j.expectedVersion;
      if (!expected) return false;
      if (this.guardVersion === expected) { // 已达标：清除标记（一次性）
        try { fs.unlinkSync(f); } catch {}
        if (this.events) this.events.append('guard_self_update_verified', { version: expected });
        return false;
      }
      return semverCompare(expected, this.guardVersion) > 0; // 预期更新才叫 pending；回退场景不标
    } catch { return false; }
  }

  /** 读磁盘上运行位二进制的自报版本（A1 校验用）：spawn --version，解析 guardVersion= 行。
   *  仅 SEA 二进制支持（source-shell 形态在读 package.json，与 npm 安装无关）。 */
  _readBinarySelfVersion() {
    const dep = deploy.detect();
    if (dep.form !== 'sea-binary' || !dep.runningTarget) return null;
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(dep.runningTarget, ['--version'], { timeout: 20000, encoding: 'utf8' });
      const m = /dsh-supervisor v([^s]+)/.exec(out);
      return m ? m[1] : null;
    } catch { return null; }
  }

  // ---- DSH 即安即用：本体安装状态判定（命令指向的 bin 可执行 + 已管实例版本）----
  dshenvStatus() {
    let bin = null, binOk = false, installed = null, cmdOk = false;
    try {
      const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
      cmdOk = cmd0.length > 0;
      bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
      if (bin) binOk = fs.existsSync(bin);
    } catch {}
    try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
    // main = 守卫核心服务(概念清分)：受管状态以 config.command 有效为准（不再依赖沙箱实例登记）
    return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this._mPhase() || null };
  }

  // ---- 管家自身版本检查（与 DSH 更新解耦）：本地仓库 git 视角，配了远程才 fetch 比对 ----
  /** VCS 根解析：从 dsh-supervisor/ 上溯找最近的「外层」.git（排除自身嵌套仓）。
   *  修复（2026-09）：原 path.resolve(__dirname,'..') 命中 dsh-supervisor/.git 嵌套仓，
   *  其 HEAD 与真实外层仓脱节（嵌套仓 06:29 早于外层 07:15 提交）→ UI 版本/commit 失真。
   *  找不到外层仓时回退自身目录（行为与历史一致，commit 解析失败仍为 null）。 */
  _vcsRoot() {
    let dir = path.resolve(__dirname, '..'); // dsh-supervisor/
    const innerGit = path.join(dir, '.git');
    let parent = path.dirname(dir);
    while (parent !== path.dirname(parent)) {
      const cand = path.join(parent, '.git');
      if (cand !== innerGit && fs.existsSync(cand)) return parent; // 最近的外层仓
      parent = path.dirname(parent);
    }
    return dir; // 无外层仓：回退自身（嵌套仓/部署态）
  }

  /** 本地视角（无网络 I/O，同步安全）：commit + 是否配了 upstream。 */
  guardVersionLocal() {
    const root = this._vcsRoot();
    let commit = null;
    try { commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    let upstream = 'local';
    try {
      const up = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}'], { encoding: 'utf8' }).trim();
      if (up) upstream = 'git-repo';
    } catch {}
    // version = 进程运行版本（启动时固化，SEA 为编译期常量）——语义明确标注（A3）。
    // 磁盘实况版本（runningVersion vs diskVersion 的 updatePending 判定）在 async guardVersionCheck。
    return { version: this.guardVersion, runningVersion: this.guardVersion, commit, updateAvailable: false, upstream, latest: this.guardVersion };
  }

  /**
   * 完整版本检查（async）：本地 commit + 远端 fetch 比对。
   * 关键架构约束：git fetch 是网络 I/O，绝不能同步执行（会冻结整个事件循环，守卫假死且无法自愈）。
   * 这里用 execFile（异步）+ 10s 超时；fetch 失败/超时只降级为「本地视图」，不抛错。
   */
  async guardVersionCheck() {
    const base = this.guardVersionLocal();
    if (base.upstream !== 'git-repo') return base;
    const root = this._vcsRoot();
    const fetchOk = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      try {
        const child = execFile('git', ['-C', root, 'fetch', '--quiet'], { timeout: 10000 }, (err) => done(!err));
        child.on('error', () => done(false));
      } catch { done(false); }
    });
    if (!fetchOk) return base; // fetch 失败：保持本地视图，不误报
    let updateAvailable = false;
    try {
      const ahead = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}'], { encoding: 'utf8' }).trim();
      updateAvailable = parseInt(ahead, 10) > 0;
    } catch {}
    // A3：磁盘运行位实况版本 vs 进程运行版本——不一致 = 「更新已安装、待重启生效」
    const dep = deploy.detect();
    let diskVersion = null;
    if (dep.form === 'sea-binary') diskVersion = this._readBinarySelfVersion();
    const updatePending = !!(diskVersion && diskVersion !== this.guardVersion);
    return { ...base, diskVersion, updatePending };
  }

  // ---- 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）----
  lanPanelStatus() {
    const enabled = this.config.apiHost === '0.0.0.0';
    const port = this.config.apiPort;
    // 真实可访问地址（2026-09 用户指正）：只给局域网内设备真正能访问的地址——
    // 取「走默认路由的真实出口网卡」的 IPv4，过滤虚拟网桥(virbr*/veth*/docker*/br-*)。
    const ips = [];
    if (enabled) {
      try {
        const { execFileSync } = require('node:child_process');
        // 1) 先找默认路由关联的出口网卡名
        let dev = null;
        try {
          const def = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
          dev = (def.match(/dev\s+(\S+)/) || [])[1] || null;
        } catch {}
        // 2) 枚举各网卡 IPv4（记录 secondary/dynamic 标志——DHCP 动态地址优先排除）
        const out = execFileSync('ip', ['-o', 'addr', 'show'], { encoding: 'utf8' }).trim();
        const collected = {}; // iface -> [{ addr, dyn }]
        for (const line of out.split('\n')) {
          const m = line.match(/^\d+:\s+(\S+?)(@\S+)?\s+inet\s+([0-9.]+)\//);
          if (!m) continue;
          const iface = m[1];
          const addr = m[3];
          const dyn = /(?:secondary|dynamic)/.test(line);
          if (addr.startsWith('127.') || addr.startsWith('169.254.')) continue;
          if (/^(virbr|veth|docker|vmnet|br-|lo)/.test(iface)) continue;
          (collected[iface] = collected[iface] || []).push({ addr, dyn });
        }
        // 3) 每网卡取 1 个首选地址（静态优先；无静态才用 DHCP）；默认路由网卡排最前。
        const firstOf = (arr) => {
          const stat = arr.find((x) => !x.dyn);
          return (stat || arr[0]).addr;
        };
        if (dev && collected[dev]) {
          ips.push(firstOf(collected[dev]));
          delete collected[dev];
        }
        for (const iface of Object.keys(collected)) ips.push(firstOf(collected[iface]));
      } catch (e) { this.logger && this.logger.warn && this.logger.warn('lan ips: ' + e.message); }
    } else {
      ips.push('127.0.0.1');
    }
    // 去重保持稳定顺序
    const unique = [...new Set(ips)];
    return { enabled, host: this.config.apiHost, port, urls: unique.map((ip) => 'http://' + ip + ':' + port) };
  }

  /** 开=面板绑定 0.0.0.0（局域网可访问，经 apiHost 白名单限制为局域网/本机）；关=仅绑定 127.0.0.1（本机可访问）。 */
  setLanPanel(enabled) {
    try {
      const host = enabled ? '0.0.0.0' : '127.0.0.1';
      const changed = this.config.apiHost !== host;
      this.config.apiHost = host;
      if (this.configPath) {
        try {
          const doc = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
          doc.apiHost = host;
          const ctmp = this.configPath + '.tmp';
          fs.writeFileSync(ctmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
          fs.renameSync(ctmp, this.configPath); // 原子 + 0600
        } catch (e) { this.logger.error('persist apiHost: ' + e.message); }
      }
      if (changed && this.api && typeof this.api.close === 'function') this._rebindApiHost();
      if (this.events) this.events.append('lan_panel_changed', { enabled });
      if (this.logger && this.logger.info) this.logger.info('管家面板局域网访问 -> ' + (enabled ? '开(0.0.0.0)' : '关(127.0.0.1)'));
      return { ok: true, ...this.lanPanelStatus() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 出回环访问密钥（F2 定案）：状态查询 + 设置/清除（api.js 路由引用此门面；
  // 2026-09 修复：此前 api.js:493 调 sup.accessKeyStatus() 但 Supervisor 从未实现该门面 →
  // 设置页每次 GET 抛 uncaughtException → 守卫 60s 3 次异常自杀重启 → 设置页长时间无响应。）----
  /** 状态（不回显明文）：configured + host。 */
  accessKeyStatus() {
    const cfg = this.config || {};
    return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
  }

  /** 设置/清除出回环访问密钥（空串=清除）。原子持久化到守卫 config。 */
  setAccessKey(key) {
    try {
      const cfg = this.config || {};
      const k = typeof key === 'string' ? key.trim() : '';
      if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
      cfg.apiAccessKey = k || null;
      if (this.configPath) this.persistConfigPatch({ apiAccessKey: k || null });
      if (this.events) this.events.append('access_key_changed', { configured: !!k });
      return { ok: true, configured: !!k };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 关闭窗口行为（2026-09 用户定稿）：隐藏至托盘 / 退出管家（壳读取执行；系统级配置）----
  /** 当前关闭行为：'hide' | 'exit'。 */
  closeActionStatus() {
    const cfg = this.config || {};
    const v = cfg.closeAction;
    return { closeAction: (v === 'exit') ? 'exit' : 'hide' };
  }

  /** 设置关闭行为（'hide'=关闭隐藏至托盘，服务继续；'exit'=关闭=退出管家，停止全部服务链）。 */
  setCloseAction(v) {
    try {
      const val = (v === 'exit') ? 'exit' : 'hide';
      const cfg = this.config || {};
      cfg.closeAction = val;
      if (this.configPath) this.persistConfigPatch({ closeAction: val });
      if (this.events) this.events.append('close_action_changed', { closeAction: val });
      return { ok: true, closeAction: val };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

const _desc = Object.getOwnPropertyDescriptors(SettingsView.prototype);
delete _desc.constructor; // 不覆盖 Supervisor.prototype.constructor

module.exports = _desc;
