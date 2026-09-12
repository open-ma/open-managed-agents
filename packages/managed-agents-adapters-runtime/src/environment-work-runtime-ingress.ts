import type {
  EnvironmentWorkExecutionFence,
  RuntimeProducedSessionEvent,
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import { decodeRuntimeProducedSessionEvent } from "./index";

const MAX_EVENTS_PER_BATCH = 100;

export type EnvironmentWorkRuntimeIngressClaim =
  EnvironmentWorkExecutionFence;

export type EnvironmentWorkRuntimeIngressResult =
  | { type: "recorded"; eventIds: string[] }
  | { type: "invalid_request"; message: string }
  | { type: "forbidden" }
  | { type: "not_found" }
  | { type: "stale_claim" }
  | { type: "version_conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBatch(body: unknown):
  | { events: RuntimeProducedSessionEvent[] }
  | { error: string } {
  if (
    !isRecord(body)
    || Object.keys(body).some((key) => key !== "events")
    || !Array.isArray(body.events)
    || body.events.length < 1
    || body.events.length > MAX_EVENTS_PER_BATCH
  ) {
    return {
      error: `Request body must contain 1 to ${MAX_EVENTS_PER_BATCH} runtime events`,
    };
  }
  const events: RuntimeProducedSessionEvent[] = [];
  const ids = new Set<string>();
  for (const raw of body.events) {
    const event = decodeRuntimeProducedSessionEvent(raw);
    if (event === null) {
      return { error: "Request contains an invalid runtime-produced event" };
    }
    if (ids.has(event.id)) {
      return { error: `Request contains duplicate event ID ${event.id}` };
    }
    ids.add(event.id);
    events.push(event);
  }
  return { events };
}

/**
 * Shared Node/Cloudflare protocol kernel for the private in-sandbox event
 * ingress. Authentication supplies `claim`; this function never trusts a
 * Work identity from the request body.
 */
export async function ingestEnvironmentWorkRuntimeEvents(input: {
  claim: EnvironmentWorkRuntimeIngressClaim;
  sessionId: string;
  body: unknown;
  projection: SessionRuntimeProjectionApplicationPort;
  publish(event: RuntimeProducedSessionEvent): Promise<void>;
}): Promise<EnvironmentWorkRuntimeIngressResult> {
  if (input.sessionId !== input.claim.sessionId) return { type: "forbidden" };
  const decoded = decodeBatch(input.body);
  if ("error" in decoded) {
    return { type: "invalid_request", message: decoded.error };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await input.projection.recordSessionRuntimeEvents({
      sessionId: input.sessionId,
      events: decoded.events,
      environmentWorkFence: input.claim,
    });
    if (result.type === "version_conflict") continue;
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "execution_fence_lost") return { type: "stale_claim" };
    for (const event of decoded.events) await input.publish(event);
    return { type: "recorded", eventIds: decoded.events.map((event) => event.id) };
  }
  return { type: "version_conflict" };
}
