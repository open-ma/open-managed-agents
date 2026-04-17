// Structured log helper.
//
// Every log line in main worker / SessionDO / sandbox / model proxy should
// carry session_id (and seq when in event-loop scope) so production logs
// (`wrangler tail | grep session=sess-xxx`) cross-reference precisely with the
// trajectory's events array (look up `seq=N` to find the event that triggered
// the log line).
//
// Usage:
//   import { log } from "@open-managed-agents/shared";
//   log({ session_id: "sess-xxx", seq: 42, attempt: 3 }, "model retry");
//   // → [session=sess-xxx seq=42] model retry attempt=3

export interface LogContext {
  session_id?: string;
  seq?: number;
  [key: string]: unknown;
}

function fmtPrefix(ctx: LogContext): string {
  const parts: string[] = [];
  if (ctx.session_id) parts.push(`session=${ctx.session_id}`);
  if (ctx.seq !== undefined) parts.push(`seq=${ctx.seq}`);
  return parts.length > 0 ? `[${parts.join(" ")}]` : "";
}

function fmtFields(ctx: LogContext): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "session_id" || key === "seq") continue;
    if (value === undefined) continue;
    const v = typeof value === "string" ? value : JSON.stringify(value);
    fields.push(`${key}=${v}`);
  }
  return fields.length > 0 ? " " + fields.join(" ") : "";
}

export function log(ctx: LogContext, msg: string): void {
  const prefix = fmtPrefix(ctx);
  const fields = fmtFields(ctx);
  console.log(`${prefix} ${msg}${fields}`.trim());
}

export function logError(ctx: LogContext, msg: string): void {
  const prefix = fmtPrefix(ctx);
  const fields = fmtFields(ctx);
  console.error(`${prefix} ${msg}${fields}`.trim());
}

export function logWarn(ctx: LogContext, msg: string): void {
  const prefix = fmtPrefix(ctx);
  const fields = fmtFields(ctx);
  console.warn(`${prefix} ${msg}${fields}`.trim());
}
