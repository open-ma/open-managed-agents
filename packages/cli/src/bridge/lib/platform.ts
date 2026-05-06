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
 *
 * Profile isolation (OMA_PROFILE env var, default empty):
 *   - Empty profile → paths exactly as the original single-tenant layout.
 *     Existing prod users see no change.
 *   - Named profile <p> → configDir becomes ~/.oma/bridge-<p>/, service
 *     label becomes dev.openma.bridge.<p>, etc. Two daemons (e.g. prod
 *     in launchd + staging in foreground) coexist without stomping each
 *     other's creds, sessions, logs, or launchd registration.
 *   See packages/cli/src/index.ts:credentialsPath for the matching cli-
 *   auth side. Both must be flipped together; OMA_PROFILE is the single
 *   source of truth.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export type Platform = "darwin" | "linux" | "win32" | "unknown";

export function currentPlatform(): Platform {
  const p = platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "unknown";
}

/**
 * Active profile slug from OMA_PROFILE. Empty string means default profile
 * (no path suffix, no Label suffix — byte-identical to the pre-profile
 * layout). Slug rules: lowercase alphanumeric + dashes, must start AND
 * end with alphanumeric (no leading/trailing dash; no `..` traversal),
 * 1-32 chars total. Restrictive enough to be filesystem-safe on every
 * OS we ship to and readable as a launchd Label suffix. Invalid values
 * throw at parse time so the user gets a clear error rather than
 * silently being routed to a malformed path. Trim whitespace because
 * env vars often pick up stray spaces.
 */
const PROFILE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export function currentProfile(): string {
  const raw = (process.env.OMA_PROFILE ?? "").trim();
  if (raw === "") return "";
  if (!PROFILE_SLUG_RE.test(raw)) {
    throw new Error(
      `OMA_PROFILE="${raw}" is not a valid profile slug. ` +
      `Expected: lowercase letters/digits/dashes, starting with letter or digit, max 32 chars.`,
    );
  }
  return raw;
}

export interface Paths {
  /** `~/.oma/bridge` (or `~/.oma/bridge-<profile>`) — root of all daemon state on every platform. */
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
  /** Service identifier — reverse-DNS style, profile-suffixed when active. */
  serviceLabel: string;
}

const SERVICE_LABEL_BASE = "dev.openma.bridge";

export function paths(): Paths {
  const home = homedir();
  const p = currentPlatform();
  const profile = currentProfile();
  // Suffix everything that needs to be unique-per-daemon. Empty profile
  // → empty suffix → identical to pre-profile layout. Named profile →
  //   ~/.oma/bridge-staging/, dev.openma.bridge.staging, …plist
  const dirSuffix = profile ? `-${profile}` : "";
  const labelSuffix = profile ? `.${profile}` : "";
  const configDir = join(home, `.oma/bridge${dirSuffix}`);
  const credsFile = join(configDir, "credentials.json");
  const machineIdFile = join(configDir, "machine-id");
  const sessionsDir = join(configDir, "sessions");
  const logFile = join(configDir, "logs", "bridge.log");
  const serviceLabel = `${SERVICE_LABEL_BASE}${labelSuffix}`;

  let serviceFile: string | null = null;
  if (p === "darwin") {
    serviceFile = join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  } else if (p === "linux") {
    serviceFile = join(home, ".config", "systemd", "user", `${serviceLabel}.service`);
  }
  return { configDir, credsFile, machineIdFile, sessionsDir, logFile, serviceFile, serviceLabel };
}

/** "darwin/arm64" — sent to server as the runtime's `os` field. */
export function osTag(): string {
  return `${platform()}/${process.arch}`;
}
