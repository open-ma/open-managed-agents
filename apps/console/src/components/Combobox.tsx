import { Command } from "cmdk";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "../lib/api";

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
 *     resolve the label, cached in a module-level Map.
 *   - Module-level 30s TTL cache keyed by (endpoint, q, cursor).
 *
 * Why this exists: native `<select>`s in the console fetched `?limit=200`
 * up front and silently truncated past 200. Combobox + server-side `?q=`
 * (added in apps/main/src/lib/list-page.ts) fixes that without a UI lib's
 * worth of new patterns to learn — the surface here is small and the
 * cmdk primitive handles ARIA / keyboard / focus for us.
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
// Module-level cache: keyed by `${endpoint}|${q}|${cursor ?? ""}`.
// 30s TTL. Avoids reissuing the same request when the user closes/reopens
// the same popover quickly. Detail (preset-label) lookups share the same
// store under key `${endpoint}/${id}`.
// ────────────────────────────────────────────────────────────────────────

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: unknown }>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
}

function pageKey(endpoint: string, q: string, cursor?: string): string {
  return `${endpoint}|${q}|${cursor ?? ""}`;
}

function detailKey(endpoint: string, id: string): string {
  return `${endpoint}/${id}`;
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
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  // Resolved labels for preset values whose item isn't in the current page.
  const [presetItem, setPresetItem] = useState<T | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Prevent stale fetch responses from stomping fresh state when the user
  // types quickly. Each fetch gets a generation; only the latest applies.
  const fetchGenRef = useRef(0);

  // ── Debounce input → debouncedInput ──
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 250);
    return () => clearTimeout(t);
  }, [input]);

  // ── Reset paging on q change OR when popover opens ──
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setCursor(undefined);
    setHasMore(false);
    void loadPage(undefined, debouncedInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedInput, open]);

  // ── Resolve preset value's label when it's not in the current items ──
  useEffect(() => {
    if (!value) {
      setPresetItem(null);
      return;
    }
    if (items.some((it) => getValue(it) === value)) {
      // Found in current items — use those.
      const found = items.find((it) => getValue(it) === value)!;
      setPresetItem(found);
      return;
    }
    // Not in current page; fetch one-shot detail with cache.
    const dKey = detailKey(endpoint, value);
    const cached = cacheGet<T>(dKey);
    if (cached) {
      setPresetItem(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api<T>(`${endpoint}/${value}`);
        if (cancelled) return;
        cacheSet(dKey, detail);
        setPresetItem(detail);
      } catch {
        if (!cancelled) setPresetItem(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items, endpoint]);

  // ── IntersectionObserver for "scrolled to bottom → load more" ──
  useEffect(() => {
    if (!open || !hasMore || loading) return;
    const sentinel = listEndRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadPage(cursor, debouncedInput);
        }
      },
      { root: sentinel.parentElement, threshold: 0.1 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasMore, loading, cursor, debouncedInput]);

  const loadPage = useCallback(
    async (afterCursor: string | undefined, q: string) => {
      const gen = ++fetchGenRef.current;
      const key = pageKey(endpoint, q, afterCursor);
      const cached = cacheGet<PageResponse<T>>(key);
      const fetcher = cached
        ? Promise.resolve(cached)
        : (async () => {
            setLoading(true);
            const sp = new URLSearchParams();
            sp.set("limit", String(pageLimit));
            if (q) sp.set("q", q);
            if (afterCursor) sp.set("cursor", afterCursor);
            const res = await api<PageResponse<T>>(`${endpoint}?${sp}`);
            cacheSet(key, res);
            return res;
          })();
      try {
        const res = await fetcher;
        if (gen !== fetchGenRef.current) return; // stale response, ignore
        setItems((prev) => (afterCursor ? [...prev, ...res.data] : res.data));
        setCursor(res.next_cursor);
        setHasMore(!!res.next_cursor);
      } catch {
        if (gen === fetchGenRef.current) {
          setItems((prev) => (afterCursor ? prev : []));
          setHasMore(false);
        }
      } finally {
        if (gen === fetchGenRef.current) setLoading(false);
      }
    },
    [api, endpoint, pageLimit],
  );

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

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          className ??
          "w-full inline-flex items-center justify-between gap-2 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                  className="w-full px-3 py-2 text-[13px] bg-bg text-fg outline-none placeholder:text-fg-subtle"
                  autoFocus
                />
              </div>
            )}
            <Command.List className="overflow-y-auto p-1 flex-1">
              {!loading && visible.length === 0 && (
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
                    onSelect={() => {
                      onValueChange(v, it);
                      setOpen(false);
                      setInput("");
                    }}
                    className="relative flex items-center gap-2 px-3 py-1.5 text-[13px] text-fg rounded cursor-pointer outline-none data-[selected=true]:bg-bg-surface aria-selected:bg-bg-surface"
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
                  {loading ? "Loading..." : ""}
                </div>
              )}
              {loading && !hasMore && items.length === 0 && (
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
