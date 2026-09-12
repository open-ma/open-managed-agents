import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";

import { getStorageIntegrationConfig } from "../../../test/storage-integration";
import {
  ensureRuntimeResourceFenceSchema,
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "../src/index";

const url = getStorageIntegrationConfig().postgres.runtimeFence;
let connection: ReturnType<typeof postgres>;
let fences: SqlRuntimeResourceFencePort;

beforeAll(async () => {
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing runtime fence test against non-loopback PostgreSQL");
  }
  connection = postgres(url, {
    max: 2,
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number) => value.toString(),
        parse: (value: string) => Number(value),
      },
    },
  });
  const sql = new PostgresSqlClient(
    connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
  );
  await ensureRuntimeResourceFenceSchema(sql);
  await sql.prepare("DELETE FROM runtime_resource_fences").run();
  await sql.prepare("DELETE FROM runtime_resource_orphans").run();
  fences = new SqlRuntimeResourceFencePort(sql, {
    now: () => new Date("2026-09-03T00:00:00.000Z"),
    nextToken: (generation) => `pg-token-${generation}`,
  });
});

afterAll(async () => connection.end({ timeout: 5 }));

describe("SqlRuntimeResourceFencePort on PostgreSQL", () => {
  it("uses the same atomic acquire and publish semantics", async () => {
    const scope = {
      workspaceId: "pg-workspace",
      environmentId: "pg-environment",
      sessionId: "pg-session",
      workId: "pg-work",
    };
    const acquired = await fences.acquire({ scope, ownerId: "pg-owner", ttlMs: 90_000 });
    if (acquired.type !== "acquired") throw new Error("expected acquired fence");
    await expect(
      fences.publish({
        fence: acquired.fence,
        workspaceCandidate: {
          id: "pg-workspace-candidate",
          contentHash: "sha256:pg-workspace",
          metadata: { provider: "postgres-test" },
        },
        outputCandidate: null,
      }),
    ).resolves.toEqual({ type: "published", revision: 1 });
    await fences.release({ fence: acquired.fence, reason: "completed" });
    const next = await fences.acquire({ scope, ownerId: "pg-next", ttlMs: 90_000 });
    expect(next).toMatchObject({
      type: "acquired",
      publication: {
        revision: 1,
        workspaceCandidate: { metadata: { provider: "postgres-test" } },
      },
    });
  });

  it("round-trips the provider-neutral orphan retry queue", async () => {
    const sql = new PostgresSqlClient(
      connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
    );
    const orphans = new SqlRuntimeOrphanPort(sql);
    const scope = {
      workspaceId: "pg-orphan-workspace",
      environmentId: "pg-orphan-environment",
      sessionId: "pg-orphan-session",
      workId: "pg-orphan-work",
    };
    await orphans.enqueue({
      scope,
      generation: 7,
      ownerId: "pg-orphan-owner",
      sandbox: { provider: "docker", runtimeId: "pg-orphan-runtime" },
      reason: "lease_lost",
      error: new Error("partition"),
    });
    const [record] = await orphans.list({ limit: 10 });
    expect(record).toMatchObject({ scope, generation: 7, attempts: 0 });
    await orphans.resolve({ id: record!.id });
    await expect(orphans.list({ limit: 10 })).resolves.toEqual([]);
  });
});
