import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "./api";

/**
 * Cursor-paginated list hook. Owns the dance every list page used to do by
 * hand: first-page fetch, append on Load more, reset when filters change.
 * Pairs with the cursor-paginated `/v1/<resource>` endpoints — wire shape
 * `{data: T[], next_cursor?: string}`.
 *
 * Usage:
 *
 *     const { items, isLoading, isLoadingMore, hasMore, loadMore, refresh } =
 *       useCursorList<Agent>("/v1/agents", { limit: 50 });
 *
 *     // ... render items ...
 *     {hasMore && <Button onClick={loadMore} loading={isLoadingMore}>Load more</Button>}
 *
 * `params` is a flat string→string map of extra query params (filters,
 * include_archived, etc.). Changing it resets the cursor and refetches —
 * pass a stable object reference for params that don't change to avoid
 * pointless refetches (or memoize with useMemo).
 *
 * `enabled: false` defers the initial fetch — useful when an upstream value
 * (`tenantId`, `agentId` filter) isn't ready yet.
 */
export interface CursorListOpts {
  limit?: number;
  /** Extra query params (filters etc.). Stable identity recommended. */
  params?: Record<string, string | undefined>;
  /** When false, skip the initial fetch. Defaults to true. */
  enabled?: boolean;
}

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

export function useCursorList<T>(endpoint: string, opts: CursorListOpts = {}) {
  const { api } = useApi();
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = opts.enabled ?? true;
  // Stable identity for the params object so the effect doesn't loop on
  // inline object literals from callers.
  const paramsKey = JSON.stringify(opts.params ?? {});
  // Refs let the loadMore closure read the latest cursor / params without
  // being re-created on every render (each new identity would break a
  // long-press button or trigger phantom effects).
  const cursorRef = useRef<string | undefined>(undefined);
  cursorRef.current = cursor;

  const buildUrl = useCallback(
    (afterCursor?: string): string => {
      const sp = new URLSearchParams();
      if (opts.limit) sp.set("limit", String(opts.limit));
      if (opts.params) {
        for (const [k, v] of Object.entries(opts.params)) {
          if (v !== undefined && v !== "") sp.set(k, v);
        }
      }
      if (afterCursor) sp.set("cursor", afterCursor);
      const qs = sp.toString();
      return qs ? `${endpoint}?${qs}` : endpoint;
    },
    // paramsKey covers `opts.params`; opts.limit is primitive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, opts.limit, paramsKey],
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await api<PageResponse<T>>(buildUrl(undefined));
      setItems(res.data);
      setCursor(res.next_cursor);
      setHasMore(!!res.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [api, buildUrl, enabled]);

  const loadMore = useCallback(async () => {
    const after = cursorRef.current;
    if (!after || isLoadingMore) return;
    setIsLoadingMore(true);
    setError(null);
    try {
      const res = await api<PageResponse<T>>(buildUrl(after));
      setItems((prev) => [...prev, ...res.data]);
      setCursor(res.next_cursor);
      setHasMore(!!res.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingMore(false);
    }
  }, [api, buildUrl, isLoadingMore]);

  // Initial + filter-change fetch. Resets to page 1 whenever endpoint /
  // params / limit / enabled flips.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, paramsKey, opts.limit, enabled]);

  return {
    items,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    loadMore,
    refresh,
    /** Optimistic mutation helper — replaces items in place. Use when
     *  toggling local state (e.g. archive flag flip) without a refetch. */
    setItems,
  };
}
