import { describe, expect, it, vi } from "vitest";

import * as runtimeHostModule from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "worker_1",
  generation: 8,
  token: "must-not-enter-sandbox",
  expiresAt: "2026-09-03T12:00:00.000Z",
};
const declaration = {
  type: "openma_supervised" as const,
  protocol: "openma-harness-supervisor-v1" as const,
  supervisor: { command: "openma-harness-supervisor" },
  harness: { id: "pi", version: "1.2.3" },
  readyTimeoutMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  drainTimeoutMs: 5_000,
};

function SupervisorDriver(): new (options: any) => any {
  const candidate = (runtimeHostModule as Record<string, unknown>)[
    "SupervisedSandboxHarnessDriver"
  ];
  expect(candidate).toBeTypeOf("function");
  return candidate as new (options: any) => any;
}

describe("SupervisedSandboxHarnessDriver", () => {
  it("advertises only the supervised harness driver", async () => {
    const driver = new (SupervisorDriver())({ transport: { open: vi.fn() } });
    await expect(driver.driverCapabilities()).resolves.toEqual({
      drivers: ["openma_supervised"],
    });
  });

  it("rejects another driver before opening a supervisor transport", async () => {
    const open = vi.fn();
    const driver = new (SupervisorDriver())({ transport: { open } });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: {
        type: "ama_worker",
        process: { command: "node" },
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "SupervisorProtocolError",
      message: "Supervised driver cannot run ama_worker",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open a transport for an already-cancelled generation", async () => {
    const open = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("lease already lost"));
    const driver = new (SupervisorDriver())({ transport: { open } });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: controller.signal,
    })).resolves.toEqual({ type: "aborted" });
    expect(open).not.toHaveBeenCalled();
  });

  it("performs ready, heartbeat, completion and drain without exposing the fence token", async () => {
    const commands: unknown[] = [];
    const channel = {
      send: vi.fn(async (command: unknown) => commands.push(command)),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield { type: "heartbeat", sequence: 1 };
        yield { type: "completed", exitCode: 0 };
        yield { type: "drained" };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });

    await expect(
      driver.run({
        scope,
        fence,
        sandbox: { provider: "fake", runtimeId: "runtime_1" },
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
        driver: declaration,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ type: "completed" });

    expect(commands).toEqual([
      {
        type: "start",
        scope,
        harness: declaration.harness,
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
      },
      { type: "drain" },
    ]);
    expect(JSON.stringify(commands)).not.toContain(fence.token);
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("commits each supervisor checkpoint through the Runtime Host before continuing", async () => {
    const checkpoint = vi.fn(async () => {});
    const commands: unknown[] = [];
    const channel = {
      send: vi.fn(async (command: unknown) => commands.push(command)),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield {
          type: "checkpoint",
          checkpointId: "checkpoint_1",
          sessionId: scope.sessionId,
          turnId: "turn_1",
        };
        yield { type: "completed", exitCode: 0 };
        yield { type: "drained" };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });

    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      checkpoint,
      signal: new AbortController().signal,
    })).resolves.toEqual({ type: "completed" });

    expect(checkpoint).toHaveBeenCalledWith({
      checkpointId: "checkpoint_1",
      sessionId: scope.sessionId,
      turnId: "turn_1",
    });
    expect(commands).toContainEqual({
      type: "checkpoint.commit",
      checkpointId: "checkpoint_1",
    });
  });

  it("rejects and stops the supervisor when a live checkpoint cannot be committed", async () => {
    const failure = new Error("workspace fence lost");
    const commands: unknown[] = [];
    const channel = {
      send: vi.fn(async (command: unknown) => commands.push(command)),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield {
          type: "checkpoint",
          checkpointId: "checkpoint_1",
          sessionId: scope.sessionId,
        };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      checkpoint: vi.fn(async () => { throw failure; }),
      signal: new AbortController().signal,
    })).rejects.toBe(failure);
    expect(commands).toContainEqual({
      type: "checkpoint.reject",
      checkpointId: "checkpoint_1",
      message: "workspace fence lost",
    });
    expect(commands).toContainEqual({ type: "stop", reason: "failed" });
  });

  it.each([
    [{ checkpointId: "", sessionId: scope.sessionId }, vi.fn(async () => {})],
    [{ checkpointId: "checkpoint_1", sessionId: "session_intruder" }, vi.fn(async () => {})],
    [{ checkpointId: "checkpoint_1", sessionId: scope.sessionId }, undefined],
  ] as const)("rejects an invalid supervisor checkpoint request %#", async (checkpointEvent, checkpoint) => {
    const channel = {
      send: vi.fn(async () => {}),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield { type: "checkpoint", ...checkpointEvent };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });

    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      name: "SupervisorProtocolError",
      message: "Supervisor checkpoint request is invalid",
    });
    expect(channel.send).toHaveBeenCalledWith({ type: "stop", reason: "failed" });
  });

  it("preserves a non-Error checkpoint failure when rejection delivery also fails", async () => {
    const channel = {
      send: vi.fn(async (command: { type: string }) => {
        if (command.type === "checkpoint.reject") {
          throw new Error("rejection transport closed");
        }
      }),
      events: vi.fn(async function* () {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield {
          type: "checkpoint",
          checkpointId: "checkpoint_1",
          sessionId: scope.sessionId,
        };
      }),
      close: vi.fn(async () => {}),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });

    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      checkpoint: vi.fn(async () => { throw "checkpoint failed"; }),
      signal: new AbortController().signal,
    })).rejects.toBe("checkpoint failed");
    expect(channel.send).toHaveBeenCalledWith({
      type: "checkpoint.reject",
      checkpointId: "checkpoint_1",
      message: "checkpoint failed",
    });
  });

  it("sends a bounded stop when the Runtime Host aborts it", async () => {
    const commands: Array<{ type: string }> = [];
    let ready!: () => void;
    const readySeen = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const channel = {
      send: vi.fn(async (command: { type: string }) => commands.push(command)),
      events: vi.fn(async function* (signal: AbortSignal) {
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        ready();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
      close: vi.fn(async () => {}),
    };
    const controller = new AbortController();
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    const running = driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: controller.signal,
    });
    await readySeen;
    controller.abort(new Error("lease lost"));

    await expect(running).resolves.toEqual({ type: "aborted" });
    expect(commands).toContainEqual({ type: "stop", reason: "aborted" });
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "protocol mismatch",
      [{ type: "ready", protocol: "wrong-protocol" }],
      /protocol mismatch/u,
    ],
    [
      "supervisor error before completion",
      [
        { type: "ready", protocol: "openma-harness-supervisor-v1" },
        { type: "error", message: "native harness failed" },
      ],
      /native harness failed/u,
    ],
    [
      "non-zero exit",
      [
        { type: "ready", protocol: "openma-harness-supervisor-v1" },
        { type: "completed", exitCode: 7 },
      ],
      /exited with code 7/u,
    ],
    [
      "unexpected completion-phase event",
      [
        { type: "ready", protocol: "openma-harness-supervisor-v1" },
        { type: "drained" },
      ],
      /Unexpected supervisor event/u,
    ],
    [
      "drain error",
      [
        { type: "ready", protocol: "openma-harness-supervisor-v1" },
        { type: "completed", exitCode: 0 },
        { type: "error", message: "flush failed" },
      ],
      /flush failed/u,
    ],
  ] as const)("stops a generation after %s", async (_name, eventList, message) => {
    const commands: unknown[] = [];
    const channel = {
      send: vi.fn(async (command: unknown) => { commands.push(command); }),
      events: vi.fn(async function* () {
        for (const event of eventList) yield event;
      }),
      close: vi.fn(async () => undefined),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: new AbortController().signal,
    })).rejects.toThrow(message);
    expect(commands).toContainEqual({ type: "stop", reason: "failed" });
  });

  it("ignores non-ready events before ready and non-drained events while draining", async () => {
    const channel = {
      send: vi.fn(async () => undefined),
      events: vi.fn(async function* () {
        yield { type: "heartbeat", sequence: 1 };
        yield { type: "ready", protocol: "openma-harness-supervisor-v1" };
        yield { type: "completed", exitCode: 0 };
        yield { type: "heartbeat", sequence: 2 };
        yield { type: "drained" };
      }),
      close: vi.fn(async () => undefined),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: new AbortController().signal,
    })).resolves.toEqual({ type: "completed" });
  });

  it("preserves the original transport-open failure when no channel exists", async () => {
    const failure = new Error("transport unavailable");
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => { throw failure; }) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: new AbortController().signal,
    })).rejects.toBe(failure);
  });

  it("bounds stop and close cleanup failures without masking the execution failure", async () => {
    const failure = new Error("start failed");
    const channel = {
      send: vi.fn(async (command: { type: string }) => {
        if (command.type === "start") throw failure;
        throw new Error("stop failed");
      }),
      events: vi.fn(async function* () {}),
      close: vi.fn(async () => { throw new Error("close failed"); }),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: declaration,
      signal: new AbortController().signal,
    })).rejects.toBe(failure);
    expect(channel.send).toHaveBeenCalledWith({ type: "stop", reason: "failed" });
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it.each([0, 1.5])("rejects invalid ready timeout %s through the protocol boundary", async (readyTimeoutMs) => {
    const channel = {
      send: vi.fn(async () => undefined),
      events: vi.fn(async function* () { yield { type: "ready", protocol: declaration.protocol }; }),
      close: vi.fn(async () => undefined),
    };
    const driver = new (SupervisorDriver())({
      transport: { open: vi.fn(async () => channel) },
    });
    await expect(driver.run({
      scope,
      fence,
      sandbox: { provider: "fake", runtimeId: "runtime_1" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: { ...declaration, readyTimeoutMs },
      signal: new AbortController().signal,
    })).rejects.toThrow(/timeout must be a positive integer/u);
  });

  it("fails when the event stream closes or rejects before the next protocol event", async () => {
    const run = async (events: () => AsyncGenerator<never, void, unknown>) => {
      const channel = {
        send: vi.fn(async () => undefined),
        events: vi.fn(events),
        close: vi.fn(async () => undefined),
      };
      const driver = new (SupervisorDriver())({
        transport: { open: vi.fn(async () => channel) },
      });
      return driver.run({
        scope,
        fence,
        sandbox: { provider: "fake", runtimeId: "runtime_1" },
        workspacePath: "/workspace",
        outputPath: null,
        driver: declaration,
        signal: new AbortController().signal,
      });
    };
    await expect(run(async function* () {})).rejects.toThrow(/closed before ready/u);
    const failure = new Error("event transport failed");
    await expect(run(async function* () { throw failure; })).rejects.toBe(failure);
  });

  it("times out a stalled supervisor event", async () => {
    vi.useFakeTimers();
    try {
      const channel = {
        send: vi.fn(async () => undefined),
        events: vi.fn(async function* () { await new Promise(() => {}); }),
        close: vi.fn(async () => undefined),
      };
      const driver = new (SupervisorDriver())({
        transport: { open: vi.fn(async () => channel) },
      });
      const running = driver.run({
        scope,
        fence,
        sandbox: { provider: "fake", runtimeId: "runtime_1" },
        workspacePath: "/workspace",
        outputPath: null,
        driver: { ...declaration, readyTimeoutMs: 10 },
        signal: new AbortController().signal,
      });
      const expectation = expect(running).rejects.toThrow(/ready timed out after 10ms/u);
      await vi.advanceTimersByTimeAsync(10);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
