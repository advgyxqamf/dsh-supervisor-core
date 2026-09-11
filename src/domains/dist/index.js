'use strict';

// 统一的「包发布/安装/更新」领域逻辑。
//
// 核心抽象：凡是从「外部发布通道」获取并安装软件的地方（DeepSeek Harness 自升级、
// 反向代理子应用），都共用同一套：
//   - 全局 npm 镜像源配置（一个来源，自动适配国内网络/手动固定）
//   - 版本检查（npm registry + GitHub Releases，按 channel 抽象）
//   - 版本比较（semver）
//   - 安装命令执行（注入选中镜像）
//
// 这样镜像源配置、版本检测、安装逻辑只有一份，不再各自旁路分支。
// 未来产品经 npm / GitHub 发布，也走这里。

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
// 镜像契约读取器（壳 → 内核）。**目录与探测方法的所有权在壳**：
// 用户在装壳那刻机器上没有内核，壳必须先完成镜像选择才能装内核，
// 故内核**消费壳投放的契约**，而不是自己再持一份硬编码副本。
const registryContract = require('../../platform/registry-contract');
// 服务管理器抽象（跨平台审计 §7.1）：分发域不直接调用 systemctl。
const service = require('../../platform/os/service').current();

// 合法 semver（含 prerelease/build），杜绝脏版本号进比较/安装链路。
// 收紧：core 段禁止前导零（1.02.3 非法）、pre/build 标识符禁止连续/首尾点（rc..1 非法）
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 简化 semver 比较：返回 >0 / 0 / <0。支持 1.2.3 与 1.2.3-rc.1 形态（prerelease < release）。
 *  build metadata（+xxx）按规范忽略：1.0.0-rc.1+build5 与 1.0.0-rc.1 相等。 */
function semverCompare(a, b) {
  const parse = (v) => {
    const clean = String(v).split('+')[0]; // 剥离 build metadata（不参与比较）
    const [core, pre] = clean.split('-');
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((A.nums[i] || 0) !== (B.nums[i] || 0)) return (A.nums[i] || 0) - (B.nums[i] || 0);
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1; // release > prerelease
  if (B.pre === '') return -1;
  const ap = A.pre.split('.');
  const bp = B.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (parseInt(x, 10) !== parseInt(y, 10)) return parseInt(x, 10) - parseInt(y, 10);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 最小兜底镜像源 —— **仅契约缺失/损坏时使用**（2026-09-11 契约化）。
 *
 * ## 为什么从 6 条减到 2 条
 *
 * 原 6 条（npm 官方 / npmmirror / 华为 / 腾讯 / 中科大 / cnpmjs）在**三处**逐字节重复：
 *   · 壳 `mirror.rs` `NPM_PRESETS`（**所有者**）
 *   · 本文件原 `REGISTRY_PRESETS`（**已删除**）
 *   · `platform/config.js` `registries`
 * 任何一处增删都会漂移，且实测已造成**两侧选源不一致**（探测方法不同）。
 *
 * 现目录归壳（经 `~/.dsh/supervisor/registry.json` 的 `catalog` 投放），
 * 内核只需保证「**契约不可用时也能跑**」（不变量 C2）——
 * 故保留 2 条覆盖两种基本情形：能上网（官方）+ 中国网络（npmmirror）。
 *
 * 完整目录与探测规格一律来自契约；此处**不参与**正常选择路径。
 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

/**
 * 统一分发管理器：全局镜像源配置 + 版本检查 + 安装执行。
 *
 * @param {object} opts
 *   - registries: 候选镜像源（默认来自 config.registries）
 *   - registryFile: 全局镜像配置持久化路径（mode/origins/manualOrigin）
 *   - events: 事件总线（可选）
 *   - logger
 */
class DistributionManager {
  constructor(opts) {
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    // 最小兜底（契约不可用时才用；见 FALLBACK_REGISTRIES 注释）。
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...FALLBACK_REGISTRIES];
    // 壳投放的镜像契约（目录 + 选择结果 + **探测规格**）。
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, selected: null };
    // 全局镜像配置：mode auto|manual，origins 候选，manualOrigin 手动固定。从 registryFile 加载。
    this.registryConfig = { mode: 'auto', origins: [...this.defaultRegistries], manualOrigin: this.defaultRegistries[0] || '' };
    this.selectedRegistry = null; // { origin, latencyMs, checkedAt, manual, source }
    this._loadRegistryConfig();
  }

  // ---- 全局镜像配置持久化 ----
  /**
   * 载入镜像配置与**壳投放的契约**。
   *
   * 优先级（高 → 低）：
   *   ① 用户在面板手动固定（`mode=manual`）—— 显式意图，最高优先；
   *   ② 壳投放的契约 `catalog` —— 目录的所有者在壳；
   *   ③ 构造参数 `opts.registries`；
   *   ④ 最小兜底 `FALLBACK_REGISTRIES`。
   *
   * 契约不可用（缺失/坏 JSON/schema 更新/空目录）时**不阻断**：
   * 记录 reason 供诊断，选择路径自动回退到 ③/④（不变量 C2）。
   */
  _loadRegistryConfig() {
    // ① 先读契约（即使下面是 manual，也要拿到 probe 规格用于复测）
    this.contract = registryContract.read(this.registryFile);
    if (!this.contract.ok) {
      this.logger.warn && this.logger.warn(
        'dist: 镜像契约不可用（' + this.contract.reason + '），回退到最小兜底（' +
        this.defaultRegistries.length + ' 条）'
      );
      if (this.events) {
        try { this.events.append('dist_contract_unavailable', { reason: this.contract.reason, file: this.registryFile }); } catch {}
      }
    }

    // ② 旧字段（mode/manualOrigin/origins）保留读取，兼容 v1 与「内核自己写过的配置」
    if (!this.registryFile) return;
    try {
      if (!fs.existsSync(this.registryFile)) return;
      const doc = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      if (typeof doc !== 'object' || !doc) return;
      // 候选集：契约 catalog 优先（壳是所有者），其次旧 origins，最后兜底。
      const fromContract = this.contract.ok ? this.contract.catalog : [];
      const fromDoc = (Array.isArray(doc.origins) && doc.origins.length) ? doc.origins : [];
      const origins = fromContract.length ? fromContract : (fromDoc.length ? fromDoc : [...this.defaultRegistries]);
      this.registryConfig = {
        mode: (doc.mode === 'manual') ? 'manual' : 'auto',
        origins,
        manualOrigin: (typeof doc.manualOrigin === 'string' && doc.manualOrigin)
          ? doc.manualOrigin : (origins[0] || ''),
      };
    } catch (e) { this.logger.warn && this.logger.warn('dist: registry config load failed: ' + e.message); }
  }

  _saveRegistryConfig() {
    if (!this.registryFile) return;
    try {
      const dir = path.dirname(this.registryFile);
      if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
      (() => { try { const f = this.registryFile; const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.registryConfig, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, f); } catch (e) { /* 持久化失败不阻塞 */ } })()
    } catch (e) { this.logger.warn && this.logger.warn('dist: registry config save failed: ' + e.message); }
  }

  // ---- 镜像源探测/选择 ----
  /** 内核平台标签（用于展开契约的 pathTemplate；与壳的 package_name 同源）。 */
  _platformTag() {
    const os = process.platform === 'darwin' ? 'darwin' : (process.platform === 'win32' ? 'win' : 'linux');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return os + '-' + arch;
  }

  /**
   * 探测单个 registry 的可达性 + 延迟。
   *
   * **探测 URL 由契约决定**（修复「两侧选源不一致」）：
   *   契约 `probe.kind='package-metadata'` → 与壳完全一致的**真实包元数据** URL；
   *   无契约 → 退回旧的 `/-/ping`（兜底，不阻断）。
   *
   * 为什么必须一致：实测同一镜像两种方法测出的延迟差 **6.7 倍**
   *（ustclug 2613ms vs 389ms），内核与壳因此**选到不同的源** ——
   * 用户看到「面板显示一个源、实际下载用另一个」。
   */
  async _probeRegistry(origin) {
    const base = origin.replace(/\/+$/, '');
    const spec = (this.contract && this.contract.ok && this.contract.probe) || null;
    let url = base + '/-/ping';
    let kind = 'ping';
    if (spec && spec.kind === 'package-metadata' && spec.pathTemplate) {
      url = base + '/' + spec.pathTemplate.replace('{platform}', this._platformTag());
      kind = spec.kind;
    }
    const timeoutMs = (spec && spec.timeoutMs) || 4000;
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok, latencyMs: Date.now() - start, probe: kind };
    } catch (e) { return { ok: false, latencyMs: Date.now() - start, probe: kind }; }
  }

  /** 生效的候选 registry 列表（用户配置或默认）。 */
  _registryOrigins() {
    const o = (this.registryConfig && this.registryConfig.origins) || [];
    const list = o.filter((x) => typeof x === 'string' && x.trim());
    return list.length ? list : [...this.defaultRegistries];
  }

  /** 选一个可达且最快的 registry。mode=manual 时锁定 manualOrigin。TTL 缓存 30min。返回 origin。 */
  async selectRegistry(force) {
    const rc = this.registryConfig || {};
    if (rc.mode === 'manual' && rc.manualOrigin) {
      const origin = rc.manualOrigin.replace(/\/+$/, '');
      this.selectedRegistry = { origin, latencyMs: null, checkedAt: Date.now(), manual: true, probes: [] };
      return origin;
    }
    const now = Date.now();
    if (!force && this.selectedRegistry && !this.selectedRegistry.manual && this.selectedRegistry.checkedAt && (now - this.selectedRegistry.checkedAt) < 30 * 60 * 1000) return this.selectedRegistry.origin;
    // ★ 优先采用**壳投放的选择结果**（2026-09-11 契约化）：
    //   壳已完成同轮测速（且用同一探测规格），内核无需再测一遍；
    //   仅当契约过期（超 TTL）或 force 时才自己复测。
    //   收益：正常路径零重复网络；且两侧**必然同源**（同一份 selected）。
    const c = this.contract;
    if (!force && c && c.ok && c.selected) {
      const age = Math.floor(Date.now() / 1000) - c.selected.checkedAt;
      if (age >= 0 && age < 30 * 60) {
        this.selectedRegistry = {
          origin: c.selected.origin, latencyMs: c.selected.latencyMs,
          checkedAt: Date.now(), manual: false, source: 'shell',
          probes: [],
        };
        if (this.events) {
          try { this.events.append('dist_registry_selected', { origin: c.selected.origin, source: 'shell-contract' }); } catch {}
        }
        return c.selected.origin;
      }
    }
    const origins = this._registryOrigins();
    const results = await Promise.all(origins.map(async (origin) => {
      const p = await this._probeRegistry(origin);
      return { origin, ok: p.ok, latencyMs: p.latencyMs };
    }));
    const reachable = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
    if (!reachable.length) {
      // 全部镜像不可达：返回 null（调用方降级 npm 默认源）且不缓存失败选择——
      // 旧实现仍选 origins[0] 并缓存 30min，安装会以不可达 registry 继续失败
      this.selectedRegistry = { origin: null, latencyMs: null, checkedAt: null, manual: false, probes: results };
      if (this.events) this.events.append('dist_registry_unreachable', { candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms') });
      return null;
    }
    const picked = reachable[0];
    this.selectedRegistry = { origin: picked.origin, latencyMs: picked.latencyMs, checkedAt: Date.now(), manual: false, probes: results };
    if (this.events) this.events.append('dist_registry_selected', { origin: picked.origin, latencyMs: picked.latencyMs, candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms') });
    return picked.origin;
  }

  /** 镜像源信息（供 UI/API 展示）。 */
  async registryInfo() {
    const origin = await this.selectRegistry(false);
    const rc = this.registryConfig || {};
    return {
      origin,
      mode: rc.mode || 'auto',
      manualOrigin: rc.manualOrigin || '',
      candidates: this._registryOrigins().map((o) => ({ origin: o })),
      // 预设 = 壳投放的目录（契约）；契约不可用时为空数组，
      // UI 应展示 candidates（实际候选）而非依赖 presets。
      presets: (this.contract && this.contract.ok) ? this.contract.catalog : [],
      catalogSource: (this.contract && this.contract.ok) ? (this.contract.writtenBy || 'shell') : 'fallback',
      latencyMs: (this.selectedRegistry && this.selectedRegistry.latencyMs) || null,
      checkedAt: (this.selectedRegistry && this.selectedRegistry.checkedAt) || null,
      manual: !!(this.selectedRegistry && this.selectedRegistry.manual),
      probes: (this.selectedRegistry && this.selectedRegistry.probes) || [],
    };
  }

  /** 保存全局镜像源配置（mode/手动源/候选），并立即重测。 */
  async setRegistryConfig(cfg) {
    const rc = this.registryConfig || {};
    if (cfg && typeof cfg === 'object') {
      if (cfg.mode === 'manual' || cfg.mode === 'auto') rc.mode = cfg.mode;
      if (typeof cfg.manualOrigin === 'string') rc.manualOrigin = cfg.manualOrigin.trim();
      if (Array.isArray(cfg.origins)) {
        const list = cfg.origins.map((x) => String(x).trim()).filter((x) => /^https?:\/\//.test(x));
        if (list.length) rc.origins = list;
      }
    }
    this.registryConfig = rc;
    this._saveRegistryConfig();
    this.selectedRegistry = null; // 清缓存，立即重测
    return this.registryInfo();
  }

  // ---- 版本检查 ----
  /** npm registry 最新版（用选中镜像；失败回退逐个候选；null 表示不可达）。 */
  async fetchNpmLatest(pkg, opts) {
    if (!pkg) return null;
    const o = opts || {};
    let origin = null;
    if (o.authoritative) {
      // 发布权威源解析（RC6 补充）：版本真相源 = 官方 npm registry。
      // ① 配置列表里显式配了官方源（生产 DEFAULTS 含 npmjs）→ 用它；
      // ② 测试/私有部署注入了非官方列表（如 mock）→ 尊重注入（可测试性优先）；
      // ③ 列表为空 → 默认官方。
      const official = this._registryOrigins().find((x) => /registry\.npmjs\.org/.test(x));
      origin = official || this._registryOrigins()[0] || 'https://registry.npmjs.org';
    } else {
      origin = await this.selectRegistry(false);
    }
    if (!origin) return null; // 全部镜像不可达：明确失败（checkUpdate 据此报错而非误报最新）
    try {
      // 完整版本检测：拉包完整元数据（dist-tags + versions），取最高版本——
      // 覆盖 latest/alpha/rc/next 全 tag（DeepSeek 新版本可能发布在 alpha 而非 latest）
      const res = await fetch(origin.replace(/\/+$/, '') + '/' + encodeURIComponent(pkg), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const j = await res.json();
      const tags = (j && j['dist-tags']) || {};
      const versions = (j && j.versions) ? Object.keys(j.versions) : [];
      const candidates = new Set([...Object.values(tags), ...versions].filter((v) => typeof v === 'string' && VERSION_RE.test(v)));
      if (!candidates.size) {
        const lr = await fetch(origin.replace(/\/+$/, '') + '/' + encodeURIComponent(pkg) + '/latest', { signal: AbortSignal.timeout(8000) });
        if (!lr.ok) return null;
        const lj = await lr.json();
        return (lj && typeof lj.version === 'string' && VERSION_RE.test(lj.version)) ? lj.version : null;
      }
      let best = null;
      for (const v of candidates) if (!best || semverCompare(v, best) > 0) best = v;
      return best;
    } catch (e) { return null; }
  }

  /** GitHub Releases 最新 tag（去除可选 v 前缀）。返回版本号。 */
  async fetchGithubLatest(owner, repo) {
    if (!owner || !repo) return null;
    try {
      const res = await fetch('https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dsh-supervisor' } });
      if (!res.ok) return null;
      const j = await res.json();
      const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
      if (!tag) return null;
      return String(tag).replace(/^v/, '');
    } catch (e) { return null; }
  }

  /**
   * 统一版本检查：channel = 'npm' | 'github'。返回最新版本字符串或 null。
   * @param {object} [opts] { authoritative?: boolean }
   *   authoritative=true：直查发布权威源（registry.npmjs.org）——用于「我们自己发布」的包
   *   （内核自更新等）：镜像（npmmirror 等）同步存在分钟~小时级延迟，把"镜像未同步"
   *   误判为"没有新版本"是真相源错误；镜像仅为安装下载流量服务（可容忍延迟）。
   * @returns Promise<string|null>
   */
  async fetchLatestVersion(pkg, channel, opts) {
    const ch = channel || 'npm';
    const o = opts || {};
    if (ch === 'github') {
      const slash = String(pkg).split('/');
      if (slash.length >= 2) return this.fetchGithubLatest(slash[0], slash.slice(1).join('/'));
      return null;
    }
    return this.fetchNpmLatest(pkg, { authoritative: o.authoritative === true });
  }

  /* ═══════ 安装执行器（统一 npm 安装）═══════
   * 收敛 native（全局 npm install -g）与沙箱（npm install -g --prefix <dir>）
   * 的 npm 安装执行：镜像注入 / 超时 / 行日志 / 退出码 / 进程树清理 全在此一份。
   * @param {object} opts
   *   - pkg: 包名（如 '@deepseek-ai/dsh'）
   *   - version: 目标版本（必须显式；npm 默认装 latest tag 可能不是最高版本）
   *   - prefix: 可选；指定则 --prefix <dir>（沙箱独立安装），缺省为全局
   *   - registry: 可选；注入 npm_config_registry
   *   - timeoutMs: 超时（默认 600s）
   *   - detached: 是否独立进程组（默认 true，便于 killTree）
   *   - onLine: 可选行回调（逐行，已 trim 非空）
   * @returns Promise<{ ok, error, output }> */
  runNpmInstall(opts) {
    const o = opts || {};
    const pkg = o.pkg || '@deepseek-ai/dsh';
    if (!o.version) return Promise.resolve({ ok: false, error: 'runNpmInstall: 缺少 version（必须显式携带）', output: [] });
    // 唯一安装执行器：commandTemplate 支持完整替换命令（测试/特殊环境注入 fake-npm 等），
    // 收敛 native 旧 _runInstall 模板分支的重复 spawn/killTree/超时/行收集实现（2026-09 架构收敛）。
    let argv;
    let bin = 'npm';
    if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
      argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version).replace(/{prefix}/g, o.prefix || ''));
      bin = argv[0];
      argv = argv.slice(1);
    } else {
      argv = ['install', '-g', '--no-audit', '--no-fund'];
      if (o.prefix) argv.push('--prefix', o.prefix);
      argv.push(pkg + '@' + o.version);
    }
    const envVars = Object.assign({}, process.env);
    if (o.registry) { envVars.npm_config_registry = o.registry; envVars.NPM_CONFIG_REGISTRY = o.registry; }
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: envVars, detached: o.detached !== false });
      } catch (e) {
        return resolve({ ok: false, error: e.message, output: [] });
      }
      const out = [];
      const killTree = () => {
        if (!child || child.exitCode !== null) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      };
      const timer = setTimeout(() => {
        killTree();
        resolve({ ok: false, error: '安装超时', output: out });
      }, o.timeoutMs || 600000);
      const onLine = (buf) => {
        for (const l of String(buf).split(/\r?\n/)) {
          const t = l.trim();
          if (!t) continue;
          out.push(t.slice(0, 200));
          if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch {} }
        }
      };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, output: out }); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, error: code === 0 ? null : 'npm install 退出码 ' + code, output: out });
      });
    });
  }

  /* ═══════ 健康验证器（统一端口 + systemd 单元 + 稳定期）═══════
   * 收敛原生与沙箱升级后的启动验证：DSH 进程可能先监听端口、随后因插件兼容
   * 崩溃（如 dsh-mos 引用被移除的 API），只探测端口会误判成功——
   * 必须同时检查 systemd 单元仍 active，并留稳定期防"延迟崩溃"。
   * @param {object} opts
   *   - host: 默认 127.0.0.1
   *   - port: 目标端口（必填）
   *   - unit: 可选 systemd 单元名（如 'dsh-web@main'）；提供则同时校验 is-active
   *   - timeoutMs: 总等待上限（默认 60s）
   *   - stabilityMs: 端口+单元通过后的稳定期（默认 15s，期间再次确认单元仍 active）
   * @returns Promise<{ ok, reason }> */
  waitPortHealthy(opts) {
    const o = opts || {};
    const host = o.host || '127.0.0.1';
    const port = Number(o.port);
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve({ ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port });
    const unit = o.unit || null;
    const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
    const portListening = () => new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch {}
        resolve(ok);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    const unitActive = () => service.isUnitActive(unit); // 平台层判定（无单元视为通过）
    const deadline = Date.now() + (o.timeoutMs || 60000);
    return (async () => {
      while (Date.now() < deadline) {
        if (await portListening() && unitActive()) {
          // 稳定期：插件加载可能在端口监听之后才失败，确认单元在稳定期后仍 active。
          // ⚠ 修复（2026-09，实例升级恒判失败的另一根因）：原实现在「剩余时间 < stabilityMs」时
          //   直接 break 返回**失败**——但此刻端口/单元明明是健康的（只是探测来得晚）。
          //   慢启动实例（插件多/首次加载）端口在 25s 后就绪时会被误判「升级后未能启动」→ 触发
          //   不必要的回滚。现改为：用**剩余预算**做缩短的稳定期复检（不漏判、不超 deadline）。
          const remain = deadline - Date.now();
          const wait = Math.max(0, Math.min(stabilityMs, remain));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          // 稳定期复查必须同时复检端口：只查单元会漏掉 spawn 模式下进程在稳定期内崩溃（端口已空）
          if ((await portListening()) && unitActive()) return { ok: true };
        }
        // 短眠前同样受 deadline 约束（剩余 <2s 不再空转一轮）
        const remain = deadline - Date.now();
        if (remain <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(2000, remain)));
      }
      return { ok: false, reason: '端口 ' + port + ' 未就绪' + (unit ? ' 或单元 ' + unit + ' 未保持 active' : '') };
    })();
  }

}

module.exports = {
  DistributionManager,
  semverCompare,
  VERSION_RE,
};
