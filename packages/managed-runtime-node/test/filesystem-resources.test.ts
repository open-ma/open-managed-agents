import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as nodeRuntimeModule from "../src/index";

const roots: string[] = [];
const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function exportedConstructor(name: string): new (options: any) => any {
  const candidate = (nodeRuntimeModule as Record<string, unknown>)[name];
  expect(candidate, `${name} must be exported`).toBeTypeOf("function");
  return candidate as new (options: any) => any;
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "oma-runtime-node-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("NodeFilesystemWorkspacePort", () => {
  it("restores only an immutable candidate that the control plane published", async () => {
    const Constructor = exportedConstructor("NodeFilesystemWorkspacePort");
    const port = new Constructor({ rootDir: await root() });
    const firstFence = {
      ...scope,
      ownerId: "worker_1",
      generation: 1,
      token: "fence_1",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const first = await port.materialize({
      scope,
      fence: firstFence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "materialize-1",
      signal: new AbortController().signal,
    });
    await writeFile(join(first.metadata.hostPath, "state.txt"), "generation one");
    const candidate = await port.checkpoint({
      scope,
      fence: firstFence,
      strategy: "checkpoint_restore",
      binding: first,
      idempotencyKey: "checkpoint-1",
      signal: new AbortController().signal,
    });
    await port.release({ scope, fence: firstFence, binding: first });

    const secondFence = { ...firstFence, ownerId: "worker_2", generation: 2, token: "fence_2" };
    const second = await port.materialize({
      scope,
      fence: secondFence,
      strategy: "checkpoint_restore",
      activeCheckpoint: candidate,
      idempotencyKey: "materialize-2",
      signal: new AbortController().signal,
    });
    await expect(readFile(join(second.metadata.hostPath, "state.txt"), "utf8")).resolves.toBe(
      "generation one",
    );
    expect(candidate.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects a corrupted immutable checkpoint instead of restoring partial state", async () => {
    const Constructor = exportedConstructor("NodeFilesystemWorkspacePort");
    const rootDir = await root();
    const port = new Constructor({ rootDir });
    const fence = {
      ...scope,
      ownerId: "worker_corrupt",
      generation: 1,
      token: "fence_corrupt",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const binding = await port.materialize({
      scope,
      fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: null,
      idempotencyKey: "materialize-corrupt",
      signal: new AbortController().signal,
    });
    await writeFile(join(binding.metadata.hostPath, "state.txt"), "verified");
    const candidate = await port.checkpoint({
      scope,
      fence,
      strategy: "checkpoint_restore",
      binding,
      idempotencyKey: "checkpoint-corrupt",
      signal: new AbortController().signal,
    });
    const scopeHash = createHash("sha256")
      .update([scope.workspaceId, scope.environmentId, scope.sessionId, scope.workId].join("\0"))
      .digest("hex");
    await writeFile(
      join(
        rootDir,
        "workspaces",
        scopeHash,
        "candidates",
        candidate.id,
        "content",
        "state.txt",
      ),
      "tampered",
    );

    await expect(
      port.materialize({
        scope,
        fence: { ...fence, generation: 2, token: "fence_next" },
        strategy: "checkpoint_restore",
        activeCheckpoint: candidate,
        idempotencyKey: "materialize-after-corruption",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/content hash mismatch/i);
  });
});

describe("NodeFilesystemSessionOutputPort", () => {
  it("deduplicates content and emits an immutable stable manifest", async () => {
    const Constructor = exportedConstructor("NodeFilesystemSessionOutputPort");
    const port = new Constructor({ rootDir: await root() });
    const fence = {
      ...scope,
      ownerId: "worker_1",
      generation: 1,
      token: "fence_1",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const binding = await port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "prepare-1",
      signal: new AbortController().signal,
    });
    await writeFile(join(binding.metadata.hostPath, "report.md"), "hello output");
    const entries = await port.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      signal: new AbortController().signal,
    });
    const first = await port.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      entries,
      idempotencyKey: "finalize-1",
      signal: new AbortController().signal,
    });
    const retried = await port.finalize({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      entries,
      idempotencyKey: "finalize-1",
      signal: new AbortController().signal,
    });

    expect(entries).toEqual([
      expect.objectContaining({
        logicalPath: "report.md",
        size: 12,
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]);
    expect(retried).toEqual(first);
    expect(first).toMatchObject({ entries: 1 });
    await port.release({ scope, fence, binding });
    await expect(stat(binding.metadata.bindingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to finalize a file that changed after collection", async () => {
    const Constructor = exportedConstructor("NodeFilesystemSessionOutputPort");
    const port = new Constructor({ rootDir: await root() });
    const fence = {
      ...scope,
      ownerId: "worker_mutation",
      generation: 2,
      token: "fence_mutation",
      expiresAt: "2026-09-03T12:00:00.000Z",
    };
    const binding = await port.prepare({
      scope,
      fence,
      strategy: "final_collect",
      idempotencyKey: "prepare-mutation",
      signal: new AbortController().signal,
    });
    const report = join(binding.metadata.hostPath, "report.md");
    await writeFile(report, "before");
    const entries = await port.collect({
      scope,
      fence,
      strategy: "final_collect",
      binding,
      signal: new AbortController().signal,
    });
    await writeFile(report, "after");

    await expect(
      port.finalize({
        scope,
        fence,
        strategy: "final_collect",
        binding,
        entries,
        idempotencyKey: "finalize-mutation",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/changed during collection/i);
    await expect(port.abort({ scope, fence, binding, reason: "failed" })).resolves.toBeUndefined();
    await expect(port.abort({ scope, fence, binding, reason: "failed" })).resolves.toBeUndefined();
  });
});
