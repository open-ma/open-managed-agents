import { describe, expect, it, vi } from "vitest";

import { composeSandboxHarnessDrivers } from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

const baseRun = {
  scope,
  fence: {
    ...scope,
    ownerId: "owner_1",
    generation: 1,
    token: "secret",
    expiresAt: "2026-09-03T12:00:00.000Z",
  },
  sandbox: { provider: "fake", runtimeId: "runtime_1" },
  workspacePath: "/workspace" as const,
  outputPath: null,
  signal: new AbortController().signal,
};

describe("sandbox harness driver router", () => {
  it("keeps unmodified AMA workers and enhanced supervisors as independent lanes", async () => {
    const directRun = vi.fn(async () => ({ type: "completed" as const }));
    const supervisedRun = vi.fn(async () => ({ type: "completed" as const }));
    const router = composeSandboxHarnessDrivers(
      {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] as const })),
        run: directRun,
      },
      {
        driverCapabilities: vi.fn(async () => ({ drivers: ["openma_supervised"] as const })),
        run: supervisedRun,
      },
    );

    await expect(router.driverCapabilities(scope)).resolves.toEqual({
      drivers: ["ama_worker", "openma_supervised"],
    });
    await router.run({
      ...baseRun,
      driver: {
        type: "ama_worker",
        process: { command: "community-worker", args: ["--poll"] },
      },
    });

    expect(directRun).toHaveBeenCalledOnce();
    expect(supervisedRun).not.toHaveBeenCalled();
  });

  it("rejects ambiguous and unavailable driver registrations", async () => {
    const duplicate = composeSandboxHarnessDrivers(
      {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] as const })),
        run: vi.fn(),
      },
      {
        driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] as const })),
        run: vi.fn(),
      },
    );
    await expect(duplicate.driverCapabilities(scope)).rejects.toThrow(/duplicate/i);

    const directOnly = composeSandboxHarnessDrivers({
      driverCapabilities: vi.fn(async () => ({ drivers: ["ama_worker"] as const })),
      run: vi.fn(),
    });
    await expect(
      directOnly.run({
        ...baseRun,
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: { command: "openma-supervisor" },
          harness: { id: "pi", version: "1" },
          readyTimeoutMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          drainTimeoutMs: 10_000,
        },
      }),
    ).rejects.toThrow(/no sandbox harness driver/i);
  });
});
