import { generateEventId, type SessionErrorEvent } from "@open-managed-agents/shared";

/** Warmup failures enter both the live stream and the canonical projection.
 * Stamp the event at its source so neither path can expose a legacy,
 * schema-invalid agent.message frame. */
export function createSandboxWarmupFailureEvent(
  error: unknown,
): SessionErrorEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "session.error",
    id: `sevt_${generateEventId()}`,
    processed_at: new Date().toISOString(),
    error: `Sandbox warmup failed: ${message}`,
  };
}
