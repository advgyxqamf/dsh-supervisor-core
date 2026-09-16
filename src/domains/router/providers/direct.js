'use strict';

// 直连 API 供应商（模式一）：轻量——账号=API Key，上游=官方 OpenAI 兼容端点（多 Key 共享直连）。
// 检测：按 adapter.quota.type 查配额策略注册表（quota-strategies.js）——window-usage（含历史
//  alias opencode-usage）= 官方 /usage 窗口面；无适配器（adapter=null）= 响应驱动（不探测，靠
//  上游 400/429 响应经转发层分类冻结）。模式类不携带供应商解析词。

const { ProviderBase } = require('./base');
const { getQuotaStrategy } = require('./quota-strategies');

class DirectProvider extends ProviderBase {
  constructor(opts) {
    super(opts);
    this.kind = 'direct';
    this.baseUrl = opts.baseUrl || '';
    this.plan = opts.plan || { per5hUsd: null, weeklyUsd: null, monthlyUsd: null };
    this.pricing = opts.pricing || {};
    this.adapter = opts.adapter || null;
    this.presetId = opts.presetId || null;
    this.officialPricing = {};
  }

  /** **能力声明**（PROVIDER-GATEWAY-ARCHITECTURE §5.1）：key-pool 无实例能力。
   *  显式声明"不支持"，使转发层不再靠 typeof 猜测，也让差异可被静态校验。 */
  supports(_cap) { return false; }

  async detectAccount(acc) {
    const quota = (this.adapter && this.adapter.quota) || {};
    const strategy = quota && getQuotaStrategy(quota.type);
    // ⚠ P3-4 修复（PROVIDER-GATEWAY-ARCHITECTURE §5.2「不支持的能力必须显式拒绝，不得静默降级」）：
    //   此前任何非 window-usage 策略（含 official-billing）都**静默返回 quota:null**，
    //   使用者会误以为"该供应商无配额"，而实际是"direct 模式不支持该配额面"。
    //   现如实返回不支持，并注明应改用 process-pool（反代）模式的对应策略。
    if (strategy && strategy.kind === 'official-billing') {
      return { ok: true, quota: null, unsupported: 'official-billing（direct 模式不支持直连官方 billing 面；该配额策略需 process-pool 模式）' };
    }
    if (!strategy || strategy.kind !== 'window-usage') return { ok: true, quota: null };
    const base = (this.baseUrl || '').replace(/\/$/, '');
    const url = base + (quota.usagePath || '/usage');
    // 直连窗口 usage：12s 超时 + Bearer；percent 原样（历史行为：不取整）
    const det = await strategy.detect({ url, key: acc.key, timeout: 12000, roundPercent: false }).catch((e) => ({ ok: false, error: e.message }));
    if (!det.ok) return det;
    return { ok: true, quota: det.quota || null };
  }
}

module.exports = { DirectProvider };
