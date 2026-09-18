'use strict';

const srcpath = require('../../platform/util/srcpath');

// 内核自更新状态 / 管家自身版本检查门面。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-5：直接调用与属性访问去 this（改经按 host 缓存的**惰性 deps**）。方法名/{ methods }/
// 逐字体保留；round8-fixes 的源码形态钉子同批改为按符号名。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ex = require('../../platform/util/exec');
// 平台知识唯一事实源（跨平台架构规范）：os/arch 到标签映射只在 src/platform/contract/matrix.js。
const matrix = require('../../platform/contract/matrix');
const { semverCompare } = require('../../shared/version');
const deploy = require('../../platform/contract/deploy'); // 自更新形态判定（deploy.detect）

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config,
      dist: () => host.dist,
      events: () => host.events,
      guardVersion: () => host.guardVersion,
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      guardCorePkg: () => host.guardCorePkg(),
      readBinarySelfVersion: () => host._readBinarySelfVersion(),
      vcsRoot: () => host._vcsRoot(),
      guardVersionLocal: () => host.guardVersionLocal(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    // ---- 内核更新（单写入者契约：安装/重启归桌面壳）----
    // 内核 npm 包的唯一写入者是桌面壳（见 RELEASE-AND-UPDATE-MECHANISM.md §6）；
    // 守卫只保留只读的 guardSelfUpdateStatus，接口 /self-update/apply|restart-guard 返回 410。

    /** 内核 npm 子包名（按当前平台/架构）。corePackageName 可为显式常量或含 {os}/{arch} 占位的模板。 */
    guardCorePkg() {
      const d = depsOf(this);
      const raw = d.config().corePackageName;
      if (!raw) return null;
      return String(raw).replace(/{os}/g, matrix.osTag()).replace(/{arch}/g, matrix.current().arch) || null;
    },

    /** 内核更新状态（只读；安装/重启归桌面壳，单写入者契约）。
     *  查 @dsh-sup/dsh-core-<os>-<arch> 的通道版本（RELEASE-CHANNEL-CONTRACT §3：
     *  rollback -> canary -> latest；latest 缺失才回落最高），与本机 guardVersion 比较。
     *  本方法不写任何东西：面板据此显示可更新，实际安装由桌面壳 kernel_update_apply 执行。 */
    async guardSelfUpdateStatus() {
      const d = depsOf(this);
      const pkg = d.guardCorePkg();
      if (!pkg) return { ok: false, error: '未配置内核包（corePackageName）' };
      if (!d.dist() || typeof d.dist().fetchLatestVersion !== 'function') return { ok: false, error: '发布服务未初始化' };
      // 部署形态判定：源码开发形态（bin 壳 require 源码目录）不适用 npm 分发的版本口径——显式说明。
      const dep = deploy.detect();
      if (!dep.updatable) {
        return { ok: false, error: dep.reason, form: dep.form, updatable: false };
      }
      try {
        // authoritative：查官方 registry——镜像同步延迟会把新版本误判为『已是最新』。
        const latest = await d.dist().fetchLatestVersion(pkg, d.config().releaseChannel || 'npm', { authoritative: true });
        const installed = d.guardVersion();
        if (!latest) return { ok: false, error: '官方源不可达或未查询到版本' };
        const updateAvailable = semverCompare(latest, installed) > 0;
        if (d.events()) d.events().append('guard_self_update_checked', { installed, latest, updateAvailable });
        return { ok: true, pkg, installed, latest, updateAvailable, form: dep.form, updatable: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /** 读磁盘上运行位的自报版本（A1 校验用）：spawn --version，解析 guardVersion= 行。
     *
     *  条件为「可更新的标准形态」（updatable === true，即 sea-binary 或 launcher）：
     *    发布形态已弃 SEA 改为文本 launcher，launcher 的 <pkg>/bin/dsh-supervisor 同样是可执行入口
     *    （require('../../core.cjs')），spawn 它能得到同样的 --version 输出。若只认 sea-binary，
     *    真实用户永远读不到磁盘实况版本，updatePending 恒 false（「已装好待重启」永不显示）。
     *  source-shell（源码形态）不支持：其 --version 报的是开发目录版本，与 npm 安装无关。
     */
    _readBinarySelfVersion() {
      const dep = deploy.detect();
      if (!dep.updatable || !dep.runningTarget) return null;
      try {
        const out = ex.runOut(dep.runningTarget, ['--version'], { timeoutMs: 20000 });
        // 正则必须用 /dsh-supervisor v([^\s]+)/：字符类若写成 [^s]（非字母 s），
        //   版本串里一旦出现 s 就截断，且 \n 不在排除集内会跨行吞字符，污染 verified 判定。
        const m = /dsh-supervisor v([^\s]+)/.exec(out);
        return m ? m[1] : null;
      } catch { return null; }
    },

    // 管家自身版本检查（与 DSH 更新解耦）：本地仓库 git 视角，配了远程才 fetch 比对。
    /** VCS 根解析：从包根上溯找最近的外层 .git（排除自身嵌套仓）。
     *  命中嵌套仓会使其 HEAD 与真实外层仓脱节，导致 UI 版本/commit 失真；找不到外层仓时回退包根。
     *  包根用 srcpath.resolvePackageRoot()（按 package.json 上溯），不能靠 __dirname 相对路径。 */
    _vcsRoot() {
      const dir = srcpath.resolvePackageRoot() || path.resolve(__dirname, '..');
      const innerGit = path.join(dir, '.git');
      let parent = path.dirname(dir);
      while (parent !== path.dirname(parent)) {
        const cand = path.join(parent, '.git');
        if (cand !== innerGit && fs.existsSync(cand)) return parent; // 最近的外层仓
        parent = path.dirname(parent);
      }
      return dir; // 无外层仓：回退自身（嵌套仓/部署态）
    },

    /** 本地视角（无网络 I/O，同步安全）：commit + 是否配了 upstream。 */
    guardVersionLocal() {
      const d = depsOf(this);
      const root = d.vcsRoot();
      let commit = null;
      commit = (ex.runOut('git', ['-C', root, 'rev-parse', '--short', 'HEAD']) || '').trim() || null;
      let upstream = 'local';
      try {
        const up = (ex.runOut('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}']) || '').trim();
        if (up) upstream = 'git-repo';
      } catch {}
      // version = 进程运行版本（启动时固化，打包态为编译期常量）。
      // 磁盘实况版本（runningVersion vs diskVersion 的 updatePending 判定）在 async guardVersionCheck。
      return { version: d.guardVersion(), runningVersion: d.guardVersion(), commit, updateAvailable: false, upstream, latest: d.guardVersion() };
    },

    /**
     * 完整版本检查（async）：本地 commit + 远端 fetch 比对。
     * 关键架构约束：git fetch 是网络 I/O，绝不能同步执行（会冻结整个事件循环，守卫假死且无法自愈）。
     * 这里用 execFile（异步）+ 10s 超时；fetch 失败/超时只降级为「本地视图」，不抛错。
     */
    async guardVersionCheck() {
      const d = depsOf(this);
      const base = d.guardVersionLocal();
      if (base.upstream !== 'git-repo') return base;
      const root = d.vcsRoot();
      const fetchOk = await new Promise((resolve) => {
        let settled = false;
        const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        try {
          const child = execFile('git', ['-C', root, 'fetch', '--quiet'], { timeout: 10000 }, (err) => done(!err));
          child.on('error', () => done(false));
        } catch { done(false); }
      });
      if (!fetchOk) return base; // fetch 失败：保持本地视图，不误报
      let updateAvailable = false;
      try {
        // git 可能因网络盘/凭证助手挂起，必须有界（原为裸 execFileSync，无 timeout）。
        const ahead = (ex.runOut('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}']) || '').trim();
        updateAvailable = parseInt(ahead, 10) > 0;
      } catch {}
      // 磁盘运行位实况版本 vs 进程运行版本：不一致 = 「更新已安装、待重启生效」
      const dep = deploy.detect();
      let diskVersion = null;
      // launcher 形态同样有运行位自报版本（见 _readBinarySelfVersion 说明）。
      if (dep.updatable) diskVersion = d.readBinarySelfVersion();
      const updatePending = !!(diskVersion && diskVersion !== d.guardVersion());
      return { ...base, diskVersion, updatePending };
    },
  },
};
