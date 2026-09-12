import {
  ACP_NATIVE_STATE_PROFILES,
  bindAcpAgentState,
  type AcpAgentStateBinding,
  type AcpNativeStateAdapterId,
  type AcpStatefulAgentSpec,
} from "./native-state.js";

/**
 * The small amount of per-agent knowledge needed before an ACP child starts.
 *
 * This is intentionally a descriptor, not a second agent protocol. It is the
 * OpenMA equivalent of Harbor's installed-agent adapter metadata: callers can
 * tell whether native files can be resumed without knowing provider paths or
 * branching on every agent id in the runtime host.
 */
export interface AcpSandboxAgentAdapterDescriptor {
  readonly id: AcpNativeStateAdapterId | "opaque";
  readonly provenance: "harbor" | "oma";
  readonly nativeResume: boolean;
}

export interface AcpSandboxAgentLifecyclePolicy {
  /** A host replacement keeps the session namespace for the next owner. */
  readonly onShutdown: "retain";
  /** A child crash keeps state so the next attempt can resume or recover. */
  readonly onCrash: "retain-and-recover";
  /** Explicit session destruction removes the isolated session namespace. */
  readonly onDestroy: "delete";
}

export interface AcpSandboxAgentLaunchSpec {
  readonly command: string;
  readonly args?: string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * Provider-neutral preparation result for an ACP harness-in-sandbox run.
 *
 * `binding` is the persistence contract and `launch` is the process contract.
 * Keeping them together makes the Harbor-style prepare step explicit while
 * leaving ACP initialize/resume/prompt and the outer lease supervisor where
 * they already belong.
 */
export interface AcpSandboxAgentPreparation {
  readonly adapter: AcpSandboxAgentAdapterDescriptor;
  readonly binding: AcpAgentStateBinding;
  readonly launch: AcpSandboxAgentLaunchSpec;
  readonly lifecycle: AcpSandboxAgentLifecyclePolicy;
}

/** Minimal filesystem/process surface required by the installed-agent state adapter. */
export interface AcpSandboxAgentStatePort {
  writeFile(path: string, content: string): Promise<unknown>;
  exec(command: string): Promise<string>;
}

export type AcpSandboxAgentReleaseReason = "replace" | "shutdown" | "destroy";

export interface ManagedMcpServerForSandbox {
  readonly name: string;
  readonly type: string;
  readonly url?: string;
}

export interface ProjectedAcpHttpMcpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: [{ name: "Authorization"; value: string }];
}

const LIFECYCLE_POLICY: AcpSandboxAgentLifecyclePolicy = {
  onShutdown: "retain",
  onCrash: "retain-and-recover",
  onDestroy: "delete",
};

const OPAQUE_ADAPTER: AcpSandboxAgentAdapterDescriptor = {
  id: "opaque",
  provenance: "oma",
  nativeResume: false,
};

export interface ManagedMcpProxyCapability {
  gatewayBaseUrl: string;
  sessionsToken: string;
}

/** Decode only the official self-hosted Work secret fields needed by an ACP
 * child. Invalid or absent input is a capability miss, never a reason to fall
 * back to the original upstream MCP URL. */
export function managedMcpProxyFromWorkEnvironment(input: {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_WORK_SECRET?: string;
}): ManagedMcpProxyCapability | null {
  if (!input.ANTHROPIC_WORK_SECRET) return null;
  try {
    const normalized = input.ANTHROPIC_WORK_SECRET
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - normalized.length % 4) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {
      sessions_token?: unknown;
      api_base_url?: unknown;
    };
    const sessionsToken = decoded.sessions_token;
    const gatewayBaseUrl = typeof decoded.api_base_url === "string"
      ? decoded.api_base_url
      : input.ANTHROPIC_BASE_URL;
    if (
      typeof sessionsToken !== "string" || sessionsToken.length === 0
      || typeof gatewayBaseUrl !== "string" || gatewayBaseUrl.length === 0
    ) {
      return null;
    }
    const gateway = new URL(gatewayBaseUrl);
    if (gateway.protocol !== "http:" && gateway.protocol !== "https:") return null;
    return { gatewayBaseUrl, sessionsToken };
  } catch {
    return null;
  }
}

/**
 * Convert control-plane MCP declarations into the ACP transport handed to an
 * agent running inside a sandbox.  The upstream URL is intentionally discarded:
 * Vault resolution and OAuth refresh stay behind OpenMA's HTTP MCP gateway.
 *
 * `sessionsToken` is the already-present, short-lived Work capability — never
 * an upstream credential.  It remains in an Authorization header so it cannot
 * leak through URL logs, history, redirects, or checkpoint filenames.
 */
export function projectAcpSandboxMcpServers(input: {
  sessionId: string;
  gatewayBaseUrl: string;
  sessionsToken: string;
  servers: readonly ManagedMcpServerForSandbox[];
}): ProjectedAcpHttpMcpServer[] {
  if (input.sessionId.length === 0 || input.sessionsToken.length === 0) {
    throw new Error("ACP sandbox MCP proxy requires a Session id and Work token");
  }
  const gateway = new URL(input.gatewayBaseUrl);
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("ACP sandbox MCP proxy gateway must use HTTP or HTTPS");
  }
  gateway.username = "";
  gateway.password = "";
  gateway.search = "";
  gateway.hash = "";
  return input.servers.flatMap((server) => {
    if (!server.url || server.type === "stdio" || server.type === "stdio_proxy") {
      return [];
    }
    const url = new URL(gateway.origin);
    url.pathname = [
      "v1",
      "oma",
      "mcp-proxy",
      encodeURIComponent(input.sessionId),
      encodeURIComponent(server.name),
    ].join("/");
    return [{
      type: "http" as const,
      name: server.name,
      url: url.toString(),
      headers: [{
        name: "Authorization" as const,
        value: `Bearer ${input.sessionsToken}`,
      }],
    }];
  });
}

/** Resolve Harbor-derived/OMA native state metadata without starting a child. */
export function resolveAcpSandboxAgentAdapter(
  agent: AcpStatefulAgentSpec,
): AcpSandboxAgentAdapterDescriptor {
  const profile = ACP_NATIVE_STATE_PROFILES.find((candidate) =>
    candidate.matches(agent)
  );
  if (!profile) return OPAQUE_ADAPTER;
  return {
    id: profile.id,
    provenance: profile.provenance,
    nativeResume: profile.resume === "native-and-acp",
  };
}

/**
 * Prepare one ACP child using the matching native-state adapter.
 *
 * The returned launch environment contains only the caller's declared
 * process environment plus the adapter's isolated state roots. Credentials
 * are intentionally not inferred from native files; the host/vault layer
 * remains responsible for model endpoint injection.
 */
export function prepareAcpSandboxAgent(input: {
  sessionId: string;
  agent: AcpStatefulAgentSpec;
}): AcpSandboxAgentPreparation {
  const binding = bindAcpAgentState(input);
  const adapter = resolveAcpSandboxAgentAdapter(input.agent);
  return {
    adapter,
    binding,
    launch: {
      command: binding.agent.command,
      args: binding.agent.args ? [...binding.agent.args] : undefined,
      cwd: binding.agent.cwd ?? "/workspace",
      env: { ...(binding.agent.env ?? {}) },
    },
    lifecycle: LIFECYCLE_POLICY,
  };
}

/** Publish the exact native-session allowlist before the child can write state. */
export async function materializeAcpSandboxAgentState(
  sandbox: AcpSandboxAgentStatePort,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  const binding = preparation.binding;
  await sandbox.writeFile(
    `${binding.rootPath}/session-binding.json`,
    `${JSON.stringify({
      version: 1,
      adapter_id: binding.adapterId,
      durability: binding.durability,
      resume: binding.resume,
      session_artifacts: binding.sessionArtifacts,
    })}\n`,
  );
}

/**
 * Check all artifacts that the selected adapter requires for native resume.
 * Any failed/indeterminate probe is treated as absent so callers fall back to
 * canonical-event recovery instead of sending a stale ACP session id.
 */
export async function hasRequiredAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<boolean> {
  const required = preparation.binding.sessionArtifacts.filter(
    (artifact) => artifact.requiredForResume,
  );
  for (const artifact of required) {
    const predicate = artifact.kind === "directory" ? "-d" : "-f";
    try {
      const result = await sandbox.exec(
        `if [ ${predicate} ${shellQuote(sandboxShellPath(artifact.path))} ]; then printf present; else printf missing; fi`,
      );
      if (result.trim() !== "present") return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Copy only the adapter-declared native session artifacts into the durable
 * workspace checkpoint. The agent's HOME/config root remains ephemeral, so
 * credentials, provider configuration, caches and unrelated logs cannot be
 * captured accidentally.
 */
export async function captureAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  for (const artifact of preparation.binding.sessionArtifacts) {
    await sandbox.exec(copyArtifactCommand({
      source: artifact.runtimePath,
      destination: artifact.path,
      kind: artifact.kind,
    }));
  }
}

/** Restore the durable native-session allowlist into the agent's ephemeral home. */
export async function restoreAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
): Promise<void> {
  for (const artifact of preparation.binding.sessionArtifacts) {
    await sandbox.exec(copyArtifactCommand({
      source: artifact.path,
      destination: artifact.runtimePath,
      kind: artifact.kind,
    }));
  }
}

/** Apply the adapter lifecycle policy after the ACP child is stopped. */
export async function releaseAcpSandboxAgentState(
  sandbox: Pick<AcpSandboxAgentStatePort, "exec">,
  preparation: AcpSandboxAgentPreparation,
  reason: AcpSandboxAgentReleaseReason,
): Promise<void> {
  // Remove the complete per-session runtime namespace, not only its native/
  // child. Real sandboxes discard /tmp with the runtime; host-backed local
  // adapters share the OS temp directory and would otherwise accumulate an
  // empty openma-harness-state tree across every session.
  const runtimeRoot = posixDirname(preparation.binding.nativePath);
  const adapterRoot = posixDirname(runtimeRoot);
  const sessionRoot = posixDirname(adapterRoot);
  const acpRoot = posixDirname(sessionRoot);
  const scratchRoot = posixDirname(acpRoot);
  await sandbox.exec(
    `rm -rf -- ${shellQuote(sandboxShellPath(runtimeRoot))}; `
      + `rmdir -- ${[
        adapterRoot,
        sessionRoot,
        acpRoot,
        scratchRoot,
      ].map((path) => shellQuote(sandboxShellPath(path))).join(" ")} `
      + "2>/dev/null || true",
  );
  if (reason !== "destroy") return;
  await sandbox.exec(
    `rm -rf -- ${shellQuote(sandboxShellPath(preparation.binding.rootPath))}`,
  );
}

function copyArtifactCommand(input: {
  source: string;
  destination: string;
  kind: "directory" | "file" | "sqlite";
}): string {
  const source = shellQuote(sandboxShellPath(input.source));
  const destinationPath = sandboxShellPath(input.destination);
  const destination = shellQuote(destinationPath);
  const destinationParent = shellQuote(posixDirname(destinationPath));
  const predicate = input.kind === "directory" ? "-d" : "-f";
  const copyFlag = input.kind === "directory" ? "-R" : "-f";
  const sidecars = input.kind === "sqlite"
    ? ["-wal", "-shm"].map((suffix) => {
      const sourceSidecar = `${sandboxShellPath(input.source)}${suffix}`;
      const destinationSidecar = `${destinationPath}${suffix}`;
      return `if [ -f ${shellQuote(sourceSidecar)} ]; then cp -f -- ${shellQuote(sourceSidecar)} ${shellQuote(destinationSidecar)}; else rm -f -- ${shellQuote(destinationSidecar)}; fi`;
    }).join("; ")
    : "";
  const cleanup = input.kind === "sqlite"
    ? `rm -f -- ${destination} ${shellQuote(`${destinationPath}-wal`)} ${shellQuote(`${destinationPath}-shm`)}`
    : `rm -rf -- ${destination}`;
  return [
    `mkdir -p -- ${destinationParent}`,
    `if [ ${predicate} ${source} ]; then ${cleanup}; cp ${copyFlag} -- ${source} ${destination}${sidecars ? `; ${sidecars}` : ""}; else ${cleanup}; fi`,
  ].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxShellPath(path: string): string {
  return path.startsWith("/workspace/")
    ? path.slice("/workspace/".length)
    : path;
}

function posixDirname(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}
