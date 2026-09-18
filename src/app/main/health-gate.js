'use strict';

// app/main/health-gate.js —— 崩溃窗口/退避记账（_bumpCrashWindow）与假死判定（_applyHealthCheck）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
//
// 阶段六 B-2 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的**惰性 deps**。
// 方法名/{ methods }/逐字体保留，装配路径与读源码形态的门禁不变，AT 棘轮计数归零。
const guardian = require('../../shared/guardian');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      state() { return host.state; },
      events() { return host.events; },
      logger() { return host.logger; },
      ui() { return host.ui; },
      // 字段 helper 经 host 上的既有安装转发（等价于原经 this 的调用）。
      mCrashWindowStart() { return host._mCrashWindowStart(); },
      mCrashWindowRestarts() { return host._mCrashWindowRestarts(); },
      mBackoffLevel() { return host._mBackoffLevel(); },
      mSetCrashWindowStart(v) { return host._mSetCrashWindowStart(v); },
      mSetCrashWindowRestarts(v) { return host._mSetCrashWindowRestarts(v); },
      mSetBackoffLevel(v) { return host._mSetBackoffLevel(v); },
      mSetBackoffUntil(v) { return host._mSetBackoffUntil(v); },
      mSetFailStreak(v) { return host._mSetFailStreak(v); },
      mFailStreak() { return host._mFailStreak(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  _bumpCrashWindow() {
    const d = depsOf(this);
    const now = Date.now();
    // 崩溃窗口 + 退避决策统一交 domain/guardian（对原生与实例共用）
    const dec = guardian.bumpCrashWindow(
      { start: d.mCrashWindowStart(), restarts: d.mCrashWindowRestarts() },
      now,
      { crashWindowMs: d.config().crashWindowMs, crashBurst: d.config().crashBurst, backoff: d.config().backoff, backoffLevel: d.mBackoffLevel() }
    );
    d.mSetCrashWindowStart(dec.start);
    d.mSetCrashWindowRestarts(dec.restarts);
    d.mSetBackoffLevel(dec.backoffLevel);
    if (dec.backoffEntered) {
      d.mSetBackoffUntil(dec.backoffUntil);
      d.state().setPhase('BACKOFF');
      d.events().append('crash_loop_entered', {
        level: dec.backoffLevel,
        waitMs: d.config().backoff[dec.backoffLevel],
      });
      d.logger().error('crash loop entered: level=' + dec.backoffLevel + ' waitMs=' + d.config().backoff[dec.backoffLevel]);
      d.ui().notify('DSH 反复崩溃', '已进入第 ' + dec.backoffLevel + ' 级退避（' + Math.round(d.config().backoff[dec.backoffLevel] / 1000) + 's），请查看 dsh-supervisor 面板');
    }
  },

  /** 假死识别（健康维度判定）：进程/端口在但 HTTP 不健康时连续 failThreshold 次判故障重启。
   *  单次抖动不清零（failStreak 单调累积直到达到阈值或恢复健康），达到阈值即触发。
   *  httpProbeEnabled=false 时 healthOk 恒为 true（monitor.probe 已退化），此处天然不触发。
   *
   *  本方法只记账 + 返回决策，不直接调 main.beginRestart()（否则造成
   *  health-gate -> process 反向边）；执行由收敛器（main/controller.js）承担。
   *  依赖单向：controller/process -> health-gate。 */
  _applyHealthCheck(healthOk) {
    const d = depsOf(this);
    if (healthOk) {
      d.mSetFailStreak(0);
      return { restart: false };
    }
    d.mSetFailStreak(d.mFailStreak() + 1);
    const threshold = d.config().failThreshold || 2;
    if (d.mFailStreak() >= threshold) {
      d.events().append('unhealthy', { reason: 'http_unhealthy', streak: d.mFailStreak() });
      return { restart: true, reason: 'http_unhealthy', countCrash: true };
    }
    return { restart: false };
  }
  },
};
