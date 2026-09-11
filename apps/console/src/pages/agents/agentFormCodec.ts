/**
 * Pure create/edit codec for AgentFormDialog.
 *
 * Form mode only models a subset of AgentConfig. Updates and Form↔YAML/JSON
 * switches must be lossless for unsupported fields (model.speed, custom
 * tools, MCP stdio, unknown toolsets, metadata, etc.). Form controls own the
 * common fields; the full YAML/JSON editor remains available for every other
 * AgentConfig key.
 */
import type { AgentRecord as Agent } from "../../types/agent";

export interface McpEntry {
  name: string;
  type: string;
  url: string;
  /** Non-secret configuration for a sandbox-hosted stdio MCP server. */
  stdioCommand: string;
  stdioArgs: string[];
  stdioEnv: Record<string, string>;
  stdioPort: string;
  stdioSsePath: string;
  stdioReadyTimeoutMs: string;
  /** Stable identity used to preserve fields when an existing server is renamed. */
  originalName?: string;
}

export interface SkillEntry {
  type: "anthropic" | "custom";
  skill_id: string;
  version?: string | number;
}

export interface CallableEntry {
  type: "agent";
  id: string;
  version: number;
}

export type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

export type FormState = {
  name: string;
  model: string;
  /** Preserved from `{ id, speed }` model objects; not edited in Form UI yet. */
  modelSpeed: "" | "standard" | "fast";
  auxiliaryModel: string;
  auxiliaryModelSpeed: "" | "standard" | "fast";
  appendablePrompts: string[];
  metadataJson: string;
  system: string;
  description: string;
  modelCardId: string;
  mcpServers: McpEntry[];
  skills: SkillEntry[];
  callableAgents: CallableEntry[];
  runtimeId: string;
  acpAgentId: string;
  localSkillBlocklist: string[];
  toolDefaultEnabled: boolean;
  toolDefaultPermission: "always_allow" | "always_ask";
  toolOverrides: Record<string, ToolOverride>;
  enableGeneralSubagent: boolean;
};

export const INITIAL_FORM: FormState = {
  name: "",
  model: "",
  modelSpeed: "",
  auxiliaryModel: "",
  auxiliaryModelSpeed: "",
  appendablePrompts: [],
  metadataJson: "{}",
  system: "",
  description: "",
  modelCardId: "",
  mcpServers: [],
  skills: [],
  callableAgents: [],
  runtimeId: "",
  acpAgentId: "claude-agent-acp",
  localSkillBlocklist: [],
  toolDefaultEnabled: true,
  toolDefaultPermission: "always_allow",
  toolOverrides: {},
  enableGeneralSubagent: false,
};

const RESPONSE_ONLY_KEYS = new Set([
  "id",
  "version",
  "created_at",
  "updated_at",
  "archived_at",
]);

/** Clone an API agent into a config baseline for lossless form merges. */
export function agentToPreservedConfig(agent: Agent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(agent as unknown as Record<string, unknown>)) {
    if (RESPONSE_ONLY_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out[k] = structuredClone(v);
  }
  return out;
}

/** Pull default_config + per-tool overrides out of an agent_toolset_20260401 entry. */
export function parseToolPolicy(tools: unknown[] | undefined): {
  toolDefaultEnabled: boolean;
  toolDefaultPermission: "always_allow" | "always_ask";
  toolOverrides: Record<string, ToolOverride>;
} {
  const toolset = Array.isArray(tools)
    ? (tools as Array<Record<string, unknown>>).find(
        (t) => t?.type === "agent_toolset_20260401",
      )
    : undefined;
  const dc = (toolset?.default_config ?? {}) as {
    enabled?: boolean;
    permission_policy?: { type?: string };
  };
  const cfgs = (toolset?.configs ?? []) as Array<{
    name?: string;
    enabled?: boolean;
    permission_policy?: { type?: string };
  }>;
  const overrides: Record<string, ToolOverride> = {};
  for (const c of cfgs) {
    if (!c?.name) continue;
    if (c.enabled === false) overrides[c.name] = "disabled";
    else if (c.permission_policy?.type === "always_ask") overrides[c.name] = "always_ask";
    else if (c.permission_policy?.type === "always_allow") overrides[c.name] = "always_allow";
  }
  return {
    toolDefaultEnabled: dc.enabled ?? true,
    toolDefaultPermission:
      dc.permission_policy?.type === "always_ask" ? "always_ask" : "always_allow",
    toolOverrides: overrides,
  };
}

function modelIdOf(model: unknown): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "id" in model) {
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function modelSpeedOf(model: unknown): "" | "standard" | "fast" {
  if (!model || typeof model !== "object") return "";
  const speed = (model as { speed?: unknown }).speed;
  return speed === "standard" || speed === "fast" ? speed : "";
}

function modelValueFromParts(
  id: string,
  speed: "" | "standard" | "fast",
  existing?: unknown,
): string | Record<string, unknown> {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const model = structuredClone(existing as Record<string, unknown>);
    model.id = id;
    if (speed === "standard" || speed === "fast") model.speed = speed;
    return model;
  }
  return speed === "standard" || speed === "fast" ? { id, speed } : id;
}

type RuntimeBinding = {
  runtime_id?: string;
  acp_agent_id?: string;
  local_skill_blocklist?: string[];
};

/** Map an API / pasted config into form state (lossy by design for the UI). */
export function configToForm(config: Record<string, unknown>): FormState {
  const oma = config._oma as {
    runtime_binding?: RuntimeBinding;
    aux_model?: unknown;
    appendable_prompts?: unknown;
  } | undefined;
  const rb: RuntimeBinding | undefined =
    oma?.runtime_binding ?? (config.runtime_binding as RuntimeBinding | undefined);
  const toolPolicy = parseToolPolicy(
    Array.isArray(config.tools) ? (config.tools as unknown[]) : undefined,
  );
  const multiagent = config.multiagent as { agents?: CallableEntry[] } | undefined;
  const callableAgents = Array.isArray(config.callable_agents)
    ? (config.callable_agents as CallableEntry[])
    : multiagent?.agents;
  return {
    ...INITIAL_FORM,
    name: String(config.name || ""),
    model: modelIdOf(config.model) || (typeof config.model === "string" ? config.model : ""),
    modelSpeed: modelSpeedOf(config.model),
    auxiliaryModel: modelIdOf(oma?.aux_model ?? config.aux_model),
    auxiliaryModelSpeed: modelSpeedOf(oma?.aux_model ?? config.aux_model),
    appendablePrompts: Array.isArray(oma?.appendable_prompts ?? config.appendable_prompts)
      ? ((oma?.appendable_prompts ?? config.appendable_prompts) as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    metadataJson: JSON.stringify(config.metadata ?? {}, null, 2),
    modelCardId: "",
    system: String(config.system || ""),
    description: String(config.description || ""),
    mcpServers: Array.isArray(config.mcp_servers)
      ? (config.mcp_servers as Array<Record<string, unknown>>).map((m) => ({
          name: String(m.name || ""),
          type: String(m.type || "url"),
          url: typeof m.url === "string" ? m.url : "",
          stdioCommand:
            typeof (m.stdio as { command?: unknown } | undefined)?.command === "string"
              ? (m.stdio as { command: string }).command
              : "",
          stdioArgs: Array.isArray((m.stdio as { args?: unknown } | undefined)?.args)
            ? (m.stdio as { args: unknown[] }).args.filter((arg): arg is string => typeof arg === "string")
            : [],
          stdioEnv:
            (m.stdio as { env?: unknown } | undefined)?.env &&
            typeof (m.stdio as { env?: unknown }).env === "object"
              ? Object.entries((m.stdio as { env: Record<string, unknown> }).env).reduce<
                  Record<string, string>
                >((env, [key, value]) => {
                  if (typeof value === "string") env[key] = value;
                  return env;
                }, {})
              : {},
          stdioPort:
            typeof (m.stdio as { port?: unknown } | undefined)?.port === "number"
              ? String((m.stdio as { port: number }).port)
              : "",
          stdioSsePath:
            typeof (m.stdio as { sse_path?: unknown } | undefined)?.sse_path === "string"
              ? (m.stdio as { sse_path: string }).sse_path
              : "",
          stdioReadyTimeoutMs:
            typeof (m.stdio as { ready_timeout_ms?: unknown } | undefined)?.ready_timeout_ms === "number"
              ? String((m.stdio as { ready_timeout_ms: number }).ready_timeout_ms)
              : "",
          originalName: String(m.name || "") || undefined,
        }))
      : [],
    skills: Array.isArray(config.skills)
      ? (config.skills as Array<Record<string, unknown>>).map((s) => ({
          type: (s.type === "anthropic" ? "anthropic" : "custom") as "anthropic" | "custom",
          skill_id: String(s.skill_id || ""),
          ...(typeof s.version === "string" || typeof s.version === "number"
            ? { version: s.version }
            : {}),
        }))
      : [],
    callableAgents: Array.isArray(callableAgents)
      ? callableAgents.map((a) => ({
          type: "agent" as const,
          id: a.id,
          version: a.version ?? 1,
        }))
      : [],
    runtimeId: rb?.runtime_id ?? "",
    acpAgentId: rb?.acp_agent_id ?? "claude-agent-acp",
    localSkillBlocklist: Array.isArray(rb?.local_skill_blocklist)
      ? rb.local_skill_blocklist
      : [],
    ...toolPolicy,
    enableGeneralSubagent: config.enable_general_subagent === true,
  };
}

export function agentToForm(agent: Agent): FormState {
  return configToForm(agent as unknown as Record<string, unknown>);
}

export function buildModelValue(
  form: FormState,
  existingModel?: unknown,
): string | Record<string, unknown> {
  return modelValueFromParts(form.model, form.modelSpeed, existingModel);
}

/** Form-managed built-in toolset entry only. */
export function buildManagedToolset(
  form: FormState,
  previous?: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = Object.entries(form.toolOverrides)
    .filter(([, v]) => v !== "default")
    .map(([name, v]) => {
      if (v === "disabled") return { name, enabled: false };
      return {
        name,
        enabled: true,
        permission_policy: { type: v as "always_allow" | "always_ask" },
      };
    });
  const previousDefault =
    previous?.default_config && typeof previous.default_config === "object"
      ? structuredClone(previous.default_config as Record<string, unknown>)
      : {};
  const previousByName = new Map(
    (Array.isArray(previous?.configs) ? previous.configs : [])
      .filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
      .map((value) => [typeof value.name === "string" ? value.name : "", value]),
  );
  // Retain configs not represented by the current UI as well. They can be
  // new built-ins or provider extensions, and must not disappear on a name
  // edit. Form-authored overrides replace only their corresponding row.
  const configs = (Array.isArray(previous?.configs) ? previous.configs : []).map((value) =>
    structuredClone(value),
  );
  for (const override of overrides) {
    const next = {
      ...(previousByName.has(override.name)
        ? structuredClone(previousByName.get(override.name)!)
        : {}),
      ...override,
    };
    const index = configs.findIndex(
      (value) =>
        !!value &&
        typeof value === "object" &&
        (value as { name?: unknown }).name === override.name,
    );
    if (index === -1) configs.push(next);
    else configs[index] = next;
  }

  return {
    ...(previous ? structuredClone(previous) : {}),
    type: "agent_toolset_20260401",
    default_config: {
      ...previousDefault,
      enabled: form.toolDefaultEnabled,
      permission_policy: { type: form.toolDefaultPermission },
    },
    ...(configs.length > 0 ? { configs } : {}),
  };
}

/**
 * Merge form-managed toolsets into an existing tools array.
 * Preserves custom tools, unknown toolsets, and existing mcp_toolset
 * permission policies for MCP servers that remain selected.
 */
export function mergeToolsField(
  existingTools: unknown[] | undefined,
  form: FormState,
): unknown[] {
  const existing = Array.isArray(existingTools) ? existingTools : [];
  const existingBuiltin = existing.find(
    (tool): tool is Record<string, unknown> =>
      !!tool &&
      typeof tool === "object" &&
      (tool as { type?: unknown }).type === "agent_toolset_20260401",
  );
  const result: unknown[] = [buildManagedToolset(form, existingBuiltin)];

  for (const tool of existing) {
    if (!tool || typeof tool !== "object") {
      result.push(tool);
      continue;
    }
    const type = (tool as { type?: unknown }).type;
    if (type === "agent_toolset_20260401") continue;
    if (type === "mcp_toolset") {
      const serverName = (tool as { mcp_server_name?: unknown }).mcp_server_name;
      // Rebuild only MCP toolsets associated with a Form-managed server so
      // renames track correctly. Orphaned/future MCP declarations are still
      // valid data and must survive a harmless Form edit.
      if (
        typeof serverName === "string" &&
        form.mcpServers.some((server) =>
          [server.name, server.originalName].includes(serverName),
        )
      ) {
        continue;
      }
      result.push(tool);
      continue;
    }
    result.push(tool);
  }

  for (const mcp of form.mcpServers.filter((m) => m.name)) {
    const prior = existing.find(
      (t) =>
        t &&
        typeof t === "object" &&
        (t as { type?: unknown }).type === "mcp_toolset" &&
        (t as { mcp_server_name?: unknown }).mcp_server_name ===
          (mcp.originalName || mcp.name),
    );
    if (prior) {
      result.push({
        ...structuredClone(prior as Record<string, unknown>),
        mcp_server_name: mcp.name,
      });
    } else {
      result.push({
        type: "mcp_toolset",
        mcp_server_name: mcp.name,
        default_config: { permission_policy: { type: "always_allow" } },
      });
    }
  }

  return result;
}

/**
 * Merge form MCP rows onto existing servers by name so stdio / auth / extra
 * keys survive a name/url-only edit. Removed form rows are dropped.
 */
export function mergeMcpServers(
  existing: unknown[] | undefined,
  formServers: McpEntry[],
): Array<Record<string, unknown>> {
  const priorByName = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing)) {
    for (const row of existing) {
      if (!row || typeof row !== "object") continue;
      const name = (row as { name?: unknown }).name;
      if (typeof name === "string" && name) {
        priorByName.set(name, structuredClone(row as Record<string, unknown>));
      }
    }
  }

  return formServers
    .filter((m) => m.name)
    .map((m) => {
      const prior = priorByName.get(m.originalName || m.name);
      if (!prior) {
        const created: Record<string, unknown> = {
          name: m.name,
          type: m.type || "url",
          ...(m.url ? { url: m.url } : {}),
        };
        if (m.type === "stdio") created.stdio = stdioFromForm({}, m);
        return created;
      }
      const next: Record<string, unknown> = { ...prior, name: m.name, type: m.type || prior.type || "url" };
      if (m.url) next.url = m.url;
      else if (m.type === "stdio" && prior.stdio) {
        // stdio-hosted servers often have no remote URL — don't invent one.
        delete next.url;
      } else if (!m.url && typeof prior.url === "string") {
        // Keep prior url when the form left it blank (stdio / incomplete edit).
        next.url = prior.url;
      }
      if (m.type === "stdio") {
        next.stdio = stdioFromForm(
          next.stdio && typeof next.stdio === "object"
            ? (next.stdio as Record<string, unknown>)
            : {},
          m,
        );
      }
      return next;
    });
}

/** Apply only values the form can author, retaining unknown stdio extensions. */
function stdioFromForm(
  previous: Record<string, unknown>,
  form: McpEntry,
): Record<string, unknown> {
  const next = structuredClone(previous);
  if (form.stdioCommand) next.command = form.stdioCommand;
  if (form.stdioArgs.length || Object.hasOwn(previous, "args")) next.args = [...form.stdioArgs];
  if (Object.keys(form.stdioEnv).length || Object.hasOwn(previous, "env")) {
    next.env = structuredClone(form.stdioEnv);
  }
  const port = Number(form.stdioPort);
  if (Number.isFinite(port) && port > 0) next.port = port;
  if (form.stdioSsePath || Object.hasOwn(previous, "sse_path")) {
    next.sse_path = form.stdioSsePath;
  }
  const timeout = Number(form.stdioReadyTimeoutMs);
  if (Number.isFinite(timeout) && timeout >= 0) next.ready_timeout_ms = timeout;
  return next;
}

function mergeSkillsField(existing: unknown, skills: SkillEntry[]): SkillEntry[] {
  const byKey = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing)) {
    for (const skill of existing) {
      if (!skill || typeof skill !== "object") continue;
      const entry = skill as Record<string, unknown>;
      if (typeof entry.type === "string" && typeof entry.skill_id === "string") {
        byKey.set(`${entry.type}:${entry.skill_id}`, entry);
      }
    }
  }
  return skills.map((skill) => ({
    ...(byKey.get(`${skill.type}:${skill.skill_id}`)
      ? structuredClone(byKey.get(`${skill.type}:${skill.skill_id}`)!)
      : {}),
    ...skill,
  })) as SkillEntry[];
}

function mergeCallableAgentsField(existing: unknown, agents: CallableEntry[]): CallableEntry[] {
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing)) {
    for (const agent of existing) {
      if (agent && typeof agent === "object" && typeof (agent as { id?: unknown }).id === "string") {
        byId.set((agent as { id: string }).id, agent as Record<string, unknown>);
      }
    }
  }
  return agents.map((agent) => ({
    ...(byId.get(agent.id) ? structuredClone(byId.get(agent.id)!) : {}),
    ...agent,
  })) as CallableEntry[];
}

function buildOmaPatch(
  form: FormState,
  forUpdate: boolean,
  base: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const baseOma =
    base?._oma && typeof base._oma === "object"
      ? structuredClone(base._oma as Record<string, unknown>)
      : {};
  const hadBinding =
    !!(baseOma.runtime_binding) ||
    !!(base?.runtime_binding);

  if (form.runtimeId && form.acpAgentId) {
    return {
      ...baseOma,
      ...(form.auxiliaryModel
        ? {
            aux_model: modelValueFromParts(
              form.auxiliaryModel,
              form.auxiliaryModelSpeed,
              baseOma.aux_model ?? base?.aux_model,
            ),
          }
        : {}),
      ...(form.appendablePrompts.length > 0
        ? { appendable_prompts: [...form.appendablePrompts] }
        : {}),
      harness: "acp-proxy",
      runtime_binding: {
        runtime_id: form.runtimeId,
        acp_agent_id: form.acpAgentId,
        ...(form.localSkillBlocklist.length > 0
          ? { local_skill_blocklist: form.localSkillBlocklist }
          : {}),
      },
    };
  }

  if (forUpdate && hadBinding) {
    return {
      ...baseOma,
      ...(form.auxiliaryModel
        ? {
            aux_model: modelValueFromParts(
              form.auxiliaryModel,
              form.auxiliaryModelSpeed,
              baseOma.aux_model ?? base?.aux_model,
            ),
          }
        : {}),
      ...(form.appendablePrompts.length > 0
        ? { appendable_prompts: [...form.appendablePrompts] }
        : {}),
      harness: "default",
      runtime_binding: null,
    };
  }

  if (form.auxiliaryModel) {
    baseOma.aux_model = modelValueFromParts(
      form.auxiliaryModel,
      form.auxiliaryModelSpeed,
      baseOma.aux_model ?? base?.aux_model,
    );
  }
  if (form.appendablePrompts.length > 0) {
    baseOma.appendable_prompts = [...form.appendablePrompts];
  }

  // Preserve untouched _oma (aux_model, appendable_prompts, …) on update /
  // mode switches even when the form does not manage a runtime binding.
  if (Object.keys(baseOma).length > 0) return baseOma;
  return undefined;
}

/**
 * Overlay form-managed fields onto a preserved config baseline.
 * Create mode (no base) emits only the fields the form owns.
 */
export function mergeFormIntoConfig(
  form: FormState,
  base: Record<string, unknown> | null | undefined,
  opts: { forUpdate: boolean },
): Record<string, unknown> {
  const { forUpdate } = opts;
  const existingTools = Array.isArray(base?.tools) ? (base!.tools as unknown[]) : undefined;
  const existingMcp = Array.isArray(base?.mcp_servers)
    ? (base!.mcp_servers as unknown[])
    : undefined;

  const payload: Record<string, unknown> = base
    ? structuredClone(base)
    : {};

  // Drop response-ish keys if a caller passed a full agent record.
  for (const k of RESPONSE_ONLY_KEYS) delete payload[k];

  payload.name = form.name;
  payload.model = buildModelValue(form, base?.model);
  payload.tools = mergeToolsField(existingTools, form);
  try {
    const metadata: unknown = JSON.parse(form.metadataJson);
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      payload.metadata = metadata;
    }
  } catch {
    // Keep the preserved metadata during an incomplete JSON edit. The Form UI
    // surfaces invalid JSON and blocks submit.
  }

  if (forUpdate) {
    payload.system = form.system || null;
    payload.description = form.description || null;
    payload.mcp_servers = form.mcpServers.some((m) => m.name)
      ? mergeMcpServers(existingMcp, form.mcpServers)
      : null;
    payload.skills = form.skills.length ? mergeSkillsField(base?.skills, form.skills) : null;
    const callableAgents = mergeCallableAgentsField(base?.callable_agents, form.callableAgents);
    payload.callable_agents = callableAgents.length ? callableAgents : null;
    payload.multiagent = callableAgents.length
      ? { type: "coordinator", agents: callableAgents }
      : null;
    payload.enable_general_subagent = form.enableGeneralSubagent;
  } else {
    if (form.system) payload.system = form.system;
    else delete payload.system;
    if (form.description) payload.description = form.description;
    else delete payload.description;
    if (form.mcpServers.some((m) => m.name)) {
      payload.mcp_servers = mergeMcpServers(existingMcp, form.mcpServers);
    } else {
      delete payload.mcp_servers;
    }
    if (form.skills.length) payload.skills = mergeSkillsField(base?.skills, form.skills);
    else delete payload.skills;
    if (form.callableAgents.length) {
      const callableAgents = mergeCallableAgentsField(base?.callable_agents, form.callableAgents);
      payload.callable_agents = callableAgents;
      payload.multiagent = { type: "coordinator", agents: callableAgents };
    } else {
      delete payload.multiagent;
      delete payload.callable_agents;
    }
    if (form.enableGeneralSubagent) payload.enable_general_subagent = true;
    else delete payload.enable_general_subagent;
  }

  const oma = buildOmaPatch(form, forUpdate, base);
  if (oma) payload._oma = oma;
  else if (forUpdate) {
    // Leave existing _oma alone when base had none and form cleared nothing.
    delete payload._oma;
  } else {
    delete payload._oma;
  }

  return payload;
}

/**
 * Keep the standard Managed Agents endpoint strict. OpenMA-only runtime,
 * harness and local-process fields are routed through the explicit product
 * namespace instead of being smuggled into `/v1/agents`.
 */
export function requiresOmaAgentEndpoint(payload: Record<string, unknown>): boolean {
  const omaOnlyKeys = [
    "_oma",
    "runtime_binding",
    "harness",
    "acp",
    "aux_model",
    "appendable_prompts",
    "enable_general_subagent",
    "callable_agents",
  ];
  if (omaOnlyKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    return true;
  }

  // The Managed Agents SDK endpoint validates a fixed public schema. Route
  // full config payloads (including provider options and future fields)
  // through OMA's pass-through endpoint instead of letting that schema strip
  // them during a read-modify-write cycle.
  const managedKeys = new Set([
    "name",
    "model",
    "system",
    "description",
    "tools",
    "mcp_servers",
    "skills",
    "multiagent",
    "metadata",
  ]);
  if (Object.keys(payload).some((key) => !managedKeys.has(key))) return true;
  if (
    payload.model &&
    typeof payload.model === "object" &&
    Object.keys(payload.model as Record<string, unknown>).some(
      (key) => key !== "id" && key !== "speed",
    )
  ) {
    return true;
  }

  const servers = payload.mcp_servers;
  return (
    Array.isArray(servers) &&
    servers.some(
      (server) =>
        !!server &&
        typeof server === "object" &&
        ((server as { type?: unknown }).type !== "url" ||
          Object.prototype.hasOwnProperty.call(server, "stdio")),
    )
  );
}
