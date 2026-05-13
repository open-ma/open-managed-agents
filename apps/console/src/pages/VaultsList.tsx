import { useEffect, useState, useCallback } from "react";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { ListPage } from "../components/ListPage";
import { TextInput, SecretInput } from "../components/Input";
import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";

interface Vault { id: string; name: string; created_at: string; archived_at?: string; }
interface Credential {
  id: string; display_name: string; vault_id: string;
  auth: { type: string; mcp_server_url?: string; cli_id?: string };
  created_at: string; archived_at?: string;
}

// First-wave cap CLI list. Mirrors @open-managed-agents/cap builtinSpecs.
// Source of truth for the CLIs available to the "+ Add CLI" picker.
// `oauth: true` enables the device flow button; CLIs without it require
// manual token entry only.
const CAP_CLIS: Array<{ cli_id: string; label: string; helper: string; oauth?: boolean }> = [
  { cli_id: "gh", label: "GitHub CLI (gh)", helper: "Personal access token (ghp_...)", oauth: true },
  { cli_id: "glab", label: "GitLab CLI (glab)", helper: "Personal access token (glpat-...)", oauth: true },
  { cli_id: "az", label: "Azure CLI (az)", helper: "ARM access token", oauth: true },
  { cli_id: "gcloud", label: "Google Cloud SDK", helper: "OAuth access token", oauth: true },
  { cli_id: "fly", label: "Fly.io (fly / flyctl)", helper: "Fly API token (fo1_...)" },
  { cli_id: "vercel", label: "Vercel CLI", helper: "Account access token" },
  { cli_id: "doctl", label: "DigitalOcean (doctl)", helper: "API token (dop_v1_...)" },
  { cli_id: "heroku", label: "Heroku CLI", helper: "API token (heroku auth:token)" },
  { cli_id: "cf", label: "Cloudflare (cf / wrangler)", helper: "API token (CLOUDFLARE_API_TOKEN)" },
  { cli_id: "npm", label: "npm registry", helper: "Granular access token (npm_...)" },
  { cli_id: "aws", label: "AWS CLI / SDKs", helper: "AWS secret access key" },
  { cli_id: "kubectl", label: "kubectl", helper: "Bearer token for the API server" },
  { cli_id: "docker", label: "Docker registry", helper: "Registry password / PAT" },
  { cli_id: "git", label: "git (HTTPS remotes)", helper: "Personal access token" },
];

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

  // Custom MCP server form — opened from the "Custom Server" row at the
  // bottom of the registry list. Lets the user attach a server that's not
  // in Anthropic's registry: name, OAuth or static-bearer, URL, optional
  // token (bearer only).
  const [customMode, setCustomMode] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: "",
    type: "oauth" as "oauth" | "bearer",
    url: "",
    token: "",
  });

  // Add-CLI form (cap_cli credentials).
  const [showAddCli, setShowAddCli] = useState(false);
  const [cliForm, setCliForm] = useState({
    cli_id: "gh", display_name: "", token: "",
  });

  // OAuth device flow state for cap_cli credentials.
  // Set when "Sign in via OAuth" is clicked. The poll loop fires until
  // ready / failure, then writes a cap_cli credential.
  const [deviceFlow, setDeviceFlow] = useState<{
    cli_id: string;
    session_id: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval_seconds: number;
    expires_at_ms: number;
    status: "polling" | "ready" | "expired" | "denied" | "error";
    error?: string;
  } | null>(null);

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

  const createBearerCred = async () => {
    if (!selectedVault) return;
    setConnecting("custom");
    try {
      await api(`/v1/vaults/${selectedVault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          display_name: customForm.name || "Custom MCP",
          auth: {
            type: "static_bearer",
            token: customForm.token,
            mcp_server_url: customForm.url,
          },
        }),
      });
      setShowAddCred(false);
      setCustomMode(false);
      setCustomForm({ name: "", type: "oauth", url: "", token: "" });
      openVault(selectedVault);
    } finally {
      setConnecting(null);
    }
  };

  const submitCustom = () => {
    if (!customForm.url) return;
    if (customForm.type === "oauth") {
      connectMcp({ name: customForm.name || customForm.url, url: customForm.url });
    } else {
      void createBearerCred();
    }
  };

  const createCapCliCred = async () => {
    if (!selectedVault) return;
    const defaultName = CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ?? cliForm.cli_id;
    await api(`/v1/vaults/${selectedVault.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        display_name: cliForm.display_name || defaultName,
        auth: {
          type: "cap_cli",
          cli_id: cliForm.cli_id,
          token: cliForm.token,
        },
      }),
    });
    setShowAddCli(false);
    setCliForm({ cli_id: "gh", display_name: "", token: "" });
    openVault(selectedVault);
  };

  // Drive cap's OAuth Device Authorization Grant for the selected CLI.
  // Sequence: POST /initiate → show user_code + URL → poll /poll until
  // ready / terminal failure → write cap_cli credential and close modal.
  const startDeviceFlow = async () => {
    if (!selectedVault) return;
    setDeviceFlow(null);
    try {
      const init = await api<{
        session_id: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        interval_seconds: number;
        expires_at_ms: number;
      }>(`/v1/cap-cli/oauth/initiate`, {
        method: "POST",
        body: JSON.stringify({ vault_id: selectedVault.id, cli_id: cliForm.cli_id }),
      });
      const flow = { ...init, cli_id: cliForm.cli_id, status: "polling" as const };
      setDeviceFlow(flow);
      void pollDeviceFlow(flow);
    } catch (err) {
      setDeviceFlow({
        cli_id: cliForm.cli_id,
        session_id: "",
        user_code: "",
        verification_uri: "",
        interval_seconds: 0,
        expires_at_ms: 0,
        status: "error",
        error: (err as Error).message,
      });
    }
  };

  const pollDeviceFlow = async (flow: { session_id: string; interval_seconds: number; expires_at_ms: number }) => {
    let interval = flow.interval_seconds;
    while (Date.now() < flow.expires_at_ms) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        const r = await api<{
          status: "pending" | "slow_down" | "ready" | "expired" | "denied" | "error";
          new_interval_seconds?: number;
          oauth_error?: string;
          description?: string;
          credential_id?: string;
        }>(`/v1/cap-cli/oauth/poll`, {
          method: "POST",
          body: JSON.stringify({ session_id: flow.session_id }),
        });
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = r.new_interval_seconds ?? interval + 5;
          continue;
        }
        if (r.status === "ready") {
          setDeviceFlow((prev) => (prev ? { ...prev, status: "ready" } : null));
          if (selectedVault) openVault(selectedVault);
          setTimeout(() => {
            setShowAddCli(false);
            setDeviceFlow(null);
          }, 1500);
          return;
        }
        // expired / denied / error
        setDeviceFlow((prev) =>
          prev ? { ...prev, status: r.status as "expired" | "denied" | "error", error: r.description ?? r.oauth_error } : null,
        );
        return;
      } catch (err) {
        setDeviceFlow((prev) => (prev ? { ...prev, status: "error", error: (err as Error).message } : null));
        return;
      }
    }
    setDeviceFlow((prev) => (prev ? { ...prev, status: "expired" } : null));
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
            <Button variant="ghost" size="sm" onClick={() => setShowAddCli(true)}>+ Add CLI</Button>
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
            No credentials yet. Connect an MCP server or add a CLI token.
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
                      {c.auth.mcp_server_url || c.auth.cli_id || c.id}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    c.auth.type === "mcp_oauth" ? "bg-info-subtle text-info"
                    : c.auth.type === "cap_cli" ? "bg-brand-subtle text-brand"
                    : "bg-success-subtle text-success"
                  }`}>{c.auth.type === "mcp_oauth" ? "OAuth" : c.auth.type === "cap_cli" ? "CLI" : "Bearer"}</span>
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
        onClose={() => {
          setShowAddCred(false);
          setMcpSearch("");
          setCustomMode(false);
          setCustomForm({ name: "", type: "oauth", url: "", token: "" });
        }}
        title={customMode ? "Add credential" : "Connect a service"}
        maxWidth="max-w-lg"
        footer={
          customMode ? (
            <Button
              onClick={submitCustom}
              disabled={!customForm.url || (customForm.type === "bearer" && !customForm.token) || !!connecting}
            >
              Connect
            </Button>
          ) : isCustomUrl ? (
            <Button onClick={() => connectMcp({ name: mcpSearch, url: mcpSearch })} disabled={!!connecting}>Connect</Button>
          ) : undefined
        }
      >
        {customMode ? (
          <div className="space-y-4">
            <div className="text-sm text-fg-muted">Authorize an MCP server for delegated user authentication.</div>
            <div>
              <label className="text-sm font-medium text-fg">Name <span className="text-xs text-fg-muted ml-1">Optional</span></label>
              <input
                value={customForm.name}
                onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                placeholder="Example MCP"
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-fg">Type</label>
              <div className="inline-flex rounded-md border border-border-subtle p-0.5 mt-1">
                {(["oauth", "bearer"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setCustomForm({ ...customForm, type: t })}
                    className={`px-3 py-1 text-sm rounded ${customForm.type === t ? "bg-bg-surface text-fg" : "text-fg-muted"}`}
                  >
                    {t === "oauth" ? "OAuth" : "Bearer token"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-fg">MCP Server</label>
              <input
                value={customForm.url}
                onChange={(e) => setCustomForm({ ...customForm, url: e.target.value })}
                placeholder="https://mcp.example.com"
                className={inputCls}
              />
            </div>
            {customForm.type === "bearer" && (
              <div>
                <label className="text-sm font-medium text-fg">Bearer token</label>
                <input
                  value={customForm.token}
                  onChange={(e) => setCustomForm({ ...customForm, token: e.target.value })}
                  type="password"
                  placeholder="••••••••"
                  className={inputCls}
                />
              </div>
            )}
          </div>
        ) : (
        <div className="space-y-3">
          <input
            value={mcpSearch}
            onChange={(e) => setMcpSearch(e.target.value)}
            className={inputCls}
            placeholder="Search Anthropic's MCP registry or enter a custom URL"
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
              <div className="text-center py-6 text-fg-subtle text-sm">No matches. Use Custom Server below.</div>
            )}
            {isCustomUrl && (
              <div className="px-3 py-2.5 text-sm text-fg-muted">
                Custom URL: <span className="font-mono text-fg">{mcpSearch}</span>
              </div>
            )}

            {/* Always-visible Custom Server entry — Anthropic-style. Opens
                the Add credential form (Name + Type + URL + optional token). */}
            <div className="border-t border-border-subtle mt-2 pt-2">
              <button
                onClick={() => {
                  setCustomMode(true);
                  setCustomForm({ name: "", type: "oauth", url: mcpSearch.startsWith("http") ? mcpSearch : "", token: "" });
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left hover:bg-bg-surface cursor-pointer"
              >
                <div className="w-5 h-5 rounded bg-bg-surface shrink-0 flex items-center justify-center text-fg-muted">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">Custom Server</div>
                  <div className="text-xs text-fg-muted">Connect a server that's not in the registry</div>
                </div>
              </button>
            </div>
          </div>
        </div>
        )}
      </Modal>

      {/* Add CLI credential (cap_cli) */}
      <Modal
        open={showAddCli && !!selectedVault}
        onClose={() => { setShowAddCli(false); setDeviceFlow(null); }}
        title="Add a CLI"
        subtitle="cap injects the token at HTTPS time. Sandbox process never sees the secret."
        footer={
          deviceFlow?.status === "polling" ? (
            <Button variant="ghost" onClick={() => { setDeviceFlow(null); }}>Cancel</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setShowAddCli(false)}>Cancel</Button>
              <Button onClick={createCapCliCred} disabled={!cliForm.token}>Create</Button>
            </>
          )
        }
      >
        <div className="space-y-3">
          <div>
            <label className="text-sm text-fg-muted block mb-1">CLI</label>
            <select
              value={cliForm.cli_id}
              onChange={(e) => { setCliForm({ ...cliForm, cli_id: e.target.value }); setDeviceFlow(null); }}
              className={inputCls}
              disabled={deviceFlow?.status === "polling"}
            >
              {CAP_CLIS.map((c) => (
                <option key={c.cli_id} value={c.cli_id}>{c.label}{c.oauth ? " (OAuth supported)" : ""}</option>
              ))}
            </select>
            <div className="text-xs text-fg-subtle mt-1">
              {CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.helper}
            </div>
          </div>

          {/* Device flow panel */}
          {CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.oauth && (
            <div className="border border-border rounded-md p-3 bg-bg-surface">
              {!deviceFlow && (
                <Button variant="secondary" size="sm" onClick={startDeviceFlow}>
                  Sign in via {cliForm.cli_id} OAuth
                </Button>
              )}
              {deviceFlow?.status === "polling" && (
                <div className="space-y-2 text-sm">
                  <div className="text-fg-muted">
                    Open <a href={deviceFlow.verification_uri_complete ?? deviceFlow.verification_uri} target="_blank" rel="noreferrer" className="text-brand underline">{deviceFlow.verification_uri_complete ?? deviceFlow.verification_uri}</a> and enter:
                  </div>
                  <div className="font-mono text-2xl text-center tracking-widest text-fg py-2 select-all">
                    {deviceFlow.user_code}
                  </div>
                  <div className="text-xs text-fg-subtle text-center">Waiting for confirmation… (polls every {deviceFlow.interval_seconds}s)</div>
                </div>
              )}
              {deviceFlow?.status === "ready" && (
                <div className="text-sm text-success">✓ Token acquired and stored.</div>
              )}
              {(deviceFlow?.status === "expired" || deviceFlow?.status === "denied" || deviceFlow?.status === "error") && (
                <div className="text-sm text-danger">
                  {deviceFlow.status === "denied" ? "Access denied by user." : deviceFlow.status === "expired" ? "Code expired — try again." : `OAuth error: ${deviceFlow.error ?? "unknown"}`}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-sm text-fg-muted block mb-1">Display Name <span className="text-fg-subtle">(optional)</span></label>
            <TextInput
              value={cliForm.display_name}
              onChange={(e) => setCliForm({ ...cliForm, display_name: e.target.value })}
              className={inputCls}
              placeholder={CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ?? cliForm.cli_id}
              disabled={deviceFlow?.status === "polling"}
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Token <span className="text-fg-subtle">(write-only — leave blank to use OAuth above)</span></label>
            <SecretInput
              value={cliForm.token}
              onChange={(e) => setCliForm({ ...cliForm, token: e.target.value })}
              className={inputCls}
              placeholder="••••••••"
              disabled={deviceFlow?.status === "polling"}
            />
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}
