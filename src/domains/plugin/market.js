'use strict';

// 插件市场索引服务：实时聚合 npm + GitHub 的 DeepSeek Harness 插件。
// 权威判定：包/仓库声明 dsh.bundle 才视为 DSH 插件；分类基于 keywords + 描述启发；
// 来源标注 npm/github/community；磁盘缓存 + TTL 刷新。
// HTTP 原语在 market-net.js，源叶子在 market-sources.js；批次循环体必须留在本文件
// （test/market-budget-test.js M-d 以源码正则锁定「预算检查在 slice 之前」）。

const path = require('node:path');
const { getJson } = require('./market-net');
const { rawGet, fetchLatest, repoPkg } = require('./market-sources');
const { classify, pickAuthor } = require('./policies/classify');
const marketCache = require('./store/market-cache');
const { npmEntry, githubEntry } = require('./policies/market-entry');

const REGISTRY = 'https://registry.npmjs.org';
const GH_API = 'https://api.github.com';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const INDEX_FILE = 'plugin-market-cache.json';

/** 社区源单条候选处理（单条失败跳过，不影响整体）。 */
async function addCommunityLink(host, { npmName, ghName, label }, out, seenName) {
  try {
    if (npmName) {
      const meta = await host.safeFetchLatest(npmName);
      if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(npmName)) {
        seenName.add(npmName);
        out.push({ name: npmName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: pickAuthor(meta), homepage: meta.homepage || null, repository: meta.repository && meta.repository.url || null, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
      }
    } else if (ghName) {
      const meta = await host.safeRepoPkg(ghName);
      if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(ghName)) {
        seenName.add(ghName);
        out.push({ name: meta.name || ghName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: ghName.split('/')[0], homepage: null, repository: 'https://github.com/' + ghName, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
      }
    }
  } catch { /* 单条失败跳过，不影响整体 */ }
}

class PluginMarket {
  constructor(opts) {
    this.cacheDir = opts.cacheDir || path.dirname(opts.stateFile || '');
    this.stateFile = opts.stateFile;
    this.ttl = opts.ttlMs || DEFAULT_TTL_MS;
    this.logger = opts.logger || console;
    this.dist = opts.dist || null;   // 安装/分发系统：镜像源选择收口处（npm 版本查询走镜像，不再硬编码官方源）
    this.indexFile = path.join(this.cacheDir, INDEX_FILE);
    this._cache = null;
    this._ts = 0;
    this._inFlight = null;
    // 整体构建预算（默认 4 分钟）：社区源候选约 2468 个，8 并发分批最坏可达数十分钟，
    // 而 GET /plugins/market 会阻塞到构建完成。到点即停止发起新批次，用已采集部分构建索引。
    this.buildBudgetMs = opts.buildBudgetMs || 240000;
    this._deadline = 0;
    // 记录本次构建被预算截断的源：部分结果不得替换完整缓存（见 _buildIndexInner）。
    this._truncatedSources = new Set();
    this.loadFromDisk();
  }

  loadFromDisk() {
    const r = marketCache.loadIndex(this.indexFile);
    if (!r) return false;
    this._cache = r.cache;
    this._ts = r.ts;
    return true;
  }

  saveToDisk() { marketCache.saveIndex(this.cacheDir, this.indexFile, this._cache, this.logger); }

  /** 读取插件列表（带 TTL 缓存 + 并发去重）。 */
  async getIndex(force = false) {
    // 有缓存（含磁盘加载）直接返回；后台刷新
    if (this._cache && !force) {
      this._refreshIfStale();
      return this._cache;
    }
    if (this._inFlight) return this._inFlight;
    return this._startBuild();
  }

  /** 启动一次构建并登记为并发去重引用，返回**原始** promise。
   *  两条不变量必须同时成立：
   *    (a) 无消费者的后台刷新失败不得成为进程级 unhandledRejection —— 靠给 raw **挂一个
   *        no-op handler「标记已处理」**实现，而不是把 promise 消化掉；
   *    (b) 被消费者取走时仍须如实失败 —— raw 的 reject 语义不变（api/domains/plugins.js 的
   *        GET /plugins/market 分支据此回答 500）。
   *  若改成「消化后存回 _inFlight」，则并发的 force 请求会取到这个已消化的 promise，
   *  失败时 resolve 成 undefined → 200 + 空体，正是本仓最忌讳的「假成功」。 */
  _startBuild() {
    const raw = this.buildIndex();
    raw.catch(() => {}); // 标记已处理：无人 await 时否则就是 unhandledRejection
    this._inFlight = raw;
    raw.then(() => {}, () => {}).then(() => { if (this._inFlight === raw) this._inFlight = null; });
    return raw;
  }

  _refreshIfStale() {
    if (Date.now() - this._ts < this.ttl) return;
    if (this._inFlight) return;
    // 后台刷新无消费者：额外接一个 warn（不静默）；raw 自身的 reject 语义不变（见 _startBuild）。
    this._startBuild().catch((e) => {
      this.logger.warn && this.logger.warn('market: 后台刷新索引失败（沿用旧缓存）: ' + ((e && e.message) || e));
    });
  }

  async buildIndex() {
    const start = Date.now();
    // 构建期间置 deadline（各源可观察），finally 清零。
    this._deadline = Date.now() + this.buildBudgetMs;
    this._truncatedSources = new Set();
    try { return await this._buildIndexInner(start); }
    finally { this._deadline = 0; }
  }

  /** 预算是否已耗尽（供各源的批次循环调用）。 */
  _budgetExhausted() { return this._deadline > 0 && Date.now() >= this._deadline; }

  async _buildIndexInner(start) {
    const plugins = [];
    const seen = new Set();
    const add = (p) => {
      if (!p || seen.has(p.name)) return;
      seen.add(p.name);
      plugins.push(p);
    };

    const npm = await this.indexNpm();
    npm.forEach(add);

    const gh = await this.indexGithub();
    gh.forEach(add);

    const community = await this.indexCommunity();
    community.forEach(add);

    for (const p of plugins) {
      p.category = p.category || classify(p);
      p.stars = p.stars || 0;
    }
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    const prev = this._cache;

    // 保护 A：被预算截断的源仍出现在结果里（只是不完整），不会触发下面的保护 B，
    // 从而会把缓存的完整列表替换成缩水版；故单独与旧缓存按 source 取并集，
    // 不受 50% 比例约束（「截断」与「整源失败」语义不同，不能共用判据）。
    const truncated = this._truncatedSources || new Set();
    if (prev && prev.plugins && prev.plugins.length > 0 && truncated.size > 0) {
      const freshNames = new Set(plugins.map((pp) => pp.name));
      const kept = prev.plugins.filter((pp) => truncated.has(pp.source) && !freshNames.has(pp.name));
      for (const kp of kept) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      if (kept.length) {
        this.logger.warn && this.logger.warn(
          'market: 源 ' + [...truncated].join('/') + ' 因预算截断，已与旧缓存合并（补回 ' + kept.length + ' 条）'
        );
      }
    }

    // 保护 B：本次结果较旧缓存缩水 <50%（某源大面积失败/限流）时，沿用旧缓存中
    // 本次完全缺失的源，绝不因一次坏构建丢掉好缓存。
    if (prev && prev.plugins && prev.plugins.length > 0 && plugins.length < prev.plugins.length * 0.5) {
      const freshSources = new Set(plugins.map((pp) => pp.source));
      const prevByKey = new Map(prev.plugins.map((pp) => [pp.name, pp]));
      const keepPrev = prev.plugins.filter((pp) => !freshSources.has(pp.source)); // 本次整源失败 -> 沿用旧源全部
      for (const kp of keepPrev) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      this.logger.warn && this.logger.warn('market index partial build: ' + plugins.length + ' (prev ' + prev.plugins.length + ') — 失败源已沿用旧缓存');
    }

    // 合并的旧条目未参与排序，重排保持 stars 降序（前端依赖该序）。
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    this._cache = { indexedAt: Date.now(), sources: { npm: npm.length, github: gh.length, community: community.length }, total: plugins.length, plugins };
    this._ts = Date.now();
    this.saveToDisk();
    this.logger.info && this.logger.info('market index built in ' + (Date.now() - start) + 'ms: ' + plugins.length + ' plugins (npm=' + npm.length + ', gh=' + gh.length + ', community=' + community.length + ')');
    return this._cache;
  }

  /** npm 源：搜 deepseek-harness 受限 dsh，逐个检测 dsh.bundle。 */
  async indexNpm() {
    const out = [];
    const queries = ['keywords:deepseek-harness', 'keywords:dsh-bundle', 'keywords:dsh-plugin'];
    const allNames = new Set();
    for (const query of queries) {
      try {
        for (let from = 0; from < 1000; from += 250) {
          const base = await this._npmOrigin();
          const url = base + '/-/v1/search?text=' + encodeURIComponent(query) + '&size=250&from=' + from;
          let d;
          try { d = await getJson(url, 15000); } catch { break; }
          const items = d.objects || [];
          for (const o of items) allNames.add(o.package.name);
          if (items.length < 250) break;
        }
      } catch (e) { this.logger.error && this.logger.error('npm search fail ' + query + ': ' + e.message); }
    }
    const names = [...allNames];
    this.logger.info && this.logger.info('npm candidates: ' + names.length);
    const batch = 8;
    for (let i = 0; i < names.length; i += batch) {
      // 预算耗尽即停止发起新批次（已采集部分照常返回）。
      if (this._budgetExhausted()) { this._truncatedSources.add("npm"); this.logger.warn && this.logger.warn("market: npm 源预算耗尽，已处理 " + i + "/" + names.length + " 个候选"); break; }
      const slice = names.slice(i, i + batch);
      await Promise.all(slice.map(async (name) => {
        const meta = await this.safeFetchLatest(name);
        if (meta && meta.dsh && meta.dsh.bundle) {
          out.push(npmEntry(name, meta));
        }
      }));
    }
    return out;
  }
  /** npm 镜像源 origin（经 dist 统一选择；dist 不可达降级官方源）。 */
  async _npmOrigin() {
    let origin = null;
    if (this.dist) { try { origin = await this.dist.selectRegistry(false); } catch {} }
    return (origin || REGISTRY).replace(/\/+$/, '');
  }

  /** npm 最新版元数据查询：走 dist 统一镜像源（国内可达性/手动固定与全系统一致）。 */
  async safeFetchLatest(name) {
    return fetchLatest(await this._npmOrigin(), name);
  }

  /** GitHub 源：搜 topic:dsh-plugin + deepseek-harness，逐个验证 dsh.bundle。 */
  async indexGithub() {
    const out = [];
    const topics = ['dsh-plugin', 'deepseek-harness'];
    const seen = new Set();
    for (const topic of topics) {
      try {
        const url = GH_API + '/search/repositories?q=topic:' + topic + '&sort=stars&order=desc&per_page=30';
        const d = await getJson(url, 12000);
        for (const r of (d.items || [])) {
          if (seen.has(r.full_name)) continue;
          seen.add(r.full_name);
          const text = (r.full_name + ' ' + (r.description || '')).toLowerCase();
          if (!text.includes('dsh') && !text.includes('deepseek-harness') && !text.includes('deepseek harness')) continue;
          // 略过官方本体仓库（不是可选插件）
          if (r.full_name === 'deepseek-ai/deepseek-harness') continue;
          const meta = await this.safeRepoPkg(r.full_name);
          if (meta && meta.dsh && meta.dsh.bundle) {
            out.push(githubEntry(meta, r));
          }
        }
      } catch (e) { this.logger.error && this.logger.error('github index fail ' + topic + ': ' + e.message); }
    }
    return out;
  }

  /** 抓取 GitHub 仓库 package.json（raw）验证 dsh.bundle。 */
  async safeRepoPkg(fullName) {
    return repoPkg(fullName);
  }

  /** 社区列表：抓 awesome-dsh-plugin README 白名单（官方社区维护的精选）。 */
  async indexCommunity() {
    const out = [];
    try {
      const md = await rawGet('awesome-dsh-plugin/awesome-dsh-plugin/main/README.md', false, 30000);
      // 提取 npm 包名（- 或 [ 开头的 包名）+ GitHub 全名
      const re = /\[([^\]|]+)\]\(https:\/\/(?:www\.)?(?:npmjs\.com\/package\/([\w@\/.-]+)|github\.com\/([\w.-]+\/[\w.-]+))\)/g;
      const links = [];
      let m;
      while ((m = re.exec(md)) !== null) { links.push({ npmName: m[2], ghName: m[3], label: m[1] || '' }); }
      // 候选约 2468，串行逐个查 npm 太慢/易整体超时 -> 8 并发批次，单条失败跳过
      const seenName = new Set();
      for (let i = 0; i < links.length; i += 8) {
        // 预算耗尽即停止（社区源候选最多，最易超时）。
        if (this._budgetExhausted()) { this._truncatedSources.add("community"); this.logger.warn && this.logger.warn("market: community 源预算耗尽，已处理 " + i + "/" + links.length + " 个候选"); break; }
        const slice = links.slice(i, i + 8);
        await Promise.all(slice.map((link) => addCommunityLink(this, link, out, seenName)));
      }
    } catch (e) { this.logger.error && this.logger.error('community index fail: ' + e.message); }
    return out;
  }
}

module.exports = { PluginMarket };
