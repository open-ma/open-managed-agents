import { Hono } from "hono";
import type { Env } from "../env";
import type { FileRecord } from "../types";
import { generateFileId } from "../id";

const app = new Hono<{ Bindings: Env }>();

// POST /v1/files — upload file (JSON body)
app.post("/", async (c) => {
  const body = await c.req.json<{
    filename: string;
    content: string;
    media_type?: string;
    scope_id?: string;
  }>();

  if (!body.filename || body.content === undefined || body.content === null) {
    return c.json({ error: "filename and content are required" }, 400);
  }

  const id = generateFileId();
  const contentStr = body.content;
  const sizeBytes = new TextEncoder().encode(contentStr).length;

  const file: FileRecord = {
    id,
    filename: body.filename,
    media_type: body.media_type || "application/octet-stream",
    size_bytes: sizeBytes,
    scope_id: body.scope_id,
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`file:${id}`, JSON.stringify(file));
  await c.env.CONFIG_KV.put(`filecontent:${id}`, contentStr);

  return c.json(file, 201);
});

// GET /v1/files — list files
app.get("/", async (c) => {
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  let limit = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;

  const list = await c.env.CONFIG_KV.list({ prefix: "file:" });
  let files = (
    await Promise.all(
      list.keys
        .filter((k) => !k.name.startsWith("filecontent:"))
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
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`file:${id}`);
  if (!data) return c.json({ error: "File not found" }, 404);
  return c.json(JSON.parse(data));
});

// GET /v1/files/:id/content — download file content
app.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  const metaData = await c.env.CONFIG_KV.get(`file:${id}`);
  if (!metaData) return c.json({ error: "File not found" }, 404);

  const meta = JSON.parse(metaData) as FileRecord;
  const content = await c.env.CONFIG_KV.get(`filecontent:${id}`);
  if (content === null) return c.json({ error: "File content not found" }, 404);

  return new Response(content, {
    headers: {
      "Content-Type": meta.media_type,
    },
  });
});

// DELETE /v1/files/:id — delete file + content
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`file:${id}`);
  if (!data) return c.json({ error: "File not found" }, 404);

  await c.env.CONFIG_KV.delete(`file:${id}`);
  await c.env.CONFIG_KV.delete(`filecontent:${id}`);

  return c.json({ type: "file_deleted", id });
});

export default app;
