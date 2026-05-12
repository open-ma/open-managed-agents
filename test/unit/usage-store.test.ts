// Unit tests for SqlUsageStore — the OSS half of the hybrid resource-
// billing pipeline. Verifies recordUsage / listUnbilled / ack semantics
// against a real D1 (migrations auto-applied from
// wrangler.test.jsonc's migrations_dir).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
// Importing the test worker triggers its migrations bootstrap on first
// fetch — we trigger it explicitly in beforeAll so this unit-style test
// doesn't have to drive an HTTP route just to get the schema applied.
import worker from "../test-worker";
import {
  SqlUsageStore,
  createCfUsageStore,
  clampUsageValue,
  MAX_VALUE_PER_EMIT_SEC,
} from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

const TENANT_A = "t_a";
const TENANT_B = "t_b";

function db(): D1Database {
  return (env as { AUTH_DB: D1Database }).AUTH_DB;
}

beforeAll(async () => {
  // Health-check fetch drives the lazy migration bootstrap in test-worker.ts.
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

beforeEach(async () => {
  await db().exec(`DELETE FROM usage_events`);
});

describe("SqlUsageStore — recordUsage", () => {
  it("writes a row with the supplied (tenant, session, kind, value)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      agentId: "agent_x",
      kind: "sandbox_active_seconds",
      value: 60,
    });
    const r = await db()
      .prepare(`SELECT tenant_id, session_id, agent_id, kind, value, billed_at FROM usage_events WHERE tenant_id = ?`)
      .bind(TENANT_A)
      .all<{ tenant_id: string; session_id: string; agent_id: string; kind: string; value: number; billed_at: number | null }>();
    expect(r.results).toHaveLength(1);
    expect(r.results![0]).toMatchObject({
      tenant_id: TENANT_A,
      session_id: "sess1",
      agent_id: "agent_x",
      kind: "sandbox_active_seconds",
      value: 60,
      billed_at: null,
    });
  });

  it("clamps value at MAX_VALUE_PER_EMIT_SEC (24h)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "session_alive_seconds",
      value: MAX_VALUE_PER_EMIT_SEC * 10, // 240h
    });
    const r = await db()
      .prepare(`SELECT value FROM usage_events WHERE tenant_id = ?`)
      .bind(TENANT_A)
      .first<{ value: number }>();
    expect(r?.value).toBe(MAX_VALUE_PER_EMIT_SEC);
  });

  it("skips the insert when value clamps to 0", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: 0,
    });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: -5,
    });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: Number.NaN,
    });
    const r = await db()
      .prepare(`SELECT COUNT(*) AS c FROM usage_events`)
      .first<{ c: number }>();
    expect(r?.c).toBe(0);
  });
});

describe("SqlUsageStore — listUnbilled + ack", () => {
  it("listUnbilled returns ordered ASC by id, only unbilled, only for tenantId", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    // Three events for A, one for B
    for (let i = 0; i < 3; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `sess_a_${i}`,
        kind: "sandbox_active_seconds",
        value: 10 + i,
      });
    }
    await store.recordUsage({
      tenantId: TENANT_B,
      sessionId: "sess_b",
      kind: "session_alive_seconds",
      value: 100,
    });

    const rowsA = await store.listUnbilled(TENANT_A, 0, 500);
    expect(rowsA).toHaveLength(3);
    expect(rowsA.map((r) => r.value)).toEqual([10, 11, 12]);
    expect(rowsA.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    // Ascending id
    expect(rowsA[0].id).toBeLessThan(rowsA[1].id);

    const rowsB = await store.listUnbilled(TENANT_B, 0, 500);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].tenant_id).toBe(TENANT_B);
  });

  it("ack marks billed_at and excludes from subsequent listUnbilled", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    for (let i = 0; i < 3; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `s${i}`,
        kind: "sandbox_active_seconds",
        value: 10,
      });
    }
    const before = await store.listUnbilled(TENANT_A, 0, 500);
    expect(before).toHaveLength(3);
    const idsToAck = [before[0].id, before[1].id];
    await store.ack(idsToAck);

    const after = await store.listUnbilled(TENANT_A, 0, 500);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[2].id);
  });

  it("second ack of same ids is a no-op (doesn't bump billed_at)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "s1",
      kind: "sandbox_active_seconds",
      value: 10,
    });
    const [row] = await store.listUnbilled(TENANT_A, 0, 500);
    await store.ack([row.id]);
    const firstBilledAt = await db()
      .prepare(`SELECT billed_at FROM usage_events WHERE id = ?`)
      .bind(row.id)
      .first<{ billed_at: number | null }>();
    expect(firstBilledAt?.billed_at).toBeGreaterThan(0);

    // small delay so a hypothetical re-ack would set a later timestamp
    await new Promise((res) => setTimeout(res, 5));
    await store.ack([row.id]);
    const secondBilledAt = await db()
      .prepare(`SELECT billed_at FROM usage_events WHERE id = ?`)
      .bind(row.id)
      .first<{ billed_at: number | null }>();
    expect(secondBilledAt?.billed_at).toBe(firstBilledAt?.billed_at);
  });

  it("listUnbilled honours the since cursor", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    for (let i = 0; i < 5; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `s${i}`,
        kind: "sandbox_active_seconds",
        value: 10,
      });
    }
    const all = await store.listUnbilled(TENANT_A, 0, 500);
    const cursor = all[1].id;
    const after = await store.listUnbilled(TENANT_A, cursor, 500);
    expect(after.every((r) => r.id > cursor)).toBe(true);
    expect(after).toHaveLength(3);
  });

  it("listUnbilledTenants returns each tenant once", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({ tenantId: TENANT_A, sessionId: "x", kind: "sandbox_active_seconds", value: 10 });
    await store.recordUsage({ tenantId: TENANT_A, sessionId: "y", kind: "session_alive_seconds", value: 10 });
    await store.recordUsage({ tenantId: TENANT_B, sessionId: "z", kind: "browser_active_seconds", value: 10 });
    const tenants = await store.listUnbilledTenants();
    const ids = tenants.map((t) => t.tenant_id).sort();
    expect(ids).toEqual([TENANT_A, TENANT_B]);
  });
});

describe("createCfUsageStore + clampUsageValue helpers", () => {
  it("createCfUsageStore wires the same SqlUsageStore over CfD1SqlClient", async () => {
    const store = createCfUsageStore({ db: db() });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "fac1",
      kind: "session_alive_seconds",
      value: 42,
    });
    const rows = await store.listUnbilled(TENANT_A, 0, 500);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(42);
  });

  it("clampUsageValue floors fractionals + clamps overage + zeroes garbage", () => {
    expect(clampUsageValue(60.7)).toBe(60);
    expect(clampUsageValue(MAX_VALUE_PER_EMIT_SEC + 1)).toBe(MAX_VALUE_PER_EMIT_SEC);
    expect(clampUsageValue(-1)).toBe(0);
    expect(clampUsageValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampUsageValue(Number.NaN)).toBe(0);
  });
});
