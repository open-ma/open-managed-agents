import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

import {
  ensureRuntimeResourceFenceSchema,
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

describe("SqlRuntimeResourceFencePort", () => {
  it("atomically fences stale owners and preserves opaque publication metadata", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeResourceFenceSchema(sql);
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    let token = 0;
    const fences = new SqlRuntimeResourceFencePort(sql, {
      now: () => new Date(clock.now),
      nextToken: () => `token_${++token}`,
    });

    const first = await fences.acquire({ scope, ownerId: "owner_old", ttlMs: 90_000 });
    expect(first.type).toBe("acquired");
    if (first.type !== "acquired") throw new Error("expected first fence");
    await expect(
      fences.acquire({ scope, ownerId: "owner_new", ttlMs: 90_000 }),
    ).resolves.toMatchObject({ type: "conflict" });

    clock.now += 90_001;
    const second = await fences.acquire({ scope, ownerId: "owner_new", ttlMs: 90_000 });
    expect(second).toMatchObject({
      type: "acquired",
      fence: { generation: 2, ownerId: "owner_new" },
    });
    if (second.type !== "acquired") throw new Error("expected second fence");
    await expect(
      fences.publish({
        fence: first.fence,
        workspaceCandidate: { id: "stale", contentHash: "sha256:stale" },
        outputCandidate: null,
      }),
    ).resolves.toEqual({ type: "lost" });

    const publication = {
      fence: second.fence,
      workspaceCandidate: {
        id: "workspace-2",
        contentHash: "sha256:workspace-2",
        metadata: { checkpoint: "opaque-provider-handle" },
      },
      outputCandidate: {
        id: "outputs-2",
        contentHash: "sha256:outputs-2",
        metadata: { manifest: "opaque-output-handle" },
      },
      runtimeCheckpoint: {
        provider: "fake",
        checkpointId: "proc-2",
        kind: "process" as const,
        sourceRuntimeId: "runtime-2",
        sessionId: scope.sessionId,
        workGeneration: 2,
        workspaceRevision: 1,
        harnessVersion: "ama-worker-v1",
        runtimeIdentity: "fake-runtime",
      },
    };
    await expect(fences.publish(publication)).resolves.toEqual({
      type: "published",
      revision: 1,
    });
    await expect(fences.publish(publication)).resolves.toEqual({
      type: "published",
      revision: 1,
    });
    await fences.release({ fence: second.fence, reason: "completed" });

    const third = await fences.acquire({ scope, ownerId: "owner_next", ttlMs: 90_000 });
    expect(third).toMatchObject({
      type: "acquired",
      fence: { generation: 3 },
      publication: {
        generation: 2,
        revision: 1,
        workspaceCandidate: {
          metadata: { checkpoint: "opaque-provider-handle" },
        },
        outputCandidate: {
          metadata: { manifest: "opaque-output-handle" },
        },
        runtimeCheckpoint: {
          checkpointId: "proc-2",
          kind: "process",
          sourceRuntimeId: "runtime-2",
        },
      },
    });
  });

  it("renews and releases only the current generation/token", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeResourceFenceSchema(sql);
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const fences = new SqlRuntimeResourceFencePort(sql, {
      now: () => new Date(clock.now),
      nextToken: (generation) => `token_${generation}`,
    });
    const acquired = await fences.acquire({ scope, ownerId: "owner_1", ttlMs: 10_000 });
    if (acquired.type !== "acquired") throw new Error("expected acquired fence");
    clock.now += 5_000;
    const renewed = await fences.renew({ fence: acquired.fence, ttlMs: 20_000 });
    expect(renewed).toMatchObject({ type: "renewed" });
    if (renewed.type !== "renewed") throw new Error("expected renewed fence");
    await fences.release({ fence: acquired.fence, reason: "failed" });
    await expect(
      fences.renew({ fence: renewed.fence, ttlMs: 20_000 }),
    ).resolves.toEqual({ type: "lost" });
  });

  it("authorizes credential egress only for the live exact fence", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeResourceFenceSchema(sql);
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const fences = new SqlRuntimeResourceFencePort(sql, {
      now: () => new Date(clock.now),
      nextToken: () => "fence-token",
    });
    const acquired = await fences.acquire({ scope, ownerId: "owner_1", ttlMs: 10_000 });
    if (acquired.type !== "acquired") throw new Error("expected acquired fence");

    await expect(fences.isCurrent(acquired.fence)).resolves.toBe(true);
    await expect(fences.isCurrent({
      ...acquired.fence,
      token: "forged-token",
    })).resolves.toBe(false);
    await expect(fences.isCurrent({
      ...acquired.fence,
      generation: acquired.fence.generation + 1,
    })).resolves.toBe(false);

    clock.now += 10_001;
    await expect(fences.isCurrent(acquired.fence)).resolves.toBe(false);
  });

  it("persists idempotent orphan cleanup work without fencing credentials", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeResourceFenceSchema(sql);
    const orphans = new SqlRuntimeOrphanPort(sql);
    const input = {
      scope,
      generation: 4,
      ownerId: "owner_orphan",
      sandbox: {
        provider: "docker",
        runtimeId: "container_orphan",
        metadata: { region: "local" },
      },
      reason: "lease_lost" as const,
      error: new Error("docker unavailable"),
    };

    await orphans.enqueue(input);
    await orphans.enqueue(input);
    await expect(orphans.list({ limit: 0 })).rejects.toThrow(
      "Runtime orphan list limit must be a positive integer",
    );
    const pending = await orphans.list({ limit: 10 });
    expect(pending).toEqual([
      expect.objectContaining({
        scope,
        generation: 4,
        ownerId: "owner_orphan",
        sandbox: input.sandbox,
        reason: "lease_lost",
        attempts: 0,
        lastError: "docker unavailable",
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain("token");

    await orphans.failed({ id: pending[0]!.id, error: new Error("still unavailable") });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ attempts: 1, lastError: "still unavailable" }),
    ]);
    await orphans.resolve({ id: pending[0]!.id });
    await orphans.resolve({ id: pending[0]!.id });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });
});
