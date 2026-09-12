/**
 * Pure create/edit codec for AgentFormDialog.
 *
 * Form mode only models a subset of AgentConfig. Updates and Form↔YAML/JSON
 * switches must be lossless for unsupported fields (model.speed, custom
 * tools, MCP stdio, unknown toolsets, metadata, etc.). Full-field UI is
 * tracked separately in #155 — this module only guarantees round-trips.
 */
import type { AgentRecord as Agent } from "../../types/agent";

export interface McpEntry {
  name: string;
  type: string;
  url: string;
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
  const multiagent = config.multiagent as { agents?: CallableEntry[] } | undefined;
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
    modelCardId: "",
    system: String(config.system || ""),
    description: String(config.description || ""),
    mcpServers: Array.isArray(config.mcp_servers)
      ? (config.mcp_servers as Array<Record<string, unknown>>).map((m) => ({
          name: String(m.name || ""),
          type: String(m.type || "url"),
          url: typeof m.url === "string" ? m.url : "",
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
      ? multiagent.agents.map((a) => ({
          type: "agent" as const,
          id: a.id,
          version: a.version ?? 1,
        }))
      : [],
    ...toolPolicy,
  };
}

export function agentToForm(agent: Agent): FormState {
  return configToForm(agent as unknown as Record<string, unknown>);
}

export function buildModelValue(
  form: FormState,
): string | { id: string; speed: "standard" | "fast" } {
  if (form.modelSpeed === "standard" || form.modelSpeed === "fast") {
    return { id: form.model, speed: form.modelSpeed };
  }
  return form.model;
}

/** Form-managed built-in toolset entry only. */
export function buildManagedToolset(form: FormState): Record<string, unknown> {
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
  return {
    type: "agent_toolset_20260401",
    default_config: {
      enabled: form.toolDefaultEnabled,
      permission_policy: { type: form.toolDefaultPermission },
    },
    ...(overrides.length > 0 ? { configs: overrides } : {}),
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
  const result: unknown[] = [buildManagedToolset(form)];

  for (const tool of existing) {
    if (!tool || typeof tool !== "object") {
      result.push(tool);
      continue;
    }
    const type = (tool as { type?: unknown }).type;
    if (type === "agent_toolset_20260401") continue;
    if (type === "mcp_toolset") continue;
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
        return { name: m.name, type: m.type || "url", ...(m.url ? { url: m.url } : {}) };
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
  payload.model = buildModelValue(form);
  payload.tools = mergeToolsField(existingTools, form);

  const existingOpenMa =
    base?._oma && typeof base._oma === "object"
      ? (base._oma as Record<string, unknown>)
      : undefined;
  const openma: Record<string, unknown> = existingOpenMa
    ? structuredClone(existingOpenMa)
    : {};
  if (form.auxiliaryModel) {
    const priorAuxiliary =
      existingOpenMa?.aux_model && typeof existingOpenMa.aux_model === "object"
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
    payload.multiagent = form.callableAgents.length
      ? { type: "coordinator", agents: form.callableAgents }
      : null;
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
    if (form.callableAgents.length) {
      payload.multiagent = { type: "coordinator", agents: form.callableAgents };
    } else {
      delete payload.multiagent;
    }
  }

  return payload;
}
