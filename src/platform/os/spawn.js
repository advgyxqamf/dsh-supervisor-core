'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 异步子进程统一封装（NO-CONSOLE-WINDOW-STANDARD §3，契约**冻结**）
//
// 为什么需要这一层（SSOT §1 真机取证）：
//   · 内核 JS 的**同步**执行器 platform/util/exec.js 早已 windowsHide:true 并有门禁 G9-d；
//     而**异步** child_process.spawn 此前无任何统一约束 → 14 处裸调用、13 处漏 windowsHide。
//   · 关键机制（Node 官方文档）：Windows 上 options.detached=true 时
//     「The child will have its own console window」——**detached 本身**就会给子进程新建
//     一个控制台窗口，windowsHide:true 正是用来隐藏它。故所有 detached 子进程
//     （主 DSH / router·lan daemon / 反代实例）必须同时带 windowsHide:true，
//     否则真机上必弹黑框。
//
// 设计取舍（为什么固定项写死在封装内，而不是让调用方各自传）：
//   把 windowsHide 交给调用方 = 回到逐处补字段的老路，新代码/漏改处会再次弹窗（W5：靠门禁而非注释）。
//   因此三个入口都把 windowsHide:true 作为**固定项**，调用方无法覆盖；
//   同时**不改变**既有 detached/stdio 语义（SSOT W-2 / W-3）——窗口可见性与生命周期设计正交（§5 非目标）。
//
// 三个入口的分工（对应 SSOT §3）：
//   · detached()        —— 独立进程组 + stdio 默认 'ignore'（后台常驻）；
//   · piped()           —— 独立进程组可选 + stdio ['ignore','pipe','pipe']（需要读输出）；
//   · detachedIgnored() —— detached + stdio:'ignore'（浏览器/OS 打开等完全脱离本进程的场景）。
// ═══════════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');

/**
 * 独立进程组（后台常驻：主 DSH / daemon / 反代）。
 *
 * 固定 detached:true（W-2：进程组语义不得因隐藏窗口而丢失，kill(-pid) 依赖它）
 * 与 windowsHide:true（W-1）。stdio 默认 'ignore'，但允许调用方经 opts.stdio 覆盖
 * ——覆盖只动 stdio，**不会**放开 detached/windowsHide 这两项固定值。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?:object, stdio?:any, cwd?:string}} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
function detached(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    // 默认 'ignore'；显式传 undefined 也回落到 'ignore'（等价于不传，避免 stdio:undefined 被 Node 当缺省处理时的歧义）。
    stdio: o.stdio === undefined ? 'ignore' : o.stdio,
  }));
}

/**
 * 管道模式（需要读取输出：npm install / 插件 CLI / frpc）。
 *
 * 固定 stdio:['ignore','pipe','pipe'] 与 windowsHide:true；
 * opts.detached 可显式覆盖（默认 false）——因为「是否自成进程组」是调用方的生命周期决策，
 * 与窗口隐藏无关（W-3：封装只补 windowsHide，不改既有 detached 取值）。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?:object, cwd?:string, detached?:boolean}} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
function piped(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: o.detached === true,
  }));
}

/**
 * 浏览器 / OS 打开（完全脱离本进程，且不读任何输出）。
 *
 * 等价于 detached() + stdio:'ignore'；单独成一个入口是为了让调用方语义自解释
 * （「打开外部程序」而非「启动受管进程」），同时同样固定 windowsHide:true。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{env?:object, cwd?:string}} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
function detachedIgnored(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }));
}

module.exports = { detached, piped, detachedIgnored };
