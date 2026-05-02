import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { checkUploadFreq, checkUploadSize } from "../quotas";
import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillFileInput {
  filename: string;
  content: string;
  /** "utf8" (default) for text, "base64" for binary (images, fonts, archives) */
  encoding?: "utf8" | "base64";
}

interface SkillFileEntry {
  filename: string;
  size_bytes: number;
  /** Encoding used when this file is returned in API responses. */
  encoding: "utf8" | "base64";
}

interface SkillMeta {
  id: string;
  display_title: string;
  name: string;
  description: string;
  source: "custom" | "builtin";
  latest_version: string;
  created_at: string;
}

interface SkillVersion {
  version: string;
  /** Manifest of files. Bytes live in R2 at skillFileKey(t, id, ver, filename). */
  files: SkillFileEntry[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Pre-built (Anthropic) skills — always present in list responses
// ---------------------------------------------------------------------------

const BUILTIN_SKILLS: SkillMeta[] = [
  {
    id: "builtin_xlsx",
    display_title: "Excel (.xlsx) Processing",
    name: "xlsx",
    description:
      "Read, analyze, and transform Excel spreadsheets. Extracts sheets, rows, and cell data from .xlsx files.",
    source: "builtin",
    latest_version: "1",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "builtin_pdf",
    display_title: "PDF Processing",
    name: "pdf",
    description:
      "Read and extract text, tables, and metadata from PDF documents.",
    source: "builtin",
    latest_version: "1",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "builtin_pptx",
    display_title: "PowerPoint (.pptx) Processing",
    name: "pptx",
    description:
      "Read and extract text, slides, and metadata from PowerPoint presentations.",
    source: "builtin",
    latest_version: "1",
    created_at: "2025-01-01T00:00:00Z",
  },
  {
    id: "builtin_docx",
    display_title: "Word (.docx) Processing",
    name: "docx",
    description:
      "Read and extract text, tables, and metadata from Word documents.",
    source: "builtin",
    latest_version: "1",
    created_at: "2025-01-01T00:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9-]{1,64}$/;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function inputToBytes(file: SkillFileInput): Uint8Array {
  if (file.encoding === "base64") return base64ToBytes(file.content);
  return new TextEncoder().encode(file.content);
}

/**
 * Persist all files for a skill version to R2. Throws if FILES_BUCKET is
 * unbound.
 */
async function writeFilesToR2(
  bucket: BlobStore,
  tenantId: string,
  skillId: string,
  version: string,
  files: SkillFileInput[],
): Promise<SkillFileEntry[]> {
  const manifest: SkillFileEntry[] = [];
  for (const f of files) {
    const bytes = inputToBytes(f);
    await bucket.put(skillFileR2Key(tenantId, skillId, version, f.filename), bytes);
    manifest.push({
      filename: f.filename,
      size_bytes: bytes.byteLength,
      encoding: f.encoding === "base64" ? "base64" : "utf8",
    });
  }
  return manifest;
}

async function readFilesFromR2(
  bucket: BlobStore,
  tenantId: string,
  skillId: string,
  version: string,
  manifest: SkillFileEntry[],
): Promise<Array<{ filename: string; content: string; encoding: "utf8" | "base64" }>> {
  const out: Array<{ filename: string; content: string; encoding: "utf8" | "base64" }> = [];
  for (const entry of manifest) {
    const obj = await bucket.get(skillFileR2Key(tenantId, skillId, version, entry.filename));
    if (!obj) continue;
    const bytes = await obj.bytes();
    const content = entry.encoding === "base64"
      ? bytesToBase64(bytes)
      : new TextDecoder("utf-8").decode(bytes);
    out.push({ filename: entry.filename, content, encoding: entry.encoding });
  }
  return out;
}

async function deleteFilesFromR2(
  bucket: BlobStore,
  tenantId: string,
  skillId: string,
  version: string,
  manifest: SkillFileEntry[],
): Promise<void> {
  await Promise.all(
    manifest.map((f) =>
      bucket.delete(skillFileR2Key(tenantId, skillId, version, f.filename)),
    ),
  );
}

function ensureBucket(c: { var: { services: Services } }): BlobStore | null {
  return c.var.services.filesBlob;
}

/**
 * Attempt to extract `name` and `description` from YAML frontmatter in a
 * SKILL.md file.
 */
function parseFrontmatter(
  content: string,
): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const result: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return { name: result.name, description: result.description };
}

function extractFromFiles(
  files: SkillFileInput[],
): { name?: string; description?: string } {
  const skillMd = files.find(
    (f) => f.filename.toLowerCase() === "skill.md" && (f.encoding ?? "utf8") === "utf8",
  );
  if (!skillMd) return {};
  return parseFrontmatter(skillMd.content);
}

function validateFiles(files: SkillFileInput[]): string | null {
  for (const f of files) {
    if (!f.filename || typeof f.content !== "string") {
      return "each file must have a filename and content string";
    }
    if (f.encoding && f.encoding !== "utf8" && f.encoding !== "base64") {
      return `unsupported encoding: ${f.encoding}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// POST /v1/skills — create a custom skill
// ---------------------------------------------------------------------------

app.post("/", async (c) => {
  const t = c.get("tenant_id");
  // Cheap upfront rejects — same gates as POST /v1/files. Both soft-pass
  // when unconfigured.
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const body = await c.req.json<{
    display_title?: string;
    name?: string;
    description?: string;
    files: SkillFileInput[];
  }>();

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return c.json({ error: "files array is required and must not be empty" }, 400);
  }

  const validateErr = validateFiles(body.files);
  if (validateErr) return c.json({ error: validateErr }, 400);

  const extracted = extractFromFiles(body.files);
  const name = body.name || extracted.name;
  const description = body.description || extracted.description || "";
  const displayTitle = body.display_title || name || "";

  if (!name) {
    return c.json(
      { error: "name is required (provide it explicitly or via SKILL.md frontmatter)" },
      400,
    );
  }
  if (!NAME_RE.test(name)) {
    return c.json(
      { error: "name must be lowercase letters, numbers, and hyphens only (max 64 chars)" },
      400,
    );
  }

  const now = new Date().toISOString();
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();

  const manifest = await writeFilesToR2(bucket, t, id, versionId, body.files);

  const skill: SkillMeta = {
    id,
    display_title: displayTitle,
    name,
    description,
    source: "custom",
    latest_version: versionId,
    created_at: now,
  };
  const version: SkillVersion = { version: versionId, files: manifest, created_at: now };

  await Promise.all([
    c.env.CONFIG_KV.put(kvKey(t, "skill", id), JSON.stringify(skill)),
    c.env.CONFIG_KV.put(kvKey(t, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  // Return the same shape the previous API returned: skill metadata + files
  // with content (so existing CLI tooling keeps working).
  const filesOut = await readFilesFromR2(bucket, t, id, versionId, manifest);
  return c.json({ ...skill, files: filesOut }, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/skills — list skills (custom + builtin)
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const source = c.req.query("source");
  let customs: SkillMeta[] = [];
  if (source !== "builtin") {
    const t = c.get("tenant_id");
    const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "skill"));
    customs = (
      await Promise.all(
        list.map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          if (!data) return null;
          try {
            return JSON.parse(data) as SkillMeta;
          } catch (err) {
            logWarn(
              { op: "skills.list.parse", tenant_id: t, kv_key: k.name, err },
              "skill metadata JSON parse failed; skipping entry",
            );
            return null;
          }
        }),
      )
    ).filter((s): s is SkillMeta => s !== null);
  }
  const builtins = source === "custom" ? [] : BUILTIN_SKILLS;
  return c.json({ data: [...builtins, ...customs] });
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id — metadata only
// ---------------------------------------------------------------------------

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const builtin = BUILTIN_SKILLS.find((s) => s.id === id);
  if (builtin) return c.json(builtin);
  const data = await c.env.CONFIG_KV.get(kvKey(c.get("tenant_id"), "skill", id));
  if (!data) return c.json({ error: "Skill not found" }, 404);
  return c.json(JSON.parse(data) as SkillMeta);
});

// ---------------------------------------------------------------------------
// DELETE /v1/skills/:id — delete skill, all versions, and all R2 objects
// ---------------------------------------------------------------------------

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (id.startsWith("builtin_")) {
    return c.json({ error: "Cannot delete built-in skills" }, 403);
  }
  const t = c.get("tenant_id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "skill", id));
  if (!data) return c.json({ error: "Skill not found" }, 404);

  const versionKeys = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "skillver", id));

  const bucket = ensureBucket(c);
  if (bucket) {
    for (const k of versionKeys) {
      const verData = await c.env.CONFIG_KV.get(k.name);
      if (!verData) continue;
      try {
        const v = JSON.parse(verData) as SkillVersion;
        await deleteFilesFromR2(bucket, t, id, v.version, v.files);
      } catch (err) {
        logWarn(
          { op: "skills.delete.r2_cleanup", tenant_id: t, skill_id: id, kv_key: k.name, err },
          "skill version R2 cleanup failed; KV row will still be deleted",
        );
      }
    }
  }

  await Promise.all([
    c.env.CONFIG_KV.delete(kvKey(t, "skill", id)),
    ...versionKeys.map((k) => c.env.CONFIG_KV.delete(k.name)),
  ]);

  return c.json({ type: "skill_deleted", id });
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/versions — create a new version
// ---------------------------------------------------------------------------

app.post("/:id/versions", async (c) => {
  const t = c.get("tenant_id");
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const id = c.req.param("id");
  const raw = await c.env.CONFIG_KV.get(kvKey(t, "skill", id));
  if (!raw) return c.json({ error: "Skill not found" }, 404);

  const skill: SkillMeta = JSON.parse(raw);
  if (skill.source !== "custom") {
    return c.json({ error: "Cannot create versions for built-in skills" }, 403);
  }

  const body = await c.req.json<{
    files: SkillFileInput[];
    display_title?: string;
    description?: string;
  }>();

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return c.json({ error: "files array is required and must not be empty" }, 400);
  }
  const validateErr = validateFiles(body.files);
  if (validateErr) return c.json({ error: validateErr }, 400);

  const now = new Date().toISOString();
  const versionId = Date.now().toString();

  const manifest = await writeFilesToR2(bucket, t, id, versionId, body.files);
  const version: SkillVersion = { version: versionId, files: manifest, created_at: now };

  skill.latest_version = versionId;
  if (body.display_title !== undefined) skill.display_title = body.display_title;
  if (body.description !== undefined) skill.description = body.description;

  const extracted = extractFromFiles(body.files);
  if (!body.display_title && extracted.name) skill.display_title = extracted.name;
  if (!body.description && extracted.description) skill.description = extracted.description;

  await Promise.all([
    c.env.CONFIG_KV.put(kvKey(t, "skill", id), JSON.stringify(skill)),
    c.env.CONFIG_KV.put(kvKey(t, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  return c.json(version, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id/versions — list all versions (manifests only)
// ---------------------------------------------------------------------------

app.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const skillData = await c.env.CONFIG_KV.get(kvKey(t, "skill", id));
  if (!skillData) return c.json({ error: "Skill not found" }, 404);

  const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "skillver", id));

  const versions = (
    await Promise.all(
      list.map(async (k) => {
        const data = await c.env.CONFIG_KV.get(k.name);
        if (!data) return null;
        try {
          const v = JSON.parse(data) as SkillVersion;
          return {
            version: v.version,
            file_count: v.files.length,
            created_at: v.created_at,
          };
        } catch (err) {
          logWarn(
            { op: "skills.versions.parse", kv_key: k.name, err },
            "skill version JSON parse failed; skipping",
          );
          return null;
        }
      }),
    )
  ).filter(Boolean);

  versions.sort((a, b) => {
    const ta = parseInt((a as { version: string }).version, 10);
    const tb = parseInt((b as { version: string }).version, 10);
    return tb - ta;
  });

  return c.json({ data: versions });
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id/versions/:version — get a specific version with files
// ---------------------------------------------------------------------------

app.get("/:id/versions/:version", async (c) => {
  const id = c.req.param("id");
  const version = c.req.param("version");
  const t = c.get("tenant_id");

  const data = await c.env.CONFIG_KV.get(kvKey(t, "skillver", id, version));
  if (!data) return c.json({ error: "Version not found" }, 404);

  const v = JSON.parse(data) as SkillVersion;
  const bucket = ensureBucket(c);
  if (!bucket) return c.json(v); // metadata-only fallback when no bucket

  const filesOut = await readFilesFromR2(bucket, t, id, version, v.files);
  return c.json({ ...v, files: filesOut });
});

// ---------------------------------------------------------------------------
// DELETE /v1/skills/:id/versions/:version
// ---------------------------------------------------------------------------

app.delete("/:id/versions/:version", async (c) => {
  const id = c.req.param("id");
  const version = c.req.param("version");
  const t = c.get("tenant_id");

  const skillRaw = await c.env.CONFIG_KV.get(kvKey(t, "skill", id));
  if (!skillRaw) return c.json({ error: "Skill not found" }, 404);

  const key = kvKey(t, "skillver", id, version);
  const data = await c.env.CONFIG_KV.get(key);
  if (!data) return c.json({ error: "Version not found" }, 404);

  const skill: SkillMeta = JSON.parse(skillRaw);
  const v = JSON.parse(data) as SkillVersion;

  if (skill.latest_version === version) {
    const allVersions = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "skillver", id));
    const remaining = allVersions
      .filter((k) => k.name !== key)
      .map((k) => k.name.split(":").pop()!)
      .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

    if (remaining.length === 0) {
      return c.json(
        { error: "Cannot delete the last version. Delete the skill instead." },
        400,
      );
    }
    skill.latest_version = remaining[0];
    await c.env.CONFIG_KV.put(kvKey(t, "skill", id), JSON.stringify(skill));
  }

  const bucket = ensureBucket(c);
  if (bucket) await deleteFilesFromR2(bucket, t, id, version, v.files);

  await c.env.CONFIG_KV.delete(key);

  return c.json({ type: "skill_version_deleted", id, version });
});

export default app;
