import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

import {
  ensureRuntimeResourceFenceSchema,
  SqlRuntimeOrphanPort,
  SqlRuntimeResourceFencePort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_boundaries",
  environmentId: "environment_boundaries",
  sessionId: "session_boundaries",
  workId: "work_boundaries",
};

function scriptedSql(options: {
  first?: unknown[];
  all?: unknown[];
  resultsUndefined?: boolean;
} = {}) {
  const first = [...(options.first ?? [])];
  const all = [...(options.all ?? [])];
  return {
    prepare: vi.fn(() => {
      const statement: any = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => first.shift() ?? null),
        all: vi.fn(async () => options.resultsUndefined
          ? {}
          : { results: (all.shift() as unknown[] | undefined) ?? [] }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => undefined),
  } as any;
}

function fenceRow(overrides: Record<string, unknown> = {}) {
  return {
    generation: 1,
    owner_id: "owner",
    fence_token: "token",
    expires_at_ms: Date.parse("2026-09-08T00:00:00.000Z"),
    publication_json: null,
    publication_generation: null,
    revision: 0,
    ...overrides,
  };
}

describe("SQL runtime fence persisted-state boundaries", () => {
  it("uses production clock/token defaults and accepts safe integer strings from SQL drivers", async () => {
    const sql = scriptedSql({ first: [fenceRow({
      generation: "1",
      expires_at_ms: String(Date.parse("2026-09-08T00:00:00.000Z")),
      revision: "0",
    })] });
    const port = new SqlRuntimeResourceFencePort(sql);
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).resolves.toMatchObject({
      type: "acquired",
      fence: { generation: 1, ownerId: "owner" },
      publication: null,
    });
  });

  it("reports a null expiry when a conflicting row disappears between atomic claim and observation", async () => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql({ first: [null, null] }), {
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      nextToken: () => "token",
    });
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).resolves.toEqual({
      type: "conflict",
      expiresAt: null,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid fence TTL %s", async (ttlMs) => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql());
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs })).rejects.toThrow(/positive integer/i);
    await expect(port.renew({
      fence: {
        ...scope,
        ownerId: "owner",
        generation: 1,
        token: "token",
        expiresAt: "2026-09-08T00:00:00.000Z",
      },
      ttlMs,
    })).rejects.toThrow(/positive integer/i);
  });

  it("rejects unsafe integer values returned by a SQL driver", async () => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql({ first: [
      fenceRow({ generation: "not-an-integer" }),
    ] }), {
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      nextToken: () => "token",
    });
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).rejects.toThrow(
      /invalid generation/i,
    );
  });

  it("fails closed when a persisted publication has no generation", async () => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql({ first: [fenceRow({
      publication_json: JSON.stringify({
        workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
        outputCandidate: null,
      }),
      publication_generation: null,
    })] }), {
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      nextToken: () => "token",
    });
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).rejects.toThrow(
      /publication is missing its generation/i,
    );
  });

  it.each([
    [{ workspaceCandidate: {}, outputCandidate: null }, /invalid publication/i],
    [{
      workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
      outputCandidate: null,
      runtimeCheckpoint: "invalid",
    }, /invalid publication/i],
  ])("fails closed on malformed persisted publication candidates", async (publication, expected) => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql({ first: [fenceRow({
      publication_json: JSON.stringify(publication),
      publication_generation: 1,
    })] }), {
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      nextToken: () => "token",
    });
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).rejects.toThrow(expected);
  });

  it("accepts an explicitly null optional runtime checkpoint", async () => {
    const port = new SqlRuntimeResourceFencePort(scriptedSql({ first: [fenceRow({
      publication_json: JSON.stringify({
        workspaceCandidate: { id: "workspace", contentHash: "sha256:workspace" },
        outputCandidate: null,
        runtimeCheckpoint: null,
      }),
      publication_generation: 1,
    })] }), {
      now: () => new Date("2026-09-07T00:00:00.000Z"),
      nextToken: () => "token",
    });
    await expect(port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 })).resolves.toMatchObject({
      type: "acquired",
      publication: { runtimeCheckpoint: null },
    });
  });

  it("canonicalizes nested arrays and omits an absent runtime checkpoint", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureRuntimeResourceFenceSchema(sql);
    let now = Date.parse("2026-09-07T00:00:00.000Z");
    const port = new SqlRuntimeResourceFencePort(sql, {
      now: () => new Date(now),
      nextToken: () => "token",
    });
    const acquired = await port.acquire({ scope, ownerId: "owner", ttlMs: 1_000 });
    if (acquired.type !== "acquired") throw new Error("expected acquisition");
    await port.publish({
      fence: acquired.fence,
      workspaceCandidate: {
        id: "workspace",
        contentHash: "sha256:workspace",
        metadata: { nested: [{ z: 1, a: 2 }] } as any,
      },
      outputCandidate: null,
    });
    await port.release({ fence: acquired.fence, reason: "completed" });
    now += 1;
    const restored = await port.acquire({ scope, ownerId: "next", ttlMs: 1_000 });
    expect(restored).toMatchObject({
      type: "acquired",
      publication: {
        workspaceCandidate: { metadata: { nested: [{ a: 2, z: 1 }] } },
      },
    });
    if (restored.type === "acquired") {
      expect("runtimeCheckpoint" in (restored.publication ?? {})).toBe(false);
    }
  });
});

describe("SQL runtime orphan persisted-state boundaries", () => {
  const validRow = {
    id: "orphan",
    workspace_id: scope.workspaceId,
    environment_id: scope.environmentId,
    session_id: scope.sessionId,
    work_id: scope.workId,
    generation: "1",
    owner_id: "owner",
    sandbox_json: JSON.stringify({ provider: "docker", runtimeId: "runtime" }),
    reason: "failed",
    attempts: "0",
    last_error: "failed",
  };

  it("supports SQL drivers that omit an empty results array", async () => {
    const port = new SqlRuntimeOrphanPort(scriptedSql({ resultsUndefined: true }));
    await expect(port.list({ limit: 10 })).resolves.toEqual([]);
  });

  it.each([
    [{ ...validRow, sandbox_json: JSON.stringify({ provider: "", runtimeId: "runtime" }) }, /invalid sandbox lease/i],
    [{ ...validRow, sandbox_json: JSON.stringify({ provider: "docker", runtimeId: "" }) }, /invalid sandbox lease/i],
    [{ ...validRow, sandbox_json: JSON.stringify(null) }, /invalid sandbox lease/i],
    [{ ...validRow, reason: "unknown" }, /invalid cleanup reason/i],
  ])("fails closed on corrupt persisted orphan rows", async (row, expected) => {
    const port = new SqlRuntimeOrphanPort(scriptedSql({ all: [[row]] }));
    await expect(port.list({ limit: 10 })).rejects.toThrow(expected);
  });

  it("normalizes non-Error cleanup diagnostics", async () => {
    const sql = scriptedSql();
    const port = new SqlRuntimeOrphanPort(sql);
    await port.enqueue({
      scope,
      generation: 1,
      ownerId: "owner",
      sandbox: { provider: "docker", runtimeId: "runtime" },
      reason: "failed",
      error: { code: "ECONNRESET" },
    });
    const statement = sql.prepare.mock.results[0]!.value;
    expect(statement.bind).toHaveBeenCalledWith(
      expect.any(String),
      scope.workspaceId,
      scope.environmentId,
      scope.sessionId,
      scope.workId,
      1,
      "owner",
      expect.any(String),
      "failed",
      "[object Object]",
    );
  });
});
