import { describe, expect, it, vi } from "vitest";
import type {
  SessionMemoryAccessPort,
  SessionMemoryDocument,
} from "@open-managed-agents/runtime-resource-contract";

import {
  SessionMemoryWorkspaceLifecycle,
  type SessionMemoryWorkspaceFilePort,
} from "../src/session-memory-workspace";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};
const fence = {
  ...scope,
  ownerId: "owner_1",
  generation: 7,
  token: "secret",
  expiresAt: "2026-09-10T12:00:00.000Z",
};

async function digest(content: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class MemoryFiles implements SessionMemoryWorkspaceFilePort {
  readonly files = new Map<string, string>();

  async scan(root: string) {
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    const entries = [...this.files]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => [path.slice(prefix.length), content] as const);
    return entries.length === 0 ? null : new Map(entries);
  }

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, content: string) {
    this.files.set(path, content);
  }

  async replace(root: string, entries: ReadonlyMap<string, string>) {
    const prefix = `${root.replace(/\/+$/u, "")}/`;
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(prefix)) this.files.delete(path);
    }
    for (const [path, content] of entries) this.files.set(`${prefix}${path}`, content);
  }
}

async function memoryAccess(initial: Record<string, string>) {
  let sequence = 0;
  const remote = new Map<string, SessionMemoryDocument>();
  for (const [path, content] of Object.entries(initial)) {
    sequence += 1;
    remote.set(path, {
      id: `mem_${sequence}`,
      path,
      content,
      contentSha256: await digest(content),
    });
  }
  const list = vi.fn(async ({ projection }: { projection: "basic" | "full" }) =>
    [...remote.values()].map((item) => projection === "full"
      ? { ...item }
      : { id: item.id, path: item.path, contentSha256: item.contentSha256 }));
  const create = vi.fn(async (input: {
    path: string;
    content: string;
  }) => {
    if (remote.has(input.path)) return { type: "conflict" as const };
    sequence += 1;
    const memory = {
      id: `mem_${sequence}`,
      path: input.path,
      content: input.content,
      contentSha256: await digest(input.content),
    };
    remote.set(input.path, memory);
    return { type: "applied" as const, memory };
  });
  const update = vi.fn(async (input: {
    memoryId: string;
    path: string;
    content: string;
    expectedContentSha256: string;
  }) => {
    const current = [...remote.values()].find(({ id }) => id === input.memoryId);
    if (current === undefined) return { type: "not_found" as const };
    if (current.contentSha256 !== input.expectedContentSha256) {
      return { type: "conflict" as const };
    }
    remote.delete(current.path);
    const memory = {
      ...current,
      path: input.path,
      content: input.content,
      contentSha256: await digest(input.content),
    };
    remote.set(input.path, memory);
    return { type: "applied" as const, memory };
  });
  const remove = vi.fn(async (input: {
    memoryId: string;
    expectedContentSha256: string;
  }) => {
    const current = [...remote.values()].find(({ id }) => id === input.memoryId);
    if (current === undefined) return { type: "not_found" as const };
    if (current.contentSha256 !== input.expectedContentSha256) {
      return { type: "conflict" as const };
    }
    remote.delete(current.path);
    return { type: "applied" as const };
  });
  return {
    port: { list, create, update, delete: remove } satisfies SessionMemoryAccessPort,
    remote,
    list,
    create,
    update,
    remove,
  };
}

function input(access: SessionMemoryAccessPort, authorize = vi.fn(async () => true)) {
  const signal = new AbortController().signal;
  return {
    scope,
    fence,
    session: {
      id: scope.sessionId,
      environmentId: scope.environmentId,
      metadata: {},
      resources: [{
        type: "memory_store",
        memory_store_id: "memstore_1",
        mount_path: "/workspace/memory",
        access: "read_write",
      }],
    },
    sandbox: { provider: "fake", runtimeId: "runtime_1" },
    resourceOwnership: { memoryStore: "materializer" as const },
    access: { downloadFile: vi.fn(), memories: access },
    authorize,
    signal,
  };
}

describe("SessionMemoryWorkspaceLifecycle", () => {
  it("does nothing without Memory resources and requires claim-scoped access when present", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({});
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const noMemory = input(canonical.port);
    noMemory.session.resources = [];

    await expect(lifecycle.materialize(noMemory)).resolves.toBeUndefined();
    await expect(lifecycle.synchronize(noMemory)).resolves.toBeUndefined();
    expect(canonical.list).not.toHaveBeenCalled();

    const noAccess = input(canonical.port);
    noAccess.access = { downloadFile: vi.fn() } as typeof noAccess.access;
    await expect(lifecycle.materialize(noAccess)).rejects.toThrow(/per-claim Memory access/u);
    await expect(lifecycle.synchronize(noAccess)).rejects.toThrow(/per-claim Memory access/u);

    const workerOwned = input(canonical.port);
    (workerOwned.resourceOwnership as { memoryStore: "worker" | "materializer" }).memoryStore = "worker";
    await expect(lifecycle.synchronize(workerOwned)).resolves.toBeUndefined();
    expect(canonical.list).not.toHaveBeenCalled();
  });

  it("reconciles an edit left in a durable workspace before rematerializing", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);
    files.files.set("/workspace/memory/notes.md", "recovered edit");

    await lifecycle.materialize(context);

    expect(canonical.update).toHaveBeenCalledOnce();
    expect(canonical.remote.get("/notes.md")?.content).toBe("recovered edit");
  });

  it("hydrates a private baseline then reconciles create, update, delete, and rename", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({
      "/delete.md": "delete me",
      "/rename.md": "rename me",
      "/update.md": "before",
    });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const authorize = vi.fn(async () => true);
    const context = input(canonical.port, authorize);

    await lifecycle.materialize(context);
    expect(files.files.get("/workspace/memory/update.md")).toBe("before");
    expect([...files.files.keys()]).toContain(
      "/workspace/.openma/session-inputs/session_1/memory/memstore_1.json",
    );

    files.files.delete("/workspace/memory/delete.md");
    files.files.delete("/workspace/memory/rename.md");
    files.files.set("/workspace/memory/renamed.md", "rename me");
    files.files.set("/workspace/memory/update.md", "after");
    files.files.set("/workspace/memory/create.md", "created");

    await lifecycle.synchronize(context);

    expect([...canonical.remote].map(([path, item]) => [path, item.content]))
      .toEqual([
        ["/create.md", "created"],
        ["/renamed.md", "rename me"],
        ["/update.md", "after"],
      ]);
    expect(canonical.create).toHaveBeenCalledTimes(2);
    expect(canonical.update).toHaveBeenCalledOnce();
    expect(canonical.remove).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledTimes(5);
  });

  it("takes the canonical winner on a two-sided conflict", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);

    files.files.set("/workspace/memory/notes.md", "local");
    const remote = canonical.remote.get("/notes.md")!;
    canonical.remote.set("/notes.md", {
      ...remote,
      content: "remote",
      contentSha256: await digest("remote"),
    });
    await lifecycle.synchronize(context);

    expect(canonical.update).not.toHaveBeenCalled();
    expect(files.files.get("/workspace/memory/notes.md")).toBe("remote");
  });

  it("honors a canonical deletion unless the local file changed", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);

    canonical.remote.delete("/notes.md");
    await lifecycle.synchronize(context);
    expect(files.files.has("/workspace/memory/notes.md")).toBe(false);
    expect(canonical.create).not.toHaveBeenCalled();

    canonical.remote.set("/notes.md", {
      id: "mem_recreated",
      path: "/notes.md",
      content: "base",
      contentSha256: await digest("base"),
    });
    await lifecycle.materialize(context);
    canonical.remote.delete("/notes.md");
    files.files.set("/workspace/memory/notes.md", "local edit");
    await lifecycle.synchronize(context);

    expect(canonical.create).toHaveBeenCalledOnce();
    expect(canonical.remote.get("/notes.md")?.content).toBe("local edit");
  });

  it("fails closed before any canonical mutation when the resource fence is stale", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const authorize = vi.fn(async () => false);
    const context = input(canonical.port, authorize);
    await lifecycle.materialize({ ...context, authorize: vi.fn(async () => true) });
    files.files.set("/workspace/memory/notes.md", "local");

    await expect(lifecycle.synchronize(context)).rejects.toThrow(/fence lost/u);
    expect(canonical.update).not.toHaveBeenCalled();
    expect(canonical.create).not.toHaveBeenCalled();
    expect(canonical.remove).not.toHaveBeenCalled();
  });

  it("rehydrates a missing marker instead of interpreting a wiped folder as deletes", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({
      "/a.md": "a",
      "/b.md": "b",
    });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);
    for (const path of [...files.files.keys()]) {
      if (path.startsWith("/workspace/memory/")) files.files.delete(path);
    }

    await lifecycle.synchronize(context);

    expect(canonical.remove).not.toHaveBeenCalled();
    expect(files.files.get("/workspace/memory/a.md")).toBe("a");
    expect(files.files.get("/workspace/memory/b.md")).toBe("b");
  });

  it("stops destructive reconciliation when the marker changes after the scan", async () => {
    class MarkerRaceFiles extends MemoryFiles {
      corruptMarkerRead = false;
      override async read(path: string) {
        if (this.corruptMarkerRead && path.endsWith("/.openma-memory-store")) return "replaced";
        return super.read(path);
      }
    }
    const files = new MarkerRaceFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);
    files.files.delete("/workspace/memory/notes.md");
    files.corruptMarkerRead = true;

    await expect(lifecycle.synchronize(context)).rejects.toThrow(/marker changed/u);
    expect(canonical.remove).not.toHaveBeenCalled();
  });

  it("refuses an accidental bulk deletion beyond the safety limit", async () => {
    const files = new MemoryFiles();
    const initial = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`/note-${index}.md`, `note ${index}`]),
    );
    const canonical = await memoryAccess(initial);
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);
    for (const path of [...files.files.keys()]) {
      if (path.startsWith("/workspace/memory/") && !path.endsWith("/.openma-memory-store")) {
        files.files.delete(path);
      }
    }

    await expect(lifecycle.synchronize(context)).rejects.toThrow(/safety limit exceeded/u);
    expect(canonical.remove).not.toHaveBeenCalled();
  });

  it("pulls over local edits for a read-only attachment without issuing mutations", async () => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "canonical" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    context.session.resources = [{
      type: "memory_store",
      memory_store_id: "memstore_1",
      mount_path: "/workspace/memory",
      access: "read_only",
    }];
    await lifecycle.materialize(context);
    files.files.set("/workspace/memory/notes.md", "local edit");

    await lifecycle.synchronize(context);

    expect(files.files.get("/workspace/memory/notes.md")).toBe("canonical");
    expect(canonical.create).not.toHaveBeenCalled();
    expect(canonical.update).not.toHaveBeenCalled();
    expect(canonical.remove).not.toHaveBeenCalled();
  });

  it("retries idempotently after a canonical update succeeds but local rebase crashes", async () => {
    class CrashOnceFiles extends MemoryFiles {
      crashNextReplace = false;
      override async replace(root: string, entries: ReadonlyMap<string, string>) {
        if (this.crashNextReplace) {
          this.crashNextReplace = false;
          throw new Error("injected rebase crash");
        }
        await super.replace(root, entries);
      }
    }
    const files = new CrashOnceFiles();
    const canonical = await memoryAccess({ "/notes.md": "base" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    await lifecycle.materialize(context);
    files.files.set("/workspace/memory/notes.md", "local");
    files.crashNextReplace = true;

    await expect(lifecycle.synchronize(context)).rejects.toThrow("injected rebase crash");
    await expect(lifecycle.synchronize(context)).resolves.toBeUndefined();

    expect(canonical.update).toHaveBeenCalledOnce();
    expect(files.files.get("/workspace/memory/notes.md")).toBe("local");
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ version: 2, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [] }),
    JSON.stringify({ version: 1, memoryStoreId: "wrong", mountPath: "/workspace/memory", baseline: [] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/wrong", baseline: [] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: null }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [null] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [{ id: 1, path: "/a", sha256: "x" }] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [{ id: "1", path: 1, sha256: "x" }] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [{ id: "1", path: "/a", sha256: 1 }] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [{ id: "1", path: "../a", sha256: "x" }] }),
    JSON.stringify({ version: 1, memoryStoreId: "memstore_1", mountPath: "/workspace/memory", baseline: [
      { id: "1", path: "/a", sha256: "x" },
      { id: "2", path: "/a", sha256: "y" },
    ] }),
  ])("recovers a corrupt private manifest from canonical state %#", async (manifest) => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({ "/notes.md": "canonical" });
    const lifecycle = new SessionMemoryWorkspaceLifecycle(files);
    const context = input(canonical.port);
    files.files.set(
      "/workspace/.openma/session-inputs/session_1/memory/memstore_1.json",
      manifest,
    );
    files.files.set(
      "/workspace/memory/.openma-memory-store",
      "openma-memory-store-v1\nmemstore_1",
    );
    files.files.set("/workspace/memory/stale.md", "stale");

    await expect(lifecycle.synchronize(context)).resolves.toBeUndefined();
    expect(files.files.get("/workspace/memory/notes.md")).toBe("canonical");
    expect(files.files.has("/workspace/memory/stale.md")).toBe(false);
  });

  it.each([
    [{ type: "memory_store", mount_path: "/workspace/memory" }, /memory_store_id/u],
    [{ type: "memory_store", memory_store_id: "memstore_1" }, /mount_path/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "/" }, /dedicated safe/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "/workspace" }, /dedicated safe/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "relative" }, /dedicated safe/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "/workspace/../escape" }, /dedicated safe/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "/workspace/memory\0bad" }, /dedicated safe/u],
    [{ type: "memory_store", memory_store_id: "memstore_1", mount_path: "/workspace/.openma" }, /dedicated safe/u],
  ])("rejects an invalid Memory resource %#", async (resource, expected) => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({});
    const context = input(canonical.port);
    context.session.resources = [resource as any];

    await expect(new SessionMemoryWorkspaceLifecycle(files).materialize(context))
      .rejects.toThrow(expected);
  });

  it.each(["", ".", "..", "bad\0id"])(
    "rejects unsafe Session identities %#",
    async (sessionId) => {
      const files = new MemoryFiles();
      const canonical = await memoryAccess({});
      const context = input(canonical.port);
      context.session.id = sessionId;

      await expect(new SessionMemoryWorkspaceLifecycle(files).materialize(context))
        .rejects.toThrow(/identity is unsafe/u);
    },
  );

  it.each([
    [[{ id: "1", path: "relative", content: "x", contentSha256: "x" }], /path .* unsafe/u],
    [[{ id: "1", path: "/", content: "x", contentSha256: "x" }], /path .* unsafe/u],
    [[{ id: "1", path: "/a/../b", content: "x", contentSha256: "x" }], /path .* unsafe/u],
    [[{ id: "1", path: "/a", contentSha256: "x" }], /omitted full content/u],
    [[
      { id: "1", path: "/a", content: "x", contentSha256: "x" },
      { id: "2", path: "/a", content: "y", contentSha256: "y" },
    ], /duplicate path/u],
    [[{
      id: "1",
      path: "/.openma-memory-store",
      content: "x",
      contentSha256: "x",
    }], /reserved/u],
  ])("rejects an invalid canonical full projection %#", async (documents, expected) => {
    const files = new MemoryFiles();
    const canonical = await memoryAccess({});
    canonical.list.mockResolvedValue(documents as SessionMemoryDocument[]);

    await expect(new SessionMemoryWorkspaceLifecycle(files).materialize(input(canonical.port)))
      .rejects.toThrow(expected);
  });
});
