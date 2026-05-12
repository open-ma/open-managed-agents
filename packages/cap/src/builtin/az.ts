// az — Microsoft Azure CLI.
//
// Header injection: api requests to management.azure.com (Azure Resource
// Manager). Azure data-plane APIs (storage, key vault, graph) live on
// other hostnames and require resource-specific tokens — out of scope for
// this first wave; users extend the registry per-tenant if they need
// data-plane injection.
//
// OAuth device flow: Microsoft identity platform endpoints. Uses az's
// public client_id (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). The
// `organizations` tenant accepts both work and personal accounts via
// the v2 endpoint — a multi-tenant CAP deployment can override to
// `common` (any account) or a specific tenant guid.
//
// Scope `https://management.azure.com/.default` requests an ARM-scoped
// token; `offline_access` opts into refresh tokens. Microsoft's `.default`
// suffix tells the issuer "give me whatever scopes the app's static
// configuration declares for this resource", which matches how az itself
// requests ARM tokens internally.
//
// Bootstrap is intentionally empty: az has no `AZURE_ACCESS_TOKEN`
// equivalent, so we can't convince its own login machinery it's already
// authenticated. CAP-driven OAuth populates the vault; the CLI side
// either already has a local MSAL cache from a one-off `az login`, or
// the consumer talks to ARM via SDKs that send Bearer themselves.

import type { CapSpec } from "../types";

export const azSpec: CapSpec = {
  cli_id: "az",
  description: "Azure CLI (az) — Bearer injection to ARM, plus OAuth device flow",
  endpoints: ["management.azure.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  oauth: {
    device_flow: {
      initiate_url:
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
      token_url:
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      // Public client_id of the Azure CLI. Documented and stable; replace
      // with your own multi-tenant Microsoft Entra app registration for
      // production use if you want consent screens to show your branding.
      client_id: "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
      scopes: [
        "https://management.azure.com/.default",
        "offline_access",
      ],
    },
  },
};
