'use strict';

const platform = require('../../platform/os/index');

// 域：实例管理 API（沙箱实例 CRUD/启停/open-web/版本更新）。
const crypto = require('node:crypto');
// dsh-auth 换取（§1 派生令牌）——直接引令牌组件的 exchange 子模块。
// 为什么不走 platform/os：换取是**令牌组件**的职责，不是平台差异（platform/os 只做平台分支）。
// 为什么不加进 token/index.js 门面：「§4 冻结 API」只导出 DshTokenService/parseDshTokenLine，
//   新增门面导出会扩大冻结面；子模块路径即最小暴露。
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');

// ── 本机浏览器「一次性授权码」表（open-web 专用）──────────────────────────────
// 为什么需要它：open-web 要把本机系统浏览器带到该实例的 DSH 页面，而 DSH 需要浏览器
//   会话认证。旧做法把 DSH 令牌拼进 URL（?token=…）交给 platform.browser.open —— 该函数
//   把 URL 原样放进 spawn argv，于是**同机任意进程 ps 即可看到会话令牌**（违反 SSOT §6
//   TK-G6，也与 router/providers/proxy.js 的「api-key 绝不进 cmdline」既有标准冲突）。
// 现在令牌**不出本进程**：只把一枚一次性、限时、用后即删的随机码交给浏览器；浏览器凭
//   码回到 /open 路由，由服务端完成「令牌 → dsh-auth cookie」的换取（§1 归属令牌组件）。
//   码本身泄露也几乎无用（30s TTL + 一次性 + 只能换到本机回环会话 cookie）。
// 键=码，值={ id, exp }；仅内存，不落盘（dsh-auth 本就「不落盘」，见 §1 存储列）。
const OPEN_WEB_CODES = new Map();
const OPEN_WEB_CODE_TTL_MS = 30000;

/** 签发一次性授权码：写入内存表并返回码本身。 */
function issueOpenWebCode(id) {
  const code = crypto.randomUUID();
  OPEN_WEB_CODES.set(code, { id, exp: Date.now() + OPEN_WEB_CODE_TTL_MS });
  return code;
}

/** 校验并**一次性消费**授权码：返回 { id }；不存在/已过期返回 null（过期项顺手清理）。 */
function consumeOpenWebCode(code) {
  if (!code) return null;
  const rec = OPEN_WEB_CODES.get(code);
  if (!rec) return null;
  OPEN_WEB_CODES.delete(code); // 一次性：无论后续成败，先删
  if (!(rec.exp > Date.now())) return null;
  return { id: rec.id };
}

/** 清除授权码（换取失败/异常时调用），避免留下可用凭证。 */
function dropOpenWebCode(code) { if (code) OPEN_WEB_CODES.delete(code); }

function owns(pathname) {
  return pathname === '/open' || pathname === '/instances' || pathname.startsWith('/instances/');
}

// ── GET /open?code=<一次性码>：服务端换取 dsh-auth cookie 并回跳 DSH 页面 ──────────
// 流程（令牌全程不出服务端）：
//   ① 校验并消费一次性码（TTL 30s，用后即删）→ 得到实例 id；无 code → 404，带 code 但无效/已过期 → 400（实现不区分二者）。
//   ② tokOf(id) 从唯一令牌节点取该实例令牌（TK-4：按需读，不缓存）。
//   ③ platform.bootstrapDshCookie 向该实例回环 DSH 换取 dsh-auth-* cookie。
//   ④ Set-Cookie: <dsh-auth-*>; Path=/; HttpOnly → 303 到 DSH 端口根路径。
// cookie **不区分端口**，故在 127.0.0.1:<apiPort> 上种下后，浏览器访问
// 127.0.0.1:<dshPort> 也会携带 —— 这正是 relay 种 dsh_lan_token 的同一机制。
function handleOpen(ctx) {
  const { sup, req, res, identity, originAllowed, tokOf } = ctx;
  // ⚠ 2026-09-16 审计修复：**不得从 ctx 取 url** —— 网关构造的 ctx
  //   （api/index.js 的 `const ctx = { sup, req, res, pathname, identity, send, ... }`）
  //   **不含 url 键**，故 `const { url } = ctx` 恒为 undefined → `url.searchParams` 抛
  //   TypeError → 网关兜底成 HTTP 500。公开用户点「DSH Web」100% 失败且无从诊断。
  //   正确形态与本仓其它域一致：从 req.url 自行解析（见 api/lifecycle.js 的
  //   `new URL(req.url, 'http://localhost')`）。
  const url = new URL(req.url, 'http://localhost');
  // 回跳目标由实例真实端口（it.port）与固定回环主机生成，**绝不**取自请求参数 → 无开放重定向。
  const apiPort = sup.config.apiPort;
  const code = url.searchParams.get('code');
  const deny = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  // 授权码是回环本机凭证：只允许本机来源，且写语义请求须经既有 CSRF 深化闸。
  if (!identity.loopback) return deny(403, '仅允许本机访问');
  if (!originAllowed(req, apiPort)) return deny(403, 'origin not allowed');
  const rec = consumeOpenWebCode(code);
  if (!rec) return deny(code ? 400 : 404, code ? '授权码无效或已过期' : '缺少授权码');
  // 实例解析：main 走守卫核心视图，沙箱走实例列表（与 get 的 decorate 同源）。
  const it = (rec.id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function')
    ? sup.dshMainView()
    : ((sup.instances.list() || []).find((x) => x.id === rec.id) || null);
  if (!it) return deny(404, '实例不存在');
  const tok = tokOf(rec.id);
  if (!tok) return deny(400, '实例令牌不可用');
  return bootstrapDshCookie('127.0.0.1', it.port, tok).then((cookie) => {
    if (!cookie) return deny(400, '令牌换取失败');
    res.writeHead(303, {
      'Set-Cookie': cookie + '; Path=/; HttpOnly',
      'Location': 'http://127.0.0.1:' + it.port + '/',
    });
    res.end();
  }).catch((e) => { dropOpenWebCode(code); deny(500, (e && e.message) || 'open failed'); });
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;
  function openInSystemBrowser(url) { return platform.browser.open(url); }

    // 本机浏览器落地页（一次性码换取 dsh-auth cookie）——不属 /instances 前缀，但仍由本域
    // 处理：它消费的正是 open-web 签发的码，与实例解析/tokOf 同源，放在一起避免第二份实现。
    if (req.method === 'GET' && pathname === '/open') return handleOpen(ctx);

    if (req.method === 'GET' && pathname === '/instances') {
      // 附加打开链接：本机直连（带 DSH 认证 token）与局域网 relay（免认证）。
      // token 一律从唯一令牌节点按实例解析（见 tokOf）：原生与沙箱同源。
      // L3b：sup.listLan() 在 lan-daemon 监督模式为异步（ctl 委托），统一 Promise.resolve 兼容。
      // ── 概念清分（2026-09-06）──
      //   instances[] = 沙箱实例（管理对象：CRUD/启停/升级全属沙箱 API）
      //   native      = 原生主干 main（唯一；其生命周期/升级不属 /instances 沙箱 API——
      //                启停 /lifecycle/dsh/*、安装/升级/卸载 /native/*。此处仅提供只读条目供
      //                横切视图（如远程控制）取端口/开关；对象上不带沙箱 CRUD 语义）
      const decorate = (it, lanItems, lanAddrs) => {
        const lan = lanItems.find((x) => x.id === it.id) || null;
        const tok = tokOf(it.id);
        const lanAddr = lanAddrs[0] || '127.0.0.1';
        const out = Object.assign({}, it);
        const loopback = identity.loopback;
        out.authUrl = (tok && loopback)
          ? ('http://127.0.0.1:' + it.port + '/?token=' + encodeURIComponent(tok))
          : ('http://127.0.0.1:' + it.port + '/');
        out.tokenPresent = loopback && !!tok;
        const wan = lan && lan.wanPort;
        out.lanUrl = wan ? ('http://' + lanAddr + ':' + wan + '/') : null;
        out.lanRunning = !!(lan && lan.running);
        return out;
      };
      const render = (ll) => {
        const lanItems = (ll && ll.items) || [];
        const lanAddrs = (ll && ll.addresses) || [];
        // 概念清分：沙箱来自 InstanceManager；原生主干(main)来自守卫核心 dshMainView()（不再混存沙箱数组）
        const sandboxes = (sup.instances.list() || []).filter((i) => i.domain === 'sandbox');
        const main = (sup.dshMainView && typeof sup.dshMainView === 'function') ? sup.dshMainView() : null;
        return send(200, {
          instances: sandboxes.map((it) => decorate(it, lanItems, lanAddrs)),
          native: main ? decorate(main, lanItems, lanAddrs) : null,
        });
      };
      return Promise.resolve(sup.listLan()).then(render).catch(() => render({ items: [], addresses: [] }));
    }
    if (req.method === 'POST' && pathname.startsWith('/instances/')) {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/instances/'.length);
      collectBody(req, res, 65536, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (act === 'add') {
            // P3 配套：addInstance 现为 async（新增端口占用探测）——必须等结果再作答，
            //   否则 send 收到的是 Promise（`r.ok` 恒 undefined → 恒 400，且响应体不可序列化）。
            return Promise.resolve(sup.instances.addInstance(j))
              .then((r) => send(r && r.ok ? 200 : 400, r))
              .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          }
          // ── 沙箱/原生清分护栏：main（原生主干）的生命周期/更新不属沙箱实例 API ──
          // 原生主干唯一操作渠道：启停 /lifecycle/dsh/*、安装/升级/卸载/版本 /native/*。
          // 此处拦截一切落到 main 的管理动作（防双轨：守卫 spawn 语义 vs systemd-run 沙箱语义）。
          if (j.id) {
            const target = sup.instances.find(j.id);
            if (target && target.domain === 'native' && act !== 'open-web') {
              const hint = (act === 'start' || act === 'stop' || act === 'restart')
                ? '原生主实例请经 /lifecycle/dsh/start|stop 启停'
                : '原生主实例请经 /native/* 管理（安装/升级/卸载/版本检测）';
              return send(400, { ok: false, error: hint });
            }
          }
          if (act === 'remove' && j.id) return send(200, sup.instances.removeInstance(j.id));
          if (act === 'update' && j.id) return send(200, sup.instances.updateInstance(j.id, j));
          // ⚠ 2026-09-16 审计修复：start **不得恒 200**。
          //   startInstance 明确有 {ok:false} 分支（平台不支持沙箱 / 沙箱安装失败 / systemd 启动失败），
          //   原先一律 send(200, r) → 面板显示「已启动」而实际无进程（违反本仓
          //   「未验证不得报成功」不变量）。与同文件 stop 一致：如实把 ok 映射为 HTTP 状态。
          if (act === 'start' && j.id) return Promise.resolve(sup.instances.startInstance(j.id))
            .then((r) => send(r && r.ok ? 200 : 400, r))
            .catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'stop' && j.id) return send(200, sup.instances.stopInstance(j.id));
          // 用系统默认浏览器打开该实例的 DSH Web（解决 Tauri/WebView 中 window.open 被拦）。
          // ⚠ TK-G6：URL 内**不得**含 DSH 令牌 —— 该 URL 会原样进入 spawn argv，
          //   同机任意进程经 ps 即可读到会话令牌。改为只带一枚一次性授权码（/open 换取）。
          if (act === 'open-web' && j.id) {
            try {
              // 概念清分：main 走守卫核心视图；沙箱走实例列表
              const it = (j.id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function')
                ? sup.dshMainView()
                : ((sup.instances.list() || []).find((x) => x.id === j.id) || null);
              if (!it) return send(404, { ok: false, error: '实例不存在' });
              // 安全校验：只允许本机回环 + 该实例真实端口（防开放重定向）
              if (!(Number(it.port) > 0)) return send(400, { ok: false, error: '非法端口' });
              const code = issueOpenWebCode(j.id);
              const url = 'http://127.0.0.1:' + sup.config.apiPort + '/open?code=' + code;
              const ok = openInSystemBrowser(url);
              if (!ok) dropOpenWebCode(code);
              return send(ok ? 200 : 500, { ok, url });
            } catch (e) { return send(500, { ok: false, error: e.message }); }
          }
          // 沙箱实例版本更新：检查 / 升级（job 模型，前端轮询 upgrade/status）
          if (act === 'check-update' && j.id) return Promise.resolve(sup.instances.checkUpdate(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade' && j.id) return Promise.resolve(sup.instances.upgradeInstance(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade/status' && j.id) return send(200, sup.instances.upgradeStatus(j.id));
          return send(404, { error: 'not found' });
        } catch (e) { return send(500, { ok: false, error: e.message }); }
      });
      return;
    }
  // 域内未匹配(方法/子路径) → 全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

// handleOpen 一并导出：供测试直接做行为断言（与 api/index.js 导出 originAllowed 同理——
// 仅源码正则不足以证明「令牌不进 URL」，必须能真实驱动 /open 并看 Set-Cookie）。
module.exports = { owns, handle, handleOpen, issueOpenWebCode, consumeOpenWebCode };
