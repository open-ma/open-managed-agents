import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { kvKey } from "../kv-helpers";
import { generateId } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

// GET /v1/clawhub/search?q=xxx — search ClawHub skills
app.get("/search", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ data: [] });

  const res = await fetch(`${CLAWHUB_BASE}/skills/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return c.json({ error: `ClawHub search failed: ${res.status}` }, 502);
  return c.json(await res.json());
});

// POST /v1/clawhub/install — install a skill from ClawHub into this tenant
app.post("/install", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ slug: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);

  // 1. Resolve skill metadata
  const resolveRes = await fetch(`${CLAWHUB_BASE}/skills/resolve?slug=${encodeURIComponent(body.slug)}`);
  if (!resolveRes.ok) return c.json({ error: `Skill "${body.slug}" not found on ClawHub` }, 404);
  const resolved = (await resolveRes.json()) as {
    skill?: { slug: string; name: string; description: string; version: string };
    files?: Array<{ filename: string; content: string }>;
  };

  // 2. If resolve doesn't include files, download the zip
  let files = resolved.files;
  if (!files || files.length === 0) {
    const dlRes = await fetch(`${CLAWHUB_BASE}/download?slug=${encodeURIComponent(body.slug)}`);
    if (!dlRes.ok) return c.json({ error: "Failed to download skill from ClawHub" }, 502);

    // Parse zip — simple approach: if it's a zip we can't parse in Workers easily,
    // so we try to get the raw text content
    const contentType = dlRes.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const jsonBody = (await dlRes.json()) as { files?: Array<{ filename: string; content: string }> };
      files = jsonBody.files;
    }
  }

  if (!files || files.length === 0) {
    return c.json({ error: "Could not extract skill files from ClawHub" }, 502);
  }

  // 3. Create skill in our KV
  const meta = resolved.skill || { name: body.slug, description: "", slug: body.slug, version: "1" };
  const name = meta.name || meta.slug;
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();
  const now = new Date().toISOString();

  const skill = {
    id,
    display_title: name,
    name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64),
    description: meta.description || "",
    source: "custom" as const,
    latest_version: versionId,
    created_at: now,
    clawhub_slug: meta.slug,
  };

  const version = {
    version: versionId,
    files,
    created_at: now,
  };

  await Promise.all([
    c.env.CONFIG_KV.put(kvKey(t, "skill", id), JSON.stringify(skill)),
    c.env.CONFIG_KV.put(kvKey(t, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  return c.json({ ...skill, files: version.files }, 201);
});

export default app;
