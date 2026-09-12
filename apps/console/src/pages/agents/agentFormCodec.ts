/**
 * Pure create/edit codec for AgentFormDialog.
 *
 * Form mode only models a subset of AgentConfig. Updates and Form↔YAML/JSON
 * switches must be lossless for unsupported fields (model.speed, custom
 * tools, MCP stdio, unknown toolsets, metadata, etc.). Full-field UI is
 * tracked separately in #155 — this module only guarantees round-trips.
 */
import type { AgentRecord as Agent } from "../../types/agent";
import yaml from "js-yaml";

export function parseAgentConfigText(
  source: string,
  format: "yaml" | "json",
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = format === "yaml" ? yaml.load(source) : JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid ${format.toUpperCase()}${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent config must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** Apply create-only defaults without changing update patch semantics. */
export function prepareCodePayload(
  parsed: Record<string, unknown>,
  opts: { forUpdate: boolean },
): Record<string, unknown> {
  const payload = structuredClone(parsed);
  if (!opts.forUpdate) {
    if (typeof payload.name !== "string" || payload.name.length === 0) {
      throw new Error("name is required");
    }
    if (payload.tools === undefined) {
      payload.tools = [{ type: "agent_toolset_20260401" }];
    }
  }
  return payload;
}

function parseMetadataJson(source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Invalid metadata JSON${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Metadata JSON must be an object");
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Metadata JSON values must be strings");
    }
  }
  return parsed as Record<string, string>;
}

function metadataPatch(
  current: Record<string, string>,
  next: Record<string, string>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(next)) {
    if (current[key] !== value) patch[key] = value;
  }
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(next, key)) patch[key] = null;
  }
  return patch;
}

/** Expand official update-patch semantics into a full editable config view. */
export function materializeAgentUpdate(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (RESPONSE_ONLY_KEYS.has(key)) continue;
    if (key === "metadata") {
      const currentMetadata =
        next.metadata &&
        typeof next.metadata === "object" &&
        !Array.isArray(next.metadata)
          ? (next.metadata as Record<string, string>)
          : {};
      if (value === null) {
        next.metadata = {};
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const metadata = { ...currentMetadata };
        for (const [metadataKey, metadataValue] of Object.entries(value)) {
          if (metadataValue === null) delete metadata[metadataKey];
          else if (typeof metadataValue === "string") metadata[metadataKey] = metadataValue;
          else throw new Error("Metadata patch values must be strings or null");
        }
        next.metadata = metadata;
      } else {
        throw new Error("Metadata patch must be an object or null");
      }
      continue;
    }
    if (key === "_oma" && value && typeof value === "object" && !Array.isArray(value)) {
      const extension =
        next._oma && typeof next._oma === "object" && !Array.isArray(next._oma)
          ? structuredClone(next._oma as Record<string, unknown>)
          : {};
      for (const [extensionKey, extensionValue] of Object.entries(value)) {
        if (extensionValue === null) delete extension[extensionKey];
        else extension[extensionKey] = structuredClone(extensionValue);
      }
      if (Object.keys(extension).length > 0) next._oma = extension;
      else delete next._oma;
      continue;
    }
    if (
      value === null &&
      (key === "mcp_servers" || key === "skills" || key === "tools")
    ) {
      next[key] = [];
      continue;
    }
    next[key] = structuredClone(value);
  }
  return next;
}

export interface McpEntry {
  name: string;
  type: "url" | "stdio";
  url: string;
  command: string;
  argsJson: string;
  envJson: string;
  /** Stable identity used to preserve fields when an existing server is renamed. */
  originalName?: string;
}

export interface SkillEntry {
  type: "anthropic" | "custom";
  skill_id: string;
  version?: string;
}

export interface CallableEntry {
  type: "agent";
  id: string;
  version?: number;
}

export type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

export type FormState = {
  name: string;
  model: string;
  /** Preserved from model config objects; not edited in Form UI yet. */
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
  toolDefaultEnabled: boolean;
  toolDefaultPermission: "always_allow" | "always_ask";
  toolOverrides: Record<string, ToolOverride>;
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
  toolDefaultEnabled: true,
  toolDefaultPermission: "always_allow",
  toolOverrides: {},
};

const RESPONSE_ONLY_KEYS = new Set([
  "id",
  "type",
  "version",
  "created_at",
  "updated_at",
  "archived_at",
]);

const OMA_ONLY_KEYS = new Set([
  "runtime_binding",
  "harness",
  "acp",
  "aux_model",
  "appendable_prompts",
  "enable_general_subagent",
  "callable_agents",
]);

/** Clone an API agent into a config baseline for lossless form merges. */
export function agentToPreservedConfig(agent: Agent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(agent as unknown as Record<string, unknown>)) {
    if (RESPONSE_ONLY_KEYS.has(k) || OMA_ONLY_KEYS.has(k)) continue;
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

/** Map an API / pasted config into form state (lossy by design for the UI). */
export function configToForm(config: Record<string, unknown>): FormState {
  const toolPolicy = parseToolPolicy(
    Array.isArray(config.tools) ? (config.tools as unknown[]) : undefined,
  );
  const multiagent = config.multiagent as {
    agents?: Array<Record<string, unknown>>;
  } | undefined;
  const openma =
    config._oma && typeof config._oma === "object"
      ? (config._oma as Record<string, unknown>)
      : undefined;
  return {
    ...INITIAL_FORM,
    name: String(config.name || ""),
    model: modelIdOf(config.model) || (typeof config.model === "string" ? config.model : ""),
    modelSpeed: modelSpeedOf(config.model),
    auxiliaryModel: modelIdOf(openma?.aux_model),
    auxiliaryModelSpeed: modelSpeedOf(openma?.aux_model),
    appendablePrompts: Array.isArray(openma?.appendable_prompts)
      ? openma.appendable_prompts.filter(
          (prompt): prompt is string => typeof prompt === "string",
        )
      : [],
    metadataJson:
      config.metadata &&
      typeof config.metadata === "object" &&
      !Array.isArray(config.metadata)
        ? JSON.stringify(config.metadata, null, 2)
        : "{}",
    modelCardId: "",
    system: String(config.system || ""),
    description: String(config.description || ""),
    mcpServers: Array.isArray(config.mcp_servers)
      ? (config.mcp_servers as Array<Record<string, unknown>>).map((m) => ({
          name: String(m.name || ""),
          type: m.type === "stdio" ? "stdio" as const : "url" as const,
          url: typeof m.url === "string" ? m.url : "",
          command: typeof m.command === "string" ? m.command : "",
          argsJson: JSON.stringify(Array.isArray(m.args) ? m.args : []),
          envJson: JSON.stringify(
            m.env && typeof m.env === "object" && !Array.isArray(m.env)
              ? m.env
              : {},
          ),
          originalName: String(m.name || "") || undefined,
        }))
      : [],
    skills: Array.isArray(config.skills)
      ? (config.skills as Array<Record<string, unknown>>).map((s) => ({
          type: (s.type === "anthropic" ? "anthropic" : "custom") as "anthropic" | "custom",
          skill_id: String(s.skill_id || ""),
          ...(typeof s.version === "string" ? { version: s.version } : {}),
        }))
      : [],
    callableAgents: Array.isArray(multiagent?.agents)
      ? multiagent.agents.flatMap((entry): CallableEntry[] =>
          entry.type === "agent" && typeof entry.id === "string"
            ? [{
                type: "agent",
                id: entry.id,
                ...(typeof entry.version === "number" && Number.isInteger(entry.version)
                  ? { version: entry.version }
                  : {}),
              }]
            : [],
        )
      : [],
    ...toolPolicy,
  };
}

export function agentToForm(agent: Agent): FormState {
  return configToForm(agent as unknown as Record<string, unknown>);
}

export function buildModelValue(
  form: FormState,
  existingModel?: unknown,
): string | Record<string, unknown> {
  if (
    existingModel &&
    typeof existingModel === "object" &&
    !Array.isArray(existingModel) &&
    modelIdOf(existingModel) === form.model
  ) {
    const model = structuredClone(existingModel as Record<string, unknown>);
    model.id = form.model;
    if (form.modelSpeed === "standard" || form.modelSpeed === "fast") {
      model.speed = form.modelSpeed;
    } else {
      delete model.speed;
    }
    return model;
  }
  return form.modelSpeed === "standard" || form.modelSpeed === "fast"
    ? { id: form.model, speed: form.modelSpeed }
    : form.model;
}

/** Form-managed built-in toolset entry only. */
export function buildManagedToolset(
  form: FormState,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const priorConfigs = Array.isArray(existing?.configs)
    ? existing.configs.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  const priorByName = new Map(
    priorConfigs.flatMap((entry) =>
      typeof entry.name === "string" ? [[entry.name, entry] as const] : [],
    ),
  );
  const configs: Record<string, unknown>[] = [];

  for (const prior of priorConfigs) {
    const name = typeof prior.name === "string" ? prior.name : undefined;
    if (name === undefined || !Object.hasOwn(form.toolOverrides, name)) {
      configs.push(structuredClone(prior));
      continue;
    }
    const mode = form.toolOverrides[name];
    const next = structuredClone(prior);
    if (mode === "default") {
      delete next.enabled;
      delete next.permission_policy;
      const meaningfulKeys = Object.keys(next).filter(
        (key) => key !== "name" && key !== "type",
      );
      if (meaningfulKeys.length > 0) configs.push(next);
      continue;
    }
    if (mode === "disabled") {
      next.enabled = false;
      delete next.permission_policy;
    } else {
      next.enabled = true;
      next.permission_policy = { type: mode };
    }
    configs.push(next);
  }

  for (const [name, mode] of Object.entries(form.toolOverrides)) {
    if (priorByName.has(name) || mode === "default") continue;
    configs.push(
      mode === "disabled"
        ? { name, enabled: false }
        : { name, enabled: true, permission_policy: { type: mode } },
    );
  }

  const priorDefault =
    existing?.default_config && typeof existing.default_config === "object"
      ? structuredClone(existing.default_config as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = {
    ...(existing ? structuredClone(existing) : {}),
    type: "agent_toolset_20260401",
    default_config: {
      ...priorDefault,
      enabled: form.toolDefaultEnabled,
      permission_policy: { type: form.toolDefaultPermission },
    },
  };
  if (configs.length > 0) result.configs = configs;
  else delete result.configs;
  return result;
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
  const priorManagedToolset = existing.find(
    (tool): tool is Record<string, unknown> =>
      !!tool &&
      typeof tool === "object" &&
      !Array.isArray(tool) &&
      (tool as { type?: unknown }).type === "agent_toolset_20260401",
  );
  const managedToolset = buildManagedToolset(form, priorManagedToolset);
  const handledMcp = new Set<McpEntry>();
  let handledManagedToolset = false;
  const result: unknown[] = [];

  for (const tool of existing) {
    if (!tool || typeof tool !== "object") {
      result.push(tool);
      continue;
    }
    const type = (tool as { type?: unknown }).type;
    if (type === "agent_toolset_20260401" && !handledManagedToolset) {
      result.push(managedToolset);
      handledManagedToolset = true;
      continue;
    }
    if (type === "mcp_toolset") {
      const priorName = (tool as { mcp_server_name?: unknown }).mcp_server_name;
      const mcp = form.mcpServers.find(
        (entry) => (entry.originalName || entry.name) === priorName,
      );
      if (mcp === undefined || !mcp.name) continue;
      handledMcp.add(mcp);
      result.push({
        ...structuredClone(tool as Record<string, unknown>),
        mcp_server_name: mcp.name,
      });
      continue;
    }
    result.push(structuredClone(tool));
  }

  if (!handledManagedToolset) result.unshift(managedToolset);

  for (const mcp of form.mcpServers.filter((entry) => entry.name && !handledMcp.has(entry))) {
    result.push({
      type: "mcp_toolset",
      mcp_server_name: mcp.name,
      default_config: { permission_policy: { type: "always_allow" } },
    });
  }

  return result;
}

function mergeMultiagent(
  existing: unknown,
  callableAgents: CallableEntry[],
): Record<string, unknown> | null {
  const prior =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : undefined;
  const priorRoster = Array.isArray(prior?.agents)
    ? prior.agents.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  const requested = new Map(callableAgents.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const roster: Record<string, unknown>[] = [];

  for (const member of priorRoster) {
    if (member.type !== "agent" || typeof member.id !== "string") {
      roster.push(structuredClone(member));
      continue;
    }
    const replacement = requested.get(member.id);
    if (replacement === undefined) continue;
    seen.add(member.id);
    const next = {
      ...structuredClone(member),
      type: "agent",
      id: replacement.id,
      ...(replacement.version !== undefined
        ? { version: replacement.version }
        : {}),
    };
    if (replacement.version === undefined) delete next.version;
    roster.push(next);
  }
  for (const member of callableAgents) {
    if (seen.has(member.id)) continue;
    roster.push({ ...member });
  }
  if (roster.length === 0) return null;
  return {
    ...(prior ? structuredClone(prior) : {}),
    type: "coordinator",
    agents: roster,
  };
}

/**
 * Merge form MCP rows onto existing servers by name while preserving unknown
 * extension keys. Removed form rows are dropped.
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
      const next: Record<string, unknown> = {
        ...(prior ?? {}),
        name: m.name,
        type: m.type,
      };
      if (m.type === "stdio") {
        if (!m.command.startsWith("/")) {
          throw new Error(`MCP stdio command for "${m.name}" must be an absolute path`);
        }
        const args = JSON.parse(m.argsJson || "[]") as unknown;
        if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) {
          throw new Error(`MCP stdio args for "${m.name}" must be a JSON string array`);
        }
        const env = JSON.parse(m.envJson || "{}") as unknown;
        if (
          !env || typeof env !== "object" || Array.isArray(env)
          || !Object.values(env).every((value) => typeof value === "string")
        ) {
          throw new Error(`MCP stdio env for "${m.name}" must be a JSON string map`);
        }
        delete next.url;
        delete next.stdio;
        next.command = m.command;
        next.args = args;
        next.env = env;
        return next;
      }
      delete next.command;
      delete next.args;
      delete next.env;
      delete next.stdio;
      if (m.url) next.url = m.url;
      return next;
    });
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
  for (const k of OMA_ONLY_KEYS) delete payload[k];

  payload.name = form.name;
  payload.model = buildModelValue(form, base?.model);
  payload.tools = mergeToolsField(existingTools, form);
  const metadata = parseMetadataJson(form.metadataJson);
  if (forUpdate) {
    const currentMetadata =
      base?.metadata &&
      typeof base.metadata === "object" &&
      !Array.isArray(base.metadata)
        ? (base.metadata as Record<string, string>)
        : {};
    const patch = metadataPatch(currentMetadata, metadata);
    if (Object.keys(patch).length > 0) payload.metadata = patch;
    else delete payload.metadata;
  } else if (Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  } else {
    delete payload.metadata;
  }

  const existingOpenMa =
    base?._oma && typeof base._oma === "object"
      ? (base._oma as Record<string, unknown>)
      : undefined;
  const openma: Record<string, unknown> = existingOpenMa
    ? structuredClone(existingOpenMa)
    : {};
  if (form.auxiliaryModel) {
    const priorAuxiliary =
      existingOpenMa?.aux_model &&
      typeof existingOpenMa.aux_model === "object" &&
      modelIdOf(existingOpenMa.aux_model) === form.auxiliaryModel
        ? structuredClone(existingOpenMa.aux_model as Record<string, unknown>)
        : {};
    openma.aux_model = {
      ...priorAuxiliary,
      id: form.auxiliaryModel,
      ...(form.auxiliaryModelSpeed
        ? { speed: form.auxiliaryModelSpeed }
        : {}),
    };
    if (!form.auxiliaryModelSpeed) {
      delete (openma.aux_model as Record<string, unknown>).speed;
    }
  } else if (forUpdate && existingOpenMa?.aux_model !== undefined) {
    openma.aux_model = null;
  } else {
    delete openma.aux_model;
  }
  if (form.appendablePrompts.length > 0) {
    openma.appendable_prompts = form.appendablePrompts;
  } else if (forUpdate && existingOpenMa?.appendable_prompts !== undefined) {
    openma.appendable_prompts = [];
  } else {
    delete openma.appendable_prompts;
  }
  if (Object.keys(openma).length > 0) payload._oma = openma;
  else delete payload._oma;

  if (forUpdate) {
    payload.system = form.system || null;
    payload.description = form.description || null;
    payload.mcp_servers = form.mcpServers.some((m) => m.name)
      ? mergeMcpServers(existingMcp, form.mcpServers)
      : null;
    payload.skills = form.skills.length ? form.skills : null;
    payload.multiagent = mergeMultiagent(base?.multiagent, form.callableAgents);
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
    if (form.skills.length) payload.skills = form.skills;
    else delete payload.skills;
    const multiagent = mergeMultiagent(base?.multiagent, form.callableAgents);
    if (multiagent !== null) {
      payload.multiagent = multiagent;
    } else {
      delete payload.multiagent;
    }
  }

  return payload;
}
