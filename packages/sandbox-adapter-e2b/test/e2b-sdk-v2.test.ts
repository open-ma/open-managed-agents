import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(async (template: string) => makeSdkSandbox(`created:${template}`)),
  connect: vi.fn(async (sandboxId: string) => makeSdkSandbox(`connected:${sandboxId}`)),
}));

function makeSdkSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
    kill: vi.fn(),
    getInfo: vi.fn(async () => ({ state: "running" })),
    setTimeout: vi.fn(async () => {}),
    pause: vi.fn(async () => true),
    connect: vi.fn(async function (this: unknown) { return this; }),
    createSnapshot: vi.fn(async () => ({
      snapshotId: "snap_default",
      names: ["project/default:v1"],
    })),
  };
}

vi.mock("e2b", () => ({
  Sandbox: { create: sdk.create, connect: sdk.connect },
}));

import * as e2bAdapter from "../src/e2b";
import { sandboxFactory } from "../src/e2b";
import { E2BSandboxExecutor } from "../src/e2b";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) return value + decoder.decode();
    value += decoder.decode(item.value, { stream: true });
  }
}

describe("E2B SDK v2 adapter", () => {
  beforeEach(() => {
    sdk.create.mockClear();
    sdk.connect.mockClear();
  });

  it("passes the template and self-hosted endpoints using the official v2 shape", async () => {
    await sandboxFactory(
      { sessionId: "session_e2b", workdir: "/tmp/unused" },
      {
        E2B_API_KEY: "local",
        E2B_API_URL: "http://127.0.0.1:3000",
        E2B_SANDBOX_URL: "http://127.0.0.1:3002",
        E2B_DOMAIN: "localhost",
        SANDBOX_IMAGE: "code-interpreter",
      },
    );

    expect(sdk.create).toHaveBeenCalledWith("code-interpreter", {
      apiKey: "local",
      apiUrl: "http://127.0.0.1:3000",
      sandboxUrl: "http://127.0.0.1:3002",
      domain: "localhost",
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
  });

  it("uses the official live-stdin command channel for ACP", async () => {
    let commandOptions:
      | {
          background?: boolean;
          stdin?: boolean;
          timeoutMs?: number;
          cwd?: string;
          envs?: Record<string, string>;
          onStdout?(data: string): void;
          onStderr?(data: string): void;
        }
      | undefined;
    let finish!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => { finish = resolve; },
    );
    const handle = {
      pid: 73,
      async sendStdin(data: Uint8Array) {
        commandOptions?.onStdout?.(new TextDecoder().decode(data));
      },
      async closeStdin() {},
      async kill() { return true; },
      wait: () => wait,
    };
    const adapter = new E2BSandboxExecutor({
      commands: {
        async run(_command: string, options: typeof commandOptions) {
          commandOptions = options;
          return handle;
        },
      },
      files: { async read() { return ""; }, async write() {} },
      async kill() {},
    } as never, {});

    const child = await adapter.spawnDuplexProcess({
      command: "agent",
      args: ["--acp"],
      cwd: "/workspace",
      env: { MODEL: "test" },
    });
    const stdout = readAll(child.stdout);
    const stderr = readAll(child.stderr);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode('{"id":1}\n'));
    await writer.write(new TextEncoder().encode('{"id":2}\n'));
    await writer.close();
    commandOptions?.onStderr?.("diagnostic");
    finish({ stdout: "", stderr: "", exitCode: 0 });

    expect(commandOptions).toMatchObject({
      background: true,
      stdin: true,
      timeoutMs: 0,
      cwd: "/workspace",
      envs: { MODEL: "test" },
    });
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe('{"id":1}\n{"id":2}\n');
    await expect(stderr).resolves.toBe("diagnostic");
  });

  it("maps lease, suspend, resume and durable checkpoint to the official E2B lifecycle", async () => {
    const calls: unknown[] = [];
    const sandbox = {
      ...makeSdkSandbox("sb_runtime_01"),
      async getInfo() { return { state: "paused" as const }; },
      async setTimeout(timeoutMs: number) { calls.push(["setTimeout", timeoutMs]); },
      async pause(options: { keepMemory?: boolean }) {
        calls.push(["pause", options]);
        return true;
      },
      async connect() {
        calls.push(["connect"]);
        return this;
      },
      async createSnapshot(options: { name?: string }) {
        calls.push(["createSnapshot", options]);
        return {
          snapshotId: "snap_checkpoint_01",
          names: ["project/checkpoint:v1"],
        };
      },
    };
    const adapter = new E2BSandboxExecutor(sandbox as never, {});
    const runtime = adapter as unknown as {
      runtimeHandle(): { provider: string; runtimeId: string };
      runtimeCapabilities(): {
        lease: boolean;
        suspend: string[];
        checkpoint: string[];
      };
      status(): Promise<string>;
      renewLease(input: { ttlMs: number }): Promise<void>;
      suspend(input: { kind: "filesystem" | "memory" }): Promise<unknown>;
      resume(checkpoint: unknown): Promise<void>;
      checkpoint(input: { kind: "memory"; name: string }): Promise<unknown>;
    };

    expect(runtime.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "sb_runtime_01",
    });
    expect(runtime.runtimeCapabilities()).toEqual({
      lease: true,
      suspend: ["filesystem", "memory"],
      checkpoint: ["memory"],
    });
    await expect(runtime.status()).resolves.toBe("suspended");
    await runtime.renewLease({ ttlMs: 45_000 });
    const suspension = await runtime.suspend({ kind: "memory" });
    expect(suspension).toEqual({
      provider: "e2b",
      checkpointId: "sb_runtime_01",
      sourceRuntimeId: "sb_runtime_01",
      kind: "memory",
      scope: "runtime",
    });
    await runtime.resume(suspension);
    const snapshot = await runtime.checkpoint({
      kind: "memory",
      name: "checkpoint-01",
    });
    expect(snapshot).toEqual({
      provider: "e2b",
      checkpointId: "snap_checkpoint_01",
      sourceRuntimeId: "sb_runtime_01",
      kind: "memory",
      scope: "portable",
    });
    expect(calls).toEqual([
      ["setTimeout", 45_000],
      ["pause", { keepMemory: true }],
      ["connect"],
      ["createSnapshot", { name: "checkpoint-01" }],
    ]);
  });

  it("restores portable snapshots and resumes suspended runtimes through the provider port", async () => {
    const provider = (e2bAdapter as unknown as {
      sandboxProvider?: {
        resume(
          handle: unknown,
          context: { sessionId: string; workdir: string },
          env: Record<string, string>,
        ): Promise<unknown>;
        restore(
          checkpoint: unknown,
          context: { sessionId: string; workdir: string },
          env: Record<string, string>,
        ): Promise<unknown>;
      };
    }).sandboxProvider;
    expect(provider).toBeDefined();

    const context = { sessionId: "session_e2b_restore", workdir: "/tmp/unused" };
    const env = { E2B_API_KEY: "test-key", E2B_DOMAIN: "sandbox.test" };
    const resumed = await provider!.resume({
      provider: "e2b",
      runtimeId: "sb_paused_01",
    }, context, env) as { runtimeHandle(): unknown };
    const restored = await provider!.restore({
      provider: "e2b",
      checkpointId: "snap_portable_01",
      sourceRuntimeId: "sb_source_01",
      kind: "memory",
      scope: "portable",
    }, context, env) as { runtimeHandle(): unknown };

    expect(sdk.connect).toHaveBeenCalledWith("sb_paused_01", {
      apiKey: "test-key",
      apiUrl: undefined,
      sandboxUrl: undefined,
      domain: "sandbox.test",
    });
    expect(sdk.create).toHaveBeenCalledWith("snap_portable_01", {
      apiKey: "test-key",
      apiUrl: undefined,
      sandboxUrl: undefined,
      domain: "sandbox.test",
      lifecycle: {
        onTimeout: { action: "pause", keepMemory: true },
        autoResume: true,
      },
    });
    expect(resumed.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "connected:sb_paused_01",
    });
    expect(restored.runtimeHandle()).toEqual({
      provider: "e2b",
      runtimeId: "created:snap_portable_01",
    });
  });
});
