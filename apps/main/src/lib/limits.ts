// Field-size caps on agent / environment mutations.
//
// Mirrors the Anthropic Managed Agents API caps so list/retrieve can
// safely return the full object without rows blowing up payload size or
// D1 row size. We enforce on POST/PUT only — existing rows that predate
// these caps stay readable; we never retroactively reject them.
//
// Anthropic's published caps (verified against @anthropic-ai/sdk@0.95.0
// types and the public API reference):
//
//   agent.system           ≤ 100,000 chars
//   agent.tools            ≤ 128 entries (toolset configs + custom tools)
//   agent.mcp_servers      ≤ 20
//   agent.skills           ≤ 20
//   agent.metadata         ≤ 16 keys; key ≤ 64 chars; value ≤ 512 chars
//   agent.name             ≤ 256 chars (1-256)
//   agent.description      ≤ 2048 chars
//
// OMA-specific (no Anthropic equivalent):
//   environment.config.dockerfile         ≤ 100,000 chars
//   environment.config.packages.<eco>     ≤ 100 entries per ecosystem
//
// Naming: ValidationError is intentionally a plain object, not a thrown
// class, so the route layer can map it to a 400 with a clear message
// without unwinding the stack. Errors mention the offending field and
// the limit value.

export type ValidationResult = { ok: true } | { ok: false; error: string };

const NAME_MAX = 256;
const DESCRIPTION_MAX = 2048;
const SYSTEM_MAX = 100_000;
const TOOLS_MAX = 128;
const MCP_SERVERS_MAX = 20;
const SKILLS_MAX = 20;
const METADATA_KEYS_MAX = 16;
const METADATA_KEY_CHARS_MAX = 64;
const METADATA_VALUE_CHARS_MAX = 512;
const DOCKERFILE_MAX = 100_000;
const PACKAGES_PER_ECO_MAX = 100;

function validateMetadata(
  field: string,
  metadata: unknown,
): ValidationResult {
  if (metadata === undefined || metadata === null) return { ok: true };
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, error: `${field} must be an object` };
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > METADATA_KEYS_MAX) {
    return {
      ok: false,
      error: `${field} has ${entries.length} keys; max ${METADATA_KEYS_MAX}`,
    };
  }
  for (const [k, v] of entries) {
    if (k.length > METADATA_KEY_CHARS_MAX) {
      return {
        ok: false,
        error: `${field}.${k} key length ${k.length} exceeds ${METADATA_KEY_CHARS_MAX}`,
      };
    }
    // Anthropic stores metadata values as strings only; we accept any JSON
    // value but length-check the serialized form for non-strings (so a
    // huge nested array doesn't sneak through).
    const serialized = typeof v === "string" ? v : JSON.stringify(v);
    if (serialized.length > METADATA_VALUE_CHARS_MAX) {
      return {
        ok: false,
        error: `${field}.${k} value length ${serialized.length} exceeds ${METADATA_VALUE_CHARS_MAX}`,
      };
    }
  }
  return { ok: true };
}

export interface AgentLimitsInput {
  name?: string;
  description?: string | null;
  system?: string | null;
  tools?: unknown[] | null;
  mcp_servers?: unknown[] | null;
  skills?: unknown[] | null;
  metadata?: Record<string, unknown> | null;
}

export function validateAgentLimits(input: AgentLimitsInput): ValidationResult {
  if (input.name !== undefined && input.name.length > NAME_MAX) {
    return { ok: false, error: `name length ${input.name.length} exceeds ${NAME_MAX}` };
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > DESCRIPTION_MAX
  ) {
    return {
      ok: false,
      error: `description length ${input.description.length} exceeds ${DESCRIPTION_MAX}`,
    };
  }
  if (
    input.system !== undefined &&
    input.system !== null &&
    input.system.length > SYSTEM_MAX
  ) {
    return {
      ok: false,
      error: `system length ${input.system.length} exceeds ${SYSTEM_MAX}`,
    };
  }
  if (input.tools !== undefined && input.tools !== null && input.tools.length > TOOLS_MAX) {
    return { ok: false, error: `tools length ${input.tools.length} exceeds ${TOOLS_MAX}` };
  }
  if (
    input.mcp_servers !== undefined &&
    input.mcp_servers !== null &&
    input.mcp_servers.length > MCP_SERVERS_MAX
  ) {
    return {
      ok: false,
      error: `mcp_servers length ${input.mcp_servers.length} exceeds ${MCP_SERVERS_MAX}`,
    };
  }
  if (
    input.skills !== undefined &&
    input.skills !== null &&
    input.skills.length > SKILLS_MAX
  ) {
    return { ok: false, error: `skills length ${input.skills.length} exceeds ${SKILLS_MAX}` };
  }
  return validateMetadata("metadata", input.metadata);
}

export interface EnvironmentLimitsInput {
  name?: string;
  description?: string | null;
  config?: {
    type?: string;
    dockerfile?: string;
    packages?: Record<string, unknown>;
    [k: string]: unknown;
  } | null;
  metadata?: Record<string, unknown> | null;
}

export function validateEnvironmentLimits(
  input: EnvironmentLimitsInput,
): ValidationResult {
  if (input.name !== undefined && input.name.length > NAME_MAX) {
    return { ok: false, error: `name length ${input.name.length} exceeds ${NAME_MAX}` };
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > DESCRIPTION_MAX
  ) {
    return {
      ok: false,
      error: `description length ${input.description.length} exceeds ${DESCRIPTION_MAX}`,
    };
  }
  if (input.config) {
    const dockerfile = input.config.dockerfile;
    if (typeof dockerfile === "string" && dockerfile.length > DOCKERFILE_MAX) {
      return {
        ok: false,
        error: `config.dockerfile length ${dockerfile.length} exceeds ${DOCKERFILE_MAX}`,
      };
    }
    const packages = input.config.packages;
    if (packages && typeof packages === "object") {
      for (const [eco, list] of Object.entries(packages)) {
        if (Array.isArray(list) && list.length > PACKAGES_PER_ECO_MAX) {
          return {
            ok: false,
            error: `config.packages.${eco} length ${list.length} exceeds ${PACKAGES_PER_ECO_MAX}`,
          };
        }
      }
    }
  }
  return validateMetadata("metadata", input.metadata);
}
