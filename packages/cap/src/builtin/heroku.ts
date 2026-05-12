// heroku — Heroku Platform CLI.
//
// Header injection: api.heroku.com REST. Heroku tokens are sent as
// `Authorization: Bearer <token>`. Heroku also requires an
// `Accept: application/vnd.heroku+json; version=3` header, but the CLI
// and SDKs already set it themselves — we don't add it.
//
// No OAuth section: Heroku's user OAuth is browser-redirect Authorization
// Code (not RFC 8628 device flow). Tokens are minted out-of-band via
// `heroku auth:token` (one-year expiry by default) or
// `heroku authorizations:create --no-expires` and loaded into the vault.

import type { CapSpec } from "../types";

export const herokuSpec: CapSpec = {
  cli_id: "heroku",
  description: "Heroku Platform CLI (heroku) — Bearer injection",
  endpoints: ["api.heroku.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    // The CLI reads HEROKU_API_KEY from the env, overriding ~/.netrc.
    // Sentinel value — real token is injected at request time.
    env: { HEROKU_API_KEY: "__cap_managed__" },
  },
};
