'use strict';

// §7.6 拆分自 supervisor.js：settings-view（原型 mixin）。
// 仅经 this 协作；导出「原型属性描述符」由 supervisor.js 注入 Supervisor.prototype。
// 行为与拆分前逐字一致（含 getter/setter；class 体方法无需逗号）。
// 依赖由拆分脚本按块内实际使用自动携带（遗漏会导致运行期 ReferenceError）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const ex = require('../../platform/exec');
// 平台知识唯一事实源（跨平台架构规范）：os/arch→标签映射只在 src/platform/matrix.js。
const matrix = require('../../platform/matrix');
const netInfo = require('../../platform/os/netinfo');
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
      // ⚠ 2026-09-12（P2）：**接线桌面壳看护的观测快照**。
      //   `watchdog.status()` 的注释一直写着「供 /env/status 或诊断」，但**零生产消费**
      //   （全仓只有 e2e 测试读它）—— 于是「壳反复拉起失败」在面板上**不可见**。
      //   现如实暴露：enabled/intervalMs/graceMs/absentForMs/restartsInWindow/
      //   everSawAlive/lastSkipReason/expectedAbsence —— 排障时能直接看到看护在做什么。
      shellWatchdog: (() => {
        try { return this.shellWatchdog && typeof this.shellWatchdog.status === 'function' ? this.shellWatchdog.status() : null; }
        catch { return null; }
      })(),
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

  // ---- 内核更新（单写入者契约：安装/重启归桌面壳）----
  //
  // ⚠ 2026-09-15（A 方案）：`guardSelfUpdateApply` 与 `guardSelfUpdateRestart` **已删除** ——
  //   内核 npm 包的唯一写入者是桌面壳（见 RELEASE-AND-UPDATE-MECHANISM.md §6）；
  //   守卫只保留只读的 `guardSelfUpdateStatus`，接口 `/self-update/apply|restart-guard` 返回 410。
  //   （此前 2026-09-12 已删除零调用点的 `guardSelfUpdateDir()`。）

  /** 内核 npm 子包名（按当前平台/架构）。corePackageName 可为显式常量或含 {os}/{arch} 占位的模板。 */
  guardCorePkg() {
    const raw = this.config.corePackageName;
    if (!raw) return null;
    // 2026-09-13（跨平台架构规范化）：平台知识收口到 src/platform/matrix.js。
    return String(raw).replace(/{os}/g, matrix.osTag()).replace(/{arch}/g, matrix.current().arch) || null;
  }

  /** 内核更新状态（**只读**；安装/重启归桌面壳，单写入者契约）。
   *  查 @dsh-sup/dsh-core-<os>-<arch> 全 tag 最高版本（BETA/RC/正式都算更新），与本机 guardVersion 比较。
   *  本方法**不写任何东西**：面板据此显示「可更新」，实际安装由桌面壳 kernel_update_apply 执行。 */
  async guardSelfUpdateStatus() {
    const pkg = this.guardCorePkg();
    if (!pkg) return { ok: false, error: '未配置内核包（corePackageName）' };
    if (!this.dist || typeof this.dist.fetchLatestVersion !== 'function') return { ok: false, error: '发布服务未初始化' };
    // 部署形态判定：源码开发形态（bin 壳 require 源码目录）不适用 npm 分发的版本口径——显式说明。
    const dep = deploy.detect();
    if (!dep.updatable) {
      return { ok: false, error: dep.reason, form: dep.form, updatable: false };
    }
    try {
      // authoritative：查官方 registry——镜像同步延迟会把新版本误判为『已是最新』。
      const latest = await this.dist.fetchLatestVersion(pkg, this.config.releaseChannel || 'npm', { authoritative: true });
      const installed = this.guardVersion;
      if (!latest) return { ok: false, error: '官方源不可达或未查询到版本' };
      const updateAvailable = semverCompare(latest, installed) > 0;
      if (this.events) this.events.append('guard_self_update_checked', { installed, latest, updateAvailable });
      return { ok: true, pkg, installed, latest, updateAvailable, form: dep.form, updatable: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 读磁盘上**运行位**的自报版本（A1 校验用）：spawn `--version`，解析 guardVersion= 行。
   *
   *  ⚠ 2026-09-12（P0 配套）：条件从 `form === 'sea-binary'` 放宽为「**可更新的标准形态**」
   *    （`updatable === true`，即 sea-binary **或** launcher）。
   *    理由：发布形态早已弃 SEA 改为文本 launcher，而 launcher 的 `<pkg>/bin/dsh-supervisor`
   *    同样是可执行入口（`require('../core.cjs')`），spawn 它能得到同样的 --version 输出。
   *    若仍只认 sea-binary，则真实用户永远读不到磁盘实况版本 → `updatePending` 恒 false
   *    （「已装好待重启」永不显示）。
   *
   *    source-shell（源码形态）仍不支持：其 `--version` 报的是开发目录版本，与 npm 安装无关。
   */
  _readBinarySelfVersion() {
    const dep = deploy.detect();
    if (!dep.updatable || !dep.runningTarget) return null;
    try {
      const out = ex.runOut(dep.runningTarget, ['--version'], { timeoutMs: 20000 });
      // ⚠ 2026-09-11 修复（K9）：原为 /dsh-supervisor v([^s]+)/ —— 字符类 [^s] 的意图
      //   是「非空白」，却写成了「非字母 s」：版本串里一旦出现 s 就截断，
      //   且 \n 不在排除集内，正则会跨行吞字符。结果污染 self-update 的 verified 判定。
      const m = /dsh-supervisor v([^\s]+)/.exec(out);
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
  /** VCS 根解析：从**包根**上溯找最近的「外层」.git（排除自身嵌套仓）。
   *
   *  修复（2026-09）：原实现命中 dsh-supervisor/.git 嵌套仓，其 HEAD 与真实外层仓脱节
   *  （嵌套仓 06:29 早于外层 07:15 提交）→ UI 版本/commit 失真。
   *  找不到外层仓时回退包根（行为与历史一致，commit 解析失败仍为 null）。
   *
   *  ⚠ 二次修复（2026-09-11）：包根解析原为 `path.resolve(__dirname, '..')` 并注释
   *  「= dsh-supervisor/」，但 §7.6 拆分把本文件从 `src/` 移到 `src/guard/supervisor/`，
   *  该表达式实际得到 `src/guard/` —— **注释与行为已不符**，
   *  使「排除嵌套 .git」的判据作用在错误目录（真正的包根 .git 不再被排除）。
   *  改用 srcpath.resolvePackageRoot()（按 package.json 上溯，不受层级调整影响）。 */
  _vcsRoot() {
    const dir = require('../../platform/srcpath').resolvePackageRoot() || path.resolve(__dirname, '..');
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
    commit = (ex.runOut('git', ['-C', root, 'rev-parse', '--short', 'HEAD']) || '').trim() || null;
    let upstream = 'local';
    try {
      const up = (ex.runOut('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}']) || '').trim();
      if (up) upstream = 'git-repo';
    } catch {}
    // version = 进程运行版本（启动时固化，打包态为编译期常量）——语义明确标注（A3）。
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
      // git 可能因网络盘/凭证助手挂起 → 必须有界（原为裸 execFileSync，无 timeout）。
      const ahead = (ex.runOut('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}']) || '').trim();
      updateAvailable = parseInt(ahead, 10) > 0;
    } catch {}
    // A3：磁盘运行位实况版本 vs 进程运行版本——不一致 = 「更新已安装、待重启生效」
    const dep = deploy.detect();
    let diskVersion = null;
    // P0 配套：launcher 形态同样有运行位自报版本（见 _readBinarySelfVersion 说明）。
    if (dep.updatable) diskVersion = this._readBinarySelfVersion();
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
      // ★ 平台化（2026-09-11 修 K8）：原实现**直接**调用 `ip` (iproute2) ——
      //   这是 Linux 专有命令；在 macOS/Windows 上抛异常后被 catch 吞掉，
      //   于是 ips 恒为空 → 面板显示「开关已开但没有任何可访问地址」，
      //   且**不报错**（静默降级）。同时它也是裸 execFileSync（无超时）。
      //   现下沉到 platform/os/netinfo（三平台实现 + 经 platform/exec 有界）。
      ips.push(...netInfo.lanAddresses());
      if (!ips.length) {
        this.logger && this.logger.warn && this.logger.warn(
          "lan ips: 未枚举到可用局域网地址（platform=" + netInfo.PLATFORM +
          ", supported=" + netInfo.supported + "）"
        );
      }
    } else {
      ips.push("127.0.0.1");
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
