/**
 * `oma bridge setup` — one-time onboarding.
 *
 *   1. Bind 127.0.0.1:<rand-port> as a single-shot HTTP server.
 *   2. Open the user's browser to https://openma.dev/connect-runtime?cb=…&state=…
 *   3. User clicks "Allow this machine" (already auth'd via session cookie).
 *      Browser POSTs /api/v1/runtimes/connect-runtime → gets one-time `code`.
 *      Browser redirects to http://127.0.0.1:<port>/cb?code=…&state=…
 *   4. Local server receives the code, returns a "✓ All set" HTML page,
 *      shuts down.
 *   5. CLI POSTs /agents/runtime/exchange { code, state, machine_id, … }
 *      and persists the returned token to credentials.json.
 *   6. Install the platform's user-scope service (launchd / systemd / Task
 *      Scheduler), which auto-starts the daemon now and at every login.
 *      With `--no-service`, the same setup process exec's into the daemon
 *      foreground instead so the user never has to type a second command.
 *   7. Exit (or never returns when exec'd into daemon).
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
import { realpathSync } from "node:fs";
import { writeCreds, readCreds, getOrCreateMachineId } from "../lib/config.js";
import { paths, currentProfile, osTag } from "../lib/platform.js";
import {
  install as installService,
  readInstalledCliEntry,
  detectServiceKind,
  lingerHint,
  type InstallOptions,
  type InstallResult,
} from "../lib/service-manager.js";
import { detectAll, loadRegistry } from "@open-managed-agents/acp-runtime/registry";
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { probeRuntimeToken } from "../lib/probe.js";
import { auditAndOfferWrappers } from "../lib/wrapper-audit.js";
import { join } from "node:path";

/** Snapshot of the current process's node + cli entry. Frozen here (not at
 *  daemon start) because system service managers don't source the user's
 *  shell — the only moment we know which node the user actually wants is
 *  when they run `oma bridge setup`. realpath unwraps the npm/.bin/oma
 *  symlink so the unit/plist/task points at the real dist/index.js, not
 *  at a shim that re-triggers shebang resolution. */
function serviceInstallOpts(): InstallOptions {
  return {
    nodePath: process.execPath,
    cliEntry: realpathSync(process.argv[1]!),
  };
}

interface SetupOpts {
  serverUrl: string;
  /** Browser-facing origin where the user authorizes this machine. Almost
   *  always the same as `serverUrl` in production (Console + API both live
   *  on the same Worker at openma.dev). Kept separate so dev/staging can
   *  point the browser at one host while the daemon hits another. */
  browserOrigin: string;
  /** When true, skip system service install. The setup process exec's
   *  into the daemon foreground at the end so the user still doesn't
   *  type a separate command — but daemon dies when the terminal closes
   *  / the user Ctrl-C's. Useful for dev/debugging and for hosts that
   *  don't have a supported service manager (legacy unix). */
  noService?: boolean;
  /** Force a fresh OAuth even if credentials.json already exists. */
  force?: boolean;
  /** Skip y/N prompts in the wrapper-install audit; install all
   *  offerable wrappers automatically. Useful for CI / scripted setup. */
  yes?: boolean;
}


export async function runSetup(opts: SetupOpts): Promise<void> {
  // Diagnostic: if setup completes but the process doesn't exit, dump
  // active handles + requests every 2s so we can find what's keeping
  // the event loop alive. Opt-in via OMA_DEBUG_HANDLES=1 to keep it
  // out of normal users' faces.
  if (process.env.OMA_DEBUG_HANDLES) {
    let tick = 0;
    const probe = setInterval(() => {
      tick += 1;
      const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles();
      const requests = (process as unknown as { _getActiveRequests: () => unknown[] })._getActiveRequests();
      const hsum = handles.map((h) => (h as { constructor?: { name?: string } })?.constructor?.name ?? "?").reduce<Record<string, number>>((a, k) => { a[k] = (a[k] ?? 0) + 1; return a; }, {});
      const rsum = requests.map((r) => (r as { constructor?: { name?: string } })?.constructor?.name ?? "?").reduce<Record<string, number>>((a, k) => { a[k] = (a[k] ?? 0) + 1; return a; }, {});
      process.stderr.write(`\n[debug t=${tick * 2}s] handles: ${JSON.stringify(hsum)} requests: ${JSON.stringify(rsum)}\n`);
    }, 2000);
    probe.unref(); // don't let the probe itself keep the loop alive
  }

  try {
    await runSetupInner(opts);
  } finally {
    // Force-exit the short-lived setup process. Node 18+'s built-in
    // fetch uses an internal undici dispatcher that holds keep-alive
    // HTTP(S) sockets open for ~5min; for a CLI command we'd rather
    // return the user's prompt immediately than wait for those to time
    // out. Without this, OMA_DEBUG_HANDLES shows 2x Socket + 1x
    // TLSSocket lingering after "Done." prints (loadRegistry CDN +
    // probeRuntimeToken API + postExchange API).
    //
    // process.exit(0) is the conventional fix in CLI tools (npm,
    // pnpm, gh all do something equivalent). Anything that NEEDS to
    // survive the exit (background analytics flush, etc.) must be
    // done before this hits — there's nothing of that shape in
    // setup today.
    setImmediate(() => process.exit(0));
  }
}

async function runSetupInner(opts: SetupOpts): Promise<void> {
  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`setup — register this machine with ${opts.serverUrl}${profileTag}`, PKG_VERSION);

  // Warm the merged ACP registry (official + OMA overlay) so subsequent
  // detect/warn/missing-list calls have the full 35+ agents available.
  // Cache lives under the profile-aware configDir; non-fatal on failure.
  await loadRegistry({ cachePath: join(paths().configDir, "registry-cache.json") });

  // Fast path: if creds already exist (and the user didn't pass --force),
  // probe the server first. This catches the "I deleted the runtime in the
  // console and re-ran setup" recovery flow — without the probe we'd happily
  // refresh the service unit and restart the daemon with a token the server
  // no longer recognizes, leaving the runtime offline with no hint why.
  //
  // Three outcomes from probeRuntimeToken:
  //   - ok          → original fast path (refresh service, kick daemon, exit)
  //   - invalid     → server forgot us; fall through to OAuth dance, same
  //                   as if --force was passed. The stale creds will be
  //                   overwritten by writeCreds() below.
  //   - unreachable → can't tell; refresh service anyway (offline tolerance)
  //                   and warn the user that we couldn't verify.
  if (!opts.force) {
    const existing = await readCreds();
    if (existing) {
      log.ok(`existing credentials found  ${c.dim(paths().credsFile)}`);
      const probe = await probeRuntimeToken(existing.serverUrl, existing.token);
      if (!probe.ok && probe.reason === "invalid") {
        log.warn(
          `server no longer recognises this runtime (${probe.detail}) — re-registering`,
        );
        log.hint(`(was runtime ${existing.runtimeId.slice(0, 8)}…)`);
        // Fall through to the OAuth path; writeCreds() will overwrite the
        // stale file with the new runtime_id + token from /exchange.
      } else {
        if (!probe.ok) {
          log.warn(`could not verify with server (${probe.detail}) — proceeding anyway`);
        } else {
          log.hint(`runtime ${existing.runtimeId.slice(0, 8)}… (use --force to re-register)`);
        }
        // Re-running `oma bridge setup` is the natural moment for a
        // user to discover "I just installed claude — should I get
        // the wrapper?". Run the audit BEFORE service refresh / exec
        // so the prompt isn't shadowed by a foreground daemon when
        // --no-service exec's at the end.
        const fastPathAgents: Array<{ id: string; binary?: string }> =
          (await detectAll()).map((a) => ({ id: a.id, binary: a.spec.command }));
        await auditAndOfferWrappers(fastPathAgents, { yes: opts.yes });
        process.stderr.write(`\n${c.bold("Up to date.")}\n\n`);
        await refreshServiceOrFallback(opts);
        // refreshServiceOrFallback may have exec'd into daemon and
        // never returned; if it did return, we exit cleanly here.
        return;
      }
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
  let agents: Array<{ id: string; binary?: string }> =
    (await detectAll()).map((a) => ({ id: a.id, binary: a.spec.command }));

  // Auto-install convenience for ACP **wrappers** — entries in the
  // merged registry that overlay marks `wraps: "<binary>"`. We DON'T
  // install anything without asking the user first: setup scans for
  // upstream agents (claude, codex, …) the user has on PATH but whose
  // ACP wrapper is missing, then prompts in a multi-select TUI.
  // Non-TTY contexts (CI, scripts piping into setup) skip prompts;
  // user can run `oma bridge agents refresh` later, same flow.
  agents = await auditAndOfferWrappers(agents, { yes: opts.yes });

  if (agents.length > 0) {
    log.ok(`agents detected  ${c.dim(agents.map((a: { id: string }) => a.id).join(", "))}`);
  } else {
    log.warn("no ACP agents on PATH yet");
    log.hint("install one, e.g. `npm i -g @agentclientprotocol/claude-agent-acp`");
  }

  await installServiceOrFallback(opts);
}

/** Slow-path tail: install the system service if supported, otherwise
 *  exec into the daemon foreground. Either way the user has a running
 *  daemon by the time this returns (or the process is gone, replaced
 *  by daemon). `--no-service` always takes the foreground path. */
async function installServiceOrFallback(opts: SetupOpts): Promise<void> {
  const kind = detectServiceKind();
  if (opts.noService || kind === "unsupported") {
    process.stderr.write("\n");
    if (kind === "unsupported") {
      log.warn(`platform service install not supported on ${process.platform}; running daemon in foreground`);
    } else {
      log.step("--no-service: starting daemon in foreground");
    }
    log.hint("Ctrl-C to stop. To run as a system service, re-run setup without --no-service.");
    process.stderr.write("\n");
    execIntoDaemon();
    return;
  }
  await installAndReport(opts);
}

/** Fast-path tail: refresh the existing service install so it picks up
 *  any new dist/index.js path (npm upgrade), or fall back to foreground
 *  daemon when service mode is off / unsupported. Same return contract
 *  as installServiceOrFallback. */
async function refreshServiceOrFallback(opts: SetupOpts): Promise<void> {
  const kind = detectServiceKind();
  if (opts.noService || kind === "unsupported") {
    // Symmetrical with installServiceOrFallback: --no-service means
    // "start daemon foreground" no matter whether we just ran OAuth
    // or just probed an existing creds file. User who wanted to bail
    // out without starting a daemon would run `oma bridge status`.
    process.stderr.write("\n");
    log.step(opts.noService ? "--no-service: starting daemon in foreground" : `service install not supported on ${process.platform}; running daemon in foreground`);
    log.hint("Ctrl-C to stop. To run as a system service, re-run setup without --no-service.");
    process.stderr.write("\n");
    execIntoDaemon();
    return;
  }
  // Warn about service-binary drift before refreshing. The service file
  // gets rewritten to whatever cliEntry the *current* process resolves
  // to, so we want to surface "your daemon was running an older binary
  // until just now" rather than silently swap it under the user.
  const installedEntry = await readInstalledCliEntry();
  const currentEntry = serviceInstallOpts().cliEntry;
  if (installedEntry && installedEntry !== currentEntry) {
    log.warn(`service was pointing at a different binary; updating`);
    log.hint(`old: ${c.dim(installedEntry)}`);
    log.hint(`new: ${c.dim(currentEntry)}`);
  }
  await installAndReport(opts);
}

/** Shared installer + reporter — install the service via the façade,
 *  print a per-platform success/warning summary so the user knows what
 *  actually happened (launchd plist installed / systemd unit started /
 *  schtasks task registered + queued). */
async function installAndReport(opts: SetupOpts): Promise<void> {
  void opts; // currently unused; kept for future flag-driven branches
  const result: InstallResult = await installService(serviceInstallOpts());
  const where = result.installedAt ? c.dim(result.installedAt) : c.dim("(no install path)");
  switch (result.kind) {
    case "launchd":
      log.ok(`launchd plist installed  ${where}`);
      log.ok(`daemon started  ${c.dim("logs: " + paths().logFile)}`);
      break;
    case "systemd":
      log.ok(`systemd unit installed  ${where}`);
      if (result.started) {
        log.ok(`daemon started  ${c.dim("logs: " + paths().logFile)}`);
      } else {
        log.warn(`unit installed but failed to start: ${result.warning ?? "unknown"}`);
        log.hint(`try: systemctl --user status ${paths().serviceLabel}`);
      }
      if (!result.lingerEnabled) {
        log.hint(lingerHint());
      }
      break;
    case "windows-task":
      log.ok(`Task Scheduler task registered  ${where}`);
      if (result.started) {
        log.ok(`daemon started  ${c.dim("logs: " + paths().logFile)}`);
      } else {
        log.warn(`task registered but failed to start now: ${result.warning ?? "unknown"}`);
        log.hint(`it will run at next logon. To start manually: schtasks /run /tn ${paths().serviceLabel}`);
      }
      break;
    case "unsupported":
      // Should never reach here — caller checked detectServiceKind.
      log.err(`platform unsupported`);
      return;
  }
  process.stderr.write("\n");
  process.stderr.write(`${c.bold("Done.")} the runtime should appear online at ${c.cyan(opts.browserOrigin)}\n\n`);
}

/** Replace this process with `oma bridge daemon` (foreground). Uses
 *  spawn+inherit so the daemon's stdio shares the user's terminal;
 *  setup process exits with the daemon's exit code. Profile is forwarded
 *  via OMA_PROFILE so the daemon uses the same configDir / service label
 *  as setup. SIGINT (Ctrl-C) flows naturally to the daemon via the
 *  shared process group. */
function execIntoDaemon(): never {
  const profile = currentProfile();
  const child = spawn(process.execPath, [process.argv[1]!, "bridge", "daemon"], {
    stdio: "inherit",
    env: { ...process.env, ...(profile ? { OMA_PROFILE: profile } : {}) },
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  // Block until child resolves — we never return.
  return new Promise(() => undefined) as never;
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
        `${browserOrigin.replace(/\/$/, "")}/connect-runtime` +
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
