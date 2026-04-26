// Structured JSON-line logger for OMA workers.
//
// One JSON object per line so Workers Logs / Logpush consumers (Datadog,
// Honeycomb, BigQuery, etc.) can index by field instead of regex-parsing
// freeform strings. Bind `wrangler tail --format json` to view locally.
//
// Usage:
//   import { log, logWarn, logError } from "@open-managed-agents/shared";
//   log({ op: "session.create", session_id, tenant_id }, "session created");
//   logError({ op: "session.delete.cleanup", session_id, err }, "cleanup failed");
//
// Conventions:
//   - `op` is "<area>.<verb>" — the primary grouping key for dashboards.
//   - `err` is auto-normalized: Error → {message, name, stack[:6]}, string passes
//     through, anything else gets JSON.stringify. Never log a raw Error directly
//     because `String(err)` collapses the stack.
//   - Always include the IDs you have in scope (session_id, tenant_id, agent_id)
//     so post-hoc grep can correlate to a specific request.

export interface LogContext {
  /** Structured operation tag, e.g. "session.delete.cleanup". The primary
   *  field used for dashboards / alerts / metric grouping. */
  op?: string;
  session_id?: string;
  tenant_id?: string;
  agent_id?: string;
  seq?: number;
  /** Any thrown value. Errors get message/name/stack extracted; other values
   *  are stringified. Never include raw Errors elsewhere — they collapse. */
  err?: unknown;
  [key: string]: unknown;
}

interface NormalizedErr {
  message: string;
  name: string;
  stack?: string;
  cause?: string;
}

function normalizeErr(err: unknown): NormalizedErr | string {
  if (err instanceof Error) {
    const out: NormalizedErr = {
      message: err.message || "(empty)",
      name: err.name,
    };
    if (err.stack) {
      // Top 6 frames keeps lines readable; full stack lives in source maps.
      out.stack = err.stack.split("\n").slice(0, 6).join("\n");
    }
    if ("cause" in err && err.cause !== undefined) {
      out.cause = String(err.cause);
    }
    return out;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function emit(level: "info" | "warn" | "error", ctx: LogContext, msg: string): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    entry[k] = k === "err" ? normalizeErr(v) : v;
  }
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Last-ditch: a context value isn't serializable. Fall back to a
    // hand-built record so we at least get level + msg.
    line = JSON.stringify({ ts: entry.ts, level, msg, _serialize_failed: true });
  }
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export function log(ctx: LogContext, msg: string): void {
  emit("info", ctx, msg);
}

export function logWarn(ctx: LogContext, msg: string): void {
  emit("warn", ctx, msg);
}

export function logError(ctx: LogContext, msg: string): void {
  emit("error", ctx, msg);
}
