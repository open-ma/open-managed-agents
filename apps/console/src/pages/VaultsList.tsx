import { useEffect, useState, useCallback } from "react";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { ListPage } from "../components/ListPage";
import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";

interface Vault { id: string; name: string; created_at: string; archived_at?: string; }
interface Credential {
  id: string; display_name: string; vault_id: string;
  auth: { type: string; mcp_server_url?: string; command_prefixes?: string[]; env_var?: string };
  created_at: string; archived_at?: string;
}

export function VaultsList() {
  const { api } = useApi();
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");

  const [selectedVault, setSelectedVault] = useState<Vault | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [credsLoading, setCredsLoading] = useState(false);

  const [showAddCred, setShowAddCred] = useState(false);
  const [mcpSearch, setMcpSearch] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);

  // Manual credential form (for command_secret type)
  const [showManualCred, setShowManualCred] = useState(false);
  const [manualForm, setManualForm] = useState({
    display_name: "", token: "", command_prefixes: "", env_var: "",
  });

  const {
    items: vaults,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: load,
  } = useCursorList<Vault>("/v1/vaults", { limit: 50 });

  // Listen for OAuth popup completion
  const handleOAuthMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === "oauth_complete" && selectedVault) {
      setConnecting(null);
      setShowAddCred(false);
      openVault(selectedVault);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVault]);

  useEffect(() => {
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [handleOAuthMessage]);

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

  const connectMcp = (entry: McpRegistryEntry | { name: string; url: string }) => {
    if (!selectedVault) return;
    setConnecting(entry.name);
    const authUrl = `/v1/oauth/authorize?mcp_server_url=${encodeURIComponent(entry.url)}&vault_id=${encodeURIComponent(selectedVault.id)}&redirect_uri=${encodeURIComponent(window.location.href)}`;
    window.open(authUrl, "oauth", "width=600,height=700,popup=yes");
  };

  const createManualCred = async () => {
    if (!selectedVault) return;
    await api(`/v1/vaults/${selectedVault.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        display_name: manualForm.display_name,
        auth: {
          type: "command_secret",
          command_prefixes: manualForm.command_prefixes.split(",").map(s => s.trim()).filter(Boolean),
          env_var: manualForm.env_var,
          token: manualForm.token,
        },
      }),
    });
    setShowManualCred(false);
    setManualForm({ display_name: "", token: "", command_prefixes: "", env_var: "" });
    openVault(selectedVault);
  };

  const deleteCred = async (credId: string) => {
    if (!selectedVault || !confirm("Delete this credential?")) return;
    await api(`/v1/vaults/${selectedVault.id}/credentials/${credId}`, { method: "DELETE" });
    openVault(selectedVault);
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  // Filter registry by search
  const filteredRegistry = mcpSearch
    ? MCP_REGISTRY.filter(
        (e) =>
          e.name.toLowerCase().includes(mcpSearch.toLowerCase()) ||
          e.url.toLowerCase().includes(mcpSearch.toLowerCase()),
      )
    : MCP_REGISTRY;

  // Check if search looks like a custom URL
  const isCustomUrl = mcpSearch.startsWith("https://") || mcpSearch.startsWith("http://");

  // Already connected MCP server URLs
  const connectedUrls = new Set(credentials.map((c) => c.auth.mcp_server_url).filter(Boolean));

  const [vaultTab, setVaultTab] = useState<"all" | "active">("active");
  const displayedVaults = vaultTab === "active" ? vaults.filter((v) => !v.archived_at) : vaults;

  const tabs = (
    <div className="flex gap-1">
      {(["all", "active"] as const).map((t) => (
        <button
          key={t}
          onClick={() => setVaultTab(t)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            vaultTab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
          }`}
        >
          {t === "all" ? "All" : "Active"}
        </button>
      ))}
    </div>
  );

  return (
    <ListPage<Vault>
      title="Credential Vaults"
      subtitle="Manage credentials for MCP servers and CLI tools."
      createLabel="+ New vault"
      onCreate={() => setShowCreateVault(true)}
      filters={tabs}
      data={displayedVaults}
      loading={loading}
      getRowKey={(v) => v.id}
      onRowClick={openVault}
      hasMore={hasMore}
      onLoadMore={loadMore}
      loadingMore={isLoadingMore}
      emptyTitle="No vaults yet"
      columns={[
        { key: "name", label: "Name", className: "font-medium text-fg" },
        { key: "id", label: "ID", className: "font-mono text-xs text-fg-muted" },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (v) => new Date(v.created_at).toLocaleDateString(),
        },
      ]}
    >
      {/* Create Vault */}
      <Modal
        open={showCreateVault}
        onClose={() => setShowCreateVault(false)}
        title="New Vault"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreateVault(false)}>Cancel</Button>
            <Button onClick={createVault} disabled={!vaultName}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name</label>
            <input
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value.slice(0, 30))}
              className={inputCls}
              placeholder="My Vault"
            />
          </div>
        </div>
      </Modal>

      {/* Vault Detail */}
      <Modal
        open={!!selectedVault}
        onClose={() => setSelectedVault(null)}
        title={selectedVault?.name || ""}
        subtitle={selectedVault ? `ID: ${selectedVault.id}` : undefined}
        maxWidth="max-w-2xl"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowAddCred(true)}>+ Connect service</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowManualCred(true)}>+ Add secret</Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setSelectedVault(null)}>Close</Button>
          </div>
        }
      >
        <div className="mb-3">
          <h3 className="text-xs font-medium text-fg-subtle uppercase tracking-wider">Credentials</h3>
        </div>

        {credsLoading ? (
          <div className="text-fg-subtle text-sm py-4 text-center">Loading...</div>
        ) : credentials.length === 0 ? (
          <div className="text-center py-8 text-fg-subtle text-sm">
            No credentials yet. Connect an MCP server or add a command secret.
          </div>
        ) : (
          <div className="space-y-2">
            {credentials.map((c) => (
              <div key={c.id} className="flex items-center justify-between border border-border rounded-lg px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${c.archived_at ? "bg-fg-subtle" : "bg-success"}`} />
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-fg truncate">{c.display_name}</div>
                    <div className="text-xs text-fg-muted font-mono truncate">
                      {c.auth.mcp_server_url || c.auth.command_prefixes?.join(", ") || c.id}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    c.auth.type === "mcp_oauth" ? "bg-info-subtle text-info"
                    : c.auth.type === "command_secret" ? "bg-brand-subtle text-brand"
                    : "bg-success-subtle text-success"
                  }`}>{c.auth.type === "mcp_oauth" ? "OAuth" : c.auth.type === "command_secret" ? "Secret" : "Bearer"}</span>
                  <button onClick={() => deleteCred(c.id)} className="text-xs text-fg-subtle hover:text-danger transition-colors">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Connect MCP Server — Registry Search (Anthropic-style) */}
      <Modal
        open={showAddCred && !!selectedVault}
        onClose={() => { setShowAddCred(false); setMcpSearch(""); }}
        title="Connect a service"
        maxWidth="max-w-lg"
        footer={isCustomUrl ? <Button onClick={() => connectMcp({ name: mcpSearch, url: mcpSearch })} disabled={!!connecting}>Connect</Button> : undefined}
      >
        <div className="space-y-3">
          <input
            value={mcpSearch}
            onChange={(e) => setMcpSearch(e.target.value)}
            className={inputCls}
            placeholder="Search services or enter a custom URL"
            autoFocus
          />

          <div className="max-h-80 overflow-y-auto -mx-1">
            {filteredRegistry.map((entry) => {
              const isConnected = connectedUrls.has(entry.url);
              return (
                <button
                  key={entry.id}
                  onClick={() => !isConnected && connectMcp(entry)}
                  disabled={isConnected || connecting === entry.name}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors ${
                    isConnected ? "opacity-50 cursor-default" : "hover:bg-bg-surface cursor-pointer"
                  }`}
                >
                  {entry.icon ? (
                    <img src={entry.icon} alt="" className="w-5 h-5 rounded shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  ) : (
                    <div className="w-5 h-5 rounded bg-bg-surface shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">{entry.name}</div>
                    <div className="text-xs text-fg-muted font-mono truncate">{entry.url}</div>
                  </div>
                  {isConnected ? (
                    <span className="text-xs text-success font-medium shrink-0">Connected</span>
                  ) : connecting === entry.name ? (
                    <span className="text-xs text-fg-muted shrink-0">Connecting...</span>
                  ) : null}
                </button>
              );
            })}
            {filteredRegistry.length === 0 && !isCustomUrl && (
              <div className="text-center py-6 text-fg-subtle text-sm">No matches. Enter a full URL to connect a custom MCP server.</div>
            )}
            {isCustomUrl && (
              <div className="px-3 py-2.5 text-sm text-fg-muted">
                Custom URL: <span className="font-mono text-fg">{mcpSearch}</span>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Add Manual Secret (command_secret) */}
      <Modal
        open={showManualCred && !!selectedVault}
        onClose={() => setShowManualCred(false)}
        title="Add Command Secret"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowManualCred(false)}>Cancel</Button>
            <Button onClick={createManualCred} disabled={!manualForm.display_name || !manualForm.token}>Create</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Display Name</label>
            <input value={manualForm.display_name} onChange={(e) => setManualForm({ ...manualForm, display_name: e.target.value })} className={inputCls} placeholder="GitHub Token" />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Command Prefixes <span className="text-fg-subtle">(comma-separated)</span></label>
            <input value={manualForm.command_prefixes} onChange={(e) => setManualForm({ ...manualForm, command_prefixes: e.target.value })} className={inputCls} placeholder="git, gh" />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Environment Variable</label>
            <input value={manualForm.env_var} onChange={(e) => setManualForm({ ...manualForm, env_var: e.target.value })} className={inputCls} placeholder="GITHUB_TOKEN" />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Token <span className="text-fg-subtle">(write-only)</span></label>
            <input type="password" value={manualForm.token} onChange={(e) => setManualForm({ ...manualForm, token: e.target.value })} className={inputCls} placeholder="••••••••" />
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}
