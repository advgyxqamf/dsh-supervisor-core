import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ============================================================================
 * DSH 通用 UI 框架 — useAsync
 * ============================================================================
 * 通用异步状态管理：loading / error / data，带竞态保护。
 *
 * 用法：
 *   const { data, loading, error, run } = useAsync(fetchFn, [deps]);
 * ============================================================================
 */

type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
};

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList = [],
  options?: { immediate?: boolean },
) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: false,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const run = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (!disposedRef.current) {
        setState({ data, error: null, loading: false });
      }
      return data;
    } catch (err) {
      if (!disposedRef.current) {
        setState({ data: null, error: String(err), loading: false });
      }
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (options?.immediate) {
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { ...state, run } as const;
}

