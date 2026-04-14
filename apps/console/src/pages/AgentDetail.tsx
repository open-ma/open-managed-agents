import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useApi } from "../lib/api";

interface Agent {
  id: string; name: string; model: string | { id: string; speed?: string };
  system?: string; harness?: string; version: number; description?: string;
  tools?: unknown[]; callable_agents?: unknown[]; mcp_servers?: unknown[];
  skills?: unknown[]; created_at: string; updated_at?: string; archived_at?: string;
}

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [versions, setVersions] = useState<Agent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    api<Agent>(`/v1/agents/${id}`).then(setAgent).catch((e) => setError(e.message));
    api<{ data: Agent[] }>(`/v1/agents/${id}/versions`).then((d) => setVersions(d.data)).catch(() => {});
  }, [id]);

  const modelStr = (m: Agent["model"]) => typeof m === "string" ? m : `${m?.id} (${m?.speed || "standard"})`;

  const archive = async () => {
    if (!confirm("Archive this agent?")) return;
    await api(`/v1/agents/${id}/archive`, { method: "POST", body: "{}" });
    nav("/agents");
  };

  const del = async () => {
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    await api(`/v1/agents/${id}`, { method: "DELETE" });
    nav("/agents");
  };

  if (error) return <div className="p-10 text-danger">Error: {error}</div>;
  if (!agent) return <div className="p-10 text-fg-subtle">Loading...</div>;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <Link to="/agents" className="text-sm text-fg-subtle hover:text-fg-muted transition-colors">&larr; Agents</Link>

      <div className="flex items-start justify-between mt-2 mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight text-fg">{agent.name}</h1>
        <div className="flex gap-2">
          <button onClick={archive} className="px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors">Archive</button>
          <button onClick={del} className="px-3 py-1.5 border border-danger/30 text-danger rounded-lg text-sm hover:bg-danger-subtle transition-colors">Delete</button>
        </div>
      </div>

      {/* Properties grid */}
      <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 max-w-2xl text-sm">
        <span className="text-fg-muted">ID</span><span className="font-mono text-xs">{agent.id}</span>
        <span className="text-fg-muted">Model</span><span>{modelStr(agent.model)}</span>
        <span className="text-fg-muted">Harness</span><span>{agent.harness || "default"}</span>
        <span className="text-fg-muted">Version</span><span>v{agent.version}</span>
        <span className="text-fg-muted">Tools</span>
        <span>{(agent.tools || []).map((t: any) => t.type === "custom" ? `Custom: ${t.name}` : t.type).join(", ") || "None"}</span>
        <span className="text-fg-muted">Created</span><span>{new Date(agent.created_at).toLocaleString()}</span>
        <span className="text-fg-muted">Updated</span><span>{new Date(agent.updated_at || agent.created_at).toLocaleString()}</span>
        {agent.archived_at && <><span className="text-fg-muted">Archived</span><span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span></>}
      </div>

      {/* System prompt */}
      {agent.system && (
        <div className="mt-8 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">System Prompt</h2>
          <pre className="bg-bg-surface border border-border rounded-lg p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto font-mono text-fg-muted leading-relaxed">
            {agent.system}
          </pre>
        </div>
      )}

      {/* Version history */}
      {versions.length > 0 && (
        <div className="mt-8 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">Version History</h2>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Version</th>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-4 py-2">System Prompt</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} className="border-t border-border">
                    <td className="px-4 py-2">v{v.version}</td>
                    <td className="px-4 py-2 text-fg-muted">{modelStr(v.model)}</td>
                    <td className="px-4 py-2 text-fg-muted max-w-xs truncate">{v.system || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
