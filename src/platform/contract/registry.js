'use strict';

// 镜像契约读取器（壳写、内核读）。契约文件：<产品状态根>/supervisor/registry.json。
// 所有权在壳：用户装壳时机器上尚无内核，壳必须先完成镜像选择（目录与探测方法归壳），
// 内核只消费产物，不持有硬编码副本。
// schema 1 仅 mode/origins/manualOrigin；schema 2 增加 catalog/selected/probe。
// probe 随契约投放是为了让两侧选源一致：内核照壳的探测规格执行，否则同一镜像两侧测得的
// 延迟可差数倍，会出现面板显示一个源、实际用另一个。
// 不变量 C2：契约缺失/损坏时返回 { ok:false, reason }，调用方回退最小兜底，绝不启动失败。

const fs = require('node:fs');

const SUPPORTED_SCHEMA = 2;

/** 契约不可用时的理由码（供事件与诊断）。 */
const REASON = {
  NO_FILE: 'contract-missing',
  BAD_JSON: 'contract-bad-json',
  BAD_SHAPE: 'contract-bad-shape',
  SCHEMA_NEWER: 'contract-schema-newer',
  EMPTY_CATALOG: 'contract-empty-catalog',
};

function normOrigin(x) {
  return typeof x === 'string' ? x.trim().replace(/\/+$/, '') : '';
}

/** 合法 http(s) 源列表（过滤脏数据；契约来自文件，必须防御）。 */
function sanitizeOrigins(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const o = normOrigin(x);
    if (/^https?:\/\//.test(o) && !out.includes(o)) out.push(o);
  }
  return out;
}

/** 读取镜像契约；契约不可用时返回 ok:false 与 reason，绝不抛错。 */
function read(file) {
  const empty = {
    ok: false, reason: REASON.NO_FILE, schema: null, writtenBy: null,
    catalog: [], probe: null, selected: null,
    mode: 'auto', manualOrigin: '',
  };
  if (!file) return empty;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return empty; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return Object.assign({}, empty, { reason: REASON.BAD_JSON }); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return Object.assign({}, empty, { reason: REASON.BAD_SHAPE });
  }

  const mode = doc.mode === 'manual' ? 'manual' : 'auto';
  const manualOrigin = normOrigin(doc.manualOrigin);
  const schema = Number.isInteger(doc.schema) ? doc.schema : 1;

  // 契约比本内核新时明确拒绝，不猜格式（不变量 C3）。
  if (schema > SUPPORTED_SCHEMA) {
    return Object.assign({}, empty, { reason: REASON.SCHEMA_NEWER, schema, mode, manualOrigin });
  }

  // v2 优先 catalog；v1 只有 origins，两者都接受以实现平滑升级。
  const catalog = sanitizeOrigins(doc.catalog);
  const origins = sanitizeOrigins(doc.origins);
  const list = catalog.length ? catalog : origins;
  if (!list.length) {
    return Object.assign({}, empty, { reason: REASON.EMPTY_CATALOG, schema, mode, manualOrigin });
  }

  // probe 校验到可用为止，形状不对就当没有（回退 /-/ping）。
  let probe = null;
  if (doc.probe && typeof doc.probe === 'object' && typeof doc.probe.kind === 'string') {
    probe = {
      kind: doc.probe.kind,
      pathTemplate: typeof doc.probe.pathTemplate === 'string' ? doc.probe.pathTemplate : null,
      timeoutMs: Number.isFinite(doc.probe.timeoutMs) && doc.probe.timeoutMs > 0
        ? Math.min(Math.max(doc.probe.timeoutMs, 1000), 20000) : 6000,
    };
  }

  // selected 须为合法 origin，且 checkedAt 为数字（用于 TTL 判定）。
  let selected = null;
  if (doc.selected && typeof doc.selected === 'object') {
    const origin = normOrigin(doc.selected.origin);
    const checkedAt = Number(doc.selected.checkedAt);
    if (origin && /^https?:\/\//.test(origin) && Number.isFinite(checkedAt) && checkedAt > 0) {
      selected = {
        origin,
        latencyMs: Number.isFinite(doc.selected.latencyMs) ? doc.selected.latencyMs : null,
        checkedAt,
      };
    }
  }

  return {
    ok: true, reason: null,
    schema,
    writtenBy: typeof doc.writtenBy === 'string' ? doc.writtenBy : null,
    catalog: list,
    probe,
    selected,
    mode,
    manualOrigin,
  };
}

module.exports = { read, SUPPORTED_SCHEMA };
