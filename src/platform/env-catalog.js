'use strict';

// EnvCatalog：声明式环境目录（Phase2 收口）。
// 每条目 = { id, label, required, probe() → ok?detail }；状态机 ok/missing/unconfigured。
// 消费方：supervisor.envStatus/dshenvStatus/面板环境卡；壳负责 Node 前置安装，catalog 负责陈述+判定。

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** 探测某二进制版本；不可执行返回 null。 */
function whichVersion(bin) {
  try { const v = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim(); return v || null; }
  catch { return null; }
}

// 版本探测结果缓存（TTL 10s）：envStatus 的 probe + summary 会在单次 API 调用内重复探测 3+ 次，
// 每次都是同步 execFileSync（node/npm/git）——磁盘/进程占用且阻塞事件循环（2026-09 审计修复）。
const _verCache = new Map();
const CACHE_TTL = 10000;
function cachedWhichVersion(bin) {
  const hit = _verCache.get(bin);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL) return hit.v;
  const v = whichVersion(bin);
  _verCache.set(bin, { at: now, v });
  if (_verCache.size > 16) { // 有界：清最旧
    let oldest = null;
    for (const [k, e] of _verCache) if (!oldest || e.at < oldest.at) oldest = { k, at: e.at };
    if (oldest) _verCache.delete(oldest.k);
  }
  return v;
}

/** 系统环境条目（必要前置：Node/npm 为 DSH 与反代更新的执行器；git 可选）。 */
const SYSTEM_ENTRIES = {
  node: { label: 'Node.js', required: true, probe: () => cachedWhichVersion('node') },
  npm:  { label: 'npm',     required: true, probe: () => cachedWhichVersion('npm') },
  git:  { label: 'git',     required: false, probe: () => cachedWhichVersion('git') },
};

class EnvCatalog {
  constructor(config) { this.config = config || {}; }

  /** 系统二进制条目探测：{id:{label,required,state,detail}}；state=ok|missing。 */
  probe() {
    const out = {};
    for (const [id, e] of Object.entries(SYSTEM_ENTRIES)) {
      const v = e.probe() || null;
      out[id] = { label: e.label, required: e.required, state: v ? 'ok' : 'missing', detail: v };
    }
    return out;
  }

  /** 守卫自更新条目（由 config 编排：selfUpdateManifestUrl/selfUpdateDir）。 */
  selfUpdateEntry() {
    if (!this.config.selfUpdateManifestUrl) return { label: '守卫自更新', required: false, state: 'unconfigured', detail: '未配置 selfUpdateManifestUrl' };
    if (!this.config.selfUpdateDir) return { label: '守卫自更新', required: false, state: 'unconfigured', detail: '未配置 selfUpdateDir（发行版布局）' };
    return { label: '守卫自更新', required: false, state: 'configured', detail: this.config.selfUpdateManifestUrl };
  }

  /** DSH 本体条目（外传判定：bin 可执行 + 已装版本）。 */
  dshEntry(binOk, installed, bin) {
    return {
      label: 'DSH 本体',
      required: true,
      state: binOk ? 'ok' : 'missing',
      detail: binOk ? (installed || '已装') : ('bin 不存在: ' + (bin || '?')),
    };
  }

  /** 汇总：全部必填项状态（供面板/守卫快速判定「环境就绪」）。
   *  @param extra 附加条目（dsh/selfUpdate）
   *  @param sys 可选：已探测的系统条目（避免调用方已 probe 后又重 probe——2026-09 审计修复）
   *  无 sys 时探测一次（探测结果有 10s TTL 缓存）。 */
  summary(extra, sys) {
    const s = sys || this.probe();
    const items = { ...s, ...(extra || {}) };
    const required = Object.values(items).filter((e) => e && e.required);
    return { ready: required.every((e) => e.state === 'ok' || e.state === 'configured'), items };
  }
}

module.exports = { EnvCatalog };