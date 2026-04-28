import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

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
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">
            API Keys
          </h1>
          <p className="text-fg-muted text-sm">
            Manage API keys for programmatic access (CLI, SDK).
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>+ New API key</Button>
      </div>

      {loading ? (
        <div className="text-fg-subtle text-sm py-8 text-center">
          Loading...
        </div>
      ) : keys.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">No API keys yet</p>
          <p className="text-sm">
            Create an API key to access the platform from CLI or SDK.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Key</th>
                <th className="text-left px-4 py-2.5">Created</th>
                <th className="text-right px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  className="border-t border-border hover:bg-bg-surface transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-fg">{k.name}</div>
                    <div className="text-xs text-fg-subtle font-mono">
                      {k.id}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                    {k.prefix}...
                  </td>
                  <td className="px-4 py-3 text-fg-muted text-xs">
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(k.id)}
                      className="text-xs text-fg-subtle hover:text-danger"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
              <label className="text-sm text-fg-muted block mb-1">
                Name (optional)
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. CLI key, CI/CD"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
