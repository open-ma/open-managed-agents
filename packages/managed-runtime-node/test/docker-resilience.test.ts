import { describe, expect, it, vi } from "vitest";

import { DockerManagedRuntimeAdapter } from "../src/docker";

const scope = {
  workspaceId: "workspace_resilience",
  environmentId: "environment_resilience",
  sessionId: "session_resilience",
  workId: "work_resilience",
};
const fence = {
  ...scope,
  ownerId: "worker_resilience",
  generation: 4,
  token: "fence_resilience",
  expiresAt: "2026-09-07T12:00:00.000Z",
};

function acquireInput(signal = new AbortController().signal): any {
  return {
    scope,
    fence,
    plan: {
      workspaceStrategy: "checkpoint_restore" as const,
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: {
        type: "ama_worker" as const,
        process: { command: "worker" },
      },
    },
    workspace: {
      bindingId: "workspace-binding",
      mountPath: "/workspace",
      metadata: { hostPath: "/tmp/openma/workspace" },
    },
    outputs: null,
    signal,
  };
}

function commandPort(run: (args: string[]) => Promise<any>) {
  return { run: vi.fn(run) };
}

function materializeInput(resources: any[], overrides: Record<string, unknown> = {}) {
  return {
    scope,
    fence,
    session: {
      id: scope.sessionId,
      environmentId: scope.environmentId,
      metadata: {},
      resources,
    },
    workspace: { bindingId: "workspace", mountPath: "/workspace" },
    sandbox: { provider: "docker", runtimeId: "runtime" },
    activeWorkspaceCheckpoint: null,
    resourceOwnership: { memoryStore: "worker" },
    idempotencyKey: "inputs",
    signal: new AbortController().signal,
    ...overrides,
  } as any;
}

function duplexProcess(chunks: string[], options: { killRejects?: boolean } = {}) {
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    exited: Promise.resolve({ code: 0, signal: null }),
    kill: options.killRejects
      ? vi.fn(async () => { throw new Error("kill failed"); })
      : vi.fn(async () => undefined),
  };
}

describe("DockerManagedRuntimeAdapter allocation barriers", () => {
  it("waits for Docker create to commit before honoring cancellation and reaps the committed id", async () => {
    const controller = new AbortController();
    const reason = new Error("fence lost during create");
    const calls: Array<{ args: string[]; hasSignal: boolean }> = [];
    const docker = {
      run: vi.fn(async (args: string[], options?: { signal?: AbortSignal }) => {
        calls.push({ args, hasSignal: options?.signal !== undefined });
        if (args[0] === "create") {
          controller.abort(reason);
          return { stdout: "committed-id\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`unexpected Docker command: ${args.join(" ")}`);
      }),
    };

    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker }).acquire(
      acquireInput(controller.signal),
    )).rejects.toBe(reason);
    expect(calls).toEqual([
      { args: expect.arrayContaining(["create", "--name"]), hasSignal: false },
      { args: ["rm", "--force", "committed-id"], hasSignal: false },
    ]);
  });

  it("uses the deterministic name and preserves cancellation when commit cleanup also fails", async () => {
    const controller = new AbortController();
    const reason = new Error("fence lost during create");
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") {
          controller.abort(reason);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error("cleanup failed");
      }),
    };

    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker }).acquire(
      acquireInput(controller.signal),
    )).rejects.toBe(reason);
    const containerName = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(calls[1]).toEqual(["rm", "--force", containerName]);
  });

  it("reaps the deterministic name when docker create rejects after a daemon-side commit", async () => {
    const reason = new Error("docker transport interrupted");
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") throw reason;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });

    await expect(adapter.acquire(acquireInput())).rejects.toBe(reason);
    const containerName = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(calls[1]).toEqual(["rm", "--force", containerName]);
  });

  it("reaps the deterministic name when docker create loses its container id", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: "\n", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });

    await expect(adapter.acquire(acquireInput())).rejects.toThrow(/no container id/i);
    const containerName = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(calls[1]).toEqual(["rm", "--force", containerName]);
  });

  it("reaps an allocated runtime when docker start rejects", async () => {
    const reason = new Error("start transport interrupted");
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") {
          return { stdout: "allocated-id\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "start") throw reason;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });

    await expect(adapter.acquire(acquireInput())).rejects.toBe(reason);
    expect(calls.at(-1)).toEqual(["rm", "--force", "allocated-id"]);
  });

  it("maps an interrupted attached worker to the driver aborted result", async () => {
    const controller = new AbortController();
    const reason = new Error("lease cancelled");
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "kill") return { stdout: "", stderr: "", exitCode: 0 };
        controller.abort(reason);
        throw reason;
      }),
    };
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });

    await expect(adapter.run({
      scope,
      fence,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
      signal: controller.signal,
    })).resolves.toEqual({ type: "aborted" });
    expect(docker.run).toHaveBeenCalledWith(["kill", "runtime"]);
  });
});

describe("DockerManagedRuntimeAdapter lifecycle contract", () => {
  it("declares the exact sandbox and direct-driver capabilities", async () => {
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker: commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 })) });
    await expect(adapter.capabilities()).resolves.toEqual({
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    });
    await expect(adapter.driverCapabilities()).resolves.toEqual({ drivers: ["ama_worker"] });
    await expect(adapter.suspend({} as never)).rejects.toThrow(/does not support suspend/i);
  });

  it("passes network, cwd, and environment configuration only through explicit arguments", async () => {
    const calls: string[][] = [];
    const docker = commandPort(async (args) => {
      calls.push(args);
      return args[0] === "create"
        ? { stdout: "runtime-configured\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    });
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", network: "isolated", docker });
    const input = acquireInput();
    input.plan.driver.process = {
      command: "worker",
      args: [],
      cwd: "/workspace/repo",
      env: { OMA_ENDPOINT: "http://gateway", EMPTY: "" },
    };
    await adapter.acquire(input);
    expect(calls[0]).toEqual(expect.arrayContaining([
      "--network", "isolated",
      "--workdir", "/workspace/repo",
      "--env", "OMA_ENDPOINT=http://gateway",
      "--env", "EMPTY=",
    ]));
  });

  it.each([
    [{ hostname: "bad:host", address: "127.0.0.1" }],
    [{ hostname: "host", address: "" }],
  ])("rejects malformed host aliases before allocation", async (host) => {
    const docker = commandPort(async () => ({ stdout: "runtime", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker, extraHosts: [host] });
    await expect(adapter.acquire(acquireInput())).rejects.toThrow(/host aliases/i);
    expect(docker.run).not.toHaveBeenCalled();
  });

  it.each([
    [{ metadata: { hostPath: "/tmp/source,invalid" }, mountPath: "/workspace" }],
    [{ metadata: { hostPath: "/tmp/source" }, mountPath: "/workspace,invalid" }],
  ])("rejects ambiguous bind mount serialization", async (workspace) => {
    const docker = commandPort(async () => ({ stdout: "runtime", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    await expect(adapter.acquire({ ...acquireInput(), workspace: { bindingId: "workspace", ...workspace } } as any)).rejects.toThrow(/cannot contain commas/i);
  });

  it("best-effort cleanup never hides create/start failures", async () => {
    const createFailure = new Error("create transport");
    let invocation = 0;
    const createDocker = commandPort(async () => {
      invocation += 1;
      if (invocation === 1) throw createFailure;
      throw new Error("cleanup failed");
    });
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: createDocker }).acquire(acquireInput())).rejects.toBe(createFailure);

    invocation = 0;
    const failedExitDocker = commandPort(async () => {
      invocation += 1;
      if (invocation === 1) return { stdout: "", stderr: "bad create", exitCode: 9 };
      throw new Error("cleanup failed");
    });
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: failedExitDocker }).acquire(acquireInput())).rejects.toThrow(/docker create failed \(9\): bad create/i);

    invocation = 0;
    const emptyIdDocker = commandPort(async () => {
      invocation += 1;
      if (invocation === 1) return { stdout: "", stderr: "", exitCode: 0 };
      throw new Error("cleanup failed");
    });
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: emptyIdDocker }).acquire(acquireInput())).rejects.toThrow(/no container id/i);

    invocation = 0;
    const startExitDocker = commandPort(async () => {
      invocation += 1;
      if (invocation === 1) return { stdout: "runtime\n", stderr: "", exitCode: 0 };
      if (invocation === 2) return { stdout: "", stderr: "bad start", exitCode: 8 };
      throw new Error("cleanup failed");
    });
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: startExitDocker }).acquire(acquireInput())).rejects.toThrow(/docker start failed \(8\): bad start/i);

    invocation = 0;
    const startThrow = new Error("start transport");
    const startThrowDocker = commandPort(async () => {
      invocation += 1;
      if (invocation === 1) return { stdout: "runtime\n", stderr: "", exitCode: 0 };
      if (invocation === 2) throw startThrow;
      throw new Error("cleanup failed");
    });
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: startThrowDocker }).acquire(acquireInput())).rejects.toBe(startThrow);
  });

  it("normalizes every Docker observation and heartbeat state", async () => {
    const states = ["running", "created", "restarting", "paused", "exited", "dead", "removing", "mystery"];
    const docker = commandPort(async () => ({ stdout: `${states.shift()}\n`, stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    const lease = { provider: "docker", runtimeId: "runtime" } as const;
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "running" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "running" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "running" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "suspended" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "stopped" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "stopped" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "stopped" });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "unknown" });

    const heartbeatDocker = commandPort(async () => ({ stdout: "paused", stderr: "", exitCode: 0 }));
    await expect(new DockerManagedRuntimeAdapter({ image: "image", docker: heartbeatDocker }).heartbeat({ scope, fence, lease })).resolves.toEqual({ type: "alive" });
  });

  it("validates leases and distinguishes missing from failed removals", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "daemon unavailable", exitCode: 1 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    for (const lease of [
      { provider: "other", runtimeId: "runtime" },
      { provider: "docker", runtimeId: "" },
    ]) {
      await expect(adapter.inspect(lease as any)).rejects.toThrow(/incompatible sandbox lease/i);
    }
    await expect(adapter.terminate({ scope, fence, lease: { provider: "docker", runtimeId: "runtime" }, reason: "failed" } as any)).rejects.toThrow(/docker rm failed/i);
  });

  it("returns aborted without starting a worker when its lease signal is already cancelled", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(adapter.run({
      scope,
      fence,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
      signal: controller.signal,
    })).resolves.toEqual({ type: "aborted" });
    expect(docker.run).not.toHaveBeenCalled();
  });

  it("rejects a supervised driver and preserves non-cancellation transport failures", async () => {
    const transportFailure = new Error("exec transport");
    const docker = commandPort(async () => { throw transportFailure; });
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    const base = {
      scope,
      fence,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      workspacePath: "/workspace",
      outputPath: null,
      signal: new AbortController().signal,
    };
    await expect(adapter.run({ ...base, driver: { type: "openma_supervised" } } as any)).rejects.toThrow(/cannot run openma_supervised/i);
    await expect(adapter.run({ ...base, driver: { type: "ama_worker", process: { command: "worker" } } } as any)).rejects.toBe(transportFailure);
  });

  it("returns aborted after a completed exec race and suppresses failed best-effort kill", async () => {
    const controller = new AbortController();
    const docker = commandPort(async (args) => {
      if (args[0] === "kill") throw new Error("kill transport failed");
      controller.abort(new Error("lease lost"));
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    await expect(adapter.run({
      scope,
      fence,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker" } },
      signal: controller.signal,
    })).resolves.toEqual({ type: "aborted" });
    await Promise.resolve();
  });
});

describe("DockerManagedRuntimeAdapter Session input contract", () => {
  it("leaves worker-owned memory stores to the official worker", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    await expect(adapter.materialize(materializeInput([
      { type: "memory_store", memory_store_id: "memory", mount_path: "/workspace/memory" },
    ]))).resolves.toBeUndefined();
    expect(docker.run).not.toHaveBeenCalled();
  });

  it("requires claim-scoped file access and complete safe file metadata", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    await expect(adapter.materialize(materializeInput([
      { type: "file", file_id: "file", mount_path: "/mnt/file" },
    ]))).rejects.toThrow(/requires per-claim/i);

    const access = { downloadFile: vi.fn(async () => ({ content: new Uint8Array() })) };
    for (const resource of [
      { type: "file", mount_path: "/mnt/file" },
      { type: "file", file_id: "", mount_path: "/mnt/file" },
      { type: "file", file_id: "file", mount_path: "relative" },
      { type: "file", file_id: "file", mount_path: "/mnt/../escape" },
      { type: "file", file_id: "file", mount_path: "/mnt/zero\0byte" },
    ]) {
      await expect(adapter.materialize(materializeInput([resource], { access }))).rejects.toThrow();
    }
  });

  it("stops file staging when cancellation wins after download", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    const controller = new AbortController();
    const reason = new Error("file download cancelled");
    const access = {
      downloadFile: vi.fn(async () => {
        controller.abort(reason);
        return { content: new Uint8Array([1]) };
      }),
    };
    await expect(adapter.materialize(materializeInput([
      { type: "file", file_id: "file", mount_path: "/mnt/file" },
    ], { access, signal: controller.signal }))).rejects.toBe(reason);
    expect(docker.run).not.toHaveBeenCalled();
  });

  it("reports checked Docker staging failures with operation context", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "mkdir failed", exitCode: 6 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    const access = { downloadFile: vi.fn(async () => ({ content: new Uint8Array([1]) })) };
    await expect(adapter.materialize(materializeInput([
      { type: "file", file_id: "file", mount_path: "/mnt/file" },
    ], { access }))).rejects.toThrow(/create Session file parent failed \(6\): mkdir failed/i);
  });

  it("does not reclone repositories after workspace checkpoint restore", async () => {
    const docker = commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    await expect(adapter.materialize(materializeInput([
      { type: "github_repository", url: "https://example.com/repo.git", mount_path: "/workspace/repo" },
    ], { activeWorkspaceCheckpoint: { id: "wcp", contentHash: "sha256:x", revision: 1 } }))).resolves.toBeUndefined();
    expect(docker.run).not.toHaveBeenCalled();
  });

  it("validates repository metadata, protocol, branch, and commit shapes", async () => {
    const calls: string[][] = [];
    const docker = commandPort(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker });
    for (const resource of [
      { type: "github_repository", mount_path: "/workspace/repo" },
      { type: "github_repository", url: "not a url", mount_path: "/workspace/repo" },
      { type: "github_repository", url: "ssh://example.com/repo", mount_path: "/workspace/repo" },
      { type: "github_repository", url: "https://example.com/repo", mount_path: "/workspace/repo", checkout: { type: "commit", sha: "bad" } },
      { type: "github_repository", url: "https://example.com/repo", mount_path: "/workspace/repo", checkout: { type: "commit", sha: 123 } },
    ]) {
      await expect(adapter.materialize(materializeInput([resource]))).rejects.toThrow();
    }

    await adapter.materialize(materializeInput([{
      type: "github_repository",
      url: "http://example.com/repo",
      mount_path: "/workspace/repo",
      checkout: { type: "branch", name: "main" },
    }]));
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["clone", "--branch", "main"]));

    await adapter.materialize(materializeInput([{
      type: "github_repository",
      url: "https://example.com/repo",
      mount_path: "/workspace/repo-2",
      checkout: { type: "branch", name: "" },
    }]));
    expect(calls.at(-1)).not.toContain("--branch");

    await adapter.materialize(materializeInput([{
      type: "github_repository",
      url: "https://example.com/repo",
      mount_path: "/workspace/repo-3",
      checkout: "default",
    }]));
    expect(calls.at(-1)).not.toContain("--branch");
  });

  it("fails closed on unknown official Session resource types and incompatible leases", async () => {
    const adapter = new DockerManagedRuntimeAdapter({ image: "image", docker: commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 })) });
    await expect(adapter.materialize(materializeInput([{ type: "future_resource" }]))).rejects.toThrow(/unsupported Session resource type/i);
    await expect(adapter.materialize(materializeInput([], { sandbox: { provider: "other", runtimeId: "runtime" } }))).rejects.toThrow(/incompatible sandbox lease/i);
  });
});

describe("DockerManagedRuntimeAdapter supervisor transport", () => {
  function adapterWithProcess(process: ReturnType<typeof duplexProcess>) {
    const docker = {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      spawnDuplex: vi.fn(() => process),
    };
    return { adapter: new DockerManagedRuntimeAdapter({ image: "image", docker }), docker };
  }

  async function collectEvents(lines: string[]) {
    const process = duplexProcess(lines);
    const { adapter } = adapterWithProcess(process);
    const controller = new AbortController();
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor", args: ["--jsonl"] },
      signal: controller.signal,
    });
    const events = [];
    for await (const event of channel.events(controller.signal)) events.push(event);
    await channel.close();
    return events;
  }

  it("parses fragmented, blank, and trailing valid supervisor events", async () => {
    await expect(collectEvents([
      "\n{\"type\":\"heart",
      "beat\",\"sequence\":0}\n{\"type\":\"error\",\"message\":\"failed\"}\n",
      `{\"type\":\"checkpoint\",\"checkpointId\":\"checkpoint_1\",\"sessionId\":\"${scope.sessionId}\"}\n`,
      "{\"type\":\"completed\",\"exitCode\":-1}",
    ])).resolves.toEqual([
      { type: "heartbeat", sequence: 0 },
      { type: "error", message: "failed" },
      { type: "checkpoint", checkpointId: "checkpoint_1", sessionId: scope.sessionId },
      { type: "completed", exitCode: -1 },
    ]);
    await expect(collectEvents(["\n"])).resolves.toEqual([]);
  });

  it.each([
    ["not-json", /invalid JSON/i],
    ["null", /object with a type/i],
    ["{}", /object with a type/i],
    ["{\"type\":\"ready\",\"protocol\":\"bad\"}", /unsupported ready protocol/i],
    ["{\"type\":\"heartbeat\",\"sequence\":1.5}", /sequence must be non-negative/i],
    ["{\"type\":\"heartbeat\",\"sequence\":-1}", /sequence must be non-negative/i],
    ["{\"type\":\"checkpoint\",\"sessionId\":\"session\"}", /checkpoint request is invalid/i],
    ["{\"type\":\"checkpoint\",\"checkpointId\":\"\",\"sessionId\":\"session\"}", /checkpoint request is invalid/i],
    ["{\"type\":\"checkpoint\",\"checkpointId\":\"checkpoint\"}", /checkpoint request is invalid/i],
    ["{\"type\":\"checkpoint\",\"checkpointId\":\"checkpoint\",\"sessionId\":\"\"}", /checkpoint request is invalid/i],
    ["{\"type\":\"checkpoint\",\"checkpointId\":\"checkpoint\",\"sessionId\":\"session\",\"turnId\":7}", /checkpoint request is invalid/i],
    ["{\"type\":\"checkpoint\",\"checkpointId\":\"checkpoint\",\"sessionId\":\"session\",\"turnId\":\"\"}", /checkpoint request is invalid/i],
    ["{\"type\":\"completed\",\"exitCode\":1.5}", /exitCode must be an integer/i],
    ["{\"type\":\"error\",\"message\":7}", /message must be non-empty/i],
    ["{\"type\":\"error\",\"message\":\"\"}", /message must be non-empty/i],
    ["{\"type\":\"future\"}", /unknown harness supervisor event/i],
  ])("fails closed on malformed supervisor event %s", async (line, expected) => {
    await expect(collectEvents([line])).rejects.toThrow(expected);
  });

  it("requires duplex support, a live signal, and a compatible lease", async () => {
    const noDuplex = new DockerManagedRuntimeAdapter({ image: "image", docker: commandPort(async () => ({ stdout: "", stderr: "", exitCode: 0 })) });
    const base = {
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: new AbortController().signal,
    };
    await expect(noDuplex.open(base)).rejects.toThrow(/no duplex process capability/i);
    await expect(noDuplex.open({ ...base, sandbox: { provider: "other", runtimeId: "runtime" } })).rejects.toThrow(/incompatible sandbox lease/i);
    const controller = new AbortController();
    const reason = new Error("cancel open");
    controller.abort(reason);
    await expect(noDuplex.open({ ...base, signal: controller.signal })).rejects.toBe(reason);
  });

  it("allows one event consumer, rejects sends after close, and makes close idempotent", async () => {
    const process = duplexProcess([]);
    const { adapter } = adapterWithProcess(process);
    const controller = new AbortController();
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: controller.signal,
    });
    channel.events(controller.signal);
    expect(() => channel.events(controller.signal)).toThrow(/only be consumed once/i);
    await channel.close();
    await expect(channel.close()).resolves.toBeUndefined();
    await expect(channel.send({ type: "drain" })).rejects.toThrow(/channel is closed/i);
  });

  it("kills the supervisor on claim abort and suppresses best-effort kill failures", async () => {
    const process = duplexProcess([], { killRejects: true });
    const { adapter } = adapterWithProcess(process);
    const controller = new AbortController();
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: controller.signal,
    });
    controller.abort(new Error("claim lost"));
    await Promise.resolve();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(channel.close()).resolves.toBeUndefined();
  });

  it("suppresses diagnostic drain and writer-close failures during best-effort shutdown", async () => {
    const process = {
      ...duplexProcess([], { killRejects: true }),
      stdin: new WritableStream<Uint8Array>({
        close() {
          throw new Error("writer close failed");
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("stderr failed"));
        },
      }),
    };
    const { adapter } = adapterWithProcess(process);
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    await expect(channel.close()).resolves.toBeUndefined();
  });

  it("cancels a blocked event read with the caller's abort reason", async () => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const process = {
      ...duplexProcess([]),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => { stdoutController = controller; } }),
    };
    void stdoutController;
    const { adapter } = adapterWithProcess(process);
    const claim = new AbortController();
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: new AbortController().signal,
    });
    const iterator = channel.events(claim.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const reason = new Error("stream cancelled");
    claim.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await channel.close();
  });

  it("preserves the abort reason even when reader cancellation itself fails", async () => {
    const process = {
      ...duplexProcess([]),
      stdout: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          throw new Error("cancel failed");
        },
      }),
    };
    const { adapter } = adapterWithProcess(process);
    const claim = new AbortController();
    const channel = await adapter.open({
      scope,
      sandbox: { provider: "docker", runtimeId: "runtime" },
      process: { command: "supervisor" },
      signal: new AbortController().signal,
    });
    const iterator = channel.events(claim.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const reason = new Error("stream cancelled");
    claim.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await channel.close();
  });
});
