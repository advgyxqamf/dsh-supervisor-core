import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../utils";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — 页面结构组件
 * ============================================================================
 * Page / ToolStrip / StatGrid / ResultPanel / PanelTitle / InlineMessage
 * 构成一个标准页面内容区的骨架，业务页面只需组合它们。
 * ============================================================================
 */

/** 页面内容容器（透明、无边框，作为页面的根） */
export function Page({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "min-w-0 min-h-0 overflow-visible rounded-md border-0 bg-transparent p-0",
        className,
      )}
      {...props}
    />
  );
}

/** 页面上方的操作条（说明文字 + 主按钮） */
export function ToolStrip({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mb-2.5 flex min-h-[38px] items-center justify-between gap-4 max-[640px]:flex-col max-[640px]:items-stretch",
        "[&_p]:max-w-[680px] [&_p]:text-sm [&_p]:leading-normal [&_p]:text-muted-foreground",
        "[&_button]:h-8 [&_button]:gap-1.5 [&_button]:rounded-md [&_button]:px-3 [&_button]:text-sm",
        className,
      )}
      {...props}
    />
  );
}

/** 指标条容器（放 StatCard / MetricCell） */
export function StatGrid({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mb-2.5 flex min-h-[34px] items-center gap-3.5 rounded-lg border border-black/5 bg-card/75 px-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]",
        "max-[640px]:h-auto max-[640px]:min-h-0 max-[640px]:flex-col max-[640px]:items-start max-[640px]:gap-1.5 max-[640px]:py-2",
        className,
      )}
      {...props}
    />
  );
}

/** 结果面板（白色卡片容器） */
export function ResultPanel({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "overflow-visible rounded-lg border border-black/5 bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        className,
      )}
      {...props}
    />
  );
}

/** 面板标题行（标题 + 副标题 + 右侧动作） */
export function PanelTitle({
  actions,
  children,
  className,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center justify-between gap-4 border-b border-black/5 bg-muted px-5",
        "max-[640px]:flex-col max-[640px]:items-stretch",
        "[&_strong]:text-sm [&_strong]:font-semibold [&_strong]:leading-tight [&_strong]:text-foreground",
        "[&_span]:mt-1 [&_span]:block [&_span]:text-xs [&_span]:leading-tight [&_span]:text-muted-foreground",
        "[&_button]:h-8 [&_button]:gap-1.5 [&_button]:rounded-md [&_button]:px-3 [&_button]:text-sm",
        className,
      )}
    >
      {children}
      {actions}
    </div>
  );
}

/** 行内提示（错误 / 信息） */
export function InlineMessage({
  kind,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { kind: "error" | "info" }) {
  return (
    <div
      className={cn(
        "mb-3.5 rounded-lg px-3 py-2.5 text-sm",
        kind === "error"
          ? "border border-careful-background bg-careful-background text-careful"
          : "border border-success-background bg-success-background text-success dark:border-success-background dark:bg-success-background dark:text-success",
        className,
      )}
      {...props}
    />
  );
}
