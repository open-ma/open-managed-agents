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
import type { SlackInstallationRepo, SlackSessionScopeRepo } from "./ports";
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
 * For `per_channel` granularity: how long after the first new top-level
 * message we hold the "armed" flag before allowing another scan-arm dispatch.
 * The agent receives the armed signal immediately and is expected to call
 * scheduleWakeup with roughly this same delay; on wake it reads
 * conversations.history for everything that arrived during the window.
 */
const PER_CHANNEL_DEBOUNCE_WINDOW_MS = 90_000;

/**
 * Routing intent for per_channel dispatch. classifyDispatch sets this so
 * dispatchEvent knows which signal to render and which lifecycle action to
 * take. For per_thread / per_event (legacy) paths intent is undefined.
 */
type DispatchIntent =
  | "joined_channel"     // member_joined_channel for bot, or first wake of a fresh channel session
  | "scan_arm"           // top-level message in per_channel — debounce + signal
  | "direct_invocation"  // @ / DM / thread reply (per_channel routes to channel session)
  | "reaction_on_bot"    // reaction on a bot-authored message
  | "close_session"      // member_left_channel for bot, or channel_archive
  | "reopen_session";    // channel_unarchive

type ClassifyDecision =
  | { kind: "dispatch"; intent?: DispatchIntent }
  | { kind: "drop"; reason: string }
  /** channel_rename: update the cached channel_name on the scope row but don't wake the agent. */
  | { kind: "metadata_only"; channelName: string };

/**
 * The kind of signal embedded in the rendered user.message text. Drives the
 * agent's behavior — each kind's prompt phrasing is documented in
 * renderEventAsUserMessage. Distinct from DispatchIntent because intents
 * describe routing actions (close session, arm scan) while signals describe
 * what the agent perceives.
 */
type SignalKind =
  | "joined_channel"
  | "channel_scan_armed"
  | "direct_invocation"
  | "reaction_on_bot_message"
  | "session_closed";

/** Optional context fields passed to renderEventAsUserMessage / buildSessionEvent. */
interface SignalExtras {
  /** Cached channel display name (without `#`), if known. */
  channelName?: string | null;
  /** Debounce window the agent should match in scheduleWakeup, in ms. */
  debounceMs?: number;
  /** ms timestamp of last completed scan; renderer formats as Slack `oldest=`. */
  lastScanAt?: number | null;
  /** Whether this is a reopen rather than a fresh join. */
  reopened?: boolean;
}

/**
 * SlackProvider's container differs from the base Container in two places:
 * `installations` is a SlackInstallationRepo (extends InstallationRepo with
 * getUserToken / setBotVaultId), and `sessionScopes` is a SlackSessionScopeRepo
 * (extends SessionScopeRepo with armPendingScan / clearPendingScan /
 * updateChannelName for per_channel granularity).
 */
export interface SlackContainer extends Omit<Container, "installations" | "sessionScopes"> {
  installations: SlackInstallationRepo;
  sessionScopes: SlackSessionScopeRepo;
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
      sessionGranularity: this.config.defaultSessionGranularity ?? "per_channel",
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

    // Revocation events — flip the installation, close all channel-scope
    // sessions for the publication so dangling scheduleWakeups don't burn
    // turns 401-ing against a now-revoked token. No agent dispatch needed
    // (the wakeups themselves will cascade through and discover their
    // sessions are completed).
    if (event.kind === "tokens_revoked" || event.kind === "app_uninstalled") {
      await this.container.installations.markRevoked(installation.id, this.container.clock.nowMs());
      await this.container.sessionScopes.closeAllForPublication(pub.id);
      await this.container.webhookEvents.attachPublication(env.event_id, pub.id);
      return { handled: true, reason: event.kind, publicationId: pub.id, tenantId: installation.tenantId };
    }

    // Skip bot's own messages to avoid loops.
    if (event.isBotMessage) {
      await this.container.webhookEvents.attachError(env.event_id, "skipped_bot_message");
      return { handled: false, reason: "bot_message" };
    }

    // Decide whether this event should reach the agent. Slack delivers a
    // mix of signals; we route them according to user intent rather than
    // raw event kind. See classifyDispatch() for the rules.
    const decision = await this.classifyDispatch(pub, event, installation.botUserId);
    if (decision.kind === "drop") {
      await this.container.webhookEvents.attachError(env.event_id, decision.reason);
      return { handled: false, reason: decision.reason };
    }

    if (pub.status !== "live") {
      await this.container.webhookEvents.attachError(env.event_id, "publication_not_live");
      return { handled: false, reason: "publication_not_live" };
    }

    // metadata_only — channel_rename: update the cached channel_name on the
    // scope row without waking the agent. Agent reads it from session
    // metadata on its next natural wake (scan / mention / etc.).
    if (decision.kind === "metadata_only") {
      if (event.channelId) {
        const scopeKey = `channel:${event.channelId}`;
        await this.container.sessionScopes.updateChannelName(
          pub.id,
          scopeKey,
          decision.channelName,
        );
      }
      await this.container.webhookEvents.attachPublication(env.event_id, pub.id);
      return {
        handled: true,
        reason: "metadata_only",
        publicationId: pub.id,
        tenantId: installation.tenantId,
      };
    }

    await this.container.webhookEvents.attachPublication(env.event_id, pub.id);

    // Defer the actual session create/resume to satisfy Slack's 3-sec budget.
    // The route handler attaches this to executionCtx.waitUntil(...).
    const deferred = async () => {
      try {
        const sessionId = await this.dispatchEvent(pub, installation.id, event, decision.intent);
        if (sessionId) {
          await this.container.webhookEvents.attachSession(env.event_id, sessionId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.container.webhookEvents.attachError(env.event_id, msg.slice(0, 200));
      }
    };

    return {
      handled: true,
      reason: event.kind ?? "dispatched",
      publicationId: pub.id,
      tenantId: installation.tenantId,
      deferredWork: deferred,
    };
  }

  private async dispatchEvent(
    publication: Publication,
    installationId: string,
    event: NormalizedSlackEvent,
    intent?: DispatchIntent,
  ): Promise<string | null> {
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

    // ─── per_channel granularity ──────────────────────────────────────
    // One session per (publication, channel_id). All channel events route
    // to it via intent. Top-level scan-arms throttle on a D1 watermark.
    if (publication.sessionGranularity === "per_channel" && event.channelId) {
      const scopeKey = `channel:${event.channelId}`;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );

      // close_session (bot kicked / channel archived) — flip status, clear
      // the debounce watermark, send a final session_closed signal so the
      // agent can cancel its own scheduleWakeups before going dormant.
      if (intent === "close_session") {
        if (!existing) return null;
        await this.container.sessionScopes.updateStatus(
          publication.id,
          scopeKey,
          "completed",
        );
        await this.container.sessionScopes.clearPendingScan(publication.id, scopeKey);
        if (existing.status === "active") {
          const sessionEvent = this.buildSessionEvent(
            event,
            "session_closed",
            { channelName: existing.channelName ?? null },
          );
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
        }
        return existing.sessionId;
      }

      // scan_arm — debounce check on the scope row. If already armed within
      // window, drop silently. If armed fresh, resume with the signal.
      if (intent === "scan_arm") {
        // Lazy-create the scope row if missing — bot may have been added to
        // the channel before per_channel rolled out, so member_joined_channel
        // wasn't received. First top-level message bootstraps the session.
        if (!existing) {
          const newId = await this.createChannelSession(
            publication,
            event,
            scopeKey,
            "joined_channel",
            vaultIds,
            mcpServers,
          );
          // Arm immediately — the bootstrap turn establishes context, the
          // agent should already start its first scheduleWakeup loop.
          await this.container.sessionScopes.armPendingScan(
            publication.id,
            scopeKey,
            this.container.clock.nowMs() + PER_CHANNEL_DEBOUNCE_WINDOW_MS,
            this.container.clock.nowMs(),
          );
          return newId;
        }
        if (existing.status !== "active") return null;
        const now = this.container.clock.nowMs();
        const armResult = await this.container.sessionScopes.armPendingScan(
          publication.id,
          scopeKey,
          now + PER_CHANNEL_DEBOUNCE_WINDOW_MS,
          now,
        );
        if (!armResult.armed) {
          // Already armed; throttle silently. Surface as a soft drop reason
          // on the webhook event so operators can see throttle hits in logs.
          await this.container.webhookEvents.attachError(
            event.deliveryId,
            "throttled_pending_scan",
          );
          return existing.sessionId;
        }
        const sessionEvent = this.buildSessionEvent(event, "channel_scan_armed", {
          debounceMs: PER_CHANNEL_DEBOUNCE_WINDOW_MS,
          lastScanAt: existing.lastScanAt ?? null,
          channelName: existing.channelName ?? null,
        });
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }

      // direct_invocation / reaction_on_bot — both require resuming a live
      // channel session. Lazy-create if missing (bot may pre-date per_channel
      // rollout in this channel).
      if (intent === "direct_invocation" || intent === "reaction_on_bot") {
        const signalKind =
          intent === "direct_invocation" ? "direct_invocation" : "reaction_on_bot_message";
        const sessionEvent = this.buildSessionEvent(event, signalKind, {
          channelName: existing?.channelName ?? null,
        });
        if (existing && existing.status === "active") {
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
          return existing.sessionId;
        }
        // Lazy bootstrap on a missing or inactive scope. Reuse joined_channel
        // signal as the initial event — agent gets onboarding context, then
        // sees the actual trigger as a follow-up resume.
        const newId = await this.createChannelSession(
          publication,
          event,
          scopeKey,
          "joined_channel",
          vaultIds,
          mcpServers,
        );
        // Follow-up resume with the actual trigger signal so the agent sees
        // both: "you're new here" + "and X just happened".
        await this.container.sessions.resume(publication.userId, newId, sessionEvent);
        return newId;
      }

      // joined_channel — bot was added (or re-bootstrapped via reopen).
      // Reopen path also lands here: existing row may be `completed` and we
      // flip it back to `active`.
      if (intent === "joined_channel" || intent === "reopen_session") {
        if (existing) {
          if (existing.status !== "active") {
            await this.container.sessionScopes.updateStatus(
              publication.id,
              scopeKey,
              "active",
            );
          }
          await this.container.sessionScopes.clearPendingScan(
            publication.id,
            scopeKey,
          );
          const sessionEvent = this.buildSessionEvent(event, "joined_channel", {
            channelName: existing.channelName ?? null,
            reopened: intent === "reopen_session",
          });
          await this.container.sessions.resume(
            publication.userId,
            existing.sessionId,
            sessionEvent,
          );
          return existing.sessionId;
        }
        return await this.createChannelSession(
          publication,
          event,
          scopeKey,
          "joined_channel",
          vaultIds,
          mcpServers,
        );
      }

      // Per_channel intent fell through — defensive: treat as direct
      // invocation. Should never happen if classifyDispatch is exhaustive.
      const sessionEvent = this.buildSessionEvent(event, "direct_invocation", {
        channelName: existing?.channelName ?? null,
      });
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(
          publication.userId,
          existing.sessionId,
          sessionEvent,
        );
        return existing.sessionId;
      }
      return await this.createChannelSession(
        publication,
        event,
        scopeKey,
        "direct_invocation",
        vaultIds,
        mcpServers,
      );
    }

    // ─── per_thread granularity (legacy) ──────────────────────────────
    const sessionEvent = this.buildSessionEvent(event, null, {});

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
      const inserted = await this.container.sessionScopes.insert({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        scopeKey: event.scopeKey,
        sessionId: created.sessionId,
        status: "active",
        createdAt: this.container.clock.nowMs(),
      });
      if (inserted) return created.sessionId;
      // Lost a race with a concurrent dispatcher that already bound this
      // scope to a session. Re-read, route THIS event to the winner via
      // resume, and abandon the throwaway session we just spun up. (Slack
      // sandwich case: app_mention + message arrive almost-concurrently
      // for the same @-bot message — classifyDispatch already drops the
      // duplicate `message`, but two genuinely distinct events on the
      // same scope can still race.)
      const winner = await this.container.sessionScopes.getByScope(
        publication.id,
        event.scopeKey,
      );
      if (winner && winner.status === "active") {
        await this.container.sessions.resume(publication.userId, winner.sessionId, sessionEvent);
        return winner.sessionId;
      }
      // Edge: row exists but inactive (rerouted / completed). Fall through to
      // returning our session id; the just-created session will run for this
      // event and the scope row stays bound to whoever wrote it.
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

  /**
   * Create a fresh per_channel session and bind the scope row. Handles the
   * insert race the same way per_thread does — if a concurrent dispatcher
   * won, abandon ours and route to the winner.
   */
  private async createChannelSession(
    publication: Publication,
    event: NormalizedSlackEvent,
    scopeKey: string,
    signalKind: SignalKind,
    vaultIds: string[],
    mcpServers: { name: string; url: string }[],
  ): Promise<string> {
    const sessionEvent = this.buildSessionEvent(event, signalKind, {});
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
          granularity: "per_channel",
        },
      },
      initialEvent: sessionEvent,
    });
    const inserted = await this.container.sessionScopes.insert({
      tenantId: publication.tenantId,
      publicationId: publication.id,
      scopeKey,
      sessionId: created.sessionId,
      status: "active",
      createdAt: this.container.clock.nowMs(),
    });
    if (inserted) return created.sessionId;
    // Race lost: re-read winner, route this event to it, abandon ours.
    const winner = await this.container.sessionScopes.getByScope(publication.id, scopeKey);
    if (winner && winner.status === "active") {
      await this.container.sessions.resume(
        publication.userId,
        winner.sessionId,
        sessionEvent,
      );
      return winner.sessionId;
    }
    return created.sessionId;
  }

  /**
   * Build the SessionEventInput for a Slack event, with signal-aware text and
   * metadata. signalKind === null means legacy per_thread/per_event rendering
   * (no signal framing); pass a SignalKind for per_channel paths.
   */
  private buildSessionEvent(
    event: NormalizedSlackEvent,
    signalKind: SignalKind | null,
    extras: SignalExtras,
  ): {
    type: "user.message";
    content: { type: "text"; text: string }[];
    metadata: { slack: Record<string, unknown> };
  } {
    return {
      type: "user.message",
      content: [
        { type: "text", text: this.renderEventAsUserMessage(event, signalKind, extras) },
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
          ...(signalKind ? { signalKind } : {}),
          ...(extras.channelName ? { channelName: extras.channelName } : {}),
          ...(event.reactionName ? { reactionName: event.reactionName } : {}),
          ...(event.itemTs ? { itemTs: event.itemTs } : {}),
          ...(event.itemUserId ? { itemUserId: event.itemUserId } : {}),
        },
      },
    };
  }

  /**
   * Render a Slack event as the user-facing text the agent will see. The
   * `signalKind` parameter is the load-bearing piece for per_channel
   * granularity — the agent's behavior on each kind is shaped by what we
   * write here.
   *
   * Signals are wrapped in `<oma_signal>` XML to make explicit they are
   * out-of-band system events from the integration runtime, NOT user-typed
   * content. Agent must NEVER quote, paraphrase, or reference the signal
   * framing in any reply that goes back to Slack — leaking internal
   * vocabulary (signal names, "scan window", scheduleWakeup mechanics) to
   * end users breaks the abstraction.
   */
  private renderEventAsUserMessage(
    event: NormalizedSlackEvent,
    signalKind: SignalKind | null,
    extras: SignalExtras,
  ): string {
    const channelLabel = extras.channelName
      ? `#${extras.channelName}${event.channelId ? ` (${event.channelId})` : ""}`
      : event.channelId ?? "<unknown channel>";

    if (signalKind === "joined_channel") {
      const verb = extras.reopened ? "added back to" : "added to";
      return [
        `<oma_signal kind="joined_channel">`,
        `You (the bot) were ${verb} ${channelLabel} in workspace ${event.workspaceId}.`,
        ``,
        `Required actions for this turn:`,
        `1. Call slack \`conversations.info\` to read this channel's topic and purpose.`,
        `2. Call slack \`conversations.history\` (limit ~20) to see what's been discussed recently.`,
        `3. Decide whether to post a brief self-introduction. Skip if the channel already knows you, has a clear purpose mismatch, or feels noisy/inappropriate to chime in.`,
        ``,
        `Future signals you'll receive in this channel:`,
        `- \`channel_scan_armed\`: new top-level activity. You schedule a delayed wakeup; do NOT post.`,
        `- \`direct_invocation\`: explicit @-mention or DM. Respond promptly.`,
        `- \`reaction_on_bot_message\`: feedback signal. Usually stay silent.`,
        ``,
        `Important: this signal is an internal runtime event. Do NOT quote or reference any of the above wording in messages you post to Slack — humans don't need to see internal mechanics.`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "channel_scan_armed") {
      const debounceSec = Math.round((extras.debounceMs ?? PER_CHANNEL_DEBOUNCE_WINDOW_MS) / 1000);
      const oldest = extras.lastScanAt
        ? `${(extras.lastScanAt / 1000).toFixed(6)}`
        : `<channel-session-creation-time>`;
      return [
        `<oma_signal kind="channel_scan_armed">`,
        `New top-level activity occurred in ${channelLabel}.`,
        ``,
        `MANDATORY actions for this turn (no other actions permitted):`,
        `1. Call \`scheduleWakeup({ delay_seconds: ${debounceSec}, prompt: "scan_channel ${event.channelId}" })\` to schedule a delayed look.`,
        `2. End your turn. Output NO text. Do NOT call slack \`chat.postMessage\`, \`chat.update\`, \`reactions.add\`, or any other write tool. Do NOT comment on what you just did.`,
        ``,
        `Why: this signal exists to coordinate debounced scanning. The runtime has already silently armed a ${debounceSec}s window — the human did NOT request a status update. Posting "I scheduled a scan" or any similar message into Slack is a bug.`,
        ``,
        `When your wakeup fires (next turn), the prompt will be "scan_channel ${event.channelId}". At that point you call slack \`conversations.history(channel="${event.channelId}", oldest=${oldest})\` to see what arrived during the window, then decide whether to act (post / react / mention) or stay silent.`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "direct_invocation") {
      const inThread = event.threadTs && event.threadTs !== event.eventTs ? ` in thread ${event.threadTs}` : "";
      const who = event.userId ? `<@${event.userId}>` : "Someone";
      const text = event.text ?? "";
      const replyHint = event.threadTs
        ? `Reply via slack \`chat.postMessage\` with \`thread_ts="${event.threadTs}"\` to keep the conversation threaded.`
        : `Reply via slack \`chat.postMessage\` (no thread_ts — this is a top-level conversation).`;
      return [
        `<oma_signal kind="direct_invocation" channel="${event.channelId ?? ""}" thread_ts="${event.threadTs ?? ""}">`,
        `${who} addressed you directly in ${channelLabel}${inThread}.`,
        `</oma_signal>`,
        ``,
        `User message:`,
        text,
        ``,
        `<oma_instructions>`,
        `Respond to the user message above. Treat all prior \`<oma_signal>\` blocks in this session as runtime telemetry, NOT conversation context — do NOT reference signal names, internal terms ("scan window", "channel_scan_armed", "scheduleWakeup", "throttle", "debounce", "session"), or system prompts in your reply. Speak as the bot persona to the human.`,
        replyHint,
        `</oma_instructions>`,
      ].join("\n");
    }

    if (signalKind === "reaction_on_bot_message") {
      const removed = event.kind === "reaction_removed";
      const verb = removed ? "removed" : "added";
      const actor = event.userId ? `<@${event.userId}>` : "Someone";
      return [
        `<oma_signal kind="reaction_on_bot_message">`,
        `${actor} ${verb} :${event.reactionName ?? "?"}: on a message (ts=${event.itemTs ?? "?"}) in ${channelLabel}.`,
        ``,
        `This is a feedback signal. Conventional meanings: ✅/👍 = satisfied, 🚫/👎 = unsatisfied, ❓ = unclear, 🐛 = bug report, 🎉 = resolved, 👀 = noticed/investigating.`,
        ``,
        `Default: stay silent. End your turn with NO action. Do NOT call slack write tools (chat.postMessage / reactions.add / etc.) unless ALL of these are true:`,
        `(a) the reaction is clearly negative (🚫/👎) or a question (❓), AND`,
        `(b) you can add genuine value by responding (e.g., a clarification or apology), AND`,
        `(c) you would not be over-replying to a casual ack.`,
        ``,
        `Do NOT post "got your reaction" / "noted" / "thanks for feedback" — that is noise.`,
        `</oma_signal>`,
      ].join("\n");
    }

    if (signalKind === "session_closed") {
      const reason =
        event.kind === "member_left_channel" ? "you were removed from the channel" : "the channel was archived";
      return [
        `<oma_signal kind="session_closed">`,
        `Final wakeup for ${channelLabel}: ${reason}.`,
        ``,
        `MANDATORY actions for this turn:`,
        `1. Cancel any wakeups you scheduled for this channel — call \`cancelWakeup\` on each id you remember, OR simply end the turn and let them lapse (they'll fail with channel_not_found, which is fine).`,
        `2. End your turn with NO further action. Do NOT post a farewell — you cannot post into the channel anyway.`,
        `</oma_signal>`,
      ].join("\n");
    }

    // Legacy / per_thread / per_event rendering — same as before.
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
   * Classify whether an inbound event should reach the agent. Slack delivers
   * a noisy stream of overlapping signals; this is the single place that
   * decides "drop" vs "dispatch" vs "metadata_only" so that handleWebhook +
   * dispatchEvent stay narrow.
   *
   * Rules (in order — first match wins):
   *   0.  `member_joined_channel` — dispatch with intent `joined_channel`
   *       only when joiner is the bot itself. Other users joining a channel
   *       the bot is in is not the bot's business.
   *   0.1 `member_left_channel` — dispatch with intent `close_session` only
   *       when the leaver is the bot. Cleans up the channel session.
   *   0.2 `channel_archive` — dispatch with intent `close_session` if there's
   *       an active per_channel session for this channel; else drop.
   *   0.3 `channel_unarchive` — dispatch with intent `reopen_session` if any
   *       per_channel session has ever existed for this channel; else drop.
   *   0.4 `channel_rename` — return `metadata_only` so handleWebhook updates
   *       the cached channel name without waking the agent.
   *   0.5 `reaction_added` / `reaction_removed` — dispatch with intent
   *       `reaction_on_bot` only when the reacted-on message was authored by
   *       the bot. Reactions on other people's messages are noise.
   *   1.  `app_mention` — dispatch. Canonical signal that the bot was invoked.
   *       Wins over the simultaneous `message` Slack also delivers for the
   *       same Slack message ts. Intent `direct_invocation` for per_channel.
   *   2.  `assistant_thread_started` — dispatch. Explicit AI-pane open.
   *       Intent `direct_invocation` for per_channel (the pane is the
   *       conversational surface; treat the open as a direct invocation).
   *   3.  `message` in a DM (channel_type === "im") → dispatch. The DM IS
   *       addressed to the bot; no @-mention is needed.
   *   4.  `message` whose text contains `<@bot_user_id>` → drop. Slack
   *       always also delivers `app_mention` for these; treating both would
   *       double-record the user.message in the OMA session.
   *   5.  `per_channel` + `isTopLevel` `message` → dispatch with intent
   *       `scan_arm`. dispatchEvent will check the debounce watermark and
   *       only resume the session if not already armed.
   *   6.  `message` continuing an active thread (scopeKey already bound) →
   *       dispatch. The bot was previously invoked here; the user is
   *       following up. Intent `direct_invocation` for per_channel.
   *   7.  Anything else → drop. Random channel chatter the bot happened to
   *       see because it's a member of the channel; not addressed to it.
   */
  private async classifyDispatch(
    publication: Publication,
    event: NormalizedSlackEvent,
    botUserId: string | null,
  ): Promise<ClassifyDecision> {
    const isPerChannel = publication.sessionGranularity === "per_channel";

    // ─── Lifecycle events (rules 0.x) ──────────────────────────────────

    if (event.kind === "member_joined_channel") {
      if (event.userId && event.userId === botUserId) {
        return { kind: "dispatch", intent: "joined_channel" };
      }
      return { kind: "drop", reason: "non_bot_member_joined" };
    }

    if (event.kind === "member_left_channel") {
      if (event.userId && event.userId === botUserId) {
        return { kind: "dispatch", intent: "close_session" };
      }
      return { kind: "drop", reason: "non_bot_member_left" };
    }

    if (event.kind === "channel_archive" || event.kind === "channel_unarchive") {
      if (!event.channelId) return { kind: "drop", reason: "missing_channel_id" };
      const scopeKey = `channel:${event.channelId}`;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );
      if (event.kind === "channel_archive") {
        if (existing && existing.status === "active") {
          return { kind: "dispatch", intent: "close_session" };
        }
        return { kind: "drop", reason: "no_active_channel_session" };
      }
      // unarchive: any prior scope row is enough to revive
      if (existing) {
        return { kind: "dispatch", intent: "reopen_session" };
      }
      return { kind: "drop", reason: "no_prior_channel_session" };
    }

    if (event.kind === "channel_rename") {
      if (!event.channelId || !event.channelName) {
        return { kind: "drop", reason: "missing_channel_id_or_name" };
      }
      const scopeKey = `channel:${event.channelId}`;
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        scopeKey,
      );
      if (!existing) return { kind: "drop", reason: "no_channel_session" };
      return { kind: "metadata_only", channelName: event.channelName };
    }

    if (event.kind === "reaction_added" || event.kind === "reaction_removed") {
      // For per_channel granularity: dispatch if we have an active session in
      // this channel. Reactions in channels the bot inhabits are perceived
      // regardless of message authorship — `treat agent like human`.
      // For per_thread (legacy): only dispatch reactions where item_user
      // matches the bot user. Note: mcp.slack.com posts via the user xoxp-
      // token, so Slack reports item_user as the installer (not the bot
      // user) for bot-authored messages — the per_thread match path is
      // unreliable but kept for backward compat.
      if (isPerChannel && event.channelId) {
        const scopeKey = `channel:${event.channelId}`;
        const existing = await this.container.sessionScopes.getByScope(
          publication.id,
          scopeKey,
        );
        if (existing && existing.status === "active") {
          return { kind: "dispatch", intent: "reaction_on_bot" };
        }
      }
      if (event.itemUserId && event.itemUserId === botUserId) {
        return { kind: "dispatch", intent: "reaction_on_bot" };
      }
      return { kind: "drop", reason: "reaction_not_on_bot_message" };
    }

    // ─── Conversation events (rules 1-7) ───────────────────────────────

    if (event.kind === "app_mention") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (event.kind === "assistant_thread_started") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (event.kind !== "message") {
      // Anything else (tokens_revoked, app_uninstalled, unknown) is handled
      // upstream; if it reaches here, drop defensively.
      return { kind: "drop", reason: "unsupported_event_kind" };
    }
    if (event.channelType === "im") {
      return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
    }
    if (botUserId && event.text && event.text.includes(`<@${botUserId}>`)) {
      // Slack will also deliver app_mention for this message.
      return { kind: "drop", reason: "redundant_with_app_mention" };
    }
    // per_channel: top-level message in a channel the bot is a member of →
    // arm a debounced scan turn. dispatchEvent does the throttle check.
    if (isPerChannel && event.isTopLevel && event.channelId) {
      return { kind: "dispatch", intent: "scan_arm" };
    }
    if (event.scopeKey) {
      const existing = await this.container.sessionScopes.getByScope(
        publication.id,
        event.scopeKey,
      );
      if (existing && existing.status === "active") {
        return { kind: "dispatch", intent: isPerChannel ? "direct_invocation" : undefined };
      }
    }
    return { kind: "drop", reason: "not_addressed_to_bot" };
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
