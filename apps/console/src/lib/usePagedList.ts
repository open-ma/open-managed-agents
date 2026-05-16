import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "./api";

/**
 * Cursor-paginated list hook with proper Prev / Page-N / Next pagination,
 * page-size selection, and URL sync.
 *
 * The `/v1/<resource>` endpoints expose only forward cursors — to support
 * Prev + jumping to known pages, we cache every cursor we've ever used in
 * a stack: `cursorStack[N]` is the cursor that fetches page N. Index 0 is
 * always `undefined` (initial fetch). The cursor stack lives across
 * renders (ref) and is cleared whenever filters / page size change.
 *
 * URL sync uses `?page=N&size=N`. Page is 1-based for human-friendly URLs;
 * the hook converts back to 0-based internally. Size persists across
 * navigation so the user's choice sticks.
 *
 * Usage:
 *
 *     const {
 *       items, isLoading, pageIndex, pageSize, hasNext, hasPrev,
 *       goToPage, setPageSize, refresh, knownPages,
 *     } = usePagedList<Session>("/v1/sessions", { defaultPageSize: 20 });
 *
 *     <Pagination
 *       pageIndex={pageIndex}
 *       pageSize={pageSize}
 *       hasNext={hasNext}
 *       knownPages={knownPages}
 *       onPageChange={goToPage}
 *       onPageSizeChange={setPageSize}
 *     />
 */
export interface PagedListOpts {
  /** Default rows per page when URL doesn't specify. */
  defaultPageSize?: number;
  /** Allowed page sizes for the selector. Defaults to [10, 20, 50, 100]. */
  pageSizeOptions?: number[];
  /** Extra query params (filters etc.). Stable identity recommended. */
  params?: Record<string, string | undefined>;
  /** When false, skip the initial fetch. Defaults to true. */
  enabled?: boolean;
  /** Sync `?page=N&size=N` to the URL. Default true; turn off when you
   *  want the URL untouched (e.g. paginated list inside a modal). */
  syncUrl?: boolean;
  /** Cursor query param name. Defaults to `cursor` (most OMA endpoints).
   *  Override for endpoints that follow a different convention — e.g.
   *  Anthropic Files (`before_id`). */
  cursorParam?: string;
  /** Custom extractor for the next-cursor in the response body. Defaults
   *  to `res.next_cursor`. Override for endpoints that return it under a
   *  different key — e.g. Anthropic Files returns `last_id` only when
   *  `has_more` is true (so you'd return `res.has_more ? res.last_id : undefined`). */
  getNextCursor?: (res: unknown) => string | undefined;
}

export interface PagedListResult<T> {
  items: T[];
  isLoading: boolean;
  /** Zero-based — display as `pageIndex + 1` to humans. */
  pageIndex: number;
  pageSize: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** Number of pages we've actually visited (i.e. have cursors for).
   *  The Pagination component renders these as numbered tiles plus an
   *  ellipsis if `hasNext` is true. */
  knownPages: number;
  /** Jump to a specific page (0-based). Refuses to skip past pages we
   *  don't have a cursor for. Use `pageIndex + 1` to advance. */
  goToPage(index: number): void;
  setPageSize(size: number): void;
  /** Clear the cursor stack, drop back to page 0, refetch. */
  refresh(): void;
  error: string | null;
}

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** Default cursor extractor — reads `next_cursor` from the response body
 *  (the OMA standard envelope shape). Override via `opts.getNextCursor`
 *  for endpoints that return it differently. */
function defaultGetNextCursor(res: unknown): string | undefined {
  const r = res as { next_cursor?: string };
  return r.next_cursor;
}

export function usePagedList<T>(
  endpoint: string,
  opts: PagedListOpts = {},
): PagedListResult<T> {
  const { api } = useApi();

  const defaultSize = opts.defaultPageSize ?? 20;
  const sizeOptions = opts.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;
  const enabled = opts.enabled ?? true;
  const syncUrl = opts.syncUrl ?? true;

  const [searchParams, setSearchParams] = useSearchParams();

  // Derive initial page / size from URL (or fallback to defaults). We pin
  // these to URL on every change via a separate effect — the URL is the
  // source of truth, but we mirror to local state so the render is sync.
  const initialPage = (() => {
    if (!syncUrl) return 0;
    const v = parseInt(searchParams.get("page") ?? "1", 10);
    return Number.isFinite(v) && v > 0 ? v - 1 : 0;
  })();
  const initialSize = (() => {
    if (!syncUrl) return defaultSize;
    const v = parseInt(searchParams.get("size") ?? "", 10);
    return sizeOptions.includes(v) ? v : defaultSize;
  })();

  const [pageIndex, setPageIndex] = useState(initialPage);
  const [pageSize, setPageSizeState] = useState(initialSize);
  const [items, setItems] = useState<T[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Stable identity for the params object so the effect doesn't loop on
  // inline object literals from callers.
  const paramsKey = JSON.stringify(opts.params ?? {});

  // Cursor stack: index N holds the cursor that fetches page N. Backend
  // is forward-only, so we cache every cursor we've used. Cleared when
  // filters or page size change.
  const cursorStackRef = useRef<Array<string | undefined>>([undefined]);
  // Track `knownPages` as React state (not just the ref) so the pagination
  // UI re-renders when we discover a new page.
  const [knownPages, setKnownPages] = useState(1);
  // Track filters / size across renders to detect changes that should
  // blow away the stack.
  const lastResetKeyRef = useRef(`${paramsKey}|${pageSize}`);

  const cursorParam = opts.cursorParam ?? "cursor";
  const getNextCursor = opts.getNextCursor ?? defaultGetNextCursor;

  const buildUrl = useCallback(
    (afterCursor?: string): string => {
      const sp = new URLSearchParams();
      sp.set("limit", String(pageSize));
      if (opts.params) {
        for (const [k, v] of Object.entries(opts.params)) {
          if (v !== undefined && v !== "") sp.set(k, v);
        }
      }
      if (afterCursor) sp.set(cursorParam, afterCursor);
      return `${endpoint}?${sp.toString()}`;
    },
    // paramsKey covers `opts.params`; pageSize + cursorParam are primitive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, pageSize, paramsKey, cursorParam],
  );

  // Fetch effect — fires on mount, page change, refresh, filter change,
  // page size change. AbortController tears down stale fetches.
  useEffect(() => {
    if (!enabled) return;

    // Filter / size change → clear stack and bounce to page 0. Has to
    // happen before we read the cursor since the URL we build uses it.
    const resetKey = `${paramsKey}|${pageSize}`;
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      cursorStackRef.current = [undefined];
      setKnownPages(1);
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
        const nextCursor = getNextCursor(res);
        setHasNext(!!nextCursor);
        if (nextCursor) {
          cursorStackRef.current[pageIndex + 1] = nextCursor;
          setKnownPages((n) => Math.max(n, pageIndex + 2));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, paramsKey, pageSize, enabled, refreshKey, pageIndex]);

  // URL sync. Pin `?page=N&size=N` whenever they change. Skip when
  // disabled or when both already match (avoids a no-op history entry).
  useEffect(() => {
    if (!syncUrl) return;
    const wantPage = String(pageIndex + 1);
    const wantSize = String(pageSize);
    const currentPage = searchParams.get("page");
    const currentSize = searchParams.get("size");
    // pageIndex 0 + default size means "clean URL" — drop the params.
    const shouldSetPage = pageIndex !== 0;
    const shouldSetSize = pageSize !== defaultSize;
    if (
      (shouldSetPage ? currentPage === wantPage : currentPage === null) &&
      (shouldSetSize ? currentSize === wantSize : currentSize === null)
    ) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (shouldSetPage) next.set("page", wantPage);
    else next.delete("page");
    if (shouldSetSize) next.set("size", wantSize);
    else next.delete("size");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, pageSize, syncUrl]);

  const goToPage = useCallback(
    (idx: number) => {
      if (idx < 0) return;
      // Refuse to skip past known pages (only Next can extend the stack).
      if (idx >= cursorStackRef.current.length) return;
      setPageIndex(idx);
    },
    [],
  );

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
  }, []);

  const refresh = useCallback(() => {
    cursorStackRef.current = [undefined];
    setKnownPages(1);
    setPageIndex(0);
    setRefreshKey((k) => k + 1);
  }, []);

  const result = useMemo<PagedListResult<T>>(
    () => ({
      items,
      isLoading,
      pageIndex,
      pageSize,
      hasNext,
      hasPrev: pageIndex > 0,
      knownPages,
      goToPage,
      setPageSize,
      refresh,
      error,
    }),
    [items, isLoading, pageIndex, pageSize, hasNext, knownPages, goToPage, setPageSize, refresh, error],
  );

  return result;
}
