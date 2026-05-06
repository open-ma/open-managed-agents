/**
 * OMA's static overlay over the official ACP registry — pure data, browser-safe.
 *
 * The official registry at https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 * is the source of truth for ACP-compatible agents (35+ entries, auto-updated
 * hourly). This file holds only the deltas OMA needs on top:
 *
 *   1. **Legacy aliases**: pre-registry AgentConfig rows in our DB use ids
 *      that don't match the official registry's slugs. We keep those ids
 *      as `aliases` so existing customers don't see broken sessions after
 *      the registry switch. Same mechanism that handled the
 *      claude-code-acp → claude-agent-acp rename.
 *
 *   2. **Agents not in the official registry yet**: hermes (Nous Research,
 *      pip-install only) and openclaw (gateway-bridge mode) have no entry
 *      upstream. OMA users still want them, so we ship full entries here.
 *
 * Browser-safe (no node deps): the daemon resolves `aliases` and the
 * Console renders `installHint` for our overlay-only entries. The daemon
 * additionally fetches the full official registry at runtime
 * (registry-fetch.ts) and merges; the Console can stay overlay-only and
 * trust whatever the daemon's `hello` manifest reports as detected.
 */

import type { AgentSpec } from "./types.js";

export interface KnownAgentEntry {
  /** Canonical id used by hosts and dropdowns. Slug-only, no spaces. */
  id: string;
  /** Human-readable name for UI. */
  label: string;
  /** Spec used when this agent is selected. */
  spec: AgentSpec;
  /** Suggested install command, surfaced when detect() returns false. */
  installHint?: string;
  /** Where to learn more / file bugs. */
  homepage?: string;
  /**
   * Legacy / pre-rename ids that resolve to this entry. Used to keep
   * pre-registry-switch `AgentConfig.runtime_binding.acp_agent_id` rows
   * working after id changes. Daemon canonicalizes via
   * `resolveKnownAgent()` before spawning so old rows still spawn the
   * current binary; UI dropdowns only show the canonical id.
   *
   * Note: aliases are for ID resolution only. Deprecated *binaries* are
   * not auto-spawned — if `spec.command` isn't on PATH, detect() returns
   * null and the user must install the canonical wrapper.
   */
  aliases?: string[];
  /**
   * UI signal: this agent is one of the four OMA promotes as "first
   * class" in the Console (claude-acp, codex-acp, openclaw, hermes as
   * of v0.3.x). Featured agents render in the dropdown's first group;
   * other detected agents render below. Set by overlay only — official
   * entries are never featured-by-default.
   */
  featured?: boolean;
  /**
   * If set, this entry is an ACP **wrapper** around a separate upstream
   * binary (e.g. claude-acp wraps `claude`, codex-acp wraps `codex`).
   * `wraps` holds the upstream binary name daemon-setup checks for: when
   * that binary is on PATH but the wrapper isn't, OMA can offer to
   * install the wrapper (see `install` for the recipe). Leave unset for
   * "agent itself" entries (gemini, hermes, opencode — these have
   * built-in ACP and aren't wrappers, so OMA never installs them; users
   * install on their own and the daemon detects them).
   */
  wraps?: string;
  /**
   * How to install this wrapper. Decoupled from `spec` because spec
   * describes how to SPAWN once installed (e.g. `claude-agent-acp` as a
   * direct binary), while install describes the package-manager step
   * to GET the wrapper on PATH (e.g. `npm install -g <pkg>`). Only
   * meaningful when `wraps` is also set.
   *   - `npm`:    `npm install -g <package>` — auto-installable via npm
   *   - `binary`: per-platform tarball/zip from a release URL — auto
   *               -installable via the cli's binary downloader
   *               (extracts to ~/.local/share/oma/wrappers/<id>/ and
   *               symlinks the cmd into ~/.local/bin/). Missing platform
   *               key falls back to the manual `downloadUrl` hint.
   * Future kinds (`uvx`, `homebrew`, …) extend the union.
   */
  install?:
    | { kind: "npm"; package: string }
    | {
        kind: "binary";
        /**
         * Per-platform archive recipe, keyed by `<os>-<arch>` matching
         * the official ACP registry's keys (`darwin-aarch64`,
         * `linux-x86_64`, `windows-x86_64`, …). Missing key = the
         * upstream doesn't ship a build for this host; OMA falls back
         * to printing `downloadUrl` for the user to handle manually.
         *
         * `cmd` is the path inside the extracted archive root (registry
         * convention: leading `./`, may be nested e.g.
         * `./dist-package/cursor-agent`). The downloader symlinks
         * basename(cmd) into ~/.local/bin/.
         */
        archives: Partial<Record<string, { url: string; cmd: string }>>;
        /** Manual download page; used when the user's platform isn't in
         *  `archives`, or as a fallback hint in the audit. */
        downloadUrl?: string;
      };
}

/**
 * Static overlay only. Daemon merges this with the live official registry
 * via registry.ts:loadRegistry(). Same-id entries from official + overlay
 * MERGE: overlay's spec/aliases/legacySpec win, official supplies the
 * label/install hint/homepage if missing. Overlay-only entries (no
 * matching official id) just append.
 */
export const OMA_OVERLAY_AGENTS: KnownAgentEntry[] = [
  // claude-acp: ACP wrapper around the user's `claude` binary. setup
  // and `bridge agents refresh` offer y/N install via npm. spec uses
  // the bare binary (faster spawn than `npx -y` per turn); install
  // tells the audit how to get the binary onto PATH.
  {
    id: "claude-acp",
    label: "Claude Agent",
    spec: { command: "claude-agent-acp" },
    aliases: ["claude-agent-acp", "claude-code-acp"],
    featured: true,
    wraps: "claude",
    install: { kind: "npm", package: "@agentclientprotocol/claude-agent-acp" },
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
    homepage: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
  // codex-acp: ACP wrapper around the user's `codex` binary. Zed
  // Industries' Rust binary; distributed as GitHub release tarballs +
  // an npm mirror. We leave `install` unset here so mergeOverlay picks
  // up the per-platform archives from the live registry — keeps overlay
  // a single source of truth (no version-pinned URLs to bit-rot).
  {
    id: "codex-acp",
    label: "Codex CLI",
    spec: { command: "codex-acp" },
    aliases: ["codex-cli", "codex-acp-bridge"],
    featured: true,
    wraps: "codex",
    installHint: "download from https://github.com/zed-industries/codex-acp/releases and place on PATH",
    homepage: "https://github.com/zed-industries/codex-acp",
  },
  // gemini: official id is `gemini`. Pre-registry OMA had `gemini-cli`.
  {
    id: "gemini",
    label: "Gemini CLI",
    spec: { command: "gemini", args: ["--acp"] },
    aliases: ["gemini-cli"],
    installHint: "npm install -g @google/gemini-cli",
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
  // opencode: official id matches ours, no alias needed. Listed here
  // anyway so the Console (overlay-only) still sees it without needing
  // a CDN fetch.
  {
    id: "opencode",
    label: "OpenCode",
    spec: { command: "opencode", args: ["acp"] },
    installHint: "npm install -g opencode-ai@latest  # or curl -fsSL https://opencode.ai/install | bash",
    homepage: "https://opencode.ai/",
  },
  // hermes: NOT in official registry. Python-packaged; the official
  // installer downloads + sets up the global `hermes` binary. We ship a
  // full entry so it appears in install hints even though the registry
  // doesn't know about it.
  {
    id: "hermes",
    label: "Hermes (Nous Research)",
    spec: { command: "hermes", args: ["acp"] },
    featured: true,
    installHint: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    homepage: "https://github.com/NousResearch/hermes-agent",
  },
  // openclaw: NOT in official registry. The `openclaw` cli's `acp`
  // subcommand exposes an ACP bridge that forwards to the OpenClaw
  // Gateway. Distinct from `acpx` (an ACP CLIENT, same GH org).
  {
    id: "openclaw",
    label: "OpenClaw",
    spec: { command: "openclaw", args: ["acp"] },
    featured: true,
    installHint: "npm install -g openclaw",
    homepage: "https://github.com/openclaw/openclaw",
  },
];

/**
 * Sync resolver against the static overlay only. Suitable for browser
 * (Console) and CF Worker (apps/main) — both need the alias data for
 * canonicalize but neither should fetch the live registry on the hot
 * path. Daemon code should prefer registry.ts:resolveKnownAgent which
 * checks the merged (overlay + official) cache first.
 */
export function resolveOverlayAgent(id: string): KnownAgentEntry | null {
  for (const e of OMA_OVERLAY_AGENTS) {
    if (e.id === id) return e;
    if (e.aliases?.includes(id)) return e;
  }
  return null;
}

// Back-compat aliases for the names this module exported before we
// switched to "official + overlay" merging. Browser bundles + the CF
// Worker import these by name; keeping them lets us avoid touching
// every callsite in this PR. Daemon-side code should migrate to the
// async registry.ts:loadRegistry / getKnownAgents / resolveKnownAgent.
export { OMA_OVERLAY_AGENTS as KNOWN_ACP_AGENTS };
export { resolveOverlayAgent as resolveKnownAgent };

