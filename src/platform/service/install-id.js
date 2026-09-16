'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 安装标识（installId）—— **基础组件**
//
// 规范：RELEASE-CHANNEL-CONTRACT.md §5.2 / §5.3。
//
// ## 它是什么、为什么需要
//
//   灰度发布（canary）必须能**定向**指定"哪些机器装灰度版"。定向就需要一个
//   **稳定、唯一、我方生成**的机器标识。
//
//   为什么不用现成的环境事实（主机的 IP / 主机名 / MAC）：
//     · IP     —— 家庭宽带重拨 / DHCP 租约会变；公司或运营商 NAT 出口 IP 是**多用户共享**，
//                  一旦命中「整栋楼都进灰度」，且我方无法归因谁真正命中；
//     · 主机名 —— 用户可改、会重名、容器里随机；
//     · MAC    —— 多网卡/虚拟网卡混乱，且可伪造。
//   故本组件**自己生成** UUID 并持久化：这是唯一可被我们精确控制、且跨会话稳定的标识。
//
// ## 关键设计（与契约逐条对应）
//
//   1) **首次生成、此后只读**（§5.2）：一旦落盘就永不重写 —— UUID 漂移会让
//      "已经在灰度名单里"的机器突然失配，且现象极难排查（名单明明有它）。
//   2) **失败绝不静默新建**（§5.2 铁律）：读失败/写失败时返回 null 并记录原因，
//      **不**"顺手生成一个新的" —— 那正是 UUID 漂移的另一种成因。
//   3) **落盘 0600**：标识本身不是机密，但它是身份，且与其它状态文件同目录，
//      统一按私有文件处理（写后 chmod 收口 —— 本仓有"mode 只对新建生效"的教训）。
//   4) **可显式覆盖**：DSH_CANARY_ID 环境变量优先（测试与特殊部署用）；
//      默认路径必须走持久文件，否则稳定性无从谈起。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { supervisorDir } = require('./state-root');

/** 标识文件名（位于内核状态根下；壳也读**同一个文件**，见契约 §5.2 跨仓一致性）。 */
const FILE_NAME = 'install-id';

/** 环境变量覆盖（显式声明本机身份；测试/特殊部署用）。 */
const ENV_OVERRIDE = 'DSH_CANARY_ID';

/** UUID v4 字面量（用于校验文件内容没被写坏）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 进程内缓存：同一进程内 UUID 恒定，避免每次都读盘。 */
let _cached = null;

/** 标识文件路径（导出以便测试与壳侧对齐口径）。 */
function installIdPath() {
  return path.join(supervisorDir(), FILE_NAME);
}

/**
 * 读取本机安装标识。
 *
 * @returns {{ id: string, source: string } | null}
 *   - `source`：'env' | 'file' | 'created'（诊断用，回答"这个值从哪来"）；
 *   - `null`：**无法确定**（读/写失败）—— 调用方必须按"无标识"处理并如实告知，
 *     绝不当作"没有就随便造一个"。契约 §5.2：失败绝不静默新建。
 */
function readInstallId() {
  if (_cached) return _cached;

  // ① 显式覆盖优先（契约 §5.2：可用环境变量覆盖，默认路径仍是持久文件）。
  const env = process.env[ENV_OVERRIDE];
  if (typeof env === 'string' && env.trim()) {
    _cached = { id: env.trim(), source: 'env' };
    return _cached;
  }

  const fp = installIdPath();

  // ② 既有文件：只读返回（**绝不重写**——重写就是 UUID 漂移）。
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const id = String(raw).split(/\r?\n/)[0].trim();
    if (UUID_RE.test(id)) {
      _cached = { id: id.toLowerCase(), source: 'file' };
      return _cached;
    }
    // 文件存在但内容不是合法 UUID（被手工改坏/写了一半）：**不覆盖**，如实报错。
    //   覆盖会改变身份（漂移）；保持原样让运维看见并处置，才是安全方向。
    console.warn('[install-id] ' + fp + ' 内容不是合法 UUID，拒绝覆盖（请人工处置）：' + JSON.stringify(id.slice(0, 40)));
    return null;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      // 存在但读不了（权限等）：同样是"无法确定"，不新建。
      console.warn('[install-id] 读取失败（不新建，避免标识漂移）：' + e.message);
      return null;
    }
  }

  // ③ 确实不存在 → 首次生成并落盘（原子写 + 0600）。
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, id + '\n', { mode: 0o600 });
    // mode 只对**新建**生效：目标文件若已存在（竞态）须写后收口（P3 教训）。
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch {}
    _cached = { id: id.toLowerCase(), source: 'created' };
    return _cached;
  } catch (e) {
    // 写失败（磁盘满/只读）：**不返回一个内存里的临时 UUID** —— 那会让本次运行
    //   把自己当成"名单里的机器"（若恰好命中），但重启后又变，行为不可复现。
    console.warn('[install-id] 生成/落盘失败（本次无标识）：' + e.message);
    return null;
  }
}

/** 便捷读取：只要标识值（无标识时 null）。 */
function installId() {
  const r = readInstallId();
  return r ? r.id : null;
}

/** 测试用：清空进程内缓存（生产代码不应调用）。 */
function _resetCache() { _cached = null; }

module.exports = { installId, readInstallId, installIdPath, FILE_NAME, ENV_OVERRIDE, UUID_RE, _resetCache };
