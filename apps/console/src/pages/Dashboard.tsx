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

export function Dashboard() {
  const nav = useNavigate();
  const { api } = useApi();
  const { user: _user } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

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

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    toast("Copied", "success");
    setTimeout(() => setCopied(null), 1600);
  };

  const stat = (label: string, value: number | undefined, to: string) => (
    <button
      key={label}
      onClick={() => nav(to)}
      className="group relative text-left px-4 py-3.5 border border-border rounded-md bg-bg hover:border-border-strong hover:bg-bg-surface/40 transition-colors"
    >
      <div className="font-display text-[28px] leading-none font-semibold text-fg group-hover:text-brand transition-colors tabular-nums">
        {value ?? "–"}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">
        {label}
      </div>
    </button>
  );

  const stats_ = [
    { label: "Agents", value: stats?.agents, to: "/agents" },
    { label: "Sessions", value: stats?.sessions, to: "/sessions" },
    { label: "Environments", value: stats?.environments, to: "/environments" },
    { label: "Vaults", value: stats?.vaults, to: "/vaults" },
    { label: "Skills", value: stats?.skills, to: "/skills" },
    { label: "Model Cards", value: stats?.modelCards, to: "/model-cards" },
  ];

  const statusCls = (s: string) => {
    if (s === "running") return "bg-info-subtle text-info";
    if (s === "idle") return "bg-success-subtle text-success";
    return "bg-bg-surface text-fg-muted";
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-fg-subtle text-sm">Loading...</div>
      </div>
    );
  }

  const cmd = "npx open-managed-agents";
  const cmdGlobal = "npm i -g open-managed-agents";
  const examplePrompt =
    "Use oma to create a research agent that monitors arXiv for new ML papers daily";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-8 lg:px-10 py-10 lg:py-12 space-y-10">
        {/* Header */}
        <header>
          <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight text-fg">
            Get started with openma
          </h1>
          <p className="mt-1.5 text-[15px] text-fg-muted">
            Hand the platform to your agent — install the CLI, mint a key, point them at it.
          </p>
        </header>

        {/* Quickstart — single panel with three rows, no per-step cards */}
        <section className="border border-border rounded-lg overflow-hidden">
          {/* Step 1 */}
          <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6 border-b border-border">
            <div>
              <div className="font-mono text-[11px] tracking-wider text-brand">STEP 01</div>
              <div className="mt-1 font-medium text-fg text-[15px]">Install the CLI</div>
            </div>
            <div className="space-y-2.5 min-w-0">
              <p className="text-sm text-fg-muted">
                The <code className="font-mono text-[13px] text-fg">oma</code> CLI lets your
                agent (or you) drive the platform from the terminal.
              </p>
              <button
                onClick={() => copy(cmd, "cmd")}
                className="group w-full sm:w-auto sm:inline-flex items-center gap-3 pl-3 pr-2 py-2 rounded-md border border-border bg-bg-surface/50 hover:border-border-strong transition-colors text-left"
              >
                <span className="text-fg-subtle select-none font-mono text-xs">›</span>
                <span className="font-mono text-[13px] text-fg flex-1 truncate">{cmd}</span>
                <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors p-1">
                  {copied === "cmd" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                  )}
                </span>
              </button>
              <p className="text-[12px] text-fg-subtle">
                or globally:{" "}
                <button
                  onClick={() => copy(cmdGlobal, "cmd-global")}
                  className="font-mono text-fg-muted hover:text-brand transition-colors"
                >
                  {cmdGlobal}
                </button>
              </p>
            </div>
          </div>

          {/* Step 2 */}
          <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6 border-b border-border">
            <div>
              <div className="font-mono text-[11px] tracking-wider text-brand">STEP 02</div>
              <div className="mt-1 font-medium text-fg text-[15px]">Mint an API key</div>
            </div>
            <div className="space-y-2.5">
              <p className="text-sm text-fg-muted">
                Your agent needs this to authenticate. Keep it somewhere it can read.
              </p>
              <button
                onClick={() => nav("/api-keys")}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors"
              >
                Generate API key
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
          </div>

          {/* Step 3 */}
          <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6">
            <div>
              <div className="font-mono text-[11px] tracking-wider text-brand">STEP 03</div>
              <div className="mt-1 font-medium text-fg text-[15px]">Hand it the reins</div>
            </div>
            <div className="space-y-2.5">
              <p className="text-sm text-fg-muted">
                Point your agent at the <code className="font-mono text-[13px] text-fg">openma-cli</code>{" "}
                or <code className="font-mono text-[13px] text-fg">openma-api</code> skill, then
                ask for what you want:
              </p>
              <button
                onClick={() => copy(examplePrompt, "prompt")}
                className="group w-full text-left rounded-md border border-border bg-bg-surface/50 hover:border-border-strong transition-colors p-3 flex items-start gap-3"
              >
                <span className="shrink-0 mt-0.5 font-mono text-[10px] tracking-wider text-fg-subtle">
                  PROMPT
                </span>
                <span className="flex-1 text-[13px] text-fg leading-snug">{examplePrompt}</span>
                <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors mt-0.5">
                  {copied === "prompt" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                  )}
                </span>
              </button>
            </div>
          </div>
        </section>

        {/* Stats — number-forward, no decorative icons */}
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {stats_.map((s) => stat(s.label, s.value, s.to))}
          </div>
        </section>

        {/* Recent sessions */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-display text-lg font-semibold text-fg">Recent sessions</h2>
            <button
              onClick={() => nav("/sessions")}
              className="text-[13px] text-fg-muted hover:text-brand transition-colors"
            >
              View all →
            </button>
          </div>

          {recentSessions.length === 0 ? (
            <div className="border border-border rounded-lg px-6 py-10 text-center bg-bg-surface/30">
              <div className="font-mono text-fg-subtle text-sm select-none mb-2">[ &nbsp;&nbsp; ]</div>
              <p className="text-sm text-fg">No sessions yet — the stable's empty.</p>
              <p className="text-[13px] text-fg-muted mt-1">
                Tell your agent to start one, or visit the{" "}
                <button
                  onClick={() => nav("/sessions")}
                  className="text-brand hover:underline"
                >
                  Sessions page
                </button>
                .
              </p>
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg-surface/40 text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
                    <th className="text-left px-4 py-2.5 font-medium">Title</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                    <th className="text-left px-4 py-2.5 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => nav(`/sessions/${s.id}`)}
                      className="border-t border-border hover:bg-bg-surface/40 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5 text-fg">{s.title || "Untitled"}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[11px] px-2 py-0.5 rounded ${statusCls(s.status)}`}>
                          {s.status || "idle"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted font-mono text-[12px]">
                        {s.agent_id}
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted text-[12px]">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
