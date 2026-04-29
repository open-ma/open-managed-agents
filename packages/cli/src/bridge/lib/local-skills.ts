/**
 * Detect ACP-compatible local skills installed on the user's machine.
 *
 * Currently scans Claude Code skill paths only (other ACP agents have their
 * own conventions; codex / gemini / opencode each store skills/plugins
 * differently). Add new agent types as detection grows.
 *
 * Output is sent to the platform in the daemon's `hello` manifest so the
 * Console can show "what's available locally" and so per-agent settings
 * can blocklist specific skills (the platform tells us which to hide via
 * the bundle response on each session.start, and we filter by NOT
 * symlinking blocklisted dirs into the spawn cwd's CLAUDE_CONFIG_DIR).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface LocalSkill {
  /** Directory name — used as the stable id the platform stores in
   *  AgentConfig.runtime_binding.local_skill_blocklist. Also the name
   *  the ACP agent uses to refer to the skill. */
  id: string;
  /** Display name pulled from SKILL.md frontmatter / first H1, fallback to id. */
  name?: string;
  /** First non-empty paragraph of SKILL.md, capped to ~200 chars for UI display. */
  description?: string;
  /** Where the skill came from — affects how Console labels it. */
  source: "global" | "plugin" | "project";
  /** When source=plugin, the plugin name (e.g. "openclaw"). */
  source_label?: string;
  /** Absolute path on disk — daemon-only, not persisted server-side. */
  path: string;
}

/** Manifest shape returned to platform: keyed by ACP agent id so each
 *  agent kind can have its own skill ecosystem. */
export type LocalSkillManifest = Partial<Record<string, LocalSkill[]>>;

const HOME = homedir();

/**
 * Scan all known skill locations on this machine. Each skill is detected
 * exactly once (deduped by id within an agent kind; later entries shadow
 * earlier — same precedence claude-code uses, project > plugin > global).
 */
export async function detectLocalSkills(): Promise<LocalSkillManifest> {
  return {
    "claude-code-acp": await detectClaudeCodeSkills(),
  };
}

async function detectClaudeCodeSkills(): Promise<LocalSkill[]> {
  const seen = new Map<string, LocalSkill>();

  // ~/.claude/skills/<id>/SKILL.md — global skills the user installed by hand
  // or via `claude /skills`.
  for (const skill of await scanSkillsDir(join(HOME, ".claude", "skills"), "global")) {
    seen.set(skill.id, skill);
  }

  // ~/.claude/plugins/<plugin>/skills/<id>/SKILL.md — skills bundled with
  // installed plugins. Same ACP agent sees these alongside globals; we keep
  // the source label so the Console can show the user where each came from.
  const pluginsRoot = join(HOME, ".claude", "plugins");
  let plugins: string[] = [];
  try { plugins = await readdir(pluginsRoot); } catch { /* no plugins dir */ }
  for (const plugin of plugins) {
    const pluginSkillsDir = join(pluginsRoot, plugin, "skills");
    for (const skill of await scanSkillsDir(pluginSkillsDir, "plugin", plugin)) {
      // Plugin skills don't override globals with the same id — claude-code
      // would also see both, so report both. Use a synthetic id with plugin
      // prefix to dedupe in the map but keep the original id for the wire.
      const key = `${plugin}/${skill.id}`;
      seen.set(key, skill);
    }
  }

  return [...seen.values()];
}

async function scanSkillsDir(
  dir: string,
  source: LocalSkill["source"],
  source_label?: string,
): Promise<LocalSkill[]> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return []; }
  const out: LocalSkill[] = [];
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const skillDir = join(dir, id);
    let st;
    try { st = await stat(skillDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const meta = await readSkillMeta(join(skillDir, "SKILL.md"));
    out.push({
      id,
      name: meta.name ?? id,
      description: meta.description,
      source,
      source_label,
      path: skillDir,
    });
  }
  return out;
}

async function readSkillMeta(file: string): Promise<{ name?: string; description?: string }> {
  let text: string;
  try { text = await readFile(file, "utf-8"); } catch { return {}; }
  // YAML frontmatter (---\nname: ...\ndescription: ...\n---)
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  let name: string | undefined;
  let description: string | undefined;
  if (fm) {
    const nm = fm[1].match(/^name:\s*(.+)$/m);
    if (nm) name = nm[1].trim().replace(/^["']|["']$/g, "");
    const dm = fm[1].match(/^description:\s*(.+)$/m);
    if (dm) description = dm[1].trim().replace(/^["']|["']$/g, "");
    text = text.slice(fm[0].length);
  }
  // Fallback: first H1 = name, first non-blank paragraph after = description
  if (!name) {
    const h1 = text.match(/^#\s+(.+)$/m);
    if (h1) name = h1[1].trim();
  }
  if (!description) {
    const para = text
      .replace(/^#.*$/gm, "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0);
    if (para) description = para.slice(0, 200) + (para.length > 200 ? "…" : "");
  }
  return { name, description };
}
