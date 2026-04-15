import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { FileRecord } from "@open-managed-agents/shared";
import { generateFileId } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

// POST /v1/files — upload file (multipart form or JSON body)
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  let filename: string;
  let contentStr: string;
  let mediaType: string;
  let scopeId: string | undefined;

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    // Anthropic-compatible multipart upload
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field is required in multipart upload" }, 400);
    }
    filename = file.name;
    mediaType = file.type || "application/octet-stream";
    contentStr = await file.text();
  } else {
    // JSON body upload (legacy)
    const body = await c.req.json<{
      filename: string;
      content: string;
      media_type?: string;
      scope_id?: string;
    }>();

    if (!body.filename || body.content === undefined || body.content === null) {
      return c.json({ error: "filename and content are required" }, 400);
    }
    filename = body.filename;
    contentStr = body.content;
    mediaType = body.media_type || "application/octet-stream";
    scopeId = body.scope_id;
  }

  const id = generateFileId();
  const sizeBytes = new TextEncoder().encode(contentStr).length;

  const file: FileRecord = {
    id,
    type: "file" as const,
    filename,
    media_type: mediaType,
    size_bytes: sizeBytes,
    scope_id: scopeId,
    downloadable: false,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(kvKey(t, "file", id), JSON.stringify(file));
  await c.env.CONFIG_KV.put(kvKey(t, "filecontent", id), contentStr);

  return c.json(file, 201);
});

// GET /v1/files — list files
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: kvPrefix(t, "file") });
  let files = (
    await Promise.all(
      list.keys
        .filter((k) => !k.name.includes(":filecontent:"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? (JSON.parse(data) as FileRecord) : null;
        })
    )
  ).filter((f): f is FileRecord => f !== null);

  if (scopeId) {
    files = files.filter((f) => f.scope_id === scopeId);
  }

  files.sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    return order === "asc" ? cmp : -cmp;
  });

  return c.json({ data: files.slice(0, limit) });
});

// GET /v1/files/:id — get file metadata
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!data) return c.json({ error: "File not found" }, 404);
  return c.json(JSON.parse(data));
});

// GET /v1/files/:id/content — download file content
app.get("/:id/content", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const metaData = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!metaData) return c.json({ error: "File not found" }, 404);

  const meta = JSON.parse(metaData) as FileRecord;
  const content = await c.env.CONFIG_KV.get(kvKey(t, "filecontent", id));
  if (content === null) return c.json({ error: "File content not found" }, 404);

  return new Response(content, {
    headers: {
      "Content-Type": meta.media_type,
    },
  });
});

// DELETE /v1/files/:id — delete file + content
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "file", id));
  if (!data) return c.json({ error: "File not found" }, 404);

  await c.env.CONFIG_KV.delete(kvKey(t, "file", id));
  await c.env.CONFIG_KV.delete(kvKey(t, "filecontent", id));

  return c.json({ type: "file_deleted", id });
});

export default app;
