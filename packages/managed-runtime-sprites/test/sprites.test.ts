import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createSpritesManagedRuntime,
  createSpritesManagedRuntimeDriver,
  createSpritesProvider,
  createSpritesSandbox,
  type SpriteFilesystemPort,
  type SpriteSdkPort,
  type SpritesClientPort,
} from "../src/sprites";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "owner_1",
  generation: 1,
  token: "secret",
  expiresAt: "2026-09-07T12:00:00.000Z",
};

class FakeFilesystem implements SpriteFilesystemPort {
  readFile(_path: string, encoding: "utf8"): Promise<string>;
  readFile(_path: string, encoding?: null): Promise<Buffer>;
  async readFile(_path: string, encoding: "utf8" | null = null): Promise<string | Buffer> {
    return encoding === "utf8" ? "content" : Buffer.from("content");
  }
  readonly writeFile = vi.fn(async () => {});
  readonly mkdir = vi.fn(async () => {});
}

class FakeSprite implements SpriteSdkPort {
  readonly id = "sprite-id";
  status = "running";
  labels: string[] = [];
  readonly filesystemPort = new FakeFilesystem();
  readonly filesystem = vi.fn(() => this.filesystemPort);
  readonly execFileHTTP = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  readonly closeControlConnection = vi.fn();
  readonly check = vi.fn(async () => ({ status: this.status }));
  readonly delete = vi.fn(async () => {});
  readonly updateNetworkPolicy = vi.fn(async () => {});
  readonly spawn = vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return {
      stdin,
      stdout,
      stderr,
      once(event: "spawn" | "error", listener: (...args: unknown[]) => void) {
        if (event === "spawn") queueMicrotask(() => {
          stdout.end("worker output");
          stderr.end();
          listener();
        });
        return this;
      },
      wait: vi.fn(async () => 0),
      kill: vi.fn(),
      close: vi.fn(),
    };
  });

  constructor(readonly name: string) {}
}

function client(sprite: FakeSprite): SpritesClientPort {
  return {
    getSprite: vi.fn(async () => sprite),
    createSprite: vi.fn(async () => sprite),
    deleteSprite: vi.fn(async () => {}),
  };
}

describe("Sprites managed runtime provider", () => {
  it("scopes registered repository credentials to matching Sprite commands", async () => {
    const sprite = new FakeSprite("oma-owned");
    const runtime = new (await import("../src/sprites")).SpritesRuntime({
      client: client(sprite),
      sprite,
    });

    await runtime.setEnvVars({ OMA_MEMORY_DIR: "/mnt/memory" });
    runtime.registerCommandSecrets("git", { GIT_AUTH_HEADER: "secret" });

    await runtime.exec("git clone -- https://example.test/repo.git repository");
    await runtime.exec("github-helper status");

    expect(sprite.execFileHTTP).toHaveBeenNthCalledWith(
      1,
      "/bin/sh",
      ["-lc", "git clone -- https://example.test/repo.git repository"],
      {
        cwd: "/workspace",
        env: {
          OMA_MEMORY_DIR: "/mnt/memory",
          GIT_AUTH_HEADER: "secret",
        },
        timeout: 120_000,
      },
    );
    expect(sprite.execFileHTTP).toHaveBeenNthCalledWith(
      2,
      "/bin/sh",
      ["-lc", "github-helper status"],
      {
        cwd: "/workspace",
        env: { OMA_MEMORY_DIR: "/mnt/memory" },
        timeout: 120_000,
      },
    );
  });

  it("propagates global environment without leaking repository credentials to the harness", async () => {
    const sprite = new FakeSprite("oma-owned");
    const runtime = new (await import("../src/sprites")).SpritesRuntime({
      client: client(sprite),
      sprite,
    });
    await runtime.setEnvVars({ OMA_MEMORY_DIR: "/mnt/memory" });
    runtime.registerCommandSecrets("git", { GIT_AUTH_HEADER: "secret" });

    const process = await runtime.spawnDuplexProcess({
      command: "openma-acp",
      args: ["serve"],
      cwd: "/workspace",
      env: { SESSION_ID: "session_1" },
    });
    await process.exited;

    expect(sprite.spawn).toHaveBeenCalledWith(
      "/usr/bin/flock",
      [
        "--nonblock",
        "/run/openma-managed-agent.lock",
        "openma-acp",
        "serve",
      ],
      {
        cwd: "/workspace",
        env: {
          OMA_MEMORY_DIR: "/mnt/memory",
          SESSION_ID: "session_1",
        },
        tty: false,
        maxRunAfterDisconnect: "1h",
      },
    );
  });

  it("exposes its lifecycle through the standalone Node sandbox factory", async () => {
    const sprite = new FakeSprite("placeholder");
    const sdk = client(sprite);
    (sdk.getSprite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );

    const runtime = await createSpritesSandbox(
      { sessionId: "session_1", workdir: "/workspace" },
      {},
      {
        client: sdk,
        createOptions: async (input) => {
          Object.defineProperty(sprite, "name", { value: input.name });
          sprite.labels = input.ownershipLabels;
          return { config: { ramMB: 1024 } };
        },
      },
    );

    expect(sdk.createSprite).toHaveBeenCalledWith(
      expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      expect.objectContaining({
        config: { ramMB: 1024 },
        labels: expect.arrayContaining(["openma-managed"]),
      }),
    );
    expect(runtime.sessionOutputMountCapabilities()).toEqual({
      durability: "best_effort",
    });
    await runtime.mountSessionOutputs({
      tenantId: "workspace_1",
      sessionId: "session_1",
    });
    expect(sprite.execFileHTTP).toHaveBeenCalledWith(
      "/bin/mkdir",
      ["-p", "/mnt/session/outputs"],
      expect.objectContaining({ cwd: "/", timeout: 60_000 }),
    );
    await runtime.destroy();
    expect(sprite.closeControlConnection).toHaveBeenCalledOnce();
    expect(sdk.deleteSprite).toHaveBeenCalledWith(sprite.name);
  });

  it("uses stable identity, persistent filesystem, auto-pause handoff, and duplex execution", async () => {
    const sprite = new FakeSprite("placeholder");
    const sdk = client(sprite);
    (sdk.getSprite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("not found"), { statusCode: 404 }),
    );
    const runtime = createSpritesManagedRuntime({
      client: sdk,
      leaseTtlMs: 90_000,
      outputStore: null,
      createOptions: async (input) => {
        Object.defineProperty(sprite, "name", { value: input.name });
        sprite.labels = input.ownershipLabels;
        return { config: { ramMB: 2048 }, waitForCapacity: true };
      },
    });
    const signal = new AbortController().signal;
    const workspace = await runtime.workspace.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "materialize-1",
      signal,
    });
    const lease = await runtime.sandbox.acquire({
      scope,
      fence,
      plan: {
        workspaceStrategy: "retained_runtime",
        outputStrategy: null,
        runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      },
      workspace,
      outputs: null,
      signal,
    });

    expect(sdk.createSprite).toHaveBeenCalledWith(
      expect.stringMatching(/^oma-[a-f0-9]{32}$/),
      expect.objectContaining({
        config: { ramMB: 2048 },
        waitForCapacity: true,
        labels: expect.arrayContaining(["openma-managed"]),
      }),
    );
    expect(sprite.execFileHTTP).toHaveBeenCalledWith(
      "/bin/mkdir",
      ["-p", "/workspace"],
      expect.objectContaining({ timeout: 60_000 }),
    );

    await expect(runtime.harness.run({
      scope,
      fence,
      sandbox: lease,
      workspacePath: "/workspace",
      outputPath: null,
      driver: { type: "ama_worker", process: { command: "worker", args: ["--poll"] } },
      signal,
    })).resolves.toEqual({ type: "completed" });
    expect(sprite.spawn).toHaveBeenCalledWith("/usr/bin/flock", [
      "--nonblock",
      "/run/openma-managed-agent.lock",
      "worker",
      "--poll",
    ], expect.objectContaining({
      cwd: "/workspace",
      tty: false,
    }));

    const suspended = await runtime.sandbox.suspend({ scope, fence, lease, signal });
    expect(sprite.execFileHTTP).toHaveBeenCalledWith("/bin/sync", [], expect.any(Object));
    expect(sprite.closeControlConnection).toHaveBeenCalledOnce();
    await runtime.sandbox.reap({ scope, lease: suspended, reason: "completed" });
    expect(sdk.deleteSprite).toHaveBeenCalledWith(sprite.name);
  });

  it("rejects a same-name Sprite without OpenMA ownership labels", async () => {
    const sprite = new FakeSprite("oma-foreign");
    const provider = createSpritesProvider({ client: client(sprite) });
    await expect(provider.resume(
      { provider: "sprites", runtimeId: sprite.name },
      { sessionId: scope.sessionId, workdir: "/workspace" },
      {},
      {
        scope,
        fence,
        plan: {
          workspaceStrategy: "retained_runtime",
          outputStrategy: null,
          runtimeCheckpoint: null,
          driver: { type: "ama_worker", process: { command: "worker" } },
        },
        workspace: { bindingId: "binding", mountPath: "/workspace" },
        outputs: null,
        credentialEgress: null,
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("ownership labels");
  });

  it("advertises provider-retained workspace without inventing process checkpoints", () => {
    const driver = createSpritesManagedRuntimeDriver({
      client: client(new FakeSprite("unused")),
      leaseTtlMs: 90_000,
      outputStore: null,
    });
    expect(driver.descriptor()).toMatchObject({
      provider: "sprites",
      placements: ["in_process"],
      capabilities: {
        sandbox: {
          suspendResume: "supported",
          hardTerminate: "supported",
          runtimeCheckpoints: [],
        },
        workspace: { strategies: ["retained_runtime"] },
        outputs: { strategies: [] },
        harness: { drivers: ["ama_worker", "openma_supervised"] },
      },
    });
  });
});
