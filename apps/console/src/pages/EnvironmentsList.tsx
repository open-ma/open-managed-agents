import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { Select, SelectOption } from "../components/Select";
import { ListPage } from "../components/ListPage";

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

  const tabs = (
    <div className="flex gap-1">
      {(["all", "active"] as const).map((t) => (
        <button
          key={t}
          onClick={() => setTab(t)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
          }`}
        >
          {t === "all" ? "All" : "Active"}
        </button>
      ))}
    </div>
  );

  return (
    <ListPage<Env>
      title="Environments"
      subtitle="Configure sandbox environments for agent sessions."
      createLabel="+ Add environment"
      onCreate={() => setShowCreate(true)}
      filters={tabs}
      data={displayed}
      loading={loading}
      getRowKey={(e) => e.id}
      hasMore={hasMore}
      onLoadMore={loadMore}
      loadingMore={isLoadingMore}
      emptyTitle="No environments yet"
      emptySubtitle="Create your first environment to get started."
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[180px]",
          render: (e) => <span title={e.id}>{e.id}</span>,
        },
        {
          key: "name",
          label: "Name",
          className: "font-medium",
          render: (e) => (
            <Link to={`/environments/${e.id}`} className="text-brand hover:underline">
              {e.name}
            </Link>
          ),
        },
        {
          key: "type",
          label: "Type",
          className: "text-fg-muted",
          render: (e) => (e.config?.type as string) || "cloud",
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (e) => new Date(e.created_at).toLocaleDateString(),
        },
      ]}
    >
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Environment"
        subtitle="Environments provide isolated sandboxes for code execution."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 50) })}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg transition-colors placeholder:text-fg-subtle"
              placeholder="production"
            />
            <p className="text-xs text-fg-subtle mt-1">{form.name.length}/50 characters</p>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Hosting Type</label>
            <Select value="cloud" onValueChange={() => {}} disabled>
              <SelectOption value="cloud">Cloud</SelectOption>
            </Select>
            <p className="text-xs text-fg-subtle mt-1">This cannot be changed after creation.</p>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Description <span className="text-fg-subtle">(optional)</span></label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg resize-none transition-colors placeholder:text-fg-subtle"
              placeholder="Production environment for customer-facing agents..."
            />
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}
