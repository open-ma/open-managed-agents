/**
 * `oma bridge status` — print local creds + (best-effort) ping the server
 * to verify the runtime is reachable and the token is still valid.
 *
 * No daemon process discovery (would require platform-specific PID files
 * or `launchctl list` parsing). Status is "do you have a creds file" +
 * "does the server still know about you" — for "is the daemon process
 * actually running" the user can check `launchctl list | grep oma`
 * (macOS), `systemctl --user status dev.openma.bridge` (Linux),
 * `schtasks /query /tn dev.openma.bridge` (Windows), or look at the logs.
 */

import { readCreds } from "../lib/config.js";
import { paths, currentProfile } from "../lib/platform.js";
import { detectServiceKind } from "../lib/service-manager.js";
import { printBanner, log, c, sym } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { probeRuntimeToken } from "../lib/probe.js";

export async function runStatus(): Promise<void> {
  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`status${profileTag}`, PKG_VERSION);
  const p = paths();
  const creds = await readCreds();

  if (!creds) {
    log.warn("not set up — run `oma bridge setup` to register this machine");
    log.hint(`looked for ${p.credsFile}`);
    process.exit(1);
  }

  const kind = detectServiceKind();
  const row = (k: string, v: string) =>
    process.stderr.write(`  ${c.dim(k.padEnd(11))} ${v}\n`);
  row("server",     creds.serverUrl);
  row("runtime_id", creds.runtimeId);
  row("machine_id", creds.machineId);
  row("registered", new Date(creds.createdAt * 1000).toISOString());
  row("creds file", c.dim(p.credsFile));
  row("log file",   c.dim(p.logFile));
  row("service",    c.dim(`${kind}${p.serviceFile ? ` → ${p.serviceFile}` : ""}`));

  process.stderr.write("\n");
  log.step("probing server");
  const probe = await probeRuntimeToken(creds.serverUrl, creds.token);
  if (probe.ok) {
    log.ok("token accepted (server reachable)");
  } else if (probe.reason === "invalid") {
    process.stderr.write(
      `  ${sym.err()} ${c.red(`server no longer recognises this runtime (${probe.detail})`)}\n`,
    );
    log.hint("run `oma bridge setup --force` to re-register");
    process.exit(1);
  } else {
    process.stderr.write(`  ${sym.err()} ${c.red(`probe failed: ${probe.detail}`)}\n`);
    process.exit(1);
  }
  process.stderr.write("\n");
}
