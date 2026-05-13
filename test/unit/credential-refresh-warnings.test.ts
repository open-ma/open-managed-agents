// Unit tests for OPE-12: pre-session credential refresh failures must surface
// as session.warning events (not silently swallowed).
//
// Covered: the pure helper that maps CredentialRefreshResult → SessionEvent[].
// The end-to-end "mock integrations binding → assert warning event in stream"
// flow is exercised at integration-test / staging level — the helper is the
// load-bearing piece since it owns the mapping logic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Pull through the route module's test namespace. Helper moved
// from routes/sessions.ts → lib/cf-session-lifecycle.ts during the
// sessions extraction (P2-followup).
import { __test__ } from "../../apps/main/src/lib/cf-session-lifecycle";

const { refreshResultToInitEvents } = __test__;

const CTX = { sessionId: "sess_1", tenantId: "tn_1" };

describe("refreshResultToInitEvents — silent failures eliminated", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("emits no events when refresh fully succeeded", () => {
    const result = { attempted: 2, succeeded: 2, failures: [] };
    const events = refreshResultToInitEvents(result, CTX);
    expect(events).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("emits no events when nothing was attempted (skippedReason set), but logs", () => {
    const result = {
      attempted: 0,
      succeeded: 0,
      failures: [],
      skippedReason: "no_integrations_binding" as const,
    };
    const events = refreshResultToInitEvents(result, CTX);
    expect(events).toEqual([]);
    // Skipped is a config/infra signal — log to stderr, don't pollute event stream.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Logger now emits structured JSON; assert by parsing the line.
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.op).toBe("session.start.credential_refresh.skipped");
    expect(parsed.reason).toBe("no_integrations_binding");
    expect(parsed.session_id).toBe(CTX.sessionId);
    expect(parsed.tenant_id).toBe(CTX.tenantId);
  });

  it("emits one warning event per failure (replaces silent .catch)", () => {
    const result = {
      attempted: 2,
      succeeded: 0,
      failures: [
        { provider: "github" as const, vaultId: "vlt_a", httpStatus: 500, error: "gateway returned 500" },
        { provider: "linear" as const, vaultId: "vlt_b", error: "fetch failed" },
      ],
    };
    const events = refreshResultToInitEvents(result, CTX);
    expect(events.length).toBe(2);
    for (const ev of events) {
      expect(ev.type).toBe("session.warning");
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Structured JSON now — parse and check fields instead of string match.
    const parsed = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(parsed.op).toBe("session.start.credential_refresh");
    expect(parsed.failed).toBe(2);
    expect(parsed.attempted).toBe(2);
  });

  it("warning event carries provider + vault + http status in details", () => {
    const result = {
      attempted: 1,
      succeeded: 0,
      failures: [
        { provider: "github" as const, vaultId: "vlt_a", httpStatus: 502, error: "bad gateway" },
      ],
    };
    const [event] = refreshResultToInitEvents(result, CTX);
    expect(event.type).toBe("session.warning");
    if (event.type !== "session.warning") throw new Error("type narrow");
    expect(event.source).toBe("credential_refresh");
    expect(event.message).toContain("github");
    expect(event.message).toContain("vlt_a");
    expect(event.message).toContain("on-401 retry"); // user-facing hint about non-fatality
    expect(event.details).toMatchObject({
      provider: "github",
      vault_id: "vlt_a",
      http_status: 502,
      error: "bad gateway",
    });
  });

  it("warning event omits http_status when failure was a network error (no http status)", () => {
    const result = {
      attempted: 1,
      succeeded: 0,
      failures: [
        { provider: "linear" as const, vaultId: "vlt_x", error: "ECONNREFUSED" },
      ],
    };
    const [event] = refreshResultToInitEvents(result, CTX);
    if (event.type !== "session.warning") throw new Error("type narrow");
    expect(event.details?.http_status).toBeUndefined();
    expect(event.details?.error).toBe("ECONNREFUSED");
  });
  // The legacy `it("ensures sessions.ts default export is unchanged")` test
  // was deleted alongside apps/main/src/routes/sessions.ts in the P2-B
  // sessions extraction — the route surface is now mounted from
  // @open-managed-agents/http-routes and exercised by the integration
  // suite.
});
