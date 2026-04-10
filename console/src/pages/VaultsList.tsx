import { useEffect, useState } from "react";
import { useApi } from "../lib/api";

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

  // Vault detail
  const [selectedVault, setSelectedVault] = useState<Vault | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credsLoading, setCredsLoading] = useState(false);

  // Create credential
  const [showCreateCred, setShowCreateCred] = useState(false);
  const [credForm, setCredForm] = useState({
    display_name: "",
    type: "static_bearer" as CredType,
    mcp_server_url: "",
    token: "",
    command_prefixes: "",
    env_var: "",
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
      method: "POST",
      body: JSON.stringify({ display_name: credForm.display_name, auth }),
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

  const inputCls = "w-full border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-stone-400 transition-colors";

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Credential Vaults</h1>
          <p className="text-stone-500 text-sm">Manage credentials for MCP servers and CLI tools.</p>
        </div>
        <button onClick={() => setShowCreateVault(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors">+ New vault</button>
      </div>

      {loading ? <div className="text-stone-400 text-sm py-8 text-center">Loading...</div> : vaults.length === 0 ? (
        <div className="text-center py-16 text-stone-400"><p className="text-lg mb-1">No vaults yet</p></div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-stone-100/60 text-stone-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-2.5">Name</th>
              <th className="text-left px-4 py-2.5">ID</th>
              <th className="text-left px-4 py-2.5">Created</th>
            </tr></thead>
            <tbody>{vaults.map((v) => (
              <tr key={v.id} onClick={() => openVault(v)} className="border-t border-stone-100 hover:bg-stone-50 cursor-pointer transition-colors">
                <td className="px-4 py-3 font-medium">{v.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-stone-500">{v.id}</td>
                <td className="px-4 py-3 text-stone-500">{new Date(v.created_at).toLocaleDateString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* Create Vault Dialog */}
      {showCreateVault && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreateVault(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold mb-4">New Vault</h2>
            <label className="text-sm text-stone-600 block mb-1">Name</label>
            <input value={vaultName} onChange={(e) => setVaultName(e.target.value)} className={inputCls} placeholder="My Vault" />
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreateVault(false)} className="px-4 py-2 text-sm text-stone-600">Cancel</button>
              <button onClick={createVault} disabled={!vaultName} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Vault Detail Dialog */}
      {selectedVault && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setSelectedVault(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-4 border-b border-stone-100 flex items-start justify-between">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">{selectedVault.name}</h2>
                <p className="text-xs text-stone-400 font-mono mt-0.5">{selectedVault.id}</p>
              </div>
              <button onClick={() => setShowCreateCred(true)} className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-800 transition-colors">+ Add credential</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {credsLoading ? <div className="text-stone-400 text-sm py-4 text-center">Loading...</div> :
                credentials.length === 0 ? <div className="text-center py-8 text-stone-400 text-sm">No credentials yet</div> : (
                <div className="space-y-3">
                  {credentials.map((c) => (
                    <div key={c.id} className="border border-stone-200 rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="font-medium text-sm">{c.display_name}</div>
                          <div className="text-xs text-stone-400 font-mono mt-0.5">{c.id}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            c.auth.type === "command_secret" ? "bg-purple-50 text-purple-700" :
                            c.auth.type === "mcp_oauth" ? "bg-blue-50 text-blue-700" :
                            "bg-green-50 text-green-700"
                          }`}>{c.auth.type}</span>
                          <button onClick={() => deleteCred(c.id)} className="text-xs text-stone-400 hover:text-red-500 transition-colors">Delete</button>
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-stone-500">
                        {c.auth.mcp_server_url && <div>MCP Server: <span className="font-mono">{c.auth.mcp_server_url}</span></div>}
                        {c.auth.command_prefixes && <div>Commands: <span className="font-mono">{c.auth.command_prefixes.join(", ")}</span></div>}
                        {c.auth.env_var && <div>Env var: <span className="font-mono">{c.auth.env_var}</span></div>}
                        <div className="mt-1 text-stone-400">Token: ••••••••</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-stone-100 flex justify-end">
              <button onClick={() => setSelectedVault(null)} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Create Credential Dialog */}
      {showCreateCred && selectedVault && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreateCred(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold mb-4">New Credential</h2>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-stone-600 block mb-1">Display Name</label>
                <input value={credForm.display_name} onChange={(e) => setCredForm({ ...credForm, display_name: e.target.value })} className={inputCls} placeholder="GitHub Token" />
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Type</label>
                <select value={credForm.type} onChange={(e) => setCredForm({ ...credForm, type: e.target.value as CredType })} className={inputCls}>
                  <option value="static_bearer">Static Bearer (MCP server)</option>
                  <option value="mcp_oauth">OAuth (MCP server)</option>
                  <option value="command_secret">Command Secret (CLI tools)</option>
                </select>
              </div>

              {credForm.type !== "command_secret" && (
                <div>
                  <label className="text-sm text-stone-600 block mb-1">MCP Server URL</label>
                  <input value={credForm.mcp_server_url} onChange={(e) => setCredForm({ ...credForm, mcp_server_url: e.target.value })} className={inputCls} placeholder="https://mcp.slack.com/mcp" />
                </div>
              )}

              {credForm.type === "command_secret" && (
                <>
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">Command Prefixes <span className="text-stone-400">(comma-separated)</span></label>
                    <input value={credForm.command_prefixes} onChange={(e) => setCredForm({ ...credForm, command_prefixes: e.target.value })} className={inputCls} placeholder="wrangler, npx wrangler" />
                  </div>
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">Environment Variable Name</label>
                    <input value={credForm.env_var} onChange={(e) => setCredForm({ ...credForm, env_var: e.target.value })} className={inputCls} placeholder="CLOUDFLARE_API_TOKEN" />
                  </div>
                </>
              )}

              <div>
                <label className="text-sm text-stone-600 block mb-1">Token / Secret <span className="text-stone-400">(write-only, never returned)</span></label>
                <input type="password" value={credForm.token} onChange={(e) => setCredForm({ ...credForm, token: e.target.value })} className={inputCls} placeholder="••••••••" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreateCred(false)} className="px-4 py-2 text-sm text-stone-600">Cancel</button>
              <button onClick={createCred} disabled={!credForm.display_name || !credForm.token} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
