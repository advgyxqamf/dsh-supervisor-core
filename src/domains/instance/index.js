/**
 * 多实例管理器：一台机器托管多个完全独立的 DeepSeek Harness 实例。
 *
 * 设计原则（论证后）：
 * - 每个实例 = 一个独立的 systemd transient 单元 (dsh-web@<id>.service)
 *   + 独立 sandbox 参数 (PrivateTmp/ProtectHome/MemoryMax/CPUQuota)
 *   + 独立 cgroup → 实例之间零耦合、完全隔离
 * - guard 不持有实例句柄：用 systemctl 拉起 + pidfd/端口探测观测
 * - "进程守护"开关：guardian=true 才监控/拉起(守护)，guardian=false 只记录存在
 * - 远程控制关联：每实例 remoteEnabled 决定是否生成反向代理
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const os = require('node:os');
const monitor = require('../../guard/monitor/index');
const guardian = require('../../guard/guardian/index');
const ports = require('../../guard/lifecycle/ports').shared;
const { semverCompare } = require('../dist/index');

/* 说明：实例用 systemd-run 启动为 transient 单元（每实例独立 cgroup），无需 dsh-web@.service 模板文件；
 * 残留的模板片段会阻止 systemd-run --unit=dsh-web@*（见 _prepareSystemd）。 */

class InstanceManager {
  constructor(opts) {
    this.dir = opts.dir;                 // ~/.dsh/supervisor
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;       // 统一分发：沙箱 npm 安装与 DSH 自升级共用全局镜像源
    this.dshBin = opts.dshBin || 'dsh';
    // 平台能力门（2026-09 审计修复）：沙箱实例经 systemd-run 独立 cgroup 管理 → 仅 Linux+systemd 可用。
    // 非支持平台在此显式记录，启停方法返回明确错误——原实现各 execFileSync 逐点 catch 吞错后
    // 误报「启动失败/端口冲突」等误导性原因（mac/win 上静默半瘫的根因之一）。
    const caps = require('../../platform/os/index').capabilities();
    this.sandboxSupported = !!(caps && caps.multiInstance === true);
    this.instancesFile = path.join(this.dir, 'instances.json');
    // 沙箱实例各自独立根目录（数据+依赖），与原生(~/.dsh)及彼此零共享
    this.instancesRoot = path.join(path.dirname(this.instancesFile), 'instances');
    this.systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    this.systemdTemplatePath = path.join(this.systemdDir, 'dsh-web@.service');
    this.instances = [];
    this._timer = null;
    // 唯一令牌节点注入（DshTokenService）：本模块只登记“源”（journald 单元）并触发捕获，
    // 不持有/不转发任何令牌——获取、存储、分发全部收敛到令牌服务（见 src/domain/token）
    this.tokens = opts.tokenService || null;
    // 沙箱实例版本更新：npm 最新版缓存（内存瞬态，list 5s tick 不查网）+ 更新 job 表（防并发，前端轮询）
    this._updCache = {};   // id -> { latest, checkedAt, error }
    this._updJobs = {};    // id -> { state, startedAt, finishedAt, step, errors, error }
    this._updTTL = 6 * 3600 * 1000; // 缓存 6h（与反代应用版本刷新对齐；手动「检查更新」随时强制刷新）
    this.tasks = opts.tasks || null; // 统一安装/更新任务注册表（持久化历史 + 统一 API）
    this.onRemoteChange = null;
    this.onRemove = null; // 远程控制开关变化回调（supervisor 注册，用于创建/删除代理）
    this.onInstanceStart = null; // 实例启动回调（supervisor 注册，用于关联远程代理）
    this.onInstanceStop = null;  // 实例停止回调（supervisor 注册，用于停止远程代理）
    // 控制平面申报钩子（R1 控制平面 v3）：沙箱实例创建/销毁时向管家注册机上报登记。
    // 业务仍全权执行创建/销毁；管家据此维持「注册即存在、注销即不存在」。
    this.onCreate = opts.onCreate || null;
    this.onDestroy = opts.onDestroy || null;
  }

  /* ── 实例持久化 ── */
  load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.instancesFile, 'utf8'));
      this.instances = Array.isArray(doc.instances) ? doc.instances : [];
    } catch { this.instances = []; }
    for (const inst of this.instances) {
      // 令牌收敛（2026-09，docs/token-management.md）：DSH 会话令牌唯一权威是 DshTokenService——
      // instances.json 历史遗留的 dshToken 列一律剔除（内存即刻断行，下次 save 落盘即清）；
      // 会话令牌不落盘、不透传（展示用 tokenPresent 布尔在 api 层派生）。
      if (Object.prototype.hasOwnProperty.call(inst, 'dshToken')) delete inst.dshToken;
      if (inst.guardian === undefined) inst.guardian = false; // 默认关
      // 重启后：任何 FAILED 一律重置为「停止」——失败是一次性状态，重启后应回到可重试的停止态，而非永远显示"失败"
      if (inst.state && inst.state.phase === 'FAILED') {
        inst.state.phase = 'STOPPED';
        inst.state.lastError = null;
      }
      if (inst.state) inst.state.phase = inst.state.phase || 'STOPPED';
      // 唯一令牌节点：沙箱实例登记“源”（journald 单元 dsh-web@<id>），令牌获取/分发由服务统一负责
      // 沙箱令牌源只登记 journald 单元（天然持久、-g 取最近行=当前进程新令牌）；不登记 file——
      // 沙箱重启轮换新令牌只打 journal，若复用恢复文件会缓存旧令牌 block journal（2026-09 修复）。
      if (inst.domain === 'sandbox' && this.tokens) this.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
    }
    // 端口登记派生同步（取代逐条 registerUser：统一对账，registry 恒为 instances 投影）
    this._syncInstancePorts();
    return this.instances;
  }

  /** 实例端口注册表派生同步（2026-09 架构收敛——取代散落的 4 处手动 registerUser）：
   *  实例端口真源 = instances.json（内存 instances 数组，用户配置值）；registry 的 inst:* 记录是
   *  「派生投影」——把配置端口纳入全局冲突视图（防动态分配段撞实例端口），非记忆绑定。
   *  本方法全量对账：内存实例缺登记 → registerUser；registry 有 inst:* 但内存无对应实例 → unregister。
   *  在 load/add/remove/ensureMain 等实例集合变化点调用，保证 registry 恒为准确投影（单一同步入口）。 */
  _syncInstancePorts() {
    // 增：内存实例未登记的补登记（宽松——已登记跳过；冲突(异常)记录不崩，addInstance 已前置严格校验）
    for (const inst of this.instances) {
      const id = String(inst.id || '');
      const port = Number(inst.port);
      if (!id || !Number.isInteger(port) || port <= 0) continue;
      try { if (!ports.isRegistered(port)) ports.registerUser(port, 'inst:' + id); }
      catch (e) { this.logger.warn && this.logger.warn('_syncInstancePorts register ' + id + ':' + port + ': ' + e.message); }
    }
    // 删：registry 中 inst:* 但内存实例已不存在的记录清除（实例删除/port 变更后的残留）
    try {
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!this.instances.some((i) => String(i.id) === id)) { try { ports.unregister(rec.owner); } catch {} }
      }
    } catch {}
  }

  save() {
    // 落盘失败（磁盘满/权限/只读）必须降级而非抛出：本方法从 5s tick 循环调用，
    // 一旦抛错会经 setInterval → uncaughtException → 触发守卫 3 次退出重启（2026-09 审计修复）。
    // 实例状态以内存为权威，落盘失败只记日志，下次内容变化时重试。
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

  /* ── systemd 启动准备 ── */
  _prepareSystemd() {
    try {
      fs.mkdirSync(this.systemdDir, { recursive: true });
      if (fs.existsSync(this.systemdTemplatePath)) {
        fs.unlinkSync(this.systemdTemplatePath);
        this.logger.info && this.logger.info('removed incompatible dsh-web@.service template fragment (blocks systemd-run)');
      }
      try { execFileSync('systemctl', ['--user', 'daemon-reload']); } catch {}
      return true;
    } catch (e) {
      this.logger.error && this.logger.error('_prepareSystemd: ' + e.message);
      return false;
    }
  }

  /* ── 沙箱实例目录/安装 ── */
  /** 沙箱实例的独立根目录（其下 依赖目录 install/ + 数据目录 data/）。 */
  sandboxRoot(inst) { return path.join(this.instancesRoot, inst.id); }
  /** 该实例独立数据目录（作为实例运行的 HOME/XDG_CONFIG_HOME，内置独立 .dsh 等）。 */
  sandboxDataDir(inst) { return path.join(this.sandboxRoot(inst), 'data'); }
  /** 该实例独立依赖目录（完整 DSH 安装处，node_modules 与原生隔离）。 */
  sandboxInstallDir(inst) { return path.join(this.sandboxRoot(inst), 'install'); }

  /** 为沙箱实例建独立目录，并在数据目录初始化一个独立 DSH 数据空间（sessions/profiles 等由 DSH 自建）。 */
  _ensureSandboxDirs(inst) {
    fs.mkdirSync(this.sandboxDataDir(inst), { recursive: true });
    fs.mkdirSync(this.sandboxInstallDir(inst), { recursive: true });
  }

  /** 在实例独立依赖目录完整安装 DeepSeek Harness（npm install @deepseek-ai/dsh）。
   *  R3 遗留「装配作业化」：装配以 TaskRegistry 作业（kind=instance, action=install）承载——
   *  完成/失败与 10min 看护都在作业执行器内驱动；inst.state.install* 仅作对前端呈现的镜像，
   *  监督循环（supervise/registry adapter）只读作业态/镜像，不再硬编码装配超时。
   *  返回 { ok, error }；失败不抛异常，由调用方降级。
   *  镜像源：走全局 dist（与 DSH 自升级同一份镜像配置），避免国内网络绕行官方源卡死。 */
  async _installSandbox(inst) {
    // 装配作业（统一任务模型；历史/进度/日志经 /tasks 可观测）
    let task = null;
    if (this.tasks) {
      try {
        if (this.tasks.isBusy('instance', inst.id)) {
          return { ok: true, installing: true, already: true }; // 升级/安装作业进行中：幂等等待
        }
        task = this.tasks.begin('instance', 'install', { id: inst.id, name: inst.name }, { createdBy: 'user', meta: { domain: 'sandbox' } });
        this.tasks.start(task.id);
        const s0 = this.tasks.step(task.id, '安装 DeepSeek Harness（沙箱独立副本）');
        this.tasks.stepState(task.id, task.steps.indexOf(s0), 'running');
      } catch (e) { this.logger.warn && this.logger.warn('sandbox install task begin failed: ' + (e && e.message)); task = null; }
    }
    try {
      const installDir = this.sandboxInstallDir(inst);
      this._ensureSandboxDirs(inst);
      inst.state.phase = 'INSTALLING';
      inst.state.installAt = Date.now();
      inst.state.installOk = null;
      inst.state.installError = null;
      inst.state.installLog = inst.state.installLog || []; // 可观测安装日志(有界)
      this.save();
      const pushLog = (txt) => {
        const t = new Date().toISOString().slice(11, 19);
        for (const ln of String(txt || '').split(/\r?\n/)) {
          const l = ln.trim();
          if (!l) continue;
          // 过滤 npm 噪音（Unknown user config / 各类警告 / deprecated），只保留有意义的进度与结果
          if (/unknown user config|npm warn|deprecated|^\$|npm notice/i.test(l)) continue;
          inst.state.installLog.push('[' + t + '] ' + l);
          if (inst.state.installLog.length > 60) inst.state.installLog.shift();
          if (task) { try { this.tasks.log(task.id, l); } catch {} }
        }
        this.save();
      };
      if (task) { try { this.tasks.log(task.id, '目标目录：' + installDir); } catch {} }
      // 官方标准安装方式：npm install -g --prefix <沙箱目录> @deepseek-ai/dsh@<version>（每个沙箱自己的完整独立安装）。
      // 注：本地「非全局」npm install @deepseek-ai/dsh 在本环境 peer 依赖解析卡死；全局式 -g --prefix 走官方标准装法且成功。
      // 关键：必须显式携带最高版本号——npm 默认装 latest tag（可能不是最高版本，如 latest=0.1.1-rc.2 而最高=0.1.2-alpha.2）。
      const env = Object.assign({}, process.env);
      let reg = null;
      if (this.dist) {
        try {
          reg = await this.dist.selectRegistry(false);
          if (reg) { env.npm_config_registry = reg; env.NPM_CONFIG_REGISTRY = reg; }
        } catch (e) { this.logger.warn && this.logger.warn('sandbox registry select failed: ' + e.message); }
      }
      const latestVer = await this._latestDshVersion();
      pushLog('安装目标版本：' + (latestVer || 'latest tag'));
      if (!latestVer) {
        inst.state.installOk = false; inst.state.installError = '无法获取最新版本'; this.save();
        if (task) { try { this.tasks.fail(task.id, '无法获取最新版本'); } catch {} }
        return { ok: false, error: '无法获取最新版本' };
      }
      // 统一走 dist 安装执行器（--prefix 独立安装，显式版本）
      if (!this.dist) {
        inst.state.installOk = false; inst.state.installError = 'dist 分发服务不可用'; this.save();
        if (task) { try { this.tasks.fail(task.id, 'dist 分发服务不可用'); } catch {} }
        return { ok: false, error: 'dist 分发服务不可用' };
      }
      // 10min 装配看护（作业驱动，替代旧 supervise 硬编码超时）：超时先呈现 FAILED(用户可见)，
      // npm 慢网成功后自愈拉回 INSTALLING（与旧语义一致——超时不杀死安装进程）。
      const watchdog = setTimeout(() => {
        try {
          if (inst.state && inst.state.phase === 'INSTALLING') {
            inst.state.phase = 'FAILED';
            inst.state.installError = '安装超时(10分钟)';
            this.save();
            if (task) { try { this.tasks.log(task.id, '安装超时(10分钟)——等待安装进程收敛，成功则自动恢复'); } catch {} }
          }
        } catch (e2) { this.logger.error && this.logger.error('install watchdog ' + inst.id + ': ' + (e2 && e2.message)); }
      }, 10 * 60 * 1000);
      let res;
      try {
        res = await this.dist.runNpmInstall({
          pkg: '@deepseek-ai/dsh',
          version: latestVer,
          prefix: installDir,
          registry: reg,
          onLine: pushLog,
        });
      } finally {
        clearTimeout(watchdog);
      }
      inst.state.installOk = res.ok;
      if (!res.ok) { inst.state.installError = res.error; this.logger.error('sandbox install failed for ' + inst.id + ': ' + res.error); }
      // 竞态自愈：await 安装期间 10min 看护可能已把实例置 FAILED（慢网/大包边缘）。
      // 若安装实际成功，恢复 INSTALLING 让监督拍立即拉起；失败则保持 FAILED（用户可见原因）。
      if (res.ok && inst.state.phase === 'FAILED' && inst.state.installError && /安装超时/.test(inst.state.installError || '')) {
        inst.state.phase = 'INSTALLING';
        inst.state.installError = null;
      }
      this.save();
      if (task) {
        try {
          if (res.ok) this.tasks.succeed(task.id, { meta: { version: latestVer } });
          else this.tasks.fail(task.id, res.error || '安装失败');
        } catch (e2) { this.logger.warn && this.logger.warn('sandbox install task finish failed: ' + (e2 && e2.message)); }
      }
      return { ok: res.ok, installing: res.ok, error: res.ok ? null : (res.error || '安装失败') };
    } catch (e) {
      if (task) { try { this.tasks.fail(task.id, (e && e.message) || '安装异常'); } catch (e2) {} }
      this.logger.error && this.logger.error('sandbox install failed for ' + inst.id + ': ' + (e && e.message));
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 沙箱实例的启动命令：用「官方 npm install -g --prefix」装进该沙箱 install 目录的 DSH（独立安装）。 */
  _sandboxCommand(inst) {
    const nodeBin = process.execPath;
    // -g --prefix 布局：<installDir>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    const bin = path.join(this.sandboxInstallDir(inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    return [nodeBin, bin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
  }

  /* ── 实例 CRUD ── */
  /** 新增实例：生成独立 unit 名 + 独立配置。sandbox 默认标准隔离。 */
  addInstance(payload) {
    const port = parseInt(payload.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效端口' };
    if (this.instances.some((i) => i.port === port)) return { ok: false, error: '端口 ' + port + ' 已被实例占用' };
    const id = 'inst-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    // 端口登记入口严格校验（同步）：实例端口必须避开全部系统端口（固定/relay 40000+/反代实例 41000+/oauth 42000+）
    // 与 registry 已登记端口冲突 → 返错（新增是唯一允许拒绝的入口；登记即完成，后续由 _syncInstancePorts 幂等维持）
    try { ports.registerUser(port, 'inst:' + id); } catch (e) { return { ok: false, error: '端口 ' + port + ' 与系统服务端口冲突（' + (e.message || e) + '）' }; }
    const inst = {
      id,
      name: String(payload.name || ('实例:' + port)).slice(0, 40),
      port,
      // 新增实例：默认沙箱域（绝对隔离、与原生/彼此互不干扰）
      domain: 'sandbox',
      kind: 'sandbox',
      autoRegistered: false,
      createdBy: 'user',
      command: Array.isArray(payload.command) ? payload.command : [],
      guardian: !!payload.guardian, // 进程守护(自动拉起)开关默认关（架构红线：未显式开启绝不自动拉起）
      remoteEnabled: !!payload.remoteEnabled,
      remoteToken: String(payload.remoteToken || ''),
      unitName: 'dsh-web@' + id,
      sandbox: {
        privateTmp: true,
        // node/dsh 位于 /home（nvm），ProtectHome=yes 会使其 exec 失败(203/EXEC)；默认关闭，可用 payload.protectHome 覆盖
        protectHome: payload.protectHome === undefined ? false : !!payload.protectHome,
        memoryMax: String(payload.memoryMax || '4G'),
        cpuQuota: String(payload.cpuQuota || '150%'),
      },
      state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null },
      createdAt: new Date().toISOString(),
    };
    this.instances.push(inst);
    this.save();
    this._prepareSystemd();
    if (this.onCreate) { try { this.onCreate(inst); } catch (e) { this.logger.warn && this.logger.warn('onCreate(' + id + '): ' + (e && e.message)); } }
    if (this.events) this.events.append('inst_added', { id, name: inst.name, port });
    return { ok: true, instance: inst };
  }


  removeInstance(id) {
    const inst = this.instances.find((i) => i.id === id);
    const before = this.instances.length;
    this.instances = this.instances.filter((i) => i.id !== id);
    if (this.instances.length === before) return { ok: false, error: '实例不存在' };
    this.save();
    if (this.tokens) this.tokens.detach(inst.id); // 唯一令牌节点：删除实例即注销其源与令牌
    // 端口释放：删除实例必须释放其端口登记（inst:<id> 的 user 端口），否则同端口重建提示「已被占用」
    if (inst) {
      try { ports.unregister('inst:' + id); } catch {}
      try { ports.release(inst.port); } catch {} // 双保险：owner 释放 + 端口号释放
    }
    try { execFileSync('systemctl', ['--user', 'stop', 'dsh-web@' + id]); } catch {}
    // 沙箱实例：异步清理其独立根目录（install 依赖 + data 数据），避免磁盘残留。
    // 删除是破坏性操作，仅对 sandbox 域生效（main/native 永不删除）；失败只警告不阻塞。
    if (inst && inst.domain === 'sandbox' && inst.id !== 'main') {
      const root = this.sandboxRoot(inst);
      setImmediate(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (e) { this.logger.warn && this.logger.warn('清理沙箱目录失败 ' + root + ': ' + e.message); }
      });
    }
    if (this.onRemove) this.onRemove(id, this.instances);
    if (this.onDestroy) { try { this.onDestroy(id); } catch (e) { this.logger.warn && this.logger.warn('onDestroy(' + id + '): ' + (e && e.message)); } }
    if (this.events) this.events.append('inst_removed', { id });
    return { ok: true };
  }

  /** 设置实例的监控开关 / 远程控制开关 / 沙箱。 */
  updateInstance(id, patch) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (patch.guardian !== undefined) {
      const gChanged = inst.guardian !== !!patch.guardian;
      inst.guardian = !!patch.guardian;
      // 守护开关变更事件（2026-09 收敛：与 main 同语义——记录哪个实例开了/关了守护）
      if (gChanged && this.events) {
        this.events.append('inst_guardian_changed', { id: inst.id, name: inst.name, enabled: inst.guardian === true });
      }
    }
    if (patch.remoteEnabled !== undefined) {
      const changed = inst.remoteEnabled !== !!patch.remoteEnabled;
      inst.remoteEnabled = !!patch.remoteEnabled;
      if (changed && this.onRemoteChange) this.onRemoteChange(inst);
      if (changed && this.events) {
        this.events.append('inst_remote_changed', { id: inst.id, name: inst.name, enabled: inst.remoteEnabled === true });
      }
    }
    if (patch.remoteToken !== undefined) inst.remoteToken = String(patch.remoteToken || '');
    if (patch.memoryMax !== undefined) inst.sandbox.memoryMax = String(patch.memoryMax);
    if (patch.cpuQuota !== undefined) inst.sandbox.cpuQuota = String(patch.cpuQuota);
    this.save();
    return { ok: true, instance: inst };
  }

  /* ── 沙箱实例版本与更新（每实例独立安装的 DSH，版本/更新均 per-instance）── */
  /** 读取沙箱实例已安装的 DSH 版本（其独立 install 目录的 package.json，同步读盘不查网）。 */
  _readInstalledVersion(inst) {
    if (!inst || inst.domain !== 'sandbox') return null;
    try {
      const pkg = path.join(this.sandboxInstallDir(inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
      if (!fs.existsSync(pkg)) return null;
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      return (j && typeof j.version === 'string') ? j.version : null;
    } catch { return null; }
  }

  /** 查询 @deepseek-ai/dsh 的最高可用版本（含 alpha/rc，走统一镜像源）。
   *  注意：不能依赖 npm 默认安装（它装 latest tag，可能不是最高版本）——
   *  升级/安装必须显式携带版本号。带 30s 内存缓存防高频查询。 */
  async _latestDshVersion() {
    if (this._latestDshVer && Date.now() - this._latestDshVerAt < 30000) return this._latestDshVer;
    let v = null;
    try { if (this.dist) v = await this.dist.fetchNpmLatest('@deepseek-ai/dsh'); } catch {}
    this._latestDshVer = v;
    this._latestDshVerAt = Date.now();
    return v;
  }

  /** 检查某沙箱实例是否有更新：npm 查最新版（走统一镜像源 + 完整版本检测），缓存 6h。
   *  返回 { ok, installed, latest, updateAvailable, error }。 */
  async checkUpdate(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持版本检查' };
    const installed = this._readInstalledVersion(inst);
    const cached = this._updCache[id];
    let latest = (cached && cached.latest) || null;
    if (!latest || !cached || (Date.now() - cached.checkedAt) > this._updTTL) {
      try {
        latest = await this.dist.fetchNpmLatest('@deepseek-ai/dsh');
        this._updCache[id] = { latest, checkedAt: Date.now(), error: latest ? null : '查询失败' };
      } catch (e) {
        latest = null;
        this._updCache[id] = { latest: null, checkedAt: Date.now(), error: e.message };
      }
    }
    const updateAvailable = !!(latest && installed && semverCompare(latest, installed) > 0);
    if (this.events) this.events.append('inst_update_check', { id, installed, latest, updateAvailable });
    return { ok: true, installed, latest, updateAvailable, error: this._updCache[id].error };
  }

  /** 升级沙箱实例的 DSH（重新 npm install -g --prefix 到该实例独立目录，强制拉最新）。
   *  统一任务模型：stop(若在跑) → 安装 → 重启(若之前在跑) → succeeded/failed；
   *  前端经统一 /tasks 或兼容 upgradeStatus 轮询。同一实例升级中重复调用返回 already。 */
  async upgradeInstance(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持升级' };
    const job = this._updJobs[id];
    // 并发互斥（勿拆散）：检查与 _updJobs[id]=running 置位之间没有任何 await（同步完成），
    // 因此第二个并发调用到此必然看到 state==='running' 被拦截——同一实例绝无双 npm install。
    if (job && job.state === 'running') return { ok: true, jobId: id, already: true };
    if (this.tasks && this.tasks.isBusy('instance', id)) return { ok: true, jobId: id, already: true };
    // 统一任务
    const oldVersion = this._readInstalledVersion(inst); // 升级前版本（自动回滚目标）
    let task = null;
    if (this.tasks) {
      task = this.tasks.begin('instance', 'upgrade', { id, name: inst.name }, { from: oldVersion, to: null, createdBy: 'user' });
      this.tasks.start(task.id);
    }
    const nj = { state: 'running', startedAt: Date.now(), finishedAt: null, step: 'preparing', errors: 0, error: null };
    this._updJobs[id] = nj;
    (async () => {
      const installDir = this.sandboxInstallDir(inst);
      const env = Object.assign({}, process.env);
      let reg = null;
      try {
        reg = await this.dist.selectRegistry(false);
        if (reg) { env.npm_config_registry = reg; env.NPM_CONFIG_REGISTRY = reg; }
      } catch {}
      let wasRunning = false;
      try { wasRunning = this._probeState(inst).running; } catch {}
      // 1) 运行中先停（升级期间不跑旧版；tick 见 STOPPED 不干预）
      if (wasRunning) {
        nj.step = 'stopping';
        if (task) { const s = this.tasks.step(task.id, '停止实例'); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
        try { await this.stopInstance(id); } catch {}
        if (task) { const t2 = this.tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; this.tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
      }
      // 2) 强制重装最新版（与首次安装同命令、同镜像源；npm 自会覆盖旧版本）
      //    关键：必须显式携带最高版本号——npm 默认装 latest tag（可能不是最高版本）。
      nj.step = 'installing';
      if (task) { const s = this.tasks.step(task.id, '安装最新版'); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
      const targetVer = await this._latestDshVersion();
      if (task) this.tasks.log(task.id, '目标版本：' + (targetVer || 'latest tag'));
      if (!targetVer) { nj.errors++; nj.error = '无法获取最新版本'; if (task) this.tasks.log(task.id, '无法获取最新版本'); }
      else {
        // 统一走 dist 安装执行器（--prefix 独立安装，显式版本）
        if (!this.dist) { nj.errors++; nj.error = 'dist 分发服务不可用'; }
        else {
          const res = await this.dist.runNpmInstall({
            pkg: '@deepseek-ai/dsh',
            version: targetVer,
            prefix: installDir,
            registry: reg,
            onLine: (l) => { if (task) this.tasks.log(task.id, l); },
          });
          if (!res.ok) { nj.errors++; nj.error = res.error || 'npm install 失败'; if (task) this.tasks.log(task.id, res.error || 'npm install 失败'); }
        }
      }
      if (nj.errors) { nj.state = 'failed'; }
      else {
        nj.step = 'restarting';
        // 3) 读新版本 → 拉回实例并验证可启动（防止"显示成功但实例起不来"）。
        //    无论升级前是否在跑都验证：DSH 可能先监听端口后因插件兼容崩溃（如 dsh-mos），
        //    只探测端口会误判成功，必须同时检查 systemd 单元仍 active。
        inst.state.version = this._readInstalledVersion(inst);
        {
          if (task) { const s = this.tasks.step(task.id, '重启实例并验证'); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
          const sr = await this.startInstance(id).catch(() => ({ ok: false }));
          if (!sr || !sr.ok) { nj.errors++; nj.error = '升级后重启失败: ' + ((sr && sr.error) || ''); nj.state = 'failed'; }
          else {
            // 等待端口就绪并确认单元存活（统一走 dist.waitPortHealthy）。
            // 注意：DSH 进程可能先监听端口、随后因插件兼容崩溃（如 dsh-mos 引用的 API 被新版移除）——
            // 只探测端口会误判成功，必须同时检查 systemd 单元仍 active + 稳定期。
            let up = false;
            if (this.dist) {
              const vh = await this.dist.waitPortHealthy({
                host: '127.0.0.1',
                port: inst.port,
                unit: 'dsh-web@' + inst.id,
                timeoutMs: 40000,
              });
              up = vh.ok;
            }
            if (!up) {
              nj.errors++;
              nj.error = '升级后实例未能启动（端口 ' + inst.port + ' 未就绪）——可能是新版 DSH 与已装插件不兼容';
              nj.state = 'failed';
              if (task) this.tasks.log(task.id, '实例启动失败：端口 ' + inst.port + ' 未就绪（疑似插件与新版不兼容）');
              // ── 自动回滚：装回升级前版本并重启，保证实例永远可用 ──
              if (oldVersion) {
                if (task) { this.tasks.log(task.id, '自动回滚到 ' + oldVersion + '…'); const s = this.tasks.step(task.id, '自动回滚到 ' + oldVersion); this.tasks.stepState(task.id, this.tasks.get(task.id).steps.indexOf(s), 'running'); }
                // 统一走 dist 安装执行器（回滚 = 装回旧版本，同 --prefix 独立安装）
                let rbOk = false;
                if (this.dist) {
                  const rbRes = await this.dist.runNpmInstall({
                    pkg: '@deepseek-ai/dsh',
                    version: oldVersion,
                    prefix: installDir,
                    registry: reg,
                    onLine: (l) => { if (task) this.tasks.log(task.id, l); },
                  });
                  rbOk = rbRes.ok;
                }
                inst.state.version = this._readInstalledVersion(inst);
                if (rbOk) {
                  const rbStart = await this.startInstance(id).catch(() => ({ ok: false }));
                  if (task) this.tasks.log(task.id, '回滚完成，版本 ' + (this._readInstalledVersion(inst) || '') + '，实例已重启');
                  if (!rbStart || !rbStart.ok) {
                    nj.error += '；回滚后重启也失败';
                    if (task) this.tasks.log(task.id, '回滚后重启失败：' + ((rbStart && rbStart.error) || ''));
                  }
                } else {
                  nj.error += '；自动回滚失败（npm install 退出非 0），请手动处理';
                  if (task) this.tasks.log(task.id, '自动回滚失败，请手动处理');
                }
              }
            }
          }
          }
          if (task && nj.state !== 'failed') { const t2 = this.tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; this.tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
        }
        if (nj.state !== 'failed') { nj.state = 'done'; }
        this._updCache[id] = { latest: targetVer || this._readInstalledVersion(inst) || null, checkedAt: Date.now(), error: null };
      nj.finishedAt = Date.now();
      if (this.events) this.events.append('inst_upgraded', { id: inst.id, name: inst.name, ok: nj.state === 'done', error: nj.error });
      // 统一任务收尾
      if (task) {
        if (nj.state === 'done') { this.tasks.log(task.id, '升级完成，版本 ' + (this._readInstalledVersion(inst) || '')); this.tasks.succeed(task.id); }
        else this.tasks.fail(task.id, nj.error || '升级失败');
      }
      this.save();
      // 完成后保留 60s 供前端轮询收尾，随后清理（防表无限增长）
      setTimeout(() => { if (this._updJobs[id] && this._updJobs[id].state !== 'running') delete this._updJobs[id]; }, 60000);
    })().catch((e) => {
      // RC4 执行契约兜底：作业体任何 reject（npm 异常/网络栈错误等）必达终态——
      // 任务落 failed、_updJobs 释放，绝不永久 running 锁死实例（审计 P2-2 根治）。
      try { this.logger && this.logger.error && this.logger.error('upgrade job crashed ' + id + ': ' + (e && e.stack || e)); } catch {}
      if (nj.state === 'running') {
        nj.state = 'failed';
        nj.error = '升级作业异常: ' + ((e && e.message) || e);
        nj.finishedAt = Date.now();
      }
      try { if (task) this.tasks.fail(task.id, nj.error || ('升级作业异常: ' + ((e && e.message) || e))); } catch {}
      try { this.save(); } catch {}
      try { setTimeout(() => { if (this._updJobs[id] && this._updJobs[id].state !== 'running') delete this._updJobs[id]; }, 60000); } catch {}
    });
    return { ok: true, jobId: id };
  }

  /** 任务状态 → 前端契约（前端轮询判定 done/failed；TaskRegistry 状态为 succeeded/skipped/canceled）。 */
  _taskStateToView(s) {
    return (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
  }

  /** 升级进度查询（前端轮询；单一事实源 = TaskRegistry，无任务环境回退 _updJobs 兼容）。
   *  current() 优先：running 期间精确取当前任务，绝不误显示上一笔已完成任务；
   *  无运行中任务时回退该目标最近一次任务（含完成态，供 UI 展示上次结果）。 */
  upgradeStatus(id) {
    const all = this.tasks ? this.tasks.list('instance') : [];
    const t = this.tasks ? (this.tasks.current('instance', id) || all.find((x) => x.target.id === id) || null) : null;
    if (t) {
      return {
        state: this._taskStateToView(t.state),
        step: (t.steps.length ? t.steps[t.steps.length - 1].name : 'preparing'),
        errors: t.state === 'failed' ? 1 : 0,
        error: t.error,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        taskId: t.id,
      };
    }
    const job = this._updJobs[id];
    if (!job) return { error: 'no upgrade job for ' + id };
    return {
      state: job.state, step: job.step, errors: job.errors, error: job.error,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
    };
  }

  list() {
    return this.instances.map((inst) => {
      const ver = this._readInstalledVersion(inst);
      const upd = this._updCache[inst.id];
      const latest = (upd && upd.latest) || null;
      return {
      id: inst.id,
      name: inst.name,
      port: inst.port,
      domain: inst.domain || 'native',
      kind: inst.kind || inst.domain || 'native',
      guardian: inst.guardian,
      remoteEnabled: inst.remoteEnabled,
      unitName: inst.unitName,
      sandbox: inst.sandbox,
      // 沙箱实例版本与更新（每实例独立 DSH 安装；native 无独立安装 → null，不显示）
      version: ver,
      latest,
      updateAvailable: !!(latest && ver && semverCompare(latest, ver) > 0),
      updateJob: (() => {
        // 单一事实源：优先 TaskRegistry current()（running 精确）；无运行中任务回退最近一次完成态；
        // 无任务环境（tasks 缺失）回退 _updJobs 兼容
        const tAll = this.tasks ? this.tasks.list('instance') : [];
        const tt = this.tasks ? (this.tasks.current('instance', inst.id) || tAll.find((x) => x.target.id === inst.id) || null) : null;
        if (tt) {
          return {
            state: this._taskStateToView(tt.state),
            step: (tt.steps.length ? tt.steps[tt.steps.length - 1].name : 'preparing'),
            errors: tt.state === 'failed' ? 1 : 0,
            error: tt.error,
          };
        }
        const nj = this._updJobs[inst.id];
        return nj ? { state: nj.state, step: nj.step, errors: nj.errors, error: nj.error } : null;
      })(),
      state: Object.assign({}, this._probeState(inst), {
        // 沙箱生命周期（可观测）：lifecyclePhase 为内部状态机相位，lastError 暴露失败原因
        lifecyclePhase: inst.state ? inst.state.phase : 'STOPPED',
        lastError: inst.state ? inst.state.lastError : null,
        // 稳定性统计（与原生卡一致）：重启次数 / 最近故障原因（BACKOFF/FAILED 由状态机记录）
        restartCount: inst.state ? (inst.state.restartCount || 0) : 0,
        lastFailure: inst.state ? (inst.state.lastFailure || null) : null,
        installing: inst.state && inst.state.phase === 'INSTALLING',
        installOk: inst.state ? inst.state.installOk : undefined,
        installError: inst.state ? inst.state.installError : undefined,
        installLog: inst.state ? (inst.state.installLog || []) : [],
      }),
      };
    });
  }

  /* ── 探测实例状态（不持有句柄：端口+pid+cmdline）── */
  /** 实例未配 command 时的默认启动命令：<node> <dshBin> web --port <port> */
  _defaultCommand(inst) {
    const nodeBin = process.execPath;
    return [nodeBin, this.dshBin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
  }

  /** 获取实例的有效启动命令。
   *  - 沙箱实例：用户显式配置(command)则用之；否则用该实例自己安装的 dsh（隔离，不碰宿主 dsh）。
   *  - 原生/其它：用户配置或默认宿主命令。 */
  effectiveCommand(inst) {
    if (inst.domain === 'sandbox' && (!inst.command || !inst.command.length)) {
      return this._sandboxCommand(inst);
    }
    if (inst.command && inst.command.length) return inst.command;
    return this._defaultCommand(inst);
  }

  _probeState(inst) {
    // 监控只管探测：统一交 domain/monitor（原生与沙箱实例共用）
    return monitor.probeInstance(inst);
  }

  /** 公开探测实例在线状态（端口+pid+cmdline）。供守卫/外部使用，避免直接调私有 _probeState。 */
  probeInstance(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { pid: null, running: false, isDsh: false, phase: 'STOPPED' };
    return this._probeState(inst);
  }

  /* ── systemd 拉起/停止单个实例 ── */
  /** 清理残留的同名 transient 单元：stop → reset-failed → 删除 transient 单元文件 → daemon-reload。
   *  确保 systemd-run 能新建同名单元。transient 单元文件（/run/user/<uid>/systemd/transient/）
   *  只要存在，systemd 就视为单元已加载，systemd-run 会拒绝重建（报 already loaded）。
   *  关键（日志实证 21:21:25）：删除文件后 systemd 内存仍缓存该单元为 loaded，
   *  必须 daemon-reload 让 systemd 卸载其加载状态，否则 systemd-run 依然拒绝。 */
  _cleanStaleUnit(unit) {
    try { execFileSync('systemctl', ['--user', 'stop', unit + '.service'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('systemctl', ['--user', 'reset-failed', unit + '.service'], { stdio: 'ignore' }); } catch {}
    try {
      const f = path.join(process.env.XDG_RUNTIME_DIR || ('/run/user/' + os.userInfo().uid), 'systemd', 'transient', unit + '.service');
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        this.logger.info && this.logger.info('cleaned stale transient unit: ' + f);
      }
    } catch (e) {
      this.logger.warn && this.logger.warn('_cleanStaleUnit 清理 transient 文件失败: ' + e.message);
    }
    // 删除文件后必须 daemon-reload：systemd 才会卸载该单元的加载状态（否则 systemd-run 仍拒绝重建）
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
  }

  /** 用 systemd 启动实例（独立 transient unit/隔离环境）。沙箱注入独立 HOME/XDG/PATH/NODE_PATH。
   *  工业级健壮性：绝不抛异常（否则会打挂 tick 循环）；失败返回 {ok,error} 并由调用方做退避重试。 */
  _systemdStart(inst) {
    try {
      const cmdArr = this.effectiveCommand(inst);
      if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
      // 端口被占：不启动（避免抢占/双实例），交给调用方重试/告警
      if (this._probeState(inst).running) return { ok: false, error: '端口 ' + inst.port + ' 已被占用' };
      const sysdArgs = [
        '--user', '--unit=dsh-web@' + inst.id,
        '--property=KillMode=process',
        '--property=MemoryMax=' + ((inst.sandbox && inst.sandbox.memoryMax) || '8G'),
        '--property=CPUQuota=' + ((inst.sandbox && inst.sandbox.cpuQuota) || '200%'),
        '--property=PrivateTmp=' + (inst.sandbox.privateTmp ? 'yes' : 'no'),
        '--property=ProtectHome=' + (inst.sandbox.protectHome ? 'yes' : 'no'),
        '--property=Restart=no',
      ];
      if (inst.domain === 'sandbox') {
        const dataDir = this.sandboxDataDir(inst);
        const installDir = this.sandboxInstallDir(inst);
        const nodeBinDir = path.dirname(process.execPath);
        const paths = [nodeBinDir, path.join(installDir, 'bin'), process.env.PATH || ''].join(':');
        sysdArgs.push(
          '--setenv=HOME=' + dataDir,
          '--setenv=XDG_CONFIG_HOME=' + dataDir,
          '--setenv=XDG_DATA_HOME=' + dataDir,
          '--setenv=PATH=' + paths,
          '--setenv=NODE_PATH=' + path.join(installDir, 'lib', 'node_modules'),
          '--working-directory=' + dataDir,
        );
      }
      this._cleanStaleUnit('dsh-web@' + inst.id);
      try {
        execFileSync('systemd-run', [...sysdArgs, '--', ...cmdArr]);
      } catch (e) {
        const msg = 'systemd 启动失败: ' + (e.message || e);
        inst.state.lastError = msg;
        this.save();
        if (this.events) this.events.append('inst_start_failed', { id: inst.id, name: inst.name, error: msg });
        return { ok: false, error: msg };
      }
      inst.state.phase = 'STARTING';
      inst.state.startAt = Date.now();
      inst.state.lastError = null;
      this.save();
      this._startLanForInstance(inst);
      if (this.events) this.events.append('inst_started', { id: inst.id, port: inst.port });
      this.logger.info && this.logger.info('started instance ' + inst.name + ' (dsh-web@' + inst.id + ')');
      return { ok: true };
    } catch (e) {
      this.logger.error && this.logger.error('_systemdStart error ' + inst.id + ': ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  /** 用 systemd 拉起实例（独立 unit，不牵连他人），并注入沙箱 toml。
   *  async：沙箱实例首次启动需异步安装 DSH（走全局镜像源）。调用方（api/supervisor/tick）均按 async 处理。 */
  async startInstance(id, opts) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!this.sandboxSupported) return { ok: false, error: '当前平台不支持沙箱实例（需 Linux + systemd-run，见 /env/status capabilities.multiInstance）' };
    // 手动启动不受「守护(自动拉起)」开关限制：守护只控制进程挂了是否自动拉起，不影响手动启停/安装。
    this._prepareSystemd();
    // 沙箱实例：install 目录没有完整 DSH 副本 → 先独立安装（装配作业化：以 TaskRegistry 作业执行，
    // 装完由监督拍按作业结果 systemd 拉起）。升级/安装作业进行中 → 幂等返回（不双开安装）。
    if (inst.domain === 'sandbox') {
      if (this.tasks && this.tasks.isBusy('instance', id)) {
        return { ok: true, installing: true, already: true };
      }
      this._ensureSandboxDirs(inst);
      const dshEntry = path.join(this.sandboxInstallDir(inst), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(dshEntry)) {
        const r = await this._installSandbox(inst);
        if (!r.ok) return { ok: false, error: '沙箱实例安装 DSH 失败: ' + (r.error || 'unknown') };
        return { ok: true, installing: true };
      }
    }
    return this._systemdStart(inst);
  }

  stopInstance(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!this.sandboxSupported) return { ok: false, error: '当前平台不支持沙箱实例（需 Linux + systemd-run）' };
    try { execFileSync('systemctl', ['--user', 'stop', 'dsh-web@' + inst.id], { timeout: 20000 }); } catch {} // RC4：有界，防 dbus 挂起冻结守卫
    inst.state.phase = 'STOPPED';
    this.save();
    this._stopLanForInstance(inst);
    if (this.events) this.events.append('inst_stopped', { id: inst.id });
    return { ok: true };
  }

  /* 远程控制关联：实例启动/停止时通知 supervisor 生成/停止反向代理。
   * 是否生成代理由 inst.remoteEnabled + supervisor 的 _lanInstanceStart 共同决定。 */
  _startLanForInstance(inst) {
    if (!inst || !inst.port) return;
    if (this.onInstanceStart) this.onInstanceStart(inst);
  }

  _stopLanForInstance(inst) {
    if (!inst || !inst.port) return;
    if (this.onInstanceStop) this.onInstanceStop(inst);
  }

  /* ── 监督（单实例；R3 C3-4b 起由唯一心跳经 registry adapter 逐实例调用）── */
  /** 单实例监督拍：确定性健壮状态机（单实例 try/catch —— 单个实例异常绝不拖垮心跳循环）。
   *  状态：STOPPED → INSTALLING → STARTING → RUNNING → BACKOFF(自愈退避重试) → FAILED(暴露原因,用户可重试)。
   *  语义与旧 tick() 的 per-instance 段逐行一致（旧定时器循环并入唯一心跳）；域业务
   *  CRUD/安装/装配/systemd/持久化保留本模块（本方法只做监督收敛 + 周期令牌回填）。 */
  supervise(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    const now = Date.now();
    try {
      const st = this._probeState(inst);
      inst.state.lastProbeOk = st.running;
      // 令牌回填与实例 phase 解耦（2026-09，docs/token-management.md）：
      // 原仅在 RUNNING 分支 ensureCaptured——长驻/孤立（单元在跑但状态机非 RUNNING）实例在守卫重启后
      // 令牌永远不回填 → 远程 relay 无 cookie 401（实测 inst-…920）。服务内自带节流（已有令牌即返回）。
      if (inst.domain === 'sandbox' && this.tokens) { try { this.tokens.ensureCaptured(inst.id); } catch {} }
      const state = inst.state;
      const guarded = guardian.shouldGuard(inst); // 守护(自动拉起)开关：只影响「挂了是否自动拉起」，不影响手动启动流程
      switch (state.phase) {
        // 安装中：装完 → systemd 拉起；装失败/超时 → FAILED；期间若已监听(直接可跑) → 运行
        case 'INSTALLING': {
          // R3 遗留「装配作业化」：装配完成/失败/看护由 TaskRegistry 作业驱动——本分支只读
          // 作业态/镜像结果收敛（不再硬编码 10min 超时；超时看护移入作业执行器 _installSandbox）。
          if (st.running) { this._setRunning(inst, st, now); break; }
          if (state.installOk === true) {
            const r = this._systemdStart(inst);
            if (!r.ok) this._restartInstance(inst, '启动失败:' + r.error);
            break;
          }
          if (state.installOk === false) {
            this._failInstance(inst, state.installError || '安装失败');
            break;
          }
          if (this.tasks) {
            // 作业在跑 → 等待；无作业且无结果 → 中断恢复（守卫重启/任务中断遗留态）
            if (!this.tasks.current('instance', inst.id)) {
              let why = '安装中断（无进行中安装任务）';
              try {
                const recent = this.tasks.list('instance').find((t) => t.target && t.target.id === inst.id && t.action === 'install');
                if (recent && (recent.state === 'failed' || recent.state === 'canceled')) why = recent.error || why;
              } catch {}
              this._failInstance(inst, why);
            }
          } else if (state.installAt && now - state.installAt > 10 * 60 * 1000) {
            // 无任务注册表环境（测试/降级构造）：保留看护兜底，不丢超时语义
            this._failInstance(inst, '安装超时(10分钟)');
          }
          break;
        }
        // 启动中：端口起来 → 运行；超时(30s) → 退避重试（DSH 可能失败/端口冲突）
        case 'STARTING': {
          if (st.running) this._setRunning(inst, st, now);
          else if (state.startAt && now - state.startAt > 30000) this._restartInstance(inst, '启动超时: DSH 未监听端口');
          break;
        }
        // 运行中：挂了 → 守护开则退避自愈，否则回到「停止」(非"失败"——只是没在跑且用户未守护)
        case 'RUNNING': {
          if (!st.running) {
            if (guarded) this._restartInstance(inst, '实例进程退出');
            else this._setStopped(inst);
          } else if (inst.domain === 'sandbox' && this.tokens) {
            // 守卫重启后内存令牌空置（令牌服务不落盘）：周期回填（服务内部 30s 节流）直到重新捕获，
            // 避免“实例在跑但 DSH Web / 远程控制无令牌”401。
            this.tokens.ensureCaptured(inst.id);
          }
          break;
        }
        // 退避：到期 → 重试启动；启动失败 → 继续退避（自愈）
        case 'BACKOFF': {
          if (state.backoffUntil && now >= state.backoffUntil) {
            this.startInstance(inst.id).then((r) => {
              if (!r || (!r.ok && !r.installing)) this._restartInstance(inst, '重试失败:' + ((r && r.error) || ''));
            }).catch((e) => this._restartInstance(inst, '重试异常:' + (e && e.message)));
          }
          break;
        }
        default: break; // STOPPED / FAILED：保持，由用户手动 startInstance 重置
      }
      this.save();
    } catch (e) {
      this.logger.error && this.logger.error('supervise ' + inst.id + ' error: ' + e.message);
    }
    return { ok: true };
  }

  /** 设置实例运行中。 */
  _setRunning(inst, st, now) {
    const state = inst.state;
    state.phase = 'RUNNING';
    state.lastError = null;
    // 稳定运行后重置崩溃计数（时间窗语义）：距上次失败 >5 分钟视为已恢复稳定，
    // 清零 restartCount/backoffLevel——否则偶发重启（间隔数天/数小时）会跨时间无限累计
    // 到 20 次上限触发永久 FAILED（2026-09 审计修复：restartCount 永不归零缺陷）。
    if ((state.lastFailAt || 0) && now - state.lastFailAt > 5 * 60 * 1000) {
      if ((state.restartCount || 0) > 0 || (state.backoffLevel || 0) > 0) {
        state.restartCount = 0;
        state.backoffLevel = 0;
        state.lastFailAt = null;
      }
    }
    if (this.events) this.events.append('inst_running', { id: inst.id, name: inst.name, pid: st.pid });
    // 沙箱实例同样走 DSH 浏览器会话认证（新版）：统一令牌服务负责捕获（journald 源），
    // 进入 RUNNING 即启动退避重试（“端口先起、URL 后打印”竞态 / 令牌轮换收敛由服务内策略覆盖），
    // 令牌变化经服务 onChange 统一下发（relay 热换 cookie），实例侧不持有/不转发令牌。
    if (inst.domain === 'sandbox' && this.tokens) {
      // 沙箱令牌源只登记 journald 单元（-g 取最近行）；不登记 file 避免旧 token 缓存 block journal
      this.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
      this.tokens.scheduleCapture(inst.id);
    }
  }

  /** 设置实例回到「停止」（未运行且未守护：不算失败，只是停着）。 */
  _setStopped(inst) {
    const state = inst.state;
    state.phase = 'STOPPED';
    state.lastError = null;
    this.save();
  }

  /** 实例失败（安装/启动失败）：进入 FAILED 并暴露原因，由用户手动重试；不无限自愈（避免白费资源）。 */
  _failInstance(inst, reason) {
    const state = inst.state;
    state.phase = 'FAILED';
    state.lastError = reason;
    if (this.events) this.events.append('inst_failed', { id: inst.id, name: inst.name, reason });
    this.logger.error && this.logger.error('instance ' + inst.name + ' FAILED: ' + reason);
    this.save();
  }

  /** 实例异常：进入退避（BACKOFF），到期由监督拍自动重试。始终带最小等待，避免紧循环打爆；超过最大重试次数则 FAILED（暴露原因，避免无限白忙）。 */
  _restartInstance(inst, reason) {
    const state = inst.state;
    const attempts = (state.restartCount || 0) + 1;
    if (attempts > 20) { // 超过 20 次仍起不来 → 判定失败，交给用户处理
      state.restartCount = attempts;
      this._failInstance(inst, '重试超限(' + reason + ')');
      return;
    }
    state.phase = 'BACKOFF';
    state.restartCount = attempts;
    state.lastFailure = reason;
    const now = Date.now();
    const d = guardian.instanceRestartDecision(state, now);
    state.lastFailAt = now;
    state.backoffLevel = d.nextBackoffLevel;
    state.backoffUntil = now + Math.max(d.waitMs, 5000); // 至少 5s，防紧循环
    if (this.events) this.events.append('inst_restarted', { id: inst.id, name: inst.name, reason, waitMs: Math.max(d.waitMs, 5000) });
    this.logger.warn && this.logger.warn('instance ' + inst.name + ' ' + reason + ', retry in ' + Math.max(d.waitMs, 5000) + 'ms');
    this.save();
  }

  /** 兜底定时驱动（R3 C3-4b 主路径不使用——实例监督并入守卫唯一心跳；仅当守卫侧
   *  ManagedRegistry 不可用（极罕见）时由 supervisor.start 调用，保证沙箱不被放养）。 */
  startTimer(intervalMs) {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      for (const inst of this.instances) {
        if (inst.domain === 'native') continue;
        try { this.supervise(inst.id); } catch {}
      }
    }, intervalMs || 5000);
  }
}


module.exports = { InstanceManager };
