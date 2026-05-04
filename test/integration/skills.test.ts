// @ts-nocheck
import { exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";

const H = { "x-api-key": "test-key", "Content-Type": "application/json" };
function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}
function post(path: string, body: any) {
  return api(path, { method: "POST", headers: H, body: JSON.stringify(body) });
}
function get(path: string) {
  return api(path, { headers: H });
}
function del(path: string) {
  return api(path, { method: "DELETE", headers: H });
}

/** Build a multipart upload Request without setting content-type ourselves —
 *  FormData lets fetch synthesize the correct boundary. We construct a Request
 *  the same way the dispatcher does so c.req.formData() works. */
function postZip(path: string, zipBytes: Uint8Array, opts?: { displayTitle?: string; filename?: string }) {
  const fd = new FormData();
  fd.append("file", new File([zipBytes], opts?.filename ?? "skill.zip", { type: "application/zip" }));
  if (opts?.displayTitle) fd.append("display_title", opts.displayTitle);
  return api(path, {
    method: "POST",
    headers: { "x-api-key": "test-key" },
    body: fd,
  });
}

const SKILL_MD = `---
name: my-skill
description: A custom skill for testing
---

# My Skill

Instructions here.
`;

const SKILL_MD_ALT = `---
name: alt-skill
description: An alternative skill
---

# Alt Skill

Alternative instructions.
`;

function makeSkillBody(overrides?: Record<string, unknown>) {
  return {
    display_title: "My Test Skill",
    files: [{ filename: "SKILL.md", content: SKILL_MD }],
    ...overrides,
  };
}

// ============================================================
// 1. Skills CRUD
// ============================================================
describe("Skills CRUD", () => {
  it("creates a skill with SKILL.md file", async () => {
    const res = await post("/v1/skills", makeSkillBody());
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.id).toMatch(/^skill_/);
    expect(skill.display_title).toBe("My Test Skill");
    expect(skill.created_at).toBeTruthy();
  });

  it("creates skill — extracts name/description from YAML frontmatter", async () => {
    const res = await post("/v1/skills", makeSkillBody());
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("A custom skill for testing");
  });

  it("rejects skill without files", async () => {
    const res = await post("/v1/skills", { display_title: "No Files" });
    expect(res.status).toBe(400);
  });

  it("creates skill without display_title (auto-extracts from name)", async () => {
    const res = await post("/v1/skills", {
      files: [{ filename: "SKILL.md", content: SKILL_MD }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.display_title).toBeTruthy();
  });

  it("lists skills (includes custom)", async () => {
    // Create a skill so at least one custom skill exists
    const createRes = await post("/v1/skills", makeSkillBody({
      display_title: "Listable Skill",
    }));
    expect(createRes.status).toBe(201);

    const res = await get("/v1/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    const custom = body.data.filter((s: any) => s.display_title === "Listable Skill");
    expect(custom.length).toBeGreaterThanOrEqual(1);
  });

  it("lists skills includes anthropic pre-built skills", async () => {
    const res = await get("/v1/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeInstanceOf(Array);
    // There should be at least one anthropic/pre-built skill in the list
    const anthropic = body.data.filter(
      (s: any) => s.source === "anthropic" || s.source === "builtin"
    );
    expect(anthropic.length).toBeGreaterThanOrEqual(1);
  });

  it("gets skill by id (no file content in response)", async () => {
    const createRes = await post("/v1/skills", makeSkillBody({
      display_title: "Get By ID Skill",
    }));
    const created = (await createRes.json()) as any;

    const res = await get(`/v1/skills/${created.id}`);
    expect(res.status).toBe(200);
    const skill = (await res.json()) as any;
    expect(skill.id).toBe(created.id);
    expect(skill.display_title).toBe("Get By ID Skill");
    // File content should NOT be included in the metadata response
    if (skill.files) {
      for (const f of skill.files) {
        expect(f.content).toBeUndefined();
      }
    }
  });

  it("returns 404 for unknown skill", async () => {
    const res = await get("/v1/skills/skill_nonexistent");
    expect(res.status).toBe(404);
  });

  it("deletes a skill", async () => {
    const createRes = await post("/v1/skills", makeSkillBody({
      display_title: "To Delete",
    }));
    const skill = (await createRes.json()) as any;

    const delRes = await del(`/v1/skills/${skill.id}`);
    expect(delRes.status).toBe(200);
    const body = (await delRes.json()) as any;
    expect(body.type).toBe("skill_deleted");
    expect(body.id).toBe(skill.id);

    // Verify it is gone
    const getRes = await get(`/v1/skills/${skill.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 when deleting nonexistent skill", async () => {
    const res = await del("/v1/skills/skill_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 2. Versions
// ============================================================
describe("Skill versions", () => {
  it("creates initial version on skill creation", async () => {
    const res = await post("/v1/skills", makeSkillBody());
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.latest_version).toBeTruthy();

    // List versions — should have exactly one
    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBe(1);
  });

  it("creates a new version via POST /versions", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    const versionRes = await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });
    expect(versionRes.status).toBe(201);
    const version = (await versionRes.json()) as any;
    expect(version.version).toBeTruthy();
  });

  it("new version has different version ID", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    const initialVersions = await get(`/v1/skills/${skill.id}/versions`);
    const initialData = (await initialVersions.json()) as any;
    const firstVersionId = initialData.data[0].version;

    const newVersionRes = await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });
    const newVersion = (await newVersionRes.json()) as any;
    expect(newVersion.version).not.toBe(firstVersionId);
  });

  it("lists versions (newest first)", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    // Create a second version
    await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });

    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as any;
    expect(versions.data.length).toBe(2);
    // Newest first: the first entry should have a higher version or more recent created_at
    const first = versions.data[0];
    const second = versions.data[1];
    if (first.created_at && second.created_at) {
      expect(first.created_at >= second.created_at).toBe(true);
    }
  });

  it("gets specific version with file content", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    const versions = (await versionsRes.json()) as any;
    const versionId = versions.data[0].version;

    const versionRes = await get(`/v1/skills/${skill.id}/versions/${versionId}`);
    expect(versionRes.status).toBe(200);
    const version = (await versionRes.json()) as any;
    expect(version.files).toBeInstanceOf(Array);
    expect(version.files.length).toBeGreaterThanOrEqual(1);
    const skillMd = version.files.find((f: any) => f.filename === "SKILL.md");
    expect(skillMd).toBeTruthy();
    expect(skillMd.content).toContain("# My Skill");
  });

  it("returns 404 for unknown version", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    const res = await get(`/v1/skills/${skill.id}/versions/nonexistent_version`);
    expect(res.status).toBe(404);
  });

  it("deletes specific version", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;

    // Create a second version so there is something left after deletion
    await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });

    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    const versions = (await versionsRes.json()) as any;
    const versionToDelete = versions.data[versions.data.length - 1].version;

    const delRes = await del(`/v1/skills/${skill.id}/versions/${versionToDelete}`);
    expect(delRes.status).toBe(200);

    // Verify it is gone
    const getRes = await get(`/v1/skills/${skill.id}/versions/${versionToDelete}`);
    expect(getRes.status).toBe(404);
  });

  it("latest_version updates when new version created", async () => {
    const createRes = await post("/v1/skills", makeSkillBody());
    const skill = (await createRes.json()) as any;
    const originalLatest = skill.latest_version;

    await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });

    const updatedRes = await get(`/v1/skills/${skill.id}`);
    const updated = (await updatedRes.json()) as any;
    expect(updated.latest_version).not.toBe(originalLatest);
  });

  it("skill with multiple files in version", async () => {
    const res = await post("/v1/skills", {
      display_title: "Multi File Skill",
      files: [
        { filename: "SKILL.md", content: SKILL_MD },
        { filename: "helper.py", content: "def greet(): return 'hello'" },
        { filename: "config.json", content: '{"key": "value"}' },
      ],
    });
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;

    // Get the version and verify all files are present
    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    const versions = (await versionsRes.json()) as any;
    const versionId = versions.data[0].version;

    const versionRes = await get(`/v1/skills/${skill.id}/versions/${versionId}`);
    const version = (await versionRes.json()) as any;
    expect(version.files.length).toBe(3);
    const filenames = version.files.map((f: any) => f.filename);
    expect(filenames).toContain("SKILL.md");
    expect(filenames).toContain("helper.py");
    expect(filenames).toContain("config.json");
  });

  it("version files include SKILL.md and additional resources", async () => {
    const res = await post("/v1/skills", {
      display_title: "Resource Skill",
      files: [
        { filename: "SKILL.md", content: SKILL_MD },
        { filename: "template.txt", content: "Hello {{name}}" },
      ],
    });
    const skill = (await res.json()) as any;

    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    const versions = (await versionsRes.json()) as any;
    const versionId = versions.data[0].version;

    const versionRes = await get(`/v1/skills/${skill.id}/versions/${versionId}`);
    const version = (await versionRes.json()) as any;

    const skillFile = version.files.find((f: any) => f.filename === "SKILL.md");
    expect(skillFile).toBeTruthy();
    expect(skillFile.content).toContain("name: my-skill");

    const templateFile = version.files.find((f: any) => f.filename === "template.txt");
    expect(templateFile).toBeTruthy();
    expect(templateFile.content).toBe("Hello {{name}}");
  });
});

// ============================================================
// 3. Integration
// ============================================================
describe("Skills integration", () => {
  it("full lifecycle: create -> new version -> list versions -> delete version -> delete skill", async () => {
    // Step 1: Create
    const createRes = await post("/v1/skills", makeSkillBody({
      display_title: "Lifecycle Skill",
    }));
    expect(createRes.status).toBe(201);
    const skill = (await createRes.json()) as any;
    const skillId = skill.id;

    // Step 2: New version
    const v2Res = await post(`/v1/skills/${skillId}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });
    expect(v2Res.status).toBe(201);

    // Step 3: List versions — should have 2
    const listRes = await get(`/v1/skills/${skillId}/versions`);
    expect(listRes.status).toBe(200);
    const versions = (await listRes.json()) as any;
    expect(versions.data.length).toBe(2);

    // Step 4: Delete the older version
    const olderVersion = versions.data[versions.data.length - 1].version;
    const delVersionRes = await del(`/v1/skills/${skillId}/versions/${olderVersion}`);
    expect(delVersionRes.status).toBe(200);

    // Verify only 1 version remains
    const afterDelRes = await get(`/v1/skills/${skillId}/versions`);
    const afterDel = (await afterDelRes.json()) as any;
    expect(afterDel.data.length).toBe(1);

    // Step 5: Delete skill
    const delSkillRes = await del(`/v1/skills/${skillId}`);
    expect(delSkillRes.status).toBe(200);

    // Verify skill is gone
    const getRes = await get(`/v1/skills/${skillId}`);
    expect(getRes.status).toBe(404);
  });

  it("skill name extracted from frontmatter matches expected format", async () => {
    const customMd = `---
name: data-pipeline-runner
description: Runs data pipelines
---

# Data Pipeline Runner

Run ETL jobs.
`;
    const res = await post("/v1/skills", {
      display_title: "Data Pipeline",
      files: [{ filename: "SKILL.md", content: customMd }],
    });
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.name).toBe("data-pipeline-runner");
    // Name should be lowercase with hyphens
    expect(skill.name).toMatch(/^[a-z0-9-]+$/);
  });

  it("two skills have independent versions", async () => {
    // Create skill A
    const aRes = await post("/v1/skills", makeSkillBody({
      display_title: "Skill A",
    }));
    const skillA = (await aRes.json()) as any;

    // Create skill B
    const bRes = await post("/v1/skills", makeSkillBody({
      display_title: "Skill B",
    }));
    const skillB = (await bRes.json()) as any;

    // Add a version to skill A only
    await post(`/v1/skills/${skillA.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });

    // Skill A should have 2 versions
    const aVersionsRes = await get(`/v1/skills/${skillA.id}/versions`);
    const aVersions = (await aVersionsRes.json()) as any;
    expect(aVersions.data.length).toBe(2);

    // Skill B should still have 1 version
    const bVersionsRes = await get(`/v1/skills/${skillB.id}/versions`);
    const bVersions = (await bVersionsRes.json()) as any;
    expect(bVersions.data.length).toBe(1);
  });

  it("delete skill cascades and removes all versions", async () => {
    const createRes = await post("/v1/skills", makeSkillBody({
      display_title: "Cascade Delete Skill",
    }));
    const skill = (await createRes.json()) as any;

    // Add extra versions
    await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD_ALT }],
    });
    await post(`/v1/skills/${skill.id}/versions`, {
      files: [{ filename: "SKILL.md", content: SKILL_MD }],
    });

    // Delete the skill
    const delRes = await del(`/v1/skills/${skill.id}`);
    expect(delRes.status).toBe(200);

    // Skill is gone
    const getRes = await get(`/v1/skills/${skill.id}`);
    expect(getRes.status).toBe(404);

    // Versions endpoint should return 404 as well
    const versionsRes = await get(`/v1/skills/${skill.id}/versions`);
    expect(versionsRes.status).toBe(404);
  });

  it("skill description from frontmatter", async () => {
    const customMd = `---
name: email-summarizer
description: Summarizes long email threads into concise bullet points
---

# Email Summarizer

Summarize emails efficiently.
`;
    const res = await post("/v1/skills", {
      display_title: "Email Summarizer",
      files: [{ filename: "SKILL.md", content: customMd }],
    });
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.description).toBe(
      "Summarizes long email threads into concise bullet points"
    );
  });
});

// ============================================================
// 4. Zip upload — POST /v1/skills/upload + /:id/versions/upload
// ============================================================
describe("Skills zip upload", () => {
  // Tiny binary blob to verify base64 encoding round-trips through R2.
  const PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  function buildSkillZip(opts?: {
    /** When true, wrap files inside a top-level folder (Anthropic-style) so
     *  we can verify the server strips the common prefix. */
    nested?: boolean;
    name?: string;
    description?: string;
  }) {
    const name = opts?.name ?? "zipped-skill";
    const desc = opts?.description ?? "Created from a zip";
    const md = `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;
    const root = opts?.nested ? `${name}/` : "";
    return zipSync({
      [`${root}SKILL.md`]: strToU8(md),
      [`${root}helper.py`]: strToU8("def hello():\n    return 'hi'\n"),
      [`${root}assets/pixel.png`]: PNG_BYTES,
      [`${root}.DS_Store`]: strToU8("junk"),
    });
  }

  it("creates a skill from a zip with a nested top-level folder", async () => {
    const bytes = buildSkillZip({ nested: true, name: "from-zip-nested" });
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.name).toBe("from-zip-nested");
    expect(skill.description).toBe("Created from a zip");
    // Files in the response should NOT carry the top-level folder prefix.
    const filenames = (skill.files as any[]).map((f) => f.filename);
    expect(filenames).toContain("SKILL.md");
    expect(filenames).toContain("helper.py");
    expect(filenames).toContain("assets/pixel.png");
    // .DS_Store should have been filtered out.
    expect(filenames.find((n: string) => n.includes(".DS_Store"))).toBeUndefined();
  });

  it("creates a skill from a flat zip (no top-level folder)", async () => {
    const bytes = buildSkillZip({ nested: false, name: "from-zip-flat" });
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.name).toBe("from-zip-flat");
  });

  it("encodes binary files as base64 in the response", async () => {
    const bytes = buildSkillZip({ nested: true, name: "binary-skill" });
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    const png = (skill.files as any[]).find((f) => f.filename === "assets/pixel.png");
    expect(png).toBeTruthy();
    expect(png.encoding).toBe("base64");
    // base64-decode and compare bytes.
    const bin = atob(png.content);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    expect(Array.from(out)).toEqual(Array.from(PNG_BYTES));
  });

  it("uses display_title form field when provided", async () => {
    const bytes = buildSkillZip({ name: "title-override" });
    const res = await postZip("/v1/skills/upload", bytes, {
      displayTitle: "My Override Title",
    });
    expect(res.status).toBe(201);
    const skill = (await res.json()) as any;
    expect(skill.display_title).toBe("My Override Title");
    expect(skill.name).toBe("title-override");
  });

  it("rejects zip without SKILL.md", async () => {
    const bytes = zipSync({
      "README.md": strToU8("not a skill"),
    });
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/SKILL\.md/);
  });

  it("rejects upload without file field", async () => {
    const fd = new FormData();
    fd.append("display_title", "no file");
    const res = await api("/v1/skills/upload", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-multipart body", async () => {
    const res = await api("/v1/skills/upload", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a new version from a zip via /versions/upload", async () => {
    // Seed a skill via the JSON path.
    const createRes = await post("/v1/skills", makeSkillBody({ display_title: "Versioned" }));
    const skill = (await createRes.json()) as any;
    const before = skill.latest_version;

    const bytes = buildSkillZip({ nested: true, name: "my-skill", description: "v2 from zip" });
    const verRes = await postZip(`/v1/skills/${skill.id}/versions/upload`, bytes);
    expect(verRes.status).toBe(201);
    const ver = (await verRes.json()) as any;
    expect(ver.version).toBeTruthy();
    expect(ver.version).not.toBe(before);

    // Description should refresh from the zip's frontmatter (matches the JSON
    // version endpoint's existing behavior).
    const refreshed = (await (await get(`/v1/skills/${skill.id}`)).json()) as any;
    expect(refreshed.latest_version).toBe(ver.version);
    expect(refreshed.description).toBe("v2 from zip");
  });

  it("rejects /versions/upload for unknown skill", async () => {
    const bytes = buildSkillZip({ name: "unused" });
    const res = await postZip("/v1/skills/skill_nonexistent/versions/upload", bytes);
    expect(res.status).toBe(404);
  });

  // ----- zip-bomb defense -----

  it("rejects zip when a single file's uncompressed size exceeds the per-file cap", async () => {
    // 30MB of zeroes → ~30KB on the wire after DEFLATE → uncompressed size
    // well past the 25MB per-file limit.
    const huge = new Uint8Array(30 * 1024 * 1024);
    const bytes = zipSync({
      "SKILL.md": strToU8("---\nname: bombed\ndescription: x\n---\n"),
      "huge.bin": huge,
    });
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/per-file limit/);
  });

  it("rejects zip when total uncompressed size exceeds the aggregate cap", async () => {
    // Six 20MB compressible blobs = 120MB uncompressed total, which trips
    // the 100MB aggregate cap. Each individual file stays under the
    // per-file limit so the failure mode is unambiguous.
    const blob = new Uint8Array(20 * 1024 * 1024);
    const files: Record<string, Uint8Array> = {
      "SKILL.md": strToU8("---\nname: bombed\ndescription: x\n---\n"),
    };
    for (let i = 0; i < 6; i++) files[`blob-${i}.bin`] = blob;
    const bytes = zipSync(files);
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/zip-bomb defense|aggregate|exceeds/i);
  });

  it("rejects zip with too many files", async () => {
    // 501 tiny files trips the file-count cap of 500.
    const files: Record<string, Uint8Array> = {
      "SKILL.md": strToU8("---\nname: many\ndescription: x\n---\n"),
    };
    for (let i = 0; i < 501; i++) files[`f-${i}.txt`] = strToU8("x");
    const bytes = zipSync(files);
    const res = await postZip("/v1/skills/upload", bytes);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/too many files/i);
  });
});
