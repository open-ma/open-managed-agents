import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface Session {
  id: string; title?: string; agent_id: string; environment_id: string;
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

export function SessionsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [envs, setEnvs] = useState<Array<{ id: string; name: string }>>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
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

  const load = async () => {
    setLoading(true);
    try {
      const [s, a, e, v] = await Promise.all([
        api<{ data: Session[] }>("/v1/sessions?limit=100"),
        api<{ data: Array<{ id: string; name: string }> }>("/v1/agents?limit=100"),
        api<{ data: Array<{ id: string; name: string }> }>("/v1/environments?limit=100"),
        api<{ data: Vault[] }>("/v1/vaults?limit=100").catch(() => ({ data: [] })),
      ]);
      setSessions(s.data);
      setAgents(a.data);
      setEnvs(e.data);
      setVaults(v.data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

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
        environment_id: form.environment_id,
        title: form.title || undefined,
      };
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

  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");

  const displayed = sessions.filter((s) => {
    if (search && !s.id.toLowerCase().includes(search.toLowerCase()) && !(s.title || "").toLowerCase().includes(search.toLowerCase())) return false;
    if (filterAgent && s.agent_id !== filterAgent) return false;
    return true;
  });

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Sessions</h1>
          <p className="text-fg-muted text-sm">Trace and debug agent sessions.</p>
        </div>
        <Button onClick={() => { setShowCreate(true); if (!form.agent && agents[0]) setForm(f => ({ ...f, agent: agents[0].id })); if (!form.environment_id && envs[0]) setForm(f => ({ ...f, environment_id: envs[0].id })); }}>
          + New session
        </Button>
      </div>

      <div className="flex items-center gap-4 mb-4">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Go to session ID..."
            className="border border-border rounded-md pl-8 pr-3 py-1.5 text-sm bg-bg text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors w-56"
          />
        </div>
        {agents.length > 0 && (
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="border border-border rounded-md px-3 py-1.5 text-sm bg-bg text-fg focus:border-brand focus:outline-none transition-colors"
          >
            <option value="">Agent: All</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg></div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">{search || filterAgent ? "No matching sessions" : "No sessions yet"}</p>
          <p className="text-sm">{search || filterAgent ? "Try different filters." : "Sessions will appear here once created through the API."}</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">ID</th>
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Agent</th>
                <th className="text-left px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((s) => (
                <tr key={s.id} onClick={() => nav(`/sessions/${s.id}`)} className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted truncate max-w-[180px]" title={s.id}>{s.id}</td>
                  <td className="px-4 py-3 font-medium text-fg">
                    <span className="inline-flex items-center gap-2">
                      {s.title || "Untitled"}
                      <LinearBadge metadata={s.metadata} />
                      <SlackBadge metadata={s.metadata} />
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(s.status)}`}>
                      {s.status || "idle"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted font-mono text-xs">{s.agent_id}</td>
                  <td className="px-4 py-3 text-fg-muted">{new Date(s.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Session"
        subtitle="Start a conversation with an agent."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.agent || !form.environment_id}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-fg-muted">Agent</label>
              <a href="/agents" className="text-xs text-brand hover:underline">Manage agents →</a>
            </div>
            <select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })} className={inputCls}>
              <option value="">Select agent...</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-fg-muted">Environment</label>
              <a href="/environments" className="text-xs text-brand hover:underline">Manage environments →</a>
            </div>
            <select value={form.environment_id} onChange={(e) => setForm({ ...form, environment_id: e.target.value })} className={inputCls}>
              <option value="">Select environment...</option>
              {envs.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.id})</option>)}
            </select>
          </div>
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
    </div>
  );
}
