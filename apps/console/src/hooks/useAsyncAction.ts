import { useCallback, useRef, useState } from "react";

/**
 * Wraps an async mutation function with re-entrancy protection: while the
 * previous invocation is still in flight, additional calls become no-ops.
 * Returns a `{ run, loading }` pair to wire into Button:
 *
 *   const create = useAsyncAction(async () => {
 *     await api("/v1/api_keys", { method: "POST", body: ... });
 *   });
 *   <Button onClick={create.run} loading={create.loading} loadingLabel="Creating…">
 *     Create
 *   </Button>
 *
 * Why this exists: every "create / save / delete / submit" button in the
 * Console used to wire its own `[loading, setLoading]` state and either
 * forget the disable-on-submit guard or copy-paste it inconsistently. The
 * Create API Key button forgot it entirely — a single fast double-click
 * produced two duplicate records. Centralizing here means new mutation
 * buttons get the right behavior by default.
 *
 * Notes:
 * - The ref guard fires before React commits state, catching the case
 *   where two click events land in the same microtask before `loading`
 *   re-renders and disables the button.
 * - Errors are re-thrown so callers can attach toast / setError handlers.
 *   The `loading` flag is still cleared in `finally`.
 */
export function useAsyncAction<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): { run: (...args: Args) => Promise<R | undefined>; loading: boolean } {
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(
    async (...args: Args): Promise<R | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setLoading(true);
      try {
        return await fn(...args);
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    },
    [fn],
  );

  return { run, loading };
}
