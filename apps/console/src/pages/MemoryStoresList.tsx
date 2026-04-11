import { useEffect, useState } from "react";
import { useApi } from "../lib/api";

interface MemoryStore { id: string; name: string; description?: string; created_at: string; archived_at?: string; }
interface Memory { id: string; store_id: string; path: string; content: string; size_bytes: number; created_at: string; }

export function MemoryStoresList() {
  const { api } = useApi();
  const [stores, setStores] = useState<MemoryStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");

  // Store detail
  const [selectedStore, setSelectedStore] = useState<MemoryStore | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memsLoading, setMemsLoading] = useState(false);

  // Memory detail
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);

  // Write memory
  const [showWrite, setShowWrite] = useState(false);
  const [writePath, setWritePath] = useState("");
  const [writeContent, setWriteContent] = useState("");

  const load = async () => {
    setLoading(true);
    try { setStores((await api<{ data: MemoryStore[] }>("/v1/memory_stores?limit=100")).data); } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const createStore = async () => {
    await api("/v1/memory_stores", {
      method: "POST",
      body: JSON.stringify({ name: formName, description: formDesc || undefined }),
    });
    setShowCreate(false); setFormName(""); setFormDesc(""); load();
  };

  const openStore = async (s: MemoryStore) => {
    setSelectedStore(s);
    setSelectedMemory(null);
    setMemsLoading(true);
    try {
      setMemories((await api<{ data: Memory[] }>(`/v1/memory_stores/${s.id}/memories`)).data);
    } catch { setMemories([]); }
    setMemsLoading(false);
  };

  const writeMemory = async () => {
    if (!selectedStore) return;
    await api(`/v1/memory_stores/${selectedStore.id}/memories`, {
      method: "POST",
      body: JSON.stringify({ path: writePath, content: writeContent }),
    });
    setShowWrite(false); setWritePath(""); setWriteContent("");
    openStore(selectedStore);
  };

  const deleteStore = async (id: string) => {
    await api(`/v1/memory_stores/${id}`, { method: "DELETE" });
    setSelectedStore(null); setMemories([]); load();
  };

  // Back to list
  if (selectedStore) {
    return (
      <div>
        <button onClick={() => { setSelectedStore(null); setSelectedMemory(null); }}
          style={{ marginBottom: 16, cursor: "pointer", background: "none", border: "1px solid #666", padding: "4px 12px", borderRadius: 4, color: "#ccc" }}>
          &larr; Back
        </button>
        <h2>{selectedStore.name}</h2>
        {selectedStore.description && <p style={{ color: "#999" }}>{selectedStore.description}</p>}
        <p style={{ color: "#666", fontSize: 12 }}>ID: {selectedStore.id}</p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setShowWrite(true)}
            style={{ padding: "6px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
            Write Memory
          </button>
          <button onClick={() => deleteStore(selectedStore.id)}
            style={{ padding: "6px 16px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
            Delete Store
          </button>
        </div>

        {showWrite && (
          <div style={{ background: "#1e1e1e", padding: 16, borderRadius: 8, marginBottom: 16 }}>
            <h3>Write Memory</h3>
            <input placeholder="Path (e.g. project/notes)" value={writePath} onChange={e => setWritePath(e.target.value)}
              style={{ width: "100%", padding: 8, marginBottom: 8, background: "#2a2a2a", color: "#fff", border: "1px solid #444", borderRadius: 4 }} />
            <textarea placeholder="Content" value={writeContent} onChange={e => setWriteContent(e.target.value)} rows={6}
              style={{ width: "100%", padding: 8, marginBottom: 8, background: "#2a2a2a", color: "#fff", border: "1px solid #444", borderRadius: 4, fontFamily: "monospace" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={writeMemory} style={{ padding: "6px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Save</button>
              <button onClick={() => setShowWrite(false)} style={{ padding: "6px 16px", background: "#444", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        )}

        {memsLoading ? <p>Loading...</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333" }}>
                <th style={{ textAlign: "left", padding: 8 }}>Path</th>
                <th style={{ textAlign: "left", padding: 8 }}>Size</th>
                <th style={{ textAlign: "left", padding: 8 }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {memories.map(m => (
                <tr key={m.id} onClick={() => setSelectedMemory(selectedMemory?.id === m.id ? null : m)}
                  style={{ borderBottom: "1px solid #222", cursor: "pointer", background: selectedMemory?.id === m.id ? "#1a1a2e" : "transparent" }}>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>{m.path}</td>
                  <td style={{ padding: 8 }}>{m.size_bytes} B</td>
                  <td style={{ padding: 8, color: "#999" }}>{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {!memories.length && <tr><td colSpan={3} style={{ padding: 16, textAlign: "center", color: "#666" }}>No memories yet</td></tr>}
            </tbody>
          </table>
        )}

        {selectedMemory && (
          <div style={{ marginTop: 16, background: "#1e1e1e", padding: 16, borderRadius: 8 }}>
            <h3 style={{ fontFamily: "monospace" }}>{selectedMemory.path}</h3>
            <pre style={{ whiteSpace: "pre-wrap", background: "#0d0d0d", padding: 12, borderRadius: 4, maxHeight: 400, overflow: "auto" }}>
              {selectedMemory.content}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1>Memory Stores</h1>
        <button onClick={() => setShowCreate(true)}
          style={{ padding: "8px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>
          Create Store
        </button>
      </div>

      {showCreate && (
        <div style={{ background: "#1e1e1e", padding: 16, borderRadius: 8, marginBottom: 16 }}>
          <input placeholder="Store name" value={formName} onChange={e => setFormName(e.target.value)}
            style={{ width: "100%", padding: 8, marginBottom: 8, background: "#2a2a2a", color: "#fff", border: "1px solid #444", borderRadius: 4 }} />
          <input placeholder="Description (optional)" value={formDesc} onChange={e => setFormDesc(e.target.value)}
            style={{ width: "100%", padding: 8, marginBottom: 8, background: "#2a2a2a", color: "#fff", border: "1px solid #444", borderRadius: 4 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={createStore} style={{ padding: "6px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Create</button>
            <button onClick={() => setShowCreate(false)} style={{ padding: "6px 16px", background: "#444", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? <p>Loading...</p> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #333" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Name</th>
              <th style={{ textAlign: "left", padding: 8 }}>ID</th>
              <th style={{ textAlign: "left", padding: 8 }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {stores.map(s => (
              <tr key={s.id} onClick={() => openStore(s)}
                style={{ borderBottom: "1px solid #222", cursor: "pointer" }}>
                <td style={{ padding: 8 }}>{s.name}</td>
                <td style={{ padding: 8, fontFamily: "monospace", color: "#999", fontSize: 12 }}>{s.id}</td>
                <td style={{ padding: 8, color: "#999" }}>{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {!stores.length && <tr><td colSpan={3} style={{ padding: 16, textAlign: "center", color: "#666" }}>No memory stores</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}
