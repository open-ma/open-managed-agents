import { type ReactNode } from "react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Page } from "./Page";
import { Pagination } from "./Pagination";
import { SkeletonRows } from "./Skeleton";

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => ReactNode;
  /** Class merged into both the <th> and the <td> for this column. */
  className?: string;
}

interface ListPageProps<T> {
  /** Page title (rendered in `font-display`). */
  title: string;
  /** Subtitle below the title — accepts ReactNode so callers can drop in
   *  inline `<code>` snippets, links, etc. (e.g. MemoryStoresList shows the
   *  mount path in the subtitle). */
  subtitle: ReactNode;

  /** Primary "create" button. Both must be set for the button to render —
   *  read-only pages (EvalRunsList) just omit them. */
  createLabel?: string;
  onCreate?: () => void;

  /** Extra controls rendered to the LEFT of the create button in the
   *  header row. Use for secondary CTAs like SkillsList's "ClawHub". */
  headerActions?: ReactNode;

  /** Built-in search input. Render only when `onSearchChange` is provided. */
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;

  /** Built-in "Show archived" checkbox. Render only when the change handler
   *  is provided. Pages that drive this server-side just wire it through. */
  showArchived?: boolean;
  onShowArchivedChange?: (v: boolean) => void;

  /** Extra filter controls rendered alongside search/archived in the
   *  controls row — e.g. an agent dropdown (SessionsList) or all/active
   *  tabs (Environments, Vaults). */
  filters?: ReactNode;

  /** Standard table columns. Cell rendering is via `render` or, if absent,
   *  string coercion of `item[key]`. */
  columns: Column<T>[];
  data: T[];

  loading?: boolean;
  emptyTitle?: string;
  /** ReactNode so callers can include code snippets, links etc. */
  emptySubtitle?: ReactNode;
  /** Action slot rendered inside the empty state — typically a Button
   *  that opens the create dialog so the empty state isn't a dead end. */
  emptyAction?: ReactNode;

  onRowClick?: (item: T) => void;
  getRowKey: (item: T) => string;

  /** Cursor pagination (mirrors useCursorList). When `onLoadMore` is set
   *  and `hasMore` is true, a "Load more" footer is rendered below the
   *  table; while `loadingMore` is true the button shows a loading state.
   *  Mutually exclusive with paginated mode (`onNextPage` / `onPrevPage`). */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;

  /** Paginated mode (mirrors usePagedList). When `onNextPage` and
   *  `onPrevPage` are set, a Prev / Page-N / Next footer is rendered
   *  instead of "Load more". Mutually exclusive with `hasMore` /
   *  `onLoadMore`; if both are wired the load-more footer wins. */
  pageIndex?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  onNextPage?: () => void;
  onPrevPage?: () => void;

  /** Anything to render below the table — typically modals tied to the
   *  page (create dialog, detail dialog, etc.). */
  children?: ReactNode;
}

/**
 * Reusable list-page chrome shared across the console (Sessions, Agents,
 * Environments, etc.). Provides the standard header / controls row / table
 * shell / loading + empty states / cursor-paginated load-more so each page
 * only declares its columns and renderers.
 *
 * Pages keep ownership of their modals — pass them via `children`. Any
 * truly per-page filter UI (tabs, dropdowns) goes through the `filters`
 * slot.
 */
export function ListPage<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  headerActions,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  showArchived,
  onShowArchivedChange,
  filters,
  columns,
  data,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  emptyAction,
  onRowClick,
  getRowKey,
  hasMore,
  onLoadMore,
  loadingMore,
  pageIndex,
  hasNext,
  hasPrev,
  onNextPage,
  onPrevPage,
  children,
}: ListPageProps<T>) {
  const hasControlsRow =
    !!onSearchChange || !!onShowArchivedChange || !!filters;
  const showCreate = !!onCreate && !!createLabel;

  return (
    <Page>
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-lg md:text-xl font-semibold tracking-tight text-fg truncate">
            {title}
          </h1>
          <div className="text-sm text-fg-muted mt-0.5">{subtitle}</div>
        </div>
        {(headerActions || showCreate) && (
          <div className="flex items-center gap-2 shrink-0">
            {headerActions}
            {showCreate && (
              <Button onClick={onCreate}>{createLabel}</Button>
            )}
          </div>
        )}
      </div>

      {/* Controls row */}
      {hasControlsRow && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 mb-4">
          {onSearchChange && (
            <div className="relative w-full sm:w-auto">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                value={searchValue ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder ?? "Search..."}
                className="border border-border rounded-md pl-8 pr-3 py-1.5 text-sm bg-bg text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] w-full sm:w-64"
                autoComplete="off"
                name="oma-list-search"
              />
            </div>
          )}

          {filters}

          {onShowArchivedChange && (
            <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showArchived ?? false}
                onChange={(e) => onShowArchivedChange(e.target.checked)}
                className="rounded accent-brand"
              />
              Show archived
            </label>
          )}
        </div>
      )}

      {/* Table / loading / empty */}
      {loading ? (
        <SkeletonRows count={8} height={40} gap={8} />
      ) : data.length === 0 ? (
        <EmptyState title={emptyTitle} body={emptySubtitle} action={emptyAction} size="lg" />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={`text-left px-4 py-2.5 ${col.className ?? ""}`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((item) => (
                  <tr
                    key={getRowKey(item)}
                    onClick={onRowClick ? () => onRowClick(item) : undefined}
                    className={`border-t border-border transition-[background-color] duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                      onRowClick
                        ? "hover:bg-bg-surface cursor-pointer"
                        : "hover:bg-bg-surface"
                    }`}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 ${col.className ?? ""}`}
                      >
                        {col.render
                          ? col.render(item)
                          : String(
                              (item as Record<string, unknown>)[col.key] ?? "",
                            )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && onLoadMore ? (
            <div className="flex justify-center border-t border-border bg-bg-surface py-3">
              <button
                onClick={onLoadMore}
                disabled={loadingMore}
                className="text-sm text-fg-muted hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : onNextPage && onPrevPage ? (
            <Pagination
              pageIndex={pageIndex ?? 0}
              hasNext={hasNext ?? false}
              hasPrev={hasPrev ?? false}
              onNext={onNextPage}
              onPrev={onPrevPage}
              loading={loading}
            />
          ) : null}
        </div>
      )}

      {children}
    </Page>
  );
}
