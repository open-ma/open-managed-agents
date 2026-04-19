import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { FileRecord } from "@open-managed-agents/shared";
import { generateFileId, fileR2Key } from "@open-managed-agents/shared";
import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

function ensureBucket(c: { env: Env }): R2Bucket | null {
  return c.env.FILES_BUCKET || null;
}

// POST /v1/files — upload file (multipart form or JSON body)
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  let filename: string;
  let mediaType: string;
  let body: ArrayBuffer;
  let scopeId: string | undefined;
  let downloadable = false;

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field is required in multipart upload" }, 400);
    }
    filename = file.name;
    mediaType = file.type || "application/octet-stream";
    body = await file.arrayBuffer();
    const sc = formData.get("scope_id");
    if (typeof sc === "string") scopeId = sc;
    const d = formData.get("downloadable");
    if (typeof d === "string") downloadable = d === "true" || d === "1";
  } else {
    // JSON body upload — content is base64-encoded for binary, raw text for text/*
    const json = await c.req.json<{
      filename: string;
      content: string;
      media_type?: string;
      scope_id?: string;
      encoding?: "base64" | "utf8";
      downloadable?: boolean;
    }>();

    if (!json.filename || json.content === undefined || json.content === null) {
      return c.json({ error: "filename and content are required" }, 400);
    }
    filename = json.filename;
    mediaType = json.media_type || "application/octet-stream";
    scopeId = json.scope_id;
    downloadable = json.downloadable === true;

    const encoding = json.encoding || (mediaType.startsWith("text/") ? "utf8" : "base64");
    if (encoding === "base64") {
      const bin = atob(json.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes.buffer;
    } else {
      body = new TextEncoder().encode(json.content).buffer as ArrayBuffer;
    }
  }

  const id = generateFileId();
  await bucket.put(fileR2Key(t, id), body, { httpMetadata: { contentType: mediaType } });

  const record: FileRecord = {
    id,
    type: "file" as const,
    filename,
    media_type: mediaType,
    size_bytes: body.byteLength,
    scope_id: scopeId,
    downloadable,
    created_at: new Date().toISOString(),
  };
  await c.env.CONFIG_KV.put(kvKey(t, "file", id), JSON.stringify(record));
  // Maintain a scope index for cheap server-side filtering on list.
  if (scopeId) {
    await c.env.CONFIG_KV.put(kvKey(t, "filebyscope", scopeId, id), "1");
  }

  return c.json(record, 201);
});

// GET /v1/files — list files (cursor-paginated, optional scope_id filter)
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const beforeId = c.req.query("before_id"); // returns files with id < before_id
  const afterId = c.req.query("after_id");   // returns files with id > after_id
  const order = c.req.query("order") === "asc" ? "asc" : "desc";

  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  // When scope_id is provided, use the scope index (O(scope size) instead of
  // O(all tenant files)).
  let ids: string[];
  if (scopeId) {
    const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "filebyscope", scopeId));
    ids = list.map((k) => k.name.split(":").pop()!).filter(Boolean);
  } else {
    const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "file"));
    ids = list.map((k) => k.name.split(":").pop()!).filter(Boolean);
  }

  const files = (
    await Promise.all(
      ids.map(async (id) => {
        const data = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
        return data ? (JSON.parse(data) as FileRecord) : null;
      }),
    )
  ).filter((f): f is FileRecord => f !== null);

  // Cursor pagination is over file id (lexicographic). created_at could be
  // used too but id is monotonic-ish and unique.
  let filtered = files;
  if (beforeId) filtered = filtered.filter((f) => f.id < beforeId);
  if (afterId) filtered = filtered.filter((f) => f.id > afterId);

  filtered.sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return order === "asc" ? cmp : -cmp;
  });

  const slice = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  return c.json({
    data: slice,
    has_more: hasMore,
    first_id: slice[0]?.id,
    last_id: slice[slice.length - 1]?.id,
  });
});

// GET /v1/files/:id — get file metadata
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!data) return c.json({ error: "File not found" }, 404);
  return c.json(JSON.parse(data));
});

// GET /v1/files/:id/content — download file content (streamed from R2).
// Gated by `downloadable` flag, mirroring Anthropic's split: user-uploaded
// files are opaque, model/sandbox-emitted artefacts are downloadable.
app.get("/:id/content", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const metaData = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!metaData) return c.json({ error: "File not found" }, 404);
  const meta = JSON.parse(metaData) as FileRecord;

  if (!meta.downloadable) {
    return c.json({ error: "This file is not downloadable" }, 403);
  }

  const obj = await bucket.get(fileR2Key(t, id));
  if (!obj) return c.json({ error: "File content not found" }, 404);

  return new Response(obj.body, {
    headers: { "Content-Type": meta.media_type },
  });
});

// DELETE /v1/files/:id — delete metadata + R2 object + scope index entry
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const bucket = ensureBucket(c);

  const data = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!data) return c.json({ error: "File not found" }, 404);

  const meta = JSON.parse(data) as FileRecord;
  await c.env.CONFIG_KV.delete(kvKey(t, "file", id));
  if (meta.scope_id) {
    await c.env.CONFIG_KV.delete(kvKey(t, "filebyscope", meta.scope_id, id));
  }
  if (bucket) await bucket.delete(fileR2Key(t, id));

  return c.json({ type: "file_deleted", id });
});

export default app;
