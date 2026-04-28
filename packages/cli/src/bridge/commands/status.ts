/**
 * `oma bridge status` — print local creds + (best-effort) ping the server
 * to verify the runtime is reachable and the token is still valid.
 *
 * No daemon process discovery (would require platform-specific PID files
 * or `launchctl list` parsing). Status is "do you have a creds file" +
 * "does the server still know about you" — for "is the daemon process
 * actually running" the user can check `launchctl list | grep oma`
 * (macOS) or look at the logs.
 */

import { readCreds } from "../lib/config.js";
import { paths } from "../lib/platform.js";
import { printBanner, log, c, sym } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";

export async function runStatus(): Promise<void> {
  printBanner("status", PKG_VERSION);
  const p = paths();
  const creds = await readCreds();

  if (!creds) {
    log.warn("not set up — run `oma bridge setup` to register this machine");
    log.hint(`looked for ${p.credsFile}`);
    process.exit(1);
  }

  const row = (k: string, v: string) =>
    process.stderr.write(`  ${c.dim(k.padEnd(11))} ${v}\n`);
  row("server",     creds.serverUrl);
  row("runtime_id", creds.runtimeId);
  row("machine_id", creds.machineId);
  row("registered", new Date(creds.createdAt * 1000).toISOString());
  row("creds file", c.dim(p.credsFile));
  row("log file",   c.dim(p.logFile));
  if (p.serviceFile) row("service",    c.dim(p.serviceFile));

  process.stderr.write("\n");
  log.step("probing server");
  try {
    const wsUrl = `${creds.serverUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "")}/agents/runtime/_attach`;
    const WebSocket = (await import("ws")).default;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${creds.token}` },
      });
      ws.once("open", () => {
        log.ok("token accepted (server reachable)");
        ws.close(1000, "status probe");
        resolve();
      });
      ws.once("unexpected-response", (_req, res) => {
        reject(new Error(`HTTP ${res.statusCode}`));
      });
      ws.once("error", reject);
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
  } catch (e) {
    process.stderr.write(`  ${sym.err()} ${c.red(`probe failed: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    process.exit(1);
  }
  process.stderr.write("\n");
}
