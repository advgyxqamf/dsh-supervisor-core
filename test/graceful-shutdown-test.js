#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 优雅停机必须**等异步停止完成**（第七轮 P1，2026-09-12）
//
// ## 缺陷
//
// `Supervisor.shutdown()` 内部要停内嵌 router/lan（反代实例、relay、frpc、端口释放），
// 走 `lifecycleManager.stopAll(...)` —— 那是 **async**（逐个 `await lc.stop()`）。
//
// 但 `shutdown()` 本身是**同步函数**，调用处**不 await**；
// 而所有调用方都在其后**立即 `process.exit`**：
//
//   bin 的 SIGTERM/SIGINT ： sup.shutdown(); process.exit(0);
//   bin 的 uncaughtException： sup.shutdown(); process.exit(1);
//   settings-view 自更新退出： shutdown(); process.exit(0);
//
// 于是 stop 只跑了同步前缀就被**截断** → 子进程与端口残留成孤儿 ——
// 正是 shutdown 里那段注释（「shutdown 必须停它们防孤儿」）声称要防的事。
//
// ## 锁定不变量
//   G-a  shutdown() 返回 Promise（可被 await）
//   G-b  shutdown() 内部 **await** stopAll
//   G-c  重复调用返回同一个 Promise（幂等）
//   G-d  没有任何调用方在 shutdown() 之后**同步**立即 process.exit
//   G-e  bin 的优雅退出有**超时兜底**（防某个 stop 卡住导致永不退出）
// ═══════════════════════════════════════════════════════════════════════════

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const sup = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
// ⚠ 2026-09-16 步骤7：shutdown() 已随关停编排下沉 app/session/shutdown.js，
//   且导出形态改为「host 首参自由函数」function shutdown(host) {...}。
//   本组静态断言因此改读**新家**并匹配新签名 —— 断言语义不变（仍锁 G-a/G-b）。
const shutdownSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'session', 'shutdown.js'), 'utf8');
const bin = fs.readFileSync(path.join(ROOT, 'bin', 'dsh-supervisor'), 'utf8');

const m = shutdownSrc.match(/function shutdown\(host\) \{[\s\S]*?\n\}/);
check('G-a 定位到 shutdown', !!m, m ? 'ok' : '未找到');
const body = m ? m[0] : '';
check('G-a shutdown 返回 Promise（_shutdownPromise）', /_shutdownPromise/.test(body), '有');
check('G-a 重复调用返回同一 Promise（幂等）',
  /if \(host\._stopping\) return host\._shutdownPromise/.test(body), '有');
check('G-b 内部 await stopAll（不再 fire-and-forget）',
  /await host\.lifecycleManager\.stopAll\(/.test(body), '有');
// 反向：确认没有未 await 的 stopAll 调用
check('G-b 无未 await 的 stopAll',
  !/[^t] host\.lifecycleManager\.stopAll\(/.test(body.replace(/await host\.lifecycleManager\.stopAll\(/g, '')), '已改');

// ── G-d：调用方不得同步 exit ──
{
  // 找出所有 `shutdown();` 后面紧跟 process.exit 的单行（旧缺陷形态）
  const bad = [];
  for (const [name, src] of [['supervisor.js', sup], ['bin/dsh-supervisor', bin]]) {
    src.split(String.fromCharCode(10)).forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith('//')) return;
      if (/shutdown\(\);\s*process\.exit/.test(l) || /shutdown\(\);?\s*\}\s*catch\s*\{\}\s*process\.exit/.test(l)) {
        bad.push(name + ':' + (i + 1));
      }
    });
  }
  check('G-d 无「shutdown() 后同步 process.exit」的调用点', bad.length === 0, bad.length ? bad.join(' | ') : '已改');
}

// ── G-e：bin 的优雅退出有超时兜底 ──
check('G-e bin 定义了 gracefulExit', /function gracefulExit\(/.test(bin), '有');
check('G-e 等待 shutdown 的 Promise（.then(() => sup.shutdown())）',
  /\.then\(\(\) => sup\.shutdown\(\)\)/.test(bin), '有');
check('G-e 有 8s 强退兜底（防 stop 卡住永不退出）',
  /shutdown 超时（8s）/.test(bin), '有');
check('G-e SIGTERM/SIGINT 均走 gracefulExit',
  /process\.on\('SIGTERM', \(\) => \{ gracefulExit\(0\); \}\)/.test(bin)
  && /process\.on\('SIGINT', \(\) => \{ gracefulExit\(0\); \}\)/.test(bin), '有');

// ── G-f：relay-daemon 必须等 frpc 退出（同类缺陷的第二处）──
//   `frpmgr.stop()` 是同步的：只发 SIGTERM，SIGKILL 兜底在 3s 后的 250ms 轮询里。
//   daemon 若紧接 process.exit 会终止该定时器 → 忽略 SIGTERM 的 frpc 成孤儿。
{
  const rd = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'daemon.js'), 'utf8');
  check('G-f relay-daemon 存在等待 frpc 退出的辅助', /waitFrpcExit/.test(rd), '有');
  check('G-f shutdown 不再同步 process.exit（改为 then 后退出）',
    !/try \{ lan\.shutdown\(\); \} catch \{\}\s*\n\s*try \{ events\.append\('lan_daemon_stopped'/.test(rd), '已改');
  check('G-f shutdown 内有强退兜底（防永不退出）',
    /setTimeout\(resolve, 4000\)/.test(rd), '有');
  // 对照：router-daemon 早已是 async 等待式（证明这是同仓已有人做对的模式）
  const rod = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'daemon.js'), 'utf8');
  check('对照：router-daemon 的 shutdown 是 async 等待式', /const shutdown = async \(\) =>/.test(rod), '是');
}

// ── 行为级：shutdown 的幂等与可 await ──
//   用最小 harness：只验「返回 Promise 且重复调用同一实例」，不触真实模块。
{
  // AP1（批 8/10）：shutdown 不再挂 Supervisor.prototype（原型挂载已消除）——
  //   直接 require 其家园模块，以 host 首参形态调用（新装配下的真实调用形态）。
  const { shutdown } = require(path.join(ROOT, 'src', 'app', 'session', 'shutdown.js'));
  const fake = {};
  fake._stopping = false;
  fake._shutdownPromise = null;
  fake.lifecycle = { beginShutdown() {} };
  fake.events = { append() {} };
  fake.logger = { info() {}, warn() {} };
  fake.writeState = () => {};
  let stopCalls = 0;
  fake.lifecycleManager = {
    get: () => null,
    stopAll: async () => { stopCalls++; await new Promise((r) => setTimeout(r, 5)); },
  };
  fake._routerDaemonActive = () => false;
  const p1 = shutdown(fake);
  const p2 = shutdown(fake);
  check('G-a 行为：shutdown 返回 thenable', p1 && typeof p1.then === 'function', typeof p1);
  check('G-c 行为：重复调用返回同一 Promise', p1 === p2, p1 === p2 ? '同一实例' : '不同');
  p1.then(() => {
    check('G-b 行为：await 后 stopAll 已执行完', stopCalls === 1, stopCalls + ' 次');
    const failed = results.filter((r) => !r);
    console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
    process.exit(failed.length ? 1 : 0);
  });
}