// glab — GitLab CLI.
//
// Header injection: gitlab.com REST + GraphQL. glab accepts both
// `Authorization: Bearer <oauth-token>` and the GitLab-specific
// `PRIVATE-TOKEN: <pat>` header. We strip both and re-inject Bearer for
// uniformity — modern glab uses OAuth access tokens.
//
// OAuth device flow: GitLab's device authorization endpoint. The
// `client_id` here MUST be replaced with a registered GitLab OAuth
// application for production use; GitLab does not publish a "default
// glab CLI" client id the way GitHub does for gh.

import type { CapSpec } from "../types";

export const glabSpec: CapSpec = {
  cli_id: "glab",
  description: "GitLab CLI (glab) — Bearer/PRIVATE-TOKEN injection, plus OAuth device flow",
  endpoints: ["gitlab.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization", "private-token"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { GITLAB_TOKEN: "__cap_managed__" },
  },
  oauth: {
    device_flow: {
      initiate_url: "https://gitlab.com/oauth/authorize_device",
      token_url: "https://gitlab.com/oauth/token",
      // Placeholder — register your own GitLab application and override.
      client_id: "__cap_register_glab_oauth_app__",
      scopes: ["api", "read_user"],
    },
  },
};
