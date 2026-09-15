/**
 * 面板 → 桌面壳 内核更新消息桥（单写入者契约）。
 *
 * 面板由**内核**托管、运行在桌面壳主帧（shell.html）的内容 iframe 内 —— Tauri 的 IPC
 * 初始化脚本仅注入主帧，故面板**不能**直接 invoke。而内核包的安装/升级唯一写入者是桌面壳，
 * 于是面板只能经 postMessage 请求壳主帧代执行 kernel_update_apply。
 *
 * 协议与来源/目标校验在壳侧（docs/DESIGN-SHELL-ARCHITECTURE.md §3.2c）；
 * 两侧各自持协议版本并由门禁锁定（壳 SW-1、内核 SW）。
 */

/** 协议版本：任何语义变更必须递增；须与壳 src/bridge.rs 的常量一致。 */
export const BRIDGE_PROTOCOL_VERSION = 1;

const REQUEST = "dsh:kernel-update-request";
const RESULT = "dsh:kernel-update-result";
const PROGRESS = "dsh:kernel-update-progress";

export type KernelUpdateResult = {
  ok: boolean;
  stage?: string | null;
  version?: string | null;
  restartUncertain?: boolean;
  error?: string | null;
};

/** 是否运行在桌面壳宿主内（无宿主 = 用独立浏览器打开面板，不能更新内核）。 */
export function hasShellHost(): boolean {
  try { return window.parent !== window; } catch { return false; }
}

/** 请求桌面壳更新内核并等待终结结果。 */
export function requestKernelUpdate(timeoutMs = 6 * 60 * 1000): Promise<KernelUpdateResult> {
  return new Promise((resolve) => {
    if (!hasShellHost()) {
      resolve({ ok: false, error: "内核更新由桌面壳执行：请在桌面壳面板中操作。" });
      return;
    }
    const requestId = "kupd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (r: KernelUpdateResult) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION) return;
      if (d.type !== RESULT && d.type !== PROGRESS) return;
      if (d.requestId !== requestId) return;
      if (d.type === PROGRESS) return; // 进度消息不终结请求
      finish({
        ok: d.ok === true,
        stage: (d.stage as string) ?? null,
        version: (d.version as string) ?? null,
        restartUncertain: d.restartUncertain === true,
        error: (d.error as string) ?? null,
      });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "桌面壳无响应（更新请求超时）" }), timeoutMs);
    window.addEventListener("message", onMessage);
    try {
      // 壳主帧的 origin 是 Tauri 自定义协议（tauri://localhost 等），面板无从预知；
      // 故请求用 '*'，而壳侧以 ev.source === 内容 iframe + 回环 origin 校验来源（K2）。
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: REQUEST, requestId }, "*");
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}
