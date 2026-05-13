// InstallBridge — runtime port the package routes (OAuth callbacks, setup
// pages, Linear MCP, GitHub refresh-by-vault) call into so they don't need
// to know whether the host calls back through a CF service binding or runs
// the install in-process.
//
// CF impl: wraps the existing INTEGRATIONS service binding + MAIN RPC
// surfaces (cf-install-bridge in apps/main).
// Node impl: direct in-process — imports the same providers + services that
// CF used to reach via the binding (node-install-bridge in apps/main-node).
//
// Method surface is intentionally small. Anything more provider-specific
// stays inside the provider package (e.g. LinearProvider.continueInstall);
// the bridge only owns the cross-cutting bits a route needs to pick the
// right provider, lookup session-bound creds, and mint App-JWT-derived
// tokens for GitHub Apps.

import type { ProviderId } from "./domain";

/** The OAuth callback handlers all flow through this single entrypoint.
 *  Routing by `provider` keeps `packages/http-routes` free of imports
 *  for `@open-managed-agents/{linear,github,slack}` (they're heavy + only
 *  one runs per install). */
export interface ContinueInstallArgs {
  provider: ProviderId;
  /** OAuth `code` from the upstream redirect, or undefined for the manifest /
   *  install-callback paths that don't use one. */
  code?: string | null;
  /** OAuth `state` JWT we minted in startInstall. Carries returnUrl + userId. */
  state?: string | null;
  /** Provider-side install id — Linear App id (lin), GitHub App OMA id, or
   *  Slack App id. Path-derived. */
  providerInstallationId?: string | null;
  /** Extra payload bits (e.g. github setupAction, manifest exchange code) to
   *  pass through to the provider's continueInstall — opaque to the bridge. */
  extra?: Record<string, unknown>;
}

export interface ContinueInstallResult {
  /** Provider's publication id — what the route's redirect target encodes. */
  publicationId: string;
  /** State JWT payload's returnUrl, so the route can build the final
   *  302 target. The bridge re-verifies state internally; surfacing the
   *  decoded URL keeps each route from re-doing JWT crypto. */
  returnUrl: string | null;
}

/** GitHub `refresh-by-vault` mints a fresh installation token via App-JWT,
 *  then rotates both the static_bearer + cap_cli vault credentials in
 *  place. Same path the cf cf-route-services session-create lifecycle
 *  hook calls. */
export interface RefreshGithubVaultArgs {
  userId: string;
  vaultId: string;
}

export interface RefreshGithubVaultResult {
  token: string;
  /** ISO-8601 expiry from GitHub. */
  expiresAt: string;
}

/** Linear MCP looks up the cred bound to the session by reading session
 *  metadata.linear.publicationId, then resolving the publication's
 *  installation accessToken (refreshing when expired). */
export interface LinearMcpCredentialLookupArgs {
  sessionId: string;
  /** Per-session bearer the route extracted from `Authorization`. The bridge
   *  validates it against session metadata.linear.mcp_token and rejects
   *  mismatches — the route doesn't repeat the check. */
  bearerToken: string;
}

export interface LinearMcpCredentialLookupResult {
  publicationId: string;
  installationId: string;
  userId: string;
  /** Issue id the bot was originally bound to (per_issue session). */
  issueId: string | null;
  /** The current Linear OAuth access token. The Linear MCP route uses this
   *  for the GraphQL escape hatch and refreshes via `refreshAccessToken`
   *  on AUTHENTICATION_ERROR. */
  accessToken: string;
  /** Refresher closure — called on auth failure to mint a fresh token from
   *  Linear's `/oauth/token` and persist it. Returns the new access token. */
  refreshAccessToken: () => Promise<string>;
}

/** Drive the publication-create flow (start-a1, credentials, handoff-link,
 *  personal-token) for one provider. CF impl forwards via the INTEGRATIONS
 *  service binding; Node impl runs the provider in-process. The wire-shape
 *  must be identical across runtimes — Console + CLI talk to either. */
export interface StartInstallationArgs {
  provider: ProviderId;
  /** Which sub-route is being invoked. Mirrors the four endpoints under
   *  /v1/integrations/{provider}/. */
  mode: "start-a1" | "credentials" | "handoff-link" | "personal-token";
  /** Parsed JSON body from the originating route. Provider-specific shape;
   *  the bridge passes it through to provider.startInstall /
   *  provider.continueInstall / provider.installPersonalToken without
   *  reshaping. */
  body: Record<string, unknown>;
}

/** Wire response — verbatim what the route should JSON-serialize. Status
 *  codes mirror the CF implementation (400 / 500 mapped from provider
 *  errors). */
export interface StartInstallationResult {
  status: number;
  body: Record<string, unknown>;
}

export interface InstallBridge {
  /** Complete an OAuth install — exchange `code`, mint creds, persist into a
   *  vault, optionally bind to the originating session. Returns the new
   *  publication id + the state JWT's returnUrl so the route can redirect. */
  continueInstall(args: ContinueInstallArgs): Promise<ContinueInstallResult>;

  /** Mint a fresh GitHub installation token via App-JWT, rotate both vault
   *  creds in place. Both runtimes call into provider-specific helpers
   *  internally; the bridge owns the lookup-by-vault logic. */
  refreshGithubVault(
    args: RefreshGithubVaultArgs,
  ): Promise<RefreshGithubVaultResult>;

  /** Look up the Linear credential bound to a session. Used by /linear/mcp/
   *  :sessionId to find the access token for the GraphQL escape hatch. */
  lookupLinearCredentialForSession(
    args: LinearMcpCredentialLookupArgs,
  ): Promise<LinearMcpCredentialLookupResult>;

  /** Drive a publication-create sub-route for the given provider. Optional —
   *  hosts that don't expose publication-create endpoints can leave it
   *  undefined; the package routes 503 in that case. */
  startInstallation?(
    args: StartInstallationArgs,
  ): Promise<StartInstallationResult>;
}
