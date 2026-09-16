'use strict';

// ═════════════════════════════════════════════════════════════════════════
// 插件市场 —— 源抓取叶子原语（域：plugin / market-sources）
//
// 无预算状态的叶子：safeFetchLatest / safeRepoPkg / rawGet + RAW_MIRRORS。
//    批次循环（indexNpm/indexGithub/indexCommunity）**保留在 market.js**：
//     market-budget-test M-d 用源码正则锁定「批次循环内 _budgetExhausted() 在 slice 之前」，
//     迁走循环体会静默废掉该门禁（见 design-notes/plugin.md G.2 裁决）。
// ══════════════════════════════════════════════════════════════════════════

const { getJson, getText } = require('./market-net');

/** raw.githubusercontent.com 镜像回退（2026-09 修复：该域名在部分网络不可达 →
 *  github/community 源整源失败致插件数大幅缩水）。先直连 raw，失败/超时走 gh-proxy 镜像。 */
const RAW_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

/** 抓 raw 内容（JSON 或文本），直连失败走镜像。 */
async function rawGet(pathPart, isJson, timeoutMs = 15000) {
  const direct = 'https://raw.githubusercontent.com/' + pathPart;
  const tryOne = (url) => isJson
    ? getJson(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }))
    : getText(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }));
  let r = await tryOne(direct);
  if (r.ok) return r.data;
  for (const mir of RAW_MIRRORS) {
    r = await tryOne(mir + direct);
    if (r.ok) return r.data;
  }
  throw new Error('raw fetch failed for ' + pathPart);
}

/** npm 最新版元数据查询（origin 由调用方经 dist 统一镜像源选择）。 */
async function fetchLatest(origin, name) {
  try {
    const base = String(origin || '').replace(/\/+$/, '');
    return await getJson(base + '/' + encodeURIComponent(name) + '/latest', 8000);
  } catch { return null; }
}

/** 抓取 GitHub 仓库 package.json（raw）验证 dsh.bundle。 */
async function repoPkg(fullName) {
  for (const branch of ['master', 'main']) {
    try { return await rawGet(fullName + '/' + branch + '/package.json', true, 8000); } catch {}
  }
  return null;
}

module.exports = { RAW_MIRRORS, rawGet, fetchLatest, repoPkg };
