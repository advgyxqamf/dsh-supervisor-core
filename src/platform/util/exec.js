'use strict';

// 统一子进程执行器：同步 exec 的唯一入口（src 内只有本文件可调用 execFileSync/spawnSync）。
// 选项必须固定 timeout、killSignal=SIGKILL、windowsHide、显式 maxBuffer：
// timeout 到期默认发 SIGTERM，对挂起或被停住的进程可能无效；GUI 进程调用控制台程序会弹黑框；
// maxBuffer 默认 1MB，systemctl status 之类冗长输出会被误判为命令失败。
// 仅限守卫启动早期、CLI 一次性命令或无法异步的调用点；新增调用优先用 execFile + await。
// run() 同步执行，默认 15s 硬超时，失败或超时返回 null；runOut() 返回 stdout 字符串；
// runDetail() 返回 { ok, code, stdout, stderr, timedOut, error }。

const { execFileSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/** 默认输出上限（8MB）：足以容纳 systemctl status / ip route 等冗长输出。 */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** 把调用参数规范化为 execFileSync 选项，保证 timeout 与 killSignal 一定存在。 */
function options(opts) {
  const o = opts || {};
  return {
    // timeout 是历史别名：service.js 曾传 { timeout } 而被静默忽略，所有超时回落默认值（N1）。
    // 两种拼写都收，timeoutMs 优先；新调用一律用 timeoutMs。
    timeout: o.timeoutMs || o.timeout || DEFAULT_TIMEOUT_MS,
    // 必须 SIGKILL：SIGTERM 对挂起或被停住的进程可能无效，否则有超时等于没超时。
    killSignal: o.killSignal || 'SIGKILL',
    maxBuffer: o.maxBuffer || DEFAULT_MAX_BUFFER,
    stdio: o.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(o.encoding ? { encoding: o.encoding } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.input !== undefined ? { input: o.input } : {}),
  };
}

/** 有界执行：失败或超时返回 null（调用方自行降级）。 */
function run(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(o));
    // execFileSync 在未捕获 stdout 时命令成功也返回 null。本函数对外契约是失败/超时返回 null，
    // 故成功一律返回非 null（无 stdout 时给空 Buffer 或空串），否则调用方会把成功读成失败。
    if (out === null || out === undefined) {
      return o.encoding ? '' : Buffer.alloc(0);
    }
    return out;
  } catch (e) {
    if (o.logger && o.logger.warn) {
      try {
        o.logger.warn('[exec] ' + bin + ' ' + (args || []).join(' ').slice(0, 80) +
          ' failed: ' + ((e && e.message) || e));
      } catch {}
    }
    return null;
  }
}

/** 同 run，返回 stdout 字符串（失败或超时返回 null）。 */
function runOut(bin, args, opts) {
  const o = Object.assign({}, opts || {}, { encoding: 'utf8' });
  const r = run(bin, args, o);
  if (r === null) return null;
  try { return String(r); } catch { return null; }
}

/** 同 run，但返回结构化结果且不吞错误信息；用于区分命令失败与超时（二者对用户含义不同）。 */
function runDetail(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(Object.assign({}, o, { encoding: 'utf8' })));
    return { ok: true, code: '0', stdout: String(out || ''), stderr: '', timedOut: false, error: null };
  } catch (e) {
    // Node 超时错误：message 含 ETIMEDOUT，或被信号杀死时 signal 有值。
    const timedOut = !!(e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' ||
      /ETIMEDOUT|timed? ?out/i.test(String(e && e.message))));
    return {
      ok: false,
      code: (e && e.status != null) ? String(e.status) : null,
      stdout: String((e && e.stdout) || ''),
      stderr: String((e && e.stderr) || ''),
      timedOut,
      error: (e && e.message) ? String(e.message) : String(e),
    };
  }
}

module.exports = { run, runOut, runDetail, options, DEFAULT_TIMEOUT_MS };
