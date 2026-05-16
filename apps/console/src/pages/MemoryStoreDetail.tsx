import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { TabsRoot, TabList, Tab, TabPanel } from "../components/Tabs";

interface MemoryStore {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  archived_at?: string;
}
interface MemoryListItem {
  id: string;
  store_id: string;
  path: string;
  content_sha256: string;
  etag: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}
interface Memory extends MemoryListItem {
  content: string;
}
interface MemoryVersion {
  id: string;
  memory_id: string;
  store_id: string;
  operation: "created" | "modified" | "deleted";
  path?: string;
  content?: string;
  content_sha256?: string;
  size_bytes?: number;
  actor: { type: string; id: string };
  created_at: string;
  redacted?: boolean;
}

type Tab = "memories" | "versions" | "settings";

export function MemoryStoreDetail() {
  const { id: storeId } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("memories");
  const [error, setError] = useState<string | null>(null);

  // Top-level store fetch via TQ. The two child panels do their own
  // queries — this one just gates the page render and seeds the header.
  const { data: store, error: storeError } = useApiQuery<MemoryStore>(
    storeId ? `/v1/memory_stores/${storeId}` : null,
  );
  useEffect(() => {
    if (storeError) setError(errMsg(storeError));
  }, [storeError]);

  if (!storeId) return <div className="p-8">Missing store id.</div>;
  if (error) return (
    <div className="flex-1 p-8">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <Link to="/memory" className="text-sm text-fg-muted hover:text-fg">← Back to memory stores</Link>
    </div>
  );
  if (!store) return <div className="flex-1 p-8 text-fg-muted">Loading...</div>;

  return (
    <Page>
      <Link to="/memory" className="text-sm text-fg-muted hover:text-fg mb-4 inline-block">← Memory stores</Link>
      <div className="flex items-start justify-between mb-2">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{store.name}</h1>
          {store.description && <p className="text-fg-muted mt-1">{store.description}</p>}
          <p className="text-fg-subtle text-xs font-mono mt-1">
            {store.id} · /mnt/memory/{store.name}/
            {store.archived_at && <span className="ml-2 text-fg-muted">· archived {new Date(store.archived_at).toLocaleDateString()}</span>}
          </p>
        </div>
      </div>

      <TabsRoot value={tab} onValueChange={(v) => setTab(v as Tab)} aria-label="Memory store sections" className="mt-6">
        <TabList className="mb-6">
          <Tab value="memories">Memories</Tab>
          <Tab value="versions">Version history</Tab>
          <Tab value="settings">Settings</Tab>
        </TabList>

        <TabPanel value="memories">
          <MemoriesPanel storeId={storeId} archived={!!store.archived_at} />
        </TabPanel>
        <TabPanel value="versions">
          <VersionsPanel storeId={storeId} />
        </TabPanel>
        <TabPanel value="settings">
          <SettingsPanel store={store} archived={!!store.archived_at} />
        </TabPanel>
      </TabsRoot>
    </Page>
  );
}

// =================================================================
// Memories tab — list, create, view, edit, delete
// =================================================================

function MemoriesPanel({ storeId, archived }: { storeId: string; archived: boolean }) {
  const { api } = useApi();
  const [error, setError] = useState<string | null>(null);
  const [pathPrefix, setPathPrefix] = useState("");
  const [depth, setDepth] = useState("");
  const [showWrite, setShowWrite] = useState(false);
  const [open, setOpen] = useState<Memory | null>(null);

  // List query — TQ keys on (path, params), so changing pathPrefix/depth
  // gets a fresh cache slot and refetch automatically. The previous hand-
  // rolled load() had the same shape, just without the cache and dedup.
  const params = {
    path_prefix: pathPrefix || undefined,
    depth: depth || undefined,
  };
  const {
    data: listRes,
    isLoading: loading,
    error: listError,
    refetch,
  } = useApiQuery<{ data: MemoryListItem[] }>(
    `/v1/memory_stores/${storeId}/memories`,
    params,
  );
  useEffect(() => {
    if (listError) setError(errMsg(listError));
  }, [listError]);
  const memories = listRes?.data ?? [];
  const load = () => {
    void refetch();
  };

  const openMemory = async (m: MemoryListItem) => {
    try {
      const full = await api<Memory>(`/v1/memory_stores/${storeId}/memories/${m.id}`);
      setOpen(full);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div>
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="flex gap-2 mb-4">
        <input
          placeholder="Filter by path prefix (e.g. /preferences/)"
          aria-label="Filter by path prefix"
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
          className="flex-1 border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-border-strong"
        />
        <input
          placeholder="Depth"
          aria-label="Depth filter"
          value={depth}
          onChange={(e) => setDepth(e.target.value.replace(/[^0-9]/g, ""))}
          className="w-24 border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-border-strong"
        />
        {!archived && (
          <button onClick={() => setShowWrite(true)}
            className="inline-flex items-center justify-center px-4 py-2 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] whitespace-nowrap">
            + New memory
          </button>
        )}
      </div>

      {showWrite && !archived && (
        <WriteMemoryDialog
          storeId={storeId}
          existing={null}
          onClose={() => setShowWrite(false)}
          onSaved={() => { setShowWrite(false); load(); }}
        />
      )}

      {loading ? <p className="text-fg-subtle text-sm py-4">Loading...</p> : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Path</th>
                <th className="text-left px-4 py-2.5">Size</th>
                <th className="text-left px-4 py-2.5">SHA-256</th>
                <th className="text-left px-4 py-2.5">Updated</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => openMemory(m)}
                  className="border-t border-border cursor-pointer hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                >
                  <td className="px-4 py-3 font-mono text-xs">{m.path}</td>
                  <td className="px-4 py-3">{m.size_bytes} B</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{m.content_sha256.slice(0, 12)}…</td>
                  <td className="px-4 py-3 text-fg-muted">{new Date(m.updated_at).toLocaleString()}</td>
                </tr>
              ))}
              {!memories.length && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-fg-subtle">No memories</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <MemoryDetailDialog
          storeId={storeId}
          memory={open}
          archived={archived}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); load(); }}
        />
      )}
    </div>
  );
}

// =================================================================
// Memory detail dialog — view + edit + delete + version history sub-panel
// =================================================================

function MemoryDetailDialog({
  storeId, memory, archived, onClose, onSaved,
}: {
  storeId: string;
  memory: Memory;
  archived: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useApi();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [path, setPath] = useState(memory.path);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const loadVersions = async () => {
    try {
      const { data } = await api<{ data: MemoryVersion[] }>(
        `/v1/memory_stores/${storeId}/memory_versions?memory_id=${memory.id}`,
      );
      setVersions(data);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const save = async () => {
    setError(null);
    try {
      await api(`/v1/memory_stores/${storeId}/memories/${memory.id}`, {
        method: "POST",
        body: JSON.stringify({
          path: path !== memory.path ? path : undefined,
          content: content !== memory.content ? content : undefined,
          // CAS guard: refuse to clobber if someone else wrote since we read.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
        }),
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const remove = async () => {
    if (!confirm(`Delete memory "${memory.path}"? Audit history is preserved.`)) return;
    setError(null);
    try {
      await api(
        `/v1/memory_stores/${storeId}/memories/${memory.id}?expected_content_sha256=${memory.content_sha256}`,
        { method: "DELETE" },
      );
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const rollback = async (v: MemoryVersion) => {
    if (v.content === undefined || v.content === null) {
      alert("This version's content has been redacted — can't roll back.");
      return;
    }
    if (!confirm(`Roll back to version ${v.id} (${new Date(v.created_at).toLocaleString()})?\n\nThis writes a new version with the old content.`)) return;
    setError(null);
    try {
      await api(`/v1/memory_stores/${storeId}/memories/${memory.id}`, {
        method: "POST",
        body: JSON.stringify({
          content: v.content,
          // CAS against current head so we don't clobber a concurrent write.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
        }),
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const redact = async (v: MemoryVersion) => {
    if (v.content_sha256 && v.content_sha256 === memory.content_sha256) {
      alert("Can't redact the live head version. Write a new version first or delete the memory.");
      return;
    }
    if (!confirm(`Redact version ${v.id}? Content will be wiped; audit row stays.`)) return;
    setError(null);
    try {
      await api(`/v1/memory_stores/${storeId}/memory_versions/${v.id}/redact`, { method: "POST" });
      loadVersions();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={memory.path}
      subtitle={`${memory.id} · sha256=${memory.content_sha256.slice(0, 16)}… · ${memory.size_bytes}B`}
      maxWidth="max-w-3xl"
      footer={
        <div className="flex gap-2 w-full">
          {!archived && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                onClick={save}
                className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setContent(memory.content);
                  setPath(memory.path);
                }}
                className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Cancel
              </button>
            </>
          )}
          {!editing && (
            <button
              onClick={() => {
                setShowVersions((s) => !s);
                if (!showVersions) loadVersions();
              }}
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              aria-expanded={showVersions}
            >
              {showVersions ? "Hide" : "Show"} version history
            </button>
          )}
          {!archived && !editing && (
            <button
              onClick={remove}
              className="ml-auto inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-danger/10 border border-danger/30 text-danger rounded-lg text-sm hover:bg-danger/20 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              Delete memory
            </button>
          )}
        </div>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {editing && (
        <div className="mb-3">
          <label htmlFor="memory-edit-path" className="sr-only">Memory path</label>
          <input
            id="memory-edit-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="w-full font-mono text-sm border border-border rounded-lg px-3 py-1.5 min-h-11 sm:min-h-0 bg-bg outline-none focus:border-border-strong"
          />
        </div>
      )}

      {editing ? (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          aria-label="Memory content"
          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg font-mono outline-none focus:border-border-strong"
        />
      ) : (
        <pre className="whitespace-pre-wrap bg-bg-surface border border-border rounded-lg p-3 max-h-[40vh] overflow-auto text-sm font-mono text-fg">
          {memory.content || <span className="text-fg-subtle">(empty)</span>}
        </pre>
      )}

      {showVersions && versions && (
        <div className="mt-4 border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-bg-surface/60 text-fg-muted uppercase tracking-wider">
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Op</th>
                <th className="text-left px-3 py-2">Actor</th>
                <th className="text-left px-3 py-2">SHA-256</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => {
                const isLiveHead = v.content_sha256 && v.content_sha256 === memory.content_sha256;
                return (
                  <tr key={v.id} className="border-t border-border">
                    <td className="px-3 py-2 text-fg-muted">{new Date(v.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono">{v.operation}{v.redacted && " · redacted"}</td>
                    <td className="px-3 py-2 font-mono text-fg-muted">{v.actor.type}:{v.actor.id}</td>
                    <td className="px-3 py-2 font-mono text-fg-muted">
                      {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "—"}
                      {isLiveHead && <span className="ml-2 text-brand">(head)</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!archived && !v.redacted && v.content !== undefined && v.content !== null && !isLiveHead && (
                        <button onClick={() => rollback(v)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-brand hover:underline mr-1 sm:mr-2">
                          Roll back
                        </button>
                      )}
                      {!archived && !v.redacted && !isLiveHead && (
                        <button onClick={() => redact(v)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-danger hover:underline">
                          Redact
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!versions.length && (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-fg-subtle">No versions</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// =================================================================
// Versions tab (store-wide audit timeline)
// =================================================================

function VersionsPanel({ storeId }: { storeId: string }) {
  const [error, setError] = useState<string | null>(null);
  const {
    data: res,
    isLoading: loading,
    error: queryError,
  } = useApiQuery<{ data: MemoryVersion[] }>(
    `/v1/memory_stores/${storeId}/memory_versions`,
  );
  useEffect(() => {
    if (queryError) setError(errMsg(queryError));
  }, [queryError]);
  const versions = res?.data ?? [];

  if (error) return <ErrorBanner message={error} onDismiss={() => setError(null)} />;
  if (loading) return <p className="text-fg-subtle text-sm py-4">Loading...</p>;
  if (!versions.length) return <p className="text-fg-subtle text-sm py-4">No versions yet.</p>;

  return (
    <div className="border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-2.5">When</th>
            <th className="text-left px-4 py-2.5">Op</th>
            <th className="text-left px-4 py-2.5">Path</th>
            <th className="text-left px-4 py-2.5">Actor</th>
            <th className="text-left px-4 py-2.5">SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-t border-border">
              <td className="px-4 py-3 text-fg-muted">{new Date(v.created_at).toLocaleString()}</td>
              <td className="px-4 py-3 font-mono text-xs">{v.operation}{v.redacted && " · redacted"}</td>
              <td className="px-4 py-3 font-mono text-xs">{v.path ?? "—"}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg-muted">{v.actor.type}:{v.actor.id}</td>
              <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =================================================================
// Settings tab — info + archive + delete
// =================================================================

function SettingsPanel({ store, archived }: { store: MemoryStore; archived: boolean }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">Store ID</div>
        <code className="font-mono text-xs">{store.id}</code>
      </div>
      <div>
        <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">Mount path</div>
        <code className="font-mono text-xs">/mnt/memory/{store.name}/</code>
        <p className="text-fg-subtle text-xs mt-1">
          When this store is attached to a session, the agent reads/writes under this path with standard file tools.
        </p>
      </div>
      <div>
        <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">Created</div>
        <span>{new Date(store.created_at).toLocaleString()}</span>
      </div>
      {archived && (
        <div>
          <div className="text-fg-muted text-xs uppercase tracking-wider mb-1">Archived</div>
          <span>{new Date(store.archived_at!).toLocaleString()}</span>
          <p className="text-fg-subtle text-xs mt-1">Archived stores are read-only and cannot be attached to new sessions.</p>
        </div>
      )}
      <p className="text-fg-subtle text-xs pt-4 border-t border-border">
        To archive or delete this store, use the actions on the store list.
      </p>
    </div>
  );
}

// =================================================================
// Write memory dialog (create or first-write)
// =================================================================

function WriteMemoryDialog({
  storeId, existing, onClose, onSaved,
}: {
  storeId: string;
  existing: Memory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useApi();
  const [path, setPath] = useState(existing?.path ?? "/");
  const [content, setContent] = useState(existing?.content ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      const body: Record<string, unknown> = { path, content };
      if (!existing) body.precondition = { type: "not_exists" };
      await api(`/v1/memory_stores/${storeId}/memories`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New memory"
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Create
          </button>
        </>
      }
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <label htmlFor="new-memory-path" className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1">Path</label>
      <input
        id="new-memory-path"
        placeholder="/preferences/formatting.md"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        className="w-full font-mono border border-border rounded-lg px-3 py-2 text-sm mb-3 bg-bg text-fg outline-none focus:border-border-strong"
      />

      <label htmlFor="new-memory-content" className="block text-xs font-medium uppercase tracking-wider text-fg-muted mb-1">Content (max 100KB)</label>
      <textarea
        id="new-memory-content"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={14}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-fg font-mono outline-none focus:border-border-strong"
      />
    </Modal>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 mb-4 flex items-start justify-between gap-4">
      <p className="text-danger text-sm">{message}</p>
      <button onClick={onDismiss} className="inline-flex items-center min-h-11 sm:min-h-0 text-danger/70 hover:text-danger text-sm flex-shrink-0">Dismiss</button>
    </div>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
