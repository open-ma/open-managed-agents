import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../lib/api";

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

function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    default:          return "bg-bg-surface text-fg-muted";
  }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }
  if (error) return <div className="text-center py-16 text-danger">{error}</div>;
  if (!run) return <div className="text-center py-16 text-fg-subtle">Run not found.</div>;

  let totalPass = 0;
  let totalTrials = 0;
  for (const t of run.tasks) {
    totalPass += t.trial_pass_count ?? 0;
    totalTrials += t.trial_total ?? 0;
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={() => nav("/evals")}
          className="text-sm text-fg-subtle hover:text-fg transition-colors"
        >
          ← All runs
        </button>
      </div>

      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg font-mono">{run.id}</h1>
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(run.status)}`}>
            {run.status}
          </span>
        </div>
        <p className="text-fg-muted text-sm">Submitted {new Date(run.started_at).toLocaleString()}</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="border border-border rounded-lg p-4">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Pass rate</div>
          <div className="text-2xl font-semibold text-fg">
            {totalTrials > 0 ? `${totalPass}/${totalTrials}` : "—"}
          </div>
        </div>
        <div className="border border-border rounded-lg p-4">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Tasks</div>
          <div className="text-2xl font-semibold text-fg">
            {run.completed_count}/{run.task_count}
          </div>
          {run.failed_count > 0 && (
            <div className="text-danger text-xs mt-0.5">{run.failed_count} failed</div>
          )}
        </div>
        <div className="border border-border rounded-lg p-4">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Duration</div>
          <div className="text-2xl font-semibold text-fg">{durationStr(run.started_at, run.ended_at)}</div>
        </div>
        <div className="border border-border rounded-lg p-4">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Started</div>
          <div className="text-sm font-mono text-fg-muted" title={run.started_at}>
            {new Date(run.started_at).toLocaleTimeString()}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-border rounded-lg p-3">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Agent</div>
          <Link
            to={`/agents/${run.agent_id}`}
            className="font-mono text-sm text-brand hover:underline"
          >
            {run.agent_id}
          </Link>
        </div>
        <div className="border border-border rounded-lg p-3">
          <div className="text-xs text-fg-subtle uppercase tracking-wider mb-1">Environment</div>
          <span className="font-mono text-sm text-fg-muted">{run.environment_id}</span>
        </div>
      </div>

      {run.error && (
        <div className="border border-danger-subtle bg-danger-subtle/40 rounded-lg p-3">
          <div className="text-sm font-semibold text-danger mb-1">Run-level error</div>
          <pre className="text-xs whitespace-pre-wrap text-fg">{run.error}</pre>
        </div>
      )}

      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
              <th className="w-8 px-2 py-2.5" />
              <th className="text-left px-4 py-2.5">Task</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Pass</th>
              <th className="text-left px-4 py-2.5">Trials</th>
            </tr>
          </thead>
          <tbody>
            {run.tasks.map(t => {
              const isOpen = expanded.has(t.id);
              return [
                <tr
                  key={t.id}
                  className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors"
                  onClick={() => toggleExpand(t.id)}
                >
                  <td className="text-fg-subtle px-2 py-3 text-center">{isOpen ? "▾" : "▸"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg">{t.id}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(t.status)}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg font-medium">
                    {(t.trial_pass_count ?? 0)}/{t.trial_total ?? t.trials.length}
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-muted">
                    {t.trials.map(tr => tr.status).join(", ")}
                  </td>
                </tr>,
                isOpen && (
                  <tr key={`${t.id}-trials`} className="border-t border-border bg-bg-surface">
                    <td />
                    <td colSpan={4} className="px-4 py-3 space-y-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-fg-subtle">
                            <th className="text-left py-1 pr-3 font-medium">#</th>
                            <th className="text-left py-1 pr-3 font-medium">Status</th>
                            <th className="text-left py-1 pr-3 font-medium">Reward</th>
                            <th className="text-left py-1 pr-3 font-medium">Exit</th>
                            <th className="text-left py-1 pr-3 font-medium">Dur</th>
                            <th className="text-left py-1 pr-3 font-medium">Turns</th>
                            <th className="text-left py-1 font-medium">Session</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.trials.map(tr => (
                            <tr key={tr.trial_index}>
                              <td className="py-1 pr-3 text-fg-subtle">{tr.trial_index}</td>
                              <td className="py-1 pr-3">
                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(tr.status)}`}>
                                  {tr.status}
                                </span>
                              </td>
                              <td className="py-1 pr-3">
                                {tr.reward != null ? (
                                  <span className={tr.reward >= 1 ? "text-success font-semibold" : "text-fg-subtle"}>
                                    {tr.reward}
                                  </span>
                                ) : (
                                  <span className="text-fg-subtle">—</span>
                                )}
                              </td>
                              <td className="py-1 pr-3 font-mono text-fg-muted">{tr.exit_code ?? "—"}</td>
                              <td className="py-1 pr-3 text-fg-muted">{durationStr(tr.started_at, tr.ended_at)}</td>
                              <td className="py-1 pr-3 text-fg-muted">{tr.turns ?? "—"}</td>
                              <td className="py-1">
                                {tr.session_id ? (
                                  <Link
                                    to={`/sessions/${tr.session_id}`}
                                    className="text-brand hover:underline font-mono"
                                  >
                                    {tr.session_id}
                                  </Link>
                                ) : (
                                  <span className="text-fg-subtle">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {t.trials.some(tr => tr.error) && (
                        <div className="text-xs text-danger space-y-0.5">
                          {t.trials
                            .filter(tr => tr.error)
                            .map(tr => (
                              <div key={tr.trial_index}>trial {tr.trial_index}: {tr.error}</div>
                            ))}
                        </div>
                      )}

                      {t.trials.some(tr => tr.output_tail) && (
                        <details>
                          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                            verify_script output (tail)
                          </summary>
                          {t.trials
                            .filter(tr => tr.output_tail)
                            .map(tr => (
                              <pre
                                key={tr.trial_index}
                                className="mt-1 p-2 bg-bg border border-border rounded text-[11px] overflow-auto max-h-64 text-fg"
                              >
                                trial {tr.trial_index}:{"\n"}
                                {tr.output_tail}
                              </pre>
                            ))}
                        </details>
                      )}

                      {t.spec.setup_script && (
                        <details>
                          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                            setup_script
                          </summary>
                          <pre className="mt-1 p-2 bg-bg border border-border rounded text-[11px] overflow-auto max-h-48 text-fg">
                            {t.spec.setup_script}
                          </pre>
                        </details>
                      )}

                      <details>
                        <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                          first message
                        </summary>
                        <pre className="mt-1 p-2 bg-bg border border-border rounded text-[11px] overflow-auto max-h-48 whitespace-pre-wrap text-fg">
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
