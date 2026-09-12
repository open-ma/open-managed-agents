import { describe, expect, it, vi } from "vitest";
import type { HarnessSupervisorHarness } from "@open-managed-agents/harness-supervisor";
import type { ClaimedEnvironmentWorkLifecycleClient } from "@open-managed-agents/managed-runtime-host";

import {
  createNodeManagedAcpWorkItemRunner,
  type NodeManagedAcpSupervisorApp,
} from "../src/node-work-item";

const environment = {
  ANTHROPIC_BASE_URL: "https://fallback.openma.test",
  ANTHROPIC_ENVIRONMENT_ID: "env_01",
  ANTHROPIC_SESSION_ID: "session_01",
  ANTHROPIC_WORK_ID: "work_01",
  ANTHROPIC_WORK_SECRET: Buffer.from(JSON.stringify({
    sessions_token: "scoped-session-token",
    api_base_url: "https://control.openma.test",
  })).toString("base64url"),
  OPENMA_HARNESS_ID: "pi-acp",
};

function lifecycle(): ClaimedEnvironmentWorkLifecycleClient {
  return {
    ack: vi.fn(async () => ({})),
    heartbeat: vi.fn(async () => ({
      last_heartbeat: "beat_1",
      lease_extended: true,
      state: "running",
      ttl_seconds: 90,
    })),
    stop: vi.fn(async () => ({})),
  };
}

function supervisor(operations: string[]): NodeManagedAcpSupervisorApp {
  const harness: HarnessSupervisorHarness = {
    start: vi.fn(async (input) => {
      operations.push(`start:${input.scope.workId}:${input.harness.id}`);
      await input.checkpoint({ sessionId: input.scope.sessionId, turnId: "turn_1" });
      return {
        completed: Promise.resolve({ exitCode: 0 }),
        drain: vi.fn(async () => { operations.push("drain"); }),
        stop: vi.fn(async () => { operations.push("stop-harness"); }),
      };
    }),
  };
  return {
    resolveHarness: vi.fn(async ({ id, version }) =>
      id === "pi-acp" && version === "1" ? harness : null),
    serve: vi.fn(),
  };
}

describe("Node ACP claimed Work item", () => {
  it("constructs the production defaults from process.env without starting network work", () => {
    for (const [key, value] of Object.entries({
      ...environment,
      OPENMA_ACP_AGENT_ID: "codex-acp",
      OPENMA_OUTPUT_PATH: "/custom-output",
      OPENMA_WORKSPACE_ID: "workspace_01",
    })) {
      vi.stubEnv(key, value);
    }
    try {
      expect(createNodeManagedAcpWorkItemRunner()).toEqual({ run: expect.any(Function) });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(createNodeManagedAcpWorkItemRunner({
      environment,
      lifecycleClient: lifecycle(),
    })).toEqual({ run: expect.any(Function) });
  });

  it("runs the whole ACP brain under the claimed Work lease", async () => {
    const operations: string[] = [];
    const client = lifecycle();
    const app = supervisor(operations);
    const checkpoint = vi.fn(async () => {});
    const runner = createNodeManagedAcpWorkItemRunner({
      environment,
      lifecycleClient: client,
      supervisorApp: app,
      checkpoint,
      workspacePath: "/workspace",
      outputPath: "/mnt/session/outputs",
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await expect(runner.run()).resolves.toBeUndefined();
    expect(app.resolveHarness).toHaveBeenCalledWith({ id: "pi-acp", version: "1" });
    expect(operations).toEqual(["start:work_01:pi-acp", "drain"]);
    expect(checkpoint).toHaveBeenCalledWith({ sessionId: "session_01", turnId: "turn_1" });
    expect(client.ack).toHaveBeenCalledBefore(client.stop as ReturnType<typeof vi.fn>);
  });

  it("builds its lifecycle client from the scoped sessions token, never the standing key", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (raw: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(raw, init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/heartbeat")) {
        return Response.json({
          last_heartbeat: "beat_1",
          lease_extended: true,
          state: "running",
          ttl_seconds: 90,
        });
      }
      return Response.json({});
    });
    const runner = createNodeManagedAcpWorkItemRunner({
      environment: {
        ...environment,
        ANTHROPIC_ENVIRONMENT_KEY: "standing-key-must-not-be-used",
      },
      fetch,
      supervisorApp: supervisor([]),
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await runner.run();
    expect(requests.map((request) => new URL(request.url).origin))
      .toEqual(["https://control.openma.test", "https://control.openma.test", "https://control.openma.test"]);
    expect(requests.map((request) => request.headers.get("authorization")))
      .toEqual(["Bearer scoped-session-token", "Bearer scoped-session-token", "Bearer scoped-session-token"]);
    expect(requests.every((request) => request.headers.get("x-api-key") === null)).toBe(true);
    expect(requests.every((request) => ![...request.headers.values()].includes("standing-key-must-not-be-used")))
      .toBe(true);
  });

  it("fails closed before ACK when the harness declaration is missing", async () => {
    const client = lifecycle();
    expect(() => createNodeManagedAcpWorkItemRunner({
      environment: { ...environment, OPENMA_HARNESS_ID: undefined },
      lifecycleClient: client,
      supervisorApp: supervisor([]),
    })).toThrow("OPENMA_HARNESS_ID");
    expect(client.ack).not.toHaveBeenCalled();
  });

  it("fails closed before ACK when the scoped Work credential is invalid", () => {
    const client = lifecycle();
    expect(() => createNodeManagedAcpWorkItemRunner({
      environment: { ...environment, ANTHROPIC_WORK_SECRET: "invalid" },
      lifecycleClient: client,
      supervisorApp: supervisor([]),
    })).toThrow("scoped sessions_token");
    expect(client.ack).not.toHaveBeenCalled();
  });

  it("rejects claimed Work whose installed harness cannot be resolved", async () => {
    const client = lifecycle();
    const runner = createNodeManagedAcpWorkItemRunner({
      environment,
      lifecycleClient: client,
      supervisorApp: {
        resolveHarness: vi.fn(async () => null),
        serve: vi.fn(),
      },
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await expect(runner.run()).rejects.toThrow("pi-acp@1 is not installed");
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("stops a non-zero harness as failed and preserves the original failure", async () => {
    const client = lifecycle();
    const stop = vi.fn(async () => { throw new Error("stop cleanup failed"); });
    const runner = createNodeManagedAcpWorkItemRunner({
      environment: { ...environment, OPENMA_WORKSPACE_ID: "workspace_01" },
      lifecycleClient: client,
      outputPath: null,
      supervisorApp: {
        resolveHarness: vi.fn(async () => ({
          start: vi.fn(async (input) => {
            await input.checkpoint({ sessionId: input.scope.sessionId });
            expect(input.outputPath).toBeNull();
            return {
              completed: Promise.resolve({ exitCode: 7 }),
              drain: vi.fn(),
              stop,
            };
          }),
        })),
        serve: vi.fn(),
      },
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await expect(runner.run()).rejects.toThrow("ACP harness exited with code 7");
    expect(stop).toHaveBeenCalledWith("failed");
  });

  it("does not try to stop a harness whose start call failed", async () => {
    const client = lifecycle();
    const runner = createNodeManagedAcpWorkItemRunner({
      environment,
      lifecycleClient: client,
      supervisorApp: {
        resolveHarness: vi.fn(async () => ({
          start: vi.fn(async () => { throw new Error("start failed"); }),
        })),
        serve: vi.fn(),
      },
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    await expect(runner.run()).rejects.toThrow("start failed");
  });

  it("marks an active harness aborted when its external Work claim is cancelled", async () => {
    const client = lifecycle();
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const stop = vi.fn(async () => undefined);
    const controller = new AbortController();
    const runner = createNodeManagedAcpWorkItemRunner({
      environment,
      lifecycleClient: client,
      supervisorApp: {
        resolveHarness: vi.fn(async () => ({
          start: vi.fn(async (input) => {
            announceStarted();
            return {
              completed: new Promise<{ exitCode: number }>((_resolve, reject) => {
                input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
              }),
              drain: vi.fn(),
              stop,
            };
          }),
        })),
        serve: vi.fn(),
      },
      scheduler: { sleep: async (_ms, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } },
    });

    const running = runner.run(controller.signal);
    await started;
    controller.abort(new Error("claim cancelled"));
    await expect(running).rejects.toThrow("claim cancelled");
    expect(stop).toHaveBeenCalledWith("aborted");
  });
});
