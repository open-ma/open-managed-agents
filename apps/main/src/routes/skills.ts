import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { generateId, skillFileR2Key } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";
import { unzipSync } from "fflate";
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
// Zip handling — accept a packaged skill folder and convert to the same
// SkillFileInput[] shape the JSON endpoint already consumes. Strips the
// common top-level directory (Anthropic-style `my-skill/SKILL.md`),
// filters platform junk, and classifies each file as utf8 vs base64 by
// strict TextDecoder.
// ---------------------------------------------------------------------------

const IGNORED_BASENAMES = new Set([".DS_Store", "Thumbs.db"]);
const IGNORED_PREFIXES = ["__MACOSX/", ".git/", ".idea/", ".vscode/"];

function zipEntryIgnored(path: string): boolean {
  if (IGNORED_PREFIXES.some((p) => path.startsWith(p) || path.includes(`/${p}`))) return true;
  const base = path.split("/").pop() || "";
  if (IGNORED_BASENAMES.has(base)) return true;
  if (base.startsWith("._")) return true;
  return false;
}

function commonRootPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const firstSlash = paths[0].indexOf("/");
  if (firstSlash < 0) return "";
  const candidate = paths[0].slice(0, firstSlash + 1);
  return paths.every((p) => p.startsWith(candidate)) ? candidate : "";
}

function formatBytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function bytesToBase64Str(bytes: Uint8Array): string {
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

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

interface ParsedSkillZip {
  files: SkillFileInput[];
  name?: string;
  description?: string;
}

/** Caps applied during unzip to defend against zip-bombs. The dialed limits
 *  are deliberately generous — the largest legitimate Anthropic-style skill
 *  observed in the field is ~5 MB / ~100 files, so 100 MB / 25 MB per file /
 *  500 files leaves ~20× headroom. A maliciously crafted zip can declare
 *  multi-GB uncompressed sizes from a kilobyte payload; we reject as soon
 *  as the central-directory metadata exceeds these limits, before
 *  decompression actually runs. */
const ZIP_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
const ZIP_MAX_FILE_UNCOMPRESSED = 25 * 1024 * 1024;
const ZIP_MAX_FILE_COUNT = 500;

class ZipLimitError extends Error {}

function parseSkillZipBytes(bytes: Uint8Array): ParsedSkillZip {
  let entries: Record<string, Uint8Array>;
  try {
    let totalUncompressed = 0;
    let count = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        // Skip directory entries and platform junk before they count
        // against the budget — fflate would otherwise call us for every
        // __MACOSX/* entry.
        if (file.name.endsWith("/") || zipEntryIgnored(file.name)) return false;
        count++;
        if (count > ZIP_MAX_FILE_COUNT) {
          throw new ZipLimitError(
            `Zip has too many files (>${ZIP_MAX_FILE_COUNT}); refusing to process`,
          );
        }
        if (file.originalSize > ZIP_MAX_FILE_UNCOMPRESSED) {
          throw new ZipLimitError(
            `File "${file.name}" is ${formatBytesHuman(file.originalSize)} uncompressed; per-file limit is ${formatBytesHuman(ZIP_MAX_FILE_UNCOMPRESSED)}`,
          );
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED) {
          throw new ZipLimitError(
            `Zip uncompressed size exceeds ${formatBytesHuman(ZIP_MAX_TOTAL_UNCOMPRESSED)} (zip-bomb defense)`,
          );
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ZipLimitError) throw err;
    throw new Error(
      `Could not read zip: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  // fflate's filter already dropped directory + ignored entries; what
  // remains is the actual skill payload.
  const usable = Object.entries(entries);
  if (usable.length === 0) {
    throw new Error("Zip is empty (after filtering metadata files)");
  }

  const prefix = commonRootPrefix(usable.map(([p]) => p));
  const stripped = usable.map(([path, data]) => ({
    path: prefix ? path.slice(prefix.length) : path,
    bytes: data,
  }));

  const skillMd = stripped.find((e) => e.path.toLowerCase() === "skill.md");
  if (!skillMd) {
    throw new Error(
      "Zip must contain SKILL.md at the root (or a single top-level folder containing it)",
    );
  }
  const skillMdText = tryDecodeUtf8(skillMd.bytes);
  if (skillMdText === null) {
    throw new Error("SKILL.md must be UTF-8 text");
  }

  const files: SkillFileInput[] = [];
  for (const entry of stripped) {
    if (!entry.path) continue;
    const decoded =
      entry.path === skillMd.path
        ? skillMdText
        : tryDecodeUtf8(entry.bytes);
    if (decoded !== null) {
      files.push({ filename: entry.path, content: decoded, encoding: "utf8" });
    } else {
      files.push({
        filename: entry.path,
        content: bytesToBase64Str(entry.bytes),
        encoding: "base64",
      });
    }
  }

  const { name, description } = parseFrontmatter(skillMdText);
  return { files, name, description };
}



// ---------------------------------------------------------------------------
// Shared persistence — both the JSON POST and the multipart upload endpoint
// converge here once they have a validated SkillFileInput[] in hand.
// ---------------------------------------------------------------------------

interface PersistArgs {
  files: SkillFileInput[];
  display_title?: string;
  name?: string;
  description?: string;
}

async function persistNewSkill(
  env: Env,
  bucket: R2Bucket,
  tenantId: string,
  args: PersistArgs,
): Promise<
  | { ok: true; skill: SkillMeta; files: Array<{ filename: string; content: string; encoding: "utf8" | "base64" }>; status: 201 }
  | { ok: false; status: number; error: string }
> {
  if (!args.files || args.files.length === 0) {
    return { ok: false, status: 400, error: "files array is required and must not be empty" };
  }
  const validateErr = validateFiles(args.files);
  if (validateErr) return { ok: false, status: 400, error: validateErr };

  const extracted = extractFromFiles(args.files);
  const name = args.name || extracted.name;
  const description = args.description || extracted.description || "";
  const displayTitle = args.display_title || name || "";

  if (!name) {
    return {
      ok: false,
      status: 400,
      error: "name is required (provide it explicitly or via SKILL.md frontmatter)",
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      status: 400,
      error: "name must be lowercase letters, numbers, and hyphens only (max 64 chars)",
    };
  }

  const now = new Date().toISOString();
  const id = `skill_${generateId()}`;
  const versionId = Date.now().toString();

  const manifest = await writeFilesToR2(bucket, tenantId, id, versionId, args.files);
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
    env.CONFIG_KV.put(kvKey(tenantId, "skill", id), JSON.stringify(skill)),
    env.CONFIG_KV.put(kvKey(tenantId, "skillver", id, versionId), JSON.stringify(version)),
  ]);

  const filesOut = await readFilesFromR2(bucket, tenantId, id, versionId, manifest);
  return { ok: true, status: 201, skill, files: filesOut };
}

async function persistNewVersion(
  env: Env,
  bucket: R2Bucket,
  tenantId: string,
  skillId: string,
  args: PersistArgs,
): Promise<
  | { ok: true; version: SkillVersion; status: 201 }
  | { ok: false; status: number; error: string }
> {
  const raw = await env.CONFIG_KV.get(kvKey(tenantId, "skill", skillId));
  if (!raw) return { ok: false, status: 404, error: "Skill not found" };
  const skill: SkillMeta = JSON.parse(raw);
  if (skill.source !== "custom") {
    return { ok: false, status: 403, error: "Cannot create versions for built-in skills" };
  }

  if (!args.files || args.files.length === 0) {
    return { ok: false, status: 400, error: "files array is required and must not be empty" };
  }
  const validateErr = validateFiles(args.files);
  if (validateErr) return { ok: false, status: 400, error: validateErr };

  const now = new Date().toISOString();
  const versionId = Date.now().toString();

  const manifest = await writeFilesToR2(bucket, tenantId, skillId, versionId, args.files);
  const version: SkillVersion = { version: versionId, files: manifest, created_at: now };

  skill.latest_version = versionId;
  if (args.display_title !== undefined) skill.display_title = args.display_title;
  if (args.description !== undefined) skill.description = args.description;

  // Refresh display_title / description from frontmatter if caller didn't
  // override — matches the JSON endpoint's existing behavior.
  const extracted = extractFromFiles(args.files);
  if (!args.display_title && extracted.name) skill.display_title = extracted.name;
  if (!args.description && extracted.description) skill.description = extracted.description;

  await Promise.all([
    env.CONFIG_KV.put(kvKey(tenantId, "skill", skillId), JSON.stringify(skill)),
    env.CONFIG_KV.put(kvKey(tenantId, "skillver", skillId, versionId), JSON.stringify(version)),
  ]);

  return { ok: true, status: 201, version };
}

// ---------------------------------------------------------------------------
// POST /v1/skills — create a custom skill (JSON; SDK / programmatic path)
// ---------------------------------------------------------------------------

app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const body = await c.req.json<PersistArgs>();
  const result = await persistNewSkill(c.env, bucket, t, body);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500);
  return c.json({ ...result.skill, files: result.files }, 201);
});

// ---------------------------------------------------------------------------
// POST /v1/skills/upload — create a custom skill from a packaged .zip
// (multipart/form-data: file=<zip>, optional display_title)
// ---------------------------------------------------------------------------

app.post("/upload", async (c) => {
  const t = c.get("tenant_id");
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (err) {
    return c.json(
      { error: `Invalid multipart body: ${err instanceof Error ? err.message : "unknown"}` },
      400,
    );
  }
  const file = formData.get("file") as File | null;
  if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    return c.json({ error: "file field is required (the skill .zip)" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ParsedSkillZip;
  try {
    parsed = parseSkillZipBytes(bytes);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to read zip" },
      400,
    );
  }

  const displayTitle =
    typeof formData.get("display_title") === "string"
      ? (formData.get("display_title") as string)
      : undefined;

  const result = await persistNewSkill(c.env, bucket, t, {
    files: parsed.files,
    name: parsed.name,
    description: parsed.description,
    display_title: displayTitle,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500);
  return c.json({ ...result.skill, files: result.files }, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/skills — list skills (custom + builtin)
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const source = c.req.query("source");
  let customs: SkillMeta[] = [];
  if (source !== "builtin") {
    const t = c.get("tenant_id");
    const list = await kvListAll(c.var.services.kv, kvPrefix(t, "skill"));
    customs = (
      await Promise.all(
        list.map(async (k) => {
          const data = await c.var.services.kv.get(k.name);
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
  const data = await c.var.services.kv.get(kvKey(c.get("tenant_id"), "skill", id));
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
  const data = await c.var.services.kv.get(kvKey(t, "skill", id));
  if (!data) return c.json({ error: "Skill not found" }, 404);

  const versionKeys = await kvListAll(c.var.services.kv, kvPrefix(t, "skillver", id));

  const bucket = ensureBucket(c);
  if (bucket) {
    for (const k of versionKeys) {
      const verData = await c.var.services.kv.get(k.name);
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
    c.var.services.kv.delete(kvKey(t, "skill", id)),
    ...versionKeys.map((k) => c.var.services.kv.delete(k.name)),
  ]);

  return c.json({ type: "skill_deleted", id });
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/versions — create a new version (JSON)
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
  const body = await c.req.json<PersistArgs>();
  const result = await persistNewVersion(c.env, bucket, t, id, body);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 500);
  return c.json(result.version, 201);
});

// ---------------------------------------------------------------------------
// POST /v1/skills/:id/versions/upload — new version from a packaged .zip
// ---------------------------------------------------------------------------

app.post("/:id/versions/upload", async (c) => {
  const t = c.get("tenant_id");
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = ensureBucket(c);
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (err) {
    return c.json(
      { error: `Invalid multipart body: ${err instanceof Error ? err.message : "unknown"}` },
      400,
    );
  }
  const file = formData.get("file") as File | null;
  if (!file || typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    return c.json({ error: "file field is required (the skill .zip)" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let parsed: ParsedSkillZip;
  try {
    parsed = parseSkillZipBytes(bytes);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to read zip" },
      400,
    );
  }

  const displayTitle =
    typeof formData.get("display_title") === "string"
      ? (formData.get("display_title") as string)
      : undefined;

  const id = c.req.param("id");
  const result = await persistNewVersion(c.env, bucket, t, id, {
    files: parsed.files,
    display_title: displayTitle,
    description: parsed.description,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 404 | 500);
  return c.json(result.version, 201);
});

// ---------------------------------------------------------------------------
// GET /v1/skills/:id/versions — list all versions (manifests only)
// ---------------------------------------------------------------------------

app.get("/:id/versions", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const skillData = await c.var.services.kv.get(kvKey(t, "skill", id));
  if (!skillData) return c.json({ error: "Skill not found" }, 404);

  const list = await kvListAll(c.var.services.kv, kvPrefix(t, "skillver", id));

  const versions = (
    await Promise.all(
      list.map(async (k) => {
        const data = await c.var.services.kv.get(k.name);
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

  const data = await c.var.services.kv.get(kvKey(t, "skillver", id, version));
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

  const skillRaw = await c.var.services.kv.get(kvKey(t, "skill", id));
  if (!skillRaw) return c.json({ error: "Skill not found" }, 404);

  const key = kvKey(t, "skillver", id, version);
  const data = await c.var.services.kv.get(key);
  if (!data) return c.json({ error: "Version not found" }, 404);

  const skill: SkillMeta = JSON.parse(skillRaw);
  const v = JSON.parse(data) as SkillVersion;

  if (skill.latest_version === version) {
    const allVersions = await kvListAll(c.var.services.kv, kvPrefix(t, "skillver", id));
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
    await c.var.services.kv.put(kvKey(t, "skill", id), JSON.stringify(skill));
  }

  const bucket = ensureBucket(c);
  if (bucket) await deleteFilesFromR2(bucket, t, id, version, v.files);

  await c.var.services.kv.delete(key);

  return c.json({ type: "skill_version_deleted", id, version });
});

export default app;
