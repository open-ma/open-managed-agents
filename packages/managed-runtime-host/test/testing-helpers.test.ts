import { describe, expect, it } from "vitest";

import {
  MemoryRuntimeOrphanPort,
  MemoryRuntimeResourceFencePort,
} from "../src/testing";

const scope = {
  workspaceId: "workspace_testing",
  environmentId: "environment_testing",
  sessionId: "session_testing",
  workId: "work_testing",
};

describe("managed runtime deterministic test Ports", () => {
  it("uses its production-like clock/token defaults and exposes unknown scopes", async () => {
    const fences = new MemoryRuntimeResourceFencePort();
    const acquired = await fences.acquire({ scope, ownerId: "owner", ttlMs: 1_000 });
    expect(acquired.type).toBe("acquired");
    if (acquired.type !== "acquired") return;

    expect(acquired.fence.token).toMatch(/^1:/u);
    expect(fences.inspect(scope)).toMatchObject({ generation: 1 });
    expect(fences.inspect({ ...scope, workId: "missing" })).toBeNull();
    await expect(fences.publish({
      fence: acquired.fence,
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
      outputCandidate: null,
    })).resolves.toEqual({ type: "published", revision: 1 });
    await expect(fences.publish({
      fence: acquired.fence,
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
      outputCandidate: null,
      runtimeCheckpoint: {
        provider: "fake",
        checkpointId: "checkpoint",
        kind: "filesystem",
        sourceRuntimeId: "runtime",
        sessionId: scope.sessionId,
        workGeneration: 1,
        workspaceRevision: 1,
        harnessVersion: "1",
        runtimeIdentity: "runtime-identity",
      },
    })).resolves.toEqual({ type: "published", revision: 2 });
  });

  it("handles metadata-free orphans, string failures, stable sorting, and missing updates", async () => {
    const orphans = new MemoryRuntimeOrphanPort();
    await orphans.enqueue({
      scope: { ...scope, workId: "z" },
      generation: 1,
      ownerId: "owner",
      sandbox: { provider: "fake", runtimeId: "runtime-z" },
      reason: "failed",
      error: "string failure",
    });
    await orphans.enqueue({
      scope: { ...scope, workId: "a" },
      generation: 1,
      ownerId: "owner",
      sandbox: {
        provider: "fake",
        runtimeId: "runtime-a",
        metadata: { region: "test" },
      },
      reason: "failed",
      error: new Error("error failure"),
    });

    const listed = await orphans.list({ limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed.map((record) => record.id)).toEqual(
      [...listed.map((record) => record.id)].sort(),
    );
    expect(listed.map((record) => record.lastError)).toEqual(
      expect.arrayContaining(["string failure", "error failure"]),
    );
    await expect(orphans.failed({ id: "missing", error: "ignored" }))
      .resolves.toBeUndefined();
  });
});
