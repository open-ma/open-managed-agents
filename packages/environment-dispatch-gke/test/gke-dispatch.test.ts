import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedEnvironmentWorkDispatchPort,
  type GkeManagedEnvironmentDispatchOptions,
  type GkeSandboxClaimControlPlanePort,
} from "../src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _FactoryKeepsGkeConstructorOptions = Assert<Equal<
  Parameters<typeof createManagedEnvironmentWorkDispatchPort>[0],
  GkeManagedEnvironmentDispatchOptions
>>;

const work: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-07T04:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: {},
  secret: "opaque-work-secret",
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

function controlPlane(overrides: Partial<GkeSandboxClaimControlPlanePort> = {}) {
  const base: GkeSandboxClaimControlPlanePort = {
    listSessionClaims: vi.fn(async () => []),
    deleteClaim: vi.fn(async () => undefined),
    createClaim: vi.fn(async () => ({
      claimId: "claim_02",
      created: true,
      dispatchUrl: "http://10.0.0.2:8080/",
    })),
    postSession: vi.fn(async () => undefined),
    ...overrides,
  };
  return base;
}

describe("GKE Agent Sandbox Work dispatcher", () => {
  it("reaps stale claims, binds a warm pod, and sends only session/work identity", async () => {
    const control = controlPlane({
      listSessionClaims: vi.fn(async () => [
        { claimId: "claim_01", dispatchCount: 1 },
      ]),
    });
    const stop = vi.fn(async () => undefined);
    const port = createManagedEnvironmentWorkDispatchPort({
      controlPlane: control,
      workControl: { stop },
      namespace: "agent-sandbox",
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
      maxRedispatch: 3,
    });

    await port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "must-not-enter-claim",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(control.deleteClaim).toHaveBeenCalledWith({
      claimId: "claim_01",
      namespace: "agent-sandbox",
    });
    expect(control.createClaim).toHaveBeenCalledWith({
      labels: {
        "openma.environment-id": "env_01",
        "openma.session-id": "session_01",
        "openma.work-id": "work_01",
        "openma.dispatch-count": "2",
      },
      namespace: "agent-sandbox",
      idempotencyKey: "work_01:2",
      readyTimeoutMs: 120_000,
      signal: expect.any(AbortSignal),
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
    });
    expect(control.postSession).toHaveBeenCalledWith({
      dispatchUrl: "http://10.0.0.2:8080/",
      sessionId: "session_01",
      signal: expect.any(AbortSignal),
      workId: "work_01",
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("deletes a newly bound claim when dispatch to the pod fails", async () => {
    const control = controlPlane({
      postSession: vi.fn(async () => {
        throw new Error("injected pod dispatch failure");
      }),
    });
    const port = createManagedEnvironmentWorkDispatchPort({
      controlPlane: control,
      workControl: { stop: async () => undefined },
      namespace: "agent-sandbox",
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
    });

    await expect(port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    })).rejects.toThrow(/pod dispatch failure/);

    expect(control.deleteClaim).toHaveBeenCalledWith({
      claimId: "claim_02",
      namespace: "agent-sandbox",
    });
  });

  it("does not delete an existing idempotent claim when pod dispatch fails", async () => {
    const control = controlPlane({
      createClaim: vi.fn(async () => ({
        claimId: "claim_existing",
        created: false,
        dispatchUrl: "http://10.0.0.3:8080/",
      })),
      postSession: vi.fn(async () => {
        throw new Error("injected pod dispatch failure");
      }),
    });
    const port = createManagedEnvironmentWorkDispatchPort({
      controlPlane: control,
      workControl: { stop: async () => undefined },
      namespace: "agent-sandbox",
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
    });

    await expect(port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    })).rejects.toThrow(/pod dispatch failure/);

    expect(control.deleteClaim).not.toHaveBeenCalled();
  });

  it("reuses a surviving claim for the same Work instead of redispatching a new generation", async () => {
    const control = controlPlane({
      listSessionClaims: vi.fn(async () => [{
        claimId: "claim_existing",
        dispatchCount: 1,
        workId: "work_01",
      }]),
      createClaim: vi.fn(async () => ({
        claimId: "claim_existing",
        created: false,
        dispatchUrl: "http://10.0.0.3:8080/",
      })),
    });
    const port = createManagedEnvironmentWorkDispatchPort({
      controlPlane: control,
      workControl: { stop: async () => undefined },
      namespace: "agent-sandbox",
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
    });

    await port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(control.deleteClaim).not.toHaveBeenCalled();
    expect(control.createClaim).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "work_01:1",
    }));
  });

  it("stops poison Work after the configured redispatch limit", async () => {
    const control = controlPlane({
      listSessionClaims: vi.fn(async () => [
        { claimId: "claim_03", dispatchCount: 3 },
      ]),
    });
    const stop = vi.fn(async () => undefined);
    const port = createManagedEnvironmentWorkDispatchPort({
      controlPlane: control,
      workControl: { stop },
      namespace: "agent-sandbox",
      template: "claude-agent-worker",
      warmPool: "claude-agent-worker",
      maxRedispatch: 3,
    });

    await port.dispatch({
      apiBaseUrl: "https://api.openma.test",
      environmentKey: "environment-key",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(stop).toHaveBeenCalledWith({
      environmentId: "env_01",
      force: true,
      workId: "work_01",
    });
    expect(control.createClaim).not.toHaveBeenCalled();
    expect(control.postSession).not.toHaveBeenCalled();
  });
});
