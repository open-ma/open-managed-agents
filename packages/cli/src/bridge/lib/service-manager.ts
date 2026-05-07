/**
 * Service-manager façade — single entry-point that dispatches to
 * launchd (macOS) / systemd (Linux) / Task Scheduler (Windows). All
 * three install per-user, no admin/sudo required for any of them.
 *
 * Setup, status, and uninstall import only this file. The platform-
 * specific modules (launchd.ts / systemd.ts / windows-task.ts) stay
 * focused on producing well-formed unit/plist/task content + invoking
 * the right system tool — they don't know about each other.
 *
 * `kind` field on the result tells the caller which platform mechanism
 * actually ran, so log messages can stay specific ("launchd plist
 * installed at …") without each caller re-checking process.platform.
 */

import { currentPlatform, paths } from "./platform.js";
import * as launchd from "./launchd.js";
import * as systemd from "./systemd.js";
import * as windowsTask from "./windows-task.js";

export type ServiceKind = "launchd" | "systemd" | "windows-task" | "unsupported";

export interface InstallOptions {
  /** Absolute node path (process.execPath of the setup process). */
  nodePath: string;
  /** Absolute path to the cli's bundled entrypoint (dist/index.js). */
  cliEntry: string;
}

export interface InstallResult {
  kind: ServiceKind;
  /** Per-platform path the user can inspect:
   *    - launchd  → ~/Library/LaunchAgents/dev.openma.bridge.plist
   *    - systemd  → ~/.config/systemd/user/dev.openma.bridge.service
   *    - windows  → %LOCALAPPDATA%/.../daemon.cmd shim path
   *    - unsupported → null */
  installedAt: string | null;
  /** True when the daemon was started (or is queued to start at next
   *  logon for windows-task; the kind tells you which). */
  started: boolean;
  /** Human-readable warning message when something soft-failed —
   *  systemctl couldn't start, schtasks /run failed, etc. The unit /
   *  plist / task is usually still installed; the user can recover
   *  with one manual command. */
  warning?: string;
  /** Linux-only: whether `loginctl enable-linger <user>` is on. When
   *  false, callers should surface lingerHint() so the user knows the
   *  daemon will die on logout. Other platforms always return true
   *  (not applicable). */
  lingerEnabled: boolean;
}

export interface UninstallResult {
  kind: ServiceKind;
  removed: boolean;
  warning?: string;
}

/** Which service mechanism applies to the current host. Surfaced for
 *  log messages and for the "this platform doesn't support service
 *  install" branch in setup. */
export function detectServiceKind(): ServiceKind {
  switch (currentPlatform()) {
    case "darwin": return "launchd";
    case "linux":  return "systemd";
    case "win32":  return "windows-task";
    default:       return "unsupported";
  }
}

export async function install(opts: InstallOptions): Promise<InstallResult> {
  const kind = detectServiceKind();
  if (kind === "launchd") {
    await launchd.install(opts);
    return {
      kind,
      installedAt: paths().serviceFile,
      started: true,           // launchctl load -w starts immediately
      lingerEnabled: true,     // n/a on macOS
    };
  }
  if (kind === "systemd") {
    const r = await systemd.install(opts);
    return {
      kind,
      installedAt: paths().serviceFile,
      started: r.started,
      warning: r.warning,
      lingerEnabled: r.lingerEnabled,
    };
  }
  if (kind === "windows-task") {
    const r = await windowsTask.install(opts);
    return {
      kind,
      installedAt: r.shimPath,
      started: r.startedNow,
      warning: r.warning,
      lingerEnabled: true,     // n/a on windows
    };
  }
  return { kind, installedAt: null, started: false, lingerEnabled: true };
}

export async function uninstall(): Promise<UninstallResult> {
  const kind = detectServiceKind();
  if (kind === "launchd") {
    const r = await launchd.uninstall();
    return { kind, removed: r.removed };
  }
  if (kind === "systemd") {
    const r = await systemd.uninstall();
    return { kind, removed: r.removed, warning: r.warning };
  }
  if (kind === "windows-task") {
    const r = await windowsTask.uninstall();
    return { kind, removed: r.removed, warning: r.warning };
  }
  return { kind, removed: false };
}

/** Read the cliEntry path the currently-installed service points at,
 *  or null if no service is installed / unreadable / not supported. */
export async function readInstalledCliEntry(): Promise<string | null> {
  const kind = detectServiceKind();
  if (kind === "launchd")      return launchd.readInstalledCliEntry();
  if (kind === "systemd")      return systemd.readInstalledCliEntry();
  if (kind === "windows-task") return windowsTask.readInstalledCliEntry();
  return null;
}

/** Linux-only convenience: the one-liner the user should run if linger
 *  is off. Empty string on platforms where it doesn't apply, so callers
 *  can `if (hint) log.hint(hint)` blindly. */
export function lingerHint(): string {
  return detectServiceKind() === "systemd" ? systemd.lingerHint() : "";
}
