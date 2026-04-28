import { useEffect, useState } from "react";
import { useApi } from "../lib/api";

interface MemoryStore { id: string; name: string; description?: string; created_at: string; archived_at?: string; }
interface Memory { id: string; store_id: string; path: string; content: string; size_bytes: number; created_at: string; }

export function MemoryStoresList() {
  const { api } = useApi();
  const [stores, setStores] = useState<MemoryStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Store detail
  const [selectedStore, setSelectedStore] = useState<MemoryStore | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memsLoading, setMemsLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Memory detail
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);

  // Write memory
  const [showWrite, setShowWrite] = useState(false);
  const [writePath, setWritePath] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setStores((await api<{ data: MemoryStore[] }>("/v1/memory_stores?limit=100")).data);
    } catch (e) {
      setError(errMsg(e));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

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

  const openStore = async (s: MemoryStore) => {
    setSelectedStore(s);
    setSelectedMemory(null);
    setMemsLoading(true);
    setDetailError(null);
    try {
      setMemories((await api<{ data: Memory[] }>(`/v1/memory_stores/${s.id}/memories`)).data);
    } catch (e) {
      setMemories([]);
      setDetailError(errMsg(e));
    }
    setMemsLoading(false);
  };

  const writeMemory = async () => {
    if (!selectedStore) return;
    setWriteError(null);
    try {
      await api(`/v1/memory_stores/${selectedStore.id}/memories`, {
        method: "POST",
        body: JSON.stringify({ path: writePath, content: writeContent }),
      });
      setShowWrite(false); setWritePath(""); setWriteContent("");
      openStore(selectedStore);
    } catch (e) {
      setWriteError(errMsg(e));
    }
  };

  const deleteStore = async (id: string) => {
    setDetailError(null);
    try {
      await api(`/v1/memory_stores/${id}`, { method: "DELETE" });
      setSelectedStore(null); setMemories([]); load();
    } catch (e) {
      setDetailError(errMsg(e));
    }
  };

  // Store detail view
  if (selectedStore) {
    return (
      <div className="flex-1 overflow-y-auto p-8 lg:p-10">
        <button onClick={() => { setSelectedStore(null); setSelectedMemory(null); }}
          className="mb-4 px-3 py-1.5 border border-border rounded-lg text-sm text-fg-muted hover:bg-bg-surface transition-colors">
          &larr; Back
        </button>
        <h2 className="font-display text-xl font-semibold tracking-tight">{selectedStore.name}</h2>
        {selectedStore.description && <p className="text-fg-muted mt-1">{selectedStore.description}</p>}
        <p className="text-fg-subtle text-xs font-mono mt-1">ID: {selectedStore.id}</p>

        <div className="flex gap-2 my-4">
          <button onClick={() => setShowWrite(true)}
            className="px-4 py-2 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">
            Write Memory
          </button>
          <button onClick={() => deleteStore(selectedStore.id)}
            className="px-4 py-2 bg-danger text-brand-fg rounded-lg text-sm font-medium hover:opacity-90 transition-colors">
            Delete Store
          </button>
        </div>

        {detailError && <ErrorBanner message={detailError} onDismiss={() => setDetailError(null)} />}

        {showWrite && (
          <div className="bg-bg-surface border border-border rounded-lg p-4 mb-4">
            <h3 className="font-semibold mb-3">Write Memory</h3>
            <input placeholder="Path (e.g. project/notes)" value={writePath} onChange={e => setWritePath(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-2 bg-bg text-fg outline-none focus:border-border-strong" />
            <textarea placeholder="Content" value={writeContent} onChange={e => setWriteContent(e.target.value)} rows={6}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-2 bg-bg text-fg font-mono outline-none focus:border-border-strong" />
            {writeError && <p className="text-danger text-sm mb-2">{writeError}</p>}
            <div className="flex gap-2">
              <button onClick={writeMemory} className="px-4 py-2 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">Save</button>
              <button onClick={() => { setShowWrite(false); setWriteError(null); }} className="px-4 py-2 border border-border rounded-lg text-sm text-fg-muted hover:bg-bg-surface transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {memsLoading ? <p className="text-fg-subtle text-sm py-4">Loading...</p> : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5">Path</th>
                  <th className="text-left px-4 py-2.5">Size</th>
                  <th className="text-left px-4 py-2.5">Created</th>
                </tr>
              </thead>
              <tbody>
                {memories.map(m => (
                  <tr
                    key={m.id}
                    onClick={async () => {
                      // Toggle: if this row is already open, close it; otherwise
                      // fetch the full memory (LIST endpoint strips `content` for
                      // payload size; per-row GET is the only way to get the body).
                      if (selectedMemory?.id === m.id) {
                        setSelectedMemory(null);
                        return;
                      }
                      // Render path immediately so the panel shows up; content
                      // fills in once the fetch lands.
                      setSelectedMemory(m);
                      try {
                        const full = await api<Memory>(
                          `/v1/memory_stores/${selectedStore!.id}/memories/${m.id}`,
                        );
                        setSelectedMemory(full);
                      } catch {
                        // Leave the metadata-only row; pre block will be empty
                        // until next click.
                      }
                    }}
                    className={`border-t border-border cursor-pointer hover:bg-bg-surface transition-colors ${selectedMemory?.id === m.id ? "bg-brand-subtle" : ""}`}>
                    <td className="px-4 py-3 font-mono text-xs">{m.path}</td>
                    <td className="px-4 py-3">{m.size_bytes} B</td>
                    <td className="px-4 py-3 text-fg-muted">{new Date(m.created_at).toLocaleString()}</td>
                  </tr>
                ))}
                {!memories.length && <tr><td colSpan={3} className="px-4 py-8 text-center text-fg-subtle">No memories yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {selectedMemory && (
          <div className="mt-4 bg-bg-surface border border-border rounded-lg p-4">
            <h3 className="font-mono text-sm font-semibold mb-2">{selectedMemory.path}</h3>
            <pre className="whitespace-pre-wrap bg-bg border border-border rounded-lg p-3 max-h-96 overflow-auto text-sm font-mono text-fg-muted">
              {selectedMemory.content}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">Memory Stores</h1>
          <p className="text-fg-muted text-sm">Manage persistent memory stores for your agents.</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">
          + New store
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {showCreate && (
        <div className="bg-bg-surface border border-border rounded-lg p-4 mb-4">
          <input placeholder="Store name" value={formName} onChange={e => setFormName(e.target.value)}
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
              </tr>
            </thead>
            <tbody>
              {stores.map(s => (
                <tr key={s.id} onClick={() => openStore(s)}
                  className="border-t border-border cursor-pointer hover:bg-bg-surface transition-colors">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{s.id}</td>
                  <td className="px-4 py-3 text-fg-muted">{new Date(s.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {!stores.length && <tr><td colSpan={3} className="px-4 py-8 text-center text-fg-subtle">No memory stores</td></tr>}
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
