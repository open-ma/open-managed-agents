import { Command } from "cmdk";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";

/**
 * Generic Combobox for "pick one resource from a possibly large list."
 * Replaces native `<select>` everywhere we'd otherwise reach for it.
 *
 * Behavior:
 *   - Closed state: trigger button styled like TextInput; left shows
 *     selected label or placeholder; right ▼.
 *   - Open: popover with cmdk Command + Input + List (scrolls past first
 *     20 via cursor pagination, so a tenant with 1000+ agents never sees
 *     silent truncation).
 *   - Empty input: latest 20 from `endpoint`. Scroll to bottom auto-loads
 *     next 20.
 *   - Typing: 250ms debounce → `?q=...&limit=20`. Same scroll pagination.
 *   - Keyboard: ↑↓ Enter / Esc / type-to-search. Click outside closes.
 *   - Preset value not in current page → one-shot `GET endpoint/value` to
 *     resolve the label, cached by TanStack Query.
 *
 * Why this exists: native `<select>`s in the console fetched `?limit=200`
 * up front and silently truncated past 200. Combobox + server-side `?q=`
 * (added in apps/main/src/lib/list-page.ts) fixes that without a UI lib's
 * worth of new patterns to learn — the surface here is small and the
 * cmdk primitive handles ARIA / keyboard / focus for us.
 *
 * Fetch backbone: TanStack Query's `useInfiniteQuery`, which gives us
 *   - dedup across multiple Combobox instances on the same endpoint
 *   - tab-focus revalidation
 *   - AbortSignal-based cancellation on unmount
 *   - request-race protection (stale resolves dropped automatically)
 * for free, replacing the hand-rolled `fetchGenRef` + module Map cache
 * the previous version carried. `placeholderData: keepPreviousData`
 * keeps the prior results visible during a refetch so the dropdown
 * doesn't flicker to "No results" mid-search.
 */

interface PageResponse<T> {
  data: T[];
  next_cursor?: string;
}

export interface ComboboxProps<T> {
  value: string;
  onValueChange: (value: string, item: T | null) => void;
  /** API path, e.g. "/v1/agents". Combobox appends `?limit=&cursor=&q=`. */
  endpoint: string;
  /** Stable id extractor for an item. */
  getValue: (item: T) => string;
  /** Renderable label for an item — used both in trigger and rows. */
  getLabel: (item: T) => ReactNode;
  /** Plain-text label for the trigger when an item is selected; falls back
   *  to `String(getValue(item))` when omitted. Provide for items where
   *  `getLabel` returns JSX. */
  getTextLabel?: (item: T) => string;
  placeholder?: string;
  /** Hide the search input (still scrollable). Default false. */
  noSearch?: boolean;
  /** Item ids to filter out client-side (e.g. already-picked agents). */
  excludeIds?: string[];
  disabled?: boolean;
  className?: string;
  /** Page size for each fetch. Default 20. */
  pageLimit?: number;
}

// ────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────

export function Combobox<T>({
  value,
  onValueChange,
  endpoint,
  getValue,
  getLabel,
  getTextLabel,
  placeholder = "Select...",
  noSearch = false,
  excludeIds,
  disabled,
  className,
  pageLimit = 20,
}: ComboboxProps<T>) {
  const { api } = useApi();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [debouncedInput, setDebouncedInput] = useState("");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ── Debounce input → debouncedInput ──
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 250);
    return () => clearTimeout(t);
  }, [input]);

  // ── Infinite list fetch via TQ ──
  // Cache identity is (endpoint, debounced q, pageLimit). Two Comboboxes
  // pointing at the same endpoint with the same q share a single in-flight
  // fetch + cache entry. queryFn pulls cursor pages via `pageParam`; getNext
  // returns the server-supplied `next_cursor` (undefined = end of list).
  const infiniteQuery = useInfiniteQuery<PageResponse<T>>({
    queryKey: [endpoint, "combobox", debouncedInput, pageLimit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(pageLimit));
      if (debouncedInput) sp.set("q", debouncedInput);
      if (typeof pageParam === "string") sp.set("cursor", pageParam);
      return api<PageResponse<T>>(`${endpoint}?${sp}`, { signal });
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: open,
    // Keep prior pages visible while a new search is in flight — without
    // this the dropdown blanks to "No results" between the user typing
    // and the new payload landing.
    placeholderData: keepPreviousData,
  });

  // Flatten pages into a single items array so the render loop doesn't
  // have to know about TQ's page-of-pages shape.
  const items = useMemo<T[]>(() => {
    const pages = infiniteQuery.data?.pages ?? [];
    if (pages.length === 0) return [];
    if (pages.length === 1) return pages[0].data;
    return pages.flatMap((p) => p.data);
  }, [infiniteQuery.data]);

  // `isFetching` (true on background refetches too) drives the inline
  // "Loading..." treatment; `items.length === 0 && isFetching` switches to
  // the centered first-fetch spinner — same UX split the previous version
  // achieved via the `loading` boolean.
  const isFetching = infiniteQuery.isFetching;
  const hasMore = !!infiniteQuery.hasNextPage;

  // ── Resolve preset value's label when it's not in the current items ──
  // Skipped when the value is already in `items` (avoids a redundant fetch
  // every time the user opens the dropdown with the selection still in
  // view) or empty. TQ handles dedup + 30s cache for us.
  const presetInItems = !value || items.some((it) => getValue(it) === value);
  const { data: presetFetched } = useApiQuery<T>(
    !presetInItems && value ? `${endpoint}/${value}` : null,
  );
  const presetItem: T | null = presetInItems
    ? items.find((it) => getValue(it) === value) ?? null
    : presetFetched ?? null;

  // ── IntersectionObserver for "scrolled to bottom → load more" ──
  useEffect(() => {
    if (!open || !hasMore || infiniteQuery.isFetchingNextPage) return;
    const sentinel = listEndRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void infiniteQuery.fetchNextPage();
        }
      },
      { root: sentinel.parentElement, threshold: 0.1 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [open, hasMore, infiniteQuery]);

  // ── Click outside / Esc to close ──
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const root = popoverRef.current;
      const trig = triggerRef.current;
      if (!root || !trig) return;
      if (root.contains(e.target as Node) || trig.contains(e.target as Node)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ── Trigger label ──
  const labelText = (() => {
    if (!value) return placeholder;
    const item = presetItem ?? items.find((it) => getValue(it) === value);
    if (!item) return value; // fallback to raw id while detail resolves
    return getTextLabel ? getTextLabel(item) : String(getValue(item));
  })();
  const isPlaceholder = !value;

  // ── Filter items by excludeIds ──
  const visible = excludeIds
    ? items.filter((it) => !excludeIds.includes(getValue(it)))
    : items;

  // First-fetch spinner state: nothing rendered yet AND a query is in
  // flight. Subsequent background refetches keep showing the prior items
  // thanks to `placeholderData: keepPreviousData`.
  const showInitialLoading = items.length === 0 && isFetching;

  const handleSelect = useCallback(
    (id: string, item: T) => {
      onValueChange(id, item);
      setOpen(false);
      setInput("");
    },
    [onValueChange],
  );

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          className ??
          "w-full inline-flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-50 disabled:cursor-not-allowed"
        }
      >
        <span
          className={`truncate text-left flex-1 ${
            isPlaceholder ? "text-fg-subtle" : ""
          }`}
        >
          {labelText}
        </span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute z-50 mt-1 w-full min-w-[200px] overflow-hidden rounded-md border border-border bg-bg shadow-xl"
          // Stop the cmdk root from clipping our footer / loader.
        >
          <Command shouldFilter={false} className="flex flex-col max-h-80">
            {!noSearch && (
              <div className="border-b border-border">
                <Command.Input
                  value={input}
                  onValueChange={setInput}
                  placeholder="Search..."
                  className="w-full px-3 py-2 min-h-11 sm:min-h-0 text-[13px] bg-bg text-fg outline-none placeholder:text-fg-subtle"
                  autoFocus
                />
              </div>
            )}
            <Command.List className="overflow-y-auto p-1 flex-1">
              {!isFetching && visible.length === 0 && (
                <Command.Empty className="px-3 py-6 text-center text-[13px] text-fg-subtle">
                  {debouncedInput
                    ? `No results for "${debouncedInput}"`
                    : "No results"}
                </Command.Empty>
              )}
              {visible.map((it) => {
                const v = getValue(it);
                return (
                  <Command.Item
                    key={v}
                    value={v}
                    onSelect={() => handleSelect(v, it)}
                    className="relative flex items-center gap-2 px-3 py-1.5 min-h-11 sm:min-h-0 text-[13px] text-fg rounded cursor-pointer outline-none data-[selected=true]:bg-bg-surface aria-selected:bg-bg-surface"
                  >
                    <span className="truncate flex-1">{getLabel(it)}</span>
                    {value === v && (
                      <span className="text-brand">
                        <CheckIcon />
                      </span>
                    )}
                  </Command.Item>
                );
              })}
              {/* Sentinel for IntersectionObserver — sits inside scroll
                  container so its own visibility tracks scroll position. */}
              {hasMore && (
                <div ref={listEndRef} className="py-2 text-center text-[12px] text-fg-subtle">
                  {infiniteQuery.isFetchingNextPage ? "Loading..." : ""}
                </div>
              )}
              {showInitialLoading && (
                <div className="px-3 py-6 text-center text-[13px] text-fg-subtle">
                  Loading...
                </div>
              )}
            </Command.List>
          </Command>
        </div>
      )}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-subtle shrink-0">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
