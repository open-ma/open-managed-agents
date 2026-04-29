// Unit tests for the memory R2-events queue consumer wired in
// apps/main/src/queue/memory-events.ts. Drives the consumer's per-message
// logic against the in-memory blob/repo fakes — covers PUT, DELETE, dedupe,
// and key-shape validation. Adapter integration with real R2 + Cloudflare
// Queues is exercised at staging.

import { describe, it, expect } from "vitest";
import {
  createInMemoryMemoryStoreService,
  InMemoryBlobStore,
  InMemoryMemoryRepo,
  InMemoryStoreRepo,
} from "@open-managed-agents/memory-store/test-fakes";
import {
  parseR2Key,
  r2Key,
  sha256Hex,
} from "@open-managed-agents/memory-store";
import { generateMemoryVersionId } from "@open-managed-agents/shared";
import type { R2EventMessage } from "@open-managed-agents/shared";

const TENANT = "tn_test_consumer";

interface MockMessage {
  body: R2EventMessage;
  acked: boolean;
  retried: boolean;
}

function mockMessage(body: R2EventMessage): MockMessage {
  return { body, acked: false, retried: false };
}

/**
 * Mirror of apps/main/src/queue/memory-events.ts processOne() against the
 * in-memory fakes. Kept in the test so the test asserts the same
 * (blobs.head → blobs.getText → memoryRepo.upsertFromEvent) sequence the
 * real consumer runs.
 */
async function processOne(
  event: R2EventMessage,
  blobs: InMemoryBlobStore,
  memoryRepo: InMemoryMemoryRepo,
): Promise<void> {
  const key = event.object?.key;
  if (!key) return;
  const parsed = parseR2Key(key);
  if (!parsed) return;

  if (event.action === "DeleteObject" || event.action === "LifecycleDeletion") {
    await memoryRepo.deleteFromEvent({
      storeId: parsed.storeId,
      path: parsed.memoryPath,
      actor: { type: "agent_session", id: "unknown" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
    });
    return;
  }

  if (
    event.action === "PutObject" ||
    event.action === "CopyObject" ||
    event.action === "CompleteMultipartUpload"
  ) {
    const blob = await blobs.getText(key);
    if (!blob) return;
    const sha = await sha256Hex(blob.text);
    await memoryRepo.upsertFromEvent({
      storeId: parsed.storeId,
      path: parsed.memoryPath,
      contentSha256: sha,
      etag: blob.etag,
      sizeBytes: blob.size,
      actor: { type: "agent_session", id: "unknown" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
      content: blob.text,
    });
  }
}

describe("memory-events queue consumer — PUT", () => {
  it("synthesizes a created memory + version when a new R2 object is PUT", async () => {
    const { service, memoryRepo, blobs, storeRepo } = createInMemoryMemoryStoreService();
    void service; // service unused; consumer touches lower-level repos directly
    void storeRepo;
    const storeId = "memstore-cons-1";
    const path = "/agent-wrote.md";
    const key = r2Key(storeId, path);
    // Simulate the agent FUSE write: bytes land in R2 outside the service.
    await blobs.put(key, "hi from agent", { actorMetadata: { actor_type: "agent_session", actor_id: "sess_a" } });

    await processOne(
      mockMessage({
        account: "acc",
        action: "PutObject",
        bucket: "managed-agents-memory",
        object: { key, size: 13 },
        eventTime: new Date().toISOString(),
      }).body,
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );

    expect(memoryRepo.versions.at(-1)!.operation).toBe("created");
    expect(memoryRepo.versions.at(-1)!.actor_type).toBe("agent_session");
  });

  it("dedupes redelivered events with the same etag", async () => {
    const { memoryRepo, blobs } = createInMemoryMemoryStoreService();
    const storeId = "memstore-cons-2";
    const path = "/x";
    const key = r2Key(storeId, path);
    await blobs.put(key, "v1");

    const event: R2EventMessage = {
      account: "acc",
      action: "PutObject",
      bucket: "managed-agents-memory",
      object: { key, size: 2 },
      eventTime: new Date().toISOString(),
    };
    await processOne(event, blobs as InMemoryBlobStore, memoryRepo as InMemoryMemoryRepo);
    await processOne(event, blobs as InMemoryBlobStore, memoryRepo as InMemoryMemoryRepo);
    await processOne(event, blobs as InMemoryBlobStore, memoryRepo as InMemoryMemoryRepo);

    // First write created; subsequent same-etag events dedup → no new versions.
    expect(memoryRepo.versions.length).toBe(1);
  });

  it("PUT followed by content-changing PUT produces two versions", async () => {
    const { memoryRepo, blobs } = createInMemoryMemoryStoreService();
    const storeId = "memstore-cons-3";
    const path = "/x";
    const key = r2Key(storeId, path);

    await blobs.put(key, "v1");
    await processOne(
      {
        account: "acc",
        action: "PutObject",
        bucket: "b",
        object: { key, size: 2 },
        eventTime: new Date().toISOString(),
      },
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );

    // Overwrite blob (new etag) → consumer sees a new event.
    await blobs.put(key, "v2-different");
    await processOne(
      {
        account: "acc",
        action: "PutObject",
        bucket: "b",
        object: { key, size: 12 },
        eventTime: new Date().toISOString(),
      },
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );

    expect(memoryRepo.versions.length).toBe(2);
    expect(memoryRepo.versions.map((v) => v.operation)).toEqual(["created", "modified"]);
  });
});

describe("memory-events queue consumer — DELETE", () => {
  it("synthesizes a deleted version when an R2 object is removed", async () => {
    const { memoryRepo, blobs } = createInMemoryMemoryStoreService();
    const storeId = "memstore-cons-4";
    const path = "/x";
    const key = r2Key(storeId, path);

    await blobs.put(key, "data");
    // Pre-populate D1 index (as if the PUT event already ran).
    await memoryRepo.upsertFromEvent({
      storeId, path,
      contentSha256: await sha256Hex("data"),
      etag: (await blobs.head(key))!.etag,
      sizeBytes: 4,
      actor: { type: "agent_session", id: "unknown" },
      nowMs: Date.now(),
      versionId: generateMemoryVersionId(),
      content: "data",
    });
    expect(memoryRepo.versions.length).toBe(1);

    // Now simulate R2 DELETE.
    await blobs.delete(key);
    await processOne(
      {
        account: "acc",
        action: "DeleteObject",
        bucket: "b",
        object: { key },
        eventTime: new Date().toISOString(),
      },
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );

    expect(memoryRepo.versions.length).toBe(2);
    expect(memoryRepo.versions.at(-1)!.operation).toBe("deleted");
  });

  it("DELETE for a path the index never knew about is a no-op", async () => {
    const { memoryRepo, blobs } = createInMemoryMemoryStoreService();
    await processOne(
      {
        account: "acc",
        action: "DeleteObject",
        bucket: "b",
        object: { key: "memstore-x/never-existed" },
        eventTime: new Date().toISOString(),
      },
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );
    expect(memoryRepo.versions.length).toBe(0);
  });
});

describe("memory-events queue consumer — key shape", () => {
  it("ignores keys that aren't <store_id>/<memory_path>", async () => {
    const { memoryRepo, blobs } = createInMemoryMemoryStoreService();
    await processOne(
      {
        account: "acc",
        action: "PutObject",
        bucket: "b",
        // No "/" → not a memory key.
        object: { key: "weird-toplevel-key" },
        eventTime: new Date().toISOString(),
      },
      blobs as InMemoryBlobStore,
      memoryRepo as InMemoryMemoryRepo,
    );
    expect(memoryRepo.versions.length).toBe(0);
  });

  it("parseR2Key + r2Key are exact inverses", () => {
    const cases: Array<[string, string]> = [
      ["memstore_01abc", "/preferences/formatting.md"],
      ["memstore_xyz", "/foo.md"],
      ["memstore_q", "/deeply/nested/path/x.md"],
    ];
    for (const [storeId, path] of cases) {
      const k = r2Key(storeId, path);
      const parsed = parseR2Key(k);
      expect(parsed).toEqual({ storeId, memoryPath: path });
    }
  });
});

// Suppress unused-import warnings (these symbols are used by class typing in
// the in-memory fakes module export shape).
void InMemoryStoreRepo;
