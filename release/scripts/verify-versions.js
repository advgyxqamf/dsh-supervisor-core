'use strict';
// 版本自洽校验（双轨独立，DESIGN §16.4）：
//   --core   内核：package.json 即单源（无跨组件同号要求）
//   --shell  壳：Cargo.toml[package].version === tauri.conf.json.version（两处互锁）
// 无参 = 全部校验（私有仓两者并存）；供 bump.sh / verify:shell 复用；违反退出 1。
const fs = require('node:fs');
const mode = process.argv[2] || '--all';
const bad = [];
function coreCheck() {
  const pkg = require('../../package.json');
  // 版本规范（2026-09 定稿）：内核 = semver + 两档预览后缀（BETA.n / RC.n）——
  // 0.1.1-BETA.1 / 0.1.1-RC.1 / 0.1.1（无后缀=正式版）
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-(BETA|RC)\.[0-9]+)?$/.test(pkg.version || '')) bad.push('package.json.version 非法: ' + pkg.version);
  if (!bad.length) console.log('内核版本 OK: ' + pkg.version + '（package.json 单源）');
}
function shellCheck() {
  const root = require('node:path').join(__dirname, '..', '..');
  let cargo; let tauri;
  try {
    cargo = fs.readFileSync(require('node:path').join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([0-9.]+)"/m)?.[1];
    tauri = JSON.parse(fs.readFileSync(require('node:path').join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  } catch (e) { bad.push('读取壳版本失败: ' + e.message); return; }
  if (!cargo) bad.push('Cargo.toml 缺 [package] version');
  if (tauri && cargo && tauri !== cargo) bad.push('tauri.conf.json ' + tauri + ' ≠ Cargo.toml ' + cargo);
  if (tauri && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(tauri)) bad.push('壳版本非法: ' + tauri);
  if (!bad.length) console.log('壳版本自洽 OK: ' + tauri + '（Cargo.toml = tauri.conf.json）');
}
if (mode === '--core') coreCheck();
else if (mode === '--shell') shellCheck();
else { coreCheck(); shellCheck(); }
if (bad.length) { console.error('版本校验失败:\n- ' + bad.join('\n- ')); process.exit(1); }