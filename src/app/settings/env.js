'use strict';

const platform = require('../../platform/os/index');

// 环境状态门面（壳写 runtime.json；EnvCatalog 声明式探测）。
// 导出形态 { methods }，方法经 this 协作。
const fs = require('node:fs');
const path = require('node:path');
const { EnvCatalog } = require('../../platform/service/env-catalog');

function envCatalogSummary(that) {
  const cat = new EnvCatalog(that.config);
  const extra = {};
  const d = that.dshenvStatus();
  extra.dsh = cat.dshEntry(d.binOk, d.installed, d.bin);
  extra.selfUpdate = cat.selfUpdateEntry();
  return cat.summary(extra);
}

module.exports = {
  methods: {
    envStatus() {
      const rt = {};
      try { const f = path.join(path.dirname(this.config.stateFile), 'runtime.json'); if (fs.existsSync(f)) Object.assign(rt, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {}
      const cat = new EnvCatalog(this.config).probe();
      const en = this.nativeManager && typeof this.nativeManager.checkEnvironment === 'function' ? this.nativeManager.checkEnvironment() : null;
      return {
        node: { detected: cat.node.detail || null, runtime: rt.nodeVersion || null, path: rt.nodePath || null },
        npm: { detected: cat.npm.detail || null },
        git: { detected: cat.git.detail || null },
        installedAt: rt.installedAt || null,
        source: rt.source || null,
        ok: cat.node.state === 'ok' && cat.npm.state === 'ok',
        npmRoot: en ? en.npmRoot : null,
        // EnvCatalog 声明式视图（面板环境卡用）
        catalog: (envCatalogSummary(this)),
        // 平台能力矩阵：三平台静态档位 × 实际工具探测；前端据此做能力感知呈现与降级提示。
        capabilities: (() => { try { return platform.capabilities(); } catch { return null; } })(),
        // 桌面壳看护的观测快照：expose enabled/intervalMs/graceMs/absentForMs/restartsInWindow/
        //   everSawAlive/lastSkipReason/expectedAbsence，使「壳反复拉起失败」在面板可见。
        shellWatchdog: (() => {
          try { return this.shellWatchdog && typeof this.shellWatchdog.status === 'function' ? this.shellWatchdog.status() : null; }
          catch { return null; }
        })(),
      };
    },

    // ---- DSH 即安即用：本体安装状态判定（命令指向的 bin 可执行 + 已管实例版本）----
    dshenvStatus() {
      let bin = null, binOk = false, installed = null, cmdOk = false;
      try {
        const cmd0 = Array.isArray(this.config.command) ? this.config.command : [];
        cmdOk = cmd0.length > 0;
        bin = (cmd0[0] === 'node' && cmd0[1]) ? cmd0[1] : (cmd0[0] || null);
        if (bin) binOk = fs.existsSync(bin);
      } catch {}
      try { if (this.nativeManager && typeof this.nativeManager.installedVersion === 'function') installed = this.nativeManager.installedVersion(); } catch {}
      // main = 守卫核心服务（概念清分）：受管状态以 config.command 有效为准。
      return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this.state.phase() || null };
    },
  },
};
