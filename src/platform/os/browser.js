'use strict';

// 平台化浏览器打开：三端同一 open(url) 接口（2024 起 Linux 也可走 xdg-open）。
// 仅接受本机回环 URL（调用方已校验）；失败返回 false。

const { spawn } = require('node:child_process');

function open(url) {
  try {
    const p = process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

module.exports = { open };
