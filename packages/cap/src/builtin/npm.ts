// npm — npm registry.
//
// Header injection: registry.npmjs.org. Modern npm CLI sends granular
// access tokens (`npm_*`) as `Authorization: Bearer <token>`. Older
// classic tokens worked the same way; both formats are accepted.
// No OAuth device flow upstream — tokens are minted in the npmjs.com
// account UI.

import type { CapSpec } from "../types";

export const npmSpec: CapSpec = {
  cli_id: "npm",
  description: "npm registry — Bearer injection",
  endpoints: ["registry.npmjs.org"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    // Classic npm convention: NPM_TOKEN is read by `npm publish` and
    // many CI tools. Sentinel rather than a real value.
    env: { NPM_TOKEN: "__cap_managed__" },
  },
};
