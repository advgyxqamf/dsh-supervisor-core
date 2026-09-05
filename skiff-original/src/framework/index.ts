/**
 * ============================================================================
 * dsh-supervisor 控制面板 UI 框架
 * ============================================================================
 * 与业务无关的 React 组件框架：
 *
 *   theme   — 设计令牌（CSS 变量 + Tailwind 语义类 + 暗色主题）
 *   ui      — 基础 UI 组件库（Button/Dialog/Input/Select/...）
 *   layout  — 应用布局框架（AppShell/Sidebar/Toolbar/ContentArea/...）
 *   utils   — 通用工具（cn/format 等）
 *
 * 用法：
 *   import { AppShell, AppLayout, Button } from "@/framework";
 * ============================================================================
 */

// 主题（引入即生效：CSS 变量 + 基础样式）
import "./theme/index";

export * from "./theme";
export * from "./ui";
export * from "./layout";
export * from "./utils";
export * from "./format";
