# dsh-supervisor 控制面板（React UI）— 架构文档

> 单产品：dsh-supervisor 控制面板（本目录 `ui/` 即其前端源码；历史名 `skiff-original` 已废弃——原独立 skiff 清理工具 App 已删除，2026-09-02 起为 dsh-supervisor 面板，2026-09-06 更名迁入 `dsh-supervisor/ui/`）。
> 技术栈：React 19 + TypeScript 7 + Vite 8（Rolldown）+ Tailwind 4 + Radix UI + lucide-react + sonner + next-themes。
> 宿主（一源双出口，2026-09 Phase 3）：① 守卫托管——dsh-supervisor 内核 HTTP API（默认 127.0.0.1:36360，实际以 config.json 的 apiPort 为准）同源托管
> `ui-react` 镜像（GET / → supervisor.html，浏览器/局域网）；② Tauri 桌面壳——壳窗口 `decorations:false + transparent`，
> 内容区以 iframe 导航**守卫托管的面板 URL**（壳 `go_panel` 按 config.json 的 apiPort 动态给出），面板与守卫 API **同源直连**。
> 前端因此只有**一条**通路（`BASE=""` 同源 fetch，见 services/supervisor/client.ts），无 Tauri IPC 分支；
> 窗口形态（2026-09 Phase 3b）：壳窗口无边框，浏览器/守卫托管维持 `web` 形态。

---

## 1. 目录结构（全部源文件）

```
src/
  main-supervisor.tsx         入口（唯一）：ReactDOM → AppProviders → SupervisorApp
  app/providers.tsx           ThemeProvider(next-themes) + Toaster（无 i18n、无宿主注入）
  framework/                  业务无关、可复用（无 Tauri/i18n 依赖）
    theme/                    tokens.css（设计令牌 :root/.dark + @theme inline）· shell.css · fonts.css（Inter/Noto SC）· scrollbar.css
    ui/                       Radix+CVA 基件（Button/Checkbox/Dialog/Input/Label/Progress/Select/Spinner/Switch/Sonner Toaster，barrel index.ts）
    layout/                   AppShell/AppLayout/AppSidebar/Toolbar/ContentArea/StatusBar/ScrollArea
    utils.ts                  cn（clsx+tailwind-merge）
    format.ts                 formatSize（文件大小格式化）
  features/supervisor/        业务页面（只依赖 framework + services/supervisor）
    SupervisorApp.tsx         壳：AppSidebar(7 域) + Toolbar + ContentArea + StatusBar
    nav.ts                    导航配置 + 阶段/任务/事件元数据（阶段 tone、友好文案）
    widgets.tsx               标准展示基件（ToneDot/Pill/Card/CardTitle/Metric/QuotaBox/DomainBadge/MonoEllipsis）
    OverviewPage.tsx          控制面板（状态/版本/升级/事件日志）
    InstancesPage.tsx         实例管理（沙箱实例增删启停/守护/版本检测/升级）
    RouterPage.tsx            智能路由（路由启停/用量/供应商/账号额度/激活）
    TasksPage.tsx             任务中心（统一安装/升级/卸载/更新任务历史）
    PluginsPage.tsx           插件商店（市场浏览/搜索/已装管理/启停/卸载）
    LanPage.tsx               远程控制（LAN 代理 + FRP 公网穿透）
    SettingsPage.tsx          设置（自启/局域网访问/版本环境/镜像源）
  services/supervisor/        数据层（唯一直接 fetch 的模块）
    types.ts                  全量领域类型（对齐 HTTP API 实契约）
    client.ts                 同源 HTTP 客户端（GET/POST 全端点）
    polling.ts                运行态轮询中心（2s 快照：/status /instances /lan-access /lan/frp /router/status /router/providers + /events 增量）
    index.ts                  useSupervisorData hook（useSyncExternalStore）
```

## 2. 数据流

- **服务端**：dsh-supervisor `src/api/index.js`（默认 127.0.0.1:36360，被占自动顺延并持久化 apiPort）——HTML 由 `ui-react`（发布）/ `ui/dist`（开发）解析；API 同源。
- **单通路（同源）**：面板无论浏览器直开还是壳内 iframe，都**同源 fetch**（`BASE=""`）——壳导航的 URL 就是守卫 API 基址，故守卫零 CORS 边界不变。前端**不**检测 Tauri、**不**经 `api_proxy` IPC。
- **前端轮询**：`polling.ts` 每 2s 并行拉运行态 + 增量事件（after=seq），写入不可变快照并广播；
  页面经 `useSupervisorData()` 订阅渲染；写操作经 `supervisorApi.*` → `store.refresh()` 立即同步。
- **UI 文案**：硬编码中文（单一语言产品）。设计令牌定义浅/深主题，暗色经 `next-themes` 跟随系统切换。

## 3. 令牌与规范要点（详见 src/framework/theme/tokens.css）

- 状态语义色：primary / success(+bg) / warning(+bg) / destructive / careful(+bg) / status-ok(-soft/-ring) / status-error(-ring) / status-brand(-ring)。
- 页面禁止硬编码色值/字号；字号只走 text-xs..2xl；状态点 = 呼吸光晕双层；状态徽标 = Pill 语义色。
- 构建：`npm run build` → dist/（supervisor.html + assets/）；多页已移除（单入口）。

---

## 4. 工程治理（2026-09-05 追加）

### 4.1 代码分包（P1）
- 7 个功能页面经 React.lazy 按需分包（SupervisorApp.tsx），配 Suspense（PageFallback）+ PageErrorBoundary（chunk 加载失败/页面异常白屏兜底，提供刷新入口）。
- 构建效果：主 vendor+entry 拆双 chunk，各页面独立 chunk（RouterPage~7.5K/LanPage~11K gzip），首屏不再含全部页面代码。

### 4.2 UI 基件（U1）
- Select（radix-ui 令牌化，barrel 已导出），PluginsPage / RouterPage 的 4 处裸 <select> 已迁移；
- 原生 confirm() 保留（同步确认语义在单 WebView 场景可接受）。

### 4.3 质量门禁
- scripts：typecheck（tsc --noEmit）/ lint（eslint src）/ test（vitest run）/ verify（四者串联）。
- ESLint：flat config + @babel/eslint-parser（preset-typescript + preset-react，字符串引用）。
  **原因（2026-09 定案）**：项目 TypeScript 7.0（preview 标 latest）与 typescript-eslint peer 上限 <6.1 冲突且运行时硬拒 TS7 —— eslint 侧放弃类型规则，纯类型由 tsc strict + noUnusedLocals 承担。
- 单元测试：vitest（node env）+ vi.stubGlobal fetch 注入；覆盖 polling 事件合并去重 / in-flight 守卫、client 错误归一化与超时信号装配。

### 4.4 版本控制
- 前端源码入外层 git 仓（2026-09-05 commit 3f87482 以 `skiff-original/` 纳入；2026-09-06 迁至 `dsh-supervisor/ui/`）；dist/ node_modules/ 不入库。
- `ui-react/` 为构建镜像（统一入口 `release/scripts/build-ui.sh` 从 `ui/` 构建生成；release.sh 与 CI 均经它），gitignore 不入库；`ui/dist`（构建临时产物）亦不入库。

