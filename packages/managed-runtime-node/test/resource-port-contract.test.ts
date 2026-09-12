import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFilesystemSessionOutputPort } from "../src/outputs";
import {
  NodeFilesystemWorkspacePort,
  rethrowUnlessCheckpointPublicationConflict,
} from "../src/workspace";

const roots: string[] = [];
const scope = {
  workspaceId: "workspace_contract",
  environmentId: "environment_contract",
  sessionId: "session_contract",
  workId: "work_contract",
};
const fence = {
  ...scope,
  ownerId: "worker_contract",
  generation: 7,
  token: "fence_contract",
  expiresAt: "2026-09-07T12:00:00.000Z",
};
const sandbox = { provider: "docker", runtimeId: "runtime_contract" } as const;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oma-node-resources-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NodeFilesystemWorkspacePort contract", () => {
  it("normalizes both platform conflict codes without hiding storage faults", () => {
    expect(() => rethrowUnlessCheckpointPublicationConflict({ code: "EEXIST" })).not.toThrow();
    expect(() => rethrowUnlessCheckpointPublicationConflict({ code: "ENOTEMPTY" })).not.toThrow();
    const error = Object.assign(new Error("storage failed"), { code: "EIO" });
    expect(() => rethrowUnlessCheckpointPublicationConflict(error)).toThrow(error);
  });

  it("declares checkpoint/restore and uses no provider-side attach RPC", async () => {
    const port = new NodeFilesystemWorkspacePort({ rootDir: await temporaryRoot() });
    await expect(port.capabilities()).resolves.toEqual({ strategies: ["checkpoint_restore"] });
    await expect(port.attach({} as never)).resolves.toBeUndefined();
  });

  it("fails closed for unsupported strategies and malformed published checkpoint ids", async () => {
    const port = new NodeFilesystemWorkspacePort({ rootDir: await temporaryRoot() });
    const signal = new AbortController().signal;
    await expect(port.materialize({
      scope,
      fence,
      strategy: "retained_runtime",
      activeCheckpoint: null,
      idempotencyKey: "unsupported-materialize",
      signal,
    } as never)).rejects.toThrow(/does not support retained_runtime/i);

    await expect(port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: { id: "../../escape", contentHash: "sha256:nope" } as any,
      idempotencyKey: "invalid-checkpoint",
      signal,
    })).rejects.toThrow(/invalid workspace checkpoint id/i);

    const binding = await port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "valid-binding",
      signal,
    });
    await expect(port.checkpoint({
      scope,
      fence,
      sandbox,
      strategy: "retained_runtime",
      binding,
      idempotencyKey: "unsupported-checkpoint",
      signal,
    } as never)).rejects.toThrow(/does not support retained_runtime/i);
  });

  it("honors cancellation before allocating or checkpointing filesystem state", async () => {
    const port = new NodeFilesystemWorkspacePort({ rootDir: await temporaryRoot() });
    const controller = new AbortController();
    const reason = new Error("cancel workspace");
    controller.abort(reason);
    await expect(port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "cancel-materialize",
      signal: controller.signal,
    })).rejects.toBe(reason);
    await expect(port.checkpoint({
      scope,
      fence,
      sandbox,
      strategy: "checkpoint_restore",
      binding: { bindingId: "none", mountPath: "/workspace", metadata: {} },
      idempotencyKey: "cancel-checkpoint",
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  it("publishes one immutable checkpoint under concurrent retry", async () => {
    const port = new NodeFilesystemWorkspacePort({ rootDir: await temporaryRoot() });
    const signal = new AbortController().signal;
    const binding = await port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "concurrent-materialize",
      signal,
    });
    await mkdir(join(binding.metadata.hostPath as string, "nested"));
    await writeFile(join(binding.metadata.hostPath as string, "nested", "state.json"), "state");

    const candidates = await Promise.all([
      port.checkpoint({
        scope,
        fence,
        sandbox,
        strategy: "checkpoint_restore",
        binding,
        idempotencyKey: "checkpoint-a",
        signal,
      }),
      port.checkpoint({
        scope,
        fence,
        sandbox,
        strategy: "checkpoint_restore",
        binding,
        idempotencyKey: "checkpoint-b",
        signal,
      }),
    ]);
    expect(candidates[1]).toEqual(candidates[0]);

    const retried = await port.checkpoint({
      scope,
      fence,
      sandbox,
      strategy: "checkpoint_restore",
      binding,
      idempotencyKey: "checkpoint-c",
      signal,
    });
    expect(retried).toEqual(candidates[0]);
  });

  it("propagates a corrupt manifest read instead of treating it as a missing candidate", async () => {
    const rootDir = await temporaryRoot();
    const port = new NodeFilesystemWorkspacePort({ rootDir });
    const signal = new AbortController().signal;
    const binding = await port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "manifest-materialize",
      signal,
    });
    await writeFile(join(binding.metadata.hostPath as string, "state"), "value");
    const candidate = await port.checkpoint({
      scope,
      fence,
      sandbox,
      strategy: "checkpoint_restore",
      binding,
      idempotencyKey: "manifest-checkpoint",
      signal,
    });
    const scopeHash = (binding.metadata.bindingRoot as string).split("/").at(-3)!;
    const manifest = join(
      rootDir,
      "workspaces",
      scopeHash,
      "candidates",
      candidate.id,
      "manifest.json",
    );
    await rm(manifest);
    await mkdir(manifest);
    await expect(port.checkpoint({
      scope,
      fence,
      sandbox,
      strategy: "checkpoint_restore",
      binding,
      idempotencyKey: "manifest-checkpoint-retry",
      signal,
    })).rejects.toBeDefined();
  });

  it("validates release metadata and removes the runtime binding", async () => {
    const port = new NodeFilesystemWorkspacePort({ rootDir: await temporaryRoot() });
    await expect(port.release({
      scope,
      fence,
      binding: { bindingId: "bad", mountPath: "/workspace", metadata: {} },
    })).rejects.toThrow(/absolute host path/i);
    const binding = await port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "release",
      signal: new AbortController().signal,
    });
    await port.release({ scope, fence, binding });
    await expect(stat(binding.metadata.bindingRoot as string)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("NodeFilesystemSessionOutputPort contract", () => {
  it("declares durable final collection and uses no provider-side attach RPC", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    await expect(port.capabilities()).resolves.toEqual({
      strategies: [{ strategy: "final_collect", durability: "durable" }],
    });
    await expect(port.attach({} as never)).resolves.toBeUndefined();
  });

  it("fails closed for unsupported output strategies", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    await expect(port.prepare({
      scope,
      fence,
      strategy: "duplex_stream",
      idempotencyKey: "unsupported-output",
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/do not support duplex_stream/i);
  });

  it("collects nested outputs and finalizes them in deterministic order", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    const signal = new AbortController().signal;
    const binding = await port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "nested-output",
      signal,
    });
    await mkdir(join(binding.metadata.hostPath as string, "z"));
    await writeFile(join(binding.metadata.hostPath as string, "z", "last.txt"), "last");
    await writeFile(join(binding.metadata.hostPath as string, "a.txt"), "first");
    const entries = await port.collect({ scope, fence, strategy: "final_collect", binding, signal });
    expect(entries.map((entry) => entry.logicalPath)).toEqual(["a.txt", "z/last.txt"]);

    const manifest = await port.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      entries: [...entries].reverse(),
      idempotencyKey: "nested-finalize",
      signal,
    });
    expect(manifest.entries).toBe(2);
  });

  it("rejects symlinks and unsafe collected paths", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    const signal = new AbortController().signal;
    const binding = await port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "unsafe-output",
      signal,
    });
    await writeFile(join(binding.metadata.hostPath as string, "target"), "value");
    await symlink("target", join(binding.metadata.hostPath as string, "link"));
    await expect(port.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      signal,
    })).rejects.toThrow(/regular file/i);

    await expect(port.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      entries: [{ logicalPath: "../escape", contentHash: "sha256:nope", size: 0 }],
      idempotencyKey: "unsafe-finalize",
      signal,
    })).rejects.toThrow(/unsafe output path/i);
  });

  it("honors cancellation and validates binding metadata on every cleanup path", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    const controller = new AbortController();
    const reason = new Error("cancel outputs");
    controller.abort(reason);
    await expect(port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "cancel-output",
      signal: controller.signal,
    })).rejects.toBe(reason);
    const binding = { bindingId: "bad", mountPath: "/mnt/session/outputs" as const, metadata: {} };
    await expect(port.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      signal: new AbortController().signal,
    })).rejects.toThrow(/absolute host path/i);
    await expect(port.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      entries: [],
      idempotencyKey: "bad-finalize",
      signal: new AbortController().signal,
    })).rejects.toThrow(/absolute host path/i);
    await expect(port.abort({ scope, fence, binding, reason: "failed" })).rejects.toThrow(/absolute host path/i);
    await expect(port.release({ scope, fence, binding })).rejects.toThrow(/absolute host path/i);
  });

  it("removes prepared bindings on abort as well as release", async () => {
    const port = new NodeFilesystemSessionOutputPort({ rootDir: await temporaryRoot() });
    const binding = await port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "abort-cleanup",
      signal: new AbortController().signal,
    });
    await port.abort({ scope, fence, binding, reason: "failed" });
    await expect(stat(binding.metadata.bindingRoot as string)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
