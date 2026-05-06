/**
 * Windows Task Scheduler install/uninstall.
 *
 * Why Task Scheduler instead of Windows Service Control Manager (SCM):
 *   - SCM requires admin to install services (`sc create` needs an
 *     elevated console). For an `npm i -g @openma/cli`-installed tool
 *     that's a hard wall — the user is not in an admin shell, and we
 *     don't want a UAC prompt mid-`oma bridge setup`.
 *   - Task Scheduler with /sc onlogon and /rl limited runs at user
 *     logon under the user's own token, no admin required. Same
 *     mental model as macOS launchd LaunchAgents and Linux systemd
 *     `--user` units: per-user, no elevation.
 *   - This is what code-server, syncthing (default), and most other
 *     non-admin user-tools-with-daemons settle on.
 *
 * Logon vs boot trigger:
 *   - /sc onlogon fires when the user logs in. The daemon dies on
 *     logout (matches macOS LaunchAgent + Linux systemd-without-linger
 *     defaults). User running headless servers can use /sc onstart
 *     after manually granting elevation; that path is not in v1.
 *
 * Wrapping node + cli path:
 *   - schtasks splits /TR by spaces and is gnarly with embedded quotes.
 *     Wrap node + the cli entry in a tiny .cmd shim under
 *     %LOCALAPPDATA%\OpenMA\bridge[-profile]\daemon.cmd that calls the
 *     two with explicit quoting. Task references the shim. Easier to
 *     debug (open the shim, see the command), easier to update (rewrite
 *     the shim, re-register the task).
 *
 * Logging:
 *   - Task Scheduler doesn't redirect stdout/stderr. The shim does
 *     `>>logfile 2>&1` so we get the same single-file log story as
 *     launchd / systemd (StandardOutPath / StandardOutput=append:).
 */

import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { paths, currentPlatform } from "./platform.js";

export interface InstallOptions {
  /** Absolute path to the node binary to spawn. process.execPath. */
  nodePath: string;
  /** Absolute path to the cli's bundled entrypoint (dist/index.js). */
  cliEntry: string;
  /** PATH to expose to the daemon process. Defaults to setup-time PATH
   *  with dirname(nodePath) prepended. */
  envPath?: string;
}

export interface InstallResult {
  /** True when schtasks accepted the task and the daemon is queued to
   *  run at next logon (or already running, see startedNow). */
  registered: boolean;
  /** True iff `schtasks /run` succeeded — daemon is running right now,
   *  not just queued for next logon. */
  startedNow: boolean;
  /** Path to the `.cmd` shim the task invokes. Surfaced in logs so the
   *  user can inspect it. */
  shimPath: string;
  warning?: string;
}

/** Where the shim lives. Mirrors the per-profile configDir layout of
 *  the unix platforms (~/.oma/bridge or bridge-<profile>) so all per-
 *  daemon state collects in one place. */
function shimPath(): string {
  return join(paths().configDir, "daemon.cmd");
}

function buildShim(opts: InstallOptions): string {
  const nodeDir = dirname(opts.nodePath);
  const setupPath = process.env.PATH ?? "";
  const envPath = opts.envPath ?? dedupPathSemicolon(setupPath ? `${nodeDir};${setupPath}` : nodeDir);
  const logFile = paths().logFile;

  // Windows .cmd, not .bat — both work but .cmd is the modern choice
  // (no auto-quoting differences from inherited cmd.exe of yore).
  // @echo off keeps the command itself out of the log.
  // Append, don't overwrite, so logs survive across daemon restarts.
  return [
    "@echo off",
    `set "PATH=${envPath}"`,
    `"${opts.nodePath}" "${opts.cliEntry}" bridge daemon >> "${logFile}" 2>&1`,
  ].join("\r\n") + "\r\n";
}

function dedupPathSemicolon(p: string): string {
  const seen = new Set<string>();
  return p.split(";").filter((part) => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  }).join(";");
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  if (currentPlatform() !== "win32") {
    throw new Error(`Windows Task Scheduler install only supported on Windows.`);
  }
  const p = paths();

  // Lay down the shim + log directory + per-session sessions dir base
  // — same prep launchd/systemd do for their respective platforms.
  await mkdir(dirname(p.logFile), { recursive: true });
  await mkdir(p.configDir, { recursive: true });
  const shim = shimPath();
  await writeFile(shim, buildShim(opts), "utf-8");

  // /tn = task name; /tr = command; /sc onlogon = trigger at user logon;
  // /it = run only when user is logged on (not the SYSTEM session);
  // /rl limited = use the user's standard token (no admin elevation);
  // /f = overwrite if exists (idempotent re-runs of `oma bridge setup`).
  const taskName = p.serviceLabel;
  const args = [
    "/create", "/tn", taskName,
    "/tr", `"${shim}"`,
    "/sc", "onlogon",
    "/it",
    "/rl", "limited",
    "/f",
  ];

  let warning: string | undefined;
  try {
    await runSchtasks(args);
  } catch (e) {
    return { registered: false, startedNow: false, shimPath: shim, warning: (e as Error).message };
  }

  // Kick it off now so the user sees the daemon online without a logout/
  // login dance. /run is non-blocking — schtasks returns once the task
  // has been queued to start.
  let startedNow = true;
  try {
    await runSchtasks(["/run", "/tn", taskName]);
  } catch (e) {
    startedNow = false;
    warning = (e as Error).message;
  }

  return { registered: true, startedNow, shimPath: shim, warning };
}

export async function uninstall(): Promise<{ removed: boolean; warning?: string }> {
  if (currentPlatform() !== "win32") return { removed: false };
  const p = paths();
  const taskName = p.serviceLabel;

  // /end stops a running instance; /delete removes the task. Both are
  // best-effort: the user may have manually deleted via taskschd.msc.
  let warning: string | undefined;
  await runSchtasks(["/end", "/tn", taskName]).catch(() => undefined);
  let removed = false;
  try {
    await runSchtasks(["/delete", "/tn", taskName, "/f"]);
    removed = true;
  } catch (e) {
    // Task might have already been deleted; surface the message but
    // don't throw — caller's UX wants a soft "not present" not an error.
    warning = (e as Error).message;
  }

  // Best-effort shim cleanup. Leaving it behind is harmless (configDir
  // also holds creds, sessions, log) but the symmetry with launchd /
  // systemd uninstall (which removes their plist / unit) is nicer.
  try { await unlink(shimPath()); } catch { /* missing is fine */ }
  return { removed, warning };
}

function runSchtasks(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("schtasks.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c.toString()));
    p.stderr.on("data", (c) => (stderr += c.toString()));
    p.once("error", (e) => reject(new Error(`schtasks spawn failed: ${e.message}`)));
    p.once("exit", (code) => {
      if (code === 0) resolve();
      // schtasks writes some errors to stdout (not stderr); merge for
      // the message so the user sees the actual cause.
      else reject(new Error(`schtasks ${args.join(" ")} exited ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}

// homedir intentionally unused — `paths()` already routes through it.
// Re-exported for parity with launchd.ts / systemd.ts callers; lets
// other code log "shim at <path>" without recomputing.
export { homedir };

/**
 * Read the cliEntry path the currently-installed task points at by
 * inspecting the .cmd shim. Returns null if the shim isn't present or
 * can't be parsed. Mirrors launchd.ts / systemd.ts equivalents.
 */
export async function readInstalledCliEntry(): Promise<string | null> {
  let shim: string;
  try {
    shim = await readFile(shimPath(), "utf-8");
  } catch {
    return null;
  }
  // Line shape (with both paths quoted):
  //   "<node>" "<cliEntry>" bridge daemon >> "<log>" 2>&1
  const m = shim.match(/^"([^"]+)"\s+"([^"]+)"\s+bridge\s+daemon/m);
  return m?.[2] ?? null;
}
