// Unit tests for FileService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: tenant isolation, scope derivation
// (sessionId presence → session vs tenant scope), list with/without session
// filter, cursor pagination (beforeId / afterId), ordering (desc default),
// limit clamping, delete returns r2_key, deleteBySession cascade,
// toFileRecord API shape mapping.
//
// NOTE: imports use relative paths because vitest.config.ts has not yet been
// updated with the @open-managed-agents/files-store alias (that's done at
// integration time per packages/files-store/INTEGRATION_GUIDE.md). After the
// alias lands, these can be swapped to the package import.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIST_LIMIT,
  FileNotFoundError,
  MAX_LIST_LIMIT,
  toFileRecord,
} from "../../packages/files-store/src/index";
import {
  ManualClock,
  createInMemoryFileService,
} from "../../packages/files-store/src/test-fakes";

const TENANT = "tn_test_files";
const SESSION = "sess-test-1";

function r2KeyFor(tenantId: string, fileId: string): string {
  return `t/${tenantId}/files/${fileId}`;
}

describe("FileService — create + read", () => {
  it("creates a file and reads it back", async () => {
    const { service } = createInMemoryFileService();
    const file = await service.create({
      id: "file-1",
      tenantId: TENANT,
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1024,
      r2Key: r2KeyFor(TENANT, "file-1"),
    });
    expect(file.id).toBe("file-1");
    expect(file.tenant_id).toBe(TENANT);
    expect(file.filename).toBe("report.pdf");
    expect(file.media_type).toBe("application/pdf");
    expect(file.size_bytes).toBe(1024);
    expect(file.downloadable).toBe(false);
    expect(file.scope).toBe("tenant");
    expect(file.session_id).toBeNull();
    expect(file.r2_key).toBe(r2KeyFor(TENANT, "file-1"));

    const got = await service.get({ tenantId: TENANT, fileId: "file-1" });
    expect(got?.id).toBe("file-1");
    expect(got?.filename).toBe("report.pdf");
  });

  it("isolates files by tenant", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-1",
      tenantId: "tn_a",
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor("tn_a", "file-1"),
    });
    expect(await service.get({ tenantId: "tn_a", fileId: "file-1" })).not.toBeNull();
    expect(await service.get({ tenantId: "tn_b", fileId: "file-1" })).toBeNull();
  });

  it("returns null when reading a file that doesn't exist", async () => {
    const { service } = createInMemoryFileService();
    expect(await service.get({ tenantId: TENANT, fileId: "missing" })).toBeNull();
  });

  it("preserves downloadable=true when explicitly set", async () => {
    const { service } = createInMemoryFileService();
    const file = await service.create({
      id: "file-dl",
      tenantId: TENANT,
      filename: "report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 99,
      r2Key: r2KeyFor(TENANT, "file-dl"),
      downloadable: true,
    });
    expect(file.downloadable).toBe(true);
    const got = await service.get({ tenantId: TENANT, fileId: "file-dl" });
    expect(got?.downloadable).toBe(true);
  });
});

describe("FileService — scope semantics", () => {
  it("scopes file to session when sessionId is provided", async () => {
    const { service } = createInMemoryFileService();
    const file = await service.create({
      id: "file-s",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "session-doc.txt",
      mediaType: "text/plain",
      sizeBytes: 7,
      r2Key: r2KeyFor(TENANT, "file-s"),
    });
    expect(file.scope).toBe("session");
    expect(file.session_id).toBe(SESSION);
  });

  it("scopes file to tenant when sessionId is omitted", async () => {
    const { service } = createInMemoryFileService();
    const file = await service.create({
      id: "file-t",
      tenantId: TENANT,
      filename: "tenant-doc.txt",
      mediaType: "text/plain",
      sizeBytes: 7,
      r2Key: r2KeyFor(TENANT, "file-t"),
    });
    expect(file.scope).toBe("tenant");
    expect(file.session_id).toBeNull();
  });

  it("scopes file to tenant when sessionId is explicitly null", async () => {
    const { service } = createInMemoryFileService();
    const file = await service.create({
      id: "file-tn",
      tenantId: TENANT,
      sessionId: null,
      filename: "tenant-doc.txt",
      mediaType: "text/plain",
      sizeBytes: 7,
      r2Key: r2KeyFor(TENANT, "file-tn"),
    });
    expect(file.scope).toBe("tenant");
    expect(file.session_id).toBeNull();
  });
});

describe("FileService — list", () => {
  it("returns all tenant files when no session filter is given", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-1",
      tenantId: TENANT,
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-1"),
    });
    await service.create({
      id: "file-2",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "b.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-2"),
    });
    const all = await service.list({ tenantId: TENANT });
    expect(all.map((f) => f.id).sort()).toEqual(["file-1", "file-2"]);
  });

  it("filters by sessionId — single indexed WHERE session_id query path", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-tenant",
      tenantId: TENANT,
      filename: "t.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-tenant"),
    });
    await service.create({
      id: "file-s1-a",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s1-a"),
    });
    await service.create({
      id: "file-s1-b",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "b.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s1-b"),
    });
    await service.create({
      id: "file-s2",
      tenantId: TENANT,
      sessionId: "sess-other",
      filename: "c.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s2"),
    });
    const sessionFiles = await service.list({ tenantId: TENANT, sessionId: SESSION });
    expect(sessionFiles.map((f) => f.id).sort()).toEqual(["file-s1-a", "file-s1-b"]);
    // Cross-session isolation
    const otherFiles = await service.list({ tenantId: TENANT, sessionId: "sess-other" });
    expect(otherFiles.map((f) => f.id)).toEqual(["file-s2"]);
  });

  it("isolates list by tenant", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-1",
      tenantId: "tn_a",
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor("tn_a", "file-1"),
    });
    expect((await service.list({ tenantId: "tn_a" })).length).toBe(1);
    expect((await service.list({ tenantId: "tn_b" })).length).toBe(0);
  });

  it("orders by created_at desc by default and asc on request", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryFileService({ clock });
    await service.create({
      id: "file-old",
      tenantId: TENANT,
      filename: "old.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-old"),
    });
    clock.set(2000);
    await service.create({
      id: "file-mid",
      tenantId: TENANT,
      filename: "mid.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-mid"),
    });
    clock.set(3000);
    await service.create({
      id: "file-new",
      tenantId: TENANT,
      filename: "new.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-new"),
    });

    const desc = await service.list({ tenantId: TENANT });
    expect(desc.map((f) => f.id)).toEqual(["file-new", "file-mid", "file-old"]);

    const asc = await service.list({ tenantId: TENANT, order: "asc" });
    expect(asc.map((f) => f.id)).toEqual(["file-old", "file-mid", "file-new"]);
  });

  it("respects limit and clamps to MAX_LIST_LIMIT", async () => {
    const { service } = createInMemoryFileService();
    for (let i = 0; i < 5; i++) {
      await service.create({
        id: `file-${i}`,
        tenantId: TENANT,
        filename: `${i}.txt`,
        mediaType: "text/plain",
        sizeBytes: 1,
        r2Key: r2KeyFor(TENANT, `file-${i}`),
      });
    }
    expect((await service.list({ tenantId: TENANT, limit: 3 })).length).toBe(3);
    // Bogus limits fall back to default
    expect((await service.list({ tenantId: TENANT, limit: 0 })).length).toBe(5);
    expect((await service.list({ tenantId: TENANT, limit: -1 })).length).toBe(5);
    // Limit > MAX gets clamped (functionally same as 5 since we have only 5)
    expect((await service.list({ tenantId: TENANT, limit: MAX_LIST_LIMIT + 999 })).length).toBe(5);
    // Default limit is honored when omitted
    expect(DEFAULT_LIST_LIMIT).toBeGreaterThan(5);
  });

  it("supports beforeId and afterId cursor pagination", async () => {
    const { service } = createInMemoryFileService();
    // Lexicographic ids so cursor comparison is well-defined
    for (const id of ["file-a", "file-b", "file-c", "file-d", "file-e"]) {
      await service.create({
        id,
        tenantId: TENANT,
        filename: `${id}.txt`,
        mediaType: "text/plain",
        sizeBytes: 1,
        r2Key: r2KeyFor(TENANT, id),
      });
    }
    const before = await service.list({ tenantId: TENANT, beforeId: "file-c", order: "asc" });
    expect(before.map((f) => f.id)).toEqual(["file-a", "file-b"]);

    const after = await service.list({ tenantId: TENANT, afterId: "file-c", order: "asc" });
    expect(after.map((f) => f.id)).toEqual(["file-d", "file-e"]);
  });
});

describe("FileService — delete", () => {
  it("delete returns the deleted row including r2_key for R2 cleanup", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-x",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "x.pdf",
      mediaType: "application/pdf",
      sizeBytes: 42,
      r2Key: r2KeyFor(TENANT, "file-x"),
    });
    const deleted = await service.delete({ tenantId: TENANT, fileId: "file-x" });
    expect(deleted.id).toBe("file-x");
    expect(deleted.r2_key).toBe(r2KeyFor(TENANT, "file-x"));
    expect(deleted.session_id).toBe(SESSION);
    // Row is gone
    expect(await service.get({ tenantId: TENANT, fileId: "file-x" })).toBeNull();
  });

  it("delete throws FileNotFoundError when the row doesn't exist", async () => {
    const { service } = createInMemoryFileService();
    await expect(
      service.delete({ tenantId: TENANT, fileId: "missing" }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("delete is tenant-scoped — cross-tenant delete is a no-op", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-1",
      tenantId: "tn_a",
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor("tn_a", "file-1"),
    });
    await expect(
      service.delete({ tenantId: "tn_b", fileId: "file-1" }),
    ).rejects.toBeInstanceOf(FileNotFoundError);
    // Original tenant still sees it
    expect(await service.get({ tenantId: "tn_a", fileId: "file-1" })).not.toBeNull();
  });
});

describe("FileService — deleteBySession cascade", () => {
  it("removes all files for a session and returns the deleted rows", async () => {
    const { service } = createInMemoryFileService();
    await service.create({
      id: "file-tenant",
      tenantId: TENANT,
      filename: "t.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-tenant"),
    });
    await service.create({
      id: "file-s1-a",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s1-a"),
    });
    await service.create({
      id: "file-s1-b",
      tenantId: TENANT,
      sessionId: SESSION,
      filename: "b.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s1-b"),
    });
    await service.create({
      id: "file-s2",
      tenantId: TENANT,
      sessionId: "sess-other",
      filename: "c.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      r2Key: r2KeyFor(TENANT, "file-s2"),
    });

    const deleted = await service.deleteBySession({ sessionId: SESSION });
    expect(deleted.map((f) => f.id).sort()).toEqual(["file-s1-a", "file-s1-b"]);
    // Each row has the r2_key the caller needs for R2 cleanup
    expect(deleted.every((d) => d.r2_key.startsWith(`t/${TENANT}/files/`))).toBe(true);

    // Tenant file untouched
    expect(await service.get({ tenantId: TENANT, fileId: "file-tenant" })).not.toBeNull();
    // Other session untouched
    expect(await service.get({ tenantId: TENANT, fileId: "file-s2" })).not.toBeNull();
    // Cascade-deleted files gone
    expect(await service.get({ tenantId: TENANT, fileId: "file-s1-a" })).toBeNull();
    expect(await service.get({ tenantId: TENANT, fileId: "file-s1-b" })).toBeNull();
  });

  it("returns an empty array when no files belong to the session", async () => {
    const { service } = createInMemoryFileService();
    expect(await service.deleteBySession({ sessionId: "sess-empty" })).toEqual([]);
  });
});

describe("toFileRecord — public API shape mapping", () => {
  it("maps a FileRow with session scope to FileRecord with scope_id set", () => {
    const record = toFileRecord({
      id: "file-1",
      tenant_id: TENANT,
      session_id: SESSION,
      scope: "session",
      filename: "report.pdf",
      media_type: "application/pdf",
      size_bytes: 1024,
      downloadable: true,
      r2_key: r2KeyFor(TENANT, "file-1"),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(record).toEqual({
      id: "file-1",
      type: "file",
      filename: "report.pdf",
      media_type: "application/pdf",
      size_bytes: 1024,
      scope_id: SESSION,
      downloadable: true,
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("maps a FileRow with tenant scope to FileRecord with scope_id undefined", () => {
    const record = toFileRecord({
      id: "file-1",
      tenant_id: TENANT,
      session_id: null,
      scope: "tenant",
      filename: "report.pdf",
      media_type: "application/pdf",
      size_bytes: 1024,
      downloadable: false,
      r2_key: r2KeyFor(TENANT, "file-1"),
      created_at: "2026-01-01T00:00:00.000Z",
    });
    expect(record.scope_id).toBeUndefined();
    expect(record.downloadable).toBe(false);
    // r2_key + scope + tenant_id are server-internal — never in API
    expect(record).not.toHaveProperty("r2_key");
    expect(record).not.toHaveProperty("scope");
    expect(record).not.toHaveProperty("tenant_id");
  });
});
