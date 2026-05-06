/**
 * `oma bridge agents <verb>` — manage what the daemon thinks the user
 * has installed locally.
 *
 * Subcommands:
 *   refresh [--yes]  — re-scan + offer-install in one go:
 *                       1. fetch official ACP registry, snapshot
 *                          npm/uv installs
 *                       2. audit: for each ACP wrapper whose upstream
 *                          binary the user has but whose wrapper isn't
 *                          installed → prompt y/N (binary-distributed
 *                          ones print download URL, no auto-install)
 *                       3. SIGHUP the running daemon so its manifest
 *                          reflects the new state. Sessions stay alive,
 *                          WS stays open, no ACP child gets killed.
 *                      `--yes` skips prompts and installs all offerable
 *                      wrappers (good for CI / first-time setup auto).
 *
 * Same flow runs inside `oma bridge setup` first-pair — this verb is
 * for re-running it later (after installing claude / codex / … on the
 * machine).
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths, currentProfile } from "../lib/platform.js";
import { detectAll, loadRegistry } from "@open-managed-agents/acp-runtime/registry";
import { auditAndOfferWrappers } from "../lib/wrapper-audit.js";
import { log, c } from "../lib/style.js";

export async function runAgents(args: string[]): Promise<void> {
  const sub = args[0] ?? "";
  switch (sub) {
    case "refresh":
      await refresh(args.slice(1));
      return;
    default:
      process.stderr.write(
        "oma bridge agents — manage local agent detection\n\n" +
        "  oma bridge agents refresh [--yes]   re-scan + offer-install missing ACP wrappers + signal daemon\n",
      );
      process.exit(sub ? 1 : 0);
  }
}

/**
 * Single end-to-end refresh: re-fetch registry, audit-and-offer
 * wrapper installs, signal daemon to re-publish manifest. Designed so
 * the user runs this whenever they've changed something locally
 * (installed claude / codex / removed an agent / …) — one command
 * does the right thing.
 */
async function refresh(args: string[]): Promise<void> {
  const profile = currentProfile();
  const profileTag = profile ? ` [profile=${profile}]` : "";
  const yes = args.includes("--yes") || args.includes("-y");

  // 1. Warm the registry from cdn (force refresh — the whole point
  //    here is to see updated state). Snapshots npm/uv too.
  const cachePath = join(paths().configDir, "registry-cache.json");
  await loadRegistry({ cachePath, forceRefresh: true });

  // 2. Audit + offer installs. Returns updated agent list (post-install).
  const detected = (await detectAll()).map((a) => ({ id: a.id, binary: a.spec.command }));
  await auditAndOfferWrappers(detected, { yes });

  // 3. Signal the running daemon (if any) to re-detect + re-publish.
  //    No-op when daemon isn't up — user probably just hasn't started
  //    it yet, the next `oma bridge daemon` will pick up everything
  //    on its own startup detect.
  const pidFile = join(paths().configDir, "daemon.pid");
  let pid = 0;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) pid = 0;
    if (pid) process.kill(pid, 0); // existence probe; throws if dead
  } catch {
    pid = 0;
  }
  if (pid === 0) {
    log.hint(`no running daemon${profileTag}; manifest will reflect on next \`oma bridge daemon\``);
    return;
  }
  // Soft sanity: stale pid file (>7d) — warn but still signal.
  try {
    const ageMs = Date.now() - statSync(pidFile).mtimeMs;
    if (ageMs > 7 * 24 * 3600 * 1000) {
      log.hint(`pid file is ${Math.floor(ageMs / 86_400_000)} days old`);
    }
  } catch { /* stat failed; not important */ }

  try {
    process.kill(pid, "SIGHUP");
    log.ok(`daemon${profileTag} re-detecting (pid ${pid})`);
    log.hint("Console dropdown will reflect the new state in 1–2s");
  } catch (e) {
    log.warn(`signal failed: ${(e as Error).message}`);
    process.exit(2);
  }
}
