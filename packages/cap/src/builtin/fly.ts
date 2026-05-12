// fly — Fly.io CLI.
//
// Header injection: api.fly.io GraphQL endpoint. Uses long-lived
// `fo1_*` API tokens; no OAuth device flow available upstream as of
// this writing. Users provision tokens via `flyctl auth token` and load
// them into the vault out-of-band.

import type { CapSpec } from "../types";

export const flySpec: CapSpec = {
  cli_id: "fly",
  description: "Fly.io CLI (fly / flyctl) — Bearer injection",
  endpoints: ["api.fly.io"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { FLY_API_TOKEN: "__cap_managed__" },
  },
};
