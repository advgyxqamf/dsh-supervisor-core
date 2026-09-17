'use strict';

// 编排：实例 CRUD 顺序 + 兜底定时器 + 外部钩子外发。
// 持久化/沙箱目录/端口登记经 store/sandbox/ports，启停与监督经 deps.lifecycle，
// 版本/作业视图经 deps.upgrade（组装根注入）。无隐式 this。

const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const model = require('./model');
const sandbox = require('./sandbox');

function createOps(deps) {
  const { store, lifecycle, upgrade, service, logger, events, tokens, tasks, hooks, instancesRoot } = deps;
  let timer = null;

  /** 单实例映射到前端契约行（IO 结果由 upgrade/lifecycle 解析后传入纯 model.viewRow）。 */
  function list() {
    return store.instances.map((inst) => {
      const info = upgrade.versionInfo(inst);
      return model.viewRow(inst, {
        version: info.version,
        latest: info.latest,
        updateJob: upgrade.jobView(inst),
        probe: lifecycle.probe(inst),
      });
    });
  }

  /** 新增实例：生成独立 unit 名 + 独立配置。sandbox 默认标准隔离。 */
  async function addInstance(payload) {
    const port = parseInt(payload.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效端口' };
    if (store.instances.some((i) => i.port === port)) return { ok: false, error: '端口 ' + port + ' 已被实例占用' };
    const id = 'inst-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    // 新增时必须探测端口是否真的被占用（注册表 ∪ 本机实际监听）：只查实例重名与注册表，
    // 会建到被占端口后 bind 失败并陷入 BACKOFF 反复重试。
    try {
      if (await ports.isTaken(port)) {
        return { ok: false, error: '端口 ' + port + ' 已被占用（本机已有进程在监听，或已被系统服务登记）' };
      }
    } catch { /* 探测失败不阻断创建：交给启动期如实报错 */ }
    // 端口登记入口严格校验（同步）：实例端口必须避开全部系统端口与动态池。
    try { ports.registerUser(port, 'inst:' + id); } catch (e) { return { ok: false, error: '端口 ' + port + ' 与系统服务端口冲突（' + (e.message || e) + '）' }; }
    const inst = model.createRecord(payload, id);
    store.instances.push(inst);
    store.save();
    lifecycle._prepareSystemd();
    if (hooks.onCreate) { try { hooks.onCreate(inst); } catch (e) { logger.warn && logger.warn('onCreate(' + id + '): ' + (e && e.message)); } }
    if (events) events.append('inst_added', { id, name: inst.name, port });
    return { ok: true, instance: inst };
  }

  function removeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    // 删除必须与进行中的安装/升级作业互斥，否则 npm install 会重建已删实例的 install/，
    // 而守卫内存已无该实例，孤儿永久占盘。检查必须在任何状态变更之前。
    if (tasks && tasks.isBusy('instance', id)) {
      return { ok: false, error: '该实例有进行中的安装/升级作业，请等待其完成后再删除' };
    }
    const before = store.instances.length;
    const kept = store.instances.filter((i) => i.id !== id);
    if (kept.length === before) return { ok: false, error: '实例不存在' };
    store.replace(kept); // 原地替换：外部持有的 instances 数组引用身份保持不变
    store.save();
    if (tokens) tokens.detach(inst.id); // 唯一令牌节点：删除实例即注销其源与令牌
    // 端口释放：按 owner 精确释放（不得用不带 ownerId 的 release，那会删掉他人登记）。
    if (inst) { try { ports.unregister('inst:' + id); } catch {} }
    // 删数据目录前必须确认单元真的停了。stopUnit 已按契约区分成败（失败返回 false 不抛）；
    // 在不支持用户单元的平台上会抛 CapabilityError，那等于无单元可停、非失败，不得让删除整体崩溃。
    // 放行条件 = 停止成功；停止失败（含 is-active 查询因 dbus 挂起超时而失败）一律按未停止处理，
    // 保守保留数据，绝不因「查询失败被当成不活跃」而删除可能仍在运行的实例数据。
    const unit = 'dsh-web@' + id;
    let stopOk;
    try { stopOk = service.stopUnit(unit) !== false; } catch { stopOk = true; }
    let stillActive = !stopOk;
    if (stopOk) {
      try {
        // 停止已确认后二次复核：仅显式 false 视为已停；true / null / undefined（查询失败）一律按活跃处理。
        const active = service.isUnitActive(unit);
        stillActive = active !== false;
      } catch { stillActive = true; }
    }
    if (inst && inst.domain === 'sandbox' && inst.id !== 'main' && !stillActive) {
      const root = sandbox.root(instancesRoot, inst);
      setImmediate(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (e) { logger.warn && logger.warn('清理沙箱目录失败 ' + root + ': ' + e.message); }
      });
    } else if (stillActive) {
      // 数据目录受保护：如实上报（调用方据此提示用户「实例未停止，数据已保留」）。
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 仍在运行，已保留实例数据目录（防不可逆丢失）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-still-active' });
    }
    if (hooks.onRemove) hooks.onRemove(id, store.instances);
    if (hooks.onDestroy) { try { hooks.onDestroy(id); } catch (e) { logger.warn && logger.warn('onDestroy(' + id + '): ' + (e && e.message)); } }
    if (events) events.append('inst_removed', { id });
    // 安全结果必须对用户可见：删除确认框承诺「彻底删除」，实际数据可能被保留。
    return stillActive ? { ok: true, dataPreserved: true, preserveReason: 'unit-still-active' } : { ok: true };
  }

  function updateInstance(id, patch) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (patch.guardian !== undefined) {
      const gChanged = inst.guardian !== !!patch.guardian;
      inst.guardian = !!patch.guardian;
      if (gChanged && events) events.append('inst_guardian_changed', { id: inst.id, name: inst.name, enabled: inst.guardian === true });
    }
    if (patch.remoteEnabled !== undefined) {
      const changed = inst.remoteEnabled !== !!patch.remoteEnabled;
      inst.remoteEnabled = !!patch.remoteEnabled;
      if (changed && hooks.onRemoteChange) hooks.onRemoteChange(inst);
      if (changed && events) events.append('inst_remote_changed', { id: inst.id, name: inst.name, enabled: inst.remoteEnabled === true });
    }
    if (patch.remoteToken !== undefined) inst.remoteToken = String(patch.remoteToken || '');
    // 历史/原生记录可能没有 sandbox 对象（model.normalizeInstance 只补 guardian 与 state，不建 sandbox）：
    // 直接写 inst.sandbox.memoryMax 会抛 TypeError，而此处 guardian 与 remoteEnabled 可能已被改 → 半改状态。
    if (patch.memoryMax !== undefined || patch.cpuQuota !== undefined) inst.sandbox = inst.sandbox || {};
    if (patch.memoryMax !== undefined) inst.sandbox.memoryMax = String(patch.memoryMax);
    if (patch.cpuQuota !== undefined) inst.sandbox.cpuQuota = String(patch.cpuQuota);
    store.save();
    return { ok: true, instance: inst };
  }

  /** 兜底定时驱动（主路径不用——实例监督并入守卫唯一心跳；仅 ManagedRegistry 不可用时降级）。 */
  function startTimer(intervalMs) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      for (const inst of store.instances) {
        if (inst.domain === 'native') continue;
        try { lifecycle.supervise(inst.id); } catch {}
      }
    }, intervalMs || 5000);
  }

  return { list, addInstance, removeInstance, updateInstance, startTimer };
}

module.exports = { createOps };
