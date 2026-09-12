import { sdkContractDescriptors, sdkContractRoots } from "./sdk-contracts.generated";

type Descriptor = { kind: string; value?: unknown; variants?: string[]; element?: string; properties?: Record<string, { schema: string; required: boolean }>; additional?: string };
const descriptors: Record<string, Descriptor> = sdkContractDescriptors;
export interface OpenAIAgentsValidationIssue { path: string; message: string }
export type OpenAIAgentsValidation = { success: true } | { success: false; issue: OpenAIAgentsValidationIssue };
const fail = (path: string, message: string): OpenAIAgentsValidation => ({ success: false, issue: { path, message } });

/** Validates without stripping, coercing, or copying any JSON field. */
export function validateOpenAIAgentsSchema(value: unknown, schemaName: string, options: { allowUnknown?: boolean; omit?: string[] } = {}): OpenAIAgentsValidation {
  const root = sdkContractRoots[schemaName];
  if (!root) throw new Error(`Unknown OpenAI contract ${schemaName}`);
  function check(value: unknown, id: string, path: string, depth: number): OpenAIAgentsValidation {
    if (depth > 100) return fail(path, "Maximum JSON nesting depth exceeded");
    const descriptor = descriptors[id];
    if (!descriptor) throw new Error(`Missing OpenAI contract ${id}`);
    switch (descriptor.kind) {
      case "unknown": return { success: true };
      case "never": return fail(path, "Value is not allowed");
      case "literal": return value === descriptor.value ? { success: true } : fail(path, `Expected ${JSON.stringify(descriptor.value)}`);
      case "null": return value === null ? { success: true } : fail(path, "Expected null");
      case "string": case "boolean": case "number":
        return typeof value === descriptor.kind && (descriptor.kind !== "number" || Number.isFinite(value)) ? { success: true } : fail(path, `Expected ${descriptor.kind}`);
      case "union": {
        let best: OpenAIAgentsValidationIssue | undefined;
        for (const variant of descriptor.variants!) {
          const result = check(value, variant, path, depth + 1);
          if (result.success) return result;
          if (!best || result.issue.path.length > best.path.length) best = result.issue;
        }
        return { success: false, issue: best ?? { path, message: "Invalid value" } };
      }
      case "array": {
        if (!Array.isArray(value)) return fail(path, "Expected array");
        for (let index = 0; index < value.length; index++) {
          const result = check(value[index], descriptor.element!, `${path}[${index}]`, depth + 1);
          if (!result.success) return result;
        }
        return { success: true };
      }
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value)) return fail(path, "Expected object");
        const record = value as Record<string, unknown>;
        const properties = descriptor.properties!;
        for (const [key, field] of Object.entries(properties)) {
          if (path === "" && options.omit?.includes(key)) continue;
          const fieldPath = path ? `${path}.${key}` : key;
          if (!Object.hasOwn(record, key)) {
            if (field.required) return fail(fieldPath, "Required field is missing");
            continue;
          }
          const result = check(record[key], field.schema, fieldPath, depth + 1);
          if (!result.success) return result;
        }
        for (const key of Object.keys(record)) {
          if (Object.hasOwn(properties, key) && !(path === "" && options.omit?.includes(key))) continue;
          const fieldPath = path ? `${path}.${key}` : key;
          if (descriptor.additional) {
            const result = check(record[key], descriptor.additional, fieldPath, depth + 1);
            if (!result.success) return result;
          } else if (!options.allowUnknown) return fail(fieldPath, "Unknown field");
        }
        return { success: true };
      }
      default: throw new Error(`Unknown schema kind ${descriptor.kind}`);
    }
  }
  return check(value, root, "", 0);
}

/** Documentation constraints absent from the SDK's TypeScript declarations. */
export function validateOpenAIAgentsRequestSemantics(operation: string, body: Record<string, unknown>, query: Record<string, unknown>): OpenAIAgentsValidation {
  const limit = query.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1)) return fail("limit", "Expected a positive integer");
  for (const key of ["after", "page"]) if (query[key] === "") return fail(key, "Cursor must not be empty");
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object") {
    const entries = Object.entries(metadata);
    if (entries.length > 16) return fail("metadata", "At most 16 metadata entries are allowed");
    for (const [key, value] of entries) if (key.length > 64 || typeof value !== "string" || value.length > 512) return fail(`metadata.${key}`, "Metadata keys allow 64 characters and values allow 512 characters");
  }
  if ((operation === "agents.create" || operation === "agents.update") && body.model === "") return fail("model", "Model must not be empty");
  if (operation === "sessions.create") {
    const agent = body.agent as Record<string, unknown> | undefined;
    if (!body.agent_id && !agent?.model) return fail("agent.model", "A model is required when agent_id is omitted");
  }
  if (operation === "sessions.events.create" && Array.isArray(body.events) && !body.events.length) return fail("events", "At least one input event is required");
  for (const key of ["name"]) {
    if (operation.startsWith("vaults") && typeof body[key] === "string" && new TextEncoder().encode(body[key]).length > 256) return fail(key, "Name allows at most 256 UTF-8 bytes");
  }
  return { success: true };
}

export { sdkContractRoots };
