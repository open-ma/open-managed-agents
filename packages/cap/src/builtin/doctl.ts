// doctl — DigitalOcean CLI.
//
// Header injection: api.digitalocean.com REST. Uses long-lived API tokens
// (no public OAuth device flow exposed for CLI use; DO's OAuth is
// auth-code only and oriented at server-side apps).

import type { CapSpec } from "../types";

export const doctlSpec: CapSpec = {
  cli_id: "doctl",
  description: "DigitalOcean CLI (doctl) — Bearer injection",
  endpoints: ["api.digitalocean.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { DIGITALOCEAN_ACCESS_TOKEN: "__cap_managed__" },
  },
};
