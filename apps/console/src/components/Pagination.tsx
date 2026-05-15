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
}

/**
 * Prev / Page-N / Next pagination footer for list pages. Designed to
 * sit inside the bordered table container in `ListPage` so the divider
 * + surface background match the rest of the chrome (compare with the
 * "Load more" footer of the same shell).
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
}: PaginationProps) {
  const btn =
    "text-sm text-fg-muted hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] px-2.5 py-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";

  return (
    <div className="flex items-center justify-end gap-3 border-t border-border bg-bg-surface px-4 py-3">
      <span className="text-sm text-fg-muted">Page {pageIndex + 1}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev || loading}
          aria-label="Previous page"
          className={btn}
        >
          Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext || loading}
          aria-label="Next page"
          className={btn}
        >
          Next
        </button>
      </div>
    </div>
  );
}
