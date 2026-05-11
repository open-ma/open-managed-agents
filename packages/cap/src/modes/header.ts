// header_inject mode — strips a configured set of headers and injects a
// new one with `${token}` substituted into the value template.
//
// Behaviour summary:
//   - token present → kind="forward" with rewritten request
//   - token null    → kind="passthrough" (don't strip, don't add — let the
//                     CLI's own header reach upstream and surface a 401 the
//                     user can debug)
//
// All header matching is case-insensitive. The output's header keys
// preserve the case the spec declared for the new header, and the case
// the original request used for retained headers.

import type { CapSpec, HttpHandleResult, HttpReqLike } from "../types";
import type { ResolvedToken } from "../ports";

const TOKEN_RE = /\$\{token\}/g;

export function applyHeader(
  spec: CapSpec,
  token: ResolvedToken | null,
  req: HttpReqLike,
): HttpHandleResult {
  if (token === null) {
    return { kind: "passthrough" };
  }
  // We're guaranteed by registry validation that header is set when
  // inject_mode === "header"; this also tells the type narrower.
  const headerSpec = spec.header!;

  const stripSet = new Set(headerSpec.strip.map((h) => h.toLowerCase()));
  const newHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!stripSet.has(k.toLowerCase())) {
      newHeaders[k] = v;
    }
  }

  // After stripping, also drop any existing key whose name would collide
  // with the spec's set name (case-insensitive). Otherwise we'd end up
  // with two same-name headers in the rewritten map.
  const setNameLower = headerSpec.set.name.toLowerCase();
  for (const k of Object.keys(newHeaders)) {
    if (k.toLowerCase() === setNameLower) delete newHeaders[k];
  }

  newHeaders[headerSpec.set.name] = headerSpec.set.value.replace(TOKEN_RE, token.token);

  return {
    kind: "forward",
    req: {
      url: req.url,
      method: req.method,
      headers: newHeaders,
      body: req.body,
    },
  };
}
