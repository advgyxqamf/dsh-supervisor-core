'use strict';

// 通用文件系统工具（与业务无关，供各域复用）。

const fs = require('node:fs');
const path = require('node:path');


/** 同步统计目录体积（字节）。有界：最多遍历 200k 条目；符号链接跳过（防循环与双计）。 */
function dirSizeBytes(root) {
  let total = 0;
  let seen = 0;
  const MAX = 200000;
  const walk = (dir) => {
    if (seen > MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      if (seen > MAX) return;
      const full = path.join(dir, en.name);
      if (en.isSymbolicLink()) continue; // 链接不递归（防循环）；其目标体积由真实目录统计
      if (en.isDirectory()) walk(full);
      else if (en.isFile()) {
        try { const st = fs.statSync(full); total += st.size; } catch {}
      }
      seen++;
    }
  };
  try { walk(root); } catch {}
  return total;
}

module.exports = { dirSizeBytes };
