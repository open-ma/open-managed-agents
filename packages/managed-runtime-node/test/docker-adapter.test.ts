import { describe, expect, it, vi } from "vitest";

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

describe("DockerManagedRuntimeAdapter", () => {
  it("binds declared workspace/output paths and never exposes the fence token", async () => {
    const calls: string[][] = [];
    const docker = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create") return { stdout: "container-123\n", stderr: "", exitCode: 0 };
        if (args[0] === "start") return { stdout: "", stderr: "", exitCode: 0 };
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
    expect(calls[1]).toEqual(["start", "--attach", "container-123"]);
    expect(calls[2]).toEqual(["rm", "--force", "container-123"]);
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

  it("creates an interactive supervisor container without changing the direct-worker lane", async () => {
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
      "--interactive",
      "--entrypoint",
      "/usr/local/bin/node",
      "node:24-alpine",
      "/opt/openma/supervisor.mjs",
    ]));
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
              + '{"type":"completed","exitCode":0}\n',
          ));
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
      value: { type: "completed", exitCode: 0 },
    });
    await channel.send({ type: "drain" });
    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "drained" },
    });
    await channel.close();

    expect(docker.spawnDuplex).toHaveBeenCalledWith([
      "start",
      "--attach",
      "--interactive",
      "container-duplex",
    ]);
    expect(writes.map((value: any) => value.type)).toEqual(["start", "drain"]);
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
