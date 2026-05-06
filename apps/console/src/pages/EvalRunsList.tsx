import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { StatusPill } from "../components/Badge";

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

function statusToPill(s: string): "running" | "completed" | "errored" | "idle" {
  if (s === "completed") return "completed";
  if (s === "failed") return "errored";
  if (s === "running") return "running";
  return "idle";
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
  // Sum trial passes across all tasks. trial_pass_count is server-aggregated
  // from per-trial reward in the eval-runner finalize step.
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api<{ data: EvalRunSummary[] }>("/v1/evals/runs?limit=100");
        if (cancelled) return;
        setRuns(res.data);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
        setLoading(false);
      }
    }
    load();
    // Light auto-refresh while there's any active run.
    const id = setInterval(() => {
      if (cancelled) return;
      const anyActive = runs.some(r => r.status === "pending" || r.status === "running");
      if (anyActive) load();
    }, 5_000);
    return () => { cancelled = true; clearInterval(id); };
    // intentionally only on mount; the interval re-evaluates `runs` via closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Eval Runs</h1>
        <div className="text-xs text-gray-500">
          Submit runs via <code className="bg-gray-100 px-1 rounded">POST /v1/evals/runs</code> or
          {" "}<code className="bg-gray-100 px-1 rounded">npx tsx rl/tasks/terminal-bench/run-cloud.ts</code>
        </div>
      </div>
      {runs.length === 0 ? (
        <div className="border rounded p-8 text-center text-sm text-gray-500">
          No eval runs yet. Submit one to see it here.
        </div>
      ) : (
        <div className="border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-600">
                <th className="px-3 py-2">Run ID</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Pass rate</th>
                <th className="px-3 py-2">Tasks</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Agent</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
                <tr
                  key={r.id}
                  className="border-t hover:bg-blue-50 cursor-pointer"
                  onClick={() => nav(`/evals/${r.id}`)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.id}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={statusToPill(r.status)} label={r.status} />
                  </td>
                  <td className="px-3 py-2">{passRateStr(r)}</td>
                  <td className="px-3 py-2">
                    {r.completed_count}/{r.task_count}
                    {r.failed_count > 0 && (
                      <span className="text-red-600 ml-1">({r.failed_count} fail)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {durationStr(r.started_at, r.ended_at)}
                  </td>
                  <td className="px-3 py-2 text-gray-600" title={r.started_at}>
                    {timeAgo(r.started_at)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600">{r.agent_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
