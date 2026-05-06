import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";

interface EvalRunSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at: string;
  ended_at?: string;
  error?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: Array<{
    id: string;
    status: string;
    trial_pass_count?: number;
    trial_total?: number;
  }>;
}

function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    default:          return "bg-bg-surface text-fg-muted";
  }
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function durationStr(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function passRateStr(r: EvalRunSummary): string {
  let pass = 0;
  let total = 0;
  for (const t of r.tasks) {
    pass += t.trial_pass_count ?? 0;
    total += t.trial_total ?? 0;
  }
  if (total === 0) return "—";
  return `${pass}/${total}`;
}

export function EvalRunsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [runs, setRuns] = useState<EvalRunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api<{ data: EvalRunSummary[] }>("/v1/evals/runs?limit=100");
        if (cancelled) return;
        setRuns(res.data);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setLoading(false);
      }
    }
    load();
    const id = setInterval(() => {
      if (cancelled) return;
      const anyActive = runs.some(r => r.status === "pending" || r.status === "running");
      if (anyActive) load();
    }, 5_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Eval Runs</h1>
          <p className="text-fg-muted text-sm">Benchmark trajectories submitted via the eval API.</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">No eval runs yet</p>
          <p className="text-sm">
            Submit one with{" "}
            <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">POST /v1/evals/runs</code>{" "}
            or{" "}
            <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">npx tsx rl/tasks/terminal-bench/run-cloud.ts</code>.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">ID</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Pass rate</th>
                <th className="text-left px-4 py-2.5">Tasks</th>
                <th className="text-left px-4 py-2.5">Duration</th>
                <th className="text-left px-4 py-2.5">Started</th>
                <th className="text-left px-4 py-2.5">Agent</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
                <tr
                  key={r.id}
                  onClick={() => nav(`/evals/${r.id}`)}
                  className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted truncate max-w-[220px]" title={r.id}>
                    {r.id}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg font-medium">{passRateStr(r)}</td>
                  <td className="px-4 py-3 text-fg-muted">
                    {r.completed_count}/{r.task_count}
                    {r.failed_count > 0 && (
                      <span className="text-danger ml-1">({r.failed_count} fail)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{durationStr(r.started_at, r.ended_at)}</td>
                  <td className="px-4 py-3 text-fg-muted" title={r.started_at}>{timeAgo(r.started_at)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{r.agent_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
