import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — AppShell（应用外壳）
 * ============================================================================
 * 应用最外层容器：负责窗口级外观（圆角/阴影/系统标题栏模式），
 * 以及首次进入时的品牌光效动画。
 *
 * 宿主适配：
 *  - web 模式（浏览器/iframe）：无窗口圆角阴影、无自定义标题栏行，铺满页面
 *  - 桌面 + systemTitlebar（macOS）：使用系统标题栏，无自定义 40px 行
 *  - 桌面 + 自定义标题栏：40px 标题栏行 + 圆角阴影窗口外观
 *
 * 用法：
 *   <AppShell web={isWebRuntime()} systemTitlebar={useSystemTitlebar} mode="classic">
 *     {useCustomTitlebar ? <WindowTitlebar /> : null}
 *     <AppLayout>...</AppLayout>
 *   </AppShell>
 * ============================================================================
 */

export type AppShellProps = {
  children: ReactNode;
  /** 网页模式（非桌面壳）：不显示窗口外观，布局铺满 */
  web?: boolean;
  /** 是否使用系统标题栏（macOS 风格）—— 由宿主环境注入 */
  systemTitlebar?: boolean;
  /** 布局模式：classic（标准侧边栏）/ wide-sidebar（宽侧边栏，如空间分析） */
  mode?: "classic" | "wide-sidebar";
  className?: string;
};

export function AppShell({
  children,
  web = false,
  systemTitlebar = false,
  mode = "classic",
  className,
}: AppShellProps) {
  return (
    <main
      data-mode={mode}
      data-host={web ? "web" : systemTitlebar ? "system-titlebar" : "custom-titlebar"}
      className={cn(
        "fw-shell grid h-full w-full overflow-hidden max-[640px]:h-auto max-[640px]:min-h-dvh max-[640px]:overflow-x-clip max-[640px]:overflow-y-visible",
        // 网页模式：无窗口外观，单行内容铺满（固定视口 + 内容区内滚）
        web
          ? "grid-rows-[minmax(0,1fr)] max-[640px]:grid-rows-[auto]"
          : systemTitlebar
            ? "fw-system-titlebar grid-rows-[minmax(0,1fr)] bg-sidebar max-[640px]:grid-rows-[auto]"
            : "grid-rows-[40px_minmax(0,1fr)] rounded-2xl border border-black/10 bg-sidebar shadow-[0_24px_80px_rgba(15,23,42,0.16)] max-[640px]:grid-rows-[40px_auto] max-[640px]:rounded-none max-[640px]:border-0 max-[640px]:shadow-none",
        className,
      )}
    >
      {children}
    </main>
  );
}