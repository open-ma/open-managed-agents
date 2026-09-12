import type { BetaSelfHostedWork } from "@anthropic-ai/sdk/resources/beta/environments/work";
import type {
  VercelCommandFinishedPort,
  VercelCommandPort,
  VercelGetOrCreateOptions,
  VercelNetworkPolicy,
  VercelRunCommandInput,
  VercelSandboxSdkPort,
  VercelSdkPort,
} from "@open-managed-agents/vercel-sandbox-contract";
import { describe, expect, it, vi } from "vitest";

import { createManagedEnvironmentWorkDispatchPort } from "../src/index";

const work: BetaSelfHostedWork = {
  id: "work_01",
  acknowledged_at: null,
  created_at: "2026-09-10T00:00:00.000Z",
  data: { type: "session", id: "session_01" },
  environment_id: "env_01",
  latest_heartbeat_at: null,
  metadata: {},
  secret: "scoped-work-secret",
  started_at: null,
  state: "queued",
  stop_requested_at: null,
  stopped_at: null,
  type: "work",
};

function fakeSandbox(): VercelSandboxSdkPort {
  const finished: VercelCommandFinishedPort = {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };
  const detached: VercelCommandPort = {
    wait: async () => ({ exitCode: 0 }),
    kill: async () => undefined,
  };
  const runCommand = vi.fn(async (input: VercelRunCommandInput) =>
    input.detached === true ? detached : finished);
  return {
    name: "oma-work-placeholder",
    status: "running",
    persistent: true,
    tags: undefined,
    currentSnapshotId: undefined,
    expiresAt: new Date("2026-09-10T00:00:30.000Z"),
    extendTimeout: vi.fn(async () => undefined),
    runCommand: runCommand as VercelSandboxSdkPort["runCommand"],
    mkDir: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => null),
    writeFiles: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({})),
    updateNetworkPolicy: vi.fn(async (policy) => policy),
    delete: vi.fn(async () => undefined),
  };
}

describe("Vercel Managed Environment dispatch", () => {
  it("starts one persistent, fenced worker without copying the environment key", async () => {
    const sandbox = fakeSandbox();
    const create = vi.fn(async (options: VercelGetOrCreateOptions) => {
      Object.defineProperties(sandbox, {
        name: { value: options.name },
        tags: { value: options.tags },
      });
      return sandbox;
    });
    const client: VercelSdkPort = { getOrCreate: create, get: vi.fn() };
    const port = createManagedEnvironmentWorkDispatchPort({
      client,
      snapshotId: "snap_01",
      worker: { command: "openma-work-runner", args: ["--acp", "pi"] },
      timeoutMs: 90_000,
      now: () => Date.parse("2026-09-10T00:00:00.000Z"),
    });

    await port.dispatch({
      apiBaseUrl: "https://control.openma.test",
      environmentKey: "environment-secret",
      workspaceId: "workspace_01",
      work,
      signal: new AbortController().signal,
    });

    expect(port.descriptor()).toEqual({
      provider: "vercel",
      version: "1.0.0",
      strategy: "poll_unacked_then_dispatch",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: expect.stringMatching(/^oma-work-[a-f0-9]{32}$/),
      persistent: true,
      resume: true,
      source: { type: "snapshot", snapshotId: "snap_01" },
      timeout: 90_000,
      tags: expect.objectContaining({
        openma: "managed-work",
        oma_environment: expect.stringMatching(/^[a-f0-9]{24}$/),
        oma_session: expect.stringMatching(/^[a-f0-9]{24}$/),
        oma_work: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
      networkPolicy: {
        allow: {
          "control.openma.test": [{}],
        },
      },
    }));
    expect(sandbox.updateNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ allow: expect.any(Object) }),
      { signal: expect.any(AbortSignal) },
    );
    expect(sandbox.extendTimeout).toHaveBeenCalledWith(60_000, {
      signal: expect.any(AbortSignal),
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "/usr/bin/flock",
      args: [
        "-n",
        expect.stringMatching(/^\/tmp\/openma-work-[a-f0-9]{24}\.lock$/),
        "openma-work-runner",
        "--acp",
        "pi",
      ],
      cwd: "/workspace",
      detached: true,
      env: {
        ANTHROPIC_BASE_URL: "https://control.openma.test",
        ANTHROPIC_ENVIRONMENT_ID: "env_01",
        ANTHROPIC_SESSION_ID: "session_01",
        ANTHROPIC_WORK_ID: "work_01",
        ANTHROPIC_WORK_SECRET: "scoped-work-secret",
        OPENMA_WORKSPACE_ID: "workspace_01",
      },
    });
    expect(JSON.stringify((sandbox.runCommand as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain("environment-secret");
    expect(JSON.stringify(create.mock.calls)).not.toContain("environment-secret");
  });

  it("rejects unsupported work, invalid configuration, and aborted dispatch", async () => {
    const sandbox = fakeSandbox();
    const client: VercelSdkPort = {
      getOrCreate: vi.fn(async () => sandbox),
      get: vi.fn(async () => sandbox),
    };
    expect(() => createManagedEnvironmentWorkDispatchPort({
      client,
      snapshotId: "",
      worker: { command: "worker" },
    })).toThrow("snapshotId");
    const port = createManagedEnvironmentWorkDispatchPort({
      client,
      snapshotId: "snap_01",
      worker: { command: "worker" },
    });
    await expect(port.dispatch({
      apiBaseUrl: "https://control.openma.test",
      environmentKey: "key",
      workspaceId: "workspace_01",
      work: { ...work, data: { type: "task", id: "task_01" } } as unknown as BetaSelfHostedWork,
      signal: new AbortController().signal,
    })).rejects.toThrow("Session Work");
    const controller = new AbortController();
    controller.abort();
    await expect(port.dispatch({
      apiBaseUrl: "https://control.openma.test",
      environmentKey: "key",
      workspaceId: "workspace_01",
      work,
      signal: controller.signal,
    })).rejects.toThrow();
    expect(client.getOrCreate).not.toHaveBeenCalled();
  });
});
