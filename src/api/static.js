'use strict';

// api/static —— UI 产物目录解析 + MIME + CSP + 静态托管。
//
// 本文件是安全面（CSP / nosniff / 路径穿越防护 / 禁止缓存），语义不得"顺手优化"；
// 门禁见 test/core-test.js（CSP 头、nosniff、编码穿越 404/403）。

const fs = require('node:fs');
const path = require('node:path');

// 前端静态资源目录解析：打包后 __dirname 不再等于源码目录，故多候选探测覆盖全部发行形态。
//  候选（按优先级，命中 supervisor.html 即用）：
//    0) $DSH_UI_DIR                     — 显式注入（测试/特殊部署）
//    1) <__dirname>/ui-react            — Node launcher 统一形态（core.cjs 同目录 ui-react）
//    2) <exe 同目录>/ui-react            — 单文件分发态（二进制旁放 ui-react）
//    3) <exe>/../ui-react                — npm 子包态（pkg/bin/dsh-supervisor + pkg/ui-react）
//    4) <repo 根>/ui-react               — 源码态发布镜像（release.sh 产物）
//    5) <repo 根>/ui/dist                — 开发态（ui 源码 npm run build 产物）
//  esbuild/launcher 中 __dirname = core.cjs 真实所在目录，1/2/3 覆盖发行态，4/5 覆盖源码态。
function resolveUiDir() {
  const exeDir = (function () {
    try { return path.dirname(process.execPath); } catch { return __dirname; }
  })();
  const candidates = [
    process.env.DSH_UI_DIR || null,
    path.join(__dirname, 'ui-react'),         // launcher 统一形态（core.cjs 旁）
    path.join(exeDir, 'ui-react'),
    path.join(exeDir, '..', 'ui-react'),
    path.join(__dirname, '..', '..', 'ui-react'),
    path.join(__dirname, '..', '..', 'ui', 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'supervisor.html'))) return dir; } catch {}
  }
  return null;
}
const UI_DIR = resolveUiDir();
if (!UI_DIR) {
  console.error('[ui] 未找到新 React UI 产物（期望 supervisor.html；候选：ui-react / ui/dist / $DSH_UI_DIR）。');
  console.error('[ui] 请先执行 release/scripts/build-ui.sh（或开发态在 ui 目录 npm run build）。');
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function serveStatic(res, file, corsOrigin) {
  if (!UI_DIR) {
    // UI 缺失（未构建/部署裁剪）：显式 503，绝不抛 TypeError 触发守卫自杀重启
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run release/scripts/build-ui.sh or set DSH_UI_DIR');
  }
  const full = path.join(UI_DIR, file);
  // 路径穿越防护：relative 必须落在 UI_DIR 内部
  const rel = path.relative(UI_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    if (corsOrigin) { headers['Access-Control-Allow-Origin'] = corsOrigin; }
    // 面板资源一律 no-store：前端改动立即生效，避免浏览器缓存旧版导致渲染异常。
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(500);
      res.end('internal error');
    }
  }
}

module.exports = { MIME, CSP, serveStatic };
