'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台矩阵 —— **跨平台知识的唯一合法位置**
//
// ## 铁律（规范见 release/README.md「跨平台架构规范」）
//
//   `process.platform` / `process.arch` **只允许出现在 `src/platform/**`**。
//   业务域（domains/、guard/、api/ 等）必须经本模块或平台层能力取平台事实，
//   **不得**自建 os/arch 映射表、不得直接判断 platform。
//
// ## 为什么（本仓付出过的代价）
//
//   同一事实（os/arch → 标签）曾散落 **5 份**：
//     · src/platform/os/*（正确位置）
//     · domains/relay/frpmgr.js     { linux, darwin, win32 } → { linux, darwin, windows }
//     · domains/dist/index.js       { darwin, win32, linux } → { darwin, win, linux }
//     · guard/supervisor/settings-view.js  { win32, linux, darwin } → { win, linux, darwin }
//     · domains/plugin/plugins.js   process.platform !== 'win32'（进程组语义）
//   5 份副本必然漂移，且业务域持有的平台知识**在非本平台上不会被校验** ——
//   这正是「内部业务开发悄悄破坏跨平台构建」的机制。
//
//   本模块把这 5 份收口为 1 份；并由
//   `test/platform-matrix-single-source-test.js` 与
//   `test/cross-platform-architecture-gate-test.js` 两道门禁守住。
//
// ## 与发布矩阵的关系
//
//   `SUPPORTED` 与 `package.json#npmPublish.packages` **必须逐项一致**
//   （门禁 `platform-matrix-single-source-test` 断言）。
//   前者是"运行时能跑什么"，后者是"发布什么"；两者不是同一事实，
//   但它们的**交集集合**必须相同 —— 否则会出现「能跑但发不出」或「发了但跑不了」。
// ═══════════════════════════════════════════════════════════════════════════

/** 受支持的平台组合（顺序即发布顺序，便于 diff 与人工核对）。
 *  字段：
 *    platform —— process.platform 取值（win32 / darwin / linux）
 *    arch     —— process.arch 取值（x64 / arm64）
 *    osTag    —— npm 包名与产物目录用的 os 段（win / darwin / linux）
 *    npmTag   —— npm 子包尾段（<osTag>-<arch>） */
const SUPPORTED = [
  { platform: 'linux', arch: 'x64', osTag: 'linux', npmTag: 'linux-x64' },
  { platform: 'darwin', arch: 'arm64', osTag: 'darwin', npmTag: 'darwin-arm64' },
  { platform: 'darwin', arch: 'x64', osTag: 'darwin', npmTag: 'darwin-x64' },
  { platform: 'win32', arch: 'x64', osTag: 'win', npmTag: 'win-x64' },
];

/** process.platform → npm/产物 os 段。 */
const OS_TAG = { linux: 'linux', darwin: 'darwin', win32: 'win' };
/** process.platform → FRP 官方发布的 os 段（**第三方命名，无法统一**：frp 用 windows 而非 win）。 */
const FRP_OS = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
/** process.arch → FRP 官方发布的 arch 段（frp 用 amd64 而非 x64）。 */
const FRP_ARCH = { x64: 'amd64', arm64: 'arm64' };

/** process.platform → npm/产物 os 段；不支持返回 null。 @param platform 默认 process.platform */
function osTag(platform) {
  return OS_TAG[platform || process.platform] || null;
}

/** 当前平台/架构事实（业务域取平台事实的**唯一入口**之一）。 */
function current(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return { platform: p, arch: a, osTag: OS_TAG[p] || null, npmTag: npmTag(p, a) };
}

/** <osTag>-<arch>；不支持**抛错**（与 dist._platformTag 的历史语义一致）。
 *
 *  ⚠ 错误文案是既有对外契约（test/arch-validation-test.js 断言其内容），不得改动。 */
function npmTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = OS_TAG[p];
  if (!os || (a !== 'x64' && a !== 'arm64')) {
    throw new Error('不支持的平台组合: ' + p + '/' + a + '（仅 linux/darwin/win32 × x64/arm64）');
  }
  return os + '-' + a;
}

/** 是否为**受支持**（= `SUPPORTED` / 发布矩阵）的平台组合（不发错，供能力判定）。
 *
 *  ⚠ 与 `SUPPORTED` **同集合**：`linux-arm64` / `win32-arm64` 目前**不在发布矩阵**，
 *    故返回 false（此前只判「OS 已知 + arch 合法」，会把这两个组合误报为支持）。 */
function isSupported(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return SUPPORTED.some((x) => x.platform === p && x.arch === a);
}

/** FRP 客户端官方产物标签；不支持返回 null（调用方据此如实上报）。
 *  frp 的命名与 npm 不同（windows/amd64），故此处**必须**保留独立映射 ——
 *  但它是"平台知识"，因此**属于本模块**，不得回到业务域。 */
function frpTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = FRP_OS[p];
  const am = FRP_ARCH[a];
  if (!os || !am) return null;
  return { os, arch: am, tag: os + '_' + am, exe: p === 'win32' };
}

/** 平台是否支持 POSIX 进程组语义（kill(-pid) 整树终止）。
 *  非 POSIX（Windows）只能退化为单进程终止 —— 由业务域经此**能力查询**决定，
 *  而不是自己写 process.platform !== 'win32'。 */
function supportsProcessGroup(platform) {
  return (platform || process.platform) !== 'win32';
}

module.exports = {
  SUPPORTED,
  osTag,
  current,
  npmTag,
  isSupported,
  frpTag,
  supportsProcessGroup,
};
