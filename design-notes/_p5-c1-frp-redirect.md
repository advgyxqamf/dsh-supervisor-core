# P5-C1：frp-install.js 重定向协议守卫

## 结论

`src/domains/relay/frp-install.js` 的 `download()` 内 `get()` 已补上与同族
`src/domains/plugin/market-net.js` 同款的「重定向目标协议校验」守卫。只加守卫，
不动跟随语义、不动 sha256 校验流程。

## 改动行（唯一被改文件）

```diff
@@ function download(url, report) @@
         if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
           res.resume();
-          return get(res.headers.location, redirectsLeft - 1);
+          // 重定向目标必须校验协议：file:// 会让 http.get 同步抛（响应回调内逃逸为 uncaughtException）。
+          const next = String(res.headers.location);
+          if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
+          return get(next, redirectsLeft - 1);
         }
```

仅此 3 增 1 删；`git diff` 只显示上述行。未触碰：
`_checksums.txt` 直连官方 URL 行、`crypto.createHash('sha256').update(tgz).digest('hex')`、
`redirect:'manual'` 之类不跟随方案、任何 host 白名单。

## 两条静态论证

### 1. 合法 https 跳转仍被跟随（行为不变）

守卫条件为 `!/^https?:\/\//i.test(next)`：仅当目标**不是**以 `http://`/`https://`
开头时才 `reject`。frp 真实链路中的跳转目标（第三方镜像 → github.com → GitHub CDN
对象存储）其 `headers.location` 都是绝对 `https://…`，正则命中，随即执行
`get(next, redirectsLeft - 1)`——递归调用本身、跳数 `redirectsLeft` 递推、请求头
`User-Agent`、`timeout: 60000`、200 分支的 `resolve(Buffer.concat(chunks))` 全部与改动前
逐字一致。唯一变化是把同一 `res.headers.location` 先取出为 `next` 再传入，取值不变。
故合法跳转行为等价。

### 2. 非 http(s)/相对跳转被 reject 而非崩溃

改动前：`get(res.headers.location, redirectsLeft - 1)` 在 **http 响应回调内部**执行。
回调内先算 `const mod = u.startsWith('https:') ? https : http;`；当 `location` 为
`file://…` 或相对路径（如 `/path`）时 `u.startsWith('https:')` 为假 → 选 `http`，
而 `http.get(u, …)` 对非 http(s)/非法 URL 会**同步抛出**（ERR_INVALID_PROTOCOL /
ERR_INVALID_URL）。该抛出发生在响应回调中、不在 `new Promise(executor)` 的同步作用域内，
因此逃逸为进程级 `uncaughtException`，守卫进程崩溃。

改动后：守卫在**任何 `mod.get` 之前**对原始 `location` 字符串做
`^https?://` 前缀判定。`file://…` 与 `/path` 均不匹配，走
`return reject(new Error(…))`；`reject` 是外层 `new Promise` 闭包里的函数，合法可用，
Promise 正常落定，进程不崩，也根本不发起该次请求。即抛点对这些输入不可达。

## R1 注释纪律反查

新增注释行（已确保不含块注释结束序列）：

`// 重定向目标必须校验协议：file:// 会让 http.get 同步抛（响应回调内逃逸为 uncaughtException）。`

按 `grep -oP '\p{Han}{4,}'`（该机 `grep -E '[一-龥]{4,}'` 实测返回 0，为假绿，故必须用 `-oP`）
切出：

- CJK ≥4：`重定向目标必须校验协议`、`响应回调内逃逸为`
- ASCII ≥6：`file://`、`http.get`、`uncaughtException`

逐 token 在 `test/` 反查命中：

| token | 命中 | 处置 |
| --- | --- | --- |
| 重定向目标必须校验协议 | `test/round8-fixes-test.js:205`（注释行） | 命中该同族既有措辞，保留原措辞 |
| file:// | 同上一行 | 同上 |
| http.get | 同上一行 + 5 处功能用法 | 保留 |
| uncaughtException | 同上一行 + 3 处既有注释 | 保留 |
| 响应回调内逃逸为 | 0 | 新增无冲突 |

结论：命中的措辞正是 `market-net` 修复在 `test/round8-fixes-test.js` 中记录的同一句，
本改动沿用其原措辞（同族一致），已登记；未新造会被测试断言的措辞。

## CI 风险

- `node --check src/domains/relay/frp-install.js` 通过。
- `git diff` 仅上述 3 增 1 删，无越界改动。
- `test/round13-frpc-integrity-test.js` D 段：该测试先 `filter` 掉以 `//` 开头的行再做
  `_checksums.txt` / `createHash` 结构断言；新增行非注释且不影响这两处匹配。
  A/B/C 由桩网络层 `mgr._download` 驱动，不经过 `get()`，行为断言不受影响；
  sha256「不匹配即失败且不落盘 / 匹配成功 / 取不到降级放行 + warn」语义未被改动。
- `test/round8-fixes-test.js` J-g 只统计 `market-net.js` 内
  `/重定向到不支持的协议/g` 出现次数（2）；本文件新增第 3 处位于另一个文件，不改变该计数。
- 未改下载跟随行为，合法镜像/CDN 跳转仍可用，功能不回归。
- 残余风险：无预判新增风险。
