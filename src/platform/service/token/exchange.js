'use strict';

// ── dsh-auth 派生令牌的换取（DshTokenService §1「exchange」策略）──────────────
// SSOT: DSH-TOKEN-CONTRACT.md §1 —— kind=dsh-auth 的**生成侧是 DSH 进程**
//   （GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-<hash>=<v1...>），
//   我方职责 = 「换取 + 缓存 + 轮换重换」。此模块即「换取」这一步的唯一实现。
//
// 为什么放在 platform/service/token/：换取是**令牌组件自身**的职责（它认识 dsh-auth 的形态），
//   而不是某个业务域（relay）的私事。原先该实现内联在 domains/relay/index.js ——
//   于是「什么是 dsh-auth cookie」这一知识散落在消费方，第二个消费方（本机浏览器
//   打开的 /open 换取路由）只能复制一份或把令牌塞进 URL 交给浏览器（TK-G6 违规）。
//   现在 relay 与 api 都从本模块导入：协议知识只有一份。
//
// TK-4 不冲突：本模块**不缓存**任何结果，只做一次「启动令牌 → cookie」的换取；
//   缓存（dshCookie）仍由调用方（relay）掌握，令牌值始终由令牌池按需提供。

const http = require('node:http');

/**
 * 用 DSH 启动令牌向回环 DSH 换取浏览器会话 cookie（dsh-auth-*）。
 * DSH 的令牌交换协议：GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-<hash>=<v1...>。
 *
 * @param {string} targetHost 回环目标主机（127.0.0.1）
 * @param {number} targetPort 回环目标端口（DSH Web 端口）
 * @param {string} dshToken   DSH 启动令牌（由令牌池按需提供）
 * @returns Promise<string|null> 完整的 "name=value" cookie 对；失败/非 dsh-auth 返回 null。
 */
function bootstrapDshCookie(targetHost, targetPort, dshToken) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      resolve(cookie);
    };
    const req = http.get(
      {
        hostname: targetHost,
        port: targetPort,
        path: '/?token=' + encodeURIComponent(dshToken),
        headers: { host: targetHost + ':' + targetPort },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
          const pair = String(raw[0]).split(';')[0]; // 取第一个 Set-Cookie 的 name=value
          // 只接受 dsh-auth-* —— 否则会把**任意** Set-Cookie（DSH 未来新增的其它 cookie、
          //   反代/中间件 cookie）当成会话 cookie 注入，形成「假就绪」：
          //   state.cookieReady=true、日志报「已换取」，而实际 DSH 仍 401。
          // 旧实现（relay 内联版）走 else 分支回传任意 pair，即此缺陷。
          if (pair && /^dsh-auth-/.test(pair)) finish(pair);
          else finish(null);
        } else {
          finish(null);
        }
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    req.on('error', () => finish(null));
  });
}

module.exports = { bootstrapDshCookie };
