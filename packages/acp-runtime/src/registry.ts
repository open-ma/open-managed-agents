/**
 * Catalog of well-known ACP agents and a `which`-style detector.
 *
 * The registry is hardcoded on purpose. Users who want to spawn something
 * not on this list go through `AgentSpec` directly — the registry exists
 * to give chat UIs (clash, etc.) a sensible default dropdown without
 * making the user type a binary path.
 *
 * Entries should match what the project actually publishes. Keep the
 * `installHint` so a missing-binary error message can suggest the fix.
 */

import { spawn } from "node:child_process";
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
}

export const KNOWN_ACP_AGENTS: KnownAgentEntry[] = [
  {
    id: "claude-code-acp",
    label: "Claude Code",
    spec: { command: "claude-code-acp" },
    installHint: "npm install -g @zed-industries/claude-code-acp",
    homepage: "https://github.com/zed-industries/claude-code-acp",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    spec: { command: "codex", args: ["--acp"] },
    installHint: "npm install -g @openai/codex",
    homepage: "https://github.com/openai/codex",
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    spec: { command: "gemini", args: ["--experimental-acp"] },
    installHint: "npm install -g @google/gemini-cli",
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "opencode",
    label: "OpenCode",
    spec: { command: "opencode", args: ["acp"] },
    installHint: "https://opencode.ai/docs/ — Go binary, install via the platform package or https://opencode.ai/install.sh",
    homepage: "https://opencode.ai/",
  },
  {
    id: "hermes",
    label: "Hermes (Nous Research)",
    spec: { command: "hermes", args: ["acp"] },
    installHint: "see https://hermes-agent.nousresearch.com/docs/installation/",
    homepage: "https://github.com/NousResearch/hermes-agent",
  },
  {
    // Meta-CLI from openclaw that can wrap many non-native-ACP agents
    // (openclaw, cursor, pi, kiro, qwen). We ship one entry pointing at
    // openclaw because that's the most-asked-for; users can always pass
    // their own AgentSpec to wrap a different one.
    id: "openclaw",
    label: "OpenClaw (via acpx)",
    spec: { command: "acpx", args: ["openclaw"] },
    installHint: "npm install -g acpx",
    homepage: "https://github.com/openclaw/acpx",
  },
];

/**
 * Returns the KnownAgentEntry whose binary is on $PATH, else `null`.
 * Intentionally Node-only — relies on `child_process.spawn`. A web-ui that
 * wants to render a list can call this server-side or in the bridge process.
 */
export async function detect(id: string): Promise<KnownAgentEntry | null> {
  const entry = KNOWN_ACP_AGENTS.find((e) => e.id === id);
  if (!entry) return null;
  return (await isOnPath(entry.spec.command)) ? entry : null;
}

/** Run `which` (or `where` on Windows). Resolves to true iff exit code 0. */
function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const p = spawn(probe, [cmd], { stdio: "ignore" });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
}

/** Detect every known agent. Useful for "list available agents" UI. */
export async function detectAll(): Promise<KnownAgentEntry[]> {
  const results = await Promise.all(KNOWN_ACP_AGENTS.map((e) => detect(e.id)));
  return results.filter((e): e is KnownAgentEntry => e !== null);
}
