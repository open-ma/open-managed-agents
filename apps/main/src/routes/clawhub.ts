import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { kvKey } from "../kv-helpers";
import { generateId } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

const CLAWHUB_BASE = "https://clawhub.ai/api/v1";

interface ClawHubPackage {
  name: string;
  displayName: string;
  summary: string;
  family: string;
  latestVersion: string;
  ownerHandle: string;
}

// GET /v1/clawhub/search?q=xxx — search ClawHub registry
app.get("/search", async (c) => {
  const q = c.req.query("q") || "";
  const res = await fetch(`${CLAWHUB_BASE}/packages${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  if (!res.ok) return c.json({ error: `ClawHub search failed: ${res.status}` }, 502);
  const body = (await res.json()) as { items: ClawHubPackage[] };
  // Filter to skills only
  const skills = (body.items || [])
    .filter((p) => p.family === "skill")
    .map((p) => ({
      slug: p.name,
      name: p.displayName || p.name,
      description: p.summary || "",
      version: p.latestVersion,
      owner: p.ownerHandle,
    }));
  return c.json({ data: skills });
});

// POST /v1/clawhub/install — install a skill from ClawHub
app.post("/install", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{ slug: string }>();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);

  // 1. Get package metadata
  const metaRes = await fetch(`${CLAWHUB_BASE}/packages/${encodeURIComponent(body.slug)}`);
  if (!metaRes.ok) return c.json({ error: `Skill "${body.slug}" not found on ClawHub` }, 404);
  const meta = (await metaRes.json()) as { package: ClawHubPackage };

  // 2. Download zip
  const dlRes = await fetch(`${CLAWHUB_BASE}/download?slug=${encodeURIComponent(body.slug)}`);
  if (!dlRes.ok) return c.json({ error: `Failed to download skill: ${dlRes.status}` }, 502);

  // 3. Extract files from zip
  const files = await extractZipFiles(dlRes);

  if (files.length === 0) {
    return c.json({ error: "Downloaded zip contains no files" }, 502);
  }

  // 4. Save to KV
  const pkg = meta.package;
  const skillName = (pkg.displayName || pkg.name).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();
  const now = new Date().toISOString();

  const skill = {
    id,
    display_title: pkg.displayName || pkg.name,
    name: skillName,
    description: pkg.summary || "",
    source: "custom" as const,
    latest_version: versionId,
    created_at: now,
    clawhub_slug: body.slug,
  };

  const version = { version: versionId, files, created_at: now };

  await Promise.all([
    c.env.CONFIG_KV.put(kvKey(t, "skill", id), JSON.stringify(skill)),
    c.env.CONFIG_KV.put(kvKey(t, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  return c.json({ ...skill, files }, 201);
});

/**
 * Extract text files from a zip ArrayBuffer.
 * Minimal zip parser — handles Store (0) and Deflate (8) methods.
 */
async function extractZipFiles(res: Response): Promise<Array<{ filename: string; content: string }>> {
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const files: Array<{ filename: string; content: string }> = [];
  let offset = 0;

  while (offset < buf.byteLength - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature

    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = new Uint8Array(buf, offset + 30, nameLen);
    const filename = new TextDecoder().decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = new Uint8Array(buf, dataStart, compressedSize);

    if (!filename.endsWith("/") && !filename.startsWith("__MACOSX")) {
      try {
        let content: string;
        if (compressionMethod === 8) {
          // Deflate
          const ds = new DecompressionStream("deflate-raw");
          const writer = ds.writable.getWriter();
          writer.write(rawData).catch(() => {});
          writer.close().catch(() => {});
          const decompressed = new Response(ds.readable);
          content = await decompressed.text();
        } else {
          content = new TextDecoder().decode(rawData);
        }
        files.push({ filename, content });
      } catch {
        // Skip files that fail to decompress
      }
    }

    offset = dataStart + compressedSize;
  }

  return files;
}

export default app;
