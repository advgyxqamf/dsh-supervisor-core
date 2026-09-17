'use strict';

// 持久化：instances.json 原子读写（内容未变不写盘）+ 端口登记全量对账 + 沙箱目录创建。
// 唯一持有 instances 活数组：外部经 index 的 getter 取同一引用，替换须经 replace() 原地改写，
// 绝不换数组对象（app/state/store.js 等 20+ 处持引用直读/splice）。

const fs = require('node:fs');
const path = require('node:path');
const ports = require('../../platform/service/ports').shared;
const model = require('./model');
const sandbox = require('./sandbox');

class InstanceStore {
  constructor({ dir, instancesRoot, logger, tokens }) {
    this.dir = dir;
    this.logger = logger;
    this.tokens = tokens || null;
    this.instancesFile = path.join(dir, 'instances.json');
    // 沙箱实例各自独立根目录（数据+依赖），与原生(~/.dsh)及彼此零共享
    this.instancesRoot = instancesRoot || path.join(dir, 'instances');
    this.instances = [];
    this._lastBody = null;
  }

  load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.instancesFile, 'utf8');
    } catch (e) {
      // ENOENT=首启尚无文件，属合法空态（不告警/不备份）；其余读失败按损坏处理。
      if (e && e.code === 'ENOENT') this._replace([]);
      else this._quarantineCorrupt(e);
    }
    if (raw !== null) {
      let doc = null;
      let parsed = true;
      try { doc = JSON.parse(raw); } catch (e) { parsed = false; this._quarantineCorrupt(e); }
      if (parsed) this._replace(doc && Array.isArray(doc.instances) ? doc.instances : []);
    }
    for (const inst of this.instances) {
      model.normalizeInstance(inst);
      this._stripLegacyStateKeys(inst);
      // 唯一令牌节点：沙箱实例登记“源”（journald 单元 dsh-web@<id>），令牌获取/分发由服务统一负责。
      // 只登记 journald 单元（天然持久、-g 取最近行=当前进程新令牌）；不登记 file——沙箱重启轮换新令牌
      // 只打 journal，若复用恢复文件会缓存旧令牌 block journal。
      if (inst.domain === 'sandbox' && this.tokens) this.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
    }
    this.syncPorts();
    return this.instances;
  }

  /** 清历史遗留的未声明 state 字段。**只在内存删、本方法不写盘**；下次 save（5s tick 或任意内容变化）
   *  由 save() 全量序列化内存数组而自然落地，故幂等：文件既已无该键，再 load 即无键可删。
   *  state.version：阶段五已停止写入（upgrade.js 的两处赋值删除），且内核/测试/壳仓**零消费者**、
   *  createRecord 声明的 state 形状不含它（version 显示走 readInstalledVersion 实时读盘）。
   *  同型先例：model.normalizeInstance 同样在加载期删遗留键 dshToken（有测试断言该行为）。 */
  _stripLegacyStateKeys(inst) {
    if (inst.state && Object.prototype.hasOwnProperty.call(inst.state, 'version')) delete inst.state.version;
  }

  /** 损坏现场隔离：先告警，再把损坏文件改名为 .corrupt-<ts> 保留现场，最后清空内存。
   *  rename 先于清空（后续 save 会覆盖原文件）；rename 后原文件不再被覆盖。 */
  _quarantineCorrupt(err) {
    const bak = this.instancesFile + '.corrupt-' + Date.now();
    this.logger && this.logger.warn && this.logger.warn('instances.json 读取/解析失败，备份后清空: ' + (err && err.message) + ' -> ' + bak);
    try { fs.renameSync(this.instancesFile, bak); }
    catch (e2) { this.logger && this.logger.warn && this.logger.warn('instances.json 损坏现场备份失败: ' + (e2 && e2.message)); }
    this._replace([]);
  }

  /** 原地替换数组内容（**保持数组对象身份**，外部引用不失效）。 */
  _replace(list) {
    if (list === this.instances) return; // 自赋值：先清空会丢数据
    this.instances.length = 0;
    for (const i of list) this.instances.push(i);
  }

  replace(list) { this._replace(list); }

  save() {
    // 落盘失败（磁盘满/权限/只读）必须降级而非抛出：本方法从 5s tick 循环调用，一旦抛错会经
    // setInterval 到 uncaughtException 触发守卫 3 次退出重启。内存是权威，失败只记日志，
    // 下次内容变化时重试。
    try {
      const body = JSON.stringify({ instances: this.instances }, null, 2);
      if (body === this._lastBody) return; // 内容未变不写盘（tick 每 5s 全量调用，稳态零写放大）
      this._lastBody = body;
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.instancesFile + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.instancesFile);
    } catch (e) {
      this.logger && this.logger.error && this.logger.error('instances.json 持久化失败: ' + (e && e.message));
    }
  }

  /** 实例端口注册表派生同步：端口真源是 instances.json（内存数组，用户配置值）；registry 的 inst:*
   *  记录是派生投影，把配置端口纳入全局冲突视图（防动态分配段撞实例端口），非记忆绑定。
   *  全量对账：内存有而 registry 缺则 registerUser；registry 有 inst:* 而内存无对应实例则 unregister。
   *  同 owner 已登记端口与当前配置端口不一致（端口已变）时，先 unregister 旧登记再按新端口
   *  registerUser——否则旧 inst:* 记录因「该 id 仍存在」而永久泄漏。 */
  syncPorts() {
    for (const inst of this.instances) {
      const id = String(inst.id || '');
      const port = Number(inst.port);
      if (!id || !Number.isInteger(port) || port <= 0) continue;
      try {
        const bound = ports.byOwner('inst:' + id);
        if (bound !== null && Number(bound) !== port) ports.unregister('inst:' + id);
        if (!ports.isRegistered(port)) ports.registerUser(port, 'inst:' + id);
      } catch (e) { this.logger.warn && this.logger.warn('syncPorts register ' + id + ':' + port + ': ' + e.message); }
    }
    try {
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!this.instances.some((i) => String(i.id) === id)) { try { ports.unregister(rec.owner); } catch {} }
      }
    } catch {}
  }

  /** 为沙箱实例建独立目录（数据目录 + 依赖目录；sessions/profiles 等由 DSH 自建）。 */
  ensureDirs(inst) {
    fs.mkdirSync(sandbox.dataDir(this.instancesRoot, inst), { recursive: true });
    fs.mkdirSync(sandbox.installDir(this.instancesRoot, inst), { recursive: true });
  }
}

module.exports = { InstanceStore };
