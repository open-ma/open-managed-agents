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
 * Lifecycle: dir lifetime is bound to the OMA session. Cleanup happens when
 * the platform tells the daemon `session.dispose` (which fires on
 * `DELETE /v1/sessions/:id`). The daemon does NOT auto-GC by age — leaving
 * a stale dir is preferable to deleting transcripts the user might still
 * want to resume / inspect, and only the platform knows when a session
 * is truly dead.
 *
 * The bundle (AGENTS.md + .claude/skills/...) is fetched per session.start
 * from main's `/agents/runtime/sessions/:sid/bundle?agent_id=...`, NOT
 * bundled into the daemon binary. That keeps prompts / skills owned by
 * the OMA platform per-tenant rather than baked into the npm-published CLI.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "./platform.js";

const DIR_NAME_LEN = 12;

/**
 * Derive a short, filesystem-friendly dir name from any session id. UUIDs
 * are 36 chars and look unwieldy when listed in `~/.oma/bridge/sessions/`;
 * 12 hex chars (48 bits) are short enough to scan visually but still
 * have enough entropy to avoid practical collisions. Deterministic so
 * the same session_id always maps to the same dir (resume / cleanup work).
 */
function dirNameFor(sessionId: string): string {
  if (/^[a-f0-9]{1,12}$/i.test(sessionId)) return sessionId.toLowerCase();
  return createHash("sha256").update(sessionId).digest("hex").slice(0, DIR_NAME_LEN);
}

/**
 * Returns the cwd path for a session; creates it if it doesn't already exist.
 * Bundle materialization is the caller's job — call writeBundle() with the
 * `files: [{path, content}]` array fetched from main's
 * `/agents/runtime/sessions/:sid/bundle` before issuing session/new.
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
 * Remove a session's spawn cwd. Called when the platform tells the daemon
 * `session.dispose` — i.e. the user deleted the session in OMA. Best-effort:
 * a stuck dir is preferable to a crashed daemon, so errors are swallowed.
 */
export async function removeSessionCwd(sessionId: string): Promise<void> {
  const cwd = join(paths().sessionsDir, dirNameFor(sessionId));
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch {
    /* swallow — non-fatal */
  }
}
