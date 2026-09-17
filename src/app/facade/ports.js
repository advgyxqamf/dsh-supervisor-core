'use strict';

const probe = require('../../platform/util/probe');

// app/facade/ports.js —— 端口管理对外门面：聚合三份端口注册表并补 active 监听状态。
// 另两份姊妹注册表经 platform 只读聚合接口读取（不再 fs 直读，消除跨层旁路）；文件名由
// 本域侧提供，platform 不硬编码域知识（DS-G4）。
// 导出契约：module.exports = { methods }；内部走 this。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的
// **惰性 deps**（WeakMap；getter 每次读 host 实时值）。方法仍以 { methods } 导出、名字与体
// 逐字保留：装配路径 installMethods(host, mod.methods) 不变，AT 棘轮的直接方法调用计数归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。
const ports = require('../../platform/service/ports').shared;
const SIBLING_REGISTRIES = ['ports-lan.json', 'ports-router.json'];

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      logger() { return host.logger; },
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      portActives(list) { return host._portActives(list); },
      readPortActivesCache() { return host._portActivesCache; },
      writePortActivesCache(v) { host._portActivesCache = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  // 端口管理门面：统一端口 registry 清单经 sup 接口暴露（presentation 不直连 infra）。
  // 每条记录必须补 active（端口当前真实监听中），否则前端「状态」列全部显示停用。
  // 探测按端口集合整批缓存 3s TTL，避免前端 2s 心跳每次触发全量同步扫 /proc 挤占事件循环。
  async listPorts() {
    const d = depsOf(this);
    // 系统端口登记分散在 3 个注册表文件（同 stateDir）：
    //   ports.json（守卫共享：system/inst/oauth/managed-ctl）
    //   ports-lan.json（lan-daemon 独占：relay 隧道，managed 池 20000-23999）
    //   ports-router.json（router-daemon 独占：proxyInstance 反代，managed 池 20000-23999；
    //     providerApi 供应商端点，24000-25999）
    // /ports 必须聚合三文件去重合并，才是整个系统的运行状态。
    try { ports.reload(); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('ports reload: ' + (e && e.message)); }
    const byPort = new Map();
    const adopt = (rec) => {
      if (!rec || !Number.isInteger(rec.port) || !rec.role || byPort.has(rec.port)) return;
      byPort.set(rec.port, {
        port: rec.port, role: rec.role, owner: rec.owner || null,
        createdAt: Number.isInteger(rec.createdAt) ? rec.createdAt : Date.now(),
      });
    };
    // platform 只读聚合（本表 + 同目录两份姊妹注册表）；platform 不硬编码文件名。
    for (const r of ports.readAll(SIBLING_REGISTRIES)) adopt(r);
    // 运行状态视图归一化: oauthCallback 是登录瞬态回调(非服务)不进常驻列表; supervisor-api 历史残留段保留供 active 筛选
    const merged = [...byPort.values()].filter((r) => r.role !== "oauthCallback");
    const activeByPort = await d.portActives(merged.map((r) => r.port));
    const records = merged.map((r) => ({
      port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt,
      active: !!(activeByPort && activeByPort[r.port]) || false,
    }));
    const snap = ports.snapshotAll();
    // supervisor-api 多端口历史残留(3100/36360/36361): 只保留正在监听者, 废弃端口不占位
    const apiAct = records.filter((r) => r.role === "supervisor-api" && r.active);
    const out = apiAct.length ? records.filter((r) => r.role !== "supervisor-api" || r.active) : records;
    // 池容量可观测（工业标准：运维可见 used/free/utilization，池满前可预警/扩容）
    let capacity = null;
    try { capacity = (typeof ports.capacity === 'function') ? ports.capacity() : null; } catch {}
    return { records: out, snapshot: snap, capacity };
  },

  /** 端口集合激活探测（整批 3s TTL 缓存）。active=true 表示该端口当前有进程在监听。
   *  用纯 TCP connect（probe.portListening）判定：findListeningPid 需读 /proc/<pid>/fd 反查
   *  socket->pid，对守卫管理树外的孙进程（router-daemon 的反代子进程）常因读取权限返回 null，
   *  导致端口在监听却恒报 inactive。TCP connect 与端口是否被监听直接等价（同 isTaken 判占用
   *  语义），无需 /proc 权限，三平台一致。 */
  async _portActives(portsList) {
    const d = depsOf(this);
    const now = Date.now();
    const key = portsList.join(',');
    const cache = d.readPortActivesCache();
    if (cache && cache.key === key && now - cache.at < 3000) {
      return cache.map;
    }
    // 相对路径须相对本文件：../../platform/util/probe
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    d.writePortActivesCache({ key, at: now, map });
    return map;
  },
} };
