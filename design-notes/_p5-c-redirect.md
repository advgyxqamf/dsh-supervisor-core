# P5-C：重定向硬化第二轮（风险定性优先）

> P5-C 负责人产出。只读核验 + 一处最小改动；未跑任何测试/门禁，未 `require` 产品模块，无 git 写，未改 `test/`。
> 全部路径为仓库相对路径。

## 0. 分配表（必有下级）

| 执行者 | 文件 | 结论 |
|---|---|---|
| P5-C-1（下级） | `src/domains/relay/frp-install.js` | **加一处重定向协议守卫**（改动 3 行） |
| P5-C（本人） | `src/domains/plugin/market-net.js` | **不改**，风险定性 + 登记 |

两文件互斥，无重叠。

## 1. 任务要求的核心：先做风险定性

任务明确要求**不要机械照搬** `redirect:'manual'`，先回答两个问题：**目标 host 是否请求可控？是否存在 api 层 host 策可绕？**

### 1.1 market-net.js —— 目标 host 不可请求可控

URL 的全部来源（逐个取证）：

| 调用点 | URL 构成 | host 由谁决定 | 是否请求可控 |
|---|---|---|---|
| `market-sources.js:15` `rawGet` | `'https://raw.githubusercontent.com/' + pathPart` | **硬编码** | 否（仅 path 可变） |
| `market-sources.js:11` 镜像回退 | `gh-proxy.com` / `ghproxy.net` 前缀 | **硬编码常量** | 否 |
| `market.js:232` `indexGithub` | `GH_API`（`market.js:17` = `https://api.github.com`） | **硬编码常量** | 否 |
| `market.js:187` `indexNpm` | `await this._npmOrigin()` + 固定路径 | `dist.selectRegistry(false)` | **配置面**，非请求面 |
| `market.js:222` `safeFetchLatest` | 同上 | 同上 | 同上 |

`_npmOrigin()`（`market.js:214-218`）= `dist.selectRegistry(false)` 或默认常量 `REGISTRY = 'https://registry.npmjs.org'`（`market.js:16`）。
`selectRegistry`（`platform/distribution/registry.js:129+`）读 `state.registryConfig`：`mode==='manual'` 时用 `rc.manualOrigin`。

**关键证据：写入口是操作者信任域，不是请求体直传。** `POST /dist/registry/set`（`api/domains/dist.js:73-77`）
先过 `originAllowed(req, sup.config.apiPort)`，且 P4 已把非回环无密钥请求 **fail-closed 401**（`transport/server.js`）。
⇒ market-net 的目标 host 来自**内核/操作者配置**，**没有任何端点把请求体 URL 直接喂给 market-net**
（这与 #12 的 `/dist/registry/probe` 不同 —— 那个的 host 确实来自请求体，故当时必须收口）。

其次，`name`/`query`/`pathPart` 等可变片段全部经 `encodeURIComponent` 或只影响 **path**（host 固定），
不构成 host 注入面。

**已具备的防线**（无需新增）：重定向**已校验协议**（`:23`/`:60`，`/^https?:\/\//i`）、**跳数上限 5**（`:21`/`:57`）、
响应体上限（5MB/2MB）。且该协议守卫被 `test/round8-fixes-test.js` J-g **按源码钉住**（`guards >= 2`，读的是 market-net）——
**改它反而有破 J-g 的风险**。

**判定：不需要硬化。** 理由：

1. 目标 host 非请求可控（配置面 + 硬编码），与 #12 的威胁模型不同；
2. 在 domain 层为跳转目标复校 host 策略，等于**在域层复制 api 层的 host 策略**，违反分层（DS-G2）——
   任务明确要求避免；
3. **企业内网 npm 镜像源是合法用法**：`/dist/registry/set` 允许配置私网镜像，若在这条路径加「拒私网」会**误杀真实用法**
   （这正是 #12 采用「已配置镜像源白名单放行」的原因）；
4. 已有协议守卫 + 跳数上限 + 体积上限，且守卫被门禁钉住。

**登记残余（精确，不夸大）**：
- **(a) 配置面直连（非跳转问题）**：能过 `originAllowed` 的一方（操作者信任域）可把 `manualOrigin` 指到任意主机，
  market 抓取会**直接**请求它。属配置面信任，与「操作者能改 config」同域；且 #12 的 host 策略**只装在 probe 端点**，
  `/dist/registry/set` 无同款策略 —— 这是**策略覆盖面的有意差异**（配置=意图，探测=临时输入）。
- **(b) 跳转面盲 SSRF**：**已配置**的镜像/上游若 302 到内网，market-net 会跟随（仅校验协议）→ 盲 SSRF
  （守卫发出请求；响应被当 JSON/text 解析，泄漏面限于解析成败的 oracle）。触发前提是「操作者配置的那个源」本身恶意或被攻陷。
- **(c) DNS rebinding**：**不在 #12 覆盖内，本条亦不覆盖** —— 任何基于 host **字符串**的策略都挡不住
  「先解析到公网、后解析到私网」。这反过来说明 host 字符串策略不是这类路径的正确控制点。

### 1.2 frp-install.js —— SSRF 面同样低，但发现一处**同族漏点（真实缺陷）**

URL 来源：`downloadUrls(asset)`（`:32-35`）= `MIRROR_PREFIXES`（`:21-25`，三个**硬编码**前缀，含 GitHub 官方直连）
+ `https://github.com/fatedier/frp/releases/download/v` + `FRP_VERSION`（`:18` 常量）+ `matrix.frpTag(platform, arch)`。
校验表 URL（`:72`）同样硬编码且**直连官方、不经镜像**（信任根设计，见 `:7-8`）。
⇒ **host 全硬编码，与本机平台标签相关，非请求可控、非操作者可配** ⇒ **SSRF 风险面更低**。

**但发现一处真实缺陷（与 SSRF 无关，属健壮性/崩溃面）**：`download()` 内的 `get()`（`:40-58`）在 3xx 时
**直接递归** `get(res.headers.location, redirectsLeft - 1)`（`:45`），**未校验跳转目标协议**。
该递归发生在 **http 响应回调内部**，因此当 `location` 是**非 http(s)**（如 `file://`）或**相对路径**（如 `/x`）时，
`http.get(u)` 会**同步抛**（`ERR_INVALID_PROTOCOL` / `ERR_INVALID_URL`），而该抛出**不在 Promise executor 的同步作用域内**
→ 逃逸为**进程级 uncaughtException**，**守卫进程崩溃**。

**同族证据**：`market-net.js` `:5-6` 的注释**正是**在讲这个故障模式，并在 `:23`/`:60` 做了守卫；
`frp-install.js` 缺同款 —— 即「同类缺陷只在一个站点修了、兄弟站点漏了」，与本仓 FIX 系列反复出现的模式一致。
相对路径 `Location` 在真实网络里并不罕见，故这是**可达的健壮性缺陷**，不是纯理论。

**同时明确否决两种「机械硬化」**：
- **不改为 `redirect:'manual'`/不跟随**：frp 下载**依赖**合法跳转（第三方镜像 → `github.com` → GitHub CDN 对象存储），
  不跟随会让**所有**镜像下载失败。任务明确禁止机械照搬。
- **不加 host 白名单/拒私网**：GitHub 会跳到 CDN 域名，白名单会误杀；且该路径的**真完整性控制是 sha256**（`:134-140`），
  不是 host 策略。

## 2. 改动（P5-C-1 执行，主控已独立复核）

`src/domains/relay/frp-install.js` `download()` 内，3xx 分支加协议守卫（与 market-net 同族措辞）：

```diff
         if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
           res.resume();
-          return get(res.headers.location, redirectsLeft - 1);
+          // 重定向目标必须校验协议：file:// 会让 http.get 同步抛（响应回调内逃逸为 uncaughtException）。
+          const next = String(res.headers.location);
+          if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
+          return get(next, redirectsLeft - 1);
         }
```

**行为变更声明**：
- 合法 `http(s)` 跳转：**行为完全不变**（仍跟随，仍受 5 跳上限约束）→ 镜像→GitHub→CDN 流程不受影响；
- 非 `http(s)` 或**相对**跳转：由「**同步抛 → uncaughtException → 守卫崩溃**」变为「**clean reject(Error)**，
  该 URL 计入 `lastErr`、继续下一个镜像」（`installFrpc` 的既有 `try/catch` 循环），**可用性提升**（一个坏镜像不再打挂守卫）。

**未削弱任何校验语义**：`expectedSha256`、sha256 比对、A/B/C 三条不变量（不匹配必失败且不落盘 / 匹配必成功 /
取不到降级放行 + warn）**一行未动**。

## 3. 独立复核证据（主控亲做，未只采信下级）

| 检查 | 结果 |
|---|---|
| `node --check src/domains/relay/frp-install.js` | 通过 |
| `git diff` 是否只有声明的 3 行 | 是（仅一处 hunk） |
| D 段钉住行是否被碰 | **未碰**：`:72` 校验表 URL 仍为 `const url = 'https://github.com/fatedier/..._checksums.txt'` 且**不含** `MIRROR_PREFIXES`；`:138` `crypto.createHash('sha256')...` 仍在 |
| `downloadUrls`/`MIRROR_PREFIXES` 是否被碰 | 未碰（`frp-platform-test.js` 的行为断言不受影响） |
| A/B/C 是否受影响 | **不受影响**：三者用桩网络层 `mgr._download`（`round13-frpc-integrity-test.js:96`）驱动，**不走** `get()`；且 D 段读源码时**先滤 `//` 行**（`:137`），新增注释对它不可见 |
| 读 `frp-install.js` 的 4 个测试 | `frp-platform-test`（require 行为）、`relay-source-gate`（仅注释提及）、`domain-structure-gate:356`（RANK=2，未变）、`round13-frpc-integrity`（滤注释）→ **均无源码形态钉子被破** |
| R1 反查（新增注释 token） | `重定向目标必须校验协议`→1 命中，核实为 `round8-fixes-test.js:205` **测试自身注释**（描述 market-net 的 P1-3），非对 frp-install 的断言；`响应回调内逃逸为`→0；`会让`/`http.get`/`同步抛` 命中均为其它上下文 → **不构成钉子** |
| J-g 是否受影响 | 不受影响：J-g 读的是 `market-net.js`（`pm`），且本次**未改**该文件 |

## 4. CI 风险

- **低**。唯一代码改动是 3xx 分支的前置校验，不改变合法路径；不触及被 D 段钉住的两行；新增注释被 D 段的滤注释逻辑排除。
- 残余风险：无 CI 正向证据能覆盖「相对 Location 原本会崩溃」这条（无法在 CI 复现崩溃），故本项**正确性靠审阅**，
  与 #2（300s 超时）同类。
- 最终以 CI 四平台裁决。

## 5. 结论一句话

**frp-install.js 需要硬化，但硬化的不是 SSRF 而是「跳转协议未校验导致的进程崩溃」**（同族漏点，3 行）；
**market-net.js 不需要硬化**（host 非请求可控、已有协议守卫+跳数/体积上限、域层复校会违反分层且会误杀合法内网镜像），
残余三项已精确登记（配置面直连 / 跳转面盲 SSRF / DNS rebinding）。
