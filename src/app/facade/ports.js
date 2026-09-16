'use strict';

const probe = require('../../platform/util/probe');

// 步骤 7 迁移：自 control-view.js 逐字搬出（2 个方法）。
// 端口管理对外门面：聚合三份端口注册表并补 active 监听状态。
// 方法体逐字复制，仅导出形态规范化为 module.exports = { methods }；内部仍用 this。

// AP1（批 8/10）：另两份注册表经 platform 只读聚合接口读取（不再 fs 直读，消除跨层旁路）。
//   文件名单由本域侧提供——platform 不硬编码域知识（DS-G4）。
const ports = require('../../platform/service/ports').shared;
const SIBLING_REGISTRIES = ['ports-lan.json', 'ports-router.json'];

module.exports = { methods: {

  // ---- 端口管理门面：统一端口 registry 清单经 sup 接口暴露（presentation 不直连 infra）----
  // 2026-09 修复：原实现 records 恒缺 active → 前端端口管理「状态」列全部显示停用（接线断裂）。
  // 现为每条记录补 active（端口当前真实监听中）。探测按「端口集合」整批缓存 3s TTL，
  // 避免前端 2s 心跳每次触发全量同步扫 /proc 挤占事件循环。
  async listPorts() {
    // 归一化收拢（2026-09）：系统端口登记分散在 3 个注册表文件（同 stateDir）——
    //   ports.json（守卫共享：system/inst/oauth/managed-ctl）
    //   ports-lan.json（lan-daemon 独占：relay 隧道，managed 池 20000-23999 —— 远程控制/局域网暴露端口）
    //   ports-router.json（router-daemon 独占：proxyInstance 反代，managed 池 20000-23999；
    //     providerApi 供应商端点，24000-25999 —— 智能路由实例）
    // /ports 必须聚合三文件去重合并，才是「整个系统的运行状态」；此前只返回守卫共享段，
    // 导致智能路由反代/供应商 API、relay 隧道端口在前端缺失（结构失衡）。
    try { ports.reload(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('ports reload: ' + (e && e.message)); }
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
    const activeByPort = await this._portActives(merged.map((r) => r.port));
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
   *  2026-09 复检根治：改为纯 TCP connect 探测（probe.portListening）——不再依赖 pid 映射。
   *  背景：findListeningPing 需读 /proc/<pid>/fd 反查 socket→pid，对本机「守卫管理树外/孙进程」
   *  （router-daemon 的反代子进程）常因读取权限返回 null → 端口明明在监听却恒报 inactive（前端端口
   *  管理「无任何实例激活」失真，实测 41038 在听而 active=false）。TCP connect 与端口是否被监听
   *  直接等价（同 platform/service/ports 的 isTaken 判占用语义），无需任何 /proc 权限，三平台一致。 */
  async _portActives(portsList) {
    const now = Date.now();
    const key = portsList.join(',');
    if (this._portActivesCache && this._portActivesCache.key === key && now - this._portActivesCache.at < 3000) {
      return this._portActivesCache.map;
    }
    // 拆分后相对路径须相对本文件：src/guard/supervisor/ → ../../platform/util/probe
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    this._portActivesCache = { key, at: now, map };
    return map;
  },
} };
