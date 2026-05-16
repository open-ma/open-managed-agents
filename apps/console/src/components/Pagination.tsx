interface PaginationProps {
  /** Zero-based current page; rendered as `Page {pageIndex + 1}`. */
  pageIndex: number;
  hasNext: boolean;
  hasPrev: boolean;
  onNext(): void;
  onPrev(): void;
  /** While true both buttons are disabled — prevents spam-clicks during
   *  an in-flight fetch. */
  loading?: boolean;
  /** Optional item count for the current page — rendered on the left
   *  ("20 results"). The cursor-based backend doesn't expose a total,
   *  so we can't show "1-20 of 1453" — caller passes whatever it has. */
  itemCount?: number;
}

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

/**
 * Prev / Page-N / Next pagination footer for list pages.
 *
 * Left:   "N results" (when itemCount provided) — anchors the row.
 * Right:  bordered button-group with chevron + label, page indicator
 *         pill between the two buttons. Matches the visual weight of
 *         the table chrome above so it reads as part of the same card.
 *
 * Pair with `usePagedList`.
 */
export function Pagination({
  pageIndex,
  hasNext,
  hasPrev,
  onNext,
  onPrev,
  loading,
  itemCount,
}: PaginationProps) {
  const navBtn =
    "inline-flex items-center gap-1.5 h-8 px-2.5 text-[13px] text-fg-muted bg-bg hover:bg-bg-sidebar hover:text-fg border border-border rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg disabled:hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-sidebar/40 px-4 py-2.5">
      <div className="text-[12px] text-fg-subtle font-mono">
        {itemCount !== undefined ? `${itemCount} ${itemCount === 1 ? "result" : "results"}` : " "}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev || loading}
          aria-label="Previous page"
          className={navBtn}
        >
          <ChevronLeft />
          <span>Prev</span>
        </button>
        <span className="text-[12px] text-fg-muted font-mono px-2.5 py-1 rounded-md bg-bg border border-border min-w-[68px] text-center tabular-nums">
          Page {pageIndex + 1}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext || loading}
          aria-label="Next page"
          className={navBtn}
        >
          <span>Next</span>
          <ChevronRight />
        </button>
      </div>
    </div>
  );
}
