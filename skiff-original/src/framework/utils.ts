import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Resolve after the browser has painted the next frame.
 * Used before invoking long-running Tauri commands so the UI can
 * transition to its "busy" state before the main thread blocks.
 */
export function waitForNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Convert milliseconds since epoch to a locale-aware short date-time.
 */
export function formatDateTime(
  value: number,
  locale: "zh-CN" | "en-US",
  emptyLabel: string,
) {
  if (!value) {
    return emptyLabel;
  }

  return new Date(value).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
