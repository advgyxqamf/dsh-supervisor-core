#!/usr/bin/env node
'use strict';

// glibc 基座门禁回归（跨平台审计 F1 的防线）
//   背景：glibc 前向兼容 —— 在新基座（如 Ubuntu 24.04 / glibc 2.39）构建的产物
//   无法在旧发行版（Ubuntu 22.04 / glibc 2.35、Debian 12 / 2.36）运行。
//   实测：本项目曾有产物要求 GLIBC_2.39，把最主流的两大 LTS 用户全部排除。
//   本测试确保门禁脚本能识别该情况并正确失败/通过。

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'ci', 'check-glibc.sh');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

function run(args) {
  const r = cp.spawnSync('bash', [GATE].concat(args), { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 找一个真实的动态链接二进制作为夹具（优先用本机已有的工具）
function pickBinary() {
  const cands = ['/usr/bin/dsh-supervisor-gui', '/bin/ls', '/usr/bin/ls', '/usr/bin/env'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// 平台守卫：glibc 是 Linux 特有概念；在 macOS/Windows 上本门禁不适用。
// 跨平台审计纪律：测试必须在三端都能安全运行（而非只在 Linux 通过）。
if (process.platform !== 'linux') {
  console.log('SKIP glibc 门禁测试（仅 Linux 适用；当前 ' + process.platform + '）');
  console.log(String.fromCharCode(10) + '结果: 0 passed, 0 failed （已跳过）');
  process.exit(0);
}

console.log('== glibc 门禁 ==');
check('R1 门禁脚本存在且可执行', fs.existsSync(GATE));

const bin = pickBinary();
check('R2 找到测试用二进制', !!bin, bin || 'none');

if (bin) {
  // 该二进制实际要求的最高 glibc
  const dump = cp.execFileSync('bash', ['-c',
    'objdump -T ' + bin + ' 2>/dev/null | grep -oE "GLIBC_[0-9]+[.][0-9]+" | sed "s/^GLIBC_//" | sort -uV | tail -1'
  ], { encoding: 'utf8' }).trim();
  check('R3 能提取到 glibc 符号', /^[0-9]+[.][0-9]+$/.test(dump), dump);

  // 用「恰好等于实际要求」作为上限 -> 必须通过（证明不误报）
  const ok = run([bin, dump]);
  check('R4 上限=实际要求 -> 通过（不误报）', ok.code === 0, 'exit=' + ok.code);

  // 用「比实际要求低一档」作为上限 -> 必须失败（证明能拦住）
  const parts = dump.split('.');
  const lower = parts[0] + '.' + Math.max(0, parseInt(parts[1], 10) - 1);
  const bad = run([bin, lower]);
  check('R5 上限低于实际要求 -> 失败（能拦住）', bad.code === 1, 'exit=' + bad.code);
  check('R6 失败输出含发行版兼容性说明', /发行版|glibc|基座/.test(bad.out), (bad.out.split('\n')[2] || '').slice(0, 60));
}

// 缺失文件 -> 退出码 2（用法/环境错误，区别于门禁失败 1）
const miss = run(['/nonexistent/binary-xyz']);
check('R7 文件不存在 -> 退出码 2', miss.code === 2, 'exit=' + miss.code);

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);