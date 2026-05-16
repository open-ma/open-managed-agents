import * as Select from "@radix-ui/react-select";

interface PaginationProps {
  /** Zero-based current page; rendered as `Page {pageIndex + 1}`. */
  pageIndex: number;
  pageSize: number;
  hasNext: boolean;
  /** Number of pages we have cursors for (i.e. visited so far). When
   *  `hasNext` is true an ellipsis tile renders after the known pages. */
  knownPages: number;
  /** Items currently on screen — used to render "Showing X-Y" range. */
  itemCount: number;
  pageSizeOptions?: number[];
  loading?: boolean;
  onPageChange(index: number): void;
  onPageSizeChange(size: number): void;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/**
 * Build the visible list of page indices. Always shows page 0 and the
 * current page; collapses long runs with an ellipsis. Forward-only
 * cursor backend means we only know about pages we've visited — caller
 * passes `knownPages` (= cursor stack length) and `hasNext` to decide
 * whether to render the trailing "…" affordance.
 *
 * Returns a list of items: number = real page index, "…" = ellipsis tile.
 *
 * Examples (current = bold):
 *   knownPages=1, hasNext=true       → [**0**, …]
 *   knownPages=3, hasNext=true       → [0, 1, **2**, …]
 *   knownPages=8, hasNext=true,
 *     pageIndex=4                    → [0, …, 3, **4**, 5, …]
 *   knownPages=8, hasNext=false,
 *     pageIndex=7                    → [0, …, 5, 6, **7**]
 */
function buildPageList(
  pageIndex: number,
  knownPages: number,
  hasNext: boolean,
): Array<number | "…"> {
  const last = knownPages - 1; // highest known index
  const lo = Math.max(1, pageIndex - 1);
  const hi = Math.min(last - 1, pageIndex + 1);
  const out: Array<number | "…"> = [];

  // Always include page 0.
  out.push(0);

  // Gap between page 0 and the window?
  if (lo > 1) out.push("…");

  // Window around current page.
  for (let i = lo; i <= hi; i++) out.push(i);

  // Window contains the last known page already?
  if (hi < last - 1) out.push("…");
  if (last > 0) out.push(last);

  // Trailing ellipsis to signal "more pages exist past what we know".
  if (hasNext) out.push("…");

  // Dedup consecutive numbers (happens when knownPages is small).
  const dedup: Array<number | "…"> = [];
  for (const v of out) {
    const prev = dedup[dedup.length - 1];
    if (v === prev) continue;
    dedup.push(v);
  }
  return dedup;
}

/**
 * Full pagination footer for list pages.
 *
 *   Showing 21-40            [20 ▼ per page]            « ‹  3 [4] 5  …  ›
 *
 * Left:    "Showing X-Y" range (no total — backend is cursor-based, no count).
 * Middle:  Radix Select page-size picker. Caller provides allowed values.
 * Right:   First / Prev / numbered tiles with ellipsis / Next, all bordered
 *          to match the table card chrome above. Current page tile uses
 *          brand color so it's unmistakable at a glance.
 *
 * Pair with `usePagedList`.
 */
export function Pagination({
  pageIndex,
  pageSize,
  hasNext,
  knownPages,
  itemCount,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  loading,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const hasPrev = pageIndex > 0;

  const navBtn =
    "inline-flex items-center justify-center min-w-[32px] h-8 px-2 text-[13px] text-fg-muted bg-bg hover:bg-bg-sidebar hover:text-fg border border-border rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg disabled:hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
  const pageBtn = (active: boolean) =>
    `inline-flex items-center justify-center min-w-[32px] h-8 px-2 text-[13px] border rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg tabular-nums ${
      active
        ? "bg-brand text-brand-fg border-brand font-medium"
        : "text-fg-muted bg-bg hover:bg-bg-sidebar hover:text-fg border-border"
    }`;

  // 1-based range display. itemCount tells us the actual rows on screen
  // — true "to" is start + itemCount - 1, not start + pageSize - 1
  // (last page may be partial).
  const rangeStart = pageIndex * pageSize + 1;
  const rangeEnd = pageIndex * pageSize + itemCount;
  const showRange = itemCount > 0;

  const tiles = buildPageList(pageIndex, knownPages, hasNext);

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-sidebar/40 px-4 py-2.5 flex-wrap">
      {/* Left: range */}
      <div className="text-[12px] text-fg-subtle font-mono tabular-nums min-w-[100px]">
        {showRange ? `Showing ${rangeStart}–${rangeEnd}` : " "}
      </div>

      {/* Middle: page size selector */}
      <div className="flex items-center gap-2 text-[12px] text-fg-subtle font-mono">
        <Select.Root value={String(pageSize)} onValueChange={(v) => onPageSizeChange(parseInt(v, 10))}>
          <Select.Trigger
            aria-label="Rows per page"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 text-[13px] text-fg bg-bg border border-border rounded-md hover:bg-bg-sidebar transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg tabular-nums"
          >
            <Select.Value />
            <Select.Icon><ChevronDown /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              className="z-[60] overflow-hidden rounded-md border border-border bg-bg shadow-xl"
              position="popper"
              sideOffset={4}
            >
              <Select.Viewport className="p-1">
                {pageSizeOptions.map((n) => (
                  <Select.Item
                    key={n}
                    value={String(n)}
                    className="flex items-center gap-2 rounded px-2.5 py-1.5 text-[13px] text-fg cursor-pointer outline-none data-[highlighted]:bg-bg-sidebar data-[state=checked]:font-medium tabular-nums"
                  >
                    <Select.ItemText>{n}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <span className="text-fg-subtle">per page</span>
      </div>

      {/* Right: nav (First / Prev / numbered / Next) */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(0)}
          disabled={!hasPrev || loading}
          aria-label="First page"
          className={navBtn}
        >
          «
        </button>
        <button
          type="button"
          onClick={() => onPageChange(pageIndex - 1)}
          disabled={!hasPrev || loading}
          aria-label="Previous page"
          className={navBtn}
        >
          <ChevronLeft />
        </button>
        {tiles.map((t, i) =>
          t === "…" ? (
            <span
              key={`ellipsis-${i}`}
              aria-hidden="true"
              className="inline-flex items-center justify-center min-w-[32px] h-8 px-2 text-[13px] text-fg-subtle font-mono select-none"
            >
              …
            </span>
          ) : (
            <button
              key={t}
              type="button"
              onClick={() => onPageChange(t)}
              disabled={loading}
              aria-label={`Page ${t + 1}`}
              aria-current={t === pageIndex ? "page" : undefined}
              className={pageBtn(t === pageIndex)}
            >
              {t + 1}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(pageIndex + 1)}
          disabled={!hasNext || loading}
          aria-label="Next page"
          className={navBtn}
        >
          <ChevronRight />
        </button>
      </div>
    </div>
  );
}
