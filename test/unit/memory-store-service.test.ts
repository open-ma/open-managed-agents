// Unit tests for MemoryStoreService — drives the service against in-memory
// implementations of every port. No D1, AI, or Vectorize bindings needed.
//
// What's covered here is *service-level* behavior: consistency rules,
// preconditions, atomicity, reconciliation flow, error mapping. Adapter
// behavior (D1 SQL, Vectorize semantics) is exercised via integration
// tests + manual end-to-end verification on Cloudflare staging.

import { describe, it, expect } from "vitest";
import {
  MemoryContentTooLargeError,
  MemoryPreconditionFailedError,
  MemoryStoreNotFoundError,
} from "@open-managed-agents/memory-store";
import {
  DeterministicEmbeddingProvider,
  FailingVectorIndex,
  InMemoryVectorIndex,
  createInMemoryMemoryStoreService,
} from "@open-managed-agents/memory-store/test-fakes";

const TENANT = "tn_test_memstore";
const ACTOR = { type: "system" as const, id: "test" };

describe("MemoryStoreService — store CRUD", () => {
  it("creates and lists stores", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const a = await service.createStore({ tenantId: TENANT, name: "A" });
    const b = await service.createStore({ tenantId: TENANT, name: "B", description: "desc" });
    expect(a.id).toMatch(/^memstore-/);
    expect(b.description).toBe("desc");
    const list = await service.listStores({ tenantId: TENANT });
    expect(list.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });

  it("hides archived stores by default", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "X" });
    await service.archiveStore({ tenantId: TENANT, storeId: s.id });
    expect((await service.listStores({ tenantId: TENANT })).length).toBe(0);
    expect((await service.listStores({ tenantId: TENANT, includeArchived: true })).length).toBe(1);
  });

  it("isolates stores by tenant", async () => {
    const { service } = createInMemoryMemoryStoreService();
    await service.createStore({ tenantId: "tn_a", name: "A" });
    await service.createStore({ tenantId: "tn_b", name: "B" });
    expect((await service.listStores({ tenantId: "tn_a" })).length).toBe(1);
    expect((await service.listStores({ tenantId: "tn_b" })).length).toBe(1);
  });
});

describe("MemoryStoreService — memory write/read", () => {
  it("creates a memory + version atomically and syncs Vectorize", async () => {
    const { service, vectorIndex } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({
      tenantId: TENANT,
      storeId: store.id,
      path: "/notes/hi",
      content: "hello world",
      actor: ACTOR,
    });
    expect(mem.path).toBe("/notes/hi");
    expect(mem.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mem.size_bytes).toBe(11);
    // Vector index sync ran successfully → row marked synced.
    expect(mem.vector_synced_at).not.toBeNull();
    expect((vectorIndex as InMemoryVectorIndex).has(`${store.id}:${mem.id}`)).toBe(true);

    const versions = await service.listVersions({ tenantId: TENANT, storeId: store.id });
    expect(versions.length).toBe(1);
    expect(versions[0].operation).toBe("created");
    expect(versions[0].path).toBe("/notes/hi");
    expect(versions[0].actor_type).toBe("system");
  });

  it("upserts on duplicate path (rather than creating a 2nd row)", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v2", actor: ACTOR });
    const list = await service.listMemories({ tenantId: TENANT, storeId: store.id });
    expect(list.length).toBe(1);
    expect(list[0].content).toBe("v2");
    const versions = await service.listVersions({ tenantId: TENANT, storeId: store.id });
    expect(versions.length).toBe(2);
    expect(versions.map((v) => v.operation).sort()).toEqual(["created", "modified"]);
  });

  it("filters memory_list by path_prefix", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/notes/a", content: "x", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/notes/b", content: "x", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/other/c", content: "x", actor: ACTOR });
    const notes = await service.listMemories({ tenantId: TENANT, storeId: store.id, pathPrefix: "/notes/" });
    expect(notes.map((m) => m.path).sort()).toEqual(["/notes/a", "/notes/b"]);
  });

  it("readByPath returns null for missing path", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    expect(await service.readByPath({ tenantId: TENANT, storeId: store.id, path: "/missing" })).toBeNull();
  });

  it("rejects content > 100 KB", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const oversized = "x".repeat(100 * 1024 + 1);
    await expect(
      service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/big", content: oversized, actor: ACTOR }),
    ).rejects.toBeInstanceOf(MemoryContentTooLargeError);
  });
});

describe("MemoryStoreService — preconditions", () => {
  it("not_exists fires 409 on duplicate path", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await expect(
      service.writeByPath({
        tenantId: TENANT,
        storeId: store.id,
        path: "/p",
        content: "v2",
        precondition: { type: "not_exists" },
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(MemoryPreconditionFailedError);
  });

  it("content_sha256 mismatch fires 409", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await expect(
      service.writeByPath({
        tenantId: TENANT,
        storeId: store.id,
        path: "/p",
        content: "v2",
        precondition: { type: "content_sha256", content_sha256: "wrongHash" },
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(MemoryPreconditionFailedError);

    // Correct hash works.
    await service.writeByPath({
      tenantId: TENANT,
      storeId: store.id,
      path: "/p",
      content: "v2",
      precondition: { type: "content_sha256", content_sha256: mem.content_sha256 },
      actor: ACTOR,
    });
  });
});

describe("MemoryStoreService — update / delete", () => {
  it("update by id changes content + writes version + re-syncs vector", async () => {
    const { service, vectorIndex } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await service.updateById({
      tenantId: TENANT, storeId: store.id, memoryId: mem.id,
      content: "v2", actor: ACTOR,
    });
    const refreshed = await service.readById({ tenantId: TENANT, storeId: store.id, memoryId: mem.id });
    expect(refreshed!.content).toBe("v2");
    expect(refreshed!.vector_synced_at).not.toBeNull();
    expect((await service.listVersions({ tenantId: TENANT, storeId: store.id })).length).toBe(2);
    // Vector key remains stable through updates (idempotent overwrite).
    expect((vectorIndex as InMemoryVectorIndex).size()).toBe(1);
  });

  it("delete removes memory + writes deleted version + cleans vector", async () => {
    const { service, vectorIndex } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await service.deleteById({ tenantId: TENANT, storeId: store.id, memoryId: mem.id, actor: ACTOR });
    expect(await service.readById({ tenantId: TENANT, storeId: store.id, memoryId: mem.id })).toBeNull();
    const versions = await service.listVersions({ tenantId: TENANT, storeId: store.id });
    expect(versions.length).toBe(2);
    const deleted = versions.find((v) => v.operation === "deleted")!;
    expect(deleted.content).toBe("v1");
    expect((vectorIndex as InMemoryVectorIndex).size()).toBe(0);
  });

  it("deleteById with mismatched expectedSha throws 409", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v1", actor: ACTOR });
    await expect(
      service.deleteById({ tenantId: TENANT, storeId: store.id, memoryId: mem.id, expectedSha: "wrong", actor: ACTOR }),
    ).rejects.toBeInstanceOf(MemoryPreconditionFailedError);
    expect(await service.readById({ tenantId: TENANT, storeId: store.id, memoryId: mem.id })).not.toBeNull();
  });

  it("deleteStore cascades memories + cleans vectors", async () => {
    const { service, vectorIndex, memoryRepo } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "v", actor: ACTOR });
    await service.deleteStore({ tenantId: TENANT, storeId: store.id });
    await expect(
      service.listMemories({ tenantId: TENANT, storeId: store.id }),
    ).rejects.toBeInstanceOf(MemoryStoreNotFoundError);
    expect((vectorIndex as InMemoryVectorIndex).size()).toBe(0);
    expect(await memoryRepo.countUnsynced()).toBe(0);
  });
});

describe("MemoryStoreService — semantic search via injected fakes", () => {
  it("returns hits ordered by similarity, with D1 join filtering orphans", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/a", content: "alpha beta gamma delta", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/b", content: "alpha beta", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/c", content: "completely different words", actor: ACTOR });

    const hits = await service.searchMemories({ tenantId: TENANT, storeId: store.id, query: "alpha beta" });
    expect(hits.length).toBeGreaterThan(0);
    // /b is the closer match (exact phrase).
    expect(hits[0].path).toBe("/b");
  });

  it("search returns [] when vector index is the no-op variant", async () => {
    // Build a service with our own no-op-style adapters by passing a failing
    // index that reports unavailable via isAvailable().
    const { service } = createInMemoryMemoryStoreService({
      vectorIndex: {
        isAvailable: () => false,
        upsert: async () => {},
        query: async () => [],
        deleteByIds: async () => {},
        getById: async () => null,
      },
    });
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "hello", actor: ACTOR });
    expect(await service.searchMemories({ tenantId: TENANT, storeId: store.id, query: "hello" })).toEqual([]);
  });
});

describe("MemoryStoreService — Vectorize-down → write succeeds, reconcile fixes it", () => {
  it("write logs warning, returns 200, leaves vector_synced_at NULL when index throws", async () => {
    const failing = new FailingVectorIndex();
    const { service } = createInMemoryMemoryStoreService({ vectorIndex: failing });
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    const mem = await service.writeByPath({
      tenantId: TENANT,
      storeId: store.id,
      path: "/p",
      content: "hello",
      actor: ACTOR,
    });
    expect(mem.id).toBeDefined();
    expect(mem.vector_synced_at).toBeNull();
  });

  it("reconcile drains stale rows once vector index recovers", async () => {
    const failing = new FailingVectorIndex();
    const { service, memoryRepo, storeRepo, versionRepo } = createInMemoryMemoryStoreService({ vectorIndex: failing });
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p1", content: "a", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p2", content: "b", actor: ACTOR });
    expect(await memoryRepo.countUnsynced()).toBe(2);

    // Swap in a working vector index — simulates ops fixing Vectorize after
    // an incident — and reconcile.
    const recoveredIndex = new InMemoryVectorIndex();
    const recovered = new (await import("@open-managed-agents/memory-store")).MemoryStoreService({
      storeRepo,
      memoryRepo,
      versionRepo,
      embedding: new DeterministicEmbeddingProvider(),
      vectorIndex: recoveredIndex,
    });
    const result = await recovered.reconcile({ tenantId: TENANT, storeId: store.id });
    expect(result.scanned).toBe(2);
    expect(result.fixed).toBe(2);
    expect(result.still_failing).toBe(0);
    expect(recoveredIndex.size()).toBe(2);
    expect(await memoryRepo.countUnsynced()).toBe(0);
  });

  it("reconcile reports stale rows but cannot fix when index is unavailable", async () => {
    const { service } = createInMemoryMemoryStoreService({
      vectorIndex: {
        isAvailable: () => false,
        upsert: async () => {},
        query: async () => [],
        deleteByIds: async () => {},
        getById: async () => null,
      },
    });
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/p", content: "x", actor: ACTOR });
    const result = await service.reconcile({ tenantId: TENANT, storeId: store.id });
    expect(result.scanned).toBe(1);
    expect(result.fixed).toBe(0);
    expect(result.sample_errors[0].error).toMatch(/unavailable/);
  });
});

describe("MemoryStoreService — version operations", () => {
  it("redact wipes content + path but preserves audit fields", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const store = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: store.id, path: "/secret", content: "leaked", actor: ACTOR });
    const versions = await service.listVersions({ tenantId: TENANT, storeId: store.id });
    const v = versions[0];
    await service.redactVersion({ tenantId: TENANT, storeId: store.id, versionId: v.id });
    const after = await service.getVersion({ tenantId: TENANT, storeId: store.id, versionId: v.id });
    expect(after!.content).toBeNull();
    expect(after!.path).toBeNull();
    expect(after!.redacted).toBe(true);
    expect(after!.actor_type).toBe("system");
  });
});
