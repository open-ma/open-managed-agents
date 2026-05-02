import { useState } from "react";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface Env { id: string; name: string; config: Record<string, unknown>; created_at: string; archived_at?: string; status?: string; }

export function EnvironmentsList() {
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const [tab, setTab] = useState<"all" | "active">("all");
  const [form, setForm] = useState({ name: "", description: "" });

  const {
    items: envs,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: load,
  } = useCursorList<Env>("/v1/environments", { limit: 50 });

  const create = async () => {
    await api("/v1/environments", {
      method: "POST",
      body: JSON.stringify({ name: form.name, config: { type: "cloud" }, description: form.description || undefined }),
    });
    setShowCreate(false); setForm({ name: "", description: "" }); load();
  };

  const displayed = tab === "active" ? envs.filter((e) => !e.archived_at) : envs;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Environments</h1>
          <p className="text-fg-muted text-sm">Configure sandbox environments for agent sessions.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ Add environment</Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(["all", "active"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"}`}>
            {t === "all" ? "All" : "Active"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg></div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">No environments yet</p>
          <p className="text-sm">Create your first environment to get started.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
              <th className="text-left px-4 py-2.5">ID</th>
              <th className="text-left px-4 py-2.5">Name</th>
              <th className="text-left px-4 py-2.5">Type</th>
              <th className="text-left px-4 py-2.5">Created</th>
            </tr></thead>
            <tbody>{displayed.map((e) => (
              <tr key={e.id} className="border-t border-border hover:bg-bg-surface transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-fg-muted truncate max-w-[180px]" title={e.id}>{e.id}</td>
                <td className="px-4 py-3 font-medium text-fg">{e.name}</td>
                <td className="px-4 py-3 text-fg-muted">{(e.config as Record<string, unknown>)?.type as string || "cloud"}</td>
                <td className="px-4 py-3 text-fg-muted">{new Date(e.created_at).toLocaleDateString()}</td>
              </tr>
            ))}</tbody>
          </table>
          {hasMore && (
            <div className="flex justify-center border-t border-border bg-bg-surface py-3">
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="text-sm text-fg-muted hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Add Environment"
        subtitle="Environments provide isolated sandboxes for code execution."
        footer={<><Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button><Button onClick={create} disabled={!form.name}>Create</Button></>}>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 50) })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg transition-colors placeholder:text-fg-subtle"
              placeholder="production" />
            <p className="text-xs text-fg-subtle mt-1">{form.name.length}/50 characters</p>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Hosting Type</label>
            <select disabled className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none opacity-70">
              <option>Cloud</option>
            </select>
            <p className="text-xs text-fg-subtle mt-1">This cannot be changed after creation.</p>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Description <span className="text-fg-subtle">(optional)</span></label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg resize-none transition-colors placeholder:text-fg-subtle"
              placeholder="Production environment for customer-facing agents..." />
          </div>
        </div>
      </Modal>
    </div>
  );
}
