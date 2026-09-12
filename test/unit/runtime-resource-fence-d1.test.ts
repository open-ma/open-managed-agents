import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sqlClientFromD1 } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  ensureRuntimeResourceFenceSchema,
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "@open-managed-agents/runtime-resource-fence-sql";

describe("SqlRuntimeResourceFencePort on Cloudflare D1", () => {
  it("allows only one concurrent owner and atomically publishes", async () => {
    const sql = sqlClientFromD1(env.MAIN_DB);
    await ensureRuntimeResourceFenceSchema(sql);
    const unique = crypto.randomUUID();
    const scope = {
      workspaceId: `d1-workspace-${unique}`,
      environmentId: "d1-environment",
      sessionId: "d1-session",
      workId: "d1-work",
    };
    const fences = new SqlRuntimeResourceFencePort(sql, {
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const results = await Promise.all([
      fences.acquire({ scope, ownerId: "owner-a", ttlMs: 90_000 }),
      fences.acquire({ scope, ownerId: "owner-b", ttlMs: 90_000 }),
    ]);
    expect(results.map((result) => result.type).sort()).toEqual([
      "acquired",
      "conflict",
    ]);
    const acquired = results.find((result) => result.type === "acquired");
    if (acquired?.type !== "acquired") throw new Error("expected D1 fence owner");
    await expect(
      fences.publish({
        fence: acquired.fence,
        workspaceCandidate: { id: "d1-workspace", contentHash: "sha256:d1" },
        outputCandidate: null,
      }),
    ).resolves.toEqual({ type: "published", revision: 1 });
  });

  it("persists orphan cleanup work in D1 without the fence token", async () => {
    const sql = sqlClientFromD1(env.MAIN_DB);
    await ensureRuntimeResourceFenceSchema(sql);
    const unique = crypto.randomUUID();
    const scope = {
      workspaceId: `d1-orphan-workspace-${unique}`,
      environmentId: "d1-orphan-environment",
      sessionId: "d1-orphan-session",
      workId: "d1-orphan-work",
    };
    const orphans = new SqlRuntimeOrphanPort(sql);
    await orphans.enqueue({
      scope,
      generation: 3,
      ownerId: "d1-owner",
      sandbox: { provider: "cloudflare", runtimeId: "d1-runtime" },
      reason: "lease_lost",
      error: new Error("unavailable"),
    });
    const pending = await orphans.list({ limit: 100 });
    const record = pending.find((candidate) => candidate.scope.workspaceId === scope.workspaceId);
    expect(record).toMatchObject({ scope, attempts: 0, lastError: "unavailable" });
    expect(JSON.stringify(record)).not.toContain("token");
    await orphans.resolve({ id: record!.id });
  });
});
