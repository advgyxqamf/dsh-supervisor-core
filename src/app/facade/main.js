'use strict';

// app/facade/main.js —— 原生 DSH(main) 域只读门面（写动作 patchDshMain 在
// app/domain-actions/main.js）。只读白名单（DG-14 强制）：dshMainView / exposurePeers。
// 导出契约：module.exports = { methods }，方法内部走 this。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的
// **惰性 deps**（WeakMap；getter 每次读 host 实时值）。方法仍以 { methods } 导出、名字与体
// 逐字保留：装配路径 installMethods(host, mod.methods) 不变，AT 棘轮的直接方法调用计数归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      state() { return host.state; },
      config() { return host.config; },
      instances() { return host.instances; },
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mPhase() { return host._mPhase(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

const methods = {
  /** main 的统一只读视图（守卫核心服务；端口事实源 = config.targetPort）。 */
  dshMainView() {
    const d = depsOf(this);
    const m = d.state().readMainMeta();
    const cfg = d.config();
    const cmd = Array.isArray(cfg.command) ? cfg.command.slice() : [];
    return {
      id: 'main',
      name: '主实例',
      port: Number(cfg.targetPort || 3080),
      command: cmd,
      domain: 'native',
      kind: 'native',
      guardian: m.guardian,
      remoteEnabled: m.remoteEnabled,
      remoteToken: m.remoteToken,
      frpEnabled: m.frpEnabled,
      frpRemotePort: m.frpRemotePort,
      wanPort: m.wanPort,
      unitName: null, // systemd 托管已废弃：main 由守卫 spawn/观测
      // 实时运行态：native 条目缺 state 会导致远程控制页误判「实例已停止」
      state: {
        running: Boolean(d.mChild() || d.mAdoptPid()),
        phase: typeof d.mPhase === 'function' ? d.state().phase() : undefined,
        pid: d.mChild() ? d.mChild().pid : d.mAdoptPid(),
      },
    };
  },

  /** 只读：公网暴露冲突判定所需的受管实例清单（含 frp 字段，排除 main 自身）。
   *  供 app/domain-actions/main.js#patchDshMain 经宿主注入取用；只经实例域查询接口 all()，
   *  不直读其内部活数组（DG-11：消除跨域内部穿透）。 */
  exposurePeers() {
    const d = depsOf(this);
    const inst = d.instances();
    return (inst ? inst.all() : []).filter((i) => i.id !== 'main');
  },
};

module.exports = { methods };
