import type { ResourceObject } from "./resource-types";

const KEY = "__openai_agents_v1";
interface Envelope { version: 1; kind: string; fields: ResourceObject; original?: string }

/** External configuration shares the existing resource/version record. Only fields
 * absent from the native primitive live here; native fields remain authoritative. */
export function encodeResourceMetadata(metadata: Record<string, string>, kind: string, fields: ResourceObject): Record<string, string> {
  const original = metadata[KEY];
  const envelope: Envelope = { version: 1, kind, fields, ...(original !== undefined && { original }) };
  return { ...metadata, [KEY]: JSON.stringify(envelope) };
}

export function decodeResourceMetadata(metadata: Record<string, string>, kind: string): { metadata: Record<string, string>; fields: ResourceObject | null } {
  let envelope: Envelope;
  try { envelope = JSON.parse(metadata[KEY] ?? "null"); } catch { return { metadata: { ...metadata }, fields: null }; }
  if (!envelope || envelope.version !== 1 || envelope.kind !== kind || !envelope.fields || typeof envelope.fields !== "object") return { metadata: { ...metadata }, fields: null };
  const publicMetadata = { ...metadata };
  delete publicMetadata[KEY];
  if (envelope.original !== undefined) publicMetadata[KEY] = envelope.original;
  return { metadata: publicMetadata, fields: envelope.fields };
}

export function nameHint(wireName: string | null, nativeName: string): ResourceObject {
  return wireName === nativeName ? {} : { name: { native: nativeName, wire: wireName } };
}

export function hintedName(nativeName: string, fields: ResourceObject | null): string | null {
  return fields?.name?.native === nativeName ? fields.name.wire : nativeName;
}
