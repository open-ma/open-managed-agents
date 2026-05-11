// gcloud — Google Cloud SDK family, via GCE metadata server emulation.
//
// gcloud / google-auth-library / every google-cloud-* SDK reads from the
// GCE metadata server when it sees the `GCE_METADATA_HOST` env var pointing
// at a reachable address (or by detecting a 169.254.169.254 host).
//
// CAP serves the OAuth access_token endpoint
// (`/computeMetadata/v1/instance/service-accounts/default/token`); the SDK
// uses the returned bearer token to talk to *.googleapis.com directly.
// The required `Metadata-Flavor: Google` header is enforced by L2 — a
// real GCE metadata server rejects requests missing it with 403.
//
// OAuth device flow: gcloud's published public client_id works for the
// device authorization grant. Production deployments may want to register
// their own Google OAuth client.

import type { CapSpec } from "../types";

export const gcloudSpec: CapSpec = {
  cli_id: "gcloud",
  description: "Google Cloud SDK — GCE metadata server emulation, plus OAuth device flow",
  endpoints: ["metadata.google.internal", "169.254.169.254"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "gcp_metadata_v1",
    path: "/computeMetadata/v1/instance/service-accounts/default/token",
    required_request_headers: { "Metadata-Flavor": "Google" },
  },
  bootstrap: {
    // GCE_METADATA_HOST overrides the default metadata host; L4 sets it
    // when binding outside the canonical 169.254.169.254 path.
    env: { GCE_METADATA_HOST: "metadata.google.internal" },
  },
  endpoint_binding: {
    env_var: "GCE_METADATA_HOST",
    value_template: "${cap_host}:${cap_port}",
  },
  oauth: {
    device_flow: {
      // Google's OAuth 2.0 device authorization endpoint.
      initiate_url: "https://oauth2.googleapis.com/device/code",
      token_url: "https://oauth2.googleapis.com/token",
      // gcloud CLI's public OAuth client. Registered by Google for
      // first-party CLI use; replace with your own for production.
      client_id: "32555940559.apps.googleusercontent.com",
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
    },
  },
};
