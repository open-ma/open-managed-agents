// Node impl of InstallBridge — direct in-process. No service binding.
//
// On Node, the InstallBridge runs inside main-node. It builds providers
// (Linear / GitHub / Slack) on the fly with a runtime-agnostic Container
// whose VaultManager / SessionCreator are wired against the in-process
// services bundle. The same providers from packages/{linear,github,slack}
// — same code path the CF gateway already runs — just with different
// adapters under them.

import type {
  ContinueInstallArgs,
  ContinueInstallResult,
  InstallBridge,
  LinearMcpCredentialLookupArgs,
  LinearMcpCredentialLookupResult,
  RefreshGithubVaultArgs,
  RefreshGithubVaultResult,
  StartInstallationArgs,
  StartInstallationResult,
  Container,
  CreateCapCliInput,
  CreateCredentialInput,
  CreateSessionInput,
  SessionCreator,
  SessionEventInput,
  SessionId,
  VaultManager,
  UserId,
} from "@open-managed-agents/integrations-core";
import {
  ALL_CAPABILITIES as ALL_LINEAR_CAPS,
  DEFAULT_LINEAR_SCOPES,
  LinearProvider,
  type LinearContainer,
} from "@open-managed-agents/linear";
import {
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
  GitHubProvider,
  mintAppJwt,
  buildInstallationTokenRequest,
  parseInstallationTokenResponse,
} from "@open-managed-agents/github";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_USER_SCOPES,
  SlackProvider,
  type SlackContainer,
} from "@open-managed-agents/slack";
import {
  buildNodeRepos,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  SqlSlackWebhookEventStore,
  SqlSlackSetupLinkRepo,
} from "@open-managed-agents/integrations-adapters-node";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { VaultService } from "@open-managed-agents/vaults-store";
import type { CredentialService } from "@open-managed-agents/credentials-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { AgentService } from "@open-managed-agents/agents-store";
import type {
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("apps.main-node.install-bridge");

/** Append-event hook into the host's session router so webhook → resume
 *  drives the same path as a human-typed `POST /v1/sessions/:id/events`.
 *  See `apps/main-node/src/index.ts` for the wiring. */
export type AppendUserEventHook = (
  sessionId: string,
  tenantId: string,
  agentId: string,
  event: SessionEvent,
) => Promise<void>;

export interface NodeInstallBridgeOpts {
  sql: SqlClient;
  platformRootSecret: string;
  gatewayOrigin: string;
  vaults: VaultService;
  credentials: CredentialService;
  sessions: SessionService;
  agents: AgentService;
  /** Look up the OMA tenantId for a userId. main-node uses the membership
   *  table for this; we accept it as a callback so the bridge stays
   *  agnostic to better-auth wiring. */
  resolveTenantId: (userId: string) => Promise<string | null>;
  /** Optional: append a webhook-driven event onto an existing session. When
   *  unset, `InProcessSessionCreator.resume` is a no-op (older callers
   *  don't depend on it; main-node wires it). */
  appendUserEvent?: AppendUserEventHook;
}

export class NodeInstallBridge implements InstallBridge {
  constructor(private readonly opts: NodeInstallBridgeOpts) {}

  async continueInstall(args: ContinueInstallArgs): Promise<ContinueInstallResult> {
    const containers = this.buildContainers();
    const { jwt } = containers.linear;

    if (args.provider === "linear") {
      const provider = new LinearProvider(containers.linear, {
        gatewayOrigin: this.opts.gatewayOrigin,
        scopes: DEFAULT_LINEAR_SCOPES,
        defaultCapabilities: ALL_LINEAR_CAPS,
      });
      const stateRaw = args.state ?? "";
      let stateKind: string | null = null;
      try {
        const payload = await jwt.verify<{ kind?: string }>(stateRaw);
        stateKind = payload.kind ?? null;
      } catch {
        throw new Error("invalid_state");
      }
      if (stateKind === "linear.oauth.reauth") {
        const r = await provider.completeReauthorize({
          appId: args.providerInstallationId ?? "",
          code: args.code ?? "",
          state: stateRaw,
          redirectBase: this.opts.gatewayOrigin,
        });
        return { publicationId: r.installationId, returnUrl: null };
      }
      const result = await provider.continueInstall({
        publicationId: null,
        payload: {
          kind: "oauth_callback_dedicated",
          appId: args.providerInstallationId,
          code: args.code,
          state: stateRaw,
        },
      });
      if (result.kind !== "complete") throw new Error("unexpected install result");
      const statePayload = await jwt.verify<{ returnUrl: string }>(stateRaw);
      return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
    }

    if (args.provider === "github") {
      const provider = new GitHubProvider(containers.github, {
        gatewayOrigin: this.opts.gatewayOrigin,
        defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
        mcpServerUrl: DEFAULT_GITHUB_MCP_URL,
      });
      const stateRaw = args.state ?? "";
      const isManifest = Boolean(args.extra?.manifest);
      const result = await provider.continueInstall({
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
        return {
          publicationId: String(result.data.appOmaId ?? "pending"),
          returnUrl: String(result.data.url),
        };
      }
      if (result.kind !== "complete") throw new Error("unexpected install result");
      const statePayload = await jwt.verify<{ returnUrl: string }>(stateRaw);
      return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
    }

    // Slack
    const provider = new SlackProvider(containers.slack, {
      gatewayOrigin: this.opts.gatewayOrigin,
      botScopes: DEFAULT_SLACK_BOT_SCOPES,
      userScopes: DEFAULT_SLACK_USER_SCOPES,
      defaultCapabilities: ALL_SLACK_CAPABILITIES,
    });
    const stateRaw = args.state ?? "";
    const result = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "oauth_callback_dedicated",
        appId: args.providerInstallationId,
        code: args.code,
        state: stateRaw,
      },
    });
    if (result.kind !== "complete") throw new Error("unexpected install result");
    const statePayload = await jwt.verify<{ returnUrl: string }>(stateRaw);
    return { publicationId: result.publicationId, returnUrl: statePayload.returnUrl };
  }

  async refreshGithubVault(
    args: RefreshGithubVaultArgs,
  ): Promise<RefreshGithubVaultResult> {
    const containers = this.buildContainers();
    const container = containers.github;
    const installations = await container.installations.listByUser(args.userId, "github");
    const installation = installations.find((i) => i.vaultId === args.vaultId);
    if (!installation || !installation.appId) throw new Error("no github installation for vault");
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
    const containers = this.buildContainers();
    const linear = containers.linear;
    // Read session metadata directly — no internal-secret RPC hop on Node.
    const session = await this.opts.sessions.getById({ sessionId: args.sessionId });
    if (!session) throw new Error(`session lookup not found`);
    const meta = (session.metadata as { linear?: Record<string, unknown> } | undefined)?.linear;
    if (!meta) throw new Error("session not linked to a Linear publication");
    const mcpToken = meta.mcp_token as string | undefined;
    if (!mcpToken || mcpToken !== args.bearerToken) throw new Error("invalid token");
    const publicationId = meta.publicationId as string | undefined;
    if (!publicationId) throw new Error("session not linked to a Linear publication");
    const issueId = (meta.issueId as string | null | undefined) ?? null;

    const pub = await linear.publications.get(publicationId);
    if (!pub) throw new Error("publication not found");
    const accessToken = await linear.installations.getAccessToken(pub.installationId);
    if (!accessToken) throw new Error("App OAuth token not available");

    const provider = new LinearProvider(linear, {
      gatewayOrigin: this.opts.gatewayOrigin,
      scopes: DEFAULT_LINEAR_SCOPES,
      defaultCapabilities: ALL_LINEAR_CAPS,
    });

    return {
      publicationId: pub.id,
      installationId: pub.installationId,
      userId: pub.userId,
      issueId,
      accessToken,
      refreshAccessToken: () => provider.refreshAccessToken(pub.installationId),
    };
  }

  async startInstallation(
    args: StartInstallationArgs,
  ): Promise<StartInstallationResult> {
    // Same publication-create wire shapes as apps/integrations/src/routes/
    // {linear,github,slack}/publications.ts. Status codes (200 / 400 / 500)
    // and JSON envelopes preserved verbatim — Console + CLI talk to either.
    const containers = this.buildContainers();
    const providers = {
      linear: new LinearProvider(containers.linear, {
        gatewayOrigin: this.opts.gatewayOrigin,
        scopes: DEFAULT_LINEAR_SCOPES,
        defaultCapabilities: ALL_LINEAR_CAPS,
      }),
      github: new GitHubProvider(containers.github, {
        gatewayOrigin: this.opts.gatewayOrigin,
        defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
        mcpServerUrl: DEFAULT_GITHUB_MCP_URL,
      }),
      slack: new SlackProvider(containers.slack, {
        gatewayOrigin: this.opts.gatewayOrigin,
        botScopes: DEFAULT_SLACK_BOT_SCOPES,
        userScopes: DEFAULT_SLACK_USER_SCOPES,
        defaultCapabilities: ALL_SLACK_CAPABILITIES,
      }),
    } as const;
    const provider = providers[args.provider];
    if (!provider) return jsonResp(400, { error: `unknown provider: ${args.provider}` });
    const body = args.body;

    if (args.mode === "start-a1") {
      if (!body.userId || !body.agentId || !body.environmentId || !body.personaName || !body.returnUrl) {
        return jsonResp(400, {
          error: "userId, agentId, environmentId, personaName, returnUrl required",
        });
      }
      const result = await provider.startInstall({
        userId: body.userId as string,
        agentId: body.agentId as string,
        environmentId: body.environmentId as string,
        mode: "full",
        persona: {
          name: body.personaName as string,
          avatarUrl: (body.personaAvatarUrl as string | null) ?? null,
        },
        returnUrl: body.returnUrl as string,
      });
      if (result.kind !== "step" || result.step !== "credentials_form") {
        return jsonResp(500, { error: "unexpected install result", result });
      }
      return jsonResp(200, result.data);
    }

    if (args.mode === "credentials") {
      const required = requiredCredentialsKeys(args.provider);
      for (const key of required) {
        if (!body[key]) return jsonResp(400, credentialsBadInputBody(args.provider, required));
      }
      try {
        const result = await provider.continueInstall({
          publicationId: null,
          payload: { kind: "submit_credentials", ...body },
        });
        if (result.kind !== "step" || result.step !== "install_link") {
          return jsonResp(500, { error: "unexpected continue result", result });
        }
        return jsonResp(200, result.data);
      } catch (err) {
        return mapInstallErrorToResp(args.provider, "credentials", err);
      }
    }

    if (args.mode === "handoff-link") {
      if (!body.formToken) return jsonResp(400, { error: "formToken required" });
      try {
        const result = await provider.continueInstall({
          publicationId: null,
          payload: { kind: "handoff_link", formToken: body.formToken as string },
        });
        if (result.kind !== "step" || result.step !== "install_link") {
          return jsonResp(500, { error: "unexpected handoff result", result });
        }
        return jsonResp(200, result.data);
      } catch (err) {
        return mapInstallErrorToResp(args.provider, "handoff", err);
      }
    }

    if (args.mode === "personal-token") {
      if (args.provider !== "linear") {
        return jsonResp(400, { error: "personal-token install only supported on linear" });
      }
      if (!body.userId || !body.agentId || !body.environmentId || !body.personaName || !body.patToken) {
        return jsonResp(400, {
          error: "userId, agentId, environmentId, personaName, patToken required",
        });
      }
      try {
        const r = await providers.linear.installPersonalToken({
          userId: body.userId as string,
          agentId: body.agentId as string,
          environmentId: body.environmentId as string,
          persona: {
            name: body.personaName as string,
            avatarUrl: (body.personaAvatarUrl as string | null) ?? null,
          },
          patToken: body.patToken as string,
        });
        return jsonResp(200, { publicationId: r.publicationId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResp(400, { error: "pat_install_failed", details: msg });
      }
    }

    return jsonResp(400, { error: `unknown mode: ${args.mode}` });
  }

  // ─── Container builders (per-call; cheap) ──────────────────────────

  /** Public so the apps/main-node webhook wiring can hand the same
   *  containers into a fresh provider instance per request. Cheap;
   *  no caching. */
  buildContainers(): {
    linear: LinearContainer;
    github: Container;
    slack: SlackContainer;
  } {
    const repos = buildNodeRepos({
      sql: this.opts.sql,
      PLATFORM_ROOT_SECRET: this.opts.platformRootSecret,
    });
    const sessions = new InProcessSessionCreator(this.opts);
    const vaults = new InProcessVaultManager(this.opts);

    const baseLinear: LinearContainer = {
      ...repos,
      installations: repos.linearInstallations,
      publications: repos.linearPublications,
      webhookEvents: repos.linearEvents,
      sessions,
      vaults,
    };
    const baseGithub: Container = {
      ...repos,
      installations: repos.githubInstallations,
      publications: repos.githubPublications,
      webhookEvents: repos.githubWebhookEvents,
      sessions,
      vaults,
    };
    const slackCrypto = new WebCryptoAesGcm(this.opts.platformRootSecret, "integrations.tokens");
    const slackIds = new CryptoIdGenerator();
    const baseSlack: SlackContainer = {
      ...repos,
      installations: new SqlSlackInstallationRepo(this.opts.sql, slackCrypto, slackIds),
      publications: new SqlSlackPublicationRepo(this.opts.sql, slackIds),
      apps: new SqlSlackAppRepo(this.opts.sql, slackCrypto, slackIds),
      webhookEvents: new SqlSlackWebhookEventStore(this.opts.sql),
      sessionScopes: repos.sessionScopes,
      setupLinks: new SqlSlackSetupLinkRepo(this.opts.sql, slackIds),
      sessions,
      vaults,
    };
    return { linear: baseLinear, github: baseGithub, slack: baseSlack };
  }
}

// ─── In-process session/vault managers ────────────────────────────────
//
// These mirror what apps/main/src/routes/internal.ts does — but call the
// in-process services directly instead of going through the HTTP gateway.
// They're intentionally minimal: only the surface area providers actually
// hit during install + webhook dispatch.

class InProcessSessionCreator implements SessionCreator {
  constructor(private readonly opts: NodeInstallBridgeOpts) {}

  async create(input: CreateSessionInput): Promise<{ sessionId: SessionId }> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) throw new Error("user has no tenant");
    const agentRow = await this.opts.agents.get({ tenantId, agentId: input.agentId });
    if (!agentRow) throw new Error("agent not found in tenant");
    // Strip tenant_id like internal.ts does so the snapshot shape matches.
    const agentBase = { ...agentRow, tenant_id: undefined } as unknown as Record<string, unknown>;
    delete agentBase.tenant_id;

    // Self-host agents always run on local-runtime. We use a synthetic env
    // snapshot rather than reading from environments-store; main-node
    // accepts any environment_id today (loadEnvironment returns a synthetic
    // local-runtime env). Mirror that here so install-triggered sessions
    // don't 404.
    const envSnapshot = { id: input.environmentId, runtime: "local", sandbox_template: null };
    const meta = Object.keys(input.metadata ?? {}).length === 0 ? undefined : input.metadata;
    const { session } = await this.opts.sessions.create({
      tenantId,
      agentId: input.agentId,
      environmentId: input.environmentId,
      title: "",
      vaultIds: [...input.vaultIds],
      agentSnapshot: agentBase as never,
      environmentSnapshot: envSnapshot as never,
      metadata: meta as never,
    });
    return { sessionId: session.id as SessionId };
  }

  async resume(userId: UserId, sessionId: SessionId, event: SessionEventInput): Promise<void> {
    if (!this.opts.appendUserEvent) {
      // Bridge wired without an append hook (e.g. unit tests).
      log.warn(
        { op: "install_bridge.resume.no_hook", session_id: sessionId, user_id: userId },
        "session resume invoked but appendUserEvent hook is not wired",
      );
      return;
    }
    // Resolve session + agent so the harness gets the right (sid, tenantId,
    // agentId) tuple. 404/410 surface to the provider's webhook handler,
    // which logs and returns 200 (webhook contract — never re-deliver).
    const session = await this.opts.sessions.getById({ sessionId });
    if (!session) throw new Error(`session_not_found: ${sessionId}`);
    if (!session.agent_id) throw new Error(`session_agent_missing: ${sessionId}`);
    const agentRow = await this.opts.agents.get({
      tenantId: session.tenant_id,
      agentId: session.agent_id,
    });
    if (!agentRow) throw new Error(`agent_gone: ${session.agent_id}`);

    // SessionEventInput from integrations-core is structurally a SessionEvent
    // (type + content). Translation rule: webhook events normalize to a
    // user.message with the provider's pre-formatted markdown body. Provider
    // metadata (publicationId, issueId, etc.) rides under metadata.linear /
    // .github / .slack — same shape CF passes through SessionDO.append.
    const userMsg = {
      type: "user.message",
      content: event.content,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    } as unknown as UserMessageEvent;
    await this.opts.appendUserEvent(sessionId, session.tenant_id, agentRow.id, userMsg);
  }
}

class InProcessVaultManager implements VaultManager {
  constructor(private readonly opts: NodeInstallBridgeOpts) {}

  async createCredentialForUser(
    input: CreateCredentialInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) throw new Error("user has no tenant");
    const vault = await this.opts.vaults.create({ tenantId, name: input.vaultName });
    const cred = await this.opts.credentials.create({
      tenantId,
      vaultId: vault.id,
      displayName: input.displayName,
      auth: {
        type: "static_bearer",
        mcp_server_url: input.mcpServerUrl,
        token: input.bearerToken,
        provider: input.provider,
      },
    });
    return { vaultId: vault.id, credentialId: cred.id };
  }

  async addCapCliCredential(
    input: CreateCapCliInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) throw new Error("user has no tenant");
    let vaultId = input.vaultId;
    if (!vaultId) {
      const v = await this.opts.vaults.create({ tenantId, name: input.vaultName });
      vaultId = v.id;
    }
    const cred = await this.opts.credentials.create({
      tenantId,
      vaultId: vaultId!,
      displayName: input.displayName,
      auth: {
        type: "cap_cli",
        cli_id: input.cliId,
        token: input.token,
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
        ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
        ...(input.extras ? { extras: input.extras } : {}),
        provider: input.provider,
      },
    });
    return { vaultId: vaultId!, credentialId: cred.id };
  }

  async rotateBearerToken(input: {
    userId: string;
    vaultId: string;
    newBearerToken: string;
  }): Promise<boolean> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) return false;
    const list = await this.opts.credentials.list({ tenantId, vaultId: input.vaultId });
    const target = list.find((c) => c.auth?.type === "static_bearer");
    if (!target) return false;
    await this.opts.credentials.update({
      tenantId,
      vaultId: input.vaultId,
      credentialId: target.id,
      auth: { token: input.newBearerToken },
    });
    return true;
  }

  async rotateCapCliToken(input: {
    userId: string;
    vaultId: string;
    cliId: string;
    newToken: string;
  }): Promise<boolean> {
    const tenantId = await this.opts.resolveTenantId(input.userId);
    if (!tenantId) return false;
    const list = await this.opts.credentials.list({ tenantId, vaultId: input.vaultId });
    const target = list.find(
      (c) => c.auth?.type === "cap_cli" && c.auth.cli_id === input.cliId,
    );
    if (!target) return false;
    await this.opts.credentials.update({
      tenantId,
      vaultId: input.vaultId,
      credentialId: target.id,
      auth: { token: input.newToken },
    });
    return true;
  }
}

// Build the in-process providers off the bridge's containers. Used by
// apps/main-node to wire the webhook handlers without re-creating a
// duplicate container per request.
export function buildNodeProvidersForRequest(
  bridge: NodeInstallBridge,
  gatewayOrigin: string,
): { linear: LinearProvider; github: GitHubProvider; slack: SlackProvider } {
  const containers = bridge.buildContainers();
  return {
    linear: new LinearProvider(containers.linear, {
      gatewayOrigin,
      scopes: DEFAULT_LINEAR_SCOPES,
      defaultCapabilities: ALL_LINEAR_CAPS,
    }),
    github: new GitHubProvider(containers.github, {
      gatewayOrigin,
      defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
      mcpServerUrl: DEFAULT_GITHUB_MCP_URL,
    }),
    slack: new SlackProvider(containers.slack, {
      gatewayOrigin,
      botScopes: DEFAULT_SLACK_BOT_SCOPES,
      userScopes: DEFAULT_SLACK_USER_SCOPES,
      defaultCapabilities: ALL_SLACK_CAPABILITIES,
    }),
  };
}

// ─── Wire-shape helpers ────────────────────────────────────────────────
//
// Replicate apps/integrations/src/routes/{linear,github,slack}/publications.ts
// JSON envelopes verbatim (must match CF responses).

function jsonResp(status: number, body: Record<string, unknown>): StartInstallationResult {
  return { status, body };
}

function requiredCredentialsKeys(provider: string): string[] {
  if (provider === "linear") return ["formToken", "clientId", "clientSecret", "webhookSecret"];
  if (provider === "github") return ["formToken", "appId", "privateKey", "webhookSecret"];
  if (provider === "slack") return ["formToken", "clientId", "clientSecret", "signingSecret"];
  return ["formToken"];
}

function credentialsBadInputBody(provider: string, required: string[]): Record<string, unknown> {
  const error = `${required.join(", ")} required`;
  if (provider === "linear") {
    return {
      error,
      hint:
        "webhookSecret comes from the Linear App's webhook page (the 'lin_wh_…' value). " +
        "Linear auto-generates it; OMA can't predict it.",
    };
  }
  if (provider === "github") {
    return {
      error,
      hint:
        "From your GitHub App settings page: appId is the numeric ID at the top, " +
        "privateKey is the PEM file you download under 'Private keys', " +
        "webhookSecret is whatever you set in 'Webhook secret'.",
    };
  }
  if (provider === "slack") {
    return {
      error,
      hint:
        "signingSecret comes from the Slack App's Basic Information page " +
        "(Signing Secret field). Slack uses this single value to sign all webhook events.",
    };
  }
  return { error };
}

function mapInstallErrorToResp(
  provider: string,
  flow: "credentials" | "handoff",
  err: unknown,
): StartInstallationResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/JwtSigner\.verify/i.test(msg)) {
    return jsonResp(400, {
      error: "form_token_invalid",
      details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
      remediation: `Re-run ${provider} publish to mint a fresh form token (TTL ~30 min).`,
    });
  }
  if (provider === "github" && /appId mismatch/.test(msg)) {
    return jsonResp(400, {
      error: "credentials_mismatch",
      details: msg,
      remediation:
        "The numeric App ID you pasted doesn't match what GitHub sees for that " +
        "private key. Double-check both are from the same App's settings page.",
    });
  }
  return jsonResp(400, {
    error: flow === "handoff" ? "handoff_failed" : "credentials_failed",
    details: msg,
  });
}
