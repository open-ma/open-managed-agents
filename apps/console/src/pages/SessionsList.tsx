import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
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

/** Tiny "🔗 Linear" pill shown when a session was triggered by a Linear webhook. */
function LinearBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const linear = metadata?.linear as
    | { issueIdentifier?: string; issueId?: string; workspaceId?: string }
    | undefined;
  if (!linear || (!linear.issueId && !linear.issueIdentifier)) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700"
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
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700"
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
  const [envs, setEnvs] = useState<Array<{ id: string; name: string }>>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    agent: "", environment_id: "", title: "",
    vault_ids: [] as string[],
    github_url: "", github_token: "", github_branch: "",
    env_vars: [{ name: "", value: "" }],
  });
  // Per-row toggle for masking the env value input. Default: masked. We
  // intentionally use a text input + a visual mask via the toggle (rather
  // than type="password") so the UI stops implying that the value is
  // encrypted at rest — env values are stored alongside other session
  // resources without app-level encryption today (see the "env" type
  // rename in api-types/types.ts:801 for the matching back-end change).
  const [revealedEnvIdx, setRevealedEnvIdx] = useState<Set<number>>(new Set());
  const toggleEnvReveal = (idx: number) => setRevealedEnvIdx((prev) => {
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    return next;
  });

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");

  // Sessions table — cursor-paginated, server-side filtered by agent_id
  // when the filter dropdown is set. Filter change resets to page 1
  // (useCursorList re-fetches when params change).
  const sessionsParams = useMemo(
    () => ({ agent_id: filterAgent || undefined }),
    [filterAgent],
  );
  const {
    items: sessions,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: refreshSessions,
  } = useCursorList<Session>("/v1/sessions", { limit: 50, params: sessionsParams });

  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const [a, e, v] = await Promise.all([
        api<{ data: Array<{ id: string; name: string }> }>("/v1/agents?limit=200"),
        api<{ data: Array<{ id: string; name: string }> }>("/v1/environments?limit=200"),
        api<{ data: Vault[] }>("/v1/vaults?limit=200").catch(() => ({ data: [] })),
      ]);
      setAgents(a.data);
      setEnvs(e.data);
      setVaults(v.data);
    } catch {}
    setAuxLoading(false);
  };

  useEffect(() => { loadAux(); }, []);

  // Computed: which agent is selected, and is it bound to a local runtime?
  // The Environment picker, the Create-button enable condition, and the
  // request body all key off this single source of truth.
  // `selectedAgentDetail` is set by the Combobox onValueChange when the
  // user picks an agent (gives us the full row including runtime_binding).
  // Falls back to `agents.find` for the legacy preload path while it lasts.
  const selectedAgent =
    selectedAgentDetail ?? agents.find((a) => a.id === form.agent);
  const isLocalRuntime = !!selectedAgent?.runtime_binding;

  const create = async () => {
    try {
      const resources: Array<Record<string, unknown>> = [];

      if (form.github_url) {
        const res: Record<string, unknown> = { type: "github_repository", url: form.github_url };
        if (form.github_token) res.authorization_token = form.github_token;
        if (form.github_branch) res.checkout = { type: "branch", name: form.github_branch };
        resources.push(res);
      }

      for (const s of form.env_vars) {
        if (s.name && s.value) {
          // type=env (was env_secret pre-rename). Server still accepts the
          // legacy alias so older console builds keep working — see
          // sessions.ts:262.
          resources.push({ type: "env", name: s.name, value: s.value });
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
    } catch {}
  };

  const toggleVault = (id: string) => {
    setForm(f => ({
      ...f,
      vault_ids: f.vault_ids.includes(id) ? f.vault_ids.filter(v => v !== id) : [...f.vault_ids, id],
    }));
  };

  const updateEnvVar = (idx: number, field: "name" | "value", val: string) => {
    setForm(f => {
      const vars = [...f.env_vars];
      vars[idx] = { ...vars[idx], [field]: val };
      return { ...f, env_vars: vars };
    });
  };

  const addEnvVar = () => {
    setForm(f => ({ ...f, env_vars: [...f.env_vars, { name: "", value: "" }] }));
  };

  const removeEnvVar = (idx: number) => {
    setForm(f => ({ ...f, env_vars: f.env_vars.filter((_, i) => i !== idx) }));
    setRevealedEnvIdx((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < idx) next.add(i);
        else if (i > idx) next.add(i - 1);
      }
      return next;
    });
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
          className="text-fg-subtle hover:text-fg text-xs px-1.5 py-1 rounded hover:bg-bg-surface transition-colors"
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
      hasMore={hasMore}
      onLoadMore={loadMore}
      loadingMore={isLoadingMore}
      emptyTitle={search || filterAgent ? "No matching sessions" : "No sessions yet"}
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
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.agent || (!isLocalRuntime && !form.environment_id)}>Create</Button>
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
            <label className="text-sm text-fg-muted block mb-1">Title <span className="text-fg-subtle">(optional)</span></label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} placeholder="My conversation" />
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
            </div>
          )}

          <details className="group">
            <summary className="text-sm font-medium text-fg cursor-pointer hover:text-brand">GitHub Repository <span className="text-fg-subtle font-normal">(optional)</span></summary>
            <div className="mt-2 space-y-2 pl-1">
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">Repository URL</label>
                <input value={form.github_url} onChange={(e) => setForm({ ...form, github_url: e.target.value })} className={inputCls} placeholder="https://github.com/owner/repo" />
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">Access Token <span className="text-fg-subtle">(write-only, never returned)</span></label>
                <input type="password" value={form.github_token} onChange={(e) => setForm({ ...form, github_token: e.target.value })} className={inputCls} placeholder="ghp_..." />
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">Branch <span className="text-fg-subtle">(optional)</span></label>
                <input value={form.github_branch} onChange={(e) => setForm({ ...form, github_branch: e.target.value })} className={inputCls} placeholder="main" />
              </div>
            </div>
          </details>

          <details className="group">
            <summary className="text-sm font-medium text-fg cursor-pointer hover:text-brand">Environment Variables <span className="text-fg-subtle font-normal">(optional)</span></summary>
            <div className="mt-2 space-y-2 pl-1">
              <p className="text-xs text-fg-subtle">
                Plain environment variables passed to the agent. For tokens that need encryption, use credential vaults instead.
              </p>
              {form.env_vars.map((s, i) => {
                const revealed = revealedEnvIdx.has(i);
                return (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="flex-1">
                      <input value={s.name} onChange={(e) => updateEnvVar(i, "name", e.target.value)} className={inputCls} placeholder="ENV_VAR_NAME" />
                    </div>
                    <div className="flex-1 relative">
                      <input
                        type={revealed ? "text" : "password"}
                        value={s.value}
                        onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                        className={`${inputCls} pr-12`}
                        placeholder="value"
                      />
                      <button
                        type="button"
                        onClick={() => toggleEnvReveal(i)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-fg-subtle hover:text-fg"
                        aria-label={revealed ? "Hide value" : "Show value"}
                      >
                        {revealed ? "hide" : "show"}
                      </button>
                    </div>
                    {form.env_vars.length > 1 && (
                      <button onClick={() => removeEnvVar(i)} className="text-fg-subtle hover:text-danger text-xs mt-2">Remove</button>
                    )}
                  </div>
                );
              })}
              <button onClick={addEnvVar} className="text-xs text-fg-muted hover:text-fg">+ Add variable</button>
            </div>
          </details>
        </div>
      </Modal>
    </ListPage>
  );
}
