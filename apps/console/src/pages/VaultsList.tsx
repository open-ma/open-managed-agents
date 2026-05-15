import { useEffect, useState, useCallback } from "react";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { ListPage } from "../components/ListPage";
import { TextInput, SecretInput } from "../components/Input";
import { LocalCombobox } from "../components/LocalCombobox";
import { Disclosure } from "../components/Disclosure";
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
  // Top-level tab inside the Add-credential modal: MCP server vs CLI.
  // Folds the previously separate "+ Connect service" + "+ Add CLI" entry
  // points into one modal; matches Anthropic's UI shape.
  const [addTab, setAddTab] = useState<"mcp" | "cli">("mcp");
  const [connecting, setConnecting] = useState<string | null>(null);
  // Custom MCP server form — single inline form (Anthropic-style).
  // Renders all fields in one view: Name, Type, MCP Server (with embedded
  // registry picker), Access token (Optional), and Refresh token block
  // (Optional, visible only when Access token is filled — RFC 6749:
  // refresh_token only makes sense alongside an access_token).
  const [customForm, setCustomForm] = useState({
    name: "",
    type: "oauth" as "oauth" | "bearer",
    url: "",
    // pickedName/Icon: when the user selected a registry entry from the
    // MCP Server picker, render it as a chip. Cleared by typing or X.
    pickedName: "",
    pickedIcon: "",
    // OAuth-standard fields. token = access_token; refreshToken +
    // tokenEndpoint + authMethod are only meaningful as a group and only
    // when token is also set (RFC 6749 §6).
    token: "",
    refreshToken: "",
    tokenEndpoint: "",
    authMethod: "client_secret_post" as "client_secret_basic" | "client_secret_post" | "none",
    // OAuth client credentials (Optional). Used when the provider doesn't
    // support DCR (GitHub, Feishu) and the operator hasn't preset client
    // creds at the worker env level — passed via query param to
    // /v1/oauth/authorize to override the server's lookup.
    clientId: "",
    clientSecret: "",
  });
  const [tokenSectionOpen, setTokenSectionOpen] = useState(false);
  const [refreshSectionOpen, setRefreshSectionOpen] = useState(false);
  const [clientCredsSectionOpen, setClientCredsSectionOpen] = useState(false);

  // Add-CLI form (cap_cli credentials). Visible inside the unified
  // Add-credential modal under the "CLI" tab.
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

  const connectMcp = (entry: McpRegistryEntry | { name: string; url: string }, opts?: { clientId?: string; clientSecret?: string }) => {
    // Used by the unified MCP form's submit path. We never auto-connect
    // when the user clicks a registry row — clicking only fills the
    // MCP Server field; the user must hit Connect to actually start the
    // OAuth handshake.
    if (!selectedVault) return;
    setConnecting(entry.name);
    const params = new URLSearchParams({
      mcp_server_url: entry.url,
      vault_id: selectedVault.id,
      redirect_uri: window.location.href,
    });
    if (opts?.clientId) params.set("client_id", opts.clientId);
    if (opts?.clientSecret) params.set("client_secret", opts.clientSecret);
    window.open(`/v1/oauth/authorize?${params.toString()}`, "oauth", "width=600,height=700,popup=yes");
  };

  const createBearerCred = async () => {
    if (!selectedVault) return;
    setConnecting("custom");
    try {
      // OAuth-standard credential auth shape:
      //   - access_token + refresh_token + token_endpoint → mcp_oauth
      //     (server can refresh on 401 via vault-forward.refreshMcpOAuth).
      //   - access_token only → static_bearer (no auto-refresh).
      const hasRefresh = customForm.refreshToken && customForm.tokenEndpoint;
      const auth: Record<string, unknown> = hasRefresh
        ? {
            type: "mcp_oauth",
            access_token: customForm.token,
            refresh_token: customForm.refreshToken,
            token_endpoint: customForm.tokenEndpoint,
            token_endpoint_auth_method: customForm.authMethod,
            mcp_server_url: customForm.url,
          }
        : {
            type: "static_bearer",
            token: customForm.token,
            mcp_server_url: customForm.url,
          };
      await api(`/v1/vaults/${selectedVault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          display_name: customForm.name || customForm.pickedName || "Custom MCP",
          auth,
        }),
      });
      setShowAddCred(false);
      setCustomForm({
        name: "", type: "oauth", url: "",
        pickedName: "", pickedIcon: "",
        token: "", refreshToken: "", tokenEndpoint: "", authMethod: "client_secret_post",
        clientId: "", clientSecret: "",
      });
      openVault(selectedVault);
    } finally {
      setConnecting(null);
    }
  };

  const submitCustom = () => {
    // Submit rules for the unified Add-credential MCP form:
    //   - User filled an Access token (or picked Bearer type) → POST a
    //     credential immediately (mcp_oauth if refresh_token present,
    //     else static_bearer). Button reads "Add credential".
    //   - Otherwise → start /v1/oauth/authorize popup. Button reads
    //     "Connect". Picking a registry row only fills the MCP Server
    //     field, never auto-connects.
    if (!customForm.url) return;
    if (customForm.type === "bearer" || customForm.token) {
      void createBearerCred();
    } else {
      connectMcp(
        { name: customForm.name || customForm.pickedName || customForm.url, url: customForm.url },
        { clientId: customForm.clientId, clientSecret: customForm.clientSecret },
      );
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
    setShowAddCred(false);
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
            setShowAddCred(false);
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

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

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
          className={`px-3 py-1.5 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
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
            <label htmlFor="vault-name" className="text-sm text-fg-muted block mb-1">Name</label>
            <input
              id="vault-name"
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
            <Button variant="secondary" size="sm" onClick={() => { setAddTab("mcp"); setShowAddCred(true); }}>+ Add credential</Button>
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
                  <button onClick={() => deleteCred(c.id)} className="text-xs text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Add credential — unified MCP / CLI modal (Anthropic-style). */}
      <Modal
        open={showAddCred && !!selectedVault}
        onClose={() => {
          setShowAddCred(false);
          setTokenSectionOpen(false);
          setRefreshSectionOpen(false);
          setCustomForm({
            name: "", type: "oauth", url: "",
            pickedName: "", pickedIcon: "",
            token: "", refreshToken: "", tokenEndpoint: "", authMethod: "client_secret_post",
            clientId: "", clientSecret: "",
          });
          setDeviceFlow(null);
        }}
        title="Add credential"
        maxWidth="max-w-lg"
        footer={
          addTab === "cli" ? (
            deviceFlow?.status === "polling" ? (
              <Button variant="ghost" onClick={() => setDeviceFlow(null)}>Cancel</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setShowAddCred(false)}>Cancel</Button>
                <Button onClick={createCapCliCred} disabled={!cliForm.token}>Create</Button>
              </>
            )
          ) : (
            <>
              <Button variant="ghost" onClick={() => setShowAddCred(false)}>Cancel</Button>
              <Button
                onClick={submitCustom}
                disabled={!customForm.url || !!connecting || (customForm.type === "bearer" && !customForm.token)}
              >
                {customForm.token || customForm.type === "bearer" ? "Add credential" : "Connect"}
              </Button>
            </>
          )
        }
      >
        <div role="tablist" aria-label="Add credential" className="flex gap-1 mb-3 border-b border-border">
          {(["mcp", "cli"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={addTab === t}
              tabIndex={addTab === t ? 0 : -1}
              onClick={() => setAddTab(t)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${
                addTab === t
                  ? "border-fg text-fg font-medium"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {t === "mcp" ? "MCP server" : "CLI"}
            </button>
          ))}
        </div>

        {addTab === "mcp" && (
          <div className="space-y-4">
            <div className="text-sm text-fg-muted">Authorize an MCP server for delegated user authentication.</div>

            <div>
              <label htmlFor="vault-mcp-name" className="text-sm font-medium text-fg block mb-1">
                Name <span className="text-xs text-fg-muted ml-1 px-1.5 py-0.5 rounded bg-bg-surface">Optional</span>
              </label>
              <input
                id="vault-mcp-name"
                value={customForm.name}
                onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                placeholder="Example MCP"
                className={inputCls}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-fg block mb-1">Type</label>
              <div className="inline-flex rounded-md border border-border p-0.5">
                {(["oauth", "bearer"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setCustomForm({ ...customForm, type: t })}
                    className={`px-3 py-1 text-sm rounded ${customForm.type === t ? "bg-bg-surface text-fg font-medium" : "text-fg-muted"}`}
                  >
                    {t === "oauth" ? "OAuth" : "Bearer token"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-fg block mb-1">MCP Server</label>
              {/* Picker — combobox style. Click toggles a registry list
                  panel; click a row fills the URL field (does NOT auto-
                  connect). User can also type a custom URL inline. */}
              {/* Combobox: single input acts as both registry-search and
                  custom-URL field. Focus opens the dropdown; typing filters
                  the registry by name/URL substring. Picking a registry row
                  fills the URL + shows the favicon as a prefix. The input
                  always remains editable so the user can refine to a
                  custom URL even after picking. */}
              {/* Combobox: input filters the registry as you type. Pick a
                  row to fill the URL + show the favicon as a left-side
                  prefix; type a custom URL to ignore the registry. The
                  dropdown renders into document.body via portal so it
                  escapes Modal's overflow-y-auto clipping. */}
              <LocalCombobox
                value={customForm.url}
                onChange={(text) => setCustomForm({ ...customForm, url: text, pickedName: "", pickedIcon: "" })}
                onPick={(entry) => setCustomForm({
                  ...customForm,
                  url: entry.url,
                  pickedName: entry.name,
                  pickedIcon: entry.icon ?? "",
                })}
                options={MCP_REGISTRY}
                filter={(entry, q) =>
                  !q ||
                  entry.name.toLowerCase().includes(q) ||
                  entry.url.toLowerCase().includes(q)
                }
                getKey={(entry) => entry.id}
                renderItem={(entry) => (
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    {entry.icon ? (
                      <img src={entry.icon} alt="" loading="lazy" decoding="async" className="w-5 h-5 rounded shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    ) : (
                      <div className="w-5 h-5 rounded bg-bg-surface shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-fg">{entry.name}</div>
                      <div className="text-xs text-fg-muted font-mono truncate">{entry.url}</div>
                    </div>
                  </div>
                )}
                prefix={customForm.pickedIcon ? (
                  <img src={customForm.pickedIcon} alt="" loading="lazy" decoding="async" className="w-4 h-4 rounded shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : null}
                placeholder="Search Anthropic's MCP registry or enter a custom URL"
                emptyHint="No matches — keep typing for a custom URL"
              />
            </div>

            {/* Access token — collapsed Optional. Filling this switches
                the submit path to POST static_bearer + button label
                changes to Create. Visible regardless of Type so the
                user can supply a pre-issued OAuth access_token without
                a full handshake. */}
            <Disclosure
              title="Access token"
              meta={<span className="px-1.5 py-0.5 rounded bg-bg-surface">Optional</span>}
              open={tokenSectionOpen}
              onOpenChange={setTokenSectionOpen}
            >
              <input
                value={customForm.token}
                onChange={(e) => setCustomForm({ ...customForm, token: e.target.value })}
                type="password"
                placeholder="••••••••"
                aria-label="Access token"
                className={inputCls}
              />
              <div className="text-xs text-fg-subtle mt-1">If filled, the credential is stored as a static bearer token (no OAuth handshake).</div>
            </Disclosure>

            {/* Refresh token block (Optional) — only meaningful when an
                Access token is also set (RFC 6749 §6 refresh_token grant).
                Render only when token has a value. */}
            {customForm.token && (
              <Disclosure
                title="Refresh token"
                meta={<span className="px-1.5 py-0.5 rounded bg-bg-surface">Optional</span>}
                open={refreshSectionOpen}
                onOpenChange={setRefreshSectionOpen}
                className="space-y-3"
              >
                <div className="space-y-3">
                  <div>
                    <input
                      value={customForm.refreshToken}
                      onChange={(e) => setCustomForm({ ...customForm, refreshToken: e.target.value })}
                      placeholder="OAuth refresh token"
                      aria-label="Refresh token"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label htmlFor="vault-token-endpoint" className="text-sm font-medium text-fg block mb-1">Token endpoint</label>
                    <input
                      id="vault-token-endpoint"
                      value={customForm.tokenEndpoint}
                      onChange={(e) => setCustomForm({ ...customForm, tokenEndpoint: e.target.value })}
                      placeholder="https://auth.example.com/oauth/token"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label htmlFor="vault-auth-method" className="text-sm font-medium text-fg block mb-1">Auth method</label>
                    <select
                      id="vault-auth-method"
                      value={customForm.authMethod}
                      onChange={(e) => setCustomForm({ ...customForm, authMethod: e.target.value as typeof customForm.authMethod })}
                      className={inputCls}
                    >
                      <option value="client_secret_post">client_secret_post</option>
                      <option value="client_secret_basic">client_secret_basic</option>
                      <option value="none">none</option>
                    </select>
                  </div>
                  <div className="text-xs text-fg-subtle">RFC 8414 token_endpoint_auth_methods_supported. Used when the server refreshes on 401.</div>
                </div>
              </Disclosure>
            )}
            {/* OAuth client credentials (Optional) — only shown for the
                OAuth flow. Lets the user override the server's preset
                client_id/secret on a per-credential basis (GitHub /
                Feishu / any provider that doesn't support DCR). */}
            {customForm.type === "oauth" && !customForm.token && (
              <Disclosure
                title="OAuth client credentials"
                meta={<span className="px-1.5 py-0.5 rounded bg-bg-surface">Optional</span>}
                open={clientCredsSectionOpen}
                onOpenChange={setClientCredsSectionOpen}
              >
                <div className="space-y-2">
                  <input
                    value={customForm.clientId}
                    onChange={(e) => setCustomForm({ ...customForm, clientId: e.target.value })}
                    placeholder="Client ID"
                    aria-label="OAuth client ID"
                    className={inputCls}
                  />
                  <input
                    value={customForm.clientSecret}
                    onChange={(e) => setCustomForm({ ...customForm, clientSecret: e.target.value })}
                    type="password"
                    placeholder="Client secret"
                    aria-label="OAuth client secret"
                    className={inputCls}
                  />
                  <div className="text-xs text-fg-subtle">For OAuth providers that don't support Dynamic Client Registration (GitHub, Feishu) — supply a client_id/secret from a pre-registered app.</div>
                </div>
              </Disclosure>
            )}
          </div>
        )}

        {addTab === "cli" && (
          <div className="space-y-3">
            <div>
              <label htmlFor="vault-cli-id" className="text-sm text-fg-muted block mb-1">CLI</label>
              <select
                id="vault-cli-id"
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
              <label htmlFor="vault-cli-display-name" className="text-sm text-fg-muted block mb-1">Display Name <span className="text-fg-subtle">(optional)</span></label>
              <TextInput
                id="vault-cli-display-name"
                value={cliForm.display_name}
                onChange={(e) => setCliForm({ ...cliForm, display_name: e.target.value })}
                className={inputCls}
                placeholder={CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ?? cliForm.cli_id}
                disabled={deviceFlow?.status === "polling"}
              />
            </div>
            <div>
              <label htmlFor="vault-cli-token" className="text-sm text-fg-muted block mb-1">Token <span className="text-fg-subtle">(write-only — leave blank to use OAuth above)</span></label>
              <SecretInput
                id="vault-cli-token"
                value={cliForm.token}
                onChange={(e) => setCliForm({ ...cliForm, token: e.target.value })}
                className={inputCls}
                placeholder="••••••••"
                disabled={deviceFlow?.status === "polling"}
              />
            </div>
          </div>
        )}
      </Modal>

    </ListPage>
  );
}
