import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { ListPage } from "../components/ListPage";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export function ApiKeysList() {
  const { api } = useApi();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      setKeys((await api<{ data: ApiKey[] }>("/v1/api_keys")).data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // useAsyncAction guards re-entry: a fast double-click on the Create
  // button used to fire two POSTs and produce two records 0.5-1s apart.
  // The hook + Button loading prop handle this universally now.
  const create = useAsyncAction(async () => {
    setError("");
    try {
      const result = await api<{ key: string }>("/v1/api_keys", {
        method: "POST",
        body: JSON.stringify({ name: name || "Untitled key" }),
      });
      setCreatedKey(result.key);
      setName("");
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to create key");
    }
  });

  const remove = async (id: string) => {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    try {
      await api(`/v1/api_keys/${id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  const closeDialog = () => {
    setShowCreate(false);
    setCreatedKey("");
    setName("");
    setError("");
  };

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  return (
    <ListPage<ApiKey>
      title="API Keys"
      subtitle="Manage API keys for programmatic access (CLI, SDK)."
      createLabel="+ New API key"
      onCreate={() => setShowCreate(true)}
      data={keys}
      loading={loading}
      getRowKey={(k) => k.id}
      emptyTitle="No API keys yet"
      emptySubtitle="Create an API key to access the platform from CLI or SDK."
      columns={[
        {
          key: "name",
          label: "Name",
          render: (k) => (
            <>
              <div className="font-medium text-fg">{k.name}</div>
              <div className="text-xs text-fg-subtle font-mono">{k.id}</div>
            </>
          ),
        },
        {
          key: "key",
          label: "Key",
          className: "font-mono text-xs text-fg-muted",
          render: (k) => `${k.prefix}...`,
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted text-xs",
          render: (k) => new Date(k.created_at).toLocaleDateString(),
        },
        {
          key: "actions",
          label: "Actions",
          className: "text-right",
          render: (k) => (
            <button
              onClick={() => remove(k.id)}
              className="text-xs text-fg-subtle hover:text-danger"
            >
              Revoke
            </button>
          ),
        },
      ]}
    >
      <Modal
        open={showCreate}
        onClose={closeDialog}
        title={createdKey ? "API Key Created" : "New API Key"}
        footer={
          createdKey ? (
            <Button onClick={closeDialog}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={create.loading}>
                Cancel
              </Button>
              <Button onClick={create.run} loading={create.loading} loadingLabel="Creating…">
                Create
              </Button>
            </>
          )
        }
      >
        {createdKey ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              Copy this key now. You won't be able to see it again.
            </p>
            <div className="bg-bg-surface border border-border rounded-lg p-3">
              <code className="text-sm font-mono text-fg break-all select-all">
                {createdKey}
              </code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(createdKey)}
              className="text-sm text-brand hover:underline"
            >
              Copy to clipboard
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="api-key-name" className="text-sm text-fg-muted block mb-1">
                Name (optional)
              </label>
              <input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. CLI key, CI/CD"
              />
            </div>
          </div>
        )}
      </Modal>
    </ListPage>
  );
}
