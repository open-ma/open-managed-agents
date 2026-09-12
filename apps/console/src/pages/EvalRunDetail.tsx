import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useApiQuery } from "../lib/useApiQuery";
import { shortenId } from "../lib/format";
import type { Trajectory } from "../lib/trajectory";
import { rewardHeadline } from "../lib/trajectory";
import { Page } from "../components/Page";

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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Run detail with auto-poll while the run is unfinished. Using TQ's
  // refetchInterval so we don't have to hand-roll the cleanup-on-unmount
  // dance the previous useEffect did. Returning `false` stops the poll
  // once the run reaches a terminal state.
  const {
    data: run,
    isLoading: loading,
    error: queryError,
  } = useApiQuery<EvalRunDetail>(
    id ? `/v1/oma/evals/runs/${id}` : null,
    undefined,
    {
      refetchInterval: (query) => {
        const r = query.state.data as EvalRunDetail | undefined;
        if (!r) return false;
        return r.status === "pending" || r.status === "running" ? 5_000 : false;
      },
    },
  );
  const error = queryError instanceof Error ? queryError.message : queryError ? String(queryError) : null;

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
    <Page>
      <div className="console-detail-stack">
      {/* Page header — AppBreadcrumb above renders `Eval Runs > <run.id>`,
          so the previous `← All runs` back-link + duplicated `<h1>{run.id}</h1>`
          have been removed.

          Wireless treatment (matches SessionDetail): a status pill row,
          then ONE horizontal metadata strip — no card outlines, no
          per-metric framed boxes, no dividers between sections. Submitted
          timestamp + pass/tasks/duration/agent/env all collapse into the
          single strip below the pill. */}
      <div className="space-y-2">
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(run.status)}`}>
          {run.status}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          <span>
            Submitted{" "}
            <span className="text-fg">
              {new Date(run.started_at).toLocaleString(undefined, {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Pass{" "}
            <span className="text-fg font-medium">
              {totalTrials > 0 ? `${totalPass}/${totalTrials}` : "—"}
            </span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Tasks{" "}
            <span className="text-fg font-medium">
              {run.completed_count}/{run.task_count}
            </span>
            {run.failed_count > 0 && (
              <span className="text-danger"> ({run.failed_count} failed)</span>
            )}
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Duration{" "}
            <span className="text-fg font-medium">{durationStr(run.started_at, run.ended_at)}</span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="inline-flex items-center gap-1">
            <span>Agent</span>
            <Link
              to={`/agents/${run.agent_id}`}
              className="font-mono text-xs text-fg hover:text-brand"
              title={run.agent_id}
            >
              {shortenId(run.agent_id)}
            </Link>
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="inline-flex items-center gap-1">
            <span>Env</span>
            <Link
              to={`/environments/${run.environment_id}`}
              className="font-mono text-xs text-fg hover:text-brand"
              title={run.environment_id}
            >
              {shortenId(run.environment_id)}
            </Link>
          </span>
        </div>
      </div>

      {run.error && (
        <div className="bg-danger-subtle/40 rounded-lg p-3">
          <div className="text-sm font-semibold text-danger mb-1">Run-level error</div>
          <pre className="text-xs whitespace-pre-wrap text-fg">{run.error}</pre>
        </div>
      )}

      {/* Task list — pill-row recipe lifted from DataTable: border-separate
          + border-spacing-y-1.5, body rows tinted bg-bg-surface/60 with
          rounded first/last cells, no row borders, no table outline.
          Header row is plain <TableHeader> with small muted text — no border-b. */}
      <div className="console-detail-table-wrap" data-testid="eval-results-table">
        <Table className="console-detail-table">
          <TableHeader variant="wireless">
            <TableRow variant="wireless">
              <TableHead className="w-8 px-3 text-left" />
              <TableHead className="text-left px-3">Task</TableHead>
              <TableHead className="text-left px-3">Status</TableHead>
              <TableHead className="text-left px-3">Pass</TableHead>
              <TableHead className="text-left px-3">Trials</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.tasks.map(t => {
              const isOpen = expanded.has(t.id);
              return [
                <TableRow
                  variant="wireless"
                  key={t.id}
                  className="bg-bg-surface/60 hover:bg-bg-surface cursor-pointer transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                  onClick={() => toggleExpand(t.id)}
                >
                  <TableCell className="text-fg-subtle px-3 py-2 text-center rounded-l-lg">{isOpen ? "▾" : "▸"}</TableCell>
                  <TableCell className="px-3 py-2 font-mono text-xs text-fg">{t.id}</TableCell>
                  <TableCell className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(t.status)}`}>
                      {t.status}
                    </span>
                  </TableCell>
                  <TableCell className="px-3 py-2 text-fg font-medium">
                    {(t.trial_pass_count ?? 0)}/{t.trial_total ?? t.trials.length}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-fg-muted rounded-r-lg">
                    {t.trials.map(tr => tr.status).join(", ")}
                  </TableCell>
                </TableRow>,
                isOpen && (
                  // Expansion sits as its own subtle pill directly below the
                  // task pill — 6 px row gap (from border-spacing-y-1.5) is
                  // enough proximity to read as "detail of the row above"
                  // without needing a connecting border.
                  <TableRow key={`${t.id}-trials`} className="bg-bg-surface/30">
                    <TableCell className="rounded-l-lg" />
                    <TableCell colSpan={4} className="px-3 py-3 space-y-3 rounded-r-lg">
                      <div className="overflow-x-auto">
                        <Table className="w-full text-xs">
                        <TableHeader>
                          <TableRow className="text-fg-subtle">
                            <TableHead className="text-left py-1 pr-3 font-medium">#</TableHead>
                            <TableHead className="text-left py-1 pr-3 font-medium">Status</TableHead>
                            <TableHead className="text-left py-1 pr-3 font-medium">Reward</TableHead>
                            <TableHead className="text-left py-1 pr-3 font-medium">Exit</TableHead>
                            <TableHead className="text-left py-1 pr-3 font-medium">Dur</TableHead>
                            <TableHead className="text-left py-1 pr-3 font-medium">Turns</TableHead>
                            <TableHead className="text-left py-1 font-medium">Session</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {t.trials.map(tr => (
                            <TableRow key={tr.trial_index}>
                              <TableCell className="py-1 pr-3 text-fg-subtle">{tr.trial_index}</TableCell>
                              <TableCell className="py-1 pr-3">
                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(tr.status)}`}>
                                  {tr.status}
                                </span>
                              </TableCell>
                              <TableCell className="py-1 pr-3">
                                <TrialReward
                                  fallback={tr.reward}
                                  trajectory={undefined}
                                />
                              </TableCell>
                              <TableCell className="py-1 pr-3 font-mono text-fg-muted">{tr.exit_code ?? "—"}</TableCell>
                              <TableCell className="py-1 pr-3 text-fg-muted">{durationStr(tr.started_at, tr.ended_at)}</TableCell>
                              <TableCell className="py-1 pr-3 text-fg-muted">{tr.turns ?? "—"}</TableCell>
                              <TableCell className="py-1">
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
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      </div>


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
                                className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-64 text-fg"
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
                          <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-48 text-fg">
                            {t.spec.setup_script}
                          </pre>
                        </details>
                      )}

                      <details>
                        <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                          first message
                        </summary>
                        <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-48 whitespace-pre-wrap text-fg">
                          {t.spec.messages[0]}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ),
              ];
            })}
          </TableBody>
        </Table>
      </div>
      </div>
    </Page>
  );
}

/** Reward cell on a trial row.
 *
 *  Renders the reward already projected on the eval result. The optional
 *  trajectory branch remains reusable for a future Managed Session
 *  trajectory extension, but the Console never probes the retired OMA
 *  Session route.
 *
 *  Sentinel handling:
 *   - "loading" → small dim placeholder (no extra chrome)
 *   - "error"   → fallback + "trajectory unavailable" tooltip
 *   - undefined → fallback only (parent task wasn't expanded yet) */
function TrialReward({
  fallback,
  trajectory,
}: {
  fallback: number | undefined;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (trajectory && trajectory !== "loading" && trajectory !== "error" && trajectory.reward) {
    const r = trajectory.reward;
    const headline = rewardHeadline(r);
    const isPass = r.final_reward >= 0.99;
    const isFail = r.final_reward <= 0;
    const cls = isPass
      ? "text-success font-semibold"
      : isFail
      ? "text-danger font-semibold"
      : "text-fg";
    return (
      <div className="leading-tight">
        <div className={cls}>{headline}</div>
        {r.verifier_id && (
          <div className="text-xs text-fg-subtle font-mono">graded by {r.verifier_id}</div>
        )}
      </div>
    );
  }
  if (trajectory === "loading") {
    return <span className="text-fg-subtle text-xs">loading…</span>;
  }
  if (fallback != null) {
    const tooltip = trajectory === "error" ? "trajectory unavailable; using legacy reward" : undefined;
    return (
      <span
        className={fallback >= 1 ? "text-success font-semibold" : "text-fg-subtle"}
        title={tooltip}
      >
        {fallback}
      </span>
    );
  }
  if (trajectory === "error") {
    return <span className="text-fg-subtle text-xs" title="trajectory fetch failed">trajectory unavailable</span>;
  }
  return <span className="text-fg-subtle">—</span>;
}

/** Per-trial raw_rewards table. Renders one row per criterion in
 *  `RewardResult.raw_rewards`. Hidden in a <details> in the parent so
 *  large multi-criterion verifiers don't blow out the row height. */
function RewardBreakdown({
  trialIndex,
  reward,
}: {
  trialIndex: number;
  reward: { raw_rewards: Record<string, number>; final_reward: number; verifier_id?: string };
}) {
  const entries = Object.entries(reward.raw_rewards);
  return (
    <div className="rounded p-2 bg-bg-surface/60">
      <div className="text-xs text-fg-subtle mb-1 flex items-baseline gap-2">
        <span>trial {trialIndex}</span>
        {reward.verifier_id && (
          <span className="font-mono">{reward.verifier_id}</span>
        )}
        <span className="ml-auto text-fg">
          final = <span className="font-semibold">{reward.final_reward.toFixed(2)}</span>
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-fg-subtle italic">no raw_rewards recorded</div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-xs">
            <TableBody>
              {entries.map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="py-0.5 pr-2 font-mono text-fg-muted">{k}</TableCell>
                  <TableCell className="py-0.5 text-right text-fg">{Number.isFinite(v) ? v.toFixed(2) : String(v)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
