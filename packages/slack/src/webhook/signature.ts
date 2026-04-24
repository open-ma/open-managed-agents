// Slack request signing — verification helpers.
//
// Slack signs every Events API request with HMAC-SHA256 over the basestring
// `v0:{timestamp}:{rawBody}`, hex-encoded, prefixed `v0=`. The signing secret
// is per-App and lives in App admin → Basic Information.
//
// Reference: https://docs.slack.dev/authentication/verifying-requests-from-slack/
//
// Pure helpers; HMAC verification is delegated to the injected HmacVerifier
// (which compares the hex digest in constant time).

/** Maximum allowed clock skew between Slack and the gateway. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

/**
 * Construct the basestring Slack signs:
 *   `v0:{timestamp}:{rawBody}`
 *
 * Pass the raw bytes of the request body as a string — JSON.parse + re-stringify
 * does NOT round-trip Slack's serialization (whitespace, key order), and any
 * mismatch breaks the signature.
 */
export function buildBaseString(timestamp: string, rawBody: string): string {
  return `v0:${timestamp}:${rawBody}`;
}

export interface ParsedSignature {
  /** Signature scheme version. Slack currently emits "v0". */
  version: string;
  /** Hex-encoded HMAC-SHA256 digest. */
  hex: string;
}

/**
 * Parse the value of `X-Slack-Signature` (e.g. `v0=abc123…`). Returns null
 * for unrecognized formats so the caller can drop the request rather than
 * throw mid-pipeline.
 */
export function parseSignatureHeader(value: string | undefined): ParsedSignature | null {
  if (!value) return null;
  const match = /^(v\d+)=([0-9a-f]+)$/i.exec(value.trim());
  if (!match) return null;
  return { version: match[1].toLowerCase(), hex: match[2].toLowerCase() };
}

/**
 * Reject requests whose `X-Slack-Request-Timestamp` is older than the skew
 * limit (replay protection). `nowMs` is the gateway's current time.
 */
export function isTimestampFresh(
  timestamp: string,
  nowMs: number,
  maxSkewSeconds: number = MAX_TIMESTAMP_SKEW_SECONDS,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ageSeconds = Math.abs(nowMs / 1000 - ts);
  return ageSeconds <= maxSkewSeconds;
}
