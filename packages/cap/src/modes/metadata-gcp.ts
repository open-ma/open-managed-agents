// metadata-gcp mode — emulates the GCE metadata server's
// `/computeMetadata/v1/instance/service-accounts/default/token` endpoint.
// Returns the OAuth access_token shape gcloud / google-auth-library
// (and every google-cloud-* SDK) expects.
//
// Spec reference: https://cloud.google.com/compute/docs/access/authenticate-workloads
//
// Required request validation: every spec.metadata.required_request_headers
// entry is a literal string match (case-insensitive on header name) — the
// canonical case is `Metadata-Flavor: Google`, which the GCP SDK always
// sends and a real metadata server requires (rejects with 403 otherwise).

import type { CapSpec, HttpHandleResult, HttpReqLike } from "../types";
import type { Clock, ResolvedToken } from "../ports";

export function applyGcpMetadata(
  spec: CapSpec,
  token: ResolvedToken | null,
  req: HttpReqLike,
  clock: Clock,
): HttpHandleResult {
  if (!validateRequestHeaders(spec, req)) {
    return jsonRespond(403, { error: "missing or invalid Metadata-Flavor" });
  }

  if (token === null) {
    return jsonRespond(401, { error: "no_credential" });
  }

  if (token.expires_at === undefined) {
    return jsonRespond(500, {
      error: "malformed_credential",
      detail: "expires_at is required for metadata_ep mode",
    });
  }

  const remainingMs = token.expires_at - clock.nowMs();
  if (remainingMs <= 0) {
    // Returning expires_in=0 (or negative) would cause the SDK to spin
    // refreshing immediately. Surface a 500 so the resolver can re-resolve
    // with a fresh token.
    return jsonRespond(500, {
      error: "malformed_credential",
      detail: "credential is already expired",
    });
  }

  return {
    kind: "respond",
    res: {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Metadata-Flavor": "Google",
      },
      body: JSON.stringify({
        access_token: token.token,
        expires_in: Math.floor(remainingMs / 1000),
        token_type: "Bearer",
      }),
    },
  };
}

function validateRequestHeaders(spec: CapSpec, req: HttpReqLike): boolean {
  const required = spec.metadata?.required_request_headers;
  if (!required || Object.keys(required).length === 0) return true;

  for (const [headerName, expected] of Object.entries(required)) {
    // GCP doesn't use match_bootstrap_token — only literal-string matches.
    // If a future protocol re-uses this code path with bootstrap matching,
    // factor the comparator out (similar to metadata-aws).
    const actual = headerValueCi(req.headers, headerName);
    if (actual !== expected) return false;
  }
  return true;
}

function headerValueCi(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function jsonRespond(status: number, body: unknown): HttpHandleResult {
  return {
    kind: "respond",
    res: {
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}
