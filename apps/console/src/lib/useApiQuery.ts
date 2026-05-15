import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useApi } from "./api";

/**
 * Thin TanStack Query wrappers around `useApi`. Existing semantics (auth
 * headers, error toasting, tenant pinning) come from `useApi` itself —
 * these hooks just wire its `api` / fetch promise into TQ's lifecycle.
 *
 * Why these exist:
 *   - List/detail pages can stop hand-rolling `useEffect` + `useState` for
 *     fetched data. `useApiQuery` returns the canonical `{ data, isLoading,
 *     error, refetch }`; loading state derives from `isLoading` automatically.
 *   - Cache + dedup: two components asking for the same path within
 *     `staleTime` (30s) get one fetch. Tab-switch refetch is built in.
 *   - Mutations: `useApiMutation` + `queryClient.invalidateQueries(...)`
 *     replaces ad-hoc "POST then call refresh()" patterns; the list
 *     refetches automatically.
 *
 * Defaults inherited from `queryClient` (`src/lib/query-client.ts`):
 *   staleTime 30s, gcTime 5min, refetchOnWindowFocus, retry 1.
 *
 * Don't reach past these wrappers unless you actually need a TQ feature
 * they don't expose — the goal is a tiny surface so the codebase stays
 * easy to scan.
 */

// ────────────────────────────────────────────────────────────────────────
// URL building shared by both query hooks. Mirrors the inline param logic
// `useCursorList` / `usePagedList` carry. Drops undefined/empty values so
// `params: { agent_id: undefined }` is a no-op rather than `?agent_id=`.
// ────────────────────────────────────────────────────────────────────────

export function buildUrl(
  path: string,
  params?: Record<string, string | undefined>,
  extra?: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const src of [params, extra]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== "") sp.set(k, v);
    }
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

// ────────────────────────────────────────────────────────────────────────
// Single-resource fetch (detail page / aux fetch).
// ────────────────────────────────────────────────────────────────────────

export interface ApiQueryOpts<T> {
  /** When false, defer the fetch (e.g. waiting for an upstream id). */
  enabled?: boolean;
  /** Per-query cache override. Defaults to the QueryClient's 30s. */
  staleTime?: number;
  /** Useful for things like polling; supply a number in ms or a fn. */
  refetchInterval?: UseQueryOptions<T>["refetchInterval"];
}

export function useApiQuery<T>(
  path: string | null | undefined,
  params?: Record<string, string | undefined>,
  opts: ApiQueryOpts<T> = {},
) {
  const { api } = useApi();

  // Normalize params into a stable JSON-shaped object for the queryKey so
  // two callers passing `{ a: "x" }` from different render origins still
  // dedupe. Empty `{}` is the canonical "no params" key.
  const normalizedParams = useMemo(() => params ?? {}, [params]);

  return useQuery<T>({
    // [path, params] is the cache identity. Two consumers with the same
    // path + params share a single in-flight fetch + cache entry.
    queryKey: [path, normalizedParams],
    queryFn: ({ signal }) => {
      // `enabled: false` already short-circuits TQ; this guard is just a
      // safety net for the type system since `path` may be nullable.
      if (!path) throw new Error("useApiQuery: path is required");
      return api<T>(buildUrl(path, normalizedParams), { signal });
    },
    enabled: (opts.enabled ?? true) && !!path,
    staleTime: opts.staleTime,
    refetchInterval: opts.refetchInterval,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Cursor-paginated infinite list. Drop-in replacement for `useCursorList`.
// Returned shape mirrors what the existing list pages destructure today
// (items, isLoading, hasMore, loadMore, isLoadingMore, refresh).
// ────────────────────────────────────────────────────────────────────────

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

export interface InfiniteApiQueryOpts {
  /** Per-page limit. Mirrors `useCursorList`'s `limit`. */
  limit?: number;
  /** Stable identity recommended (pass `useMemo` if reactive). */
  params?: Record<string, string | undefined>;
  /** When false, skip the initial fetch. Defaults to true. */
  enabled?: boolean;
}

export function useInfiniteApiQuery<T>(
  endpoint: string,
  opts: InfiniteApiQueryOpts = {},
) {
  const { api } = useApi();

  // JSON.stringify keeps the queryKey stable across inline-object renders.
  // Same trick `useCursorList` used internally for its effect deps; with
  // TQ we surface it through the queryKey instead.
  const paramsKey = useMemo(
    () => JSON.stringify(opts.params ?? {}),
    [opts.params],
  );

  const query = useInfiniteQuery<PageResponse<T>>({
    queryKey: [endpoint, "infinite", opts.limit ?? null, paramsKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<PageResponse<T>>(
        buildUrl(
          endpoint,
          opts.params,
          {
            limit: opts.limit ? String(opts.limit) : undefined,
            cursor: typeof pageParam === "string" ? pageParam : undefined,
          },
        ),
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: opts.enabled ?? true,
  });

  // Flatten pages into a single items array so the consumer doesn't have
  // to know about TQ's page-of-pages shape. Stable across renders if the
  // underlying pages array is unchanged.
  const items = useMemo<T[]>(() => {
    const pages = query.data?.pages ?? [];
    if (pages.length === 0) return [];
    if (pages.length === 1) return pages[0].data;
    return pages.flatMap((p) => p.data);
  }, [query.data]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    items,
    isLoading: query.isPending,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: !!query.hasNextPage,
    loadMore,
    refresh,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Mutation wrapper. Same surface as `useMutation` but with the toasting
// `api` already wired in. Most callers will pair it with
// `queryClient.invalidateQueries({ queryKey: [path] })` in `onSuccess` —
// re-fetches every list/detail keyed under that path automatically.
// ────────────────────────────────────────────────────────────────────────

export interface ApiMutationVariables<TBody> {
  path: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: TBody;
  /** Override the JSON-encoding default — pass FormData here directly. */
  formData?: FormData;
}

export function useApiMutation<TResult = unknown, TBody = unknown>(
  options?: Omit<
    UseMutationOptions<TResult, Error, ApiMutationVariables<TBody>>,
    "mutationFn"
  >,
) {
  const { api } = useApi();

  return useMutation<TResult, Error, ApiMutationVariables<TBody>>({
    mutationFn: ({ path, method = "POST", body, formData }) =>
      api<TResult>(path, {
        method,
        body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      }),
    ...options,
  });
}

// Re-export for callers that need direct cache control (e.g. optimistic
// patches, manual invalidation outside a mutation lifecycle).
export { useQueryClient };
