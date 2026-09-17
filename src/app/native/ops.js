'use strict';

// 域：原生 DSH（app/native）—— 安装/卸载/状态/更新检查编排。
// 纯编排 + 卸载进程治理（spawn + 超时看门狗）；原子操作经 host-first 调用 NativeManager。

const fs = require('node:fs');
const spawnOS = require('../../platform/os/spawn');
const { killTree } = require('../../platform/os/process');
const { npmExe, npmExeArgs } = require('./npm');
const policies = require('./policies');

const PKG_DEFAULT = '@deepseek-ai/dsh';

/** 安装状态（含版本 + 任务进度，供前端即时渲染）。 */
function status(host) {
  const bin = host.binPath();
  const installed = host.installedVersion();
  const activeTask = host.tasks ? host.tasks.current('native', 'main') : null;
  let state;
  if (host.installing || (activeTask && activeTask.action === 'install' && activeTask.state === 'running')) state = 'installing';
  else if (host.uninstalling || (activeTask && activeTask.action === 'uninstall' && activeTask.state === 'running')) state = 'uninstalling';
  else state = installed ? 'installed' : 'uninstalled';
  return {
    installed: installed !== null && installed !== '',
    version: installed || null,
    binPath: bin,
    executable: bin ? fs.existsSync(bin) : false,
    state,
    installLog: host.installLog.slice(-8),
    lastInstall: host.lastInstall,
    lastUninstall: host.lastUninstall,
    task: activeTask ? host.tasks.view(activeTask) : null,
  };
}

/** 版本检测：未安装时静默；已安装时比较最新版（网络故障与「无更新」如实区分）。 */
async function checkUpdate(host) {
  if (host.checkingNow) return policies.versionInfo(host, host.installedVersion());
  host.checkingNow = true;
  try {
    const installed = host.installedVersion();
    if (!installed) {
      host.lastCheck = { at: new Date().toISOString(), installed: null, latest: null, updateAvailable: false, note: 'not-installed' };
      return policies.versionInfo(host, installed);
    }
    const latest = await host._latestVersion();
    host.lastCheck = {
      at: new Date().toISOString(), installed, latest,
      updateAvailable: latest ? policies.isNewer(latest, installed) : false,
      error: latest ? null : '镜像源不可达或未查询到版本',
    };
    if (host.events) host.events.append('version_checked', { installed, latest, updateAvailable: host.lastCheck.updateAvailable });
  } catch (e) {
    host.lastCheck = { ...(host.lastCheck || {}), at: new Date().toISOString(), installed: host.installedVersion(), error: e.message, updateAvailable: false };
    if (host.events) host.events.append('version_check_failed', { message: e.message });
  } finally {
    host.checkingNow = false;
  }
  return policies.versionInfo(host, host.installedVersion());
}

/** 开统一任务（install/uninstall 共用）。 */
function beginTask(host, action, meta) {
  if (!host.tasks) return null;
  const task = host.tasks.begin('native', action, { id: 'main', name: '原生 DeepSeek Harness' }, meta);
  host.tasks.start(task.id);
  return task;
}

/** 安装执行（安装/升级/回滚共用 _runInstall 核心）。 */
async function install(host, version) {
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  const env = host.checkEnvironment();
  if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
  // 并发锁必须在任何 await 之前置位（否则并发 POST 会在 await 间隙同时通过检查）。
  host.installing = true;
  host.installLog = [];
  const task = beginTask(host, 'install', { to: version || null, createdBy: 'user' });
  let target = version;
  // 锁释放统一走 finally：本函数缺它时与 uninstallOrCleanup 不对称，而锁一旦滞留，
  //   startInstall/startUninstall 与升级的并发闸会永久拒绝全部安装类操作。
  //   现状「每一环调用都自带守卫」，故暂无已知可达的抛出路径（逐路径核验见
  //   design-notes/_p4-e-uncertain.md §1.2）；此处是补健壮性，不是修在跑的故障。
  //   下方三处显式置 null 保留：冗余但无害，删它们需先证分支覆盖。
  try {
    if (!target) {
      target = await host._latestVersion().catch(() => null);
      if (!target) {
        host.installing = null;
        if (task) host.tasks.fail(task.id, '无法从镜像源获取最新版本');
        return { ok: false, error: '无法从镜像源获取最新版本' };
      }
    }
    const registry = await host._selectRegistry();
    const pkg = host.config.packageName || PKG_DEFAULT;
    if (task) host.tasks.log(task.id, '安装 ' + pkg + '@' + target + (registry ? ' via ' + registry : ''));
    if (host.events) host.events.append('native_install_started', { version: target, registry });
    if (host.logger.info) host.logger.info('native install: ' + pkg + '@' + target + (registry ? ' via ' + registry : ''));
    const res = await host._runInstall(target, registry);
    if (!res.ok) {
      host.installing = null;
      host.lastInstall = { ok: false, version: null, error: res.error, at: new Date().toISOString(), log: host.installLog.slice(-8) };
      if (host.events) host.events.append('native_install_failed', { error: res.error, output: res.output });
      if (task) host.tasks.fail(task.id, res.error);
      return { ok: false, error: res.error, output: res.output };
    }
    // 数据认领：仅首装（manifest 尚不存在）尝试；~/.dsh 已有用户数据时不认领（防误删）。
    const isFirstInstall = !host._manifest();
    host._recordManifest(target, isFirstInstall ? host._claimDataPaths() : []);
    const ver = host.installedVersion();
    host.installing = null;
    host.lastInstall = { ok: true, version: ver || target, error: null, at: new Date().toISOString(), log: host.installLog.slice(-8) };
    if (host.events) host.events.append('native_installed', { version: target });
    if (host.logger.info) host.logger.info('native installed: ' + (ver || target));
    if (task) { host.tasks.log(task.id, '安装完成，版本 ' + (ver || target)); host.tasks.succeed(task.id); }
    return { ok: true, version: ver || target };
  } finally {
    host.installing = null;
  }
}

/** 启动安装（API 用）：同步前置检查，通过则后台执行并立即返回（进度经 status 轮询）。 */
function startInstall(host, version) {
  if (host.installing) return { ok: false, error: '安装已在进行中' };
  if (host.uninstalling) return { ok: false, error: '卸载进行中，请稍后再装' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，请稍后再装（state=' + host.upgradeState + '）' };
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  const env = host.checkEnvironment();
  if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
  install(host, version).then(() => {}).catch((e) => {
    // 后台任务意外抛错：复位标志并兜底任务注册表（防任务永久 running 占锁）。
    host.installing = null;
    host.lastInstall = { ok: false, version: null, error: e.message, at: new Date().toISOString(), log: host.installLog.slice(-8) };
    if (host.events) host.events.append('native_install_failed', { error: e.message });
    if (host.tasks) {
      try {
        const cur = host.tasks.current('native', 'main');
        if (cur && cur.action === 'install') host.tasks.fail(cur.id, '安装异常: ' + e.message);
      } catch {}
    }
    if (host.logger.error) host.logger.error('native install crashed: ' + e.message);
  });
  return { ok: true, started: true };
}

/** 启动卸载（API 用）：同步前置检查 + 后台执行，立即返回。 */
function startUninstall(host) {
  if (host.installing) return { ok: false, error: '安装进行中，无法卸载' };
  if (host.uninstalling) return { ok: false, error: '卸载已在进行中' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，无法卸载（state=' + host.upgradeState + '）' };
  uninstall(host).then(() => {}).catch((e) => {
    host.uninstalling = null;
    host.lastUninstall = { ok: false, removed: [], error: e.message, at: new Date().toISOString() };
    if (host.events) host.events.append('native_uninstall_failed', { error: e.message });
    if (host.logger.error) host.logger.error('native uninstall crashed: ' + e.message);
  });
  return { ok: true, started: true };
}

/** 卸载：npm uninstall（spawn，不阻塞事件循环），按 manifest 清理数据路径。
 *  超时看门狗：npm 挂起则杀进程树，以明确的「超时」收尾（而非无限等待）。
 *  锁释放由 finally 结构保证（含异常路径）。 */
async function uninstall(host) {
  if (host.tasks && host.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
  if (host.installing) return { ok: false, error: '安装进行中，无法卸载' };
  if (host.uninstalling) return { ok: false, error: '卸载已在进行中' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，无法卸载（state=' + host.upgradeState + '）' };

  host.uninstalling = true;
  try {
    if (host.events) host.events.append('native_uninstall_started', {});
    // 先停运行中的 DSH：运行进程中直接删包/数据文件会懒加载崩溃。
    if (host.hooks && host.hooks.isDshActive && host.hooks.isDshActive()) {
      host._appendUpgradeLog('停止运行中的 DeepSeek Harness…');
      if (host.hooks.stopForUpgrade) await host.hooks.stopForUpgrade();
    }
    const m = host._manifest();
    const removed = [];
    const rm = (p) => {
      if (!p) return;
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
      catch (e) { host.logger.warn && host.logger.warn('uninstall 清理失败: ' + p + ' - ' + e.message); }
    };
    let task = null;
    if (host.tasks) {
      task = host.tasks.begin('native', 'uninstall', { id: 'main', name: '原生 DeepSeek Harness' }, { from: host.installedVersion(), createdBy: 'user' });
      host.tasks.start(task.id);
      host.tasks.log(task.id, '卸载 ' + (host.config.packageName || PKG_DEFAULT));
    }
    const pkg = host.config.packageName || PKG_DEFAULT;
    const uninstallArgs = ['uninstall', '-g'];
    if (host.npmRoot) uninstallArgs.push('--prefix', host.npmRoot);
    uninstallArgs.push(pkg);
    // 超时可注入（测试用）：默认与 Rust 侧 npm 上限（15min）同量级。
    const UNINSTALL_TIMEOUT_MS = (typeof host.config.uninstallTimeoutMs === 'number' && host.config.uninstallTimeoutMs > 0)
      ? host.config.uninstallTimeoutMs : 15 * 60 * 1000;
    let uninstallTimedOut = false;
    const exitCode = await new Promise((resolve) => {
      let child;
      try {
        child = spawnOS.piped(npmExe(host), npmExeArgs(host).concat(uninstallArgs));
      } catch (e) { return resolve(-1); }
      child.stdout.resume(); child.stderr.resume();
      let done = false;
      const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve(code); };
      const timer = setTimeout(() => {
        uninstallTimedOut = true;
        host.logger.warn && host.logger.warn('npm uninstall 超时（' + Math.round(UNINSTALL_TIMEOUT_MS / 1000) + 's），终止进程树');
        try {
          killTree(child.pid, 'SIGKILL', () => finish(-1));
        } catch (e) {
          try { child.kill('SIGKILL'); } catch (e2) {}
          finish(-1);
        }
      }, UNINSTALL_TIMEOUT_MS);
      if (timer.unref) timer.unref(); // 不因看门狗阻止进程退出
      child.on('error', () => finish(-1));
      child.on('exit', (code) => finish(code == null ? -1 : code));
    });
    if (exitCode === 0 && m) {
      if (m.packageDir) rm(m.packageDir);
      if (m.binPath) rm(m.binPath);
      for (const p of (m.dataPaths || [])) rm(p);
    }
    // 卸载失败时不得删除 manifest：保留以便重试与如实上报。
    if (exitCode === 0) {
      rm(host.manifestFile);
    } else {
      host.logger.warn && host.logger.warn('npm uninstall exit ' + exitCode + '，保留 manifest 以便重试（数据路径未删）');
    }
    const uninstallError = exitCode === 0 ? null
      : (uninstallTimedOut
        ? ('npm uninstall 超时（' + Math.round(UNINSTALL_TIMEOUT_MS / 1000) + 's）已终止，包可能仍在，可重试')
        : ('npm uninstall 退出码 ' + exitCode));
    host.lastUninstall = { ok: exitCode === 0, removed, error: uninstallError, timedOut: uninstallTimedOut, at: new Date().toISOString() };
    if (host.events) host.events.append('native_uninstalled', { removed });
    if (host.logger.info) host.logger.info('native uninstalled, removed ' + removed.length + ' paths');
    if (task) {
      if (exitCode === 0) { host.tasks.log(task.id, '卸载完成，清理 ' + removed.length + ' 个路径'); host.tasks.succeed(task.id); }
      else host.tasks.fail(task.id, 'npm uninstall 退出码 ' + exitCode);
    }
    return { ok: exitCode === 0, removed, timedOut: uninstallTimedOut, error: uninstallError };
  } finally {
    host.uninstalling = null;
  }
}

module.exports = { status, checkUpdate, install, startInstall, startUninstall, uninstall };
