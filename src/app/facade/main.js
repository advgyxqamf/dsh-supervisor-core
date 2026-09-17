'use strict';

// app/facade/main.js —— 原生 DSH(main) 域只读门面（写动作 patchDshMain 在
// app/domain-actions/main.js）。只读白名单（DG-14 强制）：dshMainView / exposurePeers。
// 导出契约：module.exports = { methods }，方法内部走 this。

const methods = {
  /** main 的统一只读视图（守卫核心服务；端口事实源 = config.targetPort）。 */
  dshMainView() {
    const m = this.state.readMainMeta();
    const cmd = Array.isArray(this.config.command) ? this.config.command.slice() : [];
    return {
      id: 'main',
      name: '主实例',
      port: Number(this.config.targetPort || 3080),
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
        running: Boolean(this._mChild() || this._mAdoptPid()),
        phase: typeof this._mPhase === 'function' ? this.state.phase() : undefined,
        pid: this._mChild() ? this._mChild().pid : this._mAdoptPid(),
      },
    };
  },

  /** 只读：公网暴露冲突判定所需的受管实例清单（含 frp 字段，排除 main 自身）。
   *  供 app/domain-actions/main.js#patchDshMain 经宿主注入取用；只经实例域查询接口 all()，
   *  不直读其内部活数组（DG-11：消除跨域内部穿透）。 */
  exposurePeers() {
    return (this.instances ? this.instances.all() : []).filter((i) => i.id !== 'main');
  },
};

module.exports = { methods };
