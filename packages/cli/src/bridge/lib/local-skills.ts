/**
 * Detect ACP-compatible local skills installed on the user's machine.
 *
 * Per-agent ecosystems (different conventions):
 *   - claude-acp        → ~/.claude/skills/<id>/SKILL.md + plugin skills
 *   - gemini            → ~/.gemini/extensions/<name>/gemini-extension.json
 *   - opencode          → ~/.opencode/agents/<id>.md + ~/.config/opencode/agents/<id>.md
 *   - codex-acp         → only ~/.codex/AGENTS.md (single global doc; not a
 *                         per-skill dir, so no enumerable items to blocklist)
 *   - hermes            → no documented per-skill dir convention yet
 *   - openclaw          → wraps other agents; no skill ecosystem of its own
 *
 * (ids match the official ACP registry's slugs; pre-A2 ids like
 * "claude-agent-acp" or "gemini-cli" route here via overlay aliases.)
 *
 * Skills with no detection support just return an empty array (or omit the
 * key entirely) — the Console UI handles undefined / [] identically.
 *
 * Output is sent to the platform in the daemon's `hello` manifest so the
 * Console can show "what's available locally" and so per-agent settings
 * can blocklist specific skills. For claude-acp the daemon enforces the
 * blocklist by NOT symlinking dirs into the spawn cwd's
 * CLAUDE_CONFIG_DIR; the other agents don't yet have an analogous
 * filesystem-level filter, so blocklist for them is informational only
 * (we still wire the UI so users can see what's installed).
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
 *
 * Per-agent detectors run in parallel; each one returns [] on missing
 * dirs / IO errors so a failure on one agent doesn't drop the others.
 */
export async function detectLocalSkills(): Promise<LocalSkillManifest> {
  const [claude, gemini, opencode] = await Promise.all([
    detectClaudeCodeSkills(),
    detectGeminiExtensions(),
    detectOpencodeAgents(),
  ]);
  const out: LocalSkillManifest = {};
  // Only emit keys with non-empty arrays — keeps the manifest small for
  // typical users who only have one agent installed, and lets the UI
  // distinguish "agent not detected" from "agent detected, no skills".
  // Keys are the canonical (post-A2) ACP registry ids — pre-A2 ids
  // route here via overlay aliases on the lookup side.
  if (claude.length) out["claude-acp"] = claude;
  if (gemini.length) out["gemini"] = gemini;
  if (opencode.length) out["opencode"] = opencode;
  return out;
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

/**
 * Detect Gemini CLI extensions:
 *   ~/.gemini/extensions/<name>/gemini-extension.json
 * Each extension is a directory; the JSON manifest has `name` (we use the
 * directory name as id since `name` may collide with an MCP server name in
 * the same file). Description comes from `description` field if present,
 * else from the contextFileName (default GEMINI.md).
 */
async function detectGeminiExtensions(): Promise<LocalSkill[]> {
  const root = join(HOME, ".gemini", "extensions");
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }
  const out: LocalSkill[] = [];
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const extDir = join(root, id);
    let st;
    try { st = await stat(extDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    // Require the manifest to exist — bare directories aren't extensions.
    let manifest: { name?: string; description?: string; contextFileName?: string } = {};
    try {
      const raw = await readFile(join(extDir, "gemini-extension.json"), "utf-8");
      manifest = JSON.parse(raw);
    } catch { continue; }
    let description = manifest.description;
    if (!description) {
      // Fall back to first paragraph of the context file.
      const ctxName = manifest.contextFileName ?? "GEMINI.md";
      const meta = await readSkillMeta(join(extDir, ctxName));
      description = meta.description;
    }
    out.push({
      id,
      name: manifest.name ?? id,
      description,
      source: "global",
      path: extDir,
    });
  }
  return out;
}

/**
 * Detect OpenCode custom agents (markdown files with YAML frontmatter):
 *   ~/.opencode/agents/<id>.md
 *   ~/.config/opencode/agents/<id>.md
 *
 * OpenCode's "agents" play the same role as Claude's skills in the bridge
 * UX — pick which ones the spawned ACP child can see. Body of the file is
 * a system prompt; frontmatter has `description`, `mode`, `model`, etc.
 */
async function detectOpencodeAgents(): Promise<LocalSkill[]> {
  const seen = new Map<string, LocalSkill>();
  const dirs = [
    join(HOME, ".opencode", "agents"),
    join(HOME, ".config", "opencode", "agents"),
  ];
  for (const dir of dirs) {
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const file of entries) {
      if (!file.endsWith(".md") || file.startsWith(".")) continue;
      const id = file.slice(0, -3);
      const path = join(dir, file);
      let st;
      try { st = await stat(path); } catch { continue; }
      if (!st.isFile()) continue;
      const meta = await readSkillMeta(path);
      // Later entries (XDG config) shadow earlier (~/.opencode) — matches
      // OpenCode's own precedence rules per their docs.
      seen.set(id, {
        id,
        name: meta.name ?? id,
        description: meta.description,
        source: "global",
        path,
      });
    }
  }
  return [...seen.values()];
}
