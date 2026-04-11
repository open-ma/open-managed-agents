/**
 * Response formatting utilities.
 * Anthropic API returns null for unset nullable fields and [] for empty arrays,
 * never undefined. This module normalizes our internal types to match.
 */

/**
 * Replace undefined with null for all top-level keys in an object.
 * Ensures API responses use null instead of omitting fields.
 */
export function nullifyUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) {
      (result as any)[key] = null;
    }
  }
  return result;
}
