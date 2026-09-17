'use strict';

// 镜像源选择与探测（IO）：消费壳投放的镜像契约（registry.json），维护内核的 registry
// 配置/选择结果并做可达性探测。状态由 DistributionManager 门面持有，本文件函数显式收参
// （state），不碰跨文件 this，可独立 require 后传假 state 单测。

const fs = require('node:fs');
const path = require('node:path');
const matrix = require('../contract/matrix');
const registryContract = require('../contract/registry');
const policies = require('./policies');

/** 壳投放契约的重载 TTL（ms）：壳会在运行中重写 registry.json，内核必须能看到。 */
const CONTRACT_TTL_MS = 60 * 1000;

/** 内核平台标签（用于展开契约的 pathTemplate）。平台知识收口到 platform/contract/matrix.js；
 *  matrix.npmTag 的抛错文案是既有对外契约（被 arch-validation 门禁断言），不得改动。 */
function platformTag() {
  return matrix.npmTag();
}

/** 距上次载入超过 CONTRACT_TTL_MS 则重载壳投放的镜像契约。用 TTL 而非 fs.watch：契约读取
 *  在多个函数入口被调用，TTL 实现简单、无句柄泄漏、跨平台一致，60s 对低频的镜像选择足够新。 */
function reloadContractIfStale(state) {
  const now = Date.now();
  if (state._contractLoadedAt && (now - state._contractLoadedAt) < CONTRACT_TTL_MS) return;
  loadRegistryConfig(state);
  state._contractLoadedAt = now;
}

/** 载入镜像配置与壳投放的契约。优先级（高到低）：1) 用户手动固定 mode=manual；2) 契约 catalog；
 *  3) 构造参数；4) 最小兜底。契约不可用时不阻断：记录 reason 供诊断，选择路径自动回退（不变量 C2）。 */
function loadRegistryConfig(state) {
  // 1) 先读契约（即使下面是 manual，也要拿到 probe 规格用于复测）
  state.contract = registryContract.read(state.registryFile);
  if (!state.contract.ok) {
    state.logger.warn && state.logger.warn(
      'dist: 镜像契约不可用（' + state.contract.reason + '），回退到最小兜底（' +
      state.defaultRegistries.length + ' 条）'
    );
    if (state.events) {
      try {
        state.events.append('dist_contract_unavailable', {
          reason: state.contract.reason, file: state.registryFile,
        });
      } catch { /* 事件失败不阻断 */ }
    }
  }
  // 2) 旧字段（mode/manualOrigin/origins）保留读取，兼容 v1 与「内核自己写过的配置」
  if (!state.registryFile) return;
  try {
    if (!fs.existsSync(state.registryFile)) return;
    const doc = JSON.parse(fs.readFileSync(state.registryFile, 'utf8'));
    if (typeof doc !== 'object' || !doc) return;
    state.registryConfig = policies.rebuildRegistryConfig(doc, state.contract, state.defaultRegistries);
  } catch (e) {
    state.logger.warn && state.logger.warn('dist: registry config load failed: ' + e.message);
  }
}

/** 落盘 registry 配置。该文件的所有者是桌面壳（壳写入 v2 字段 catalog/probe/selected）：
 *  内核必须保留壳字段，只覆盖自己拥有的 mode/origins/manualOrigin，
 *  否则一次保存就抹掉壳的镜像解析依据。 */
function saveRegistryConfig(state) {
  if (!state.registryFile) return;
  try {
    const dir = path.dirname(state.registryFile);
    if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建目录失败不阻断 */ } }
    writeRegistryDoc(state);
  } catch (e) {
    state.logger.warn && state.logger.warn('dist: registry config save failed: ' + e.message);
  }
}

/** 读回原文档（保留壳字段与未来新增字段），只覆盖内核拥有的三键，原子写回。 */
function writeRegistryDoc(state) {
  const f = state.registryFile;
  const tmp = f + '.tmp';
  let doc = {};
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') doc = parsed;
  } catch { /* 首次写入：无原文件 */ }
  const rc = state.registryConfig || {};
  doc.mode = rc.mode;
  doc.origins = rc.origins;
  doc.manualOrigin = rc.manualOrigin;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** 探测单个 registry 的可达性 + 延迟。探测 URL 由契约决定（与壳同规格）。 */
async function probeRegistry(state, origin) {
  const spec = (state.contract && state.contract.ok && state.contract.probe) || null;
  const target = policies.resolveProbe(origin, spec, platformTag());
  const start = Date.now();
  try {
    // redirect:'manual' + 显式「非 2xx 即失败」—— 本函数是 SSRF 闭环的另一半：
    //   fetch 默认 follow，攻击者控制的公网源可 302 到内网地址，从而绕过 api 层的 host 策略
    //   （白名单 / RFC1918 / 云元数据地址 / IPv6 / 单标签主机名）。
    //   在 platform 层再实现一遍跳转目标校验会复制该策略、且会让 platform 反向依赖 api（违反分层），
    //   故取「不跟随重定向」这个更简单的安全默认。
    //   显式按状态码判定而非沿用 res.ok：把「3xx 即失败」写成意图（不同实现对 opaqueredirect
    //   可能给 status=0，一并覆盖），避免后来者误读为巧合。
    //   取舍：依赖 http→https 之类跳转的 registry 源从此报不可达 —— 攻击面 > 便利，可接受默认。
    const res = await fetch(target.url, { signal: AbortSignal.timeout(target.timeoutMs), redirect: 'manual' });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, latencyMs: Date.now() - start, probe: target.kind };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, probe: target.kind };
  }
}

/** 探测单个 origin 的可达性与延迟（供面板「测试」按钮同源调用）。复用 probeRegistry，
 *  即与内核选源使用完全相同的探测规格，否则「测试按钮说可达」与「实际选源结果」会再次分叉。 */
async function probeOrigin(state, origin) {
  const o = policies.normalizeOrigin(origin);
  if (!policies.isValidOrigin(o)) return { origin: o, ok: false, latencyMs: null, error: '非法 origin' };
  const p = await probeRegistry(state, o);
  return { origin: o, ok: !!p.ok, latencyMs: p.latencyMs, probe: p.probe };
}

function registryOrigins(state) {
  return policies.effectiveOrigins(state.registryConfig, state.defaultRegistries);
}

/** 选一个可达且最快的 registry。mode=manual 时锁定 manualOrigin。TTL 缓存 30min。返回 origin。 */
async function selectRegistry(state, force) {
  // 契约必须能重载：壳会在运行中重写 registry.json（catalog/probe/selected/mode）。内核进程若
  //   只看启动瞬间的契约，会出现「两侧选源不一致」与「手动设了不生效」。
  reloadContractIfStale(state);
  const rc = state.registryConfig || {};
  if (rc.mode === 'manual' && rc.manualOrigin) {
    const origin = policies.normalizeOrigin(rc.manualOrigin);
    state.selectedRegistry = { origin, latencyMs: null, checkedAt: Date.now(), manual: true, probes: [] };
    return origin;
  }
  const now = Date.now();
  if (!force && state.selectedRegistry && !state.selectedRegistry.manual && state.selectedRegistry.checkedAt
      && (now - state.selectedRegistry.checkedAt) < 30 * 60 * 1000) {
    return state.selectedRegistry.origin;
  }
  // 优先采用壳投放的选择结果（壳已完成同轮测速，且用同一探测规格）：正常路径零重复网络；
  //   仅当契约过期（超 TTL）或 force 时才自己复测。
  const c = state.contract;
  if (!force && c && c.ok && c.selected) {
    const age = Math.floor(Date.now() / 1000) - c.selected.checkedAt;
    if (age >= 0 && age < 30 * 60) {
      state.selectedRegistry = {
        origin: c.selected.origin, latencyMs: c.selected.latencyMs,
        checkedAt: Date.now(), manual: false, source: 'shell', probes: [],
      };
      if (state.events) {
        try { state.events.append('dist_registry_selected', { origin: c.selected.origin, source: 'shell-contract' }); } catch { /* 事件失败不阻断 */ }
      }
      return c.selected.origin;
    }
  }
  const origins = registryOrigins(state);
  const results = await Promise.all(origins.map(async (origin) => {
    const p = await probeRegistry(state, origin);
    return { origin, ok: p.ok, latencyMs: p.latencyMs };
  }));
  const picked = policies.pickFastestReachable(results);
  if (!picked) {
    // 全部镜像不可达：返回 null（调用方降级 npm 默认源）且不缓存失败选择。
    state.selectedRegistry = { origin: null, latencyMs: null, checkedAt: null, manual: false, probes: results };
    if (state.events) {
      state.events.append('dist_registry_unreachable', {
        candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms'),
      });
    }
    return null;
  }
  state.selectedRegistry = {
    origin: picked.origin, latencyMs: picked.latencyMs,
    checkedAt: Date.now(), manual: false, probes: results,
  };
  if (state.events) {
    state.events.append('dist_registry_selected', {
      origin: picked.origin, latencyMs: picked.latencyMs,
      candidates: results.map((r) => r.origin + ':' + r.latencyMs + 'ms'),
    });
  }
  return picked.origin;
}

/** 镜像源信息（供 UI/API 展示）。 */
async function registryInfo(state) {
  reloadContractIfStale(state);
  const origin = await selectRegistry(state, false);
  const rc = state.registryConfig || {};
  const c = state.contract;
  const sel = state.selectedRegistry;
  return {
    origin,
    mode: rc.mode || 'auto',
    manualOrigin: rc.manualOrigin || '',
    candidates: registryOrigins(state).map((o) => ({ origin: o })),
    // 预设 = 壳投放的目录（契约）；契约不可用时为空数组，UI 应展示 candidates。
    presets: (c && c.ok) ? c.catalog : [],
    catalogSource: (c && c.ok) ? (c.writtenBy || 'shell') : 'fallback',
    latencyMs: (sel && sel.latencyMs) || null,
    checkedAt: (sel && sel.checkedAt) || null,
    manual: !!(sel && sel.manual),
    probes: (sel && sel.probes) || [],
  };
}

/** 保存全局镜像源配置（mode/手动源/候选），并立即重测。 */
async function setRegistryConfig(state, cfg) {
  const rc = state.registryConfig || {};
  let rejected = [];
  if (cfg && typeof cfg === 'object') {
    if (cfg.mode === 'manual' || cfg.mode === 'auto') rc.mode = cfg.mode;
    if (typeof cfg.manualOrigin === 'string') rc.manualOrigin = cfg.manualOrigin.trim();
    if (Array.isArray(cfg.origins)) {
      const raw = cfg.origins.map((x) => String(x).trim());
      const list = raw.filter((x) => policies.isValidOrigin(x));
      // 非法项不得静默丢弃：用户改了自己的镜像源却不知道哪条被丢。收集后在下方经日志与返回值暴露。
      rejected = raw.filter((x) => x && !policies.isValidOrigin(x));
      if (list.length) rc.origins = list; // 全部非法时保留既有 origins（不写成空）
    }
  }
  state.registryConfig = rc;
  saveRegistryConfig(state);
  state.selectedRegistry = null; // 清缓存，立即重测
  const info = await registryInfo(state);
  if (rejected.length) {
    if (state.logger && state.logger.warn) {
      state.logger.warn('[registry] 已忽略 ' + rejected.length + ' 个非法镜像源（需 http(s):// 前缀）：' +
        rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? ' …' : ''));
    }
    info.rejectedOrigins = rejected; // 调用方（/dist/registry）直接回传本对象，UI 可见
  }
  return info;
}

module.exports = {
  CONTRACT_TTL_MS,
  platformTag,
  reloadContractIfStale,
  loadRegistryConfig,
  saveRegistryConfig,
  probeRegistry,
  probeOrigin,
  registryOrigins,
  selectRegistry,
  registryInfo,
  setRegistryConfig,
};
