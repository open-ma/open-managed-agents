import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useApi, getActiveTenantId } from "../lib/api";
import { useToast } from "../components/Toast";
import { ListPage } from "../components/ListPage";
import { usePagedList } from "../lib/usePagedList";

interface FileRecord {
  id: string;
  type?: "file";
  filename: string;
  media_type: string;
  size_bytes: number;
  scope_id?: string;
  downloadable?: boolean;
  created_at: string;
}

interface ListResponse {
  data: FileRecord[];
  has_more?: boolean;
  first_id?: string;
  last_id?: string;
}

export function FilesList() {
  const { api } = useApi();
  const { toast } = useToast();
  const [scopeFilter, setScopeFilter] = useState("");
  const [search, setSearch] = useState("");

  // Files endpoint follows the Anthropic Files API shape — `before_id`
  // for the cursor param and `last_id` (only when `has_more` is true) for
  // the next-page cursor — instead of OMA's standard `cursor` /
  // `next_cursor`. usePagedList accepts adapter overrides for both.
  const filesParams = useMemo(
    () => ({ scope_id: scopeFilter || undefined }),
    [scopeFilter],
  );
  const {
    items,
    isLoading: loading,
    pageIndex,
    pageSize,
    hasNext,
    knownPages,
    goToPage,
    setPageSize,
    refresh: refreshFiles,
  } = usePagedList<FileRecord>("/v1/files", {
    defaultPageSize: 20,
    params: filesParams,
    cursorParam: "before_id",
    getNextCursor: (res) => {
      const r = res as ListResponse;
      return r.has_more ? r.data[r.data.length - 1]?.id : undefined;
    },
  });

  // Direct fetch for binary download — api() always parses JSON, and we need
  // the raw blob. Mirror its tenant-pin header so downloads honor the active
  // workspace, not the user's default tenant.
  const download = async (f: FileRecord) => {
    try {
      const activeTenant = getActiveTenantId();
      const res = await fetch(`/v1/files/${f.id}/content`, {
        credentials: "include",
        headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: string }).error || `HTTP ${res.status}`;
        toast(`Download failed: ${message}`, "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(`Download failed: ${e instanceof Error ? e.message : "network error"}`, "error");
    }
  };

  const remove = async (f: FileRecord) => {
    if (!confirm(`Delete "${f.filename}"? The R2 object and metadata both go. This cannot be undone.`)) return;
    try {
      await api(`/v1/files/${f.id}`, { method: "DELETE" });
      // Invalidate every /v1/files query (any scope filter) so the page
      // Refetch — usePagedList exposes refresh() which clears the cursor
      // stack and bounces back to page 0. Cheaper than maintaining a
      // local optimistic copy; the next refetch lands fresh server truth.
      refreshFiles();
    } catch {
      // toasted
    }
  };

  // Search is client-side over the loaded page — backend doesn't index by
  // filename and the upload API has no name filter. Operators who need a
  // file from the long tail filter by scope_id (server-side) first.
  const filtered = search
    ? items.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()))
    : items;

  return (
    <ListPage<FileRecord>
      title="Files"
      subtitle={
        <>
          Tenant-scoped file storage (<code className="text-xs">/v1/files</code>). Used by agents for inputs, attachments, and session outputs.
        </>
      }
      searchPlaceholder="Filter loaded files by name…"
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <input
          type="text"
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          placeholder="Filter by scope (session ID)…"
          aria-label="Filter by session scope"
          className="border border-border rounded-md px-3 py-1.5 min-h-11 sm:min-h-0 text-sm bg-bg text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] w-full sm:w-72"
        />
      }
      data={filtered}
      loading={loading}
      hasNext={hasNext && !search}
      pageIndex={pageIndex}
      pageSize={pageSize}
      knownPages={knownPages}
      onPageChange={goToPage}
      onPageSizeChange={setPageSize}
      getRowKey={(f) => f.id}
      emptyTitle={scopeFilter ? "No files in this scope" : "No files yet"}
      emptyKind="file"
      emptySubtitle={
        scopeFilter
          ? "Try clearing the scope filter, or check the session id."
          : <>Upload via <code className="text-xs">POST /v1/files</code> or the AMA SDK <code className="text-xs">client.beta.files.create()</code>.</>
      }
      columns={[
        {
          key: "filename",
          label: "Filename",
          className: "font-medium",
          render: (f) => (
            <span title={f.filename} className="truncate inline-block max-w-[280px] align-bottom">
              {f.filename}
            </span>
          ),
        },
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[160px]",
          render: (f) => <span title={f.id}>{f.id}</span>,
        },
        {
          key: "media_type",
          label: "Type",
          className: "text-fg-muted text-xs",
        },
        {
          key: "size_bytes",
          label: "Size",
          className: "text-fg-muted text-xs tabular-nums",
          render: (f) => formatBytes(f.size_bytes),
        },
        {
          key: "scope",
          label: "Scope",
          className: "text-fg-muted text-xs font-mono",
          render: (f) =>
            f.scope_id ? (
              <Link
                to={`/sessions/${f.scope_id}`}
                onClick={(e) => e.stopPropagation()}
                className="text-brand hover:underline"
              >
                {f.scope_id}
              </Link>
            ) : (
              <span className="text-fg-subtle">—</span>
            ),
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted text-xs whitespace-nowrap",
          render: (f) => new Date(f.created_at).toLocaleString(),
        },
        {
          key: "actions",
          label: "",
          className: "text-right whitespace-nowrap",
          render: (f) => (
            <>
              {f.downloadable && (
                <button
                  onClick={(e) => { e.stopPropagation(); void download(f); }}
                  className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 text-xs text-fg-muted hover:text-fg mr-1 sm:mr-3 px-2"
                >
                  Download
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); void remove(f); }}
                className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 text-xs text-danger hover:text-danger/80 px-2"
              >
                Delete
              </button>
            </>
          ),
        },
      ]}
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
