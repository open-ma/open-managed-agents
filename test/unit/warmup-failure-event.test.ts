import { describe, expect, it } from "vitest";

import { decodeRuntimeEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { sessionStreamEventResponseSchema } from "../../packages/managed-agents-api/src/contracts/session-events";
import { toStreamSessionEventResponse } from "../../packages/managed-agents-api/src/mappers/session-events";
import { createSandboxWarmupFailureEvent } from "../../apps/agent/src/runtime/warmup-failure-event";

describe("sandbox warmup failure event", () => {
  it("survives the runtime projection as an official Managed Agents stream event", () => {
    const raw = createSandboxWarmupFailureEvent(new Error("mount failed"));
    const [projected] = decodeRuntimeEvent(raw, new Set());

    expect(raw).toMatchObject({
      type: "session.error",
      error: "Sandbox warmup failed: mount failed",
    });
    expect(raw.id).toMatch(/^sevt_/);
    expect(raw.processed_at).toEqual(expect.any(String));
    expect(projected).toBeDefined();
    expect(
      sessionStreamEventResponseSchema.safeParse(
        toStreamSessionEventResponse(projected!),
      ).success,
    ).toBe(true);
  });
});
