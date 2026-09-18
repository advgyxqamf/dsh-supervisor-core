'use strict';

const platform = require('../../platform/os/index');
// 执行边界的单一事实源：形态/路径类判定与启动期复校共用 exec-path 的同一纯函数（见 §8.4）。
const execPath = require('../../platform/os/exec-path');

// 域：实例管理 API（沙箱实例 CRUD/启停/open-web/版本更新）。
const crypto = require('node:crypto');
// dsh-auth 换取（§1 派生令牌）直接引令牌组件的 exchange 子模块：
// 换取是令牌组件的职责（不是 platform/os 的平台差异）；不走 token/index.js 门面是因为
// §4 冻结 API 只导出 DshTokenService/parseDshTokenLine，新增门面导出会扩大冻结面。
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');

// 本机浏览器「一次性授权码」表（open-web 专用）。
// 为什么需要它：open-web 要把本机系统浏览器带到实例的 DSH 页面。若把 DSH 令牌拼进 URL
//   交给 platform.browser.open，该 URL 会原样进入 spawn argv，同机任意进程 ps 即可看到
//   会话令牌（违反 SSOT §6 TK-G6，也与 router/providers/proxy.js 的「api-key 绝不进
//   cmdline」冲突）。现在令牌不出本进程：只把一次性、限时、用后即删的随机码交给浏览器，
//   浏览器凭码回 /open，由服务端完成令牌换取 dsh-auth cookie。码泄露也几乎无用
//   （30s TTL + 一次性 + 只能换到本机回环会话 cookie）。键=码，值={ id, exp }；仅内存不落盘。
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

// GET /open?code=<一次性码>：服务端换取 dsh-auth cookie 并回跳 DSH 页面（令牌全程不出服务端）。
//   1) 校验并消费一次性码（TTL 30s，用后即删）得到实例 id；无 code 返回 404，
//      带 code 但无效/已过期返回 400（实现不区分二者）。
//   2) tokOf(id) 从唯一令牌节点取该实例令牌（TK-4：按需读，不缓存）。
//   3) bootstrapDshCookie 向该实例回环 DSH 换取 dsh-auth-* cookie。
//   4) Set-Cookie: <dsh-auth-*>; Path=/; HttpOnly，303 到 DSH 端口根路径。
// cookie 不区分端口：在 127.0.0.1:<apiPort> 种下后，浏览器访问 127.0.0.1:<dshPort>
// 也会携带（与 relay 种 dsh_lan_token 同一机制）。
function handleOpen(ctx) {
  const { sup, req, res, identity, originAllowed, tokOf } = ctx;
  // 不得从 ctx 取 url：网关构造的 ctx 不含 url 键，`const { url } = ctx` 恒为 undefined，
  //   url.searchParams 会抛 TypeError 并被网关兜底成 HTTP 500。
  //   与本仓其它域一致：从 req.url 自行解析（见 lifecycle.js 的 new URL(req.url, ...)）。
  const url = new URL(req.url, 'http://localhost');
  // 回跳目标由实例真实端口（it.port）与固定回环主机生成，绝不取自请求参数，无开放重定向。
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

// command 的 fail-closed 闸 = 结构闸 + 入口白名单（N11 / 审计 A2）：command 会被原样经
//   startTransient 交给 systemd-run，任意二进制或任意脚本因此等同「以守卫身份执行任意命令」。
// 信任边界：/instances/add 已经 originAllowed + （LAN 时）access key 鉴权，属操作者信任边界；
//   但「任意可执行 / 任意脚本」不由本端点承担。路径存在性不作为放行依据。
// 允许的两种形态（UI「启动命令」占位符即形态 A）：
//   A. node 族打头 → [node, <绝对路径的 DSH 入口>, ...其后为参数]
//   B. DSH 入口打头 → [<DSH 入口>, ...其后为参数]
// 形态 A 的三重校验（缺一即 400）：
//   1) command[1] 必须存在且是**绝对路径** —— 相对入口会按沙箱 workingDir（data 目录，
//      沙箱内可写）解析，形成「沙箱写文件 → 守卫重启执行」的二级面；
//   2) 必须是 DSH 入口，三者之一：官方包内入口（<前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js，
//      即内核 exec-path.dshJsIn()/resolveDsh() 的产出形态）、dsh 族 basename、或配置的 dshBin；
//   3) 否则 ["node", "/tmp/evil.js"] 之类等于任意脚本执行。
// 已知残留（如实登记，见 design-notes/_p3-c-api-hardening.md §1.4）：basename 判据仍可被
//   「把脚本命名为 dsh*.js / dsh / dsh-supervisor」绕过；真正的结构解是启动期（inst.id 可得后）
//   用 realpath + 安装根前缀复校，属 domains/instance 范围。
// 400 契约：结构非法、入口不在白名单、或 node 族缺少/非绝对/错配 DSH 入口 → 400 { ok:false, error }；
//   缺失/[] = 走沙箱默认命令（默认命令由域内 effectiveCommand 生成，不经本闸）。
function commandShapeError(command, dshBin) {
  if (command === undefined || command === null) return null;
  if (!Array.isArray(command)) return 'command 必须为参数数组';
  if (!command.length) return null; // 空数组 = 用沙箱默认命令，保持既有行为
  if (command.length > 64) return 'command 参数过多（上限 64）';
  for (const a of command) {
    if (typeof a !== 'string') return 'command 每项必须为字符串';
    if (!a.length) return 'command 不允许空参数';
    if (a.length > 4096) return 'command 单个参数过长（上限 4096）';
    if (/[\0\r\n]/.test(a)) return 'command 含非法字符（NUL/换行）';
  }
  // 白名单：只认 node / dsh 系列（大小写不敏感以兼容 Windows；两种分隔符都切，不依赖宿主平台）。
  const NODE_HEAD = new Set(['node', 'node.exe']);
  // command[0] 的 dsh 族维持现行为（含 Windows 的 dsh.exe / npm 垫片 dsh.cmd/.ps1）。
  const DSH_HEAD = new Set(['dsh', 'dsh.exe', 'dsh.js', 'dsh-supervisor', 'dsh-supervisor.js', 'dsh.cmd', 'dsh.ps1']);
  // command[1] 是 node 的脚本参数（.js 等），故不收 .exe/.cmd 形态。
  const DSH_ENTRY = new Set(['dsh', 'dsh.js', 'dsh-supervisor', 'dsh-supervisor.js']);
  const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  const normPath = (p) => String(p).replace(/\\/g, '/');
  // 绝对路径：POSIX /…、Windows 盘符 X:\…、UNC \\…（形态 A 的硬要求，见头注 1）。
  const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
  // 官方 DSH 包内入口：<任意前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js —— 内核自己的
  //   exec-path.dshJsIn()/resolveDsh() 产出的就是它，若不放行则「内核规范入口被自己拒绝」。
  // 官方 DSH 包内入口。**复用 exec-path.dshJsIn 作单一事实源**（原先在此硬编码
  //   '/node_modules/@deepseek-ai/dsh/' 子串，与内核解析器各写一份、有漂移风险）：
  //   先按规范尾巴取出前缀，再用 dshJsIn 重新拼出入口，归一后须与原文逐字一致。
  //   较原实现略严：'.../@deepseek-ai/dsh/其它/bin.js' 这类非规范尾形不再放行。
  const PKG_TAIL = '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const isDshPackageEntry = (p) => {
    if (baseOf(p) !== 'bin.js') return false;
    const n = normPath(p);
    if (n.length <= PKG_TAIL.length || n.slice(-PKG_TAIL.length) !== PKG_TAIL) return false;
    const prefix = n.slice(0, -PKG_TAIL.length);
    try { return normPath(execPath.dshJsIn(prefix)) === n; } catch { return false; }
  };
  // 配置的 DSH 可执行名（严格相等）；但不接受把 node 自己当 DSH 入口，否则 [node, node] 会通过。
  const isConfiguredDshBin = (p) => typeof dshBin === 'string' && dshBin !== '' && p === dshBin
    && !NODE_HEAD.has(baseOf(dshBin));
  const FORMS = '可用 [node, <绝对路径的 DSH 入口>, ...参数] 或 [<DSH 入口>, ...参数]';
  // 决策复用执行边界的同一纯函数（**单一事实源**，与启动期 realpath 复校同规）：
  //   requireAbsoluteEntry=true  —— 形态 A（node 打头）必须绝对路径（P4 语义，不变）；
  //   allowEntry                 —— 保留 P4 的 basename/包形态/dshBin 白名单（**不削弱**）；
  //   files=knownDshEntries()    —— 追加「内核自己解析出的已知 DSH 入口」（SSOT 复用，
  //                                 替代原先在 api 层硬编码包路径形态的做法）。
  const sharedErr = execPath.commandEntryViolation(command, {
    requireAbsoluteEntry: true,
    files: execPath.knownDshEntries({ dshBin }),
    allowEntry: (entry) => isDshPackageEntry(entry) || DSH_ENTRY.has(baseOf(entry)) || isConfiguredDshBin(entry),
  });
  if (!sharedErr) return null;
  if (NODE_HEAD.has(baseOf(command[0]))) {
    const entry = command.length > 1 ? command[1] : '';
    if (!entry || !isAbsolute(entry)) {
      return 'command[0] 为 node 时，command[1] 必须是**绝对路径**的 DSH 入口（相对路径按沙箱 data 目录解析，已禁止）；' + FORMS;
    }
    return 'command[0] 为 node 时 command[1] 必须是 DSH 入口（dsh / dsh.js / dsh-supervisor / dsh-supervisor.js，'
      + '或 <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js）；' + FORMS;
  }
  // 形态 B：入口自身即 DSH。相对路径（含分隔符）会被按沙箱可写工作目录解析 ⇒ 由共享判据拒绝（较 P4 收紧）。
  return sharedErr + '；' + FORMS + '；需要其它可执行请走插件安装通道';
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf } = ctx;
  function openInSystemBrowser(url) { return platform.browser.open(url); }

    // 本机浏览器落地页（一次性码换取 dsh-auth cookie）：不属 /instances 前缀，但消费的正是
    // open-web 签发的码，与实例解析/tokOf 同源，放在本域避免第二份实现。
    if (req.method === 'GET' && pathname === '/open') return handleOpen(ctx);

    if (req.method === 'GET' && pathname === '/instances') {
      // 附加打开链接：本机直连（带 DSH 认证 token）与局域网 relay（免认证）。
      // token 一律从唯一令牌节点按实例解析（见 tokOf）：原生与沙箱同源。
      // L3b：sup.listLan() 在 lan-daemon 监督模式为异步（ctl 委托），统一 Promise.resolve 兼容。
      // 概念清分：
      //   instances[] = 沙箱实例（管理对象：CRUD/启停/升级全属沙箱 API）
      //   native      = 原生主干 main（唯一；其生命周期/升级不属 /instances 沙箱 API：
      //                 启停 /lifecycle/dsh/*、安装/升级/卸载 /native/*。此处仅提供只读条目
      //                 供横切视图取端口/开关，不带沙箱 CRUD 语义）
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
            const cmdErr = commandShapeError(j.command, sup.instances && sup.instances.dshBin);
            if (cmdErr) return send(400, { ok: false, error: cmdErr });
            // addInstance 为 async（含端口占用探测）：必须等结果再作答，否则 send 收到的是
            // Promise（r.ok 恒 undefined 导致恒 400，且响应体不可序列化）。
            return Promise.resolve(sup.instances.addInstance(j))
              .then((r) => send(r && r.ok ? 200 : 400, r))
              .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          }
          // 沙箱/原生清分护栏：main（原生主干）的生命周期/更新不属沙箱实例 API。
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
          // remove/update/stop 与 start 同规：{ok:false} 必须如实映射为非 2xx，
          //   恒 200 会让面板显示「已删除/已更新/已停止」而实际未生效（未验证不得报成功）。
          if (act === 'remove' && j.id) { const r = sup.instances.removeInstance(j.id); return send(r && r.ok ? 200 : 400, r); }
          if (act === 'update' && j.id) { const r = sup.instances.updateInstance(j.id, j); return send(r && r.ok ? 200 : 400, r); }
          // start 不得恒 200：startInstance 有 {ok:false} 分支（平台不支持沙箱 / 沙箱安装失败 /
          //   systemd 启动失败），一律 send(200, r) 会让面板显示「已启动」而实际无进程
          //（违反本仓「未验证不得报成功」不变量），start 应如实映射 HTTP 状态。
          if (act === 'start' && j.id) return Promise.resolve(sup.instances.startInstance(j.id))
            .then((r) => send(r && r.ok ? 200 : 400, r))
            .catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'stop' && j.id) { const r = sup.instances.stopInstance(j.id); return send(r && r.ok ? 200 : 400, r); }
          // 用系统默认浏览器打开该实例的 DSH Web（解决 Tauri/WebView 中 window.open 被拦）。
          // TK-G6：URL 内不得含 DSH 令牌（会原样进入 spawn argv，同机进程经 ps 可读），
          //   只带一枚一次性授权码（/open 换取）。
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
  // 域内未匹配(方法/子路径)：全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

// handleOpen 一并导出：供测试直接做行为断言（与 api/index.js 导出 originAllowed 同理——
// 仅源码正则不足以证明「令牌不进 URL」，必须能真实驱动 /open 并看 Set-Cookie）。
module.exports = { owns, handle, handleOpen, issueOpenWebCode, consumeOpenWebCode };
