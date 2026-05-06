import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../lib/api";
import { ListPage } from "../components/ListPage";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

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
  const [includeArchived, setIncludeArchived] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const url = `/v1/memory_stores?include_archived=${includeArchived}`;
      setStores((await api<{ data: MemoryStore[] }>(url)).data);
    } catch (e) {
      // Match other list pages: silent failure on initial fetch — empty
      // list communicates the same thing as a banner without the chrome.
      void e;
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [includeArchived]);

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
      alert(errMsg(e));
    }
  };

  const deleteStore = async (id: string) => {
    if (!confirm("Delete this store and ALL its memories + version history? This cannot be undone.")) return;
    try {
      await api(`/v1/memory_stores/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  return (
    <ListPage<MemoryStore>
      title="Memory Stores"
      subtitle={
        <>
          Persistent memory for agents. Each store is mounted into a session at <code className="text-xs">/mnt/memory/&lt;name&gt;/</code>.
        </>
      }
      createLabel="+ New store"
      onCreate={() => { setShowCreate(true); setFormError(null); }}
      showArchived={includeArchived}
      onShowArchivedChange={setIncludeArchived}
      data={stores}
      loading={loading}
      getRowKey={(s) => s.id}
      emptyTitle="No memory stores"
      columns={[
        {
          key: "name",
          label: "Name",
          className: "font-medium",
          render: (s) => (
            <Link to={`/memory/${s.id}`} className="text-brand hover:underline">{s.name}</Link>
          ),
        },
        { key: "id", label: "ID", className: "font-mono text-xs text-fg-muted" },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (s) => new Date(s.created_at).toLocaleString(),
        },
        {
          key: "status",
          label: "Status",
          className: "text-fg-muted",
          render: (s) => s.archived_at
            ? <span className="text-xs px-2 py-0.5 rounded-full bg-bg-surface border border-border">Archived</span>
            : <span className="text-xs px-2 py-0.5 rounded-full bg-brand/10 border border-brand/30 text-brand">Live</span>,
        },
        {
          key: "actions",
          label: "",
          className: "text-right",
          render: (s) => (
            <>
              {!s.archived_at && (
                <button onClick={() => archiveStore(s.id)} className="text-xs text-fg-muted hover:text-fg mr-3">
                  Archive
                </button>
              )}
              <button onClick={() => deleteStore(s.id)} className="text-xs text-danger hover:text-danger/80">
                Delete
              </button>
            </>
          ),
        },
      ]}
    >
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setFormError(null); }}
        title="New Memory Store"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setShowCreate(false); setFormError(null); }}>
              Cancel
            </Button>
            <Button onClick={createStore} disabled={!formName}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name</label>
            <input
              placeholder="e.g. User Preferences"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Description <span className="text-fg-subtle">(optional)</span>
            </label>
            <input
              placeholder="What's stored here?"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
