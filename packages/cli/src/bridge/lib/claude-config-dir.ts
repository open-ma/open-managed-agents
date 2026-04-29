/**
 * Build a per-session `.claude-config/` directory the spawned Claude Code
 * child reads via `CLAUDE_CONFIG_DIR=<cwd>/.claude-config`. Lets us hide
 * specific local skills from a given OMA agent without touching the user's
 * real `~/.claude/`.
 *
 * Strategy: symlink everything from `~/.claude/` over EXCEPT the skills tree,
 * then rebuild `skills/` filtering out any id present in the blocklist.
 *
 *   ~/.claude/                  →   <cwd>/.claude-config/
 *     settings.json             →     settings.json (symlink)
 *     credentials.json          →     credentials.json (symlink)
 *     agents/                   →     agents/ (symlink)
 *     commands/                 →     commands/ (symlink)
 *     plugins/                  →     plugins/ (symlink, atomic)
 *     ...                       →     ... (symlink, atomic)
 *     skills/<id>/              →     skills/<id>/ (symlink, only if NOT blocklisted)
 *
 * Blocklist is a Set of skill ids (the bare directory name). v1 filters only
 * `~/.claude/skills/<id>/` — the common case where users drop custom skills
 * by hand. Plugin-bundled skills come along with the wholesale `plugins/`
 * symlink and aren't filterable yet (their layout is
 * `plugins/cache/<marketplace>/<plugin>/<ver>/skills/<id>/` — would need a
 * recursive walk to filter individually). Add when a real user hits this.
 *
 * For non–claude-code-acp agents this isn't called; their skill ecosystems
 * don't share Claude Code's filesystem layout. Add per-agent helpers when
 * codex / opencode / gemini grow analogous mechanisms.
 *
 * Best-effort throughout: a missing source dir, a stale symlink left over
 * from a previous spawn, or a permission error on one entry must not abort
 * the spawn — we log and keep going. Worst case the child sees a stale
 * `.claude-config/` from the previous turn, which is still safer than
 * crashing the daemon between user prompts.
 */

import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CLAUDE_HOME = join(homedir(), ".claude");

/**
 * Materialize `<cwd>/.claude-config/` for a Claude Code spawn.
 *
 * Returns the absolute path the caller should pass as `CLAUDE_CONFIG_DIR`.
 * Always returns the path even on partial failures — the spawn should still
 * happen; the child will just see whatever symlinks succeeded.
 */
export async function setupClaudeConfigDir(
  cwd: string,
  blocklist: ReadonlySet<string>,
): Promise<string> {
  const cfgDir = join(cwd, ".claude-config");
  await mkdir(cfgDir, { recursive: true });

  await mirrorClaudeHome(cfgDir);
  await rebuildSkills(cfgDir, blocklist);

  return cfgDir;
}

/**
 * Symlink every top-level entry in `~/.claude/` into `<cfgDir>/` EXCEPT
 * `skills/`, which we rebuild with the blocklist applied.
 *
 * Idempotent: clears any pre-existing entry at the destination first so a
 * second spawn (e.g. session.start re-fired after a daemon restart)
 * replaces stale links pointing at deleted plugins.
 */
async function mirrorClaudeHome(cfgDir: string): Promise<void> {
  let entries: string[] = [];
  try { entries = await readdir(CLAUDE_HOME); } catch { return; }
  for (const entry of entries) {
    if (entry === "skills") continue;
    const dst = join(cfgDir, entry);
    await rm(dst, { recursive: true, force: true }).catch(() => {});
    try {
      await symlink(join(CLAUDE_HOME, entry), dst);
    } catch (e) {
      process.stderr.write(
        `  ! claude-config symlink ${entry} failed (non-fatal): ${(e as Error).message}\n`,
      );
    }
  }
}

/**
 * Build `<cfgDir>/skills/` from `~/.claude/skills/` minus blocklisted ids.
 * Each retained skill is one symlink to the real directory — we never copy
 * skill content, so updates the user makes to `~/.claude/skills/<id>/` are
 * visible to the spawned child immediately.
 */
async function rebuildSkills(cfgDir: string, blocklist: ReadonlySet<string>): Promise<void> {
  const dst = join(cfgDir, "skills");
  await rm(dst, { recursive: true, force: true }).catch(() => {});
  await mkdir(dst, { recursive: true });

  const src = join(CLAUDE_HOME, "skills");
  let ids: string[] = [];
  try { ids = await readdir(src); } catch { return; }
  for (const id of ids) {
    if (id.startsWith(".")) continue;
    if (blocklist.has(id)) continue;
    await symlink(join(src, id), join(dst, id)).catch((e) => {
      process.stderr.write(
        `  ! claude-config skill symlink ${id} failed (non-fatal): ${(e as Error).message}\n`,
      );
    });
  }
}
