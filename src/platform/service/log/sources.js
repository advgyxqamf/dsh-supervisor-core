'use strict';

// ═══ DS-G4 源注册接口（platform 去域名词，DIRECTORY-STRUCTURE-DESIGN §4.2 反转法）═══
// 平台**不**硬编码任何业务源名：源名单由 app/ 在启动装配期经此接口注入。
//  - name : 聚合流 source 字段 / 水位键 / ctl 拉取身份
//  - key  : 装配短键——ctlPorts / daemonLogs / /logs/tail stream 的键（默认 = name）
//  - local: true 表示本进程本地推源（守卫自身），不参与 ctl 拉取
const LOCAL_SOURCE = 'guard';
const _sources = [];

function normalizeSource(name, opts) {
  const o = opts || {};
  if (typeof name !== 'string' || !name.trim()) return null;
  return { name, key: (typeof o.key === 'string' && o.key) ? o.key : name, local: o.local === true };
}

/** 注册（或覆盖）一个聚合源。@returns {boolean} 是否登记成功 */
function registerSource(name, opts) {
  const s = normalizeSource(name, opts);
  if (!s) return false;
  const i = _sources.findIndex((x) => x.name === s.name);
  if (i >= 0) _sources[i] = s; else _sources.push(s);
  return true;
}

/** 批量注册：元素可为 name 字符串或 { name, key?, local? } 描述符。 */
function registerSources(list) {
  for (const it of (Array.isArray(list) ? list : [])) {
    if (typeof it === 'string') registerSource(it);
    else if (it && typeof it === 'object') registerSource(it.name, it);
  }
}

/** 用给定名单**整体替换**已注册源（装配期幂等：重复调用结果一致）。 */
function setSources(list) { _sources.length = 0; registerSources(list); }

/** 已注册源快照（副本；供装配自检/测试）。 */
function getSources() { return _sources.map((s) => ({ name: s.name, key: s.key, local: s.local })); }

/** 未注入时的退化：只认本进程本地源，不猜测任何业务源名（DS-G4）。 */
function resolvedSources() {
  if (_sources.length) return _sources.slice();
  return [normalizeSource(LOCAL_SOURCE, { local: true })];
}

// 内部簿记事件类型：平台只持通用前缀；精确类型（域名词）由 app/ 装配期注入。
const _internalTypes = new Set();
/** 登记一个「内部簿记」事件类型（进审计、不进默认用户时间线）。 */
function registerInternalType(type) { const t = String(type || ''); if (t) _internalTypes.add(t); }
/** 整体替换内部簿记类型名单（装配期幂等）。 */
function setInternalTypes(list) { _internalTypes.clear(); for (const t of (Array.isArray(list) ? list : [])) registerInternalType(t); }

/** 内部簿记事件：进审计但不进默认用户时间线（/events 默认过滤，internal=1 显示）。 */
function isInternalEvent(type) {
  const t = String(type || '');
  if (t.startsWith('shadow_') || t.startsWith('managed_object_')) return true;
  // 守卫监督簿记（受监督 daemon 拉起/孤儿实例审计）：进审计不进用户时间线。
  // ⚠ 2026-09-16 域模型收口：原名单中的 'guardian_action' 已删除——其唯一生产者 _guardianEvent()
  //   是死代码（router/lan 归入域 B 后无调用者，见 control-view.js 删除说明），事件永不再产生。
  //   保留 router_daemon_supervised / orphan_audit（二者仍有真实生产者）。
  return _internalTypes.has(t);
}

// 事件人性化（穿透审计后）：给"裸类型"业务事件生成可读中文 message，写入 data.message；
// 前端事件行优先显示 data.message（fallback 才是原始 type/data）。不覆盖前端已专门格式化者。
function humaneMsg(type, data) {
  const d = data || {};
  const who = d.id === 'main' ? '主实例' : (d.id || '会话');
  switch (type) {
    case 'lan_cookie_exchanged': return who + ' 远程会话 cookie 已刷新';
    case 'lan_cookie_failed': return who + ' 远程会话 cookie 换取失败' + (d.error ? '：' + d.error : '');
    case 'dsh_token_captured': return who + ' DSH 令牌已捕获';
    case 'dsh_token_missing': return who + ' DSH 令牌缺失，等待捕获';
    case 'inst_added': return '新增沙箱实例：' + (d.id || '?');
    case 'inst_removed': return '删除沙箱实例：' + (d.id || '?');
    case 'inst_started': return '沙箱实例已启动：' + (d.id || '?');
    case 'inst_stopped': return '沙箱实例已停止：' + (d.id || '?');
    case 'inst_failed': return '沙箱实例失败：' + (d.reason || d.lastError || d.error || '?');
    case 'upgrader_started': return '开始升级 DSH' + (d.version ? ' 至 ' + d.version : '');
    case 'upgrader_done': return 'DSH 升级完成' + (d.version ? '，当前 ' + d.version : '');
    case 'upgrader_failed': return 'DSH 升级失败：' + (d.error || '未知原因');
    case 'upgrade_installed': return 'DSH ' + (d.version || '?') + ' 已安装';
    case 'api_failed': return 'API 请求失败：' + (d.error || d.message || '未知');
    default: return null;
  }
}

module.exports = {
  LOCAL_SOURCE, normalizeSource, registerSource, registerSources, setSources, getSources,
  resolvedSources, registerInternalType, setInternalTypes, isInternalEvent, humaneMsg,
};
