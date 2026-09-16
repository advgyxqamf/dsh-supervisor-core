'use strict';

const platform = require('../../platform/os/index');

// §7.6 拆分自 supervisor.js → app/settings/settings-view.js → app/settings/env.js（步骤7 分片 C）。
// 导出形态按 STEP7-INTERFACE-CONTRACT §2 统一为 { methods }；方法内部继续用 this 协作。
const fs = require('node:fs');
const path = require('node:path');
const { EnvCatalog } = require('../../platform/service/env-catalog');

// 环境目录摘要（随设置块迁移；原为 supervisor.js 模块级函数，仅本块使用）。
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
    // ---- 环境状态（Phase1 壳写 runtime.json；EnvCatalog 声明式探测）----
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
        // EnvCatalog 声明式视图（面板环境卡演进用）
        catalog: (envCatalogSummary(this)),
        // 平台能力矩阵（A1 断点修复）：三平台静态档位 × 实际工具探测。
        // 前端据此做能力感知呈现与降级提示（如 Windows/mac 不支持沙箱实例）——
        // 此前注释已承诺该字段，但实现未暴露，导致 UI 只能在后端报错后才知道。
        capabilities: (() => { try { return platform.capabilities(); } catch { return null; } })(),
        // ⚠ 2026-09-12（P2）：**接线桌面壳看护的观测快照**。
        //   `watchdog.status()` 的注释一直写着「供 /env/status 或诊断」，但**零生产消费**
        //   （全仓只有 e2e 测试读它）—— 于是「壳反复拉起失败」在面板上**不可见**。
        //   现如实暴露：enabled/intervalMs/graceMs/absentForMs/restartsInWindow/
        //   everSawAlive/lastSkipReason/expectedAbsence —— 排障时能直接看到看护在做什么。
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
      // main = 守卫核心服务(概念清分)：受管状态以 config.command 有效为准（不再依赖沙箱实例登记）
      return { installed, bin: bin || null, binOk, managed: cmdOk, phase: this.state.phase() || null };
    },
  },
  envCatalogSummary,
};
