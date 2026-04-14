import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { MemoryStoreConfig, MemoryItem, MemoryVersion } from "@open-managed-agents/shared";
import { generateMemoryStoreId, generateMemoryId, generateMemoryVersionId } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env }>();

// --- Helpers ---

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createVersion(
  kv: KVNamespace,
  opts: {
    memoryId: string;
    storeId: string;
    operation: MemoryVersion["operation"];
    path: string;
    content?: string;
    content_sha256?: string;
    size_bytes?: number;
  }
): Promise<MemoryVersion> {
  const version: MemoryVersion = {
    id: generateMemoryVersionId(),
    memory_id: opts.memoryId,
    store_id: opts.storeId,
    operation: opts.operation,
    path: opts.path,
    content: opts.content,
    content_sha256: opts.content_sha256,
    size_bytes: opts.size_bytes,
    actor: { type: "api_key", id: "api" },
    created_at: new Date().toISOString(),
  };
  await kv.put(`memver:${opts.storeId}:${version.id}`, JSON.stringify(version));
  return version;
}

// POST /v1/memory_stores — create store
app.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
  }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const store: MemoryStoreConfig = {
    id: generateMemoryStoreId(),
    name: body.name,
    description: body.description,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`memstore:${store.id}`, JSON.stringify(store));
  return c.json(store, 201);
});

// GET /v1/memory_stores — list stores
app.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";

  const list = await c.env.CONFIG_KV.list({ prefix: "memstore:" });
  const stores = (
    await Promise.all(
      list.keys
        .filter((k) => !k.name.includes(":mem:"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? JSON.parse(data) : null;
        })
    )
  ).filter(Boolean);

  const filtered = includeArchived
    ? stores
    : stores.filter((s: MemoryStoreConfig) => !s.archived_at);

  filtered.sort((a: MemoryStoreConfig, b: MemoryStoreConfig) => {
    return b.created_at.localeCompare(a.created_at);
  });

  return c.json({ data: filtered });
});

// GET /v1/memory_stores/:id — get store
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`memstore:${id}`);
  if (!data) return c.json({ error: "Memory store not found" }, 404);
  return c.json(JSON.parse(data));
});

// POST /v1/memory_stores/:id/archive — archive store
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`memstore:${id}`);
  if (!data) return c.json({ error: "Memory store not found" }, 404);

  const store: MemoryStoreConfig = JSON.parse(data);
  store.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`memstore:${id}`, JSON.stringify(store));
  return c.json(store);
});

// DELETE /v1/memory_stores/:id — delete store + all its memories + versions
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`memstore:${id}`);
  if (!data) return c.json({ error: "Memory store not found" }, 404);

  // Delete all memories in this store
  const memList = await c.env.CONFIG_KV.list({ prefix: `mem:${id}:` });
  await Promise.all(memList.keys.map((k) => c.env.CONFIG_KV.delete(k.name)));

  // Delete all versions in this store
  const verList = await c.env.CONFIG_KV.list({ prefix: `memver:${id}:` });
  await Promise.all(verList.keys.map((k) => c.env.CONFIG_KV.delete(k.name)));

  // Delete the store itself
  await c.env.CONFIG_KV.delete(`memstore:${id}`);
  return c.json({ type: "memory_store_deleted", id });
});

// POST /v1/memory_stores/:id/memories — create/write memory
app.post("/:id/memories", async (c) => {
  const storeId = c.req.param("id");
  const storeData = await c.env.CONFIG_KV.get(`memstore:${storeId}`);
  if (!storeData) return c.json({ error: "Memory store not found" }, 404);

  const body = await c.req.json<{
    path: string;
    content: string;
    precondition?: { type: "not_exists" } | { type: "content_sha256"; content_sha256: string };
  }>();

  if (!body.path || body.content === undefined) {
    return c.json({ error: "path and content are required" }, 400);
  }

  // Reject content > 100KB
  const contentBytes = new TextEncoder().encode(body.content).length;
  if (contentBytes > 100 * 1024) {
    return c.json({ error: "content exceeds 100KB limit" }, 400);
  }

  // Handle preconditions
  if (body.precondition) {
    const list = await c.env.CONFIG_KV.list({ prefix: `mem:${storeId}:` });
    for (const k of list.keys) {
      const d = await c.env.CONFIG_KV.get(k.name);
      if (d) {
        const existing: MemoryItem = JSON.parse(d);
        if (existing.path === body.path) {
          if (body.precondition.type === "not_exists") {
            return c.json({ error: "memory_precondition_failed" }, 409);
          }
          if (body.precondition.type === "content_sha256" &&
              existing.content_sha256 !== body.precondition.content_sha256) {
            return c.json({ error: "memory_precondition_failed" }, 409);
          }
        }
      }
    }
  }

  const contentHash = await sha256(body.content);

  const mem: MemoryItem = {
    id: generateMemoryId(),
    store_id: storeId,
    path: body.path,
    content: body.content,
    content_sha256: contentHash,
    size_bytes: new TextEncoder().encode(body.content).length,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`mem:${storeId}:${mem.id}`, JSON.stringify(mem));

  // Create version record
  await createVersion(c.env.CONFIG_KV, {
    memoryId: mem.id,
    storeId,
    operation: "created",
    path: mem.path,
    content: mem.content,
    content_sha256: contentHash,
    size_bytes: mem.size_bytes,
  });

  // Generate embedding and upsert to Vectorize for semantic search
  if (c.env.AI && c.env.VECTORIZE) {
    try {
      const embedding = await c.env.AI.run("@cf/google/embedding-gemma" as any, {
        text: [body.content],
      }) as { data: number[][] };
      if (embedding.data?.[0]) {
        await c.env.VECTORIZE.upsert([{
          id: `${storeId}:${mem.id}`,
          values: embedding.data[0],
          metadata: { store_id: storeId, memory_id: mem.id, path: mem.path },
        }]);
      }
    } catch {
      // Best-effort: search falls back to substring if embedding fails
    }
  }

  return c.json(mem, 201);
});

// GET /v1/memory_stores/:id/memories — list memories (metadata only)
app.get("/:id/memories", async (c) => {
  const storeId = c.req.param("id");
  const storeData = await c.env.CONFIG_KV.get(`memstore:${storeId}`);
  if (!storeData) return c.json({ error: "Memory store not found" }, 404);

  const prefix = c.req.query("prefix");

  const list = await c.env.CONFIG_KV.list({ prefix: `mem:${storeId}:` });
  const memories = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        if (!data) return null;
        const mem: MemoryItem = JSON.parse(data);
        // Filter by path prefix if provided
        if (prefix && !mem.path.startsWith(prefix)) return null;
        // Return metadata only (no content)
        const { content: _, ...metadata } = mem;
        return metadata;
      })
    )
  ).filter(Boolean);

  return c.json({ data: memories });
});

// GET /v1/memory_stores/:id/memories/:mem_id — get full memory with content
app.get("/:id/memories/:mem_id", async (c) => {
  const storeId = c.req.param("id");
  const memId = c.req.param("mem_id");
  const data = await c.env.CONFIG_KV.get(`mem:${storeId}:${memId}`);
  if (!data) return c.json({ error: "Memory not found" }, 404);
  return c.json(JSON.parse(data));
});

// PATCH/POST /v1/memory_stores/:id/memories/:mem_id — update memory content/path
const updateMemory = async (c: any) => {
  const storeId = c.req.param("id");
  const memId = c.req.param("mem_id");
  const data = await c.env.CONFIG_KV.get(`mem:${storeId}:${memId}`);
  if (!data) return c.json({ error: "Memory not found" }, 404);

  const body = await c.req.json() as {
    path?: string;
    content?: string;
    precondition?: { type: "content_sha256"; content_sha256: string };
  };

  const mem: MemoryItem = JSON.parse(data);

  // Reject content > 100KB
  if (body.content !== undefined) {
    const contentBytes = new TextEncoder().encode(body.content).length;
    if (contentBytes > 100 * 1024) {
      return c.json({ error: "content exceeds 100KB limit" }, 400);
    }
  }

  // Handle content_sha256 precondition
  if (body.precondition?.type === "content_sha256") {
    if (mem.content_sha256 !== body.precondition.content_sha256) {
      return c.json({ error: "memory_precondition_failed" }, 409);
    }
  }

  if (body.path !== undefined) mem.path = body.path;
  if (body.content !== undefined) {
    mem.content = body.content;
    mem.content_sha256 = await sha256(body.content);
    mem.size_bytes = new TextEncoder().encode(body.content).length;
  }
  mem.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(`mem:${storeId}:${memId}`, JSON.stringify(mem));

  // Create version record
  await createVersion(c.env.CONFIG_KV, {
    memoryId: memId,
    storeId,
    operation: "modified",
    path: mem.path,
    content: mem.content,
    content_sha256: mem.content_sha256,
    size_bytes: mem.size_bytes,
  });

  return c.json(mem);
};
app.patch("/:id/memories/:mem_id", updateMemory);
app.post("/:id/memories/:mem_id", updateMemory);

// DELETE /v1/memory_stores/:id/memories/:mem_id — delete memory
// Supports conditional delete via ?expected_content_sha256=<hash>
app.delete("/:id/memories/:mem_id", async (c) => {
  const storeId = c.req.param("id");
  const memId = c.req.param("mem_id");
  const data = await c.env.CONFIG_KV.get(`mem:${storeId}:${memId}`);
  if (!data) return c.json({ error: "Memory not found" }, 404);

  const mem: MemoryItem = JSON.parse(data);

  // Conditional delete: only delete if content hash matches
  const expectedHash = c.req.query("expected_content_sha256");
  if (expectedHash && mem.content_sha256 !== expectedHash) {
    return c.json({ error: "memory_precondition_failed" }, 409);
  }

  // Create version record before deleting
  await createVersion(c.env.CONFIG_KV, {
    memoryId: memId,
    storeId,
    operation: "deleted",
    path: mem.path,
    content: mem.content,
    content_sha256: mem.content_sha256,
    size_bytes: mem.size_bytes,
  });

  await c.env.CONFIG_KV.delete(`mem:${storeId}:${memId}`);
  return c.json({ type: "memory_deleted", id: memId });
});

// ============================================================
// Memory Versions
// ============================================================

// GET /v1/memory_stores/:id/memory_versions — list versions
app.get("/:id/memory_versions", async (c) => {
  const storeId = c.req.param("id");
  const storeData = await c.env.CONFIG_KV.get(`memstore:${storeId}`);
  if (!storeData) return c.json({ error: "Memory store not found" }, 404);

  const memoryIdFilter = c.req.query("memory_id");

  const list = await c.env.CONFIG_KV.list({ prefix: `memver:${storeId}:` });
  const versions = (
    await Promise.all(
      list.keys.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        if (!data) return null;
        const ver: MemoryVersion = JSON.parse(data);
        // Filter by memory_id if provided
        if (memoryIdFilter && ver.memory_id !== memoryIdFilter) return null;
        // Return metadata only (no content)
        const { content: _, ...metadata } = ver;
        return metadata;
      })
    )
  ).filter(Boolean) as Omit<MemoryVersion, "content">[];

  // Sort newest first
  versions.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return c.json({ data: versions });
});

// GET /v1/memory_stores/:id/memory_versions/:ver_id — get version with full content
app.get("/:id/memory_versions/:ver_id", async (c) => {
  const storeId = c.req.param("id");
  const verId = c.req.param("ver_id");
  const data = await c.env.CONFIG_KV.get(`memver:${storeId}:${verId}`);
  if (!data) return c.json({ error: "Memory version not found" }, 404);
  return c.json(JSON.parse(data));
});

// POST /v1/memory_stores/:id/memory_versions/:ver_id/redact — redact version
app.post("/:id/memory_versions/:ver_id/redact", async (c) => {
  const storeId = c.req.param("id");
  const verId = c.req.param("ver_id");
  const data = await c.env.CONFIG_KV.get(`memver:${storeId}:${verId}`);
  if (!data) return c.json({ error: "Memory version not found" }, 404);

  const ver: MemoryVersion = JSON.parse(data);
  // Clear sensitive fields
  delete ver.content;
  delete ver.content_sha256;
  delete ver.size_bytes;
  delete (ver as any).path;
  ver.redacted = true;

  await c.env.CONFIG_KV.put(`memver:${storeId}:${verId}`, JSON.stringify(ver));
  return c.json(ver);
});

export default app;
