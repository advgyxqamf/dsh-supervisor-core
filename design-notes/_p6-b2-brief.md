# P6-B-2 下级作业单：main 工厂化（单文件）

> ⚠ **已作废（superseded）**：`src/app/main/**` 已于 2026-09-17 全部完成原地去 this（141->0），
> 见 `_p6-b2-main-inplace.md`。本文保留仅作历史方案记录，**不要再按此文派工**。

> 由 P6-B-2 生成。**先读**：`design-notes/_workorder-phase6.md` §0/§3、`_workorder-phase4.md` §0/§1、`_p6-b-shards.md`。

## 0. 硬约束（与上游一致，违反即作废）

1. 禁 `require` 产品模块、禁内存冒烟；只 `node --check` / `grep` / `read` / `wc` / 只读 git。
2. **禁一切 git 写**。禁改 `test/**`（属 P6-A）。禁改 `src/app/assembly/**`（属 P6-B 主控）。
3. 报告 `.md` 不得含操作者绝对路径（X-2 扫全树）。CJK 反查必须 `grep -oP '\p{Han}{4,}'`（`-E '[一-龥]{4,}'` 本机静默返回空＝假绿）。
4. R1：改/删注释前把该行切成 ≥4 字 CJK 与 ≥6 字符 ASCII 串，逐 token 在 `test/` grep，命中即保留并登记。

## 1. 目标形态（P6-B-2 已定，照此实施，不要自创）

把**你负责的那一个文件**改成「真工厂 + 兼容外壳」：

```js
// 工厂：唯一实现，零 this.*（显式 deps 注入）
function createX(deps) {
  const d = deps || {};
  return {
    pubNameA(a, b) { /* 原 _implNameA 的函数体，this.X → d.getX()（惰性求值） */ },
  };
}
// 兼容外壳：host 上既有 {methods} 安装保留（这是行为零变更的关键不变量：对外面与 this.X() 语义不变、可唯一回退）
const IMPLS = new WeakMap();
function implOf(host) {
  let i = IMPLS.get(host);
  if (!i) { i = createX(depsOf(host)); IMPLS.set(host, i); }
  return i;
}
function depsOf(host) { return { getState: () => host.state, /* ...仅惰性 getter，构造期不读 host... */ }; }
module.exports = { createX, methods: { _implNameA(...a) { return implOf(this).pubNameA(...a); } } };
```

**要点**：
- 外壳里**只允许出现 `this`（作为整体传给 deps）**，**不得出现 `this.X(`**（棘轮 AT-1 按目录统计 `this.X(`；工厂化的意义正是让该计数下降）。`depsOf(host)` 内部也不得出现 `this`（用形参 `host`）。
- deps **必须是惰性 getter**（`() => host.x`），因为装配期 host 可能尚未就绪。
- 弱引用缓存（`WeakMap`）保证**不 per-call 分配**、也**不改 host 字段**（host 是`{methods}`平铺安装的，工厂化不新增 host 属性）。
- **保留该文件原有的全部 `module.exports` 键**（`methods` 与其它），除非下表明确说可删。**新增** `createX` 导出。
- 函数体逻辑**逐字不变**，只做 `this.X()` → `d.getX()` 的**机械替换**；拆分「同文件兄弟方法」时改为**模块内局部函数调用**（不要经 deps）。`this.X = v` 的**写**要改为 `d.setX(v)`。
- 顶部加一段注释，写明「保留 {methods} 安装」这一不变量与本次改动目的（供后人理解，勿回退）。

## 2. 交付

报告 `design-notes/_p6-b2-<文件名>.md`，含：
1. 改动前后该文件 `this.X(` **计数**（用 `grep -oE 'this\.[A-Za-z_$][A-Za-z0-9_$]*[ \t]*\('` 统计，给出命令与数字）；
2. `createX` 的**导出签名**：返回哪些 pub 键、deps 需要哪些惰性 getter（逐项列出 host 成员名）；
3. `node --check` 结果；
4. R1 反查结果；
5. 行为零变更论证（哪些行是机械替换、哪些是兄弟方法改局部函数）；
6. 若发现该文件被测试按**源码形态**钉住而无法在不触碰测试的前提下转换 → **停止该文件、保留原状、报告原因**（部分完成优于硬推）。

**完成后由运行时通知父代理（P6-B-2）；不要 find 父代理 id。**
