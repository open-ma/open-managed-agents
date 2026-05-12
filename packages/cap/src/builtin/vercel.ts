// vercel — Vercel CLI.
//
// Header injection: api.vercel.com REST. Uses long-lived account or team
// access tokens (no public OAuth device flow). Tokens loaded into vault
// out-of-band via Vercel dashboard's Personal Access Token UI.

import type { CapSpec } from "../types";

export const vercelSpec: CapSpec = {
  cli_id: "vercel",
  description: "Vercel CLI — Bearer injection",
  endpoints: ["api.vercel.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { VERCEL_TOKEN: "__cap_managed__" },
  },
};
