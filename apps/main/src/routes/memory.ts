import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  MemoryBlobStoreError,
  MemoryContentTooLargeError,
  MemoryNotFoundError,
  MemoryPreconditionFailedError,
  MemoryStoreNotFoundError,
  type Actor,
  type WritePrecondition,
} from "@open-managed-agents/memory-store";
import type { Services } from "@open-managed-agents/services";

// REST surface for memory stores. Aligned with Anthropic Managed Agents Memory
// (https://platform.claude.com/docs/en/managed-agents/memory). All persistence
// + R2 coordination lives in MemoryStoreService — this file only marshals
// HTTP↔service. Service surface comes from c.var.services (see packages/services).

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string; services: Services };
}>();

function actorFor(c: { get: (k: string) => unknown }): Actor {
  const userId = c.get("user_id") as string | undefined;
  return userId ? { type: "user", id: userId } : { type: "api_key", id: "api" };
}

/** Map service errors → HTTP status. */
function handle(err: unknown): Response {
  if (err instanceof MemoryStoreNotFoundError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof MemoryNotFoundError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof MemoryPreconditionFailedError) {
    return new Response(JSON.stringify({ error: err.code, detail: err.message }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  if (err instanceof MemoryContentTooLargeError) {
    return new Response(
      JSON.stringify({ error: `content exceeds 100KB limit (${err.limitBytes} bytes)` }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (err instanceof MemoryBlobStoreError) {
    console.error("memory_blob_store_error:", err.message, err.cause);
    return new Response(
      JSON.stringify({ error: err.code, detail: "blob store unavailable; try again" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  throw err;
}

// ============================================================
// Stores
// ============================================================

app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  try {
    const store = await c.var.services.memory.createStore({
      tenantId: t,
      name: body.name,
      description: body.description,
    });
    return c.json(toApiStore(store), 201);
  } catch (err) {
    return handle(err);
  }
});

app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const includeArchived = c.req.query("include_archived") === "true";
  const stores = await c.var.services.memory.listStores({ tenantId: t, includeArchived });
  return c.json({ data: stores.map(toApiStore) });
});

app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const store = await c.var.services.memory.getStore({ tenantId: t, storeId: c.req.param("id") });
  if (!store) return c.json({ error: "Memory store not found" }, 404);
  return c.json(toApiStore(store));
});

app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  try {
    const store = await c.var.services.memory.archiveStore({ tenantId: t, storeId: c.req.param("id") });
    return c.json(toApiStore(store));
  } catch (err) {
    return handle(err);
  }
});

app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  try {
    await c.var.services.memory.deleteStore({ tenantId: t, storeId: c.req.param("id") });
    return c.json({ type: "memory_store_deleted", id: c.req.param("id") });
  } catch (err) {
    return handle(err);
  }
});

// ============================================================
// Memories
// ============================================================

app.post("/:id/memories", async (c) => {
  const t = c.get("tenant_id");
  const storeId = c.req.param("id");
  const body = await c.req.json<{
    path?: string;
    content?: string;
    precondition?: WritePrecondition;
  }>();
  if (!body.path || body.content === undefined) {
    return c.json({ error: "path and content are required" }, 400);
  }
  try {
    const mem = await c.var.services.memory.writeByPath({
      tenantId: t,
      storeId,
      path: body.path,
      content: body.content,
      precondition: body.precondition,
      actor: actorFor(c),
    });
    return c.json(toApiMemory(mem), 201);
  } catch (err) {
    return handle(err);
  }
});

app.get("/:id/memories", async (c) => {
  const t = c.get("tenant_id");
  const storeId = c.req.param("id");
  const pathPrefix = c.req.query("path_prefix") ?? c.req.query("prefix");
  // `depth` is Anthropic-aligned: `depth=N` shows entries at most N path
  // segments below the prefix. Implemented client-side over the service's
  // flat list (cheap given typical store size). depth=undefined → return all.
  // Examples (prefix=/preferences/):
  //   depth=1 → /preferences/foo.md          ✓
  //             /preferences/colors/dark.md  ✗
  //   depth=2 → both ✓
  const depthRaw = c.req.query("depth");
  const depth = depthRaw ? Math.max(0, parseInt(depthRaw, 10)) : undefined;
  try {
    let memories = await c.var.services.memory.listMemories({ tenantId: t, storeId, pathPrefix });
    if (depth !== undefined && pathPrefix) {
      memories = memories.filter((m) => {
        if (!m.path.startsWith(pathPrefix)) return false;
        const remainder = m.path.slice(pathPrefix.length);
        const segments = remainder.split("/").filter(Boolean).length;
        return segments <= depth;
      });
    }
    // List does not include content (mirrors Anthropic semantics).
    return c.json({
      data: memories.map((m) => {
        const { content: _content, ...meta } = toApiMemory(m);
        return meta;
      }),
    });
  } catch (err) {
    return handle(err);
  }
});

app.get("/:id/memories/:mem_id", async (c) => {
  const t = c.get("tenant_id");
  try {
    const mem = await c.var.services.memory.readById({
      tenantId: t,
      storeId: c.req.param("id"),
      memoryId: c.req.param("mem_id"),
    });
    if (!mem) return c.json({ error: "Memory not found" }, 404);
    return c.json(toApiMemory(mem));
  } catch (err) {
    return handle(err);
  }
});

type UpdateMemoryBody = {
  path?: string;
  content?: string;
  precondition?: WritePrecondition;
};

const updateMemory = async (c: any) => {
  const t = c.get("tenant_id");
  const body: UpdateMemoryBody = await c.req.json();
  try {
    const mem = await c.var.services.memory.updateById({
      tenantId: t,
      storeId: c.req.param("id"),
      memoryId: c.req.param("mem_id"),
      path: body.path,
      content: body.content,
      precondition: body.precondition,
      actor: actorFor(c),
    });
    return c.json(toApiMemory(mem));
  } catch (err) {
    return handle(err);
  }
};
app.patch("/:id/memories/:mem_id", updateMemory);
app.post("/:id/memories/:mem_id", updateMemory);

app.delete("/:id/memories/:mem_id", async (c) => {
  const t = c.get("tenant_id");
  const expectedSha = c.req.query("expected_content_sha256") ?? undefined;
  try {
    await c.var.services.memory.deleteById({
      tenantId: t,
      storeId: c.req.param("id"),
      memoryId: c.req.param("mem_id"),
      expectedSha,
      actor: actorFor(c),
    });
    return c.json({ type: "memory_deleted", id: c.req.param("mem_id") });
  } catch (err) {
    return handle(err);
  }
});

// ============================================================
// Versions
// ============================================================

app.get("/:id/memory_versions", async (c) => {
  const t = c.get("tenant_id");
  const memoryId = c.req.query("memory_id") ?? undefined;
  try {
    const versions = await c.var.services.memory.listVersions({
      tenantId: t,
      storeId: c.req.param("id"),
      memoryId,
    });
    // List omits content body to match prior behavior.
    return c.json({
      data: versions.map((v) => {
        const { content: _content, ...rest } = toApiVersion(v);
        return rest;
      }),
    });
  } catch (err) {
    return handle(err);
  }
});

app.get("/:id/memory_versions/:ver_id", async (c) => {
  const t = c.get("tenant_id");
  try {
    const v = await c.var.services.memory.getVersion({
      tenantId: t,
      storeId: c.req.param("id"),
      versionId: c.req.param("ver_id"),
    });
    if (!v) return c.json({ error: "Memory version not found" }, 404);
    return c.json(toApiVersion(v));
  } catch (err) {
    return handle(err);
  }
});

app.post("/:id/memory_versions/:ver_id/redact", async (c) => {
  const t = c.get("tenant_id");
  try {
    const v = await c.var.services.memory.redactVersion({
      tenantId: t,
      storeId: c.req.param("id"),
      versionId: c.req.param("ver_id"),
    });
    return c.json(toApiVersion(v));
  } catch (err) {
    return handle(err);
  }
});

/** Shape returned to clients — Anthropic-aligned. */
function toApiStore(s: import("@open-managed-agents/memory-store").MemoryStoreRow) {
  return {
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    created_at: s.created_at,
    updated_at: s.updated_at ?? undefined,
    archived_at: s.archived_at ?? undefined,
  };
}

function toApiMemory(m: import("@open-managed-agents/memory-store").MemoryRow) {
  return {
    id: m.id,
    store_id: m.store_id,
    path: m.path,
    content: m.content,
    content_sha256: m.content_sha256,
    etag: m.etag,
    size_bytes: m.size_bytes,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/** Re-nest actor_type/actor_id back into Anthropic's `actor: {type, id}` shape. */
function toApiVersion(v: import("@open-managed-agents/memory-store").MemoryVersionRow) {
  return {
    id: v.id,
    memory_id: v.memory_id,
    store_id: v.store_id,
    operation: v.operation,
    path: v.path ?? undefined,
    content: v.content ?? undefined,
    content_sha256: v.content_sha256 ?? undefined,
    size_bytes: v.size_bytes ?? undefined,
    actor: { type: v.actor_type, id: v.actor_id },
    created_at: v.created_at,
    redacted: v.redacted || undefined,
  };
}

export default app;
