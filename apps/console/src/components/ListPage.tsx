import { type ReactNode } from "react";

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => ReactNode;
  className?: string;
}

interface ListPageProps<T> {
  title: string;
  subtitle: string;
  createLabel: string;
  onCreate: () => void;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  showArchived?: boolean;
  onShowArchivedChange?: (v: boolean) => void;
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyTitle?: string;
  emptySubtitle?: string;
  onRowClick?: (item: T) => void;
  getRowKey: (item: T) => string;
  children?: ReactNode;
}

export function ListPage<T>({
  title,
  subtitle,
  createLabel,
  onCreate,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  showArchived,
  onShowArchivedChange,
  columns,
  data,
  loading,
  emptyTitle = "Nothing here yet",
  emptySubtitle,
  onRowClick,
  getRowKey,
  children,
}: ListPageProps<T>) {
  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">{title}</h1>
          <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>
        </div>
        <button
          onClick={onCreate}
          className="px-4 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover transition-colors"
        >
          {createLabel}
        </button>
      </div>

      {/* Controls */}
      {(onSearchChange || onShowArchivedChange) && (
        <div className="flex items-center gap-4 mb-4">
          {onSearchChange && (
            <div className="relative">
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
                type="text"
                value={searchValue ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder ?? "Search..."}
                className="border border-border rounded-md pl-8 pr-3 py-1.5 text-sm bg-bg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors w-64"
              />
            </div>
          )}

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

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <svg
            className="animate-spin h-5 w-5 text-fg-subtle"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </div>
      ) : data.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-fg-muted">{emptyTitle}</p>
          {emptySubtitle && (
            <p className="text-sm text-fg-subtle mt-1">{emptySubtitle}</p>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden mt-4">
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
                  className={`border-t border-border transition-colors ${
                    onRowClick
                      ? "hover:bg-bg-surface cursor-pointer"
                      : ""
                  }`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-3 ${col.className ?? ""}`}
                    >
                      {col.render
                        ? col.render(item)
                        : String((item as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {children}
    </div>
  );
}
