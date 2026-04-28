/**
 * `oma bridge setup` — one-time onboarding.
 *
 *   1. Bind 127.0.0.1:<rand-port> as a single-shot HTTP server.
 *   2. Open the user's browser to https://openma.dev/connect-daemon?cb=…&state=…
 *   3. User clicks "Allow this machine" (already auth'd via session cookie).
 *      Browser POSTs /api/v1/runtimes/connect-daemon → gets one-time `code`.
 *      Browser redirects to http://127.0.0.1:<port>/cb?code=…&state=…
 *   4. Local server receives the code, returns a "✓ All set" HTML page,
 *      shuts down.
 *   5. CLI POSTs /agents/runtime/exchange { code, state, machine_id, … }
 *      and persists the returned token to credentials.json.
 *   6. (macOS) Install launchd plist, kick it off → daemon is now persistent.
 *   7. Exit.
 *
 * The `state` is verified server-side (so a leaked code can't be used by a
 * different setup attempt) AND client-side (so the localhost callback
 * can't be poisoned by an arbitrary cross-site request to 127.0.0.1).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { writeCreds, readCreds, getOrCreateMachineId } from "../lib/config.js";
import { paths, currentPlatform, osTag } from "../lib/platform.js";
import { install as installLaunchd } from "../lib/launchd.js";
import { detectAll } from "@open-managed-agents/acp-runtime/registry";
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";

interface SetupOpts {
  serverUrl: string;
  /** Browser URL — typically same host as serverUrl but on the user-facing
   *  zone (openma.dev) rather than the API zone (app.openma.dev). */
  browserOrigin: string;
  /** When true, skip launchd install (useful for dev / non-macOS). */
  noService?: boolean;
  /** Force a fresh OAuth even if credentials.json already exists. */
  force?: boolean;
}


export async function runSetup(opts: SetupOpts): Promise<void> {
  printBanner(`setup — register this machine with ${opts.serverUrl}`, PKG_VERSION);

  // Fast path: if creds already exist (and the user didn't pass --force),
  // skip the OAuth dance and just refresh the launchd plist (binary path
  // changes when the user upgrades the npm package — the plist must be
  // re-generated to point at the new dist/cli.js). This makes
  // `npx @openma/cli@beta setup` a clean upgrade flow: same one
  // command for first install and every subsequent version bump.
  if (!opts.force) {
    const existing = await readCreds();
    if (existing) {
      log.ok(`existing credentials found  ${c.dim(paths().credsFile)}`);
      log.hint(`runtime ${existing.runtimeId.slice(0, 8)}… (use --force to re-register)`);
      if (!opts.noService && currentPlatform() === "darwin") {
        await installLaunchd({ binaryPath: process.argv[1] });
        log.ok(`launchd plist refreshed  ${c.dim(paths().serviceFile ?? "")}`);
        log.ok(`daemon restarted  ${c.dim("logs: " + paths().logFile)}`);
      } else {
        log.hint("run `oma bridge daemon` to start the bridge");
      }
      process.stderr.write(`\n${c.bold("Up to date.")}\n\n`);
      return;
    }
  }

  log.step("waiting for browser to authorize");
  const state = randomBytes(16).toString("hex");
  const code = await waitForCallback(state, opts.browserOrigin);
  log.ok("received code from browser");

  const machineId = await getOrCreateMachineId();
  const exchange = await postExchange(opts.serverUrl, {
    code,
    state,
    machine_id: machineId,
    hostname: hostname(),
    os: osTag(),
    version: PKG_VERSION,
  });
  log.ok(`runtime registered  ${c.dim(exchange.runtime_id.slice(0, 8) + "…")}`);

  await writeCreds({
    serverUrl: opts.serverUrl,
    runtimeId: exchange.runtime_id,
    token: exchange.token,
    agentApiKey: exchange.agent_api_key,
    machineId,
    createdAt: Math.floor(Date.now() / 1000),
  });
  log.ok(`credentials written  ${c.dim(paths().credsFile)}`);

  // Quick agent scan so the user can see what we'll report on first daemon
  // startup. Manifest gets re-sent on every WS attach so this is just for
  // setup-time feedback.
  const agents = await detectAll();
  if (agents.length > 0) {
    log.ok(`agents detected  ${c.dim(agents.map((a: { id: string }) => a.id).join(", "))}`);
  } else {
    log.warn("no ACP agents on PATH yet");
    log.hint("install one, e.g. `npm i -g @zed-industries/claude-code-acp`");
  }

  if (opts.noService || currentPlatform() !== "darwin") {
    process.stderr.write("\n");
    log.step("service install skipped");
    log.hint("run `oma bridge daemon` to start the bridge in the foreground");
    return;
  }

  await installLaunchd({ binaryPath: process.argv[1] });
  log.ok(`launchd plist installed  ${c.dim(paths().serviceFile ?? "")}`);
  log.ok(`daemon started  ${c.dim("logs: " + paths().logFile)}`);
  process.stderr.write("\n");
  process.stderr.write(`${c.bold("Done.")} the runtime should appear online at ${c.cyan(opts.browserOrigin)}\n\n`);
}

/** Wait for browser to redirect to localhost cb. Returns the code. */
function waitForCallback(state: string, browserOrigin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = 5 * 60 * 1000;
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* already closing */ }
      reject(new Error("setup timed out — no browser callback in 5 minutes"));
    }, timeoutMs);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/cb") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const gotState = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (gotState !== state) {
        res.writeHead(400, { "content-type": "text/plain" }).end("state mismatch");
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain" }).end("no code");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta charset=utf-8><title>Connected</title>
<style>body{font-family:system-ui;text-align:center;padding:80px;color:#333}</style>
<h1>✓ Machine connected</h1>
<p>You can close this tab and return to your terminal.</p>`,
      );
      clearTimeout(timer);
      // Defer close so the response actually flushes.
      setTimeout(() => { try { server.close(); } catch { /* */ } }, 100);
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const cb = `http://127.0.0.1:${port}/cb`;
      const target =
        `${browserOrigin.replace(/\/$/, "")}/connect-daemon` +
        `?cb=${encodeURIComponent(cb)}&state=${encodeURIComponent(state)}`;
      process.stderr.write(`→ opening ${target}\n`);
      openBrowser(target).catch((e) => {
        process.stderr.write(
          `! could not auto-open browser: ${e?.message ?? e}\n` +
            `  please open this URL manually:\n  ${target}\n`,
        );
      });
    });
  });
}

interface ExchangeResponse {
  runtime_id: string;
  token: string;
  agent_api_key?: string;
}

async function postExchange(
  serverUrl: string,
  body: { code: string; state: string; machine_id: string; hostname: string; os: string; version: string },
): Promise<ExchangeResponse> {
  const url = `${serverUrl.replace(/\/$/, "")}/agents/runtime/exchange`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`exchange failed: HTTP ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as ExchangeResponse;
  } catch {
    throw new Error(`exchange returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    const args = process.platform === "win32" ? ["", url] : [url];
    const p = spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    p.once("error", reject);
    p.unref();
    setTimeout(() => resolve(), 100);
  });
}
