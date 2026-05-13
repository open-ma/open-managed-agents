// @ts-nocheck
// Unit tests for the workspace-backups D1 helpers.
//
// findLatestBackup / recordBackup / pruneExpired are exercised against the
// test-worker's miniflare D1 binding. The pure coordinateBackup function
// (no D1) lives in workspace-backups-coordinator.test.ts so it doesn't pay
// the cloudflare-pool startup cost.

import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  DEFAULT_WORKSPACE_BACKUP_TTL_SEC,
  findLatestBackup,
  pruneExpired,
  recordBackup,
  type WorkspaceBackupHandle,
} from "../../apps/agent/src/runtime/workspace-backups";

const TENANT_A = "tn_test_wb_a";
const TENANT_B = "tn_test_wb_b";
const ENV_X = "env_x";
const ENV_Y = "env_y";
const SESS_A = "sess-a";
const SESS_B = "sess-b";

beforeAll(async () => {
  // Trigger the test-worker's ensureMigrations() once so the workspace_backups
  // table exists. Hitting any HTTP route does it (see test/test-worker.ts).
  await (exports as any).default.fetch(new Request("http://localhost/health"));
}, 30_000); // 30s — concurrent file load + miniflare warmup blows past the
            // default 10s on cold runs.

beforeEach(async () => {
  // Each test gets a clean slate so ordering doesn't bleed.
  await (env as any).AUTH_DB.prepare(
    `DELETE FROM workspace_backups WHERE tenant_id IN (?, ?)`,
  ).bind(TENANT_A, TENANT_B).run();
});

function fakeHandle(id: string): WorkspaceBackupHandle {
  return { id, dir: "/workspace" };
}

describe("workspace-backups: findLatestBackup", () => {
  it("returns null when no backups exist", async () => {
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, Date.now());
    expect(got).toBeNull();
  });

  it("returns the only backup when one exists", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-1"),
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, now);
    expect(got?.id).toBe("bk-1");
    expect(got?.dir).toBe("/workspace");
  });

  it("returns the NEWEST backup when multiple exist for same scope", async () => {
    const t0 = Date.now();
    // Multiple backups within ONE session — e.g. the agent did several
    // forced backups during a long-running task. Newest wins.
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-old"),
      nowMs: t0, ttlSec: 3600, sessionId: SESS_A,
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-mid"),
      nowMs: t0 + 1000, ttlSec: 3600, sessionId: SESS_A,
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-new"),
      nowMs: t0 + 2000, ttlSec: 3600, sessionId: SESS_A,
    });
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, t0 + 2000);
    expect(got?.id).toBe("bk-new");
  });

  it("isolates scope by (tenant_id, environment_id, session_id)", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-A-X-a"),
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_Y,
      handle: fakeHandle("bk-A-Y-a"),
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_B, environmentId: ENV_X,
      handle: fakeHandle("bk-B-X-a"),
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });

    expect((await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, now))?.id).toBe("bk-A-X-a");
    expect((await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_Y, SESS_A, now))?.id).toBe("bk-A-Y-a");
    expect((await findLatestBackup((env as any).AUTH_DB, TENANT_B, ENV_X, SESS_A, now))?.id).toBe("bk-B-X-a");
    expect(await findLatestBackup((env as any).AUTH_DB, TENANT_B, ENV_Y, SESS_A, now)).toBeNull();
  });

  it("does NOT return another session's backup at same (tenant, env)", async () => {
    // Regression test for the cross-session pollution bug observed in the
    // 2026-05-02 TB pilot: batched eval runs share a (tenant, env) and
    // earlier reads ignored source_session_id, so session B could pick up
    // session A's /workspace state.
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-from-A"),
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });
    // Session B in the same (tenant, env) — should see nothing.
    expect(await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_B, now)).toBeNull();
    // Session A still finds its own backup.
    expect((await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, now))?.id).toBe("bk-from-A");
  });

  it("returns null when the only backup has expired", async () => {
    const t0 = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-stale"),
      nowMs: t0 - 10_000_000, ttlSec: 1, sessionId: SESS_A, // expired far in the past
    });
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, t0);
    expect(got).toBeNull();
  });

  it("returns the newest UN-expired backup, skipping expired ones", async () => {
    const t0 = Date.now();
    // expired
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-stale-newer"),
      nowMs: t0 - 1000, ttlSec: 0, sessionId: SESS_A, // expired immediately
    });
    // live but older
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-fresh-older"),
      nowMs: t0 - 5000, ttlSec: 3600, sessionId: SESS_A,
    });
    // The expired one is "newer" by created_at but should be filtered out;
    // the live older one should win.
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, t0);
    expect(got?.id).toBe("bk-fresh-older");
  });

  it("preserves the localBucket flag through serialize/deserialize", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: { id: "bk-local", dir: "/workspace", localBucket: true },
      nowMs: now, ttlSec: 3600, sessionId: SESS_A,
    });
    const got = await findLatestBackup((env as any).AUTH_DB, TENANT_A, ENV_X, SESS_A, now);
    expect(got?.localBucket).toBe(true);
  });
});

describe("workspace-backups: recordBackup", () => {
  it("stores all fields the schema needs", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-row"),
      nowMs: now, ttlSec: 3600, sessionId: "sess-prov",
    });
    const row = await (env as any).AUTH_DB.prepare(
      `SELECT tenant_id, environment_id, backup_handle, created_at, expires_at, source_session_id
       FROM workspace_backups
       WHERE tenant_id = ? AND environment_id = ?`,
    ).bind(TENANT_A, ENV_X).first();

    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.environment_id).toBe(ENV_X);
    expect(JSON.parse(row.backup_handle).id).toBe("bk-row");
    expect(row.created_at).toBe(now);
    expect(row.expires_at).toBe(now + 3600 * 1000);
    expect(row.source_session_id).toBe("sess-prov");
  });

  it("allows null source_session_id (not all callers have one)", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-anon"),
      nowMs: now, ttlSec: 60,
    });
    const row = await (env as any).AUTH_DB.prepare(
      `SELECT source_session_id FROM workspace_backups WHERE tenant_id = ?`,
    ).bind(TENANT_A).first();
    expect(row.source_session_id).toBeNull();
  });

  it("does not throw on duplicate inserts (multiple backups same scope is normal)", async () => {
    const now = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-1"),
      nowMs: now, ttlSec: 3600,
    });
    await expect(
      recordBackup((env as any).AUTH_DB, {
        tenantId: TENANT_A, environmentId: ENV_X,
        handle: fakeHandle("bk-2"),
        nowMs: now + 1, ttlSec: 3600,
      }),
    ).resolves.not.toThrow();

    const count = await (env as any).AUTH_DB.prepare(
      `SELECT COUNT(*) AS c FROM workspace_backups WHERE tenant_id = ?`,
    ).bind(TENANT_A).first();
    expect(count.c).toBe(2);
  });
});

describe("workspace-backups: pruneExpired", () => {
  it("removes only expired rows", async () => {
    const t0 = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-expired"),
      nowMs: t0 - 5000, ttlSec: 1, // expires_at = t0 - 4000
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-live"),
      nowMs: t0 - 1000, ttlSec: 3600,
    });

    const removed = await pruneExpired((env as any).AUTH_DB, t0);
    expect(removed).toBe(1);

    const remaining = await (env as any).AUTH_DB.prepare(
      `SELECT backup_handle FROM workspace_backups WHERE tenant_id = ?`,
    ).bind(TENANT_A).all();
    expect(remaining.results).toHaveLength(1);
    expect(JSON.parse(remaining.results[0].backup_handle).id).toBe("bk-live");
  });

  it("returns 0 when nothing expired", async () => {
    const t0 = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-fresh"),
      nowMs: t0, ttlSec: 3600,
    });
    const removed = await pruneExpired((env as any).AUTH_DB, t0);
    expect(removed).toBe(0);
  });

  it("scans across tenants", async () => {
    const t0 = Date.now();
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_A, environmentId: ENV_X,
      handle: fakeHandle("bk-a-expired"),
      nowMs: t0 - 5000, ttlSec: 1,
    });
    await recordBackup((env as any).AUTH_DB, {
      tenantId: TENANT_B, environmentId: ENV_X,
      handle: fakeHandle("bk-b-expired"),
      nowMs: t0 - 5000, ttlSec: 1,
    });
    const removed = await pruneExpired((env as any).AUTH_DB, t0);
    expect(removed).toBe(2);
  });
});

describe("workspace-backups: defaults", () => {
  it("DEFAULT_WORKSPACE_BACKUP_TTL_SEC is 7 days", () => {
    expect(DEFAULT_WORKSPACE_BACKUP_TTL_SEC).toBe(7 * 24 * 60 * 60);
  });
});
