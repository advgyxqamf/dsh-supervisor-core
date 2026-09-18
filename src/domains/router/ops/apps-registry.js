'use strict';

// 反代应用注册表与更新（IO）。deps 注入：{getProviders, proxyUpdateCache, dist, events, tasks, save, logger}。
// 更新 job 状态收敛于本工厂闭包（jobs）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROXY_APPS } = require('../proxy-apps');
const { semverCompare } = require('../../../shared/version');

function createAppsRegistryOps(deps) {
  const d = deps || {};
  const getProviders = d.getProviders || (() => []);
  const cache = d.proxyUpdateCache || {};
  const dist = d.dist || null;
  const events = d.events || null;
  const tasks = d.tasks || null;
  const save = d.save || (() => {});
  const logger = d.logger || null;
  const jobs = {};

  function proxyApps() {
    return Object.values(PROXY_APPS).map((a) => {
      const c = cache[a.id] || {};
      const instVers = [];
      for (const p of getProviders() || []) {
        if (p.kind === 'proxy' && p.proxyAppId === a.id) {
          for (const inst of (p.instances || [])) if (inst.version) instVers.push(inst.version);
        }
      }
      let installed = null;
      for (const v of instVers) if (!installed || semverCompare(v, installed) > 0) installed = v;
      const updateAvailable = !!(c.latest && installed && semverCompare(c.latest, installed) > 0);
      return { id: a.id, name: a.name, pkg: a.pkg, healthPath: a.healthPath, modelPath: a.modelPath, real: !!a.real, upstream: a.upstream, repo: a.repo, registry: a.registry || null, latest: c.latest || null, installed: installed || null, updateAvailable, checkedAt: c.checkedAt || null, error: c.error || null };
    });
  }

  async function refreshProxyUpdateInfo(force) {
    const results = {};
    for (const a of Object.values(PROXY_APPS)) {
      if (!a.registry) { results[a.id] = null; continue; }
      const c = cache[a.id] || {};
      const now = Date.now();
      if (!force && c.latest && c.checkedAt && (now - c.checkedAt) < (a.versionRefreshMs || 6 * 3600 * 1000)) { results[a.id] = c.latest; continue; }
      let ver = null;
      try { if (dist) ver = await dist.fetchNpmLatest(a.registry); } catch {}
      const prev = c.latest || null;
      cache[a.id] = { pkg: a.registry, latest: ver, checkedAt: Date.now(), error: ver ? null : 'query failed' };
      // 仅存在旧基线且版本真实变化才发事件（冷启动首查不视为新版本）
      if (ver && prev && ver !== prev && events) events.append('proxy_update_available', { appId: a.id, pkg: a.registry, from: prev, to: ver });
      results[a.id] = ver;
    }
    return results;
  }

  /** 反代更新（job 模型）：立即返回 jobId，异步 stop->start 各实例，前端经 proxyUpdateStatus 轮询。 */
  async function applyProxyUpdate(appId) {
    const a = PROXY_APPS[appId];
    if (!a) return { ok: false, error: 'unknown app ' + appId };
    const targets = (getProviders() || []).filter((p) => p.kind === 'proxy' && p.proxyAppId === appId && (p.instances || []).length);
    if (!targets.length) return { ok: false, error: 'no running ' + a.name + ' instances' };
    if (jobs[appId] && jobs[appId].state === 'running') return { ok: true, jobId: appId, already: true };
    // #5：步骤集只快照「标签」（providerId+keyId+maskedKey）；执行时按 keyId 重取活实例，
    //  否则常驻实例在 stop/start 之间被重建后仍用旧引用（静默空转/假成功）。
    const insts = targets.flatMap((provider) => (provider.instances || []).map((i) => ({ providerId: provider.id, keyId: i.keyId, maskedKey: i.maskedKey })));
    const job = {
      state: 'running', startedAt: Date.now(), finishedAt: null, restarted: 0, errors: 0,
      steps: insts.map(({ maskedKey }) => ({ name: maskedKey, state: 'pending', ts: null, reason: null })),
    };
    jobs[appId] = job;
    let task = null;
    if (tasks) {
      task = tasks.begin('proxy-app', 'update', { id: appId, name: a.name }, { to: a.registry, createdBy: 'user' });
      tasks.start(task.id);
      tasks.log(task.id, '更新 ' + a.name + '（' + a.registry + '）');
      // 逐实例步骤登记进统一 task（前端进度事实源）；job.steps 与 task.steps 同源更新。
      for (const { maskedKey } of insts) tasks.step(task.id, maskedKey);
      job.taskId = task.id;
    }
    (async () => {
      // 0) 清除该 app 的 npx 缓存（强制重新拉取最新版）
      try {
        const npxDir = path.join(os.homedir(), '.npm', '_npx');
        if (fs.existsSync(npxDir)) {
          for (const dir of fs.readdirSync(npxDir)) {
            if (!/^[0-9a-f]{8,}$/i.test(dir)) continue;
            const pkgDir = path.join(npxDir, dir, 'node_modules', a.pkg);
            if (fs.existsSync(pkgDir)) {
              try { fs.rmSync(path.join(npxDir, dir), { recursive: true, force: true }); } catch {}
            }
          }
        }
      } catch {}
      const setStep = (i, state, reason) => {
        job.steps[i].state = state; job.steps[i].ts = Date.now();
        if (reason) job.steps[i].reason = reason;
        if (task) { try { tasks.stepState(task.id, i, state); } catch {} }
      };
      // #5：按 keyId 重取活实例；取不到即如实失败（不静默空转）。
      const resolveStep = (i) => {
        const { providerId, keyId } = insts[i];
        const p = (getProviders() || []).find((x) => x.id === providerId);
        const inst = p && (p.instances || []).find((x) => x.keyId === keyId);
        if (p && inst) return { provider: p, inst };
        if (job.steps[i].state !== 'failed') {
          job.errors++;
          setStep(i, 'failed', '实例已不存在（可能已被移除或重建）');
          if (task) { try { tasks.log(task.id, '跳过 ' + insts[i].maskedKey + '：实例已不存在'); } catch {} }
        }
        return null;
      };
      for (let i = 0; i < insts.length; i++) {
        const live = resolveStep(i);
        if (!live) continue;
        setStep(i, 'stopping');
        // force=true：在用/常驻实例不带 force 只会挂待停标记，进程未死则随后的 startInstance
        // 因 pid 仍在返回 already:true，job 报 done 而旧进程从未重启（假成功）。
        try { live.provider.stopInstance(live.inst, true); } catch (e) { job.errors++; setStep(i, 'failed', (e && e.message) || '停止失败'); }
      }
      await new Promise((r) => setTimeout(r, 600));
      for (let i = 0; i < insts.length; i++) {
        const live = resolveStep(i);
        if (!live) continue;
        const { provider, inst } = live;
        if (!inst.key) { job.errors++; setStep(i, 'failed', '实例缺 key'); continue; }
        setStep(i, 'starting');
        const r = await provider.startInstance(inst);
        if (r.ok) {
          job.restarted++;
          await provider._waitHealthy(inst).catch(() => false);
          setStep(i, 'done');
        } else { job.errors++; setStep(i, 'failed', (r && r.error) || '启动失败'); }
      }
      // 供应商对象同样重取（targets 是创建时快照）；只对仍存在的置 proxyRunning。
      for (const providerId of new Set(insts.map((s) => s.providerId))) {
        const p = (getProviders() || []).find((x) => x.id === providerId);
        if (p) p.proxyRunning = true;
      }
      save();
      job.state = job.errors === 0 ? 'done' : 'failed';
      job.finishedAt = Date.now();
      if (events) events.append('proxy_update_applied', { appId, restarted: job.restarted, errors: job.errors });
      cache[appId] = Object.assign({}, cache[appId], { appliedAt: Date.now() });
      if (task && tasks) {
        if (job.state === 'done') { tasks.log(task.id, '更新完成，重启 ' + job.restarted + ' 个实例'); tasks.succeed(task.id); }
        else tasks.fail(task.id, '更新失败（' + job.errors + ' 个实例错误）');
      }
    })().catch((e) => {
      job.state = 'failed'; job.finishedAt = Date.now(); job.errors++;
      if (logger && logger.warn) logger.warn('applyProxyUpdate 异常: ' + e.message);
      if (task && tasks) tasks.fail(task.id, '更新异常: ' + (e && e.message));
    });
    return { ok: true, jobId: appId };
  }

  /** 更新进度查询（优先统一任务；无历史任务回退 job）。 */
  function proxyUpdateStatus(appId) {
    const t = tasks ? tasks.list('proxy-app').find((x) => x.target.id === appId) : null;
    if (t) {
      // #30：此 taskState→job.state 映射与 instance/model.js 的 taskStateToView、plugin/model.js 的
      // taskStateToJobState **三份有意平行**（各有各的状态词表：本处是代理应用更新进度，另两处分别是
      // 实例视图态 / 插件 job 态）。跨域抽公共纯函数需三处同批改动并回归各自门禁，故此处不抽；
      // 任一状态词表变更时，三处一并核对。
      return {
        state: (t.state === 'succeeded' || t.state === 'skipped') ? 'done' : (t.state === 'failed' || t.state === 'canceled') ? 'failed' : 'running',
        restarted: (t.steps.filter((s) => s.state === 'done')).length,
        errors: t.state === 'failed' ? 1 : 0,
        startedAt: t.startedAt, finishedAt: t.finishedAt,
        steps: t.steps.map((s) => ({ name: s.name, state: s.state })),
        taskId: t.id,
      };
    }
    const job = jobs[appId];
    if (!job) return { error: 'no update job for ' + appId };
    return {
      state: job.state, restarted: job.restarted, errors: job.errors,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      steps: job.steps.map((s) => ({ name: s.name, state: s.state, reason: s.reason || null })),
    };
  }

  return { proxyApps, refreshProxyUpdateInfo, applyProxyUpdate, proxyUpdateStatus };
}

module.exports = { createAppsRegistryOps };
