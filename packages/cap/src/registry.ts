import {
  matchesHostname,
  validateHostnamePattern,
} from "./hostname-match";
import type { CapSpec } from "./types";

export interface SpecRegistry {
  /**
   * Returns the spec for `cli_id`, or null. cli_id comparison is exact
   * (case-sensitive) — by convention all built-in cli_ids are lowercase.
   */
  byCliId(cli_id: string): CapSpec | null;

  /**
   * Returns the spec whose `endpoints` patterns include `hostname`.
   * Exact-match patterns win over wildcard patterns. Among patterns of the
   * same kind, the first registered wins. Returns null if no spec matches.
   * Hostname comparison is case-insensitive.
   */
  byHostname(hostname: string): CapSpec | null;

  /** All specs in registration order. */
  all(): readonly CapSpec[];
}

/**
 * Builds a SpecRegistry. Throws at construction time on:
 *   - duplicate cli_id across specs
 *   - any malformed hostname pattern in any spec's endpoints
 *   - missing mode-specific sub-object (e.g. inject_mode="header" but no `header`)
 *
 * Lookup is O(N) over endpoints — N is small (~20 specs total in production
 * use), and the per-request hot path runs once per outbound request, so a
 * sublinear index isn't worth the complexity.
 */
export function createSpecRegistry(specs: readonly CapSpec[]): SpecRegistry {
  const seenIds = new Set<string>();
  for (const spec of specs) {
    if (seenIds.has(spec.cli_id)) {
      throw new Error(`SpecRegistry: duplicate cli_id "${spec.cli_id}"`);
    }
    seenIds.add(spec.cli_id);

    if (spec.endpoints.length === 0) {
      throw new Error(
        `SpecRegistry: spec "${spec.cli_id}" has empty endpoints`,
      );
    }
    for (const ep of spec.endpoints) validateHostnamePattern(ep);

    validateModeSubObject(spec);
    validateOAuth(spec);
  }

  const list = specs.slice();

  const byId = new Map<string, CapSpec>();
  for (const s of list) byId.set(s.cli_id, s);

  return {
    byCliId(cli_id: string): CapSpec | null {
      return byId.get(cli_id) ?? null;
    },

    byHostname(hostname: string): CapSpec | null {
      // Two passes: exact patterns first, wildcards second. Within each
      // pass, first-registered wins.
      for (const spec of list) {
        for (const ep of spec.endpoints) {
          if (!ep.startsWith("*.") && matchesHostname(ep, hostname)) return spec;
        }
      }
      for (const spec of list) {
        for (const ep of spec.endpoints) {
          if (ep.startsWith("*.") && matchesHostname(ep, hostname)) return spec;
        }
      }
      return null;
    },

    all(): readonly CapSpec[] {
      return list;
    },
  };
}

function validateModeSubObject(spec: CapSpec): void {
  switch (spec.inject_mode) {
    case "header":
      if (!spec.header) {
        throw new Error(
          `SpecRegistry: spec "${spec.cli_id}" inject_mode="header" but header sub-object is missing`,
        );
      }
      return;
    case "metadata_ep":
      if (!spec.metadata) {
        throw new Error(
          `SpecRegistry: spec "${spec.cli_id}" inject_mode="metadata_ep" but metadata sub-object is missing`,
        );
      }
      return;
    case "exec_helper":
      if (!spec.exec) {
        throw new Error(
          `SpecRegistry: spec "${spec.cli_id}" inject_mode="exec_helper" but exec sub-object is missing`,
        );
      }
      return;
  }
}

function validateOAuth(spec: CapSpec): void {
  if (!spec.oauth) return;
  const df = spec.oauth.device_flow;
  if (!df) {
    throw new Error(
      `SpecRegistry: spec "${spec.cli_id}" oauth set but device_flow missing`,
    );
  }
  for (const field of ["initiate_url", "token_url", "client_id"] as const) {
    if (!df[field] || typeof df[field] !== "string") {
      throw new Error(
        `SpecRegistry: spec "${spec.cli_id}" oauth.device_flow.${field} must be a non-empty string`,
      );
    }
  }
  if (!Array.isArray(df.scopes)) {
    throw new Error(
      `SpecRegistry: spec "${spec.cli_id}" oauth.device_flow.scopes must be an array`,
    );
  }
}
