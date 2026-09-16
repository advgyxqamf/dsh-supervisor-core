'use strict';

// 发布通道选版（RELEASE-CHANNEL-CONTRACT §3）—— **唯一实现**（纯，无 IO）。
//
// 契约 §1 先划边界（这是「改对对象」的前提）：
//   ✅ 我们的包 '@dsh-sup/dsh-core-<os>-<arch>'（及同 scope 的壳发布包）
//      → §3 算法：rollback → canary → latest → versions 最高兜底 → null
//   ❌ 第三方包（DSH 本体、代理/插件包）
//      → 维持「取全量最高」语义不变：他人的 dist-tag 策略不受我们控制，
//        套用 rollback/canary 会把别人的 tag 误当我们的发布纪律。**不是漏改**。
//
// 收敛点：fetchNpmLatest（install.js）只负责「拉元数据 + 调本函数」；选版算法只此一份，
// 禁止在任何调用点再写第二套（本仓禁忌「同一事实两处实现」）。

const { semverCompare } = require('../../shared/version');

/** 「我们的」发布包 scope（契约 §1 A 链路）。同 scope 的 '@dsh-sup/shell-*' 亦由我们发布。 */
const OUR_RELEASE_SCOPE = '@dsh-sup/';

/** 该包名是否属于**我们的**发布通道；只有 true 时才允许 rollback/canary 语义。
 *  @param {string} pkg
 *  @returns {boolean} */
function isOurReleasePackage(pkg) {
  return typeof pkg === 'string' && pkg.startsWith(OUR_RELEASE_SCOPE);
}

/** 在候选版本集合里取**最高合法版本**（semverCompare 判定）；空集返回 null。
 *  @param {Iterable<string>} candidates
 *  @param {(v:string)=>boolean} isValid
 *  @returns {string|null} */
function highestVersion(candidates, isValid) {
  let best = null;
  for (const v of candidates) {
    if (!isValid(v)) continue;
    if (best === null || semverCompare(v, best) > 0) best = v;
  }
  return best;
}

/**
 * 选版算法（契约 §3 冻结）—— **唯一实现**。
 *
 *   ① dist-tags.rollback 合法 → 返回它                     【回退：最高优先级】
 *   ② 灰度名单内 且 dist-tags.canary 合法 → 返回它          【灰度】
 *   ③ dist-tags.latest 合法 → 返回它                        【正式：跟随我们的发布】
 *   ④ 否则 versions 中最高合法版本                           【兼容兜底】
 *   ⑤ 以上皆无 → null（**明确失败**，绝不猜 —— 契约 RC-5）
 *
 * 第三方包（isOurs !== true）→ 取 dist-tags ∪ versions 全量最高（旧语义不变）。
 *
 * @param {object} meta npm registry 元数据：{ 'dist-tags': {...}, versions: {...} }
 * @param {object} opts
 *   - isOurs  {boolean} 是否我们的发布包（用 isOurReleasePackage 判定）
 *   - canary  {boolean} 本机是否在灰度名单（契约 §5）；仅 isOurs 时生效
 *   - isValid {(v:string)=>boolean} 版本合法性判据（install.js 传 VERSION_RE.test）
 * @returns {string|null} 目标版本；无法确定时 null（明确失败）
 */
function pickReleaseVersion(meta, opts) {
  const o = opts || {};
  const isValid = typeof o.isValid === 'function' ? o.isValid : (v) => typeof v === 'string' && v.length > 0;
  const tags = (meta && meta['dist-tags']) || {};
  const versionKeys = (meta && meta.versions && typeof meta.versions === 'object') ? Object.keys(meta.versions) : [];
  // 只有「存在且合法」的 tag 才算数：脏 tag（如 'latest': 'beta'）一律忽略，走下一步。
  const validTag = (v) => (typeof v === 'string' && isValid(v) ? v : null);

  if (o.isOurs === true) {
    // ① 回退最高优先级（RC-2）：独立 tag 是**显式信号**，不靠版本比较推断（契约 §2 设计论证）
    const rollback = validTag(tags.rollback);
    if (rollback) return rollback;
    // ② 灰度：定向生效（RC-4）—— 非名单机器即使 canary tag 存在也不受影响
    if (o.canary === true) {
      const canary = validTag(tags.canary);
      if (canary) return canary;
    }
    // ③ 正式：优先信 latest（RC-1），绝不「取全量最高」（BETA 的数字可能压过 RC）
    const latest = validTag(tags.latest);
    if (latest) return latest;
    // ④ 兼容兜底：latest 缺失/非法时才回落 versions 最高；⑤ 皆无 → null
    return highestVersion(versionKeys, isValid);
  }

  // 第三方包：取 dist-tags ∪ versions 的全量最高。
  // 保留旧语义的**唯一理由**：我们无法控制他人的 dist-tag 策略，套用 rollback/canary
  // 会把别人的 tag 误当我们的发布纪律（见上方 §1）。此处不是漏改，是故意为之。
  return highestVersion(
    [...Object.values(tags).filter((v) => typeof v === 'string'), ...versionKeys],
    isValid
  );
}

module.exports = {
  OUR_RELEASE_SCOPE,
  isOurReleasePackage,
  highestVersion,
  pickReleaseVersion,
};
