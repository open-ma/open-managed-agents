import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "./api";

/**
 * Cursor-paginated list hook with proper Prev/Next/Page-N pagination.
 *
 * The `/v1/<resource>` endpoints expose only forward cursors via
 * `{data: T[], next_cursor?: string}` — no "previous cursor" exists. To
 * support a Prev button we cache every cursor we've ever used in a stack:
 * the cursor at index N is the cursor that fetches page N. Index 0 is
 * always `undefined` (the initial fetch with no cursor).
 *
 * Usage:
 *
 *     const {
 *       items, isLoading, pageIndex, hasNext, hasPrev,
 *       nextPage, prevPage, refresh,
 *     } = usePagedList<Session>("/v1/sessions", { limit: 20 });
 *
 *     // ... render items ...
 *     <Pagination
 *       pageIndex={pageIndex} hasNext={hasNext} hasPrev={hasPrev}
 *       onNext={nextPage} onPrev={prevPage} loading={isLoading}
 *     />
 *
 * `params` is a flat string→string map of extra query params. Changing
 * it resets the cursor stack and bounces back to page 0 — pass a stable
 * object reference (or memoize) to avoid pointless refetches.
 *
 * `enabled: false` defers the initial fetch — useful when an upstream
 * value (`tenantId`, etc.) isn't ready yet.
 */
export interface PagedListOpts {
  limit?: number;
  /** Extra query params (filters etc.). Stable identity recommended. */
  params?: Record<string, string | undefined>;
  /** When false, skip the initial fetch. Defaults to true. */
  enabled?: boolean;
}

export interface PagedListResult<T> {
  items: T[];
  isLoading: boolean;
  /** Zero-based — display as `pageIndex + 1` to humans. */
  pageIndex: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextPage(): void;
  prevPage(): void;
  /** Clear cached cursor stack, drop back to page 0, refetch. */
  refresh(): void;
  error: string | null;
}

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

export function usePagedList<T>(
  endpoint: string,
  opts: PagedListOpts = {},
): PagedListResult<T> {
  const { api } = useApi();
  const [items, setItems] = useState<T[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `refresh()` to force the fetch effect to re-run even when
  // pageIndex is already 0 (most common refresh case).
  const [refreshKey, setRefreshKey] = useState(0);

  const enabled = opts.enabled ?? true;
  // Stable identity for the params object so the effect doesn't loop on
  // inline object literals from callers.
  const paramsKey = JSON.stringify(opts.params ?? {});

  // Cursor stack: index N holds the cursor that fetches page N. Backend
  // is forward-only, so we cache every cursor we've used to make Prev work.
  const cursorStackRef = useRef<Array<string | undefined>>([undefined]);
  // Track last paramsKey across renders so the effect can detect a filter
  // change and blow away the stack before fetching.
  const lastParamsKeyRef = useRef(paramsKey);

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

  // Single fetch effect — runs on mount, page change, refresh, and any
  // upstream change (endpoint/params/limit/enabled).
  useEffect(() => {
    if (!enabled) return;

    // Filter / endpoint / limit change → reset cursor stack and bounce to
    // page 0. The reset happens before the fetch so the URL we build below
    // uses the correct (undefined) cursor. If pageIndex was already 0, we
    // fall through and fetch immediately; otherwise the setPageIndex re-runs
    // this effect with the right index.
    if (lastParamsKeyRef.current !== paramsKey) {
      lastParamsKeyRef.current = paramsKey;
      cursorStackRef.current = [undefined];
      if (pageIndex !== 0) {
        setPageIndex(0);
        return;
      }
    }

    const cursorForPage = cursorStackRef.current[pageIndex];
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    api<PageResponse<T>>(buildUrl(cursorForPage), {
      signal: controller.signal,
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        setItems(res.data);
        setHasNext(!!res.next_cursor);
        // Cache the cursor for the next page so Next + future Prev work.
        // Overwrite is fine — data may have shifted between visits, the
        // freshest cursor is the right one to use.
        if (res.next_cursor) {
          cursorStackRef.current[pageIndex + 1] = res.next_cursor;
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
    // `api` is a fresh function identity each render and including it would
    // loop the effect — same pattern as useCursorList.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, paramsKey, opts.limit, enabled, refreshKey, pageIndex]);

  const nextPage = useCallback(() => {
    setPageIndex((idx) => {
      // Refuse to advance past what we have a cursor for. The button is
      // already disabled in the UI, but spam-clicks during a fast click
      // sequence shouldn't be able to skip pages.
      if (!hasNext) return idx;
      if (idx + 1 >= cursorStackRef.current.length) return idx;
      return idx + 1;
    });
  }, [hasNext]);

  const prevPage = useCallback(() => {
    setPageIndex((idx) => Math.max(0, idx - 1));
  }, []);

  const refresh = useCallback(() => {
    cursorStackRef.current = [undefined];
    setPageIndex(0);
    setRefreshKey((k) => k + 1);
  }, []);

  return {
    items,
    isLoading,
    pageIndex,
    hasNext,
    hasPrev: pageIndex > 0,
    nextPage,
    prevPage,
    refresh,
    error,
  };
}
