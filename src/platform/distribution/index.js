'use strict';

// 统一的「包发布/安装/更新」平台能力（原 domains/dist 域解体上移）。
// 它不是业务域而是通用基础设施（消费者横跨 root/daemon/instance），故归 platform/，与
// platform/contract、platform/os 同层。本文件是薄门面，只做组合与导出，不含算法/IO：
//   release.js 选版算法（纯）        policies.js 纯策略（镜像合法性/探测规格/合并）
//   registry.js 镜像选择与探测（IO） install.js npm 安装 + 端口健康 + 版本检查（IO）

const policies = require('./policies');
const release = require('./release');
const registry = require('./registry');
const install = require('./install');
// semver 合法性与比较器的唯一实现在 shared/version.js。
const { semverCompare, VERSION_RE } = require('../../shared/version');

/**
 * 统一分发管理器：门面。状态字段由本实例持有，实现函数显式收参（零跨文件 this）。
 *
 * @param {object} opts
 *   - registries: 候选镜像源（默认来自 config.registries）
 *   - registryFile: 全局镜像配置持久化路径（mode/origins/manualOrigin）
 *   - events / logger
 *   - canary: 本机灰度事实（默认 false）
 */
class DistributionManager {
  constructor(opts) {
    opts = opts || {};
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    // 最小兜底（仅契约不可用时用；见 policies.FALLBACK_REGISTRIES）。
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...policies.FALLBACK_REGISTRIES];
    // 壳投放的镜像契约（目录 + 选择结果 + 探测规格）。
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, selected: null };
    // 全局镜像配置：mode auto|manual，origins 候选，manualOrigin 手动固定。从 registryFile 加载。
    this.registryConfig = { mode: 'auto', origins: [...this.defaultRegistries], manualOrigin: this.defaultRegistries[0] || '' };
    // 灰度事实：组装根注入「本机配置 canary:true / DSH_CANARY=1」。
    this.canary = opts.canary === true;
    this.selectedRegistry = null; // { origin, latencyMs, checkedAt, manual, source }
    // 注意：必须同时记「刚载入」时刻，否则首次 _reloadContractIfStale 会把 undefined 当成「从未载入」。
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
  // 选版算法（release.js 唯一实现）+ 包归属判定
  pickReleaseVersion: release.pickReleaseVersion,
  isOurReleasePackage: release.isOurReleasePackage,
  OUR_RELEASE_SCOPE: release.OUR_RELEASE_SCOPE,
};
