import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { GitHubIcon, LinearIcon, SlackIcon } from "../components/icons";
import { Page } from "../components/Page";

interface Agent {
  id: string; name: string; model: string | { id: string; speed?: string };
  system?: string; version: number; description?: string;
  tools?: unknown[]; mcp_servers?: unknown[];
  multiagent?: { type: "coordinator"; agents: Array<{type:"agent"; id:string; version:number}> } | null;
  skills?: unknown[]; created_at: string; updated_at?: string; archived_at?: string;
  _oma?: {
    aux_model?: { id: string; speed?: string };
    harness?: string;
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
    appendable_prompts?: string[];
  };
}

/** Shared publication shape across Linear / GitHub / Slack — they all
 *  expose the same id / status / mode / persona / workspace_name fields. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [versions, setVersions] = useState<Agent[]>([]);
  const [linearPubs, setLinearPubs] = useState<Pub[]>([]);
  const [githubPubs, setGithubPubs] = useState<Pub[]>([]);
  const [slackPubs, setSlackPubs] = useState<Pub[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    api<Agent>(`/v1/agents/${id}`).then(setAgent).catch((e) => setError(e.message));
    api<{ data: Agent[] }>(`/v1/agents/${id}/versions`).then((d) => setVersions(d.data)).catch(() => {});
    // Reverse-lookup publications per provider. Each endpoint exists thanks
    // to the /linear/agents/:id/publications + /slack/agents/:id/publications
    // + /github/agents/:id/publications routes added on the main worker.
    api<{ data: Pub[] }>(`/v1/integrations/linear/agents/${id}/publications`)
      .then((r) => setLinearPubs(r.data.filter((p) => p.status === "live")))
      .catch(() => {});
    api<{ data: Pub[] }>(`/v1/integrations/github/agents/${id}/publications`)
      .then((r) => setGithubPubs(r.data.filter((p) => p.status === "live")))
      .catch(() => {});
    api<{ data: Pub[] }>(`/v1/integrations/slack/agents/${id}/publications`)
      .then((r) => setSlackPubs(r.data.filter((p) => p.status === "live")))
      .catch(() => {});
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
    <Page>
      <Link to="/agents" className="text-sm text-fg-subtle hover:text-fg-muted transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">&larr; Agents</Link>

      <div className="flex items-start justify-between mt-2 mb-6">
        <h1 className="font-display text-xl font-semibold tracking-tight text-fg">{agent.name}</h1>
        <div className="flex gap-2">
          <button onClick={archive} className="px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">Archive</button>
          <button onClick={del} className="px-3 py-1.5 border border-danger/30 text-danger rounded-lg text-sm hover:bg-danger-subtle transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">Delete</button>
        </div>
      </div>

      {/* Properties grid */}
      <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 max-w-2xl text-sm">
        <span className="text-fg-muted">ID</span><span className="font-mono text-xs">{agent.id}</span>
        <span className="text-fg-muted">Model</span><span>{modelStr(agent.model)}</span>
        <span className="text-fg-muted">Harness</span><span>{agent._oma?.harness || "default"}</span>
        {agent._oma?.runtime_binding && (
          <>
            <span className="text-fg-muted">Local Runtime</span>
            <span className="text-xs">
              <span className="font-mono">{agent._oma.runtime_binding.runtime_id.slice(0, 8)}…</span>
              <span className="text-fg-subtle"> · ACP agent: </span>
              <span className="font-mono">{agent._oma.runtime_binding.acp_agent_id}</span>
            </span>
          </>
        )}
        <span className="text-fg-muted">Version</span><span>v{agent.version}</span>
        <span className="text-fg-muted">Tools</span>
        <span>{(agent.tools || []).map((t: any) => t.type === "custom" ? `Custom: ${t.name}` : t.type).join(", ") || "None"}</span>
        <span className="text-fg-muted">Created</span><span>{new Date(agent.created_at).toLocaleString()}</span>
        <span className="text-fg-muted">Updated</span><span>{new Date(agent.updated_at || agent.created_at).toLocaleString()}</span>
        {agent.archived_at && <><span className="text-fg-muted">Archived</span><span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span></>}
      </div>

      {/* Integrations — one fold per provider so adding a 4th / 5th doesn't
          push the rest of the page below the viewport. Default-open when
          there's at least one live publication so the user sees what's wired
          up at a glance; otherwise default-closed. */}
      <div className="mt-6 max-w-2xl">
        <h2 className="font-display text-base font-semibold mb-2">Integrations</h2>
        <div className="space-y-2">
          <IntegrationFold
            kind="linear"
            label="Linear"
            icon={<LinearIcon className="w-4 h-4" />}
            pubs={linearPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="github"
            label="GitHub"
            icon={<GitHubIcon className="w-4 h-4" />}
            pubs={githubPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="slack"
            label="Slack"
            icon={<SlackIcon className="w-4 h-4" />}
            pubs={slackPubs}
            agentId={agent.id}
          />
        </div>
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
          <div className="border border-border rounded-lg overflow-x-auto">
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
    </Page>
  );
}

/**
 * One foldable provider section. Default-open when there's a live
 * publication, default-closed otherwise — opening an empty section
 * just to find the "Publish to X" link is wasteful.
 */
function IntegrationFold({
  kind,
  label,
  icon,
  pubs,
  agentId,
}: {
  kind: "linear" | "github" | "slack";
  label: string;
  icon: React.ReactNode;
  pubs: Pub[];
  agentId: string;
}) {
  return (
    <details
      open={pubs.length > 0}
      className="border border-border rounded-lg bg-bg-surface/30 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="px-4 py-2.5 flex items-center gap-3 text-sm cursor-pointer hover:bg-bg-surface/60 list-none">
        <span className="text-fg-muted shrink-0">{icon}</span>
        <span className="font-medium text-fg">{label}</span>
        <span className="ml-auto text-xs text-fg-subtle">
          {pubs.length === 0 ? "Not published" : `${pubs.length} live`}
        </span>
      </summary>
      <div className="px-4 pb-3 pt-2 border-t border-border/40 space-y-1.5 text-sm">
        {pubs.length === 0 ? (
          <Link
            to={`/integrations/${kind}/publish?agent_id=${agentId}`}
            className="inline-flex items-center gap-1.5 text-brand hover:underline"
          >
            Publish to {label} →
          </Link>
        ) : (
          <>
            {pubs.map((p) => (
              <Link
                key={p.id}
                to={`/integrations/${kind}`}
                className="flex items-center gap-2 text-fg-muted hover:text-fg"
              >
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success-subtle text-success">
                  Live
                </span>
                <span>
                  as <strong>{p.persona.name}</strong> in {p.workspace_name ?? `${label} workspace`}
                </span>
                {p.mode === "full" && (
                  <span className="text-xs text-fg-subtle">(full identity)</span>
                )}
              </Link>
            ))}
            <Link
              to={`/integrations/${kind}/publish?agent_id=${agentId}`}
              className="inline-block text-xs text-brand hover:underline pt-1"
            >
              + Publish to another workspace
            </Link>
          </>
        )}
      </div>
    </details>
  );
}
