'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 插件域 —— CLI 执行（域：plugin / cli，无状态函数）
//
// F4：以目标描述的 env/runtime 起 dsh plugin 子进程，整树超时终止，逐行回吐日志。
//   registryOrigin / logger 全部显式入参（不再读 this）。
//   ⚠ 既有测试面（test/round8-fixes-test.js J-i）按域聚合断言本文件含：
//     spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], { env, detached: true }) /
//     process.kill(-child.pid, sig) / killTree('SIGTERM'|'SIGKILL') /
//     if (reg) { envBase.npm_config_registry = reg; / 无可用的 registry 镜像。
//   本文件承载这些实现，**文案与代码形态逐字保持**。
// ═══════════════════════════════════════════════════════════════════════════

// 统一 spawn 封装（SSOT NO-CONSOLE-WINDOW-STANDARD W1）：
//   插件 CLI 是 detached（需 -pid 杀整棵树），Windows 上 detached 会给子进程建控制台窗口，
//   故必须经 spawn.js 的 piped({detached:true}) —— 它把 windowsHide:true 作为固定项。
const spawn = require('../../platform/os/spawn');
// 平台知识唯一事实源（跨平台架构规范）：能力查询（进程组语义）经此，不自行判断 platform。
const matrix = require('../../platform/contract/matrix');
const { assertSafeCliArgs, cliArgv } = require('./policies');

const CLI_TIMEOUT_MS = 180000; // 单次 dsh plugin CLI 超时
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 经 dist 统一镜像源选择 registry origin（不可达降级官方源）。 */
async function registryOrigin(dist) {
  if (dist) { try { return dist.selectRegistry(false); } catch {} }
  return DEFAULT_REGISTRY;
}

/** 执行 dsh plugin CLI（整树终止 + 超时）。 */
function runCli({ target, args, opts, registryOrigin, logger }) {
  const guardErr = assertSafeCliArgs(args);
  const o = opts || {};
  const timeoutMs = o.timeoutMs || CLI_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (guardErr) return resolve({ ok: false, error: guardErr });
    let settled = false;
    let timer = null; // 提升到 executor 顶层：settle 必须能访问（此前 const 定义在 .then 内，settle 引用越界 → ReferenceError → resolve 不执行 → job 永久 running）
    const settle = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    Promise.resolve().then(() => registryOrigin()).then((regRaw) => {
      // ⚠ P1-6 修复（2026-09-12）：registry 为 null 时**不得写进 env**。
      //
      //   缺陷：selectRegistry 在全镜像不可达时**返回 null**（dist/index.js 的 selectRegistry 分支），
      //     而 Node 的 spawn 会把 env 值强转字符串 —— {X: null} 变成 'null'（已实测）。
      //     于是 pnpm 收到 npm_config_registry='null' → 报错内容与真实原因（无可用镜像）无关，
      //     把排查引向错误方向。
      //
      //   修法：null/空 → **不注入该键**（让 pnpm 用自身默认），并把无可用镜像如实记日志。
      const reg = regRaw || null;
      const envBase = Object.assign({}, process.env, target.env);
      if (reg) { envBase.npm_config_registry = reg; envBase.NPM_CONFIG_REGISTRY = reg; }
      else if (logger && logger.warn) logger.warn('plugin CLI: 无可用的 registry 镜像，回退 pnpm 默认（npmjs.org）');
      const env = envBase;
      let child;
      try {
        // 沙箱 target：固定 pnpm store（--store-dir 传给 dsh plugin → pnpm），
        // 防止 HOME 变化（沙箱隔离）导致 ERR_PNPM_UNEXPECTED_STORE。
        const cliArgs = cliArgv(target);
        // ⚠ P1-7 修复（2026-09-12）：detached: true 让子进程**自成进程组**，
        //   这样才能用 process.kill(-pid) 杀**整棵树**（同 dist/index.js 的 runNpmInstall 安装路径）。
        //   缺陷：原实现无 detached，且超时只用 child.kill() 杀**直接子进程** ——
        //     dsh plugin → pnpm 的**孙进程**（真正在跑安装的那个）会成为孤儿，
        //     继续占用 profile 目录与 pnpm store 锁。
        // 入口可能是包内 JS（原生绑定后 / 沙箱）→ 用 node <js> plugin …；纯垫片则直接执行。
        const argv0 = target.runtime || target.bin;
        const argvPrefix = target.runtime ? [target.bin] : [];
        child = spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], { env, detached: true });
      } catch (e) { return settle({ ok: false, error: e.message }); }
      // 整树终止（POSIX 进程组 / Windows 退化为单进程，与平台能力声明一致）
      const killTree = (sig) => {
        if (!child) return;
        try {
          // 能力查询（而非自行判断 platform）：POSIX 进程组语义只在支持的平台可用。
          if (matrix.supportsProcessGroup() && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch { try { child.kill(sig); } catch {} }
      };
      timer = setTimeout(() => {
        killTree('SIGTERM');
        // 兜底：SIGTERM 后 3s 若未退出则 SIGKILL（防不响应挂死）
        setTimeout(() => killTree('SIGKILL'), 3000).unref();
        settle({ ok: false, error: '执行超时（' + Math.round(timeoutMs / 1000) + 's）' });
      }, timeoutMs);
      const push = (buf) => {
        if (typeof o.onLine !== 'function') return;
        for (const l of String(buf).split(/\r?\n/)) { const t = l.trim(); if (t) { try { o.onLine(t); } catch {} } }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (e) => settle({ ok: false, error: e.message }));
      // 关键：用 exit（进程退出即触发）而非 close——dsh plugin CLI 完成后启动的后台子进程
      // 会继承 stdout pipe，导致 close 永不触发（job 永远 running）。exit 不依赖 stdio 关闭。
      child.on('exit', (code) => settle({ ok: code === 0, error: code === 0 ? null : '退出码 ' + code }));
    }).catch((e) => settle({ ok: false, error: e.message }));
  });
}

module.exports = { CLI_TIMEOUT_MS, DEFAULT_REGISTRY, registryOrigin, runCli };
