'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 语义化版本（纯函数，零依赖）—— 目录结构设计 DIRECTORY-STRUCTURE-DESIGN §4.3
//
// 归属裁决：semverCompare / VERSION_RE 是**纯算法**，被 7 个消费者跨 3 层使用
//   （domains/{instance,plugin,router,shell} + app/native + app/settings）。
//   原先它住在 domains/dist/index.js —— 那是「发布/镜像」业务域（步骤3 已解体），
//   于是 9 个文件（含 guard 两层）反向依赖 dist 域，制造了 7 条跨域 + 2 条越层依赖。
//   现上移到 shared/：出度恒为 0 的纯函数层。
//
// ⚠ 与 platform/service/version.js 的区别（勿混）：
//   · 本文件 = semver **比较算法**（纯函数）；
//   · platform/service/version.js = 守卫**版本自报**（读 package.json / __DSH_VERSION__）。
//   实测两者无关，必须分开（设计 §4.3）。
// ═══════════════════════════════════════════════════════════════════════════

// 合法 semver（含 prerelease/build），杜绝脏版本号进比较/安装链路。
// 收紧：core 段禁止前导零（1.02.3 非法）、pre/build 标识符禁止连续/首尾点（rc..1 非法）
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 简化 semver 比较：返回 >0 / 0 / <0。支持 1.2.3 与 1.2.3-rc.1 形态（prerelease < release）。
 *  build metadata（+xxx）按规范忽略：1.0.0-rc.1+build5 与 1.0.0-rc.1 相等。 */
function semverCompare(a, b) {
  const parse = (v) => {
    const clean = String(v).split('+')[0]; // 剥离 build metadata（不参与比较）
    // ⚠ P1-2 修复（2026-09-12）：按**第一个**连字符切分 core/prerelease。
    //   缺陷：原为 `clean.split('-')` —— 那会**切出多段**，而解构 `[core, pre]`
    //     只取前两段，故 `1.0.0-beta-2` 得到 core='1.0.0'、pre='beta' —— `-2` 被丢弃。
    //   而 VERSION_RE 明确允许标识符内含连字符 —— 正则与比较器认知矛盾。
    //   修法：只在**第一个**连字符处切分（pre 保留其余全部内容）。
    const dash = clean.indexOf('-');
    const core = dash === -1 ? clean : clean.slice(0, dash);
    const pre = dash === -1 ? '' : clean.slice(dash + 1);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((A.nums[i] || 0) !== (B.nums[i] || 0)) return (A.nums[i] || 0) - (B.nums[i] || 0);
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1; // release > prerelease
  if (B.pre === '') return -1;
  const ap = A.pre.split('.');
  const bp = B.pre.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (parseInt(x, 10) !== parseInt(y, 10)) return parseInt(x, 10) - parseInt(y, 10);
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { semverCompare, VERSION_RE };
