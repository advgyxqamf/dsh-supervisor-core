'use strict';

// 通用端口记录迁移（纯 IO）：把 owner 命中任一前缀的记录从 oldFile 迁出到 newFile，并从旧文件清除。
// 平台只按 owner 前缀字符串工作，前缀由域侧提供（DS-G4）；目标合并去重（按 port）、幂等、原子写。

const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** owner 前缀迁移；@returns {number} 实际迁出的记录数。 */
function migrateByOwnerPrefix(oldFile, newFile, prefixes) {
  const pre = (Array.isArray(prefixes) ? prefixes : [])
    .filter((x) => typeof x === 'string' && x !== '');
  if (!pre.length) return 0;
  const matches = (r) => { const o = String((r && r.owner) || ''); return pre.some((p) => o.startsWith(p)); };
  if (!fs.existsSync(oldFile)) return 0;
  const doc = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  const picks = (doc.records || []).filter(matches);
  if (!picks.length) return 0;
  let target = { records: [] };
  try { if (fs.existsSync(newFile)) target = JSON.parse(fs.readFileSync(newFile, 'utf8')); } catch {}
  const seen = new Set((target.records || []).map((r) => r.port));
  let moved = 0;
  for (const r of picks) { if (!seen.has(r.port)) { target.records.push(r); moved += 1; } }
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  writeAtomic(newFile, target);
  const keep = (doc.records || []).filter((r) => !matches(r));
  writeAtomic(oldFile, { records: keep });
  return moved;
}

module.exports = { migrateByOwnerPrefix };
