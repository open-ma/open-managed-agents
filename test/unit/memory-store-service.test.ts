// Unit tests for the Anthropic-aligned MemoryStoreService — drives the
// service against in-memory implementations of every port. No D1 or R2
// bindings needed.
//
// What's covered here is *service-level* behavior: consistency rules,
// preconditions, atomicity (R2 conditional PUT semantics), redact constraint,
// retention pruning, and queue-consumer-style upsertFromEvent / deleteFromEvent.
// Adapter behavior (D1 SQL, real R2) is exercised via integration tests +
// staging end-to-end verification.

import { describe, it, expect } from "vitest";
import {
  MemoryContentTooLargeError,
  MemoryNotFoundError,
  MemoryPreconditionFailedError,
  MemoryStoreNotFoundError,
} from "@open-managed-agents/memory-store";
import { createInMemoryMemoryStoreService } from "@open-managed-agents/memory-store/test-fakes";
import { generateMemoryVersionId } from "@open-managed-agents/shared";

const TENANT = "tn_test_memstore";
const ACTOR = { type: "system" as const, id: "test" };

describe("MemoryStoreService — store CRUD", () => {
  it("creates and lists stores", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const a = await service.createStore({ tenantId: TENANT, name: "A" });
    const b = await service.createStore({ tenantId: TENANT, name: "B", description: "desc" });
    expect(a.id).toMatch(/^memstore-/);
    expect(b.description).toBe("desc");
    const all = await service.listStores({ tenantId: TENANT });
    expect(all.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });

  it("rejects store names with forbidden characters", async () => {
    const { service } = createInMemoryMemoryStoreService();
    await expect(service.createStore({ tenantId: TENANT, name: "" })).rejects.toThrow();
    await expect(service.createStore({ tenantId: TENANT, name: "a/b" })).rejects.toThrow();
    // Spaces are allowed (Anthropic mounts /mnt/memory/User Preferences/ literally).
    await expect(
      service.createStore({ tenantId: TENANT, name: "User Preferences" }),
    ).resolves.toBeDefined();
  });

  it("archives + delete cleans up R2 + D1", async () => {
    const { service, blobs } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "to-clean" });
    await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x.md", content: "hi", actor: ACTOR,
    });
    expect(blobs.size()).toBe(1);
    await service.archiveStore({ tenantId: TENANT, storeId: s.id });
    expect((await service.getStore({ tenantId: TENANT, storeId: s.id }))!.archived_at).toBeTruthy();
    await service.deleteStore({ tenantId: TENANT, storeId: s.id });
    expect(blobs.size()).toBe(0);
    expect(await service.getStore({ tenantId: TENANT, storeId: s.id })).toBeNull();
  });

  it("isolates tenants — store in tenant A invisible to tenant B", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const a = await service.createStore({ tenantId: "tn_a", name: "shared-name" });
    expect(await service.getStore({ tenantId: "tn_b", storeId: a.id })).toBeNull();
  });
});

describe("MemoryStoreService — memory writes", () => {
  it("writeByPath creates a memory + version row + R2 object", async () => {
    const { service, memoryRepo, blobs } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/foo.md", content: "hello",
      actor: ACTOR,
    });
    expect(m.path).toBe("/foo.md");
    expect(m.content).toBe("hello");
    expect(m.etag).toBeTruthy();
    expect(blobs.has(`${s.id}/foo.md`)).toBe(true);
    expect(memoryRepo.versions).toHaveLength(1);
    expect(memoryRepo.versions[0].operation).toBe("created");
    expect(memoryRepo.versions[0].content).toBe("hello");
  });

  it("writeByPath with existing path overwrites + writes 'modified' version", async () => {
    const { service, memoryRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR,
    });
    const m2 = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "v2", actor: ACTOR,
    });
    expect(m2.content).toBe("v2");
    expect(memoryRepo.versions.map((v) => v.operation)).toEqual(["created", "modified"]);
  });

  it("rejects content > 100KB", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const huge = "x".repeat(101 * 1024);
    await expect(
      service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/big", content: huge, actor: ACTOR }),
    ).rejects.toThrow(MemoryContentTooLargeError);
  });

  it("rejects forbidden path characters", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await expect(
      service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "../escape", content: "x", actor: ACTOR }),
    ).rejects.toThrow();
    await expect(
      service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "back\\slash", content: "x", actor: ACTOR }),
    ).rejects.toThrow();
  });

  it("rejects unknown store with MemoryStoreNotFoundError", async () => {
    const { service } = createInMemoryMemoryStoreService();
    await expect(
      service.writeByPath({ tenantId: TENANT, storeId: "memstore-doesnotexist", path: "/x", content: "y", actor: ACTOR }),
    ).rejects.toThrow(MemoryStoreNotFoundError);
  });
});

describe("MemoryStoreService — preconditions (CAS)", () => {
  it("not_exists precondition fails when path occupied", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR });
    await expect(
      service.writeByPath({
        tenantId: TENANT, storeId: s.id, path: "/x", content: "v2",
        precondition: { type: "not_exists" }, actor: ACTOR,
      }),
    ).rejects.toThrow(MemoryPreconditionFailedError);
  });

  it("content_sha256 precondition succeeds when sha matches", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR,
    });
    const m2 = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "v2",
      precondition: { type: "content_sha256", content_sha256: m.content_sha256 },
      actor: ACTOR,
    });
    expect(m2.content).toBe("v2");
  });

  it("content_sha256 precondition fails on stale sha", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR });
    await expect(
      service.writeByPath({
        tenantId: TENANT, storeId: s.id, path: "/x", content: "v2",
        precondition: { type: "content_sha256", content_sha256: "fake-sha" },
        actor: ACTOR,
      }),
    ).rejects.toThrow(MemoryPreconditionFailedError);
  });
});

describe("MemoryStoreService — updateById + deleteById", () => {
  it("updateById renames the memory + writes new R2 object", async () => {
    const { service, blobs } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/old", content: "data", actor: ACTOR,
    });
    const renamed = await service.updateById({
      tenantId: TENANT, storeId: s.id, memoryId: m.id, path: "/new", actor: ACTOR,
    });
    expect(renamed.path).toBe("/new");
    expect(blobs.has(`${s.id}/new`)).toBe(true);
    expect(blobs.has(`${s.id}/old`)).toBe(false);
  });

  it("deleteById removes from R2 + writes 'deleted' version row", async () => {
    const { service, memoryRepo, blobs } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "data", actor: ACTOR,
    });
    await service.deleteById({ tenantId: TENANT, storeId: s.id, memoryId: m.id, actor: ACTOR });
    expect(blobs.has(`${s.id}/x`)).toBe(false);
    expect(memoryRepo.versions.at(-1)!.operation).toBe("deleted");
    expect(await service.readById({ tenantId: TENANT, storeId: s.id, memoryId: m.id })).toBeNull();
  });

  it("deleteById refuses on stale expectedSha", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "data", actor: ACTOR,
    });
    await expect(
      service.deleteById({
        tenantId: TENANT, storeId: s.id, memoryId: m.id,
        expectedSha: "fake-sha", actor: ACTOR,
      }),
    ).rejects.toThrow(MemoryPreconditionFailedError);
  });

  it("readById on missing memory returns null; updateById throws", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    expect(await service.readById({ tenantId: TENANT, storeId: s.id, memoryId: "mem-missing" })).toBeNull();
    await expect(
      service.updateById({ tenantId: TENANT, storeId: s.id, memoryId: "mem-missing", content: "x", actor: ACTOR }),
    ).rejects.toThrow(MemoryNotFoundError);
  });
});

describe("MemoryStoreService — versions + redact + rollback workflow", () => {
  it("listVersions returns audit chain in chronological order", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v2", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v3", actor: ACTOR });
    const vs = await service.listVersions({ tenantId: TENANT, storeId: s.id });
    expect(vs.length).toBe(3);
    expect(vs.map((v) => v.content)).toEqual(["v3", "v2", "v1"]);
  });

  it("rollback workflow: getVersion → writeByPath produces a new version with the old content", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m1 = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "A", actor: ACTOR,
    });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "B", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "C", actor: ACTOR });

    const versions = await service.listVersions({ tenantId: TENANT, storeId: s.id, memoryId: m1.id });
    const v1 = versions[versions.length - 1]; // oldest = "A"
    expect(v1.content).toBe("A");

    // Roll back: write the old content as the new live version
    const m4 = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: v1.content!, actor: ACTOR,
    });
    expect(m4.content).toBe("A");
    expect(m4.content_sha256).toBe(v1.content_sha256);

    const after = await service.listVersions({ tenantId: TENANT, storeId: s.id, memoryId: m1.id });
    expect(after.length).toBe(4);
    expect(after[0].content).toBe("A");
    expect(after[0].content_sha256).toBe(v1.content_sha256);
  });

  it("redact refuses live head; succeeds on prior version", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v2", actor: ACTOR });

    const versions = await service.listVersions({ tenantId: TENANT, storeId: s.id });
    const head = versions[0]; // newest = "v2" (live)
    const prior = versions[1]; // older = "v1"

    await expect(
      service.redactVersion({ tenantId: TENANT, storeId: s.id, versionId: head.id }),
    ).rejects.toThrow(MemoryPreconditionFailedError);

    const redacted = await service.redactVersion({
      tenantId: TENANT, storeId: s.id, versionId: prior.id,
    });
    expect(redacted.redacted).toBe(true);
    expect(redacted.content).toBeNull();
  });

  it("versions outlive their parent memory (audit chain preserved)", async () => {
    const { service } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "data", actor: ACTOR,
    });
    await service.deleteById({ tenantId: TENANT, storeId: s.id, memoryId: m.id, actor: ACTOR });
    const versions = await service.listVersions({
      tenantId: TENANT, storeId: s.id, memoryId: m.id,
    });
    expect(versions.length).toBe(2);
    expect(versions[0].operation).toBe("deleted");
    expect(versions[1].operation).toBe("created");
  });
});

describe("MemoryRepo — upsertFromEvent / deleteFromEvent (queue consumer)", () => {
  it("upsertFromEvent creates memory + version on first event", async () => {
    const { service, memoryRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const out = await memoryRepo.upsertFromEvent({
      storeId: s.id,
      path: "/agent-wrote.md",
      contentSha256: "sha-fake",
      etag: "etag-fake",
      sizeBytes: 5,
      actor: { type: "agent_session", id: "sess_xyz" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
      content: "hello",
    });
    expect(out.wrote).toBe(true);
    expect(memoryRepo.versions.at(-1)!.actor_type).toBe("agent_session");
  });

  it("upsertFromEvent dedupes by etag (R2 at-least-once delivery)", async () => {
    const { service, memoryRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const event = {
      storeId: s.id,
      path: "/x",
      contentSha256: "sha-1",
      etag: "etag-1",
      sizeBytes: 5,
      actor: { type: "agent_session" as const, id: "sess" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
      content: "hello",
    };
    const a = await memoryRepo.upsertFromEvent(event);
    const b = await memoryRepo.upsertFromEvent({ ...event, versionId: generateMemoryVersionId() });
    expect(a.wrote).toBe(true);
    expect(b.wrote).toBe(false);
    expect(memoryRepo.versions.length).toBe(1);
  });

  it("deleteFromEvent removes the memory + writes deleted version", async () => {
    const { service, memoryRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "data", actor: ACTOR,
    });
    const out = await memoryRepo.deleteFromEvent({
      storeId: s.id, path: "/x",
      actor: { type: "agent_session", id: "sess" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
    });
    expect(out.wrote).toBe(true);
    expect(memoryRepo.versions.at(-1)!.operation).toBe("deleted");
  });

  it("deleteFromEvent on missing path is a no-op (dedupe)", async () => {
    const { service, memoryRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const out = await memoryRepo.deleteFromEvent({
      storeId: s.id, path: "/nope",
      actor: { type: "agent_session", id: "sess" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
    });
    expect(out.wrote).toBe(false);
  });
});

describe("MemoryVersionRepo — pruneOlderThan", () => {
  it("drops old versions but keeps the most recent per memory_id", async () => {
    const { service, versionRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    const m = await service.writeByPath({
      tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR,
    });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v2", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v3", actor: ACTOR });

    const removed = await versionRepo.pruneOlderThan(Date.now() + 60_000);
    expect(removed).toBe(2);
    const remaining = await versionRepo.list(s.id, { memoryId: m.id, limit: 100 });
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("v3");
  });

  it("keeps everything when nothing is past cutoff", async () => {
    const { service, versionRepo } = createInMemoryMemoryStoreService();
    const s = await service.createStore({ tenantId: TENANT, name: "S" });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v1", actor: ACTOR });
    await service.writeByPath({ tenantId: TENANT, storeId: s.id, path: "/x", content: "v2", actor: ACTOR });

    const removed = await versionRepo.pruneOlderThan(0);
    expect(removed).toBe(0);
  });
});
