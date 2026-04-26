// Analytics Engine writer for OMA error/event metrics.
//
// AE is wider but cheaper than Logpush — datasets give you SQL queries +
// Grafana dashboards over high-cardinality dims (op, tenant_id, error_name)
// without paying per-byte log storage. Use AE for things you might want to
// alert on; use logError() for things you need to read in narrative form.
//
// Wire (per worker that needs it):
//   wrangler.jsonc:
//     "analytics_engine_datasets": [
//       { "binding": "ANALYTICS", "dataset": "oma_events" }
//     ]
//
// Schema convention (DO NOT reorder — column positions are load-bearing for
// existing queries):
//   indexes: [op]
//   blobs:   [op, tenant_id, session_id, agent_id, error_name, error_message]
//   doubles: [duration_ms]   // optional, defaults to 0
//
// Example query (CF SQL API):
//   SELECT blob1 AS op, blob5 AS error_name, count() AS n
//   FROM oma_events
//   WHERE timestamp > NOW() - INTERVAL '1' HOUR
//   GROUP BY op, error_name
//   ORDER BY n DESC

export interface AnalyticsBinding {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

export interface RecordableEvent {
  /** Required. "<area>.<verb>", e.g. "session.delete.cleanup_failed". */
  op: string;
  tenant_id?: string;
  session_id?: string;
  agent_id?: string;
  /** Error class name from `err.name`, e.g. "TypeError". */
  error_name?: string;
  /** Free-form short description; truncated to 500 chars. */
  error_message?: string;
  duration_ms?: number;
}

/** Truncation guard: AE blob limit is 5KB combined; keep individual fields short. */
const MAX_MESSAGE_LEN = 500;

/**
 * Fire-and-forget event write to Analytics Engine. Safe to call when the
 * binding is missing (dev / tests) — becomes a no-op. Never throws into the
 * caller, since observability code must not break the request path.
 */
export function recordEvent(
  ae: AnalyticsBinding | undefined | null,
  event: RecordableEvent,
): void {
  if (!ae) return;
  try {
    ae.writeDataPoint({
      indexes: [event.op],
      blobs: [
        event.op,
        event.tenant_id ?? "",
        event.session_id ?? "",
        event.agent_id ?? "",
        event.error_name ?? "",
        (event.error_message ?? "").slice(0, MAX_MESSAGE_LEN),
      ],
      doubles: [event.duration_ms ?? 0],
    });
  } catch {
    // Intentional: AE writes are non-essential. A failure here must not bubble
    // up — callers depend on this being side-effect-only. The actual error,
    // if any, will surface in Workers Logs from the AE runtime separately.
  }
}

/**
 * Extract `error_name` + `error_message` from any thrown value, for direct
 * use in `recordEvent({ ... })` calls. Mirrors the normalization in log.ts so
 * structured logs and AE rows agree on naming.
 */
export function errFields(err: unknown): { error_name: string; error_message: string } {
  if (err instanceof Error) {
    return {
      error_name: err.name || "Error",
      error_message: err.message || "(empty)",
    };
  }
  if (typeof err === "string") {
    return { error_name: "string", error_message: err };
  }
  return { error_name: typeof err, error_message: String(err) };
}
