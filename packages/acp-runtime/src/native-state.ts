/**
 * Native session profiles for ACP agents.
 *
 * ACP remains the only interaction protocol. These profiles only describe
 * where an ACP-backed coding agent keeps the private session artifacts needed by
 * `session/resume` (or legacy `session/load`) after a sandbox is restored. The path knowledge is derived
 * from Harbor's installed-agent adapters unless noted otherwise.
 */

export interface AcpStatefulAgentSpec {
  /** Canonical ACP registry id. Old records may omit this. */
  id?: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export type AcpNativeStateAdapterId =
  | "claude-code"
  | "codex"
  | "gemini"
  | "opencode"
  | "pi"
  | "mcode"
  | "copilot"
  | "cortex-code"
  | "goose"
  | "junie"
  | "kimi"
  | "qwen-code"
  | "mistral-vibe"
  | "dsh"
  | "hermes";

/**
 * One native session artifact. Only these per-agent artifacts are part of the
 * portable persistence contract; the rest of the agent profile is ephemeral.
 */
export interface AcpNativeSessionArtifact {
  path: string;
  kind: "directory" | "file" | "sqlite";
  requiredForResume: boolean;
}

export interface AcpAgentStateBinding {
  adapterId: AcpNativeStateAdapterId | "opaque";
  durability: "native" | "opaque";
  /** `acp-only` retains files for inspection but does not promise resume. */
  resume: "native-and-acp" | "acp-only";
  rootPath: string;
  checkpointPath: string;
  nativePath: string;
  /** The complete and exclusive set of native files/directories to persist. */
  sessionArtifacts: readonly AcpNativeSessionArtifact[];
  agent: AcpStatefulAgentSpec;
}

export interface AcpNativeStateProfile {
  id: AcpNativeStateAdapterId;
  provenance: "harbor" | "oma";
  durability: "native";
  resume: AcpAgentStateBinding["resume"];
  matches(agent: AcpStatefulAgentSpec): boolean;
  bindEnvironment(nativePath: string): Record<string, string>;
  sessionArtifacts(nativePath: string): readonly AcpNativeSessionArtifact[];
}

const directory = (
  path: string,
  requiredForResume = true,
): AcpNativeSessionArtifact => ({
  path,
  kind: "directory",
  requiredForResume,
});

const file = (path: string, requiredForResume = true): AcpNativeSessionArtifact => ({
  path,
  kind: "file",
  requiredForResume,
});

const sqlite = (path: string, requiredForResume = true): AcpNativeSessionArtifact => ({
  path,
  kind: "sqlite",
  requiredForResume,
});

export const ACP_NATIVE_STATE_PROFILES: readonly AcpNativeStateProfile[] = [
  {
    id: "claude-code",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, [
      "claude-acp",
      "claude-agent-acp",
      "claude-code-acp",
    ]),
    bindEnvironment: (nativePath) => ({ CLAUDE_CONFIG_DIR: nativePath }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/projects`)],
  },
  {
    id: "codex",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, [
      "codex-acp",
      "codex-cli",
      "codex-acp-bridge",
    ]),
    bindEnvironment: (nativePath) => ({ CODEX_HOME: nativePath }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/sessions`)],
  },
  {
    id: "gemini",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["gemini", "gemini-cli"]),
    // Gemini appends `.gemini` below this supported isolation root.
    bindEnvironment: (nativePath) => ({ GEMINI_CLI_HOME: nativePath }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/.gemini/tmp`)],
  },
  {
    id: "opencode",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["opencode"]),
    bindEnvironment: (nativePath) => ({
      XDG_DATA_HOME: `${nativePath}/xdg-data`,
      XDG_STATE_HOME: `${nativePath}/xdg-state`,
    }),
    sessionArtifacts: (nativePath) => [
      directory(`${nativePath}/xdg-data/opencode`),
      directory(`${nativePath}/xdg-state/opencode`),
    ],
  },
  {
    id: "pi",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["pi-acp"]),
    // pi owns PI_CODING_AGENT_DIR/sessions; pi-acp separately owns the ACP
    // session-id map below HOME. Both are required for session/resume or
    // legacy session/load.
    bindEnvironment: (nativePath) => ({
      HOME: `${nativePath}/home`,
      PI_CODING_AGENT_DIR: `${nativePath}/home/.pi/agent`,
    }),
    sessionArtifacts: (nativePath) => [
      directory(`${nativePath}/home/.pi/agent/sessions`),
      file(`${nativePath}/home/.pi/pi-acp/session-map.json`),
    ],
  },
  {
    id: "mcode",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["mcode"]),
    bindEnvironment: (nativePath) => ({ MINIMAX_DATA_DIR: nativePath }),
    sessionArtifacts: (nativePath) => [
      directory(`${nativePath}/v2/sessions`),
      sqlite(`${nativePath}/v2/sqlite/runtime-state.sqlite`),
      sqlite(`${nativePath}/v2/sqlite/session-index.sqlite`),
    ],
  },
  {
    id: "copilot",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["github-copilot-cli", "copilot"]),
    bindEnvironment: (nativePath) => ({ HOME: `${nativePath}/home` }),
    sessionArtifacts: (nativePath) => [
      directory(`${nativePath}/home/.copilot/session-state`),
      sqlite(`${nativePath}/home/.copilot/session-store.db`),
    ],
  },
  {
    id: "cortex-code",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["cortex-code", "cortex"]),
    bindEnvironment: (nativePath) => ({ HOME: `${nativePath}/home` }),
    sessionArtifacts: (nativePath) => [directory(
      `${nativePath}/home/.snowflake/cortex/conversations`,
    )],
  },
  {
    id: "goose",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["goose"]),
    bindEnvironment: (nativePath) => ({
      XDG_DATA_HOME: `${nativePath}/xdg-data`,
      XDG_STATE_HOME: `${nativePath}/xdg-state`,
    }),
    sessionArtifacts: (nativePath) => [
      directory(`${nativePath}/xdg-data/goose`),
      directory(`${nativePath}/xdg-state/goose`),
    ],
  },
  {
    id: "junie",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["junie"]),
    bindEnvironment: (nativePath) => ({ HOME: `${nativePath}/home` }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/home/.junie/sessions`)],
  },
  {
    id: "kimi",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["kimi", "kimi-cli"]),
    bindEnvironment: (nativePath) => ({ KIMI_SHARE_DIR: `${nativePath}/share` }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/share/sessions`)],
  },
  {
    id: "qwen-code",
    provenance: "harbor",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["qwen-code", "qwen"]),
    bindEnvironment: (nativePath) => ({ HOME: `${nativePath}/home` }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/home/.qwen/projects`)],
  },
  {
    id: "mistral-vibe",
    provenance: "harbor",
    durability: "native",
    // Harbor captures this session chain but does not advertise resume.
    resume: "acp-only",
    matches: (agent) => matchesIdentity(agent, ["mistral-vibe", "vibe-acp", "vibe"]),
    bindEnvironment: (nativePath) => ({ VIBE_HOME: nativePath }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/logs/session`, false)],
  },
  {
    id: "dsh",
    provenance: "oma",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, [
      "dsh-acp",
      "deepseek-harness-acp",
    ]),
    // dsh-acp owns one append-only JSONL session tree. Keep provider config,
    // credentials, logs and caches outside the portable session contract.
    bindEnvironment: (nativePath) => ({
      // 0.4.6 profile composition reads $DSH_HOME/sessions; current releases
      // also honor the explicit DSH_SESSION_ROOT setting. Bind both so native
      // resume is stable across adapter versions while only sessions/ is
      // declared portable below.
      DSH_HOME: nativePath,
      DSH_SESSION_ROOT: `${nativePath}/sessions`,
    }),
    sessionArtifacts: (nativePath) => [directory(`${nativePath}/sessions`)],
  },
  {
    id: "hermes",
    provenance: "oma",
    durability: "native",
    resume: "native-and-acp",
    matches: (agent) => matchesIdentity(agent, ["hermes"]),
    bindEnvironment: (nativePath) => ({ HERMES_HOME: nativePath }),
    sessionArtifacts: (nativePath) => [sqlite(`${nativePath}/state.db`)],
  },
];

export type HarborNativeStateCoverage =
  | {
      harborId: string;
      status: "native-resume" | "native-capture";
      profileId: AcpNativeStateAdapterId;
    }
  | { harborId: string; status: "requires-acp-adapter" };

/** Harbor native-resume inventory. Non-ACP agents remain explicit gaps. */
export const HARBOR_NATIVE_STATE_COVERAGE: readonly HarborNativeStateCoverage[] = [
  { harborId: "aider", status: "requires-acp-adapter" },
  { harborId: "claude-code", status: "native-resume", profileId: "claude-code" },
  { harborId: "codex", status: "native-resume", profileId: "codex" },
  { harborId: "copilot-cli", status: "native-resume", profileId: "copilot" },
  { harborId: "cortex-code", status: "native-resume", profileId: "cortex-code" },
  { harborId: "gemini-cli", status: "native-resume", profileId: "gemini" },
  { harborId: "goose", status: "native-resume", profileId: "goose" },
  { harborId: "junie", status: "native-resume", profileId: "junie" },
  { harborId: "kimi-cli", status: "native-resume", profileId: "kimi" },
  { harborId: "kimi-code", status: "requires-acp-adapter" },
  { harborId: "mcode", status: "native-resume", profileId: "mcode" },
  { harborId: "mimo", status: "requires-acp-adapter" },
  { harborId: "opencode", status: "native-resume", profileId: "opencode" },
  { harborId: "pi", status: "native-resume", profileId: "pi" },
  { harborId: "qwen-code", status: "native-resume", profileId: "qwen-code" },
  { harborId: "vibe", status: "native-capture", profileId: "mistral-vibe" },
];

export function bindAcpAgentState(input: {
  sessionId: string;
  agent: AcpStatefulAgentSpec;
}): AcpAgentStateBinding {
  const profile = ACP_NATIVE_STATE_PROFILES.find((candidate) =>
    candidate.matches(input.agent)
  );
  const adapterId = profile?.id ?? "opaque";
  const rootPath =
    `/workspace/.openma/harness-state/acp/${encodeURIComponent(input.sessionId)}`
    + `/${adapterId}/v1`;
  const nativePath = `${rootPath}/native`;
  const sessionArtifacts = profile?.sessionArtifacts(nativePath) ?? [];
  const agent = {
    ...input.agent,
    env: {
      ...(input.agent.env ?? {}),
      ...(profile?.bindEnvironment(nativePath) ?? {}),
      OPENMA_ACP_STATE_ROOT: rootPath,
    },
  };

  return {
    adapterId,
    durability: profile?.durability ?? "opaque",
    resume: profile?.resume ?? "acp-only",
    rootPath,
    checkpointPath: `${rootPath}/acp-session.json`,
    nativePath,
    sessionArtifacts,
    agent,
  };
}

function matchesIdentity(
  agent: AcpStatefulAgentSpec,
  identities: readonly string[],
): boolean {
  if (agent.id !== undefined && identities.includes(agent.id)) return true;
  const command = agent.command.replaceAll("\\", "/").split("/").at(-1);
  return command !== undefined && identities.includes(command);
}
