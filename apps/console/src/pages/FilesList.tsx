import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApi, getActiveTenantId } from "../lib/api";
import { useToast } from "../components/Toast";
import { ListPage } from "../components/ListPage";

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

const PAGE_SIZE = 50;

export function FilesList() {
  const { api } = useApi();
  const { toast } = useToast();
  const [items, setItems] = useState<FileRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scopeFilter, setScopeFilter] = useState("");
  const [search, setSearch] = useState("");

  const buildUrl = (beforeId?: string) => {
    const sp = new URLSearchParams();
    sp.set("limit", String(PAGE_SIZE));
    if (scopeFilter) sp.set("scope_id", scopeFilter);
    if (beforeId) sp.set("before_id", beforeId);
    return `/v1/files?${sp.toString()}`;
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api<ListResponse>(buildUrl());
      setItems(res.data);
      setHasMore(!!res.has_more);
    } catch {
      // api() already toasted; empty list communicates the failure.
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    const lastId = items[items.length - 1]?.id;
    if (!lastId || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api<ListResponse>(buildUrl(lastId));
      setItems((prev) => [...prev, ...res.data]);
      setHasMore(!!res.has_more);
    } catch {
      // toasted by api()
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFilter]);

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
      setItems((prev) => prev.filter((x) => x.id !== f.id));
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
          className="border border-border rounded-md px-3 py-1.5 text-sm bg-bg text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors w-full sm:w-72"
        />
      }
      data={filtered}
      loading={loading}
      hasMore={hasMore && !search}
      onLoadMore={loadMore}
      loadingMore={loadingMore}
      getRowKey={(f) => f.id}
      emptyTitle={scopeFilter ? "No files in this scope" : "No files yet"}
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
                  className="text-xs text-fg-muted hover:text-fg mr-3"
                >
                  Download
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); void remove(f); }}
                className="text-xs text-danger hover:text-danger/80"
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
