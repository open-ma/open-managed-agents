/**
 * `oma bridge uninstall` — tear down launchd / systemd unit, remove
 * credentials, attempt server-side revoke. Best-effort: each step
 * continues on failure so a partially-broken install can still be cleaned.
 *
 * Server-side revoke is best-effort because:
 *   - The user may have already deleted the runtime via web UI (DELETE
 *     /api/v1/runtimes/:id), in which case our token is gone too and the
 *     call returns 401.
 *   - The user may not have network when uninstalling (laptop in airplane
 *     mode).
 *
 * Either way, the local side is what matters: stop the service, delete the
 * creds. Stale rows on server eventually GC themselves (sweeper marks
 * runtimes offline after no heartbeat; user can delete manually).
 */

import { uninstall as uninstallLaunchd } from "../lib/launchd.js";
import { readCreds, deleteCreds } from "../lib/config.js";
import { paths, currentPlatform } from "../lib/platform.js";
import { printBanner, log, c, sym } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";

export async function runUninstall(): Promise<void> {
  printBanner("uninstall — remove daemon + local credentials", PKG_VERSION);

  // Step 1: stop the service first, so it isn't in the middle of writing
  // to creds file when we delete it.
  if (currentPlatform() === "darwin") {
    try {
      const r = await uninstallLaunchd();
      if (r.removed) log.ok(`launchd plist removed  ${c.dim(paths().serviceFile ?? "")}`);
      else process.stderr.write(`${sym.dot()} ${c.dim("launchd plist not present")}\n`);
    } catch (e) {
      log.warn(`launchd uninstall failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Step 2: best-effort server-side revoke.
  const creds = await readCreds();
  if (creds) {
    const url = `${creds.serverUrl.replace(/\/$/, "")}/api/v1/runtimes/${creds.runtimeId}`;
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { "x-runtime-token": creds.token },
        // Server's DELETE requires user auth via session cookie / API token
        // — our runtime token isn't accepted there. Best-effort call;
        // expected 401. Browser-side revoke (Settings → Remove) is the
        // supported path.
      });
      process.stderr.write(`${sym.dot()} ${c.dim(`server revoke: HTTP ${res.status} (browser is the canonical revoke path)`)}\n`);
    } catch (e) {
      process.stderr.write(`${sym.dot()} ${c.dim(`server revoke skipped: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    }
  }

  // Step 3: delete creds.
  try {
    await deleteCreds();
    log.ok(`credentials removed  ${c.dim(paths().credsFile)}`);
  } catch (e) {
    log.warn(`creds removal failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  process.stderr.write(`\n${c.bold("Done.")}\n\n`);
}
