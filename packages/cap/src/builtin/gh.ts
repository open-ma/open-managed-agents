// gh — GitHub CLI.
//
// Header injection: api.github.com (GraphQL + REST) and uploads.github.com
// (release asset uploads). Modern gh sends `Authorization: Bearer <token>`
// with a fine-grained PAT, classic PAT, or GitHub App user-to-server token.
//
// OAuth device flow: the official gh CLI's public OAuth app id is used here
// so consumers can run the dance immediately. Production deployments
// should register their own GitHub OAuth App and override `client_id`.
// Endpoints are the standard GitHub OAuth + device-authorization URLs;
// `Accept: application/json` is mandatory because GitHub defaults to
// `application/x-www-form-urlencoded` responses otherwise.

import type { CapSpec } from "../types";

export const ghSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI (gh) — REST + GraphQL injection, plus OAuth device flow",
  endpoints: ["api.github.com", "uploads.github.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization", "x-github-token"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
  bootstrap: {
    env: { GITHUB_TOKEN: "__cap_managed__" },
  },
  oauth: {
    device_flow: {
      initiate_url: "https://github.com/login/device/code",
      token_url: "https://github.com/login/oauth/access_token",
      // Public client_id of the official gh CLI. Replace with a
      // registered GitHub OAuth App for production multi-tenant use.
      client_id: "178c6fc778ccc68e1d6a",
      scopes: ["repo", "read:org", "gist", "workflow"],
      request_headers: { Accept: "application/json" },
    },
  },
};
