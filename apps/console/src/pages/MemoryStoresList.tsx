import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../lib/api";

interface MemoryStore {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  archived_at?: string;
}

export function MemoryStoresList() {
  const { api } = useApi();
  const [stores, setStores] = useState<MemoryStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/v1/memory_stores?include_archived=${includeArchived}`;
      setStores((await api<{ data: MemoryStore[] }>(url)).data);
    } catch (e) {
      setError(errMsg(e));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [includeArchived]);

  const createStore = async () => {
    setFormError(null);
    try {
      await api("/v1/memory_stores", {
        method: "POST",
        body: JSON.stringify({ name: formName, description: formDesc || undefined }),
      });
      setShowCreate(false); setFormName(""); setFormDesc(""); load();
    } catch (e) {
      setFormError(errMsg(e));
    }
  };

  const archiveStore = async (id: string) => {
    if (!confirm("Archive this store? It will become read-only and no new sessions can attach it. Archive is one-way.")) return;
    try {
      await api(`/v1/memory_stores/${id}/archive`, { method: "POST" });
      load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const deleteStore = async (id: string) => {
    if (!confirm("Delete this store and ALL its memories + version history? This cannot be undone.")) return;
    try {
      await api(`/v1/memory_stores/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Memory Stores</h1>
          <p className="text-fg-muted text-sm">
            Persistent memory for agents. Each store is mounted into a session at <code className="text-xs">/mnt/memory/&lt;name&gt;/</code>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="accent-brand"
            />
            Show archived
          </label>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">
            + New store
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {showCreate && (
        <div className="bg-bg-surface border border-border rounded-lg p-4 mb-4">
          <input placeholder="Store name (e.g. User Preferences)" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-2 bg-bg text-fg outline-none focus:border-border-strong" />
          <input placeholder="Description (optional)" value={formDesc} onChange={e => setFormDesc(e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-2 bg-bg text-fg outline-none focus:border-border-strong" />
          {formError && <p className="text-danger text-sm mb-2">{formError}</p>}
          <div className="flex gap-2">
            <button onClick={createStore} className="px-4 py-2 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">Create</button>
            <button onClick={() => { setShowCreate(false); setFormError(null); }} className="px-4 py-2 border border-border rounded-lg text-sm text-fg-muted hover:bg-bg-surface transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {loading ? <p className="text-fg-subtle text-sm py-8 text-center">Loading...</p> : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">ID</th>
                <th className="text-left px-4 py-2.5">Created</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {stores.map(s => (
                <tr key={s.id} className="border-t border-border hover:bg-bg-surface transition-colors">
                  <td className="px-4 py-3 font-medium">
                    <Link to={`/memory/${s.id}`} className="text-brand hover:underline">{s.name}</Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{s.id}</td>
                  <td className="px-4 py-3 text-fg-muted">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-fg-muted">
                    {s.archived_at
                      ? <span className="text-xs px-2 py-0.5 rounded-full bg-bg-surface border border-border">Archived</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full bg-brand/10 border border-brand/30 text-brand">Live</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!s.archived_at && (
                      <button onClick={() => archiveStore(s.id)}
                        className="text-xs text-fg-muted hover:text-fg mr-3">
                        Archive
                      </button>
                    )}
                    <button onClick={() => deleteStore(s.id)}
                      className="text-xs text-danger hover:text-danger/80">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!stores.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-fg-subtle">No memory stores</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="bg-danger/10 border border-danger/30 rounded-lg px-4 py-3 mb-4 flex items-start justify-between gap-4">
      <p className="text-danger text-sm">{message}</p>
      <button onClick={onDismiss} className="text-danger/70 hover:text-danger text-sm flex-shrink-0">Dismiss</button>
    </div>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
