import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { generateFileId, fileR2Key } from "@open-managed-agents/shared";
import { toFileRecord, FileNotFoundError } from "@open-managed-agents/files-store";
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

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
  const r2Key = fileR2Key(t, id);
  // R2 PUT first, then metadata insert — same failure semantics as the KV era
  // (orphan R2 object on metadata failure, never the reverse).
  await bucket.put(r2Key, body, { httpMetadata: { contentType: mediaType } });

  const row = await c.var.services.files.create({
    id,
    tenantId: t,
    sessionId: scopeId,
    filename,
    mediaType,
    sizeBytes: body.byteLength,
    r2Key,
    downloadable,
  });

  return c.json(toFileRecord(row), 201);
});

// GET /v1/files — list files (cursor-paginated, optional scope_id filter)
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const beforeId = c.req.query("before_id"); // returns files with id < before_id
  const afterId = c.req.query("after_id");   // returns files with id > after_id
  const order = c.req.query("order") === "asc" ? "asc" : "desc";

  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;

  // Ask for one extra row so we can derive `has_more` without a count query.
  const rows = await c.var.services.files.list({
    tenantId: t,
    sessionId: scopeId,
    beforeId,
    afterId,
    order,
    limit: requested + 1,
  });

  const slice = rows.slice(0, requested);
  const data = slice.map(toFileRecord);
  return c.json({
    data,
    has_more: rows.length > requested,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
  });
});

// GET /v1/files/:id — get file metadata
app.get("/:id", async (c) => {
  const row = await c.var.services.files.get({
    tenantId: c.get("tenant_id"),
    fileId: c.req.param("id"),
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});

// GET /v1/files/:id/content — download file content (streamed from R2).
// Gated by `downloadable` flag, mirroring Anthropic's split: user-uploaded
// files are opaque, model/sandbox-emitted artefacts are downloadable.
app.get("/:id/content", async (c) => {
  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const row = await c.var.services.files.get({
    tenantId: c.get("tenant_id"),
    fileId: c.req.param("id"),
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) {
    return c.json({ error: "This file is not downloadable" }, 403);
  }

  const obj = await bucket.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);

  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});

// DELETE /v1/files/:id — delete metadata + R2 object
app.delete("/:id", async (c) => {
  const bucket = ensureBucket(c);
  try {
    const deleted = await c.var.services.files.delete({
      tenantId: c.get("tenant_id"),
      fileId: c.req.param("id"),
    });
    if (bucket) await bucket.delete(deleted.r2_key);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

export default app;
