import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../lib/api";
import { StatusPill } from "../components/Badge";

interface EvalTrial {
  trial_index: number;
  status: "pending" | "running" | "completed" | "failed";
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  finalize_attempts?: number;
  reward?: number;
  exit_code?: number;
  duration_seconds?: number;
  turns?: number;
  output_tail?: string;
}

interface EvalTask {
  id: string;
  spec: {
    id: string;
    messages: string[];
    setup_files?: { path: string; content: string }[];
    setup_script?: string;
    timeout_ms?: number;
    trials?: number;
  };
  status: "pending" | "running" | "completed" | "failed";
  trials: EvalTrial[];
  trial_pass_count?: number;
  trial_total?: number;
}

interface EvalRunDetail {
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
  tasks: EvalTask[];
}

function statusToPill(s: string): "running" | "completed" | "errored" | "idle" {
  if (s === "completed") return "completed";
  if (s === "failed") return "errored";
  if (s === "running") return "running";
  return "idle";
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

export function EvalRunDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const nav = useNavigate();
  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const r = await api<EvalRunDetail>(`/v1/evals/runs/${id}`);
        if (cancelled) return;
        setRun(r);
        setLoading(false);
        if (r.status === "pending" || r.status === "running") {
          timer = window.setTimeout(load, 5_000);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, api]);

  function toggleExpand(taskId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!run) return <div className="p-6 text-sm text-gray-500">Run not found.</div>;

  let totalPass = 0;
  let totalTrials = 0;
  for (const t of run.tasks) {
    totalPass += t.trial_pass_count ?? 0;
    totalTrials += t.trial_total ?? 0;
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <button
          onClick={() => nav("/evals")}
          className="text-sm text-blue-600 hover:underline"
        >
          ← All runs
        </button>
      </div>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold font-mono">{run.id}</h1>
        <StatusPill status={statusToPill(run.status)} label={run.status} />
      </div>

      <div className="grid grid-cols-4 gap-4 border rounded p-4 text-sm">
        <div>
          <div className="text-xs text-gray-500">Pass rate</div>
          <div className="text-lg font-semibold">
            {totalTrials > 0 ? `${totalPass}/${totalTrials}` : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Tasks</div>
          <div className="text-lg font-semibold">
            {run.completed_count}/{run.task_count}
            {run.failed_count > 0 && (
              <span className="text-red-600 text-sm ml-1">({run.failed_count} fail)</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Duration</div>
          <div className="text-lg font-semibold">{durationStr(run.started_at, run.ended_at)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Started</div>
          <div className="text-sm font-mono" title={run.started_at}>
            {new Date(run.started_at).toLocaleString()}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500 mb-1">Agent</div>
          <Link
            to={`/agents/${run.agent_id}`}
            className="font-mono text-blue-600 hover:underline"
          >
            {run.agent_id}
          </Link>
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500 mb-1">Environment</div>
          <span className="font-mono">{run.environment_id}</span>
        </div>
      </div>

      {run.error && (
        <div className="border border-red-300 bg-red-50 rounded p-3 text-sm">
          <div className="font-semibold text-red-700">Run-level error</div>
          <pre className="mt-1 text-xs whitespace-pre-wrap text-red-800">{run.error}</pre>
        </div>
      )}

      <div className="border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs text-gray-600">
              <th className="px-3 py-2 w-8" />
              <th className="px-3 py-2">Task</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Pass</th>
              <th className="px-3 py-2">Trials</th>
            </tr>
          </thead>
          <tbody>
            {run.tasks.map(t => {
              const isOpen = expanded.has(t.id);
              return [
                <tr key={t.id} className="border-t">
                  <td className="px-3 py-2 cursor-pointer" onClick={() => toggleExpand(t.id)}>
                    {isOpen ? "▼" : "▶"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{t.id}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={statusToPill(t.status)} label={t.status} />
                  </td>
                  <td className="px-3 py-2">
                    {(t.trial_pass_count ?? 0)}/{t.trial_total ?? t.trials.length}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {t.trials.map(tr => tr.status).join(", ")}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`${t.id}-trials`} className="border-t bg-gray-50">
                    <td />
                    <td colSpan={4} className="px-3 py-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500">
                            <th className="text-left py-1 pr-3">#</th>
                            <th className="text-left py-1 pr-3">Status</th>
                            <th className="text-left py-1 pr-3">Reward</th>
                            <th className="text-left py-1 pr-3">Exit</th>
                            <th className="text-left py-1 pr-3">Dur</th>
                            <th className="text-left py-1 pr-3">Turns</th>
                            <th className="text-left py-1">Session</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.trials.map(tr => (
                            <tr key={tr.trial_index}>
                              <td className="py-1 pr-3 text-gray-500">{tr.trial_index}</td>
                              <td className="py-1 pr-3">
                                <StatusPill status={statusToPill(tr.status)} label={tr.status} />
                              </td>
                              <td className="py-1 pr-3">
                                {tr.reward != null ? (
                                  <span
                                    className={
                                      tr.reward >= 1
                                        ? "text-green-700 font-semibold"
                                        : "text-gray-500"
                                    }
                                  >
                                    {tr.reward}
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="py-1 pr-3 font-mono">{tr.exit_code ?? "—"}</td>
                              <td className="py-1 pr-3">
                                {durationStr(tr.started_at, tr.ended_at)}
                              </td>
                              <td className="py-1 pr-3">{tr.turns ?? "—"}</td>
                              <td className="py-1">
                                {tr.session_id ? (
                                  <Link
                                    to={`/sessions/${tr.session_id}`}
                                    className="text-blue-600 hover:underline font-mono"
                                  >
                                    {tr.session_id}
                                  </Link>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                          {t.trials.some(tr => tr.error) && (
                            <tr>
                              <td colSpan={7} className="py-1 text-red-700">
                                {t.trials
                                  .filter(tr => tr.error)
                                  .map(tr => (
                                    <div key={tr.trial_index}>
                                      trial {tr.trial_index}: {tr.error}
                                    </div>
                                  ))}
                              </td>
                            </tr>
                          )}
                          {t.trials.some(tr => tr.output_tail) && (
                            <tr>
                              <td colSpan={7} className="py-1">
                                <details>
                                  <summary className="cursor-pointer text-gray-600">
                                    verify_script output (tail)
                                  </summary>
                                  {t.trials
                                    .filter(tr => tr.output_tail)
                                    .map(tr => (
                                      <pre
                                        key={tr.trial_index}
                                        className="mt-1 p-2 bg-white border rounded text-[11px] overflow-auto max-h-64"
                                      >
                                        trial {tr.trial_index}:{"\n"}
                                        {tr.output_tail}
                                      </pre>
                                    ))}
                                </details>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                      {t.spec.setup_script && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-gray-600 text-xs">
                            setup_script
                          </summary>
                          <pre className="mt-1 p-2 bg-white border rounded text-[11px] overflow-auto max-h-48">
                            {t.spec.setup_script}
                          </pre>
                        </details>
                      )}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-gray-600 text-xs">
                          first message
                        </summary>
                        <pre className="mt-1 p-2 bg-white border rounded text-[11px] overflow-auto max-h-48 whitespace-pre-wrap">
                          {t.spec.messages[0]}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
