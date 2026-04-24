// SlackProvider — implements integrations-core's IntegrationProvider for
// Slack. Mirror of LinearProvider with Slack-specific quirks:
//
// - OAuth v2 dual-token flow (bot scope + user scope, both tokens stored).
// - Webhook signature is HMAC-SHA256 over `v0:{ts}:{rawBody}` with replay
//   protection (5-min skew limit).
// - First webhook to a fresh URL is a `url_verification` handshake — must
//   verify the signature, then echo the challenge string within 3 sec.
// - Slack's 3-second response budget rules out doing the dispatch inline.
//   The provider returns a `deferredWork` closure on WebhookOutcome; the
//   route handler attaches it to `executionCtx.waitUntil(...)` and 200's.
// - Per_thread session granularity, scopeKey = `${channel_id}:${thread_ts}`.
// - MCP runs via vault outbound injection of the user xoxp- token.

import type {
  Container,
  ContinueInstallInput,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  Persona,
  ProviderId,
  Publication,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
} from "@open-managed-agents/integrations-core";

import { SlackApiClient } from "./api/client";
import {
  ALL_SLACK_CAPABILITIES,
  DEFAULT_SLACK_BOT_SCOPES,
  DEFAULT_SLACK_SUBSCRIBED_EVENTS,
  DEFAULT_SLACK_USER_SCOPES,
  type SlackConfig,
} from "./config";
import {
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "./oauth/protocol";
import { buildManifest, buildManifestLaunchUrl } from "./oauth/manifest";
import type { SlackInstallationRepo } from "./ports";
import {
  buildBaseString,
  isTimestampFresh,
  parseSignatureHeader,
} from "./webhook/signature";
import {
  parseWebhook,
  type NormalizedSlackEvent,
  type RawSlackEnvelope,
  type RawUrlVerification,
  type RawEventCallback,
} from "./webhook/parse";

// 60 minutes — the manifest flow can spin up a new browser tab, walk through
// Slack's app creation, copy 3 secrets, and come back. 30 minutes was tight
// once the manifest tab and OAuth grant are added in.
const OAUTH_STATE_TTL_SECONDS = 60 * 60;
const PROVIDER_ID: ProviderId = "slack";

/** Slack's hosted MCP server. Outbound injection matches by hostname. */
const SLACK_MCP_URL = "https://mcp.slack.com/mcp";
/** Slack's Web API base — bot token vault binds here. */
const SLACK_API_URL = "https://slack.com/api";

/**
 * SlackProvider's container differs from the base Container in one place:
 * `installations` is a SlackInstallationRepo (extends InstallationRepo with
 * getUserToken / setBotVaultId).
 */
export interface SlackContainer extends Omit<Container, "installations"> {
  installations: SlackInstallationRepo;
}

export class SlackProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly api: SlackApiClient;

  constructor(
    private readonly container: SlackContainer,
    private readonly config: SlackConfig,
  ) {
    this.api = new SlackApiClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    // Same A1 pattern as Linear: generate appId upfront so step 1 hands the
    // user the *final* callback / Events Request URLs. We don't write the
    // App row until step 2 (after user pastes their OAuth client credentials
    // + Slack's per-app signing secret from App admin → Basic Information).
    const appId = this.container.ids.generate();
    const formToken = await this.container.jwt.sign(
      {
        kind: "slack.a1.form",
        userId: input.userId,
        agentId: input.agentId,
        environmentId: input.environmentId,
        persona: input.persona,
        returnUrl: input.returnUrl,
        appId,
      },
      OAUTH_STATE_TTL_SECONDS,
    );

    return {
      kind: "step",
      step: "credentials_form",
      data: {
        formToken,
        suggestedAppName: input.persona.name,
        suggestedAvatarUrl: input.persona.avatarUrl,
        callbackUrl: this.callbackUri(appId),
        webhookUrl: this.webhookUri(appId),
        manifestLaunchUrl: this.buildManifestLaunchUrlFor(appId, input.persona.name),
      },
    };
  }

  /**
   * Build the Slack "Create from manifest" URL for a freshly-allocated
   * appId + persona. Public so the handoff setup-page can render the same
   * one-click button without re-entering the wizard. Pure getter — no I/O.
   */
  buildManifestLaunchUrlFor(appId: string, personaName: string): string {
    const manifest = buildManifest({
      personaName,
      webhookUrl: this.webhookUri(appId),
      redirectUrl: this.callbackUri(appId),
      botScopes: this.config.botScopes ?? DEFAULT_SLACK_BOT_SCOPES,
      userScopes: this.config.userScopes ?? DEFAULT_SLACK_USER_SCOPES,
      subscribedEvents: DEFAULT_SLACK_SUBSCRIBED_EVENTS,
    });
    return buildManifestLaunchUrl(manifest);
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as { kind?: string; [k: string]: unknown };
    if (payload.kind === "submit_credentials") {
      return this.submitCredentials(payload);
    }
    if (payload.kind === "handoff_link") {
      return this.createHandoffLink(payload);
    }
    if (payload.kind === "oauth_callback_dedicated") {
      return this.completeInstall(
        (payload.appId as string) ?? "",
        (payload.code as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    throw new Error(
      `SlackProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  private async submitCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const clientId = (payload.clientId as string) ?? "";
    const clientSecret = (payload.clientSecret as string) ?? "";
    const signingSecret = (payload.signingSecret as string) ?? "";
    if (!formToken || !clientId || !clientSecret || !signingSecret) {
      throw new Error(
        "submit_credentials: formToken, clientId, clientSecret, signingSecret required",
      );
    }

    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
      appId: string;
    }>(formToken);
    if (form.kind !== "slack.a1.form") {
      throw new Error("submit_credentials: invalid formToken kind");
    }
    if (!form.appId) {
      throw new Error("submit_credentials: formToken missing appId — please restart the publish flow");
    }

    // Upsert keyed on appId — re-submits don't create duplicate rows.
    // App row uses webhookSecret column for the signing secret (same
    // AppRepo interface as Linear; semantically Slack's "webhook secret" IS
    // its signing secret).
    const tenantId = await this.container.tenants.resolveByUserId(form.userId);
    const app = await this.container.apps.insert({
      id: form.appId,
      tenantId,
      publicationId: null,
      clientId,
      clientSecret,
      webhookSecret: signingSecret,
    });

    const state = await this.container.jwt.sign(
      {
        kind: "slack.oauth.dedicated",
        appId: app.id,
        userId: form.userId,
        agentId: form.agentId,
        environmentId: form.environmentId,
        persona: form.persona,
        returnUrl: form.returnUrl,
        nonce: this.container.ids.generate(),
      },
      OAUTH_STATE_TTL_SECONDS,
    );
    const url = buildAuthorizeUrl({
      clientId,
      redirectUri: this.callbackUri(app.id),
      botScopes: this.config.botScopes ?? DEFAULT_SLACK_BOT_SCOPES,
      userScopes: this.config.userScopes ?? DEFAULT_SLACK_USER_SCOPES,
      state,
    });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        appId: app.id,
        callbackUrl: this.callbackUri(app.id),
        webhookUrl: this.webhookUri(app.id),
      },
    };
  }

  private async completeInstall(
    appId: string,
    code: string,
    stateToken: string,
  ): Promise<InstallComplete> {
    if (!appId) throw new Error("Slack OAuth callback: missing appId");
    if (!code) throw new Error("Slack OAuth callback: missing code");
    if (!stateToken) throw new Error("Slack OAuth callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      appId: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "slack.oauth.dedicated") {
      throw new Error("Slack OAuth callback: invalid state kind");
    }
    if (state.appId !== appId) {
      throw new Error("Slack OAuth callback: appId mismatch");
    }

    const app = await this.container.apps.get(appId);
    if (!app) throw new Error("Slack OAuth callback: unknown appId");

    const clientSecret = await this.container.apps.getClientSecret(app.id);
    if (!clientSecret) {
      throw new Error("Slack OAuth callback: missing client secret");
    }

    const tokenReq = buildTokenExchangeBody({
      code,
      redirectUri: this.callbackUri(app.id),
      clientId: app.clientId,
      clientSecret,
    });
    const tokenRes = await this.container.http.fetch({
      method: "POST",
      url: tokenReq.url,
      headers: { "content-type": tokenReq.contentType },
      body: tokenReq.body,
    });
    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      throw new Error(
        `Slack OAuth token exchange failed: HTTP ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);

    // Best-effort sanity check; non-fatal if Slack is throttling our test.
    try {
      await this.api.authTest(token.access_token);
    } catch {
      // Continue — install otherwise succeeded; the bot token will work
      // when next exercised by an event.
    }

    const tenantId = await this.container.tenants.resolveByUserId(state.userId);
    const installation = await this.container.installations.insert({
      tenantId,
      userId: state.userId,
      providerId: PROVIDER_ID,
      workspaceId: token.team.id,
      workspaceName: token.team.name,
      installKind: "dedicated",
      appId: app.id,
      // accessToken slot holds the bot xoxb- token — same field as Linear.
      accessToken: token.access_token,
      refreshToken: null,
      // Encode both bot + user scopes in one JSON blob so the column type
      // doesn't need to change. Repo serializes as JSON.
      scopes: [
        ...token.scope.split(/[\s,]+/).filter(Boolean).map((s) => `bot:${s}`),
        ...token.authed_user.scope.split(/[\s,]+/).filter(Boolean).map((s) => `user:${s}`),
      ],
      botUserId: token.bot_user_id,
    });

    // Stash the user xoxp- token on the install row (Slack-only field).
    await this.container.installations.setUserToken(
      installation.id,
      token.authed_user.access_token,
    );

    // Vault for mcp.slack.com — uses the USER xoxp- token (mcp.slack.com
    // rejects bot tokens; user token inherits the installer's permissions).
    const { vaultId: userVaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `Slack · ${token.team.name} · ${state.persona.name} (user)`,
      displayName: `Slack MCP user token (${state.persona.name})`,
      mcpServerUrl: SLACK_MCP_URL,
      bearerToken: token.authed_user.access_token,
    });
    await this.container.installations.setVaultId(installation.id, userVaultId);

    // Vault for direct slack.com/api calls (bot xoxb-). Used if the agent
    // calls Web API methods directly without going through MCP.
    const { vaultId: botVaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `Slack · ${token.team.name} · ${state.persona.name} (bot)`,
      displayName: `Slack bot token (${state.persona.name})`,
      mcpServerUrl: SLACK_API_URL,
      bearerToken: token.access_token,
    });
    await this.container.installations.setBotVaultId(installation.id, botVaultId);

    const publication = await this.container.publications.insert({
      tenantId,
      userId: state.userId,
      agentId: state.agentId,
      installationId: installation.id,
      environmentId: state.environmentId,
      mode: "full",
      status: "live",
      persona: state.persona,
      capabilities: new Set(
        this.config.defaultCapabilities ?? ALL_SLACK_CAPABILITIES,
      ),
      sessionGranularity: "per_thread",
    });
    await this.container.apps.setPublicationId(app.id, publication.id);

    return { kind: "complete", publicationId: publication.id };
  }

  /** 7-day re-signed formToken — gives an admin a public install URL. */
  private async createHandoffLink(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    if (!formToken) throw new Error("handoff_link: formToken required");
    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
    }>(formToken);
    if (form.kind !== "slack.a1.form") {
      throw new Error("handoff_link: invalid formToken kind");
    }
    const handoffToken = await this.container.jwt.sign(
      { ...form, kind: "slack.a1.form", handoff: true },
      7 * 24 * 60 * 60,
    );
    return {
      kind: "step",
      step: "install_link",
      data: {
        url: `${this.config.gatewayOrigin}/slack-setup/${handoffToken}`,
        expiresInDays: 7,
      },
    };
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    // App lookup happens before signature verify so we can verify even on
    // url_verification (the very first webhook a new URL receives).
    const appId = this.appIdFromHeaders(req);
    if (!appId) {
      return { handled: false, reason: "missing_app_id" };
    }
    const appRow = await this.container.apps.get(appId);
    if (!appRow) {
      return { handled: false, reason: "unknown_app_id" };
    }
    const signingSecret = await this.container.apps.getWebhookSecret(appId);
    if (!signingSecret) {
      return { handled: false, reason: "missing_signing_secret" };
    }

    // Signature + timestamp verification.
    const sigHeader = req.headers["x-slack-signature"];
    const tsHeader = req.headers["x-slack-request-timestamp"];
    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed || parsed.version !== "v0") {
      return { handled: false, reason: "invalid_signature_header" };
    }
    if (!tsHeader || !isTimestampFresh(tsHeader, this.container.clock.nowMs())) {
      return { handled: false, reason: "stale_timestamp" };
    }
    const baseString = buildBaseString(tsHeader, req.rawBody);
    const ok = await this.container.hmac.verify(signingSecret, baseString, parsed.hex);
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Parse envelope.
    let raw: RawSlackEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawSlackEnvelope;
    } catch {
      return { handled: false, reason: "invalid_json" };
    }

    // url_verification — echo the challenge. No event_id, skip dedup.
    if (raw.type === "url_verification") {
      const challenge = (raw as RawUrlVerification).challenge ?? "";
      return {
        handled: true,
        reason: "url_verification",
        challengeResponse: challenge,
      };
    }

    // app_rate_limited — informational, log + 200, skip dedup.
    if (raw.type === "app_rate_limited") {
      return { handled: false, reason: "app_rate_limited" };
    }

    // Route only event_callback envelopes from here.
    if (raw.type !== "event_callback") {
      return { handled: false, reason: `unknown_envelope_${raw.type}` };
    }
    const env = raw as RawEventCallback;

    // Find the installation behind this app.
    if (!appRow.publicationId) {
      // App registered but install hasn't completed — drop.
      return { handled: false, reason: "no_publication_yet" };
    }
    const pub = await this.container.publications.get(appRow.publicationId);
    if (!pub) {
      return { handled: false, reason: "publication_not_found" };
    }
    const installation = await this.container.installations.get(pub.installationId);
    if (!installation || installation.revokedAt !== null) {
      return { handled: false, reason: "installation_not_found_or_revoked" };
    }

    // Idempotency on event_id.
    const fresh = await this.container.webhookEvents.recordIfNew(
      env.event_id,
      installation.tenantId,
      installation.id,
      env.event?.type ?? "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    const event = parseWebhook(raw);
    if (!event) {
      await this.container.webhookEvents.attachError(env.event_id, "unparseable");
      return { handled: false, reason: "unparseable" };
    }

    // Revocation events — flip the installation, no dispatch.
    if (event.kind === "tokens_revoked" || event.kind === "app_uninstalled") {
      await this.container.installations.markRevoked(installation.id, this.container.clock.nowMs());
      await this.container.webhookEvents.attachPublication(env.event_id, pub.id);
      return { handled: true, reason: event.kind, publicationId: pub.id };
    }

    // Skip bot's own messages to avoid loops.
    if (event.isBotMessage) {
      await this.container.webhookEvents.attachError(env.event_id, "skipped_bot_message");
      return { handled: false, reason: "bot_message" };
    }

    if (pub.status !== "live") {
      await this.container.webhookEvents.attachError(env.event_id, "publication_not_live");
      return { handled: false, reason: "publication_not_live" };
    }

    await this.container.webhookEvents.attachPublication(env.event_id, pub.id);

    // Defer the actual session create/resume to satisfy Slack's 3-sec budget.
    // The route handler attaches this to executionCtx.waitUntil(...).
    const deferred = async () => {
      try {
        const sessionId = await this.dispatchEvent(pub, installation.id, event);
        await this.container.webhookEvents.attachSession(env.event_id, sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.container.webhookEvents.attachError(env.event_id, msg.slice(0, 200));
      }
    };

    return {
      handled: true,
      reason: event.kind ?? "dispatched",
      publicationId: pub.id,
      deferredWork: deferred,
    };
  }

  private async dispatchEvent(
    publication: Publication,
    installationId: string,
    event: NormalizedSlackEvent,
  ): Promise<string> {
    // Both vaults — user token (xoxp-) for mcp.slack.com + bot token (xoxb-)
    // for direct slack.com/api calls.
    const installation = await this.container.installations.get(installationId);
    const vaultIds: string[] = [];
    if (installation?.vaultId) vaultIds.push(installation.vaultId);
    // The bot vault id lives on the installation row but isn't on the base
    // Installation type. Read it via a side query.
    const botVaultId = await this.getBotVaultIdSafe(installationId);
    if (botVaultId) vaultIds.push(botVaultId);

    const mcpServers = [{ name: "slack", url: SLACK_MCP_URL }];

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        { type: "text" as const, text: this.renderEventAsUserMessage(event) },
      ],
      metadata: {
        slack: {
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          threadTs: event.threadTs,
          eventTs: event.eventTs,
          userId: event.userId,
          eventKind: event.kind,
          deliveryId: event.deliveryId,
        },
      },
    };

    if (publication.sessionGranularity === "per_thread" && event.scopeKey) {
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        event.scopeKey,
      );
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds,
        mcpServers,
        metadata: {
          slack: {
            workspaceId: event.workspaceId,
            channelId: event.channelId,
            threadTs: event.threadTs,
          },
        },
        initialEvent: sessionEvent,
      });
      await this.container.sessionScopes.insert({
        publicationId: publication.id,
        scopeKey: event.scopeKey,
        sessionId: created.sessionId,
        status: "active",
        createdAt: this.container.clock.nowMs(),
      });
      return created.sessionId;
    }

    // per_event (or per_thread without a scopeKey): always fresh session.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: {
        slack: {
          workspaceId: event.workspaceId,
          channelId: event.channelId,
          threadTs: event.threadTs,
        },
      },
      initialEvent: sessionEvent,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(event: NormalizedSlackEvent): string {
    const lines: string[] = [];
    const where = event.channelId
      ? `${event.channelId}${event.threadTs ? ` (thread ${event.threadTs})` : ""}`
      : "<unknown channel>";
    lines.push(`Slack ${event.kind ?? "event"} in ${where}`);
    if (event.userId) lines.push(`From: ${event.userId}`);
    if (event.text) lines.push(`\n${event.text}`);
    return lines.join("\n");
  }

  /**
   * Slack's webhook URL contains the appId (`/slack/webhook/app/:appId`).
   * The route handler is responsible for surfacing it via the
   * `x-internal-app-id` header before calling handleWebhook — keeps the
   * provider runtime-agnostic (no Hono context here).
   */
  private appIdFromHeaders(req: WebhookRequest): string | null {
    const headerAppId = req.headers["x-internal-app-id"];
    if (typeof headerAppId === "string" && headerAppId.length > 0) {
      return headerAppId;
    }
    // Fallback: the request's `installationId` field on WebhookRequest is
    // path-derived and the route can stuff appId there too. Useful for tests.
    if (req.installationId) return req.installationId;
    return null;
  }

  /**
   * The base Installation type doesn't carry `botVaultId` — fetch via the
   * Slack installation repo extension. Returns null if not set.
   */
  private async getBotVaultIdSafe(installationId: string): Promise<string | null> {
    return await this.container.installations.getBotVaultId(installationId);
  }

  private callbackUri(appId: string): string {
    return `${this.config.gatewayOrigin}/slack/oauth/app/${appId}/callback`;
  }
  private webhookUri(appId: string): string {
    return `${this.config.gatewayOrigin}/slack/webhook/app/${appId}`;
  }

  // ─── MCP (vault-injection model — same as Linear's hosted approach) ──

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    throw new Error("SlackProvider.mcpTools: MCP runs via vault outbound injection (mcp.slack.com)");
  }

  async invokeMcpTool(
    _scope: McpScope,
    _toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    throw new Error("SlackProvider.invokeMcpTool: MCP runs via vault outbound injection (mcp.slack.com)");
  }
}
