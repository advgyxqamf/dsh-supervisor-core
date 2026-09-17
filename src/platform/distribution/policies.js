'use strict';

// 分发域的纯策略（无 IO）：镜像合法性、契约/配置合并、探测规格展开、选源决策。
// 全部为具名纯函数，入参显式，可独立 require 单测。

/** 最小兜底镜像源——仅契约缺失/损坏时使用（完整目录与探测规格归壳，由壳经
 *  `<产品状态根>/supervisor/registry.json` 的 catalog 投放）。内核只保证契约不可用时也能跑
 *  （不变量 C2），故保留 2 条覆盖两种基本情形：能上网（官方）+ 中国网络（npmmirror）。
 *  此处不参与正常选择路径。 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '');
}

/** 是否为合法 http(s) origin（防 SSRF 到任意协议）。 */
function isValidOrigin(origin) {
  return /^https?:\/\//.test(String(origin || ''));
}

/** 生效的候选 registry 列表：配置优先，空则回退兜底。 */
function effectiveOrigins(registryConfig, defaultRegistries) {
  const o = (registryConfig && registryConfig.origins) || [];
  const list = o.filter((x) => typeof x === 'string' && x.trim());
  return list.length ? list : [...defaultRegistries];
}

/** 由契约 / 旧文档 / 兜底重建内核持有的 registryConfig（纯）。
 *  优先级：契约 catalog（壳是所有者）> 旧 origins > 兜底。 */
function rebuildRegistryConfig(doc, contract, defaultRegistries) {
  const fromContract = (contract && contract.ok) ? contract.catalog : [];
  const fromDoc = (Array.isArray(doc.origins) && doc.origins.length) ? doc.origins : [];
  const origins = fromContract.length ? fromContract : (fromDoc.length ? fromDoc : [...defaultRegistries]);
  return {
    mode: (doc.mode === 'manual') ? 'manual' : 'auto',
    origins,
    manualOrigin: (typeof doc.manualOrigin === 'string' && doc.manualOrigin)
      ? doc.manualOrigin : (origins[0] || ''),
  };
}

/** 展开单个镜像的探测目标。契约 probe.kind='package-metadata' 时用与壳完全一致的
 *  真实包元数据 URL，无契约则退化为 `/-/ping` 兜底。实测两种方法延迟差 6.7 倍，
 *  故两侧必须用同一规格，否则会出现「面板显示一个源、实际下载用另一个」。 */
function resolveProbe(origin, spec, platformTag) {
  const base = normalizeOrigin(origin);
  if (spec && spec.kind === 'package-metadata' && spec.pathTemplate) {
    return {
      url: base + '/' + spec.pathTemplate.replace('{platform}', platformTag),
      kind: spec.kind,
      timeoutMs: spec.timeoutMs || 4000,
    };
  }
  return { url: base + '/-/ping', kind: 'ping', timeoutMs: (spec && spec.timeoutMs) || 4000 };
}

/** 可达结果里选**延迟最低**者；无可达返回 null（明确失败，不缓存坏选择）。 */
function pickFastestReachable(results) {
  const reachable = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  return reachable.length ? reachable[0] : null;
}

/** 本机是否在灰度名单内。冻结语义是「读名单包内容 + schema===1 + installId/hostnames 匹配」；
 *  该包尚未发布（预留），故当前只认本地开关 `canary === true`。
 *  注意：不得以「名单包存在」为依据——名单包为全部候选机共用，装了就全员灰度。 */
function isInCanaryList(state) {
  return state.canary === true;
}

module.exports = {
  FALLBACK_REGISTRIES,
  normalizeOrigin,
  isValidOrigin,
  effectiveOrigins,
  rebuildRegistryConfig,
  resolveProbe,
  pickFastestReachable,
  isInCanaryList,
};
