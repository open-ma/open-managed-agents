// Sandbox active-time metering. Mirrors the workspace-backups.ts shape:
// a thin D1 writer the OmaSandbox calls from its lifecycle hooks.
//
// Why agent worker writes directly (vs. routing through main worker):
//   - Same AUTH_DB binding the agent already holds for backup recording
//     and credential lookups, so no extra service-binding hop.
//   - onStop fires during container teardown; the round-trip budget is
//     measured in milliseconds, not seconds. A direct INSERT is the
//     shortest path that survives the teardown deadline.
//   - Best-effort: failures log + return; never throw. Container is
//     already shutting down, blocking on a metric write would either
//     stall the teardown or mask the real exit reason.

import { logWarn } from "@open-managed-agents/shared";

export interface SandboxUsageEvent {
  tenantId: string;
  sessionId: string;
  agentId?: string;
  environmentId?: string;
  startedAt: number;
  endedAt: number;
  sandboxActiveSeconds: number;
  exitCode?: number;
  exitReason?: string;
}

export async function recordSandboxUsage(
  db: D1Database,
  ev: SandboxUsageEvent,
): Promise<void> {
  try {
    const id = `ue_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO usage_events (
           id, tenant_id, session_id, agent_id, environment_id,
           event_type, runtime_kind,
           sandbox_active_seconds, started_at, ended_at,
           exit_code, exit_reason, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 'sandbox_active', 'cloud', ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        id,
        ev.tenantId,
        ev.sessionId,
        ev.agentId ?? null,
        ev.environmentId ?? null,
        ev.sandboxActiveSeconds,
        ev.startedAt,
        ev.endedAt,
        ev.exitCode ?? null,
        ev.exitReason ?? null,
        Date.now(),
      )
      .run();
  } catch (err) {
    logWarn(
      {
        op: "usage_events.record",
        tenant_id: ev.tenantId,
        session_id: ev.sessionId,
        active_seconds: ev.sandboxActiveSeconds,
        err: (err as Error)?.message ?? String(err),
      },
      "usage_events insert failed (best-effort)",
    );
  }
}
