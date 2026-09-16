'use strict';

// ═════════════════════════════════════════════════════════════════════════
// 插件域（domain：plugin）—— 门面（组合 + 导出）
//
// 域内分层（DOMAIN-STRUCTURE-DESIGN §5.4，单向依赖）：
//   model / policies（纯）→ targets / cli / store（叶子 IO）
//   → layers（写+串行队列）→ jobs（纯状态作业服务）→ restart
//   → ops / updater（编排）→ index（组合根）。
//   jobs.js 对 ops.js **零出边** → 旧 this 调用环 {ops,jobs,store} 物理消失；
//   store.listInstalled(ctx, targets) 收 targets 入参 → store→ops 反向边消除。
//
// 组合手法：构造期创建有状态协作方（jobs / layers），其余经 ctx 显式传入模块函数。
//    门面保留**同名可覆盖的转发方法**（resolveTargets/installedOn/_runCli/
//   _setBundleEnabledInner/_scrubPluginLayersInner/_removeFromProfileBundles 等）——
//   既有测试以实例属性桩替换这些名字（test/plugin-change-restart、test/round13）。
//   转发是显式一行，不构成隐式 this 耦合。
//    原 Object.assign(PluginManager.prototype, ...) 已删除（R6 硬失败形态）。
// ══════════════════════════════════════════════════════════════════════════

const { PROTECTED } = require('./model');
const store = require('./store');
const targets = require('./targets');
const cli = require('./cli');
const restart = require('./restart');
const { createJobs } = require('./jobs');
const { createLayers } = require('./layers');
const ops = require('./ops');
const updater = require('./updater');
const { PluginMarket } = require('./market');

class PluginManager {
  constructor(opts) {
    this.dshBin = opts.dshBin || 'dsh';
    this.profileName = opts.profileName || 'web';
    this.profileDir = opts.profileDir;         // 原生 profile 目录
    this.overlayFile = opts.overlayFile;
    this.dshPort = opts.dshPort;
    this.instances = opts.instances || null;   // InstanceManager（实例目标数据源）
    this.onNativeRestart = opts.onNativeRestart || null; // 原生 DSH 重启回调（supervisor 注入）
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.tasks = opts.tasks || null;           // 统一安装/更新任务注册表
    this._updCache = {};                       // 插件更新检测缓存：name -> { latest, at }（TTL 6h）
    this._updTTL = 6 * 3600 * 1000;
    this.jobs = createJobs({ tasks: this.tasks });                          // 作业表 + 作用域互斥
    this.layers = createLayers({ overlayFile: this.overlayFile, logger: this.logger }); // 补丁层写队列
    this.store = new store.PluginStore({ getInventory: () => this.inventory() });       // 补丁行 id 推导
  }

  // ── 目标解析（可覆盖）──
  resolveTargets(str) { return targets.resolveTargets(this, str); }
  _nativeTarget() { return targets.nativeTarget(this); }
  _sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }
  _allSandboxTargets() { return targets.allSandboxTargets(this); }

  // ── 只读（可覆盖）──
  installedOn(target) { return store.installedOn(target, PROTECTED); }
  inventory() { return store.inventory(this.dshPort); }
  readManifest() { return store.readManifest(this.profileDir); }
  overlayEntries() { return store.overlayEntries(this.overlayFile); }
  listInstalled() { return ops.listInstalled(this); }

  // ── 补丁层（可覆盖转发；队列/内层在 layers 服务）──
  setBundleEnabled(name, on, targetStr) {
    return this.layers.enqueue('setBundleEnabled', () => this._setBundleEnabledInner(name, on, targetStr));
  }
  _setBundleEnabledInner(name, on, targetStr) { return this.layers.applyBundleEnabled(this, name, on, targetStr); }
  _scrubPluginLayers(target, name, onLog) {
    return this.layers.enqueue('scrub', () => this._scrubPluginLayersInner(target, name, onLog));
  }
  _scrubPluginLayersInner(target, name, onLog) { return this.layers.scrubPluginLayersInner(this, target, name, onLog); }
  _removeFromProfileBundles(target, pluginName) { return this.layers.removeFromProfileBundles(target, pluginName); }
  _readHomePatch(target) { return store.readHomePatch(target); }
  _writeHomePatch(target, entries) { return this.layers.writeHomePatch(target, entries); }
  saveOverlayEntries(entries) { return this.layers.saveOverlayEntries(entries); }

  // ── CLI 执行 / 变更生效 ──
  _runCli(target, args, opts) {
    return cli.runCli({ target, args, opts, registryOrigin: () => cli.registryOrigin(this.dist), logger: this.logger });
  }
  _targetRunning(target) { return restart.targetRunning(this, target); }
  _applyPluginChange(target, kind, onLog) { return restart.applyPluginChange(this, target, kind, onLog); }

  // ── 编排 / 作业 ──
  install(spec, opts) { return ops.install(this, spec, opts); }
  uninstall(name, targetStr) { return ops.uninstall(this, name, targetStr); }
  installStatus(jobId) { return this.jobs.installStatus(jobId); }
  checkUpdates(force) { return updater.checkUpdates(this, force); }
  update(name, targetStr) { return updater.update(this, name, targetStr); }
}

module.exports = { PluginManager, PluginMarket, PROTECTED };
