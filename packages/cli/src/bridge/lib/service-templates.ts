/**
 * Pure-template builders for the macOS launchd plist, Linux systemd
 * unit, and Windows Task Scheduler .cmd shim. Split out from the
 * platform-specific install modules (launchd.ts / systemd.ts /
 * windows-task.ts) so the templates can be exercised by unit tests
 * without dragging `node:child_process` into the import graph (the
 * Cloudflare Workers test runtime, which we share across this monorepo,
 * doesn't expose it).
 *
 * All three builders inject `OMA_PROFILE` into the spawned daemon's
 * environment when set — load-bearing for the multi-profile story (see
 * service-builders.test.ts header for the regression that motivated
 * extracting these).
 */

import { dirname } from "node:path";
import { paths, currentProfile } from "./platform.js";

export interface BuilderOpts {
  /** Absolute node binary path (process.execPath of `oma bridge setup`). */
  nodePath: string;
  /** Absolute path to the cli's bundled entrypoint (dist/index.js). */
  cliEntry: string;
  /** Optional explicit PATH override; otherwise built from the setup-time PATH. */
  envPath?: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function dedupColon(p: string): string {
  const seen = new Set<string>();
  return p.split(":").filter((part) => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  }).join(":");
}

function dedupSemicolon(p: string): string {
  const seen = new Set<string>();
  return p.split(";").filter((part) => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  }).join(";");
}

/** macOS launchd plist (UTF-8 XML). Caller writes to
 *  ~/Library/LaunchAgents/<label>.plist and runs launchctl load -w. */
export function buildPlist(opts: BuilderOpts): string {
  const p = paths();
  const nodeDir = dirname(opts.nodePath);
  const setupPath = process.env.PATH ?? "";
  const envPath = opts.envPath ?? dedupColon(setupPath ? `${nodeDir}:${setupPath}` : nodeDir);
  const profile = currentProfile();
  const envBlock =
    `<key>EnvironmentVariables</key>\n  <dict>\n` +
    `    <key>PATH</key>\n    <string>${escapeXml(envPath)}</string>\n` +
    (profile
      ? `    <key>OMA_PROFILE</key>\n    <string>${escapeXml(profile)}</string>\n`
      : "") +
    `  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${p.serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.cliEntry}</string>
    <string>bridge</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${p.logFile}</string>
  <key>StandardErrorPath</key>
  <string>${p.logFile}</string>
  ${envBlock}
</dict>
</plist>
`;
}

/** Linux systemd user unit. Caller writes to
 *  ~/.config/systemd/user/<label>.service then `systemctl --user
 *  daemon-reload && systemctl --user enable --now <label>.service`. */
export function buildUnit(opts: BuilderOpts): string {
  const p = paths();
  const nodeDir = dirname(opts.nodePath);
  const setupPath = process.env.PATH ?? "";
  const envPath = opts.envPath ?? dedupColon(setupPath ? `${nodeDir}:${setupPath}` : nodeDir);
  const profile = currentProfile();
  const profileLine = profile ? `\nEnvironment=OMA_PROFILE=${profile}` : "";
  return `[Unit]
Description=OMA Bridge Daemon
Documentation=https://github.com/open-ma/open-managed-agents
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.cliEntry} bridge daemon
Restart=always
RestartSec=10
Environment=PATH=${envPath}${profileLine}
StandardOutput=append:${p.logFile}
StandardError=append:${p.logFile}

[Install]
WantedBy=default.target
`;
}

/** Windows Task Scheduler .cmd shim. Caller writes to
 *  <configDir>/daemon.cmd and `schtasks /create /tn <label> /tr "<path>"
 *  /sc onlogon /it /rl limited /f`. */
export function buildShim(opts: BuilderOpts): string {
  const nodeDir = dirname(opts.nodePath);
  const setupPath = process.env.PATH ?? "";
  const envPath = opts.envPath ?? dedupSemicolon(setupPath ? `${nodeDir};${setupPath}` : nodeDir);
  const logFile = paths().logFile;
  const profile = currentProfile();
  const lines = [
    "@echo off",
    `set "PATH=${envPath}"`,
    profile ? `set "OMA_PROFILE=${profile}"` : "",
    `"${opts.nodePath}" "${opts.cliEntry}" bridge daemon >> "${logFile}" 2>&1`,
  ].filter(Boolean);
  return lines.join("\r\n") + "\r\n";
}
