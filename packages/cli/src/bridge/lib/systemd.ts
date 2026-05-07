/**
 * Linux systemd user-unit install/uninstall.
 *
 * User-scoped (`systemctl --user`) so we don't need sudo and stay in the
 * same single-tenant mental model as the macOS launchd LaunchAgents
 * pattern: state at ~/.oma/bridge/, unit at ~/.config/systemd/user/,
 * everything keyed to the runner of `oma bridge setup`.
 *
 * Restart=always + RestartSec=10 mirrors macOS launchd KeepAlive=true +
 * ThrottleInterval=10 so a crashing daemon comes back the same way on
 * both platforms.
 *
 * Linger note: by default a `--user` systemd manager is reaped when the
 * user logs out (graphical or last ssh session), which would kill the
 * bridge until next login. `loginctl enable-linger <user>` makes the
 * user manager survive across logouts. We do NOT auto-run it (it
 * usually requires sudo / polkit) — install() just prints the one-line
 * command for the user to copy-paste once. Tailscale / cloudflared use
 * the same prompt-but-don't-elevate pattern.
 *
 * Why we call node directly instead of the `oma` shim: same reasoning
 * as launchd.ts — systemd doesn't source the user's shell init, so on
 * nvm/asdf/volta machines a `#!/usr/bin/env node` shebang fails 127
 * and the unit loops forever. We freeze process.execPath at setup time.
 */

import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { paths, currentPlatform } from "./platform.js";
import { buildUnit, type BuilderOpts } from "./service-templates.js";

export type InstallOptions = BuilderOpts;
// Re-export for back-compat. Implementation lives in service-templates
// so unit tests can exercise it without node:child_process at import.
export { buildUnit };

export interface InstallResult {
  /** True when systemd accepted the unit and started the daemon. False
   *  when the unit was written but enable/start failed (rare; the user
   *  can usually fix and `systemctl --user start <name>` manually). */
  started: boolean;
  /** True iff the user's systemd lingering is enabled (either was, or we
   *  successfully turned it on). When false, install() prints the
   *  enable-linger hint so the user knows the daemon will die on logout
   *  unless they fix it. */
  lingerEnabled: boolean;
  /** Stderr from systemctl on failure paths — surfaced so the user can
   *  diagnose without a separate journalctl detour. */
  warning?: string;
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  if (currentPlatform() !== "linux") {
    throw new Error(
      `systemd install only supported on Linux. Run \`oma bridge daemon\` in foreground or use the platform's service mechanism.`,
    );
  }
  const p = paths();
  if (!p.serviceFile) throw new Error("no service file path on this platform");

  await mkdir(dirname(p.logFile), { recursive: true });
  await mkdir(dirname(p.serviceFile), { recursive: true });
  await writeFile(p.serviceFile, buildUnit(opts), "utf-8");

  // daemon-reload picks up the new unit. enable --now combines enable
  // (autostart at next login) with start (run right now). If anything
  // fails we still consider the unit "installed" — user can poke at it
  // with systemctl manually.
  let warning: string | undefined;
  let started = true;
  try {
    await runSystemctl(["--user", "daemon-reload"]);
    await runSystemctl(["--user", "enable", "--now", `${p.serviceLabel}.service`]);
  } catch (e) {
    started = false;
    warning = (e as Error).message;
  }

  // Linger check is informational only — we never sudo. If linger is
  // off, surface the one-liner instead.
  const lingerEnabled = await isLingerEnabled().catch(() => false);

  return { started, lingerEnabled, warning };
}

export async function uninstall(): Promise<{ removed: boolean; warning?: string }> {
  if (currentPlatform() !== "linux") return { removed: false };
  const p = paths();
  if (!p.serviceFile) return { removed: false };

  // Best-effort stop+disable; either may fail if the unit was never
  // accepted or already torn down. Don't block file removal on these.
  let warning: string | undefined;
  await runSystemctl(["--user", "disable", "--now", `${p.serviceLabel}.service`])
    .catch((e) => { warning = (e as Error).message; });
  try {
    await unlink(p.serviceFile);
    await runSystemctl(["--user", "daemon-reload"]).catch(() => undefined);
    return { removed: true, warning };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw e;
  }
}

function runSystemctl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("systemctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    p.once("error", (e) => reject(new Error(`systemctl spawn failed: ${e.message}`)));
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemctl ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** True iff the current user has lingering enabled. We probe via
 *  loginctl (no sudo) which is the canonical way; absence of the user
 *  in the list, or the file at /var/lib/systemd/linger/<user>, both
 *  mean linger is off. */
async function isLingerEnabled(): Promise<boolean> {
  const user = process.env.USER ?? process.env.LOGNAME ?? "";
  if (!user) return false;
  return new Promise((resolve) => {
    const p = spawn("loginctl", ["show-user", user, "--property=Linger", "--value"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c.toString()));
    p.once("error", () => resolve(false));
    p.once("exit", () => resolve(out.trim().toLowerCase() === "yes"));
  });
}

/** One-liner the user copy-pastes to enable linger. Splitting this out
 *  lets setup.ts surface it consistently (via log.hint) without
 *  hard-coding the command in two places. */
export function lingerHint(): string {
  const user = process.env.USER ?? process.env.LOGNAME ?? "$USER";
  return `sudo loginctl enable-linger ${user}   # so daemon survives logout`;
}

/**
 * Read the cliEntry path the currently-installed unit points at, or null
 * if no unit is installed / can't be parsed. Mirrors launchd.ts equivalent
 * — used by `oma bridge setup` to detect when an npm upgrade landed a new
 * dist/index.js but the unit still points at an older path.
 */
export async function readInstalledCliEntry(): Promise<string | null> {
  const p = paths();
  if (!p.serviceFile) return null;
  let unit: string;
  try {
    unit = await readFile(p.serviceFile, "utf-8");
  } catch {
    return null;
  }
  // ExecStart=<node-path> <cli-entry> bridge daemon
  const m = unit.match(/^ExecStart=([^\s]+)\s+([^\s]+)\s+bridge\s+daemon\s*$/m);
  return m?.[2] ?? null;
}
