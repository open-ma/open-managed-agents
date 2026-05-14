export interface Skill {
  id: string;
  name: string;
  source?: "anthropic" | "custom";
  system_prompt_addition: string;
  tools?: Record<string, unknown>;
}

export interface SkillFile {
  filename: string;
  /** Raw bytes ready for writeFileBytes(). */
  bytes: Uint8Array;
}

export interface SkillFilesResult {
  skillName: string;
  files: SkillFile[];
}

import { skillFileR2Key } from "@open-managed-agents/shared";

const skillRegistry = new Map<string, Skill>();

export function registerSkill(skill: Skill) {
  skillRegistry.set(skill.id, skill);
}

/**
 * Resolve built-in (anthropic pre-registered) skills from the in-memory registry.
 * Custom skills are NOT resolved here — use resolveCustomSkills() for those.
 * This function is intentionally kept synchronous for backward compatibility.
 */
export function resolveSkills(skillConfigs: Array<{ skill_id: string }>): Skill[] {
  return skillConfigs.map(s => skillRegistry.get(s.skill_id)).filter(Boolean) as Skill[];
}

/**
 * Resolve custom skills by fetching metadata from KV and inlining SKILL.md
 * content into the system prompt. AMA-aligned: the model sees the full
 * skill instructions up-front, no read-tool round-trip needed.
 *
 * KV key format: t:{tenant}:skill:{skill_id} -> { id, name, display_title, description, latest_version, ... }
 * Versioned manifest: t:{tenant}:skillver:{skill_id}:{version} -> { files: [{filename, ...}], ... }
 * SKILL.md bytes live in R2 at the skillFileR2Key path.
 */
export async function resolveCustomSkills(
  skillConfigs: Array<{ skill_id: string; type?: string; version?: string }>,
  kv: KVNamespace,
  filesBucket: R2Bucket | undefined,
  tenantId: string,
): Promise<Skill[]> {
  const customConfigs = skillConfigs.filter(
    s => s.type === "custom" && !skillRegistry.has(s.skill_id),
  );

  const skills: Skill[] = [];
  for (const cfg of customConfigs) {
    try {
      const raw = await kv.get(`t:${tenantId}:skill:${cfg.skill_id}`);
      if (!raw) continue;

      const meta = JSON.parse(raw) as {
        id: string;
        name?: string;
        display_title?: string;
        description?: string;
        latest_version?: string;
      };

      const name = meta.display_title || meta.name || cfg.skill_id;
      const description = meta.description || "";

      // Try to inline the full SKILL.md so the model sees it in the
      // system prompt without a read-tool round-trip. Falls back to
      // a metadata-only addition if R2 / version manifest aren't
      // available — keeps the lazy-load path as a safety net.
      let body = "";
      const version = (cfg.version && cfg.version !== "latest") ? cfg.version : meta.latest_version;
      if (filesBucket && version) {
        try {
          const verRaw = await kv.get(`t:${tenantId}:skillver:${cfg.skill_id}:${version}`);
          if (verRaw) {
            const verData = JSON.parse(verRaw) as {
              files?: Array<{ filename: string }>;
            };
            const hasSkillMd = verData.files?.some((f) => f.filename === "SKILL.md");
            if (hasSkillMd) {
              const obj = await filesBucket.get(
                skillFileR2Key(tenantId, cfg.skill_id, version, "SKILL.md"),
              );
              if (obj) body = await obj.text();
            }
          }
        } catch {
          // Fall through to metadata-only.
        }
      }

      const addition = body
        ? `<skill name="${name}">\n${body}\n</skill>`
        : `[Skill: ${name}] ${description}. Read /home/user/.skills/${name}/SKILL.md for instructions.`;

      skills.push({
        id: cfg.skill_id,
        name,
        source: "custom",
        system_prompt_addition: addition,
      });
    } catch {
      // Skip skills that can't be resolved from KV
    }
  }

  return skills;
}

/**
 * Fetch custom skill files from R2 for mounting into the sandbox.
 *
 * KV stores only the manifest (filename + size + encoding). Bytes live in
 * R2 at `t/{tenant}/skills/{id}/{ver}/{filename}` so binary assets (images,
 * fonts, model files) survive round-tripping. Caller writes bytes verbatim
 * via SandboxExecutor.writeFileBytes.
 */
export async function getSkillFiles(
  skillConfigs: Array<{ skill_id: string; type?: string; version?: string }>,
  kv: KVNamespace,
  filesBucket: R2Bucket | undefined,
  tenantId: string,
): Promise<SkillFilesResult[]> {
  if (!filesBucket) return [];
  const customConfigs = skillConfigs.filter(
    s => s.type === "custom" && !skillRegistry.has(s.skill_id),
  );

  const results: SkillFilesResult[] = [];
  for (const cfg of customConfigs) {
    try {
      const metaRaw = await kv.get(`t:${tenantId}:skill:${cfg.skill_id}`);
      if (!metaRaw) continue;

      const meta = JSON.parse(metaRaw) as {
        name?: string;
        latest_version?: string;
      };

      const version = (cfg.version && cfg.version !== "latest") ? cfg.version : meta.latest_version;
      if (!version) continue;

      const verRaw = await kv.get(`t:${tenantId}:skillver:${cfg.skill_id}:${version}`);
      if (!verRaw) continue;

      const verData = JSON.parse(verRaw) as {
        files?: Array<{ filename: string; size_bytes?: number; encoding?: string }>;
      };

      if (!verData.files?.length) continue;

      const files: SkillFile[] = [];
      for (const entry of verData.files) {
        const obj = await filesBucket.get(
          skillFileR2Key(tenantId, cfg.skill_id, version, entry.filename),
        );
        if (!obj) continue;
        const buf = await obj.arrayBuffer();
        files.push({ filename: entry.filename, bytes: new Uint8Array(buf) });
      }

      if (files.length > 0) {
        results.push({
          skillName: meta.name || cfg.skill_id,
          files,
        });
      }
    } catch {
      // Skip skills whose files can't be fetched
    }
  }

  return results;
}

// No hardcoded built-in skills.
// All skills (including Anthropic's pptx/xlsx/docx/pdf) are managed via the
// /v1/skills API and stored in KV. Use `scripts/seed-skills.ts` to import
// skills from github.com/anthropics/skills into your deployment.
