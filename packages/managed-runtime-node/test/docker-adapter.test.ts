import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";

import * as nodeRuntimeModule from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "worker_1",
  generation: 3,
  token: "secret-fence",
  expiresAt: "2026-09-03T12:00:00.000Z",
};

function DockerAdapter(): new (options: any) => any {
  const candidate = (nodeRuntimeModule as Record<string, unknown>)[
    "DockerManagedRuntimeAdapter"
  ];
  expect(candidate).toBeTypeOf("function");
  return candidate as new (options: any) => any;
}

function statefulDocker(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === "exec" && args[2] === "test" && args[3] === "-f") {
      return { stdout: "", stderr: "", exitCode: files.has(args[4]!) ? 0 : 1 };
    }
    if (args[0] === "exec" && args[2] === "find") {
      const root = args[3]!;
      const paths = [...files.keys()].filter((path) => path.startsWith(`${root}/`));
      return { stdout: paths.length === 0 ? "" : `${paths.join("\0")}\0`, stderr: "", exitCode: 0 };
    }
    if (args[0] === "exec" && args[2] === "rm" && args[3] === "-rf") {
      const root = args.at(-1)!;
      for (const path of [...files.keys()]) {
        if (path === root || path.startsWith(`${root}/`)) files.delete(path);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "cp") {
      const source = args[1]!;
      const target = args[2]!;
      const sourcePrefix = "container-memory:";
      const targetPrefix = "container-memory:";
      if (source.startsWith(sourcePrefix)) {
        await writeFile(target, files.get(source.slice(sourcePrefix.length)) ?? "", "utf8");
      } else if (target.startsWith(targetPrefix)) {
        files.set(target.slice(targetPrefix.length), await readFile(source, "utf8"));
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return { files, run };
}

describe("DockerManagedRuntimeAdapter", () => {
  it("starts a long-lived runtime during acquire and executes the worker only after staging", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") {
          return { stdout: "container-staged\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const signal = new AbortController().signal;
    const lease = await adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: { command: "node", args: ["/opt/worker.mjs"] },
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: null,
      signal,
    });

    expect(calls[0]).toEqual(expect.arrayContaining([
      "create",
      "--entrypoint",
      "/bin/sh",
      "node:24-alpine",
      "-c",
      "while :; do sleep 3600; done",
    ]));
    expect(calls[1]).toEqual(["start", "container-staged"]);

    await expect(adapter.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: {
        type: "ama_worker",
        process: { command: "node", args: ["/opt/worker.mjs"] },
      },
      signal,
    })).resolves.toEqual({ type: "completed" });
    expect(calls[2]).toEqual([
      "exec",
      "container-staged",
      "node",
      "/opt/worker.mjs",
    ]);
  });

  it("materializes binary files and repositories inside the running container", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const materialize = Reflect.get(adapter, "materialize");
    expect(materialize).toBeTypeOf("function");
    const signal = new AbortController().signal;
    const downloadFile = vi.fn(async () => ({
      content: new Uint8Array([0, 255, 1]),
      mimeType: "application/octet-stream",
    }));

    await (materialize as Function).call(adapter, {
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [
          {
            type: "file",
            file_id: "file_01",
            mount_path: "/mnt/session/uploads/input.bin",
          },
          {
            type: "github_repository",
            url: "https://github.com/openma-ai/example.git",
            mount_path: "/workspace/example",
            checkout: { type: "commit", sha: "0123456789abcdef" },
          },
        ],
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      sandbox: { provider: "docker", runtimeId: "container-inputs" },
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "worker" },
      idempotencyKey: "inputs-1",
      access: { downloadFile },
      signal,
    });

    expect(downloadFile).toHaveBeenCalledWith({ fileId: "file_01", signal });
    expect(calls[0]).toEqual([
      "exec",
      "container-inputs",
      "mkdir",
      "-p",
      "/mnt/session/uploads",
    ]);
    expect(calls[1]?.[0]).toBe("cp");
    expect(calls[1]?.at(-1)).toBe("container-inputs:/mnt/session/uploads/input.bin");
    expect(calls[2]).toEqual([
      "exec",
      "--env",
      "GIT_TERMINAL_PROMPT=0",
      "container-inputs",
      "git",
      "clone",
      "--",
      "https://github.com/openma-ai/example.git",
      "/workspace/example",
    ]);
    expect(calls[3]).toEqual([
      "exec",
      "container-inputs",
      "git",
      "-C",
      "/workspace/example",
      "checkout",
      "--detach",
      "0123456789abcdef",
    ]);
  });

  it("hydrates supervised memory through the shared Session input lifecycle", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args.includes("test") && args.includes("-f")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });

    await expect(adapter.materialize({
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      sandbox: { provider: "docker", runtimeId: "container-memory" },
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "materializer" },
      idempotencyKey: "inputs-memory-1",
      access: {
        downloadFile: vi.fn(),
        memories: {
          list: vi.fn(async () => [{
            id: "mem_01",
            path: "/notes.md",
            content: "canonical",
            contentSha256: "sha-canonical",
          }]),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
      authorize: vi.fn(async () => true),
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    expect(calls).toContainEqual(expect.arrayContaining([
      "cp",
      expect.any(String),
      "container-memory:/workspace/memory/notes.md",
    ]));
    expect(calls).toContainEqual(expect.arrayContaining([
      "cp",
      expect.any(String),
      "container-memory:/workspace/memory/.openma-memory-store",
    ]));
  });

  it("round-trips container Memory edits through the canonical CAS boundary", async () => {
    const docker = statefulDocker();
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    let content = "base";
    let sha = "sha-base";
    const list = vi.fn(async () => [{
      id: "mem_01",
      path: "/notes.md",
      content,
      contentSha256: sha,
    }]);
    const update = vi.fn(async (input: { content: string }) => {
      content = input.content;
      sha = "sha-local";
      return {
        type: "applied" as const,
        memory: { id: "mem_01", path: "/notes.md", content, contentSha256: sha },
      };
    });
    const context = {
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      sandbox: { provider: "docker", runtimeId: "container-memory" },
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "materializer" as const },
      idempotencyKey: "inputs-memory-roundtrip",
      access: {
        downloadFile: vi.fn(),
        memories: {
          list,
          create: vi.fn(),
          update,
          delete: vi.fn(),
        },
      },
      authorize: vi.fn(async () => true),
      signal: new AbortController().signal,
    };

    await adapter.materialize(context);
    docker.files.set("/workspace/memory/notes.md", "local");
    await adapter.synchronize(context);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: "mem_01",
      content: "local",
      expectedContentSha256: "sha-base",
    }));
    expect(docker.files.get("/workspace/memory/notes.md")).toBe("local");
  });

  it("treats an absent or empty Memory directory as untrusted and rehydrates it", async () => {
    for (const findResult of [
      { stdout: "", stderr: "no such file", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "/workspace/memory/vanished.md\0", stderr: "", exitCode: 0 },
    ]) {
      const docker = statefulDocker();
      const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
      const context = {
        scope,
        fence,
        session: {
          id: scope.sessionId,
          environmentId: scope.environmentId,
          metadata: {},
          resources: [{
            type: "memory_store",
            memory_store_id: "memstore_01",
            mount_path: "/workspace/memory",
            access: "read_write",
          }],
        },
        workspace: { bindingId: "workspace", mountPath: "/workspace" },
        sandbox: { provider: "docker", runtimeId: "container-memory" },
        activeWorkspaceCheckpoint: null,
        resourceOwnership: { memoryStore: "materializer" as const },
        idempotencyKey: "inputs-memory-rehydrate",
        access: {
          downloadFile: vi.fn(),
          memories: {
            list: vi.fn(async () => []),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
          },
        },
        authorize: vi.fn(async () => true),
        signal: new AbortController().signal,
      };
      await adapter.materialize(context);
      const original = docker.run.getMockImplementation()!;
      docker.run.mockImplementation(async (args: string[]) =>
        args[0] === "exec" && args[2] === "find" ? findResult : original(args));
      await expect(adapter.synchronize(context)).resolves.toBeUndefined();
      docker.run.mockImplementation(original);
    }
  });

  it.each([
    [{ stdout: "", stderr: "permission denied", exitCode: 2 }, /scan Session Memory failed/u],
    [{ stdout: "/outside/a.md\0", stderr: "", exitCode: 0 }, /escaped its mount root/u],
    [{ stdout: "/workspace/memory/\0", stderr: "", exitCode: 0 }, /unsafe path/u],
    [{ stdout: "/workspace/memory/../a.md\0", stderr: "", exitCode: 0 }, /unsafe path/u],
  ])("rejects an invalid Docker Memory scan %#", async (findResult, expected) => {
    const docker = statefulDocker();
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const context = {
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      sandbox: { provider: "docker", runtimeId: "container-memory" },
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "materializer" as const },
      idempotencyKey: "inputs-memory-invalid-scan",
      access: {
        downloadFile: vi.fn(),
        memories: {
          list: vi.fn(async () => []),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
      authorize: vi.fn(async () => true),
      signal: new AbortController().signal,
    };
    await adapter.materialize(context);
    const original = docker.run.getMockImplementation()!;
    docker.run.mockImplementation(async (args: string[]) =>
      args[0] === "exec" && args[2] === "find" ? findResult : original(args));

    await expect(adapter.synchronize(context)).rejects.toThrow(expected);
  });

  it("rejects a Docker file probe failure during Memory reconciliation", async () => {
    const docker = statefulDocker();
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const context = {
      scope,
      fence,
      session: {
        id: scope.sessionId,
        environmentId: scope.environmentId,
        metadata: {},
        resources: [{
          type: "memory_store",
          memory_store_id: "memstore_01",
          mount_path: "/workspace/memory",
          access: "read_write",
        }],
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      sandbox: { provider: "docker", runtimeId: "container-memory" },
      activeWorkspaceCheckpoint: null,
      resourceOwnership: { memoryStore: "materializer" as const },
      idempotencyKey: "inputs-memory-bad-probe",
      access: {
        downloadFile: vi.fn(),
        memories: {
          list: vi.fn(async () => []),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
      authorize: vi.fn(async () => true),
      signal: new AbortController().signal,
    };
    await adapter.materialize(context);
    const original = docker.run.getMockImplementation()!;
    docker.run.mockImplementation(async (args: string[]) => {
      if (args[0] === "exec" && args[2] === "test" && args[4] === "/workspace/memory/.openma-memory-store") {
        return { stdout: "", stderr: "daemon failure", exitCode: 2 };
      }
      return original(args);
    });

    await expect(adapter.synchronize(context)).rejects.toThrow(/probe Session Memory file failed/u);
  });

  it("reaps a deterministic container name when create is interrupted after the daemon side effect", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") {
          return { stdout: "", stderr: "interrupted", exitCode: 143 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });

    await expect(adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: null,
      signal: new AbortController().signal,
    })).rejects.toThrow(/docker create failed/);

    const name = calls[0]?.[calls[0]!.indexOf("--name") + 1];
    expect(name).toMatch(/^oma-/);
    expect(calls[1]).toEqual(["rm", "--force", name]);
  });

  it("binds declared workspace/output paths and never exposes the fence token", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") return { stdout: "container-123\n", stderr: "", exitCode: 0 };
        if (args[0] === "start" || args[0] === "exec") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`Unexpected docker command: ${args.join(" ")}`);
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const controller = new AbortController();
    const lease = await adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "final_collect",
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "/bin/sh",
            args: ["-c", "echo done"],
          },
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: {
        bindingId: "output-binding",
        mountPath: "/mnt/session/outputs",
        metadata: { hostPath: "/tmp/openma/outputs" },
      },
      signal: controller.signal,
    });
    await expect(
      adapter.run({
        scope,
        fence,
        sandbox: lease,
        workspacePath: "/workspace",
        outputPath: "/mnt/session/outputs",
        driver: {
          type: "ama_worker",
          process: {
            command: "/bin/sh",
            args: ["-c", "echo done"],
          },
        },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ type: "completed" });
    await adapter.terminate({ scope, fence, lease, reason: "completed" });

    expect(lease).toEqual({ provider: "docker", runtimeId: "container-123" });
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "create",
        "--mount",
        "type=bind,src=/tmp/openma/workspace,dst=/workspace",
        "type=bind,src=/tmp/openma/outputs,dst=/mnt/session/outputs",
        "example/managed-hand:test",
      ]),
    );
    expect(calls.flat().join(" ")).not.toContain(fence.token);
    expect(calls[1]).toEqual(["start", "container-123"]);
    expect(calls[2]).toEqual([
      "exec",
      "container-123",
      "/bin/sh",
      "-c",
      "echo done",
    ]);
    expect(calls[3]).toEqual(["rm", "--force", "container-123"]);
  });

  it("adds operator-owned read-only mounts and host aliases to the runtime", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: "container-mounted\n", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "node:24-alpine",
      additionalMounts: [{
        source: "/opt/openma",
        destination: "/opt/openma",
        readOnly: true,
      }],
      extraHosts: [{ hostname: "host.docker.internal", address: "host-gateway" }],
    });

    await adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "disabled",
        runtimeCheckpoint: null,
        driver: {
          type: "ama_worker",
          process: { command: "/usr/local/bin/node", args: ["/workspace/worker.mjs"] },
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: null,
      signal: new AbortController().signal,
    });

    expect(calls[0]).toEqual(expect.arrayContaining([
      "--mount",
      "type=bind,src=/opt/openma,dst=/opt/openma,readonly",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]));
  });

  it("creates the same long-lived runtime for the supervised lane", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        return { stdout: "container-supervised\n", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });

    await expect(adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "disabled",
        runtimeCheckpoint: null,
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: {
            command: "/usr/local/bin/node",
            args: ["/opt/openma/supervisor.mjs"],
          },
          harness: { id: "pi", version: "1" },
          readyTimeoutMs: 2_000,
          heartbeatTimeoutMs: 2_000,
          drainTimeoutMs: 2_000,
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: null,
      signal: new AbortController().signal,
    })).resolves.toEqual({ provider: "docker", runtimeId: "container-supervised" });

    expect(calls[0]).toEqual(expect.arrayContaining([
      "--entrypoint",
      "/bin/sh",
      "node:24-alpine",
      "-c",
      "while :; do sleep 3600; done",
    ]));
    expect(calls[1]).toEqual(["start", "container-supervised"]);
  });

  it("opens the supervised container as a duplex JSONL channel", async () => {
    const encoder = new TextEncoder();
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const writes: unknown[] = [];
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        const command = JSON.parse(new TextDecoder().decode(chunk));
        writes.push(command);
        if (command.type === "start") {
          stdoutController.enqueue(encoder.encode(
            '{"type":"ready","protocol":"openma-harness-supervisor-v1"}\n'
              + `{"type":"checkpoint","checkpointId":"checkpoint_1","sessionId":"${scope.sessionId}","turnId":"turn_1"}\n`
              + '{"type":"completed","exitCode":0}\n',
          ));
        } else if (command.type === "checkpoint.commit") {
          // The fake process has already emitted its next record.
        } else if (command.type === "drain") {
          stdoutController.enqueue(encoder.encode('{"type":"drained"}\n'));
        }
      },
      close() {
        stdoutController.close();
      },
    });
    const child = {
      stdin,
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: new Promise<{ code: number | null; signal: string | null }>(() => {}),
      kill: vi.fn(async () => stdoutController.close()),
    };
    const docker = {
      run: vi.fn(async () => ({
        stdout: "container-duplex\n",
        stderr: "",
        exitCode: 0,
      })),
      spawnDuplex: vi.fn(() => child),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const controller = new AbortController();
    const lease = await adapter.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "checkpoint_restore",
        outputStrategy: "disabled",
        runtimeCheckpoint: null,
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: { command: "/usr/local/bin/node" },
          harness: { id: "fixture", version: "1" },
          readyTimeoutMs: 2_000,
          heartbeatTimeoutMs: 2_000,
          drainTimeoutMs: 2_000,
        },
      },
      workspace: {
        bindingId: "workspace-binding",
        mountPath: "/workspace",
        metadata: { hostPath: "/tmp/openma/workspace" },
      },
      outputs: null,
      signal: controller.signal,
    });
    const open = (adapter as unknown as Record<string, unknown>).open;
    expect(open).toBeTypeOf("function");
    const channel = await (open as Function).call(adapter, {
      scope,
      sandbox: lease,
      process: { command: "/usr/local/bin/node" },
      signal: controller.signal,
    });
    const events = channel.events(controller.signal)[Symbol.asyncIterator]();
    await channel.send({
      type: "start",
      scope,
      harness: { id: "fixture", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "ready", protocol: "openma-harness-supervisor-v1" },
    });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        type: "checkpoint",
        checkpointId: "checkpoint_1",
        sessionId: scope.sessionId,
        turnId: "turn_1",
      },
    });
    await channel.send({ type: "checkpoint.commit", checkpointId: "checkpoint_1" });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "completed", exitCode: 0 },
    });
    await channel.send({ type: "drain" });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "drained" },
    });
    await channel.close();

    expect(docker.spawnDuplex).toHaveBeenCalledWith([
      "exec",
      "--interactive",
      "container-duplex",
      "/usr/local/bin/node",
    ]);
    expect(writes.map((value: any) => value.type)).toEqual([
      "start",
      "checkpoint.commit",
      "drain",
    ]);
  });

  it("reports a disappeared container as a lost sandbox lease", async () => {
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "inspect") {
          return { stdout: "", stderr: "not found", exitCode: 1 };
        }
        return { stdout: "container-456\n", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const lease = { provider: "docker", runtimeId: "container-456" };

    await expect(adapter.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "lost",
    });
    await expect(adapter.inspect(lease)).resolves.toEqual({ state: "stopped" });
  });

  it("keeps the runtime lease alive while an attached worker process settles", async () => {
    let resolveStart!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const start = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => { resolveStart = resolve; },
    );
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "exec") return start;
        if (args[0] === "inspect") {
          return { stdout: "running\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const lease = { provider: "docker", runtimeId: "container-clean-exit" };
    const execution = adapter.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: {
        type: "ama_worker",
        process: { command: "worker" },
      },
      signal: new AbortController().signal,
    });

    await expect(adapter.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "alive",
    });
    resolveStart({ stdout: "", stderr: "", exitCode: 0 });
    await expect(execution).resolves.toEqual({ type: "completed" });
    await expect(adapter.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "alive",
    });
  });

  it("reports a stopped long-lived container as lost while docker exec is pending", async () => {
    let resolveExec!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const exec = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => { resolveExec = resolve; },
    );
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "exec") return exec;
        if (args[0] === "inspect") {
          return { stdout: "exited\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const adapter = new (DockerAdapter())({ docker, image: "node:24-alpine" });
    const lease = { provider: "docker", runtimeId: "container-crashed" };
    const execution = adapter.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: {
        type: "ama_worker",
        process: { command: "worker" },
      },
      signal: new AbortController().signal,
    });

    await expect(adapter.heartbeat({ scope, fence, lease })).resolves.toEqual({
      type: "lost",
    });
    resolveExec({ stdout: "", stderr: "container is not running", exitCode: 1 });
    await expect(execution).rejects.toThrow("docker exec failed");
  });

  it("reaps a serialized orphan lease and treats an already-missing container as success", async () => {
    let removals = 0;
    const docker = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] !== "rm") throw new Error(`unexpected:${args.join(" ")}`);
        removals += 1;
        if (removals === 1) {
          return { stdout: "", stderr: "daemon partitioned", exitCode: 1 };
        }
        return {
          stdout: "",
          stderr: removals === 3 ? "No such container" : "",
          exitCode: removals === 3 ? 1 : 0,
        };
      }),
    };
    const adapter = new (DockerAdapter())({
      docker,
      image: "example/managed-hand:test",
    });
    const lease = { provider: "docker", runtimeId: "orphan-container" };

    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).rejects.toThrow(/daemon partitioned/i);
    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
    await expect(
      adapter.reap({ scope, lease, reason: "lease_lost" }),
    ).resolves.toBeUndefined();
  });
});
