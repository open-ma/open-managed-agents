import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";

interface Session {
  id: string; title?: string; agent_id: string; environment_id: string;
  status?: string; created_at: string; archived_at?: string;
}
interface Vault { id: string; name: string; }

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
    env_secrets: [{ name: "", value: "" }],
  });

  const inputCls = "w-full border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-stone-400 transition-colors";

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

      // GitHub repository resource
      if (form.github_url) {
        const res: Record<string, unknown> = {
          type: "github_repository",
          url: form.github_url,
        };
        if (form.github_token) res.authorization_token = form.github_token;
        if (form.github_branch) res.checkout = { type: "branch", name: form.github_branch };
        resources.push(res);
      }

      // Environment secrets
      for (const s of form.env_secrets) {
        if (s.name && s.value) {
          resources.push({ type: "env_secret", name: s.name, value: s.value });
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

  const updateEnvSecret = (idx: number, field: "name" | "value", val: string) => {
    setForm(f => {
      const secrets = [...f.env_secrets];
      secrets[idx] = { ...secrets[idx], [field]: val };
      return { ...f, env_secrets: secrets };
    });
  };

  const addEnvSecret = () => {
    setForm(f => ({ ...f, env_secrets: [...f.env_secrets, { name: "", value: "" }] }));
  };

  const removeEnvSecret = (idx: number) => {
    setForm(f => ({ ...f, env_secrets: f.env_secrets.filter((_, i) => i !== idx) }));
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-stone-500 text-sm">Trace and debug agent sessions.</p>
        </div>
        <button onClick={() => { setShowCreate(true); if (!form.agent && agents[0]) setForm(f => ({ ...f, agent: agents[0].id })); if (!form.environment_id && envs[0]) setForm(f => ({ ...f, environment_id: envs[0].id })); }} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors">
          + New session
        </button>
      </div>

      {loading ? (
        <div className="text-stone-400 text-sm py-8 text-center">Loading...</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 text-stone-400">
          <p className="text-lg mb-1">No sessions yet</p>
          <p className="text-sm">Create a session to start chatting with an agent.</p>
        </div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-100/60 text-stone-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Title</th>
                <th className="text-left px-4 py-2.5">Agent</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} onClick={() => nav(`/sessions/${s.id}`)} className="border-t border-stone-100 hover:bg-stone-50 cursor-pointer transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.title || "Untitled"}</div>
                    <div className="text-xs text-stone-400 font-mono">{s.id}</div>
                  </td>
                  <td className="px-4 py-3 text-stone-600 font-mono text-xs">{s.agent_id}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${s.status === "idle" ? "bg-green-50 text-green-700" : s.status === "running" ? "bg-blue-50 text-blue-700" : "bg-stone-100 text-stone-600"}`}>
                      {s.status || "idle"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-stone-500">{new Date(s.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold mb-4">New Session</h2>
            <div className="space-y-4">
              {/* Basic */}
              <div>
                <label className="text-sm text-stone-600 block mb-1">Agent</label>
                <select value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })} className={inputCls}>
                  <option value="">Select agent...</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Environment</label>
                <select value={form.environment_id} onChange={(e) => setForm({ ...form, environment_id: e.target.value })} className={inputCls}>
                  <option value="">Select environment...</option>
                  {envs.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.id})</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Title <span className="text-stone-400">(optional)</span></label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} placeholder="My conversation" />
              </div>

              {/* Vaults */}
              {vaults.length > 0 && (
                <div>
                  <label className="text-sm text-stone-600 block mb-1">Credential Vaults <span className="text-stone-400">(optional)</span></label>
                  <div className="space-y-1">
                    {vaults.map((v) => (
                      <label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={form.vault_ids.includes(v.id)} onChange={() => toggleVault(v.id)} className="rounded" />
                        <span>{v.name}</span>
                        <span className="text-stone-400 font-mono text-xs">{v.id}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* GitHub Repository */}
              <details className="group">
                <summary className="text-sm font-medium text-stone-700 cursor-pointer hover:text-stone-900">GitHub Repository <span className="text-stone-400 font-normal">(optional)</span></summary>
                <div className="mt-2 space-y-2 pl-1">
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">Repository URL</label>
                    <input value={form.github_url} onChange={(e) => setForm({ ...form, github_url: e.target.value })} className={inputCls} placeholder="https://github.com/owner/repo" />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">Access Token <span className="text-stone-400">(write-only, never returned)</span></label>
                    <input type="password" value={form.github_token} onChange={(e) => setForm({ ...form, github_token: e.target.value })} className={inputCls} placeholder="ghp_..." />
                  </div>
                  <div>
                    <label className="text-xs text-stone-500 block mb-0.5">Branch <span className="text-stone-400">(optional, defaults to default branch)</span></label>
                    <input value={form.github_branch} onChange={(e) => setForm({ ...form, github_branch: e.target.value })} className={inputCls} placeholder="main" />
                  </div>
                </div>
              </details>

              {/* Environment Secrets */}
              <details className="group">
                <summary className="text-sm font-medium text-stone-700 cursor-pointer hover:text-stone-900">Environment Secrets <span className="text-stone-400 font-normal">(optional)</span></summary>
                <div className="mt-2 space-y-2 pl-1">
                  {form.env_secrets.map((s, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <div className="flex-1">
                        <input value={s.name} onChange={(e) => updateEnvSecret(i, "name", e.target.value)} className={inputCls} placeholder="ENV_VAR_NAME" />
                      </div>
                      <div className="flex-1">
                        <input type="password" value={s.value} onChange={(e) => updateEnvSecret(i, "value", e.target.value)} className={inputCls} placeholder="secret value" />
                      </div>
                      {form.env_secrets.length > 1 && (
                        <button onClick={() => removeEnvSecret(i)} className="text-stone-400 hover:text-red-500 text-xs mt-2">Remove</button>
                      )}
                    </div>
                  ))}
                  <button onClick={addEnvSecret} className="text-xs text-stone-500 hover:text-stone-700">+ Add secret</button>
                </div>
              </details>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900">Cancel</button>
              <button onClick={create} disabled={!form.agent || !form.environment_id} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
