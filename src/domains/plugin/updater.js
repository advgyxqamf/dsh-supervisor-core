'use strict';

// 插件域更新检测与执行（网络 + CLI 编排）。
// 查 registry 最高版 vs 已装版；npm 型走 update，失败退 add；git/local 型拒绝。
// 检测缓存（_updCache/_updTTL）挂在装配根，经 ctx 显式访问。

const { specType, isUpdateAvailable } = require('./policies');

/** 检测：聚合各目标已装插件，标出可更新项（npm 型查 registry 最高版）。 */
async function checkUpdates(ctx, force) {
  const targets = [ctx._nativeTarget(), ...ctx._allSandboxTargets()];
  const meta = new Map();
  for (const t of targets) {
    for (const p of ctx.installedOn(t)) {
      if (meta.has(p.name)) continue;
      const st = specType(p.source);
      let latest = null;
      const c = ctx._updCache[p.name];
      if (c && !force && (Date.now() - c.at) < ctx._updTTL) latest = c.latest;
      else {
        // 插件均为第三方 npm 包：维持「取全量最高」语义（他人 tag 策略不受控）。
        if (st === 'npm' && ctx.dist) { try { latest = await ctx.dist.fetchNpmLatest(p.name); } catch {} }
        // 只在**取到**时写缓存：失败（latest=null）若写进去，等于把「registry 不可达」负缓存
        // _updTTL 之久，此后 checkUpdates 一律显示「无更新」且不再重试（backlog #13）。
        if (latest !== null) ctx._updCache[p.name] = { latest, at: Date.now() };
      }
      meta.set(p.name, { specType: st, latest });
    }
  }
  const rows = [];
  for (const t of targets) {
    for (const p of ctx.installedOn(t)) {
      const m = meta.get(p.name) || { specType: 'npm', latest: null };
      const updateAvailable = m.specType === 'npm' && isUpdateAvailable(m.latest, p.version);
      rows.push({ name: p.name, target: t.id, targetName: t.name, installed: p.version || null, latest: m.latest || null, updateAvailable, specType: m.specType, bundle: p.bundle });
    }
  }
  const byName = new Map();
  for (const row of rows) {
    let rec = byName.get(row.name);
    if (!rec) { byName.set(row.name, { name: row.name, specType: row.specType, targets: [] }); rec = byName.get(row.name); }
    rec.targets.push({ id: row.target, name: row.targetName, installed: row.installed, latest: row.latest, updateAvailable: row.updateAvailable });
  }
  const plugins = [...byName.values()].map((x) => ({ name: x.name, specType: x.specType, updateAvailable: x.targets.some((t) => t.updateAvailable), targets: x.targets })).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, checkedAt: Date.now(), plugins };
}

/** 执行更新：逐目标串行（npm update，失败退 add）；成功后重启生效。 */
async function update(ctx, name, targetStr) {
  if (!name) return { ok: false, error: 'missing plugin name' };
  const r = ctx.resolveTargets(targetStr);
  if (!r.ok) return r;
  const targets = r.targets.filter((t) => ctx.installedOn(t).some((p) => p.name === name));
  if (!targets.length) { const desc = targetStr === 'all' ? '任何目标' : ('目标「' + (targetStr || 'native') + '」'); return { ok: false, error: desc + ' 未安装插件 ' + name }; }
  let latest = null;
  const c = ctx._updCache[name];
  if (c && (Date.now() - c.at) < ctx._updTTL) latest = c.latest;
  else {
    if (ctx.dist) { try { latest = await ctx.dist.fetchNpmLatest(name); } catch {} }
    // 与 checkUpdates 同一负缓存口径（同文件第二处写入点，同类缺陷一并收口）：取失败不写缓存。
    if (latest !== null) ctx._updCache[name] = { latest, at: Date.now() };
  }
  if (!latest) return { ok: false, error: '无法获取 ' + name + ' 的最新版本（registry 不可达），请检查网络后重试' };
  const job = ctx.jobs.createJob('update', name, targetStr || 'native', targets);
  if (ctx.events) ctx.events.append('plugin_update_started', { name, jobId: job.id, target: job.target, targets: targets.map((t) => t.name) });
  let idx = 0;
  const next = () => {
    if (idx >= job.targets.length) {
      const failed = job.targets.filter((t) => t.state === 'failed');
      const ok = failed.length === 0;
      ctx.jobs.finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
      if (ctx.events) {
        if (ok) ctx.events.append('plugin_update_done', { name, jobId: job.id });
        else ctx.events.append('plugin_update_job_failed', { name, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
      }
      return;
    }
    const target = targets[idx], jt = job.targets[idx];
    jt.state = 'running';
    ctx.jobs.withScopeLock(target.id, async () => {
      let res;
      const installed = ctx.installedOn(target).find((x) => x.name === name);
      const st = installed ? specType(installed.source) : 'npm';
      if (st !== 'npm') {
        res = { ok: false, error: '本地/git 型插件不支持 registry 更新（spec: ' + (installed && installed.source) + '）' };
      } else if (!installed || !isUpdateAvailable(latest, installed.version)) {
        res = { ok: true, skipped: true, error: null };
        jt.log.push('已是最新版本（' + (installed && installed.version || '?') + '）');
      } else {
        res = await ctx._runCli(target, ['update', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
        if (!res.ok) {
          const addRes = await ctx._runCli(target, ['add', name + '@' + latest], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } });
          if (addRes.ok) { res = { ok: true, error: null }; jt.log.push('已通过 add 确立依赖并更新'); }
        }
      }
      jt.state = res.ok ? 'done' : 'failed';
      jt.error = res.ok ? null : (res.error || '');
      if (!(res && res.skipped)) jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
      if (ctx.events) ctx.events.append(res.ok ? 'plugin_update_ok' : 'plugin_update_failed', { name, target: target.name, jobId: job.id, error: res.error });
      if (res.ok && !res.skipped) await ctx._applyPluginChange(target, 'update', (m) => jt.log.push(m));
    }).then(() => { idx++; next(); });
  };
  next();
  return { ok: true, jobId: job.id, target: job.target };
}

module.exports = { checkUpdates, update };
