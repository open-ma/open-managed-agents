import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  modelCards: number;
  apiKeys: number;
}

interface RecentSession {
  id: string;
  title: string;
  agent_id: string;
  status: string;
  created_at: string;
}

const QUICKSTART_STEPS = [
  {
    step: 1,
    title: "Install the CLI",
    description: "The oma CLI lets your agent (or you) manage the platform from the terminal",
    command: "npx open-managed-agents",
    alt: "npm i -g open-managed-agents",
  },
  {
    step: 2,
    title: "Generate an API key",
    description: "Your agent needs this to authenticate with the platform",
    action: "api-key",
  },
  {
    step: 3,
    title: "Tell your agent to use it",
    description: "Point your agent at the openma-cli or openma-api skill and let it work",
    example: '"Use oma to create a research agent that monitors arXiv for new ML papers daily"',
  },
] as const;

export function Dashboard() {
  const nav = useNavigate();
  const { api } = useApi();
  const { user } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [agents, sessions, envs, vaults, skills, cards, keys] = await Promise.all([
          api<{ data: unknown[] }>("/v1/agents?limit=1000").catch(() => ({ data: [] })),
          api<{ data: RecentSession[] }>("/v1/sessions?limit=5").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/v1/environments").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/v1/vaults").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/v1/skills?source=custom").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/v1/model_cards").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/v1/api_keys").catch(() => ({ data: [] })),
        ]);
        setStats({
          agents: agents.data.length,
          sessions: sessions.data.length,
          environments: envs.data.length,
          vaults: vaults.data.length,
          skills: skills.data.length,
          modelCards: cards.data.length,
          apiKeys: keys.data.length,
        });
        setRecentSessions(sessions.data.slice(0, 5));
      } catch {}
      setLoading(false);
    })();
  }, []);

  const copyToClipboard = (text: string, step: number) => {
    navigator.clipboard.writeText(text);
    setCopied(step);
    toast("Copied to clipboard", "success");
    setTimeout(() => setCopied(null), 2000);
  };

  const cards = [
    { label: "Agents", value: stats?.agents, to: "/agents", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
    { label: "Sessions", value: stats?.sessions, to: "/sessions", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
    { label: "Environments", value: stats?.environments, to: "/environments", icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" },
    { label: "Vaults", value: stats?.vaults, to: "/vaults", icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
    { label: "Skills", value: stats?.skills, to: "/skills", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
    { label: "Model Cards", value: stats?.modelCards, to: "/model-cards", icon: "M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" },
  ];

  const statusCls = (s: string) => {
    if (s === "running") return "bg-info-subtle text-info";
    if (s === "idle") return "bg-success-subtle text-success";
    return "bg-bg-surface text-fg-muted";
  };

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><div className="text-fg-subtle text-sm">Loading...</div></div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      {/* Quickstart */}
      <div className="mb-10">
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg mb-1">
          Get started with openma
        </h1>
        <p className="text-fg-muted text-sm mb-6">Use your own agent to build and manage agents on the platform.</p>

        <div className="grid gap-4 md:grid-cols-3">
          {QUICKSTART_STEPS.map((s) => (
            <div key={s.step} className="border border-border rounded-xl p-5 bg-bg-surface/30 flex flex-col">
              <div className="flex items-center gap-2.5 mb-3">
                <span className="shrink-0 w-7 h-7 rounded-full bg-brand text-brand-fg text-xs font-bold flex items-center justify-center">
                  {s.step}
                </span>
                <h3 className="text-sm font-semibold text-fg">{s.title}</h3>
              </div>
              <p className="text-xs text-fg-muted mb-4 flex-1">{s.description}</p>

              {"command" in s && (
                <div className="space-y-2">
                  <button
                    onClick={() => copyToClipboard(s.command, s.step)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 bg-zinc-900 text-zinc-100 rounded-lg font-mono text-xs hover:bg-zinc-800 transition-colors group text-left"
                  >
                    <span className="text-emerald-400 select-none">$</span>
                    <span className="flex-1 truncate">{s.command}</span>
                    <span className="shrink-0 text-zinc-500 group-hover:text-zinc-300 transition-colors">
                      {copied === s.step ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                      )}
                    </span>
                  </button>
                  <p className="text-[11px] text-fg-subtle px-1">
                    or globally: <button onClick={() => copyToClipboard(s.alt!, s.step + 10)} className="font-mono text-brand hover:underline">{s.alt}</button>
                  </p>
                </div>
              )}

              {"action" in s && s.action === "api-key" && (
                <button
                  onClick={() => nav("/api-keys")}
                  className="w-full px-4 py-2.5 bg-brand text-brand-fg rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors"
                >
                  Generate API Key
                </button>
              )}

              {"example" in s && (
                <div className="px-3 py-2.5 bg-zinc-900 text-zinc-300 rounded-lg text-xs italic leading-relaxed">
                  {s.example}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => nav(c.to)}
            className="text-left p-4 border border-border rounded-lg hover:border-brand hover:bg-brand-subtle/30 transition-colors group"
          >
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-fg-subtle group-hover:text-brand transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d={c.icon} />
              </svg>
              <span className="text-xs text-fg-muted">{c.label}</span>
            </div>
            <div className="text-2xl font-semibold text-fg">{c.value ?? "-"}</div>
          </button>
        ))}
      </div>

      {/* Recent sessions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-fg">Recent Sessions</h2>
          <button onClick={() => nav("/sessions")} className="text-xs text-fg-muted hover:text-fg transition-colors">
            View all
          </button>
        </div>
        {recentSessions.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg p-8 text-center">
            <p className="text-fg-subtle text-sm">No sessions yet.</p>
            <p className="text-fg-subtle text-xs mt-1">Install the skill and tell your agent to create one.</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface text-fg-subtle text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Title</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">Agent</th>
                  <th className="text-left px-4 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {recentSessions.map((s) => (
                  <tr key={s.id} onClick={() => nav(`/sessions/${s.id}`)} className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors">
                    <td className="px-4 py-2.5 font-medium text-fg">{s.title || "Untitled"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusCls(s.status)}`}>{s.status || "idle"}</span>
                    </td>
                    <td className="px-4 py-2.5 text-fg-muted font-mono text-xs">{s.agent_id}</td>
                    <td className="px-4 py-2.5 text-fg-muted text-xs">{new Date(s.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
