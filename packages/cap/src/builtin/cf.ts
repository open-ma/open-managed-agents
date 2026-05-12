// cf — Cloudflare API.
//
// One spec, multiple consumer CLIs: `cf` (Cloudflare's new unified CLI,
// `npm i -g cf`), `wrangler` (Workers/Pages), and any direct API users
// all hit api.cloudflare.com with `Authorization: Bearer <token>`. Same
// pattern as `aws` covering the CLI + every AWS SDK.
//
// Header injection: api.cloudflare.com REST. The legacy global-API-key
// auth pair (X-Auth-Key + X-Auth-Email) is stripped to prevent a sandbox
// from smuggling a stolen key past us.
//
// No OAuth section: Cloudflare's first-party flow is OAuth 2.0
// Authorization Code with a localhost callback — not RFC 8628 device
// flow. CAP currently only models device flow, so users must mint an API
// token in the Cloudflare dashboard (My Profile → API Tokens) and load it
// into the vault out-of-band. Authorization-Code support is a possible
// future extension once we have a callback-handling story for sandboxes.

import type { CapSpec } from "../types";

export const cfSpec: CapSpec = {
  cli_id: "cf",
  description:
    "Cloudflare API (cf / wrangler / Workers SDK) — Bearer injection",
  endpoints: ["api.cloudflare.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization", "x-auth-key", "x-auth-email"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { CLOUDFLARE_API_TOKEN: "__cap_managed__" },
  },
};
