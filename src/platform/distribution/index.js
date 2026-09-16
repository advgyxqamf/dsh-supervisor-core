'use strict';

// 统一的「包发布/安装/更新」**平台能力**（结构设计 §3/§4.3：原 domains/dist 域解体上移）。
//
// 为什么在 platform/ 而不在 domains/：它不是业务域——「从发布通道取包并安装」是
// 与 platform/contract、platform/os 同层的通用基础设施，消费者横跨 root、daemon、instance 等多处。
//
// 核心抽象：凡是从「外部发布通道」获取并安装软件的地方，都共用同一套：
//   - 全局 npm 镜像源配置（一个来源，自动适配国内网络/手动固定）
//   - 版本检查（npm registry + GitHub Releases，按 channel 抽象）
//   - 版本比较（semver）
//   - 安装命令执行（注入选中镜像）
//
// 本文件是**薄门面**：只做组合与导出，不含算法/IO。实现分层：
//   release.js  选版算法（纯）        policies.js  纯策略（镜像合法性/探测规格/合并）
//   registry.js 镜像选择与探测（IO）  install.js   npm 安装 + 端口健康 + 版本检查（IO）

const policies = require('./policies');
const release = require('./release');
const registry = require('./registry');
const install = require('./install');
// 合法 semver 与比较器的**唯一实现**已上移到 src/shared/version.js（结构设计 §4.3）。
const { semverCompare, VERSION_RE } = require('../../shared/version');

/**
 * 统一分发管理器：门面。状态字段由本实例持有，实现函数显式收参（零 this 跨文件，DF-4）。
 *
 * @param {object} opts
 *   - registries: 候选镜像源（默认来自 config.registries）
 *   - registryFile: 全局镜像配置持久化路径（mode/origins/manualOrigin）
 *   - events: 事件总线（可选）
 *   - logger
 *   - canary: 本机灰度事实（默认 false）
 */
class DistributionManager {
  constructor(opts) {
    opts = opts || {};
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    // 最小兜底（契约不可用时才用；见 policies.FALLBACK_REGISTRIES 注释）。
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...policies.FALLBACK_REGISTRIES];
    // 壳投放的镜像契约（目录 + 选择结果 + **探测规格**）。
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, selected: null };
    // 全局镜像配置：mode auto|manual，origins 候选，manualOrigin 手动固定。从 registryFile 加载。
    this.registryConfig = { mode: 'auto', origins: [...this.defaultRegistries], manualOrigin: this.defaultRegistries[0] || '' };
    // 灰度事实（契约 §5.4）：组装根注入「本机配置 canary:true / DSH_CANARY=1」。
    this.canary = opts.canary === true;
    this.selectedRegistry = null; // { origin, latencyMs, checkedAt, manual, source }
    // ⚠ 同时记「刚载入」时刻，否则首次 _reloadContractIfStale 会把 undefined 当成「从未载入」。
    registry.loadRegistryConfig(this);
    this._contractLoadedAt = Date.now();
  }

  // ---- 镜像源（registry.js）----
  _reloadContractIfStale() { registry.reloadContractIfStale(this); }
  _loadRegistryConfig() { registry.loadRegistryConfig(this); }
  _saveRegistryConfig() { registry.saveRegistryConfig(this); }
  _platformTag() { return registry.platformTag(); }
  _probeRegistry(origin) { return registry.probeRegistry(this, origin); }
  probeOrigin(origin) { return registry.probeOrigin(this, origin); }
  _registryOrigins() { return registry.registryOrigins(this); }
  selectRegistry(force) { return registry.selectRegistry(this, force); }
  registryInfo() { return registry.registryInfo(this); }
  setRegistryConfig(cfg) { return registry.setRegistryConfig(this, cfg); }
  _inCanaryList() { return policies.isInCanaryList(this); }

  // ---- 版本检查 / 安装 / 健康（install.js）----
  fetchNpmLatest(pkg, opts) { return install.fetchNpmLatest(this, pkg, opts); }
  fetchGithubLatest(owner, repo) { return install.fetchGithubLatest(owner, repo); }
  fetchLatestVersion(pkg, channel, opts) { return install.fetchLatestVersion(this, pkg, channel, opts); }
  runNpmInstall(opts) { return install.runNpmInstall(opts); }
  waitPortHealthy(opts) { return install.waitPortHealthy(opts); }
}

module.exports = {
  DistributionManager,
  semverCompare,
  VERSION_RE,
  // 选版算法（契约 §3 唯一实现，release.js）+ 包归属判定（契约 §1 边界）
  pickReleaseVersion: release.pickReleaseVersion,
  isOurReleasePackage: release.isOurReleasePackage,
  OUR_RELEASE_SCOPE: release.OUR_RELEASE_SCOPE,
};
