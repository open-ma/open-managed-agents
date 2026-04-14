import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface Vault { id: string; name: string; created_at: string; archived_at?: string; }
interface Credential {
  id: string; display_name: string; vault_id: string;
  auth: { type: string; mcp_server_url?: string; command_prefixes?: string[]; env_var?: string };
  created_at: string; archived_at?: string;
}

type CredType = "static_bearer" | "mcp_oauth" | "command_secret";

export function VaultsList() {
  const { api } = useApi();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");

  const [selectedVault, setSelectedVault] = useState<Vault | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credsLoading, setCredsLoading] = useState(false);

  const [showCreateCred, setShowCreateCred] = useState(false);
  const [credForm, setCredForm] = useState({
    display_name: "", type: "static_bearer" as CredType,
    mcp_server_url: "", token: "", command_prefixes: "", env_var: "",
  });

  const load = async () => {
    setLoading(true);
    try { setVaults((await api<{ data: Vault[] }>("/v1/vaults?limit=100")).data); } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const createVault = async () => {
    await api("/v1/vaults", { method: "POST", body: JSON.stringify({ name: vaultName }) });
    setShowCreateVault(false); setVaultName(""); load();
  };

  const openVault = async (v: Vault) => {
    setSelectedVault(v);
    setCredsLoading(true);
    try {
      setCredentials((await api<{ data: Credential[] }>(`/v1/vaults/${v.id}/credentials`)).data);
    } catch { setCredentials([]); }
    setCredsLoading(false);
  };

  const createCred = async () => {
    if (!selectedVault) return;
    const auth: Record<string, unknown> = { type: credForm.type };
    if (credForm.type === "command_secret") {
      auth.command_prefixes = credForm.command_prefixes.split(",").map(s => s.trim()).filter(Boolean);
      auth.env_var = credForm.env_var;
      auth.token = credForm.token;
    } else {
      auth.mcp_server_url = credForm.mcp_server_url;
      auth.token = credForm.token;
    }
    await api(`/v1/vaults/${selectedVault.id}/credentials`, {
      method: "POST", body: JSON.stringify({ display_name: credForm.display_name, auth }),
    });
    setShowCreateCred(false);
    setCredForm({ display_name: "", type: "static_bearer", mcp_server_url: "", token: "", command_prefixes: "", env_var: "" });
    openVault(selectedVault);
  };

  const deleteCred = async (credId: string) => {
    if (!selectedVault || !confirm("Delete this credential?")) return;
    await api(`/v1/vaults/${selectedVault.id}/credentials/${credId}`, { method: "DELETE" });
    openVault(selectedVault);
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  const credTypeBadge = (type: string) => {
    switch (type) {
      case "command_secret": return "bg-brand-subtle text-brand";
      case "mcp_oauth": return "bg-info-subtle text-info";
      default: return "bg-success-subtle text-success";
    }
  };

  const [vaultTab, setVaultTab] = useState<"all" | "active">("all");

  const displayedVaults = vaultTab === "active" ? vaults.filter((v) => !v.archived_at) : vaults;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Credential Vaults</h1>
          <p className="text-fg-muted text-sm">Manage credentials for MCP servers and CLI tools.</p>
        </div>
        <Button onClick={() => setShowCreateVault(true)}>+ New vault</Button>
      </div>

      <div className="flex gap-1 mb-4">
        {(["all", "active"] as const).map((t) => (
          <button key={t} onClick={() => setVaultTab(t)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${vaultTab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"}`}>
            {t === "all" ? "All" : "Active"}
          </button>
        ))}
      </div>

      {loading ? <div className="text-fg-subtle text-sm py-8 text-center">Loading...</div> : displayedVaults.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle"><p className="text-lg mb-1">No vaults yet</p></div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-bg-surface text-fg-subtle text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-2.5">Name</th>
              <th className="text-left px-4 py-2.5">ID</th>
              <th className="text-left px-4 py-2.5">Created</th>
            </tr></thead>
            <tbody>{displayedVaults.map((v) => (
              <tr key={v.id} onClick={() => openVault(v)} className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors">
                <td className="px-4 py-3 font-medium text-fg">{v.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-fg-muted">{v.id}</td>
                <td className="px-4 py-3 text-fg-muted">{new Date(v.created_at).toLocaleDateString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* Create Vault */}
      <Modal open={showCreateVault} onClose={() => setShowCreateVault(false)} title="New Vault"
        footer={<><Button variant="ghost" onClick={() => setShowCreateVault(false)}>Cancel</Button><Button onClick={createVault} disabled={!vaultName}>Create</Button></>}>
        <div className="space-y-4">
          <div className="bg-warning-subtle border border-warning/30 rounded-lg px-4 py-3 text-sm text-warning">
            Vaults are shared across this workspace. Credentials added to this vault will be usable by anyone with API key access.
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name</label>
            <input value={vaultName} onChange={(e) => setVaultName(e.target.value.slice(0, 30))} className={inputCls} placeholder="My Vault" />
            <p className="text-xs text-fg-subtle mt-1">{vaultName.length}/30 characters</p>
          </div>
        </div>
      </Modal>

      {/* Vault Detail */}
      <Modal open={!!selectedVault} onClose={() => setSelectedVault(null)} title={selectedVault?.name || ""} subtitle={selectedVault?.id} maxWidth="max-w-2xl"
        footer={<><Button variant="secondary" size="sm" onClick={() => setShowCreateCred(true)}>+ Add credential</Button><Button variant="ghost" onClick={() => setSelectedVault(null)}>Close</Button></>}>
        {credsLoading ? <div className="text-fg-subtle text-sm py-4 text-center">Loading...</div> :
          credentials.length === 0 ? <div className="text-center py-8 text-fg-subtle text-sm">No credentials yet</div> : (
          <div className="space-y-3">
            {credentials.map((c) => (
              <div key={c.id} className="border border-border rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium text-sm text-fg">{c.display_name}</div>
                    <div className="text-xs text-fg-subtle font-mono mt-0.5">{c.id}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${credTypeBadge(c.auth.type)}`}>{c.auth.type}</span>
                    <button onClick={() => deleteCred(c.id)} className="text-xs text-fg-subtle hover:text-danger transition-colors">Delete</button>
                  </div>
                </div>
                <div className="mt-2 text-xs text-fg-muted">
                  {c.auth.mcp_server_url && <div>MCP Server: <span className="font-mono">{c.auth.mcp_server_url}</span></div>}
                  {c.auth.command_prefixes && <div>Commands: <span className="font-mono">{c.auth.command_prefixes.join(", ")}</span></div>}
                  {c.auth.env_var && <div>Env var: <span className="font-mono">{c.auth.env_var}</span></div>}
                  <div className="mt-1 text-fg-subtle">Token: ••••••••</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Create Credential */}
      <Modal open={showCreateCred && !!selectedVault} onClose={() => setShowCreateCred(false)} title="New Credential"
        footer={<><Button variant="ghost" onClick={() => setShowCreateCred(false)}>Cancel</Button><Button onClick={createCred} disabled={!credForm.display_name || !credForm.token}>Create</Button></>}>
        <div className="space-y-3">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Display Name</label>
            <input value={credForm.display_name} onChange={(e) => setCredForm({ ...credForm, display_name: e.target.value })} className={inputCls} placeholder="GitHub Token" />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Type</label>
            <select value={credForm.type} onChange={(e) => setCredForm({ ...credForm, type: e.target.value as CredType })} className={inputCls}>
              <option value="static_bearer">Static Bearer (MCP server)</option>
              <option value="mcp_oauth">OAuth (MCP server)</option>
              <option value="command_secret">Command Secret (CLI tools)</option>
            </select>
          </div>
          {credForm.type !== "command_secret" && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">MCP Server URL</label>
              <input value={credForm.mcp_server_url} onChange={(e) => setCredForm({ ...credForm, mcp_server_url: e.target.value })} className={inputCls} placeholder="https://mcp.slack.com/mcp" />
            </div>
          )}
          {credForm.type === "command_secret" && (
            <>
              <div>
                <label className="text-sm text-fg-muted block mb-1">Command Prefixes <span className="text-fg-subtle">(comma-separated)</span></label>
                <input value={credForm.command_prefixes} onChange={(e) => setCredForm({ ...credForm, command_prefixes: e.target.value })} className={inputCls} placeholder="wrangler, npx wrangler" />
              </div>
              <div>
                <label className="text-sm text-fg-muted block mb-1">Environment Variable Name</label>
                <input value={credForm.env_var} onChange={(e) => setCredForm({ ...credForm, env_var: e.target.value })} className={inputCls} placeholder="CLOUDFLARE_API_TOKEN" />
              </div>
            </>
          )}
          <div>
            <label className="text-sm text-fg-muted block mb-1">Token / Secret <span className="text-fg-subtle">(write-only)</span></label>
            <input type="password" value={credForm.token} onChange={(e) => setCredForm({ ...credForm, token: e.target.value })} className={inputCls} placeholder="••••••••" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
