import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { ListPage } from "../components/ListPage";

interface UsageEvent {
  id: string;
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  environment_id: string | null;
  event_type: string;
  runtime_kind: "cloud" | "local" | string;
  sandbox_active_seconds: number;
  started_at: number;
  ended_at: number;
  exit_code: number | null;
  exit_reason: string | null;
  created_at: number;
}

interface SummaryBucket {
  bucket_start: number;
  runtime_kind: string;
  event_count: number;
  total_seconds: number;
}

interface SummaryResponse {
  period: "day" | "week" | "month";
  window_ms: number;
  buckets: SummaryBucket[];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function ExitChip({ code, reason }: { code: number | null; reason: string | null }) {
  if (code == null) return null;
  // Common exit codes: 0 graceful, 137 SIGKILL/OOM, 143 SIGTERM
  const tone =
    code === 0 || code === 143
      ? "bg-success-subtle text-success"
      : "bg-warning-subtle text-warning";
  return (
    <span
      className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded ${tone}`}
      title={reason ?? `exit ${code}`}
    >
      exit {code}
    </span>
  );
}

function RuntimeChip({ kind }: { kind: string }) {
  const tone =
    kind === "cloud"
      ? "bg-info-subtle text-info"
      : "bg-bg-surface text-fg-muted";
  return (
    <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded ${tone}`}>
      {kind}
    </span>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-border rounded-md p-3 bg-bg">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
      <div className="text-[11px] text-fg-subtle mt-0.5">{sub}</div>
    </div>
  );
}

export function UsageList() {
  const { api } = useApi();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");

  const {
    items: events,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useCursorList<UsageEvent>("/v1/usage/sessions", { limit: 50 });

  useEffect(() => {
    let cancelled = false;
    api<SummaryResponse>(`/v1/usage/summary?period=${period}`).then(
      (r) => { if (!cancelled) setSummary(r); },
      () => { /* api hook already toasts */ },
    );
    return () => { cancelled = true; };
  }, [api, period]);

  const totals = summary?.buckets.reduce(
    (acc, b) => {
      if (b.runtime_kind === "cloud") {
        acc.cloudSeconds += b.total_seconds;
        acc.cloudEvents += b.event_count;
      } else {
        acc.localSeconds += b.total_seconds;
        acc.localEvents += b.event_count;
      }
      return acc;
    },
    { cloudSeconds: 0, cloudEvents: 0, localSeconds: 0, localEvents: 0 },
  ) ?? null;

  const periodLabel =
    period === "day" ? "60 days" : period === "week" ? "60 weeks" : "60 months";

  const subtitle = (
    <div className="flex flex-col gap-3 mt-2">
      <div>
        Sandbox active time per session. Cloud sandbox is what CF Containers
        bill on; local-runtime sessions are recorded for visibility.
      </div>
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-1">
          <SummaryCard label="Cloud sandbox" value={formatDuration(totals.cloudSeconds)} sub={`${totals.cloudEvents} sessions / last ${periodLabel}`} />
          <SummaryCard label="Local runtime" value={formatDuration(totals.localSeconds)} sub={`${totals.localEvents} sessions / last ${periodLabel}`} />
          <SummaryCard label="Total events" value={String(totals.cloudEvents + totals.localEvents)} sub={`last ${periodLabel}`} />
          <SummaryCard label="Bucket size" value={period} sub={`Δ = 1 ${period}`} />
        </div>
      )}
    </div>
  );

  return (
    <ListPage<UsageEvent>
      title="Usage"
      subtitle={subtitle}
      headerActions={
        <div className="flex items-center rounded-md bg-bg-surface p-0.5 gap-0.5 text-xs">
          {(["day", "week", "month"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2.5 py-1 rounded transition-colors ${
                period === p
                  ? "bg-bg text-fg font-medium shadow-sm"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      }
      data={events}
      loading={loading}
      emptyTitle="No sandbox sessions yet"
      emptySubtitle="Start an agent session to see activity here."
      hasMore={hasMore}
      onLoadMore={loadMore}
      loadingMore={isLoadingMore}
      getRowKey={(ev) => ev.id}
      onRowClick={(ev) => { window.location.href = `/sessions/${ev.session_id}`; }}
      columns={[
        {
          key: "session_id",
          label: "Session",
          render: (ev) => (
            <span className="font-mono text-xs truncate" title={ev.session_id}>
              {ev.session_id}
            </span>
          ),
        },
        {
          key: "runtime_kind",
          label: "Runtime",
          render: (ev) => <RuntimeChip kind={ev.runtime_kind} />,
        },
        {
          key: "agent_id",
          label: "Agent",
          render: (ev) =>
            ev.agent_id ? (
              <span className="font-mono text-xs text-fg-muted" title={ev.agent_id}>
                {ev.agent_id.slice(0, 12)}
              </span>
            ) : (
              <span className="text-fg-subtle">—</span>
            ),
        },
        {
          key: "started_at",
          label: "Started",
          render: (ev) => <span className="text-xs text-fg-muted">{formatTimestamp(ev.started_at)}</span>,
        },
        {
          key: "sandbox_active_seconds",
          label: "Active",
          className: "text-right font-mono",
          render: (ev) => formatDuration(ev.sandbox_active_seconds),
        },
        {
          key: "exit_code",
          label: "Exit",
          render: (ev) => <ExitChip code={ev.exit_code} reason={ev.exit_reason} />,
        },
      ]}
    />
  );
}
