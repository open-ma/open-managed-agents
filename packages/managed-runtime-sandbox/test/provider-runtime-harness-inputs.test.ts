import { describe, expect, it, vi } from "vitest";
import type {
  HarnessSupervisorEvent,
  RuntimePublicationCandidate,
  RuntimeSessionResourceSnapshot,
} from "@open-managed-agents/runtime-resource-contract";
import type { SandboxDuplexProcess } from "@open-managed-agents/sandbox";

import {
  acquire,
  binding,
  composition,
  fence,
  process,
  provider,
  runtime,
  scope,
  stream,
  type TestRuntime,
} from "./provider-runtime-fixture";

async function acquiredWithProcess(child: SandboxDuplexProcess, id = "process-runtime") {
  const live = runtime(id, {
    spawnDuplexProcess: vi.fn(async () => child),
  });
  const composed = composition(provider(live));
  const sandbox = await acquire(composed);
  return { live, composed, sandbox };
}

async function collectEvents(
  events: AsyncIterable<HarnessSupervisorEvent>,
): Promise<HarnessSupervisorEvent[]> {
  const collected: HarnessSupervisorEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function harnessInput(
  sandbox: Awaited<ReturnType<typeof acquire>>,
  signal = new AbortController().signal,
) {
  return {
    scope,
    fence,
    sandbox,
    workspacePath: "/workspace" as const,
    outputPath: null,
    driver: { type: "ama_worker" as const, process: { command: "worker" } },
    signal,
  };
}

describe("provider direct harness lifecycle", () => {
  it("rejects supervised drivers and already-aborted direct runs", async () => {
    const live = runtime("direct-rejections");
    const composed = composition(provider(live));
    const sandbox = await acquire(composed);
    await expect(composed.harness.run({
      ...harnessInput(sandbox),
      driver: {
        type: "openma_supervised",
        protocol: "openma-harness-supervisor-v1",
        supervisor: { command: "supervisor" },
        harness: { id: "pi", version: "1" },
        readyTimeoutMs: 1,
        heartbeatTimeoutMs: 1,
        drainTimeoutMs: 1,
      },
    })).rejects.toThrow(/direct driver cannot run openma_supervised/i);

    const controller = new AbortController();
    const reason = new Error("already aborted");
    controller.abort(reason);
    await expect(composed.harness.run(harnessInput(sandbox, controller.signal)))
      .rejects.toBe(reason);
    expect(live.spawnDuplexProcess).not.toHaveBeenCalled();
  });

  it("requires a duplex process Port", async () => {
    const composed = composition(provider(runtime("no-direct-duplex", {
      spawnDuplexProcess: undefined,
    })));
    const sandbox = await acquire(composed);
    await expect(composed.harness.run(harnessInput(sandbox)))
      .rejects.toThrow(/no duplex process Port/i);
  });

  it.each([
    [{ code: 7, signal: null }, /code 7$/i],
    [{ code: null, signal: "SIGKILL" }, /code null \(SIGKILL\)/i],
  ])("rejects non-zero direct worker exits %#", async (exit, message) => {
    const fixture = await acquiredWithProcess(process({ exited: Promise.resolve(exit) }));
    await expect(fixture.composed.harness.run(harnessInput(fixture.sandbox)))
      .rejects.toThrow(message);
  });

  it("passes a minimal process declaration without inventing optional fields", async () => {
    const fixture = await acquiredWithProcess(process());
    await expect(fixture.composed.harness.run(harnessInput(fixture.sandbox)))
      .resolves.toEqual({ type: "completed" });
    expect(fixture.live.spawnDuplexProcess).toHaveBeenCalledWith({ command: "worker" });
  });

  it("kills an active direct worker on abort and returns the aborted result", async () => {
    let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const child = process({
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      kill: vi.fn(async () => {
        resolveExit({ code: null, signal: "SIGTERM" });
      }),
    });
    const live = runtime("abort-direct", {
      spawnDuplexProcess: vi.fn(async () => {
        markSpawned();
        return child;
      }),
    });
    const composed = composition(provider(live));
    const sandbox = await acquire(composed);
    const controller = new AbortController();
    const running = composed.harness.run(harnessInput(sandbox, controller.signal));
    await spawned;
    await Promise.resolve();
    controller.abort(new Error("claim fenced"));
    await expect(running).resolves.toEqual({ type: "aborted" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("ignores direct-worker kill transport failure while cancellation wins", async () => {
    let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const child = process({
      exited: new Promise((resolve) => {
        resolveExit = resolve;
      }),
      kill: vi.fn(async () => {
        throw new Error("kill transport failed");
      }),
    });
    const live = runtime("abort-direct-kill-failure", {
      spawnDuplexProcess: vi.fn(async () => {
        markSpawned();
        return child;
      }),
    });
    const composed = composition(provider(live));
    const sandbox = await acquire(composed);
    const controller = new AbortController();
    const running = composed.harness.run(harnessInput(sandbox, controller.signal));
    await spawned;
    await Promise.resolve();
    controller.abort(new Error("claim fenced"));
    resolveExit({ code: null, signal: "SIGTERM" });
    await expect(running).resolves.toEqual({ type: "aborted" });
  });
});

describe("provider supervisor stdio transport", () => {
  async function openWith(child: SandboxDuplexProcess, signal = new AbortController().signal) {
    const fixture = await acquiredWithProcess(child, "supervisor-runtime");
    const channel = await fixture.composed.supervisorTransport.open({
      scope,
      sandbox: fixture.sandbox,
      process: { command: "supervisor" },
      signal,
    });
    return { ...fixture, channel };
  }

  it("rejects already-aborted and non-duplex supervisor opens", async () => {
    const live = runtime("supervisor-rejections", { spawnDuplexProcess: undefined });
    const composed = composition(provider(live));
    const sandbox = await acquire(composed);
    await expect(composed.supervisorTransport.open({
      scope,
      sandbox,
      process: { command: "supervisor" },
      signal: new AbortController().signal,
    })).rejects.toThrow(/no duplex process Port/i);

    const withDuplex = composition(provider(runtime("supervisor-aborted")));
    const abortedSandbox = await acquire(withDuplex);
    const controller = new AbortController();
    const reason = new Error("already fenced");
    controller.abort(reason);
    await expect(withDuplex.supervisorTransport.open({
      scope,
      sandbox: abortedSandbox,
      process: { command: "supervisor" },
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it("cleans up a supervisor process when abort races spawn completion", async () => {
    const controller = new AbortController();
    const reason = new Error("fenced during spawn");
    const child = process({
      kill: vi.fn(async () => {
        throw new Error("spawn cleanup transport failed");
      }),
    });
    const live = runtime("supervisor-spawn-race", {
      spawnDuplexProcess: vi.fn(async () => {
        controller.abort(reason);
        return child;
      }),
    });
    const composed = composition(provider(live));
    const sandbox = await acquire(composed);
    await expect(composed.supervisorTransport.open({
      scope,
      sandbox,
      process: { command: "supervisor" },
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("sends commands, enforces a single event consumer, and closes idempotently", async () => {
    const writes = vi.fn(async (_chunk: Uint8Array) => {});
    const child = process({
      stdin: new WritableStream({
        write: writes,
        close() {
          throw new Error("writer already closed");
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.error(new Error("stderr transport failed"));
        },
      }),
      kill: vi.fn(async () => {
        throw new Error("already stopped");
      }),
    });
    const { channel } = await openWith(child);
    await channel.send({ type: "drain" });
    expect(new TextDecoder().decode(writes.mock.calls[0]?.[0])).toBe('{"type":"drain"}\n');
    channel.events(new AbortController().signal);
    expect(() => channel.events(new AbortController().signal)).toThrow(/consumed once/i);
    await channel.close();
    await channel.close();
    await expect(channel.send({ type: "drain" })).rejects.toThrow(/channel is closed/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("passes optional supervisor process fields unchanged", async () => {
    const fixture = await acquiredWithProcess(process(), "supervisor-options");
    const channel = await fixture.composed.supervisorTransport.open({
      scope,
      sandbox: fixture.sandbox,
      process: {
        command: "supervisor",
        args: ["--stdio"],
        env: { TOKEN: "opaque" },
        cwd: "/workspace",
      },
      signal: new AbortController().signal,
    });
    expect(fixture.live.spawnDuplexProcess).toHaveBeenCalledWith({
      command: "supervisor",
      args: ["--stdio"],
      env: { TOKEN: "opaque" },
      cwd: "/workspace",
    });
    await channel.close();
  });

  it("rejects send after its owning claim is aborted", async () => {
    const controller = new AbortController();
    const fixture = await openWith(process({
      kill: vi.fn(async () => {
        throw new Error("kill transport failed");
      }),
    }), controller.signal);
    const reason = new Error("claim fenced");
    controller.abort(reason);
    await Promise.resolve();
    await expect(fixture.channel.send({ type: "drain" })).rejects.toBe(reason);
    await fixture.channel.close();
  });

  it("parses every supervisor event shape including a trailing record", async () => {
    const records: HarnessSupervisorEvent[] = [
      { type: "ready", protocol: "openma-harness-supervisor-v1" },
      { type: "heartbeat", sequence: 0 },
      {
        type: "checkpoint",
        checkpointId: "checkpoint_1",
        sessionId: scope.sessionId,
        turnId: "turn_1",
      },
      {
        type: "checkpoint",
        checkpointId: "checkpoint_2",
        sessionId: scope.sessionId,
      },
      { type: "completed", exitCode: 0 },
      { type: "drained" },
      { type: "error", message: "harness failed" },
    ];
    const encoded = new TextEncoder().encode(
      `\n${records.slice(0, -1).map((value) => JSON.stringify(value)).join("\n")}\n${JSON.stringify(records.at(-1))}`,
    );
    const fixture = await openWith(process({
      stdout: stream(encoded.slice(0, 19), encoded.slice(19)),
    }));
    const events = await collectEvents(
      fixture.channel.events(new AbortController().signal),
    );
    expect(events).toEqual(records);
    await fixture.channel.close();
  });

  it.each([
    ["{", /invalid JSON/i],
    ["null", /must be an object with a type/i],
    ["{}", /must be an object with a type/i],
    [JSON.stringify({ type: "ready", protocol: "v0" }), /unsupported ready protocol/i],
    [JSON.stringify({ type: "heartbeat", sequence: -1 }), /sequence must be non-negative/i],
    [JSON.stringify({ type: "heartbeat", sequence: 1.5 }), /sequence must be non-negative/i],
    [JSON.stringify({ type: "checkpoint", checkpointId: "", sessionId: scope.sessionId }), /checkpoint request is invalid/i],
    [JSON.stringify({ type: "checkpoint", checkpointId: "checkpoint_1", sessionId: "" }), /checkpoint request is invalid/i],
    [JSON.stringify({ type: "checkpoint", checkpointId: "checkpoint_1", sessionId: scope.sessionId, turnId: "" }), /checkpoint request is invalid/i],
    [JSON.stringify({ type: "completed", exitCode: 1.5 }), /exitCode must be an integer/i],
    [JSON.stringify({ type: "error", message: "" }), /message must be non-empty/i],
    [JSON.stringify({ type: "mystery" }), /unknown harness supervisor event/i],
  ])("rejects malformed supervisor record %#", async (line, message) => {
    const fixture = await openWith(process({
      stdout: stream(new TextEncoder().encode(`${line}\n`)),
    }));
    await expect(collectEvents(
      fixture.channel.events(new AbortController().signal),
    )).rejects.toThrow(message);
    await fixture.channel.close();
  });

  it("cancels an active supervisor event stream when its consumer is aborted", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("reader cancel failed");
    });
    const stdout = new ReadableStream<Uint8Array>({
      pull() {},
      cancel,
    });
    const fixture = await openWith(process({ stdout }));
    const controller = new AbortController();
    const iterator = fixture.channel.events(controller.signal)[Symbol.asyncIterator]();
    const reading = iterator.next();
    const reason = new Error("consumer stopped");
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    await fixture.channel.close();
  });
});

describe("official Session input materialization", () => {
  async function inputFixture(live: TestRuntime = runtime("input-runtime")) {
    const composed = composition(provider(live));
    const workspace = await binding(composed);
    const sandbox = await composed.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace,
      outputs: null,
      signal: new AbortController().signal,
    });
    return { live, composed, workspace, sandbox };
  }

  async function materialize(
    fixture: Awaited<ReturnType<typeof inputFixture>>,
    resources: readonly RuntimeSessionResourceSnapshot[],
    options: {
      checkpoint?: RuntimePublicationCandidate | null;
      access?: { downloadFile(input: { fileId: string; signal: AbortSignal }): Promise<{ content: Uint8Array }> };
      owner?: "worker" | "materializer";
      signal?: AbortSignal;
    } = {},
  ) {
    return fixture.composed.sessionInputs.materialize({
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources,
      },
      workspace: fixture.workspace,
      sandbox: fixture.sandbox,
      activeWorkspaceCheckpoint: options.checkpoint ?? null,
      resourceOwnership: { memoryStore: options.owner ?? "worker" },
      idempotencyKey: "inputs",
      ...(options.access === undefined ? {} : { access: options.access }),
      authorize: vi.fn(async () => true),
      signal: options.signal ?? new AbortController().signal,
    });
  }

  it("leaves worker-owned memory stores to the official Environment Worker", async () => {
    const fixture = await inputFixture();
    await expect(materialize(fixture, [{ type: "memory_store", memory_store_id: "memory_1" }]))
      .resolves.toBeUndefined();
  });

  it("requires per-claim access and binary writes for file resources", async () => {
    const fixture = await inputFixture();
    const file = { type: "file", file_id: "file_1", mount_path: "/workspace/input.bin" };
    await expect(materialize(fixture, [file])).rejects.toThrow(/requires per-claim/i);

    const noBinary = await inputFixture(runtime("input-no-binary", { writeFileBytes: undefined }));
    await expect(materialize(noBinary, [file], {
      access: { downloadFile: vi.fn(async () => ({ content: new Uint8Array() })) },
    })).rejects.toThrow(/cannot materialize binary Session files/i);
  });

  it.each([
    [{ type: "file", mount_path: "/workspace/a" }, /requires file_id/i],
    [{ type: "file", file_id: "f", mount_path: "relative" }, /must be absolute/i],
    [{ type: "file", file_id: "f", mount_path: "/workspace/../secret" }, /may not traverse/i],
    [{ type: "file", file_id: "f", mount_path: "/workspace/a\0b" }, /may not traverse/i],
  ])("rejects unsafe or incomplete file resource %#", async (resource, message) => {
    const fixture = await inputFixture();
    await expect(materialize(fixture, [resource], {
      access: { downloadFile: vi.fn(async () => ({ content: new Uint8Array() })) },
    })).rejects.toThrow(message);
  });

  it("does not write a downloaded file after cancellation wins", async () => {
    const fixture = await inputFixture();
    const controller = new AbortController();
    const reason = new Error("fenced after download");
    await expect(materialize(fixture, [{
      type: "file",
      file_id: "file_1",
      mount_path: "/workspace/input.bin",
    }], {
      signal: controller.signal,
      access: {
        downloadFile: vi.fn(async () => {
          controller.abort(reason);
          return { content: new Uint8Array([1]) };
        }),
      },
    })).rejects.toBe(reason);
    expect(fixture.live.writeFileBytes).not.toHaveBeenCalled();
  });

  it("does not re-clone repositories already present in the canonical checkpoint", async () => {
    const fixture = await inputFixture();
    await materialize(fixture, [{
      type: "github_repository",
      url: "https://github.com/openma-ai/example.git",
      mount_path: "/workspace/repo",
    }], { checkpoint: { id: "workspace", contentHash: "sha256:x" } });
    expect(fixture.live.gitCheckout).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "github_repository", mount_path: "/workspace/repo" }, /requires url/i],
    [{ type: "github_repository", url: ":bad", mount_path: "/workspace/repo" }, /invalid URL/i],
    [{ type: "github_repository", url: "ssh://git@example.com/repo", mount_path: "/workspace/repo" }, /must use HTTP/i],
    [{ type: "github_repository", url: "https://example.com/repo", mount_path: "relative" }, /must be absolute/i],
  ])("rejects unsafe or incomplete repository resource %#", async (resource, message) => {
    await expect(materialize(await inputFixture(), [resource])).rejects.toThrow(message);
  });

  it("uses provider git checkout without a branch for absent or invalid branch metadata", async () => {
    for (const checkout of [undefined, { type: "branch", name: "" }]) {
      const fixture = await inputFixture();
      await materialize(fixture, [{
        type: "github_repository",
        url: "https://example.com/repo.git",
        mount_path: "/workspace/repo",
        ...(checkout === undefined ? {} : { checkout }),
      }]);
      expect(fixture.live.gitCheckout).toHaveBeenCalledWith(
        "https://example.com/repo.git",
        { targetDir: "/workspace/repo" },
      );
    }
  });

  it("falls back to quoted git commands and supports branch and commit checkout", async () => {
    const live = runtime("git-fallback", { gitCheckout: undefined });
    const fixture = await inputFixture(live);
    await materialize(fixture, [{
      type: "github_repository",
      url: "https://example.com/team/o'repo.git",
      mount_path: "/workspace/o'repo",
      checkout: { type: "branch", name: "feature/o'reilly" },
    }, {
      type: "github_repository",
      url: "https://example.com/repo.git",
      mount_path: "/workspace/commit",
      checkout: { type: "commit", sha: "abcdef1234567" },
    }]);
    expect(live.exec).toHaveBeenCalledWith(
      expect.stringContaining(`'\"'\"'`),
      120_000,
    );
    expect(live.exec).toHaveBeenCalledWith(
      "git -C '/workspace/commit' checkout --detach 'abcdef1234567'",
      60_000,
    );
  });

  it.each([undefined, "", "xyz", "abc123"])("rejects invalid commit sha %j", async (sha) => {
    const fixture = await inputFixture();
    await expect(materialize(fixture, [{
      type: "github_repository",
      url: "https://example.com/repo.git",
      mount_path: "/workspace/repo",
      checkout: { type: "commit", ...(sha === undefined ? {} : { sha }) },
    }])).rejects.toThrow(/commit checkout is invalid/i);
  });

  it("rejects unknown Session resource types and pre-aborted batches", async () => {
    const fixture = await inputFixture();
    await expect(materialize(fixture, [{ type: "secret_volume" }]))
      .rejects.toThrow(/unsupported Session resource type/i);
    const controller = new AbortController();
    const reason = new Error("already fenced");
    controller.abort(reason);
    await expect(materialize(fixture, [{ type: "memory_store" }], {
      signal: controller.signal,
    })).rejects.toBe(reason);
  });
});
