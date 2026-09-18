'use strict';

// 异步子进程统一封装（NO-CONSOLE-WINDOW-STANDARD §3，契约冻结）。
// 为什么需要：同步执行器 platform/util/exec.js 早已 windowsHide:true 且有门禁，而异步
// child_process.spawn 此前无约束；Windows 上 detached:true 会给子进程新建控制台窗口，
// windowsHide:true 正是用来隐藏它，故所有 detached 子进程必须同时带 windowsHide。
// 取舍：三个入口都把 windowsHide:true 作为固定项（调用方无法覆盖），避免回到逐处补字段的老路；
// 同时不改变既有 detached/stdio 语义（窗口可见性与生命周期设计正交）。
// 入口分工：detached = 独立进程组 + stdio 默认 ignore；piped = 可选独立进程组 + 管道；
// detachedIgnored = detached + stdio ignore（浏览器/OS 打开等完全脱离本进程的场景）。

const { spawn } = require('node:child_process');

/** 独立进程组（后台常驻：主 DSH / daemon / 反代）。
 *  固定 detached:true（进程组语义不得因隐藏窗口而丢失，kill(-pid) 依赖它）与 windowsHide:true。
 *  stdio 默认 ignore，允许经 opts.stdio 覆盖；覆盖只动 stdio，不放开 detached/windowsHide。 */
function detached(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    // 默认 ignore；显式 undefined 也回落 ignore，避免 stdio:undefined 的歧义。
    stdio: o.stdio === undefined ? 'ignore' : o.stdio,
  }));
}

/** 管道模式（需要读输出：npm install / 插件 CLI / frpc）。
 *  固定 stdio ['ignore','pipe','pipe'] 与 windowsHide:true；opts.detached 可显式覆盖（默认 false），
 *  因为是否自成进程组是调用方的生命周期决策，与窗口隐藏无关。 */
function piped(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: o.detached === true,
  }));
}

/** 浏览器 / OS 打开（完全脱离本进程，且不读任何输出）：等价于 detached + stdio ignore，
 *  单独成入口是为语义自解释，同样固定 windowsHide:true。 */
function detachedIgnored(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }));
}

module.exports = { detached, piped, detachedIgnored };
