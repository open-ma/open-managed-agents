// Tiny hostname matcher — only what CAP needs.
//
// Two pattern shapes:
//   1. Exact:   "api.github.com" matches itself (case-insensitive).
//   2. Prefix:  "*.foo.bar"     matches any host ending in ".foo.bar"
//                                with at least one preceding label.
//
// No mid-segment globs ("api.*.foo"), no double-wildcard ("**.foo"), no
// trailing wildcard ("foo.*"), no bare "*". Two-labels-after-wildcard
// minimum (so "*.com" is rejected).
//
// Hostname comparison is case-insensitive; pattern is normalised to lower
// at validation time. No port stripping — caller passes the bare hostname.

const EXACT_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function validateHostnamePattern(pattern: string): void {
  if (pattern.length === 0) {
    throw new Error(`Invalid hostname pattern: empty string`);
  }
  if (pattern.includes("/")) {
    throw new Error(
      `Invalid hostname pattern "${pattern}": contains "/" — pass a hostname, not a URL`,
    );
  }
  if (pattern === "*") {
    throw new Error(`Invalid hostname pattern: bare "*" matches everything`);
  }
  if (pattern.startsWith(".")) {
    throw new Error(
      `Invalid hostname pattern "${pattern}": leading dot is not permitted (use "*.foo.bar" for subdomain match)`,
    );
  }

  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (suffix.includes("*")) {
      throw new Error(
        `Invalid hostname pattern "${pattern}": only a single leading wildcard is supported`,
      );
    }
    const labels = suffix.split(".");
    if (labels.length < 2) {
      throw new Error(
        `Invalid hostname pattern "${pattern}": wildcard suffix must have at least two labels (e.g. "*.foo.bar"), not "*.bar"`,
      );
    }
    for (const label of labels) validateLabel(label, pattern);
    return;
  }

  if (pattern.includes("*")) {
    throw new Error(
      `Invalid hostname pattern "${pattern}": wildcard must appear only as a leading "*." prefix`,
    );
  }

  for (const label of pattern.split(".")) validateLabel(label, pattern);
}

function validateLabel(label: string, fullPattern: string): void {
  if (!EXACT_LABEL.test(label)) {
    throw new Error(
      `Invalid hostname pattern "${fullPattern}": label "${label}" is not a valid DNS label`,
    );
  }
}

/**
 * Returns true iff `hostname` matches `pattern`. Case-insensitive on the
 * host. Pattern shape is NOT validated here — call validateHostnamePattern
 * at registry-build time and trust patterns at lookup time.
 */
export function matchesHostname(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();

  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // includes the leading dot, e.g. ".amazonaws.com"
    return h.length > suffix.length && h.endsWith(suffix);
  }

  return p === h;
}
