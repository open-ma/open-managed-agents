/**
 * OS paths for daemon state, logs, service files, and per-session cwd.
 *
 * Single convention across platforms: `~/.oma/bridge/` is the user-level root,
 * matching every other modern AI tool (`~/.claude`, `~/.codex`, `~/.gemini`,
 * `~/.cursor`). XDG and Library/Application-Support paths were noisier and
 * inconsistent; the one downside (slightly less Linux-purist) is acceptable.
 *
 * Service files (launchd plist / systemd user unit) stay in their
 * platform-canonical locations because the OS scans those directories —
 * we can't move them.
 *
 * Windows isn't supported in v1 for service mode — daemon command still
 * runs in foreground; users wire their own startup later.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export type Platform = "darwin" | "linux" | "win32" | "unknown";

export function currentPlatform(): Platform {
  const p = platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "unknown";
}

export interface Paths {
  /** `~/.oma/bridge` — root of all daemon state on every platform. */
  configDir: string;
  /** Credentials file (server_url, runtime_id, token, machine_id). */
  credsFile: string;
  /** Stable per-user machine fingerprint; persisted on first run. */
  machineIdFile: string;
  /** Daemon log file. */
  logFile: string;
  /** Per-session cwd root. Each spawned ACP agent gets a subdir under this. */
  sessionsDir: string;
  /** launchd plist (macOS) / systemd user unit (linux). null on win32. */
  serviceFile: string | null;
  /** Service identifier — reverse-DNS style. */
  serviceLabel: string;
}

const SERVICE_LABEL = "dev.openma.bridge";

export function paths(): Paths {
  const home = homedir();
  const p = currentPlatform();
  const configDir = join(home, ".oma/bridge");
  const credsFile = join(configDir, "credentials.json");
  const machineIdFile = join(configDir, "machine-id");
  const sessionsDir = join(configDir, "sessions");
  const logFile = join(configDir, "logs", "bridge.log");

  let serviceFile: string | null = null;
  if (p === "darwin") {
    serviceFile = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  } else if (p === "linux") {
    serviceFile = join(home, ".config", "systemd", "user", `${SERVICE_LABEL}.service`);
  }
  return { configDir, credsFile, machineIdFile, sessionsDir, logFile, serviceFile, serviceLabel: SERVICE_LABEL };
}

/** "darwin/arm64" — sent to server as the runtime's `os` field. */
export function osTag(): string {
  return `${platform()}/${process.arch}`;
}
