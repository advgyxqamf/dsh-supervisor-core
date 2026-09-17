'use strict';

// router 域持久化（providers.json + 用量 + 写权单闸）。
// 写权单闸（PG-7）：本类是唯一判定「此刻能否落盘」的地方——服务级写开关（setPersistEnabled）
// 与文件级健康（loadedOk）之并。save/writeUsage 都在方法体内自查 canPersist()，调用方不再各自判断。
// 用量读写（readUsage/writeUsage）归口本文件（.tmp 命名与 save 统一，防并发写混合内容）。
// provider 反序列化：纯映射，工厂经 deps 注入，使 store 不 require providers（保持叶子方向）；
// stateDir 由注入的 config.stateFile 派生，provider 落盘/落日志必须用它，不得各自 os.homedir()。

const fs = require('node:fs');
const path = require('node:path');

class RouterStore {
  constructor(opts) {
    this.file = opts.file;
    this.usageFile = (opts && opts.usageFile) || null;
    this.logger = (opts && opts.logger) || null;
    // 本次启动是否已成功读过盘（用于「空态立即回写」的放大效应防护）
    this.loadedOk = false;
    // 服务级写开关：true=本实例写；false=只读（外部 router-daemon 独占写）
    this._writable = true;
  }

  load() {
    // 注意：不得把「解析失败」与「本来就是空」混为一谈。原实现 catch 后静默返回 {providers: []}，
    // 而调用方启动维护阶段会立刻 _save()，把刚读出的「空」覆盖回文件，一次外部损坏/半写即导致
    // 用户全部供应商与账号配置（含 API Key）静默清零且不可恢复。故解析失败时保留现场
    // （改名 .corrupt-<ts> 备份）、logger.error 上报、置 loadedOk=false，让调用方跳过「空态回写」。
    this.loadedOk = false;
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { this.loadedOk = true; return { providers: [] }; } // 文件不存在：合法空态，允许后续写入
    try {
      const doc = JSON.parse(raw);
      this.loadedOk = true;
      return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    } catch (e) {
      const bak = this.file + '.corrupt-' + Date.now();
      try { fs.renameSync(this.file, bak); } catch {}
      if (this.logger && this.logger.error) {
        this.logger.error('[router] providers.json 解析失败（' + e.message + '）——已保留现场为 ' + bak +
          '，本次**不覆盖**该文件（防配置静默清零）');
      }
      // 不置 loadedOk：调用方据此跳过回写，给人修复/恢复的机会
      return { providers: [], corrupt: true, backup: bak };
    }
  }

  /** 唯一写权闸：服务级开关 ∪ 文件级健康（解析失败后禁止，防把损坏放大成清零）。 */
  canPersist() { return this._writable !== false && this.loadedOk === true; }

  /** L3：设置状态文件写开关（true=本实例写；false=只读，由外部 router-daemon 独占写）。 */
  setPersistEnabled(v) { this._writable = v !== false; }

  /** providers.json 原子写；未过闸返回 false（调用方无需重复判断）。 */
  save(providers) {
    if (!this.canPersist()) {
      if (!this.loadedOk && this.logger && this.logger.warn) {
        this.logger.warn('router save skipped：providers.json 读取异常（已保留现场），拒绝用空态覆盖');
      }
      return false;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 注意：tmp 名必须唯一；固定 '.tmp' 会让两个进程并发写同一临时文件，rename 出混合内容。
    const tmp = this.file + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ providers: providers.map((p) => p.serialize()) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return true;
  }

  /** usage-totals.json 读盘（兼容旧格式补默认字段，防 undefined 崩溃）。 */
  readUsage() {
    let t;
    try { t = JSON.parse(fs.readFileSync(this.usageFile, 'utf8')); } catch {}
    if (!t || typeof t !== 'object') t = {};
    t.requests = t.requests || 0;
    t.promptTokens = t.promptTokens || 0;
    t.completionTokens = t.completionTokens || 0;
    t.totalTokens = t.totalTokens || 0;
    t.costUsd = t.costUsd || 0;
    t.errors = t.errors || 0;
    if (!t.byModel || typeof t.byModel !== 'object') t.byModel = {};
    if (!t.byKey || typeof t.byKey !== 'object') t.byKey = {};
    return t;
  }

  /** usage-totals.json 原子写；唯一 tmp 命名 + 写权单闸。未过闸返回 false。 */
  writeUsage(totals) {
    if (!this.canPersist() || !totals || !this.usageFile) return false;
    fs.mkdirSync(path.dirname(this.usageFile), { recursive: true });
    const tmp = this.usageFile + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(totals), { mode: 0o600 });
    fs.renameSync(tmp, this.usageFile);
    return true;
  }
}

/** provider JSON 快照转为 provider 对象（纯映射，工厂/依赖全经 deps 注入，便于独立单测）。
 *  deps = { createDirect, createProxy, createInstance, apps, logger, events, dist, onPersist, config } */
function deserializeProvider(p, deps) {
  const d = deps || {};
  // stateDir：数据目录（由 config.stateFile 派生），供 provider 落盘/落日志，不得各自 os.homedir()。
  const stateDir = (d.config && d.config.stateFile) ? path.dirname(d.config.stateFile) : null;
  const common = {
    id: p.id, name: p.name, logger: d.logger, events: d.events, dist: d.dist,
    onPersist: d.onPersist, stateDir,
    apiPort: p.apiPort || null, activated: p.activated === true,
  };
  const apps = d.apps || {};
  let prov;
  if (p.kind === 'proxy') {
    prov = d.createProxy({ ...common, kind: 'proxy', proxyAppId: p.proxyAppId, app: apps[p.proxyAppId] || null });
    prov.proxyRunning = !!p.proxyRunning;
    const app = apps[p.proxyAppId] || null;
    prov.instances = (p.instances || []).map((i) => {
      const inst = (typeof d.createInstance === 'function') ? d.createInstance(i) : {
        key: i.key || null, keyId: i.keyId, maskedKey: i.maskedKey, status: 'COLD', healthy: false,
        quota: i.quota || null, registeredAt: i.registeredAt || Date.now(), version: i.version || null,
        port: i.port || null, pid: null,
      };
      inst.app = app;
      inst.logger = d.logger;
      inst.events = d.events;
      return inst;
    });
  } else {
    prov = d.createDirect({ ...common, kind: 'direct', baseUrl: p.baseUrl || '', plan: p.plan || null, pricing: p.pricing || {}, adapter: p.adapter || null, presetId: p.presetId || null });
  }
  // 统一恢复持久化锁定（直连/反代共用；反代旧数据 selectedProxyKeyId 兼容迁移）
  prov.selectedAccountKeyId = p.selectedAccountKeyId || p.selectedProxyKeyId || null;
  // 统一状态机恢复：恢复「当前在用账号」与每账号使用状态。旧数据无 activeAccountKeyId/usage 时
  // 安全降级（active 待首个请求重新标，usage 默认 idle），账号 key/配额等字段逐项恢复，绝不丢弃。
  const restoredActiveId = p.activeAccountKeyId || null;
  prov.accounts = (p.accounts || []).map((a) => {
    const acc = {
      key: a.key || null,
      keyId: a.keyId,
      maskedKey: a.maskedKey,
      // 单事实源：只读 status；
      //   usage 不反序列化（纯派生，由 usageOf 从 activeAccount/实例实况算）。
      status: a.status || a.validity || 'registered',
      quota: a.quota || null,
      registeredAt: a.registeredAt || Date.now(),
      detectError: a.detectError || null,
      nextResetAt: a.nextResetAt || null,
      limit: a.limit || null, // M2：limitKind 恢复（window/credits/banned + recovery）
      lastProbeAt: a.lastProbeAt || null,
      lastProbeError: a.lastProbeError || null,
      instance: prov.kind === 'proxy' ? (prov.instances.find((i) => i.keyId === a.keyId) || null) : null,
    };
    // 恢复在用指向：持久化的 active 账号若存在则恢复 activeAccount（粘滞 + 前端锁定显示）
    if (restoredActiveId && a.keyId === restoredActiveId) prov.activeAccount = acc;
    return acc;
  });
  // 锁收敛：加载不复活对不可用账号的死锁（残留 selected 指向冻结账号则丢弃，下次落盘清除）
  if (typeof prov._reconcileLock === 'function') { try { prov._reconcileLock(); } catch {} }
  return prov;
}

module.exports = { RouterStore, deserializeProvider };
