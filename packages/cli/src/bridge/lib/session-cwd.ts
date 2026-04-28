/**
 * Per-session working directory management.
 *
 * Every spawned ACP agent runs with cwd = `~/.oma/bridge/sessions/<session-id>/`
 * — never the user's pwd. Three reasons:
 *
 *   1. Spawn-cwd injection. The OMA-rendered bundle (AGENTS.md + skill files)
 *      lands in this dir before each session.start, so the ACP agent reads
 *      our prompt + skills via its native discovery convention. We can't
 *      drop those into the user's project root.
 *   2. Isolation. Two parallel sessions don't see each other's transcripts
 *      or tool-call state.
 *   3. Stable transcript paths. Resume-from-disk needs the cwd to be the
 *      same next time; the user's pwd is whatever terminal they ran
 *      `npx` from this morning.
 *
 * Cleanup is GC'd, not eager — a 7-day-old session dir is removed on the
 * next daemon startup. Eager rm-on-dispose would lose the transcript that
 * powers Resume.
 *
 * The bundle (AGENTS.md + .claude/skills/...) is fetched per session.start
 * from main's `/v1/internal/runtime-session-bundle?sid=...&agent_id=...`,
 * NOT bundled into the daemon binary. That keeps prompts / skills owned by
 * the OMA platform per-tenant rather than baked into the npm-published CLI.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "./platform.js";

const GC_AGE_SECONDS = 7 * 24 * 60 * 60;
const DIR_NAME_LEN = 12;

/**
 * Derive a short, filesystem-friendly dir name from any session id. UUIDs
 * are 36 chars and look unwieldy when listed in `~/.oma/bridge/sessions/`;
 * 12 hex chars (48 bits) are short enough to scan visually but still
 * have enough entropy to avoid practical collisions. Deterministic so
 * the same session_id always maps to the same dir (resume / GC work).
 */
function dirNameFor(sessionId: string): string {
  if (/^[a-f0-9]{1,12}$/i.test(sessionId)) return sessionId.toLowerCase();
  return createHash("sha256").update(sessionId).digest("hex").slice(0, DIR_NAME_LEN);
}

/**
 * Returns the cwd path for a session; creates it if it doesn't already exist.
 * Bundle materialization is the caller's job — call writeBundle() with the
 * `files: [{path, content}]` array fetched from main's
 * `/v1/internal/runtime-session-bundle` before issuing session/new.
 */
export async function ensureSessionCwd(sessionId: string): Promise<string> {
  const cwd = join(paths().sessionsDir, dirNameFor(sessionId));
  await mkdir(cwd, { recursive: true });
  return cwd;
}

/**
 * Drop bundle files from main into a session cwd. Each entry's `path` is
 * relative to cwd, can include subdirectories (mkdir -p applied). Existing
 * files at the same path are overwritten — bundle is the source of truth
 * for AGENTS.md / `.claude/skills/...` content, and we want each session
 * spawn to reflect the latest agent config.
 */
export async function writeBundle(
  cwd: string,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const f of files) {
    if (f.path.startsWith("/") || f.path.includes("..")) continue; // refuse traversal
    const dst = join(cwd, f.path);
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, f.content);
  }
}

/**
 * Best-effort: drop session directories not touched in `GC_AGE_SECONDS`.
 * Called by the daemon on startup so reboots reclaim disk without an
 * explicit timer. Errors are swallowed — a stuck dir is preferable to a
 * crashed daemon.
 */
export async function gcOldSessions(): Promise<{ removed: number }> {
  const root = paths().sessionsDir;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0 };
    return { removed: 0 };
  }
  const cutoff = Math.floor(Date.now() / 1000) - GC_AGE_SECONDS;
  let removed = 0;
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      if (Math.floor(st.mtimeMs / 1000) > cutoff) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* skip */
    }
  }
  return { removed };
}
