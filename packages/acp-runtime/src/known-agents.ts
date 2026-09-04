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
 *   2. **Agents not in the official registry yet**: MCode and Hermes ship
 *      complete OMA entries until compatible upstream entries exist.
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
   * class" in the Console. Featured agents render in the dropdown's first group;
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
  // Aider does not ship an ACP server. This community bridge is a real ACP
  // process which invokes the installed `aider` CLI, so the upstream binary
  // is kept explicit instead of pretending `aider` itself speaks ACP.
  {
    id: "aider",
    label: "Aider",
    spec: { command: "aider-acp" },
    wraps: "aider",
    installHint:
      "install aider-chat, then build https://github.com/jorgejhms/aider-acp and put aider-acp on PATH",
    homepage: "https://github.com/jorgejhms/aider-acp",
  },
  // Kimi Code exposes a native ACP stdio server. Keep it separate from the
  // official `kimi` registry id because Harbor's Kimi Code CLI and Moonshot's
  // Kimi CLI have different launch/configuration surfaces.
  {
    id: "kimi-code",
    label: "Kimi Code",
    spec: { command: "kimi", args: ["acp"] },
    installHint: "install Kimi Code, then run `kimi acp`",
    homepage: "https://github.com/MoonshotAI/kimi-cli",
  },
  // MiMo Code is OpenCode-derived and exposes its own ACP stdio command.
  // Keep the entry overlay-only until the upstream ACP registry publishes a
  // stable canonical id and distribution recipe.
  {
    id: "mimo",
    label: "MiMo Code",
    spec: { command: "mimo", args: ["acp"] },
    install: { kind: "npm", package: "@mimo-ai/cli" },
    installHint: "npm install -g @mimo-ai/cli",
    homepage: "https://github.com/XiaomiMiMo/MiMo-Code",
  },
  // pi-acp is in the official registry. Keep an overlay entry as well so
  // network-isolated hosts can still discover it, and so wrapper audit knows
  // that the adapter also requires the upstream `pi` binary.
  {
    id: "pi-acp",
    label: "Pi",
    spec: { command: "pi-acp" },
    wraps: "pi",
    install: { kind: "npm", package: "pi-acp" },
    installHint:
      "npm install -g @earendil-works/pi-coding-agent pi-acp",
    homepage: "https://github.com/svkozak/pi-acp",
  },
  // MiniMax Code already exposes a native ACP server (`mcode acp`) but has
  // not landed in the upstream ACP registry yet. Remove this overlay once the
  // upstream id exists and has a compatible distribution entry.
  {
    id: "mcode",
    label: "MiniMax Code",
    spec: { command: "mcode", args: ["acp"] },
    install: { kind: "npm", package: "@minimax-ai/code" },
    installHint: "npm install -g @minimax-ai/code",
    homepage: "https://github.com/MiniMax-AI/minimax-code",
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
];

/** Products intentionally excluded even if a future upstream registry adds them. */
export const REMOVED_ACP_AGENT_IDS: ReadonlySet<string> = new Set(["openclaw"]);

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
