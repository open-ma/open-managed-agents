// Unit tests for the new shard-router services + MetaTableTenantDbProvider.
//
// Verifies:
//   - TenantShardDirectoryService.assign is idempotent (first write wins,
//     never re-routes a live tenant)
//   - ShardPoolService.pickShardForNewTenant picks lowest tenant_count
//   - MetaTableTenantDbProvider falls back to default binding when
//     tenant_shard has no row (N=1 baseline)
//   - MetaTableTenantDbProvider caches per-isolate (no second control-plane
//     query for same tenantId)

import { describe, it, expect, beforeEach } from "vitest";
import {
  TenantShardDirectoryService,
  ShardPoolService,
} from "@open-managed-agents/tenant-dbs-store";
import {
  InMemoryTenantShardDirectoryRepo,
  InMemoryShardPoolRepo,
} from "@open-managed-agents/tenant-dbs-store/test-fakes";

describe("TenantShardDirectoryService", () => {
  let service: TenantShardDirectoryService;

  beforeEach(() => {
    service = new TenantShardDirectoryService(new InMemoryTenantShardDirectoryRepo());
  });

  it("assign creates a new tenant_shard row", async () => {
    const row = await service.assign({ tenantId: "tn_a", bindingName: "AUTH_DB" });
    expect(row.tenantId).toBe("tn_a");
    expect(row.bindingName).toBe("AUTH_DB");
    expect(row.createdAt).toBeGreaterThan(0);
  });

  it("assign is idempotent — second call preserves the original binding", async () => {
    await service.assign({ tenantId: "tn_a", bindingName: "AUTH_DB" });
    // A misguided second call (e.g. retry) tries to assign a different shard.
    const row = await service.assign({ tenantId: "tn_a", bindingName: "DB_001" });
    // The original assignment stands — never silently re-route a live tenant.
    expect(row.bindingName).toBe("AUTH_DB");
  });

  it("get returns null when tenant has no assignment", async () => {
    expect(await service.get("tn_unknown")).toBeNull();
  });

  it("get returns the assignment after assign", async () => {
    await service.assign({ tenantId: "tn_a", bindingName: "DB_007" });
    expect((await service.get("tn_a"))?.bindingName).toBe("DB_007");
  });

  it("migrateTo updates the binding (admin op, requires worker restart in prod)", async () => {
    await service.assign({ tenantId: "tn_a", bindingName: "AUTH_DB" });
    await service.migrateTo("tn_a", "DB_001");
    expect((await service.get("tn_a"))?.bindingName).toBe("DB_001");
  });

  it("listAll returns rows in createdAt order", async () => {
    await service.assign({ tenantId: "tn_z", bindingName: "AUTH_DB" });
    await service.assign({ tenantId: "tn_a", bindingName: "DB_001" });
    const all = await service.listAll();
    expect(all.map((r) => r.tenantId)).toEqual(["tn_z", "tn_a"]);
  });
});

describe("ShardPoolService", () => {
  let service: ShardPoolService;

  beforeEach(() => {
    service = new ShardPoolService(new InMemoryShardPoolRepo());
  });

  it("register inserts a new shard with status open by default", async () => {
    const row = await service.register({ bindingName: "DB_001" });
    expect(row.status).toBe("open");
    expect(row.tenantCount).toBe(0);
    expect(row.sizeBytes).toBeNull();
  });

  it("pickShardForNewTenant returns null when no shards registered", async () => {
    expect(await service.pickShardForNewTenant()).toBeNull();
  });

  it("pickShardForNewTenant returns the only open shard", async () => {
    await service.register({ bindingName: "AUTH_DB" });
    const pick = await service.pickShardForNewTenant();
    expect(pick?.bindingName).toBe("AUTH_DB");
  });

  it("pickShardForNewTenant prefers lowest tenant_count", async () => {
    await service.register({ bindingName: "DB_a" });
    await service.register({ bindingName: "DB_b" });
    await service.incrementTenantCount("DB_a");
    await service.incrementTenantCount("DB_a");
    await service.incrementTenantCount("DB_b");
    const pick = await service.pickShardForNewTenant();
    expect(pick?.bindingName).toBe("DB_b"); // count=1 < DB_a count=2
  });

  it("draining/full/archived shards are excluded from pickOpen", async () => {
    await service.register({ bindingName: "DB_a" });
    await service.register({ bindingName: "DB_b" });
    await service.markStatus("DB_a", "draining");
    const pick = await service.pickShardForNewTenant();
    expect(pick?.bindingName).toBe("DB_b");
  });

  it("recordObservedSize updates size + observedAt", async () => {
    await service.register({ bindingName: "DB_a" });
    await service.recordObservedSize("DB_a", 9_500_000_000);
    const row = await service.listAll();
    expect(row[0].sizeBytes).toBe(9_500_000_000);
    expect(row[0].observedAt).toBeGreaterThan(0);
  });
});

describe("MetaTableTenantDbProvider — caching + fallback", () => {
  // Direct unit test for cache + fallback semantics. Driven via miniflare
  // D1 in test-worker.ts isn't available here — we hand-roll a fake D1
  // adapter that records prepare/bind/first calls.

  function makeFakeDb(rows: Array<{ binding_name: string } | null>): D1Database {
    let callCount = 0;
    return {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            const r = rows[callCount] ?? null;
            callCount++;
            return r;
          },
        }),
      }),
    } as unknown as D1Database;
  }

  it("falls back to defaultBinding when tenant_shard has no row", async () => {
    const { MetaTableTenantDbProvider } = await import("@open-managed-agents/tenant-db");
    const auth = { __label: "AUTH_DB" } as unknown as D1Database;
    const provider = new MetaTableTenantDbProvider(
      { AUTH_DB: auth },
      makeFakeDb([null]), // control-plane returns no row
      auth,
    );
    const result = await provider.resolve("tn_no_shard");
    expect(result).toBe(auth);
  });

  it("returns the env-bound D1 when tenant_shard has a row", async () => {
    const { MetaTableTenantDbProvider } = await import("@open-managed-agents/tenant-db");
    const auth = { __label: "AUTH_DB" } as unknown as D1Database;
    const db001 = { __label: "DB_001" } as unknown as D1Database;
    const provider = new MetaTableTenantDbProvider(
      { AUTH_DB: auth, DB_001: db001 },
      makeFakeDb([{ binding_name: "DB_001" }]),
      auth,
    );
    const result = await provider.resolve("tn_on_db001");
    expect(result).toBe(db001);
  });

  it("caches per-tenant — second resolve does not re-query control plane", async () => {
    const { MetaTableTenantDbProvider } = await import("@open-managed-agents/tenant-db");
    const auth = { __label: "AUTH_DB" } as unknown as D1Database;
    const db007 = { __label: "DB_007" } as unknown as D1Database;
    let queryCount = 0;
    const trackingDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            queryCount++;
            return { binding_name: "DB_007" };
          },
        }),
      }),
    } as unknown as D1Database;
    const provider = new MetaTableTenantDbProvider(
      { AUTH_DB: auth, DB_007: db007 },
      trackingDb,
      auth,
    );
    await provider.resolve("tn_cached");
    await provider.resolve("tn_cached");
    await provider.resolve("tn_cached");
    expect(queryCount).toBe(1);
  });

  it("control-plane lookup failure falls back to defaultBinding (graceful degradation)", async () => {
    const { MetaTableTenantDbProvider } = await import("@open-managed-agents/tenant-db");
    const auth = { __label: "AUTH_DB" } as unknown as D1Database;
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1 unreachable");
          },
        }),
      }),
    } as unknown as D1Database;
    const provider = new MetaTableTenantDbProvider(
      { AUTH_DB: auth },
      failingDb,
      auth,
    );
    const result = await provider.resolve("tn_failing");
    expect(result).toBe(auth);
  });

  it("throws when tenant_shard row references a binding that doesn't exist in env", async () => {
    const { MetaTableTenantDbProvider } = await import("@open-managed-agents/tenant-db");
    const auth = { __label: "AUTH_DB" } as unknown as D1Database;
    const provider = new MetaTableTenantDbProvider(
      { AUTH_DB: auth }, // no DB_999 binding
      makeFakeDb([{ binding_name: "DB_999" }]),
      auth,
    );
    await expect(provider.resolve("tn_misconfigured")).rejects.toThrow(/DB_999.+env doesn't have it/);
  });
});
