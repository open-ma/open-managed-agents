import type { AcpRuntime } from "@open-managed-agents/acp-runtime";
import { posix } from "node:path";
import { unzipSync } from "fflate";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import {
  managedMcpProxyFromWorkEnvironment,
  projectAcpSandboxMcpServers,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import type { AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";
import {
  serveHarnessSupervisorJsonl,
  type HarnessSupervisorHarness,
  type HarnessSupervisorScheduler,
} from "@open-managed-agents/harness-supervisor";

import {
  createManagedAcpSupervisorHarness,
} from "./index.js";
import {
  createManagedHarnessHttpControlChannel,
  createManagedHarnessHttpRecoveryHistory,
  createManagedHarnessHttpSkillSource,
  type ManagedHarnessHttpScheduler,
  type ManagedHarnessHttpSkillSource,
  type ManagedHarnessWireSession,
} from "./http-control.js";
import {
  createAcpNativeSessionState,
  createNodeAcpHarnessStateIo,
  type NodeAcpHarnessStateIo,
} from "./node.js";
import {
  createManagedEventSemanticRecovery,
  type ManagedHarnessRecoveryHistoryPort,
} from "./semantic-recovery.js";

const CONTROL_PLANE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_SESSION_ID",
  "ANTHROPIC_WORK_ID",
  "ANTHROPIC_WORK_SECRET",
] as const;

export interface ManagedAcpSessionAgentSnapshot {
  readonly id: string;
  readonly version: number;
  readonly model: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly mcp_servers: readonly {
    readonly type: "url";
    readonly name: string;
    readonly url: string;
  }[];
  readonly skills: readonly ManagedAcpSkillSnapshot[];
  readonly system: string | null;
  readonly tools: readonly Readonly<Record<string, unknown>>[];
}

export interface ManagedAcpSkillSnapshot extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly skill_id: string;
  readonly version: string;
}

export interface ManagedAcpSessionSnapshot extends ManagedHarnessWireSession {
  readonly agent: ManagedAcpSessionAgentSnapshot;
}

export interface NodeManagedAcpAgentResolverInput {
  harness: { id: string; version: string };
  session: ManagedAcpSessionSnapshot;
}

export interface NodeManagedAcpSupervisorAppOptions {
  /** Process environment injected by the outer Environment Worker. */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Host path corresponding to protocol `/workspace`; defaults to `/workspace`. */
  workspacePath?: string;
  heartbeatIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  acpRuntime?: AcpRuntime;
  stateIo?: NodeAcpHarnessStateIo;
  /** Fixed installed Agent selection for a generic `acp@1` harness. */
  agentId?: string;
  resolveAgent?(
    input: NodeManagedAcpAgentResolverInput,
  ): AcpStatefulAgentSpec | null | Promise<AcpStatefulAgentSpec | null>;
  control?: {
    pollIntervalMs?: number;
    scheduler?: ManagedHarnessHttpScheduler;
    retry?: { maxAttempts?: number };
  };
  supervisorScheduler?: HarnessSupervisorScheduler;
  recovery?: { maxCharacters?: number };
  lifecycle?: {
    drainDeadlineMs?: number;
    drainPollIntervalMs?: number;
    abortGraceMs?: number;
  };
}

export interface NodeManagedAcpSupervisorApp {
  resolveHarness(
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null>;
  serve(input: {
    input: ReadableStream<Uint8Array>;
    output: WritableStream<Uint8Array>;
  }): Promise<void>;
}

interface ActiveRunContext {
  outputPath: string | null;
  proxy: { gatewayBaseUrl: string; sessionsToken: string };
  history: ManagedHarnessRecoveryHistoryPort;
  skills: ManagedHarnessHttpSkillSource;
}

/**
 * Production composition for a preinstalled ACP agent running as the whole
 * brain inside a Node-capable sandbox. Environment Work ownership remains in
 * the outer worker; this process accepts only its scoped supervisor command.
 */
export function createNodeManagedAcpSupervisorApp(
  options: NodeManagedAcpSupervisorAppOptions = {},
): NodeManagedAcpSupervisorApp {
  const environment = options.environment ?? process.env;
  const workspacePath = options.workspacePath ?? "/workspace";
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  const stateIo = options.stateIo ?? createNodeAcpHarnessStateIo({ workspacePath });
  const acpRuntime = options.acpRuntime ?? createAcpRuntime({
    type: "local",
    spawner: new NodeSpawner(),
  });

  const resolveHarness = async (
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null> => {
    if (harness.version !== "1") return null;
    // `connect` establishes the transport context before the control channel
    // can emit session.start; onSessionLoaded establishes the Session snapshot
    // before that same command is exposed. Definite assignment models that
    // protocol ordering instead of carrying unreachable nullable branches.
    let active!: ActiveRunContext;
    let activeSession!: ManagedAcpSessionSnapshot;
    const sessionState = createAcpNativeSessionState({
      io: stateIo,
      resolveSession: async () => {
        const session = activeSession;
        const resolved = options.resolveAgent === undefined
          ? defaultAgentResolver(options.agentId ?? harness.id)
          : await options.resolveAgent({ harness, session });
        if (resolved === null) {
          throw new Error(
            `No installed ACP agent is configured for ${harness.id}@${harness.version}`,
          );
        }
        const skillInstructions = await materializeSkills({
          io: stateIo,
          source: active.skills,
          skills: session.agent.skills,
        });
        const instructions = [
          session.agent.system?.trimEnd() ?? "",
          skillInstructions,
        ].filter((part) => part.length > 0).join("\n\n");
        if (instructions.length > 0) {
          await stateIo.writeFile("/workspace/AGENTS.md", `${instructions}\n`);
        }
        const scrubbedEnvironment = Object.fromEntries(
          CONTROL_PLANE_ENV_KEYS.map((key) => [key, undefined]),
        );
        const agent: AcpStatefulAgentSpec = {
          ...resolved,
          id: resolved.id ?? options.agentId ?? harness.id,
          cwd: resolved.cwd ?? "/workspace",
          env: {
            ...(resolved.env ?? {}),
            ...scrubbedEnvironment,
            ...(active.outputPath === null
              ? { OUTPUT_PATH: undefined }
              : { OUTPUT_PATH: active.outputPath }),
          },
        };
        return {
          agent,
          mcpServers: projectAcpSandboxMcpServers({
            sessionId: session.id,
            gatewayBaseUrl: active.proxy.gatewayBaseUrl,
            sessionsToken: active.proxy.sessionsToken,
            servers: session.agent.mcp_servers,
          }),
          sessionRequestMeta: {
            openma: {
              session_id: session.id,
              agent_id: session.agent.id,
              agent_version: session.agent.version,
              model: session.agent.model,
              skills: session.agent.skills,
              tools: session.agent.tools,
            },
          },
        };
      },
    });
    const semanticRecovery = createManagedEventSemanticRecovery({
      history: {
        async list(sessionId) {
          return active.history.list(sessionId);
        },
      },
      maxCharacters: options.recovery?.maxCharacters,
    });
    return createManagedAcpSupervisorHarness({
      connect: async (input) => {
        assertClaimedScope(environment, input.scope);
        const proxy = managedMcpProxyFromWorkEnvironment(environment);
        if (proxy === null) {
          throw new Error("A valid scoped ANTHROPIC_WORK_SECRET is required");
        }
        const history = createManagedHarnessHttpRecoveryHistory({
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          fetch: options.fetch,
          retry: options.control?.retry,
          scheduler: options.control?.scheduler,
          signal: input.signal,
        });
        const skills = createManagedHarnessHttpSkillSource({
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          fetch: options.fetch,
          retry: options.control?.retry,
          scheduler: options.control?.scheduler,
          signal: input.signal,
        });
        active = {
          outputPath: input.outputPath,
          proxy,
          history,
          skills,
        };
        return createManagedHarnessHttpControlChannel({
          scope: input.scope,
          harness: input.harness,
          workspacePath: input.workspacePath,
          apiBaseUrl: proxy.gatewayBaseUrl,
          sessionsToken: proxy.sessionsToken,
          fetch: options.fetch,
          pollIntervalMs: options.control?.pollIntervalMs,
          scheduler: options.control?.scheduler,
          retry: options.control?.retry,
          onSessionLoaded(session) {
            activeSession = decodeManagedAcpSessionSnapshot(session);
          },
        });
      },
      acpRuntime,
      sessionPreparation: sessionState,
      sessionState,
      semanticRecovery,
      drainDeadlineMs: options.lifecycle?.drainDeadlineMs,
      drainPollIntervalMs: options.lifecycle?.drainPollIntervalMs,
      abortGraceMs: options.lifecycle?.abortGraceMs,
    });
  };

  return {
    resolveHarness,
    async serve(input) {
      await serveHarnessSupervisorJsonl({
        ...input,
        heartbeatIntervalMs,
        resolveHarness,
        scheduler: options.supervisorScheduler,
      });
    },
  };
}

export function decodeManagedAcpSessionSnapshot(
  value: ManagedHarnessWireSession,
): ManagedAcpSessionSnapshot {
  const agent = value.agent;
  if (!isRecord(agent)) throw invalidSession("agent");
  const model = agent.model;
  if (!isRecord(model) || !isNonEmptyString(model.id)) throw invalidSession("agent.model");
  if (!isNonEmptyString(agent.id)) throw invalidSession("agent.id");
  if (!Number.isSafeInteger(agent.version) || Number(agent.version) < 1) {
    throw invalidSession("agent.version");
  }
  if (agent.system !== null && typeof agent.system !== "string") {
    throw invalidSession("agent.system");
  }
  if (!Array.isArray(agent.mcp_servers)) throw invalidSession("agent.mcp_servers");
  const mcpServers = agent.mcp_servers.map((candidate, index) => {
    if (
      !isRecord(candidate)
      || candidate.type !== "url"
      || !isNonEmptyString(candidate.name)
      || !isNonEmptyString(candidate.url)
    ) throw invalidSession(`agent.mcp_servers[${index}]`);
    return { type: "url" as const, name: candidate.name, url: candidate.url };
  });
  const skills = skillArray(agent.skills);
  const tools = recordArray(agent.tools, "agent.tools");
  return {
    ...value,
    agent: {
      id: agent.id,
      version: Number(agent.version),
      model: { ...model, id: model.id },
      mcp_servers: mcpServers,
      skills,
      system: agent.system,
      tools,
    },
  };
}

async function materializeSkills(input: {
  io: NodeAcpHarnessStateIo;
  source: ManagedHarnessHttpSkillSource;
  skills: readonly ManagedAcpSkillSnapshot[];
}): Promise<string> {
  const manifests: string[] = [];
  for (const skill of input.skills) {
    const archive = unzipSync(await input.source.download({
      skillId: skill.skill_id,
      version: skill.version,
    }));
    const root = `/workspace/.openma/skills/${encodeURIComponent(skill.skill_id)}/${encodeURIComponent(skill.version)}`;
    let foundManifest = false;
    for (const [rawPath, content] of Object.entries(archive)) {
      if (rawPath.endsWith("/")) continue;
      const path = safeSkillArchivePath(rawPath);
      await input.io.writeFileBytes(`${root}/${path}`, content);
      if (posix.basename(path) === "SKILL.md") {
        foundManifest = true;
        manifests.push(
          `- ${skill.skill_id}@${skill.version}: ${root}/${path}`,
        );
      }
    }
    if (!foundManifest) {
      throw new Error(
        `Managed Skill ${skill.skill_id}@${skill.version} archive has no SKILL.md`,
      );
    }
  }
  return manifests.length === 0
    ? ""
    : ["## OpenMA skills", "", ...manifests].join("\n");
}

function safeSkillArchivePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    value.includes("\0")
    || normalized === "."
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe Managed Skill archive path: ${value}`);
  }
  return normalized;
}

function skillArray(value: unknown): ManagedAcpSkillSnapshot[] {
  const skills = recordArray(value, "agent.skills");
  return skills.map((skill, index) => {
    if (
      !isNonEmptyString(skill.type)
      || !isNonEmptyString(skill.skill_id)
      || !isNonEmptyString(skill.version)
    ) throw invalidSession(`agent.skills[${index}]`);
    return {
      ...skill,
      type: skill.type,
      skill_id: skill.skill_id,
      version: skill.version,
    };
  });
}

function defaultAgentResolver(agentId: string): AcpStatefulAgentSpec | null {
  const entry = resolveKnownAgent(agentId);
  return entry === null ? null : { ...entry.spec, id: entry.id };
}

function assertClaimedScope(
  environment: Readonly<Record<string, string | undefined>>,
  scope: {
    environmentId: string;
    sessionId: string;
    workId: string;
  },
): void {
  if (
    environment.ANTHROPIC_ENVIRONMENT_ID !== scope.environmentId
    || environment.ANTHROPIC_SESSION_ID !== scope.sessionId
    || environment.ANTHROPIC_WORK_ID !== scope.workId
  ) {
    throw new Error("Supervisor scope does not match the claimed Work scope");
  }
}

function recordArray(value: unknown, path: string): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((candidate) => !isRecord(candidate))) {
    throw invalidSession(path);
  }
  return value.map((candidate) => ({ ...candidate as Record<string, unknown> }));
}

function invalidSession(path: string): TypeError {
  return new TypeError(`Managed Session ${path} is invalid`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
