import { useNavigate } from "react-router";
import { useApiQuery } from "../lib/useApiQuery";
import { ListPage } from "../components/ListPage";

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
  const nav = useNavigate();

  // Auto-poll every 5s only while at least one run is still pending or
  // running. TQ inspects the cached `data` on each tick to decide, so a
  // run reaching a terminal state pauses the poll on its own — matches
  // the previous `anyActive` guard without the manual setInterval +
  // cancelled flag dance.
  const { data: runsRes, isLoading: loading } = useApiQuery<{ data: EvalRunSummary[] }>(
    "/v1/evals/runs",
    { limit: "100" },
    {
      refetchInterval: (query) => {
        const data = query.state.data as { data: EvalRunSummary[] } | undefined;
        const anyActive = !!data?.data.some(
          (r) => r.status === "pending" || r.status === "running",
        );
        return anyActive ? 5_000 : false;
      },
    },
  );
  const runs = runsRes?.data ?? [];

  return (
    <ListPage<EvalRunSummary>
      title="Eval Runs"
      subtitle="Benchmark trajectories submitted via the eval API."
      data={runs}
      loading={loading}
      getRowKey={(r) => r.id}
      onRowClick={(r) => nav(`/evals/${r.id}`)}
      emptyTitle="No eval runs yet"
      emptyKind="eval"
      emptySubtitle={
        <p>
          Submit one with{" "}
          <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">POST /v1/evals/runs</code>{" "}
          or{" "}
          <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">npx tsx rl/tasks/terminal-bench/run-cloud.ts</code>.
        </p>
      }
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[220px]",
          render: (r) => <span title={r.id}>{r.id}</span>,
        },
        {
          key: "status",
          label: "Status",
          render: (r) => (
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(r.status)}`}>
              {r.status}
            </span>
          ),
        },
        {
          key: "pass_rate",
          label: "Pass rate",
          className: "text-fg font-medium",
          render: (r) => passRateStr(r),
        },
        {
          key: "tasks",
          label: "Tasks",
          className: "text-fg-muted",
          render: (r) => (
            <>
              {r.completed_count}/{r.task_count}
              {r.failed_count > 0 && (
                <span className="text-danger ml-1">({r.failed_count} fail)</span>
              )}
            </>
          ),
        },
        {
          key: "duration",
          label: "Duration",
          className: "text-fg-muted",
          render: (r) => durationStr(r.started_at, r.ended_at),
        },
        {
          key: "started",
          label: "Started",
          className: "text-fg-muted",
          render: (r) => <span title={r.started_at}>{timeAgo(r.started_at)}</span>,
        },
        {
          key: "agent",
          label: "Agent",
          className: "font-mono text-xs text-fg-muted",
          render: (r) => r.agent_id,
        },
      ]}
    />
  );
}
