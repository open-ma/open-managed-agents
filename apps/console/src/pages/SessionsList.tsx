import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { Select, SelectOption } from "../components/Select";
import { Combobox } from "../components/Combobox";
import { ListPage } from "../components/ListPage";

interface Session {
  id: string; title?: string | null; agent: { id: string; version: number };
  environment_id: string;
  status?: string; created_at: string; archived_at?: string;
  metadata?: Record<string, unknown>;
}
interface Vault { id: string; name: string; }
interface FilePick { id: string; filename: string; size_bytes: number; }
interface MemoryStorePick { id: string; name: string; }

/** Discriminated union for one row in the dynamic Resources list. Mapped
 *  to the wire `{type, ...}` resource object at submit time (see `create`). */
type ResourceRow =
  | { kind: "github"; url: string; token: string; checkout_type: "none" | "branch" | "commit"; checkout_name: string; mount_path: string }
  | { kind: "file"; file_id: string; mount_path: string }
  | { kind: "memory_store"; memory_store_id: string; mount_path: string; access: "read_write" | "read_only" }
  | { kind: "env"; name: string; value: string };

function blankResource(kind: ResourceRow["kind"]): ResourceRow {
  switch (kind) {
    case "github": return { kind, url: "", token: "", checkout_type: "none", checkout_name: "", mount_path: "" };
    case "file": return { kind, file_id: "", mount_path: "" };
    case "memory_store": return { kind, memory_store_id: "", mount_path: "", access: "read_write" };
    case "env": return { kind, name: "", value: "" };
  }
}

function kindLabel(kind: ResourceRow["kind"]): string {
  switch (kind) {
    case "github": return "GitHub repository";
    case "file": return "File";
    case "memory_store": return "Memory store";
    case "env": return "Environment variable";
  }
}

/** Best-effort `<repo-name>` extraction from GitHub URL forms. Used to
 *  derive the default mount path /workspace/<repo-name>. Returns null when
 *  the URL doesn't look like GitHub (caller falls back to /workspace). */
function parseGitHubRepoName(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (!trimmed) return null;
  // Full URL: https://github.com/owner/repo
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts[1] || null;
  } catch {
    // SSH: git@github.com:owner/repo
    const ssh = trimmed.match(/^git@github\.com:[^/]+\/([^/]+)$/);
    if (ssh) return ssh[1];
    // Bare: owner/repo
    const bare = trimmed.match(/^[^/]+\/([^/]+)$/);
    if (bare) return bare[1];
    return null;
  }
}

function defaultMountPath(githubUrl: string): string {
  const name = parseGitHubRepoName(githubUrl);
  return name ? `/workspace/${name}` : "/workspace";
}

/** Tiny "🔗 Linear" pill shown when a session was triggered by a Linear webhook. */
function LinearBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const linear = metadata?.linear as
    | { issueIdentifier?: string; issueId?: string; workspaceId?: string }
    | undefined;
  if (!linear || (!linear.issueId && !linear.issueIdentifier)) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-info-subtle text-info"
      title={`Linear issue ${linear.issueIdentifier ?? linear.issueId}`}
    >
      🔗 {linear.issueIdentifier ?? "Linear"}
    </span>
  );
}

/** Tiny "💬 Slack" pill shown when a session was triggered by a Slack event. */
function SlackBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const slack = metadata?.slack as
    | { channelId?: string; threadTs?: string; workspaceId?: string }
    | undefined;
  if (!slack || (!slack.channelId && !slack.threadTs)) return null;
  const label = slack.channelId
    ? slack.channelId.startsWith("D")
      ? "DM"
      : slack.channelId
    : "Slack";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-accent-violet-subtle text-accent-violet"
      title={`Slack channel ${slack.channelId}${slack.threadTs ? ` thread ${slack.threadTs}` : ""}`}
    >
      💬 {label}
    </span>
  );
}

/** Tiny "🧪 Eval" pill shown when a session was spawned by an eval-runner trial. */
function EvalBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const ev = metadata?.eval as { run_id?: string; task_id?: string } | undefined;
  if (!ev?.run_id) return null;
  return (
    <a
      href={`/evals/${ev.run_id}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-info-subtle text-info hover:opacity-80 transition-opacity"
      title={`Eval run ${ev.run_id}${ev.task_id ? ` · task ${ev.task_id}` : ""}`}
    >
      🧪 {ev.task_id ?? "Eval"}
    </a>
  );
}

export function SessionsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [agents, setAgents] = useState<Array<{
    id: string;
    name: string;
    // Present iff the agent is bound to a user-registered runtime
    // (acp-proxy harness). The New Session dialog reads this to decide
    // whether to show the Environment picker — local-runtime sessions
    // don't run a sandbox container so there's nothing to pick.
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
  }>>([]);
  // Set by the agent Combobox when the user picks an agent. Carries the
  // full row so we can read `runtime_binding` without keeping every agent
  // preloaded in `agents[]`.
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<{
    id: string;
    name: string;
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
  } | null>(null);
  // Agent's MCP servers (from /v1/agents/{id} fetched on pick). Used to
  // warn the user when their selected vaults don't carry credentials for
  // a server the agent is configured to use — agent will hit those MCP
  // endpoints unauthenticated and fail mid-conversation.
  const [agentMcpUrls, setAgentMcpUrls] = useState<string[]>([]);
  // Per-vault credential hostnames cache. Populated lazily as the user
  // toggles vaults. Lookups are by hostname (matches outbound proxy logic
  // in apps/main/src/routes/mcp-proxy.ts:resolveOutboundCredentialByHost).
  const [vaultCredHosts, setVaultCredHosts] = useState<Record<string, Set<string>>>({});
  const [envs, setEnvs] = useState<Array<{ id: string; name: string }>>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [files, setFiles] = useState<FilePick[]>([]);
  const [memoryStores, setMemoryStores] = useState<MemoryStorePick[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    agent: "", environment_id: "", title: "",
    vault_ids: [] as string[],
    resources: [] as ResourceRow[],
  });
  // Per-field reveal toggle for any masked input (env value, github token).
  // Keyed by `${idx}:${field}`. We intentionally don't try to keep stale
  // entries valid across resource list mutations — adding/removing a row
  // just clears the set, which costs at worst one re-click.
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const toggleReveal = (key: string) => setRevealedSecrets((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");

  // Sessions table — cursor-paginated with proper Prev/Next/Page-N
  // pagination, server-side filtered by agent_id when the filter dropdown
  // is set. Filter change resets to page 1 (usePagedList re-fetches and
  // clears the cursor stack when params change).
  const sessionsParams = useMemo(
    () => ({ agent_id: filterAgent || undefined }),
    [filterAgent],
  );
  const {
    items: sessions,
    isLoading: loading,
    pageIndex,
    pageSize,
    hasNext,
    knownPages,
    goToPage,
    setPageSize,
    refresh: refreshSessions,
  } = usePagedList<Session>("/v1/sessions", { defaultPageSize: 20, params: sessionsParams });

  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const [a, e, v, f, m] = await Promise.all([
        api<{ data: Array<{ id: string; name: string }> }>("/v1/agents?limit=200"),
        api<{ data: Array<{ id: string; name: string }> }>("/v1/environments?limit=200"),
        api<{ data: Vault[] }>("/v1/vaults?limit=200").catch(() => ({ data: [] })),
        api<{ data: FilePick[] }>("/v1/files?limit=200").catch(() => ({ data: [] })),
        api<{ data: MemoryStorePick[] }>("/v1/memory_stores").catch(() => ({ data: [] })),
      ]);
      setAgents(a.data);
      setEnvs(e.data);
      setVaults(v.data);
      setFiles(f.data);
      setMemoryStores(m.data);
    } catch {}
    setAuxLoading(false);
  };

  useEffect(() => { loadAux(); }, []);

  // Fetch the picked agent's mcp_servers list. Combobox only carries the
  // light row (id/name/runtime_binding); we need the full row to know
  // which MCP endpoints the agent will dial. Refetch on agent change;
  // clear on unselect.
  useEffect(() => {
    if (!form.agent) {
      setAgentMcpUrls([]);
      return;
    }
    let cancelled = false;
    api<{ mcp_servers?: Array<{ url?: string }> }>(`/v1/agents/${form.agent}`)
      .then((row) => {
        if (cancelled) return;
        const urls = (row.mcp_servers ?? [])
          .map((s) => s.url)
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        setAgentMcpUrls(urls);
      })
      .catch(() => {
        if (!cancelled) setAgentMcpUrls([]);
      });
    return () => { cancelled = true; };
  }, [form.agent, api]);

  // Lazy-load credential hostnames for any newly-selected vault. Cache
  // forever within this modal lifetime — credential rotation mid-form is
  // not a real workflow.
  useEffect(() => {
    const missing = form.vault_ids.filter((vid) => !(vid in vaultCredHosts));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (vid) => {
        try {
          const r = await api<{ data: Array<{ auth?: { mcp_server_url?: string } }> }>(
            `/v1/vaults/${vid}/credentials`,
          );
          const hosts = new Set<string>();
          for (const cred of r.data) {
            const u = cred.auth?.mcp_server_url;
            if (!u) continue;
            try { hosts.add(new URL(u).hostname); } catch { /* ignore malformed */ }
          }
          return [vid, hosts] as const;
        } catch {
          return [vid, new Set<string>()] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setVaultCredHosts((prev) => {
        const next = { ...prev };
        for (const [vid, hosts] of entries) next[vid] = hosts;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [form.vault_ids, vaultCredHosts, api]);

  // Compute MCP servers the agent uses but no selected vault has credentials for.
  // Empty when: no agent picked, or agent has no MCP servers, or every server
  // is covered by at least one selected vault. The proxy resolver matches by
  // hostname (not full URL), so we compare hostnames here.
  const unauthedMcpServers = useMemo(() => {
    if (agentMcpUrls.length === 0) return [];
    const coveredHosts = new Set<string>();
    for (const vid of form.vault_ids) {
      const hosts = vaultCredHosts[vid];
      if (hosts) for (const h of hosts) coveredHosts.add(h);
    }
    const missing: Array<{ url: string; host: string }> = [];
    for (const url of agentMcpUrls) {
      let host: string;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!coveredHosts.has(host)) missing.push({ url, host });
    }
    return missing;
  }, [agentMcpUrls, form.vault_ids, vaultCredHosts]);

  // Computed: which agent is selected, and is it bound to a local runtime?
  // The Environment picker, the Create-button enable condition, and the
  // request body all key off this single source of truth.
  // `selectedAgentDetail` is set by the Combobox onValueChange when the
  // user picks an agent (gives us the full row including runtime_binding).
  // Falls back to `agents.find` for the legacy preload path while it lasts.
  const selectedAgent =
    selectedAgentDetail ?? agents.find((a) => a.id === form.agent);
  const isLocalRuntime = !!selectedAgent?.runtime_binding;

  // Per-row validation for the Create button. Only github currently has
  // hard-required fields beyond the type picker (URL + token); the other
  // kinds are skip-on-incomplete during submit.
  const resourcesValid = form.resources.every((r) => {
    if (r.kind === "github") return !!r.url && !!r.token;
    return true;
  });

  const create = async () => {
    try {
      const resources: Array<Record<string, unknown>> = [];
      for (const r of form.resources) {
        if (r.kind === "github") {
          // Token is required — UI gates the Create button on this, but we
          // double-check so a stale row from a previous validation pass
          // can't slip through.
          if (!r.url || !r.token) continue;
          const res: Record<string, unknown> = {
            type: "github_repository",
            url: r.url,
            authorization_token: r.token,
            // Always send mount_path: derive /workspace/<repo-name> from the
            // URL when the user left it blank. Mirrors the in-form preview.
            mount_path: r.mount_path || defaultMountPath(r.url),
          };
          if (r.checkout_type === "branch" && r.checkout_name) {
            res.checkout = { type: "branch", name: r.checkout_name };
          } else if (r.checkout_type === "commit" && r.checkout_name) {
            res.checkout = { type: "commit", sha: r.checkout_name };
          }
          resources.push(res);
        } else if (r.kind === "file") {
          if (!r.file_id) continue;
          const res: Record<string, unknown> = { type: "file", file_id: r.file_id };
          if (r.mount_path) res.mount_path = r.mount_path;
          resources.push(res);
        } else if (r.kind === "memory_store") {
          if (!r.memory_store_id) continue;
          const res: Record<string, unknown> = {
            type: "memory_store",
            memory_store_id: r.memory_store_id,
            access: r.access,
          };
          if (r.mount_path) res.mount_path = r.mount_path;
          resources.push(res);
        } else if (r.kind === "env") {
          if (!r.name || !r.value) continue;
          // type=env (was env_secret pre-rename). Server still accepts the
          // legacy alias so older console builds keep working — see
          // sessions.ts:262.
          resources.push({ type: "env", name: r.name, value: r.value });
        }
      }

      const body: Record<string, unknown> = {
        agent: form.agent,
        title: form.title || undefined,
      };
      // Only send environment_id when the user actually picked one. For
      // local-runtime agents the picker is hidden and the server picks a
      // tenant fallback (sessions.ts requires a NOT NULL env_id today).
      if (form.environment_id) body.environment_id = form.environment_id;
      if (form.vault_ids.length > 0) body.vault_ids = form.vault_ids;
      if (resources.length > 0) body.resources = resources;

      const session = await api<Session>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setShowCreate(false);
      nav(`/sessions/${session.id}`);
    } catch (err) {
      // 402 = no balance for cloud sandbox. Toast with the server's
      // "Insufficient balance" message has already shown; close the
      // modal and surface the Billing page so the user can top up
      // without hunting in the sidebar.
      if ((err as { status?: number }).status === 402) {
        setShowCreate(false);
        nav("/billing");
      }
      // Other failures: leave modal open so the user can adjust + retry.
    }
  };

  const toggleVault = (id: string) => {
    setForm(f => ({
      ...f,
      vault_ids: f.vault_ids.includes(id) ? f.vault_ids.filter(v => v !== id) : [...f.vault_ids, id],
    }));
  };

  const updateResource = <K extends ResourceRow["kind"]>(
    idx: number,
    patch: Partial<Extract<ResourceRow, { kind: K }>>,
  ) => {
    setForm((f) => {
      const next = [...f.resources];
      next[idx] = { ...next[idx], ...patch } as ResourceRow;
      return { ...f, resources: next };
    });
  };

  const addResource = (kind: ResourceRow["kind"]) => {
    setForm((f) => ({ ...f, resources: [...f.resources, blankResource(kind)] }));
    setRevealedSecrets(new Set());
  };

  const removeResource = (idx: number) => {
    setForm((f) => ({ ...f, resources: f.resources.filter((_, i) => i !== idx) }));
    setRevealedSecrets(new Set());
  };

  const statusCls = (status?: string) => {
    switch (status) {
      case "idle": return "bg-success-subtle text-success";
      case "running": return "bg-info-subtle text-info";
      default: return "bg-bg-surface text-fg-muted";
    }
  };

  const displayed = sessions.filter((s) => {
    if (search && !s.id.toLowerCase().includes(search.toLowerCase()) && !(s.title || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Compatibility shim: keep `load()` reference for any future caller.
  // Currently unused after refresh-on-create kicks off via refreshSessions.
  void refreshSessions;

  // Agent filter — Combobox over /v1/agents with server-side q + infinite
  // scroll. Empty `filterAgent` = unfiltered. Always render (Combobox
  // self-loads); a small × inside the trigger clears the filter.
  const agentFilter = (
    <div className="inline-flex items-center gap-1">
      <div className="w-56">
        <Combobox<{ id: string; name: string }>
          value={filterAgent}
          onValueChange={(v) => setFilterAgent(v)}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => a.name}
          getTextLabel={(a) => a.name}
          placeholder="Agent: All"
        />
      </div>
      {filterAgent && (
        <button
          type="button"
          onClick={() => setFilterAgent("")}
          aria-label="Clear agent filter"
          className="text-fg-subtle hover:text-fg text-xs inline-flex items-center justify-center min-w-8 min-h-8 px-2 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <ListPage<Session>
      title="Sessions"
      subtitle="Trace and debug agent sessions."
      createLabel="+ New session"
      onCreate={() => {
        setShowCreate(true);
        if (!form.agent && agents[0]) setForm(f => ({ ...f, agent: agents[0].id }));
        if (!form.environment_id && envs[0]) setForm(f => ({ ...f, environment_id: envs[0].id }));
      }}
      searchPlaceholder="Go to session ID..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={agentFilter}
      data={displayed}
      loading={loading}
      getRowKey={(s) => s.id}
      onRowClick={(s) => nav(`/sessions/${s.id}`)}
      pageIndex={pageIndex}
      pageSize={pageSize}
      hasNext={hasNext}
      knownPages={knownPages}
      pageSizeOptions={[10, 20, 50, 100]}
      onPageChange={goToPage}
      onPageSizeChange={setPageSize}
      emptyTitle={search || filterAgent ? "No matching sessions" : "No sessions yet"}
      emptyAction={!search && !filterAgent && (
        <Button onClick={() => {
          setShowCreate(true);
          if (!form.agent && agents[0]) setForm(f => ({ ...f, agent: agents[0].id }));
          if (!form.environment_id && envs[0]) setForm(f => ({ ...f, environment_id: envs[0].id }));
        }}>+ New session</Button>
      )}
      emptySubtitle={
        search || filterAgent
          ? "Try different filters."
          : "Sessions will appear here once created through the API."
      }
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[180px]",
          render: (s) => <span title={s.id}>{s.id}</span>,
        },
        {
          key: "name",
          label: "Name",
          className: "font-medium text-fg",
          render: (s) => (
            <span className="inline-flex items-center gap-2">
              {s.title || "Untitled"}
              <LinearBadge metadata={s.metadata} />
              <SlackBadge metadata={s.metadata} />
              <EvalBadge metadata={s.metadata} />
            </span>
          ),
        },
        {
          key: "status",
          label: "Status",
          render: (s) => (
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(s.status)}`}>
              {s.status || "idle"}
            </span>
          ),
        },
        {
          key: "agent",
          label: "Agent",
          className: "text-fg-muted font-mono text-xs",
          render: (s) => s.agent.id,
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (s) => new Date(s.created_at).toLocaleDateString(),
        },
      ]}
    >
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Session"
        subtitle="Start a conversation with an agent."
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.agent || (!isLocalRuntime && !form.environment_id) || !resourcesValid}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-fg-muted">Agent</label>
              <a href="/agents" className="text-xs text-brand hover:underline">Manage agents →</a>
            </div>
            <Combobox<{
              id: string;
              name: string;
              runtime_binding?: { runtime_id: string; acp_agent_id: string };
            }>
              value={form.agent}
              onValueChange={(v, item) => {
                setForm({ ...form, agent: v });
                if (item) setSelectedAgentDetail(item);
              }}
              endpoint="/v1/agents"
              getValue={(a) => a.id}
              getLabel={(a) => (
                <span>
                  {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
                </span>
              )}
              getTextLabel={(a) => `${a.name} (${a.id})`}
              placeholder="Select agent..."
            />
          </div>
          {/* Environment picker is for cloud sandbox lanes — local-runtime
              agents (acp-proxy harness) run on the user's daemon and
              never touch a cloud sandbox, so the picker is hidden in
              that mode. Server picks a tenant fallback when env_id is
              omitted; see sessions.ts:resolvedEnvId. */}
          {!isLocalRuntime && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm text-fg-muted">Environment</label>
                <a href="/environments" className="text-xs text-brand hover:underline">Manage environments →</a>
              </div>
              <Combobox<{ id: string; name: string }>
                value={form.environment_id}
                onValueChange={(v) => setForm({ ...form, environment_id: v })}
                endpoint="/v1/environments"
                getValue={(e) => e.id}
                getLabel={(e) => (
                  <span>
                    {e.name} <span className="text-fg-subtle text-[12px]">({e.id})</span>
                  </span>
                )}
                getTextLabel={(e) => `${e.name} (${e.id})`}
                placeholder="Select environment..."
              />
            </div>
          )}
          {isLocalRuntime && (
            <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
              Local runtime agents use the runtime machine's filesystem — no cloud environment needed.
            </p>
          )}
          <div>
            <label htmlFor="session-title" className="text-sm text-fg-muted block mb-1">Title <span className="text-fg-subtle">(optional)</span></label>
            {/* autoComplete=off + an unrecognised name to defeat Chrome /
                Safari email autofill — first text input in the dialog
                got pre-filled with the user's saved email otherwise. */}
            <input
              id="session-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={inputCls}
              placeholder="My conversation"
              autoComplete="off"
              name="oma-session-title"
            />
          </div>

          {vaults.length > 0 && (
            <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-fg-muted">Credential Vaults <span className="text-fg-subtle">(optional)</span></label>
              <a href="/vaults" className="text-xs text-brand hover:underline">Manage vaults →</a>
            </div>
              <div className="space-y-1">
                {vaults.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={form.vault_ids.includes(v.id)} onChange={() => toggleVault(v.id)} className="rounded accent-brand" />
                    <span className="text-fg">{v.name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{v.id}</span>
                  </label>
                ))}
              </div>
              {unauthedMcpServers.length > 0 && (
                <div className="mt-2 px-3 py-2 rounded-md border border-warning/40 bg-warning/5 text-xs text-warning">
                  <div className="font-medium mb-1">
                    {unauthedMcpServers.length === 1
                      ? "1 MCP server has no matching credential in selected vaults:"
                      : `${unauthedMcpServers.length} MCP servers have no matching credentials in selected vaults:`}
                  </div>
                  <ul className="space-y-0.5 font-mono">
                    {unauthedMcpServers.map((s) => (
                      <li key={s.url}>· {s.host}</li>
                    ))}
                  </ul>
                  <div className="mt-1 text-fg-muted font-sans">
                    Agent will dial these endpoints unauthenticated. Add a vault credential for each, or expect the agent to see 401s mid-conversation.
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-fg-muted">Resources <span className="text-fg-subtle">(optional)</span></label>
            </div>
            <p className="text-xs text-fg-subtle mb-2">
              Mount files, GitHub repositories, memory stores, or pass environment variables into the session.
            </p>
            {form.resources.length === 0 ? (
              <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-3 text-center">
                No resources added.
              </div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  // Compute the first github row index + total count once so
                  // we can mark it "primary" inline. The proxy resolver uses
                  // the first declared github_repository's token for any
                  // request whose URL doesn't carry an owner/repo slug
                  // (graphql, /user, /search, …). Only show the hint when
                  // there are 2+ github resources — for a single repo the
                  // "first" semantics aren't meaningful.
                  const githubIdxs = form.resources
                    .map((r, i) => (r.kind === "github" ? i : -1))
                    .filter((i) => i >= 0);
                  const firstGithubIdx = githubIdxs[0] ?? -1;
                  const showPrimaryHint = githubIdxs.length > 1;
                  return form.resources.map((r, i) => (
                  <div key={i} className="border border-border rounded-lg bg-bg-surface p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-fg inline-flex items-center gap-2">
                        {kindLabel(r.kind)}
                        {showPrimaryHint && r.kind === "github" && i === firstGithubIdx && (
                          <span
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30 text-brand"
                            title="This repo's token is used for GitHub API calls that don't target a specific repo (GraphQL, Search, /user, …)"
                          >
                            primary
                          </span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeResource(i)}
                        className="text-fg-subtle hover:text-danger text-xs"
                        aria-label="Remove resource"
                      >
                        Remove
                      </button>
                    </div>
                    {r.kind === "github" && (
                      <div className="space-y-2">
                        <div>
                          <label htmlFor={`session-resource-${i}-url`} className="text-xs text-fg-muted block mb-0.5">Repository URL <span className="text-danger">*</span></label>
                          <input
                            id={`session-resource-${i}-url`}
                            value={r.url}
                            onChange={(e) => updateResource<"github">(i, { url: e.target.value })}
                            className={inputCls}
                            placeholder="https://github.com/owner/repo"
                          />
                        </div>
                        <div>
                          <label htmlFor={`session-resource-${i}-token`} className="text-xs text-fg-muted block mb-0.5">
                            Authorization Token <span className="text-danger">*</span>
                          </label>
                          <div className="relative">
                            <input
                              id={`session-resource-${i}-token`}
                              type={revealedSecrets.has(`${i}:token`) ? "text" : "password"}
                              value={r.token}
                              onChange={(e) => updateResource<"github">(i, { token: e.target.value })}
                              className={`${inputCls} pr-12`}
                              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                            />
                            {r.token && (
                              <button
                                type="button"
                                onClick={() => toggleReveal(`${i}:token`)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-subtle hover:text-fg"
                                aria-label="Toggle token visibility"
                              >
                                {revealedSecrets.has(`${i}:token`) ? "hide" : "show"}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label htmlFor={`session-resource-${i}-checkout-type`} className="text-xs text-fg-muted block mb-0.5">Checkout</label>
                            <select
                              id={`session-resource-${i}-checkout-type`}
                              value={r.checkout_type}
                              onChange={(e) => updateResource<"github">(i, { checkout_type: e.target.value as "none" | "branch" | "commit", checkout_name: "" })}
                              className={inputCls}
                            >
                              <option value="none">None</option>
                              <option value="branch">Branch</option>
                              <option value="commit">Commit</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`session-resource-${i}-checkout-name`} className="text-xs text-fg-muted block mb-0.5">
                              {r.checkout_type === "commit" ? "Commit SHA" : "Name"}
                            </label>
                            <input
                              id={`session-resource-${i}-checkout-name`}
                              value={r.checkout_name}
                              onChange={(e) => updateResource<"github">(i, { checkout_name: e.target.value })}
                              className={inputCls}
                              disabled={r.checkout_type === "none"}
                              placeholder={r.checkout_type === "commit" ? "abc123..." : "main"}
                            />
                          </div>
                        </div>
                        <div>
                          <label htmlFor={`session-resource-${i}-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                          <input
                            id={`session-resource-${i}-mount`}
                            value={r.mount_path}
                            onChange={(e) => updateResource<"github">(i, { mount_path: e.target.value })}
                            className={inputCls}
                            placeholder={`${defaultMountPath(r.url)} (default)`}
                          />
                        </div>
                      </div>
                    )}
                    {r.kind === "file" && (
                      <div className="space-y-2">
                        <div>
                          <div className="flex items-center justify-between mb-0.5">
                            <label htmlFor={`session-resource-${i}-file`} className="text-xs text-fg-muted">File <span className="text-danger">*</span></label>
                            <a href="/files" className="text-xs text-brand hover:underline">Manage files →</a>
                          </div>
                          <select
                            id={`session-resource-${i}-file`}
                            value={r.file_id}
                            onChange={(e) => updateResource<"file">(i, { file_id: e.target.value })}
                            className={inputCls}
                          >
                            <option value="">Select file...</option>
                            {files.map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.filename} ({f.id})
                              </option>
                            ))}
                          </select>
                          {files.length === 0 && (
                            <p className="text-xs text-fg-subtle mt-1">No files yet — upload via the AMA SDK or POST /v1/files.</p>
                          )}
                        </div>
                        <div>
                          <label htmlFor={`session-resource-${i}-file-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                          <input
                            id={`session-resource-${i}-file-mount`}
                            value={r.mount_path}
                            onChange={(e) => updateResource<"file">(i, { mount_path: e.target.value })}
                            className={inputCls}
                            placeholder="/mnt/session/uploads/<file_id> (default)"
                          />
                        </div>
                      </div>
                    )}
                    {r.kind === "memory_store" && (
                      <div className="space-y-2">
                        <div>
                          <div className="flex items-center justify-between mb-0.5">
                            <label htmlFor={`session-resource-${i}-store`} className="text-xs text-fg-muted">Store <span className="text-danger">*</span></label>
                            <a href="/memory" className="text-xs text-brand hover:underline">Manage stores →</a>
                          </div>
                          <select
                            id={`session-resource-${i}-store`}
                            value={r.memory_store_id}
                            onChange={(e) => updateResource<"memory_store">(i, { memory_store_id: e.target.value })}
                            className={inputCls}
                          >
                            <option value="">Select store...</option>
                            {memoryStores.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({m.id})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label htmlFor={`session-resource-${i}-access`} className="text-xs text-fg-muted block mb-0.5">Access</label>
                            <select
                              id={`session-resource-${i}-access`}
                              value={r.access}
                              onChange={(e) => updateResource<"memory_store">(i, { access: e.target.value as "read_write" | "read_only" })}
                              className={inputCls}
                            >
                              <option value="read_write">Read / Write</option>
                              <option value="read_only">Read only</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`session-resource-${i}-store-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                            <input
                              id={`session-resource-${i}-store-mount`}
                              value={r.mount_path}
                              onChange={(e) => updateResource<"memory_store">(i, { mount_path: e.target.value })}
                              className={inputCls}
                              placeholder="/mnt/memory/<name>/ (default)"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    {r.kind === "env" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={`session-resource-${i}-env-name`} className="text-xs text-fg-muted block mb-0.5">Name <span className="text-danger">*</span></label>
                          <input
                            id={`session-resource-${i}-env-name`}
                            value={r.name}
                            onChange={(e) => updateResource<"env">(i, { name: e.target.value })}
                            className={inputCls}
                            placeholder="ENV_VAR_NAME"
                          />
                        </div>
                        <div>
                          <label htmlFor={`session-resource-${i}-env-value`} className="text-xs text-fg-muted block mb-0.5">Value <span className="text-danger">*</span></label>
                          <div className="relative">
                            <input
                              id={`session-resource-${i}-env-value`}
                              type={revealedSecrets.has(`${i}:value`) ? "text" : "password"}
                              value={r.value}
                              onChange={(e) => updateResource<"env">(i, { value: e.target.value })}
                              className={`${inputCls} pr-12`}
                              placeholder="value"
                            />
                            {r.value && (
                              <button
                                type="button"
                                onClick={() => toggleReveal(`${i}:value`)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-subtle hover:text-fg"
                                aria-label="Toggle value visibility"
                              >
                                {revealedSecrets.has(`${i}:value`) ? "hide" : "show"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ));
                })()}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              <button type="button" onClick={() => addResource("github")} className="text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ GitHub repo</button>
              <button type="button" onClick={() => addResource("file")} className="text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ File</button>
              <button type="button" onClick={() => addResource("memory_store")} className="text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ Memory store</button>
              <button type="button" onClick={() => addResource("env")} className="text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ Env var</button>
            </div>
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}
