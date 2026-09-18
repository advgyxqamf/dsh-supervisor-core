# FIX-1 公网暴露安全闸与 LAN CSRF / 局域网访问密钥

日期：2026-09-17
范围（独占）：`src/app/domain-actions/main.js`、`src/app/settings/lan-panel.js`、`src/api/security.js`
验证：`node --check` 三文件通过；按硬约束未在本机运行任何测试（不改被断言钉住的字符串，故无需同步测试）。

## 缺陷 A（最高危）frp 安全闸按原始入参类型判定，与落盘归一不一致

- 现象：`patchDshMain` 用 `!!p.frpEnabled` 落盘（`frpEnabled=1` / `"true"` 均落盘 `true`），
  但安全闸写作 `if (p.frpEnabled === true)`。两者不一致，导致：
  1. `frpEnabled=1` 落盘为 true 却跳过 `validateFrpExposure`，空 token 落盘；
  2. 已开启后单改 `remoteToken:''` 或 `frpRemotePort`（此时 `p.frpEnabled` 为 `undefined`）同样跳过。
  空 token 落盘后 relay 的 tokenGate 对空 token 恒放行，公网零认证触达特权 API。
- 修法：改为按「写入生效后的状态」判闸：`if (!!meta.frpEnabled)`。
  即在应用完本次 patch 后，只要 frp 仍生效（本次置真、或已开启而本次改令牌/端口），
  一律过 `validateFrpExposure`（令牌 + 端口合法性 + 端口占用），且仍在 `writeMainMeta` 之前。
  生效令牌/端口直接取归一后的 `meta.remoteToken` / `meta.frpRemotePort`，不再回读原始入参。
- 可观测行为变化：
  - `frpEnabled` 传入非布尔真值（1/"true"/"on"）时，开启公网暴露现在会被令牌闸拦下（此前静默放行并落盘 true）；
  - frp 已开启时，任何把 `remoteToken` 改为空、或改 `frpRemotePort` 到非法/被占用端口的写入都会被拒（此前静默通过）；
  - 关闭 frp（`frpEnabled:false`，含同时清空令牌）仍直接放行，不改安全方向。
- 残留（超出本范围）：若磁盘上已存在「frpEnabled 真值 + 空 token」的旧状态，
  本次修复会在下一次 patchDshMain 生效时将其拦下并报错，而非自动清理；需要用户补设令牌。

## 缺陷 B1 LAN CSRF：originAllowed 只比端口，不校验 Origin 主机 == 实际 Host

- 现象：`originAllowed` 的 Origin 闸仅要求 Origin 主机落在回环/RFC1918 且端口等于 apiPort，
  不校验 Origin 主机是否等于请求实际到达的 Host。局域网内任意主机上端口相同的恶意页面
  （如 `http://192.168.1.5:36360`）即可驱动受害面板的写 API；socket 层看到的是合法私网来源，
  身份层与访问密钥层都不拦。
- 修法：新增 `normalizeHostname`（小写 + 去 IPv6 方括号），在 Origin 通过私网判定后追加
  `Origin 主机 === Host 头主机` 的一致性校验；不一致即拒。壳来源（`tauri://localhost`）在此前
  已放行，不受影响；Host 缺失时（如直调测试 / 非浏览器客户端）维持原「私网 Origin + 端口」语义。
- 契约影响：无。生产面板由守卫内核同源托管，Host 与 Origin 主机天然一致；
  现有测试用例（回环/LAN Host+Origin 同源放行、evil.com/公网 IP/异端口拒绝）语义全部保持。

## 缺陷 B2 局域网访问不要求访问密钥

- 现象：`setLanPanel(true)` 直接把 apiHost 置 `0.0.0.0`，不要求已配置 `apiAccessKey`。
  而访问密钥层只对「已配置 key」的非回环请求生效，未配置时局域网内任意设备零认证驱动写 API。
- 修法：`setLanPanel` 开启前显式要求 `this.config.apiAccessKey` 已配置，否则
  返回 `{ ok:false, error:'开启局域网访问前请先设置访问密钥（apiAccessKey）...' }`，不改 apiHost。
  同时把 enabled 归一为布尔（`enabled === true`）后用于落盘与事件。
- 契约变更（已按要求报告）：`POST /settings/lan {enabled:true}` 现在要求先配置 `apiAccessKey`。
  未配置时 guard.js 按既有映射返回 HTTP 500 + `{ok:false,error}`（guard.js 的 `r.ok ? 200 : 500`
  映射不在本范围，未改动）；UI `StartupCard.toggleLan` 已按 `r.ok === false` 回退开关并弹出该错误文案。
- 残留（超出本范围）：
  1. `setAccessKey('')`（清除密钥）不会自动关闭已开启的 LAN，可能留下无密钥的 LAN 暴露；
  2. 直接改 config.json 的 `apiHost=0.0.0.0` 或启动时已有该值，不经 `setLanPanel`，不受本闸约束。

## 不变量与单一事实源

- 公网暴露闸仍唯一收敛在 `domains/relay/core.validateFrpExposure`，app 侧与 relay 侧同规，未复制第二份判定。
- Host/Origin 私网判定仍复用 `identity.isPrivateIpv4`，未新增 RFC1918 实现。
- 既有被测试钉住的字符串（gate 文案、导出名、`validateFrpExposure` 调用形态）均未改动。
