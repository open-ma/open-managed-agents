// Anthropic-compatible error envelope normalization.
//
// Background: Anthropic's official SDK (and competitors like sandbox0) expect
// every 4xx/5xx response to follow the shape:
//
//   { "type": "error",
//     "error": { "type": "<error_type>", "message": "<human readable>" },
//     "request_id": "<correlator>" }
//
// The SDK uses `error.error.type` to classify failures (`authentication_error`,
// `not_found_error`, `rate_limit_error`, ...) so callers can write robust
// `catch (e) { if (e.error?.error?.type === 'authentication_error') ... }`
// logic. The OMA codebase historically returned `{ "error": "<string>" }`,
// which means SDK callers can only see the HTTP status, not the kind.
//
// This middleware runs LAST in the chain. It inspects every outgoing response
// with status >= 400; if the body is a single-string `{error: "..."}` shape,
// it rewrites it into the Anthropic envelope. All 236 existing
// `c.json({error: "..."}, 4xx)` call sites stay as-is — the wire-level shape
// is normalized in one place.
//
// Status → error.type mapping mirrors Anthropic's published taxonomy:
//   401 → authentication_error
//   403 → permission_error
//   404 → not_found_error
//   409 → conflict_error  (not in Anthropic's set but matches REST convention)
//   422 → invalid_request_error
//   429 → rate_limit_error
//   400/4xx (other) → invalid_request_error
//   501 → not_implemented (used by our memory_store update stub)
//   5xx (other) → api_error

import type { MiddlewareHandler } from "hono";

function deriveErrorType(status: number, existing?: string): string {
  // If the handler already supplied a typed error envelope (e.g. our memory
  // update stub returns `{error: {type: "not_implemented", ...}}` directly),
  // honor the type it gave us.
  if (existing) return existing;
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 422) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (status === 501) return "not_implemented";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function requestIdFor(c: Parameters<MiddlewareHandler>[0]): string {
  // Prefer Cloudflare's cf-ray (already correlated with CF logs / dashboards).
  // Fall back to a UUID-derived 32-char hex so callers always see something.
  const ray = c.req.header("cf-ray");
  if (ray) return ray;
  // Hex without dashes mirrors Anthropic's request_id shape.
  // workerd / Node ≥20 / Deno / browsers all expose Web Crypto globally.
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return uuid.replace(/-/g, "").slice(0, 32);
}

export const errorEnvelopeMiddleware: MiddlewareHandler = async (c, next) => {
  await next();

  const status = c.res.status;
  if (status < 400) return;

  // Only touch JSON responses. Streaming endpoints (SSE) and binary
  // responses (file downloads) keep their own content-type.
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;

  // Read the body once; if parsing fails, leave the response untouched.
  let parsed: unknown;
  try {
    parsed = await c.res.clone().json();
  } catch {
    return;
  }

  if (!parsed || typeof parsed !== "object") return;
  const body = parsed as Record<string, unknown>;

  // Already-canonical shape? Just make sure request_id + top-level type are
  // present (legacy handlers may have set `error: {type, message}` without
  // the rest of the envelope).
  if (
    body.error &&
    typeof body.error === "object" &&
    !Array.isArray(body.error) &&
    typeof (body.error as { type?: unknown }).type === "string"
  ) {
    if (body.type === "error" && body.request_id) return;
    const enriched = {
      ...body,
      type: "error" as const,
      request_id: body.request_id ?? requestIdFor(c),
    };
    c.res = new Response(JSON.stringify(enriched), {
      status,
      headers: c.res.headers,
    });
    return;
  }

  // Legacy `{error: "<string>"}` shape — wrap it.
  if (typeof body.error === "string") {
    const wrapped = {
      type: "error" as const,
      error: {
        type: deriveErrorType(status),
        message: body.error,
      },
      request_id: requestIdFor(c),
    };
    c.res = new Response(JSON.stringify(wrapped), {
      status,
      headers: c.res.headers,
    });
    return;
  }
};
