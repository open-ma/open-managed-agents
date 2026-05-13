// CF impl of InstallBridge — wraps the in-process LinearProvider /
// GitHubProvider / SlackProvider already wired in apps/integrations.
//
// On CF, this bridge runs INSIDE apps/integrations (not apps/main). The
// package routes are mounted on apps/integrations alongside this bridge
// so OAuth callbacks land in the worker that owns the install state.
//
// apps/main keeps its existing `/linear/*` -> INTEGRATIONS proxy lines
// untouched (they're the public entrypoint). The bridge here is what the
// proxied request hits on the inner side.

import type {
  ContinueInstallArgs,
  ContinueInstallResult,
  InstallBridge,
  LinearMcpCredentialLookupArgs,
  LinearMcpCredentialLookupResult,
  RefreshGithubVaultArgs,
  RefreshGithubVaultResult,
} from "@open-managed-agents/integrations-core";
import {
  mintAppJwt,
  buildInstallationTokenRequest,
  parseInstallationTokenResponse,
} from "@open-managed-agents/github";
import { buildContainer, buildGitHubContainer } from "./wire";
import { buildProviders } from "./providers";
import type { Env } from "./env";

export interface CfBridgeOpts {
  env: Env;
}

export class CfInstallBridge implements InstallBridge {
  constructor(private readonly opts: CfBridgeOpts) {}

  async continueInstall(args: ContinueInstallArgs): Promise<ContinueInstallResult> {
    const { env } = this.opts;
    const providers = buildProviders(env);

    if (args.provider === "linear") {
      const container = buildContainer(env);
      const stateRaw = args.state ?? "";
      // Re-route into the legacy reauth path when state.kind says so;
      // matches dedicated-callback.ts behavior.
      let stateKind: string | null = null;
      try {
        const payload = await container.jwt.verify<{ kind?: string }>(stateRaw);
        stateKind = payload.kind ?? null;
      } catch {
        throw new Error("invalid_state");
      }
      if (stateKind === "linear.oauth.reauth") {
        const r = await providers.linear.completeReauthorize({
          appId: args.providerInstallationId ?? "",
          code: args.code ?? "",
          state: stateRaw,
          redirectBase: env.GATEWAY_ORIGIN,
        });
        // reauth doesn't produce a publicationId; rotation path. Surface a
        // synthetic id so the route's redirect can render — Console treats
        // `install=ok` as enough.
        return { publicationId: r.installationId, returnUrl: null };
      }
      const result = await providers.linear.continueInstall({
        publicationId: null,
        payload: {
          kind: "oauth_callback_dedicated",
          appId: args.providerInstallationId,
          code: args.code,
          state: stateRaw,
        },
      });
      if (result.kind !== "complete") throw new Error("unexpected install result");
      const statePayload = await container.jwt.verify<{ returnUrl: string }>(stateRaw);
      return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
    }

    if (args.provider === "github") {
      const container = buildGitHubContainer(env);
      const stateRaw = args.state ?? "";
      const isManifest = Boolean(args.extra?.manifest);
      const result = await providers.github.continueInstall({
        publicationId: null,
        payload: isManifest
          ? { kind: "manifest_callback", code: args.code, state: stateRaw }
          : {
              kind: "install_callback",
              appOmaId: args.providerInstallationId,
              installationId: args.extra?.installationId,
              state: stateRaw,
            },
      });
      if (result.kind === "step" && result.step === "install_link") {
        // Manifest path: result.data carries the install URL — surface it
        // through returnUrl so the route can redirect. publicationId not
        // available yet; we use the appOmaId as a placeholder marker.
        return {
          publicationId: String(result.data.appOmaId ?? "pending"),
          returnUrl: String(result.data.url),
        };
      }
      if (result.kind !== "complete") throw new Error("unexpected install result");
      const statePayload = await container.jwt.verify<{ returnUrl: string }>(stateRaw);
      return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
    }

    // Slack
    const stateRaw = args.state ?? "";
    const slackContainer = buildContainer(env);
    const result = await providers.slack.continueInstall({
      publicationId: null,
      payload: {
        kind: "oauth_callback_dedicated",
        appId: args.providerInstallationId,
        code: args.code,
        state: stateRaw,
      },
    });
    if (result.kind !== "complete") throw new Error("unexpected install result");
    const statePayload = await slackContainer.jwt.verify<{ returnUrl: string }>(stateRaw);
    return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
  }

  async refreshGithubVault(
    args: RefreshGithubVaultArgs,
  ): Promise<RefreshGithubVaultResult> {
    const container = buildGitHubContainer(this.opts.env);
    const installations = await container.installations.listByUser(args.userId, "github");
    const installation = installations.find((i) => i.vaultId === args.vaultId);
    if (!installation || !installation.appId) {
      throw new Error("no github installation for vault");
    }
    const app = await container.githubApps.get(installation.appId);
    if (!app) throw new Error("app row missing");
    const privateKey = await container.githubApps.getPrivateKey(app.id);
    if (!privateKey) throw new Error("private key missing");
    const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
    const tokReq = buildInstallationTokenRequest(appJwt, installation.workspaceId);
    const tokRes = await container.http.fetch({
      method: "POST",
      url: tokReq.url,
      headers: tokReq.headers,
      body: tokReq.body,
    });
    if (tokRes.status < 200 || tokRes.status >= 300) {
      throw new Error(`github_token_mint_failed: ${tokRes.body.slice(0, 200)}`);
    }
    const fresh = parseInstallationTokenResponse(tokRes.body);
    await container.vaults.rotateBearerToken({
      userId: args.userId,
      vaultId: args.vaultId,
      newBearerToken: fresh.token,
    });
    await container.vaults.rotateCapCliToken({
      userId: args.userId,
      vaultId: args.vaultId,
      cliId: "gh",
      newToken: fresh.token,
    });
    return { token: fresh.token, expiresAt: fresh.expiresAt };
  }

  async lookupLinearCredentialForSession(
    args: LinearMcpCredentialLookupArgs,
  ): Promise<LinearMcpCredentialLookupResult> {
    const env = this.opts.env;
    const sessionRes = await env.MAIN.fetch(
      `http://main/v1/internal/sessions/${encodeURIComponent(args.sessionId)}`,
      {
        method: "GET",
        headers: { "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET },
      },
    );
    if (!sessionRes.ok) throw new Error(`session lookup ${sessionRes.status}`);
    const session = (await sessionRes.json()) as {
      metadata?: {
        linear?: { publicationId?: string; mcp_token?: string; issueId?: string | null };
      };
    };
    const linearMeta = session.metadata?.linear;
    if (!linearMeta?.mcp_token || linearMeta.mcp_token !== args.bearerToken) {
      throw new Error("invalid token");
    }
    if (!linearMeta.publicationId) {
      throw new Error("session not linked to a Linear publication");
    }
    const container = buildContainer(env);
    const providers = buildProviders(env, container);
    const pub = await container.publications.get(linearMeta.publicationId);
    if (!pub) throw new Error("publication not found");
    const accessToken = await container.installations.getAccessToken(pub.installationId);
    if (!accessToken) throw new Error("App OAuth token not available");

    return {
      publicationId: pub.id,
      installationId: pub.installationId,
      userId: pub.userId,
      issueId: linearMeta.issueId ?? null,
      accessToken,
      refreshAccessToken: () =>
        providers.linear.refreshAccessToken(pub.installationId),
    };
  }
}
