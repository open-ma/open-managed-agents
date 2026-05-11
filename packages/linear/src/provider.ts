// LinearProvider — implements integrations-core's IntegrationProvider for
// Linear. This is the orchestrator: routes between OAuth, webhook, and MCP
// flows, and translates between integration-core's port shapes and Linear's
// API shapes.
//
// All runtime concerns (HTTP, storage, crypto, JWT, sessions) are injected
// via the Container. The provider itself is pure logic and unit-testable
// with the in-memory fakes from @open-managed-agents/integrations-core/test-fakes.

import type {
  Container,
  ContinueInstallInput,
  DispatchRule,
  IntegrationProvider,
  InstallComplete,
  InstallStep,
  LinearEventStore,
  McpScope,
  McpToolDescriptor,
  McpToolResult,
  ProviderId,
  StartInstallInput,
  WebhookOutcome,
  WebhookRequest,
  CapabilityKey,
  Persona,
  Publication,
} from "@open-managed-agents/integrations-core";

import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES, type LinearConfig } from "./config";
import { LinearGraphQLClient } from "./graphql/client";
import {
  buildAuthorizeUrl,
  buildRefreshTokenBody,
  buildTokenExchangeBody,
  parseTokenResponse,
} from "./oauth/protocol";
import { parseWebhook, type NormalizedWebhookEvent, type RawWebhookEnvelope } from "./webhook/parse";

/** Subset of Container the LinearProvider depends on. Narrows
 *  `webhookEvents` to LinearEventStore — Linear's webhook table is the
 *  merged `linear_events` table that also holds the async drain queue. */
export interface LinearContainer extends Container {
  webhookEvents: LinearEventStore;
}

const OAUTH_STATE_TTL_SECONDS = 30 * 60; // 30 min — covers slow OAuth UX
const PROVIDER_ID: ProviderId = "linear";

/** Linear's hosted MCP server. Outbound injection matches by hostname. */
const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

export class LinearProvider implements IntegrationProvider {
  readonly id: ProviderId = PROVIDER_ID;
  private readonly graphql: LinearGraphQLClient;

  constructor(
    private readonly container: LinearContainer,
    private readonly config: LinearConfig,
  ) {
    this.graphql = new LinearGraphQLClient(container.http);
  }

  // ─── Install ─────────────────────────────────────────────────────────

  async startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete> {
    return this.startDedicatedFlow(input);
  }

  async continueInstall(
    input: ContinueInstallInput,
  ): Promise<InstallStep | InstallComplete> {
    const payload = input.payload as { kind?: string; [k: string]: unknown };
    if (payload.kind === "submit_credentials") {
      return this.submitDedicatedCredentials(payload);
    }
    if (payload.kind === "handoff_link") {
      return this.createHandoffLink(payload);
    }
    if (payload.kind === "oauth_callback_dedicated") {
      return this.completeDedicatedInstall(
        (payload.appId as string) ?? "",
        (payload.code as string) ?? "",
        (payload.state as string) ?? "",
      );
    }
    throw new Error(
      `LinearProvider.continueInstall: unknown payload kind '${payload.kind}'`,
    );
  }

  // ─── PAT install (Symphony-equivalent, no OAuth app) ────────────────

  /**
   * Install a Linear connection backed by a Personal API Key. Equivalent
   * to Symphony's `LINEAR_API_KEY` model — the bot acts as the PAT
   * owner. No webhook source, so triggering relies on dispatch rules.
   *
   * One-shot vs the OAuth dance: validate via viewer query, persist,
   * return InstallComplete in a single call. No formToken, no callback.
   *
   * Returns InstallComplete with the new publicationId on success.
   * Throws on validation failure or workspace conflicts.
   */
  async installPersonalToken(input: {
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    /** Linear PAT, format `lin_api_…`. */
    patToken: string;
  }): Promise<InstallComplete> {
    if (!input.patToken || !input.patToken.trim()) {
      throw new Error("patToken required");
    }
    const token = input.patToken.trim();

    // Validate token + capture the user this PAT acts as. Linear PATs are
    // sent as the raw token in `Authorization: <token>` (no Bearer prefix
    // for some endpoints) but our client always sends Bearer; Linear's
    // GraphQL accepts both.
    let viewer: { id: string; name: string };
    let organization: { id: string; name: string; urlKey: string };
    try {
      const result = await this.graphql.fetchViewerAndOrg(token);
      viewer = result.viewer;
      organization = result.organization;
    } catch (err) {
      throw new Error(
        `Linear PAT validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const tenantId = await this.container.tenants.resolveByUserId(input.userId);

    // Reject conflicting active install (same workspace + same install_kind).
    // Two PAT installs of the same workspace by the same OMA tenant would
    // race on dispatch and look identical in audit logs.
    const existing = await this.container.installations.findByWorkspace(
      PROVIDER_ID,
      organization.id,
      "personal_token",
      null,
    );
    if (existing) {
      throw new Error(
        `Linear workspace ${organization.name} already has an active personal-token install (id=${existing.id})`,
      );
    }

    const installation = await this.container.installations.insert({
      tenantId,
      userId: input.userId,
      providerId: PROVIDER_ID,
      workspaceId: organization.id,
      workspaceName: organization.name,
      installKind: "personal_token",
      appId: null,
      accessToken: token,
      refreshToken: null,
      scopes: ["personal_api_key"],
      botUserId: viewer.id,
    });

    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: input.userId,
      vaultName: `Linear · ${organization.name} · ${input.persona.name} (PAT)`,
      displayName: `Linear PAT (${input.persona.name})`,
      mcpServerUrl: LINEAR_MCP_URL,
      bearerToken: token,
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    const publication = await this.container.publications.insert({
      tenantId,
      userId: input.userId,
      agentId: input.agentId,
      installationId: installation.id,
      environmentId: input.environmentId,
      mode: "full",
      status: "live",
      persona: input.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? ALL_CAPABILITIES,
      ),
      sessionGranularity: "per_issue",
    });

    return { kind: "complete", publicationId: publication.id };
  }

  // ─── A1 (full identity, BYO Linear App) ─────────────────────────────

  private async startDedicatedFlow(input: StartInstallInput): Promise<InstallStep> {
    // Generate appId upfront so step 1 hands the user the *final* callback /
    // webhook URLs to paste into Linear's form. Linear bakes the webhook URL
    // at creation time and won't let you change it via API, so the only way
    // out is to make step 1 final.
    //
    // We deliberately do NOT generate a webhookSecret here. Linear's "New
    // OAuth application" form auto-generates its own (`lin_wh_…`) and ignores
    // any value pasted in — so anything we hand the user is silently
    // overwritten, and OMA verifying with our value would mean every webhook
    // failed signature verification (silently, with HTTP 200, since Linear
    // sees 2xx and never reports a delivery failure). The user copies
    // Linear's secret back at step 2 instead.
    //
    // Form contents live in a short-lived form_token; we don't write the
    // App row to D1 until step 2 (after the user pastes the OAuth client
    // credentials + Linear's webhook signing secret).
    const appId = this.container.ids.generate();
    const formToken = await this.container.jwt.sign(
      {
        kind: "linear.a1.form",
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
        callbackUrl: this.dedicatedCallbackUri(appId),
        webhookUrl: this.dedicatedWebhookUri(appId),
      },
    };
  }

  private async submitDedicatedCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const clientId = (payload.clientId as string) ?? "";
    const clientSecret = (payload.clientSecret as string) ?? "";
    const webhookSecret = (payload.webhookSecret as string) ?? "";
    if (!formToken || !clientId || !clientSecret || !webhookSecret) {
      throw new Error(
        "submit_credentials: formToken, clientId, clientSecret, webhookSecret required",
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
    if (form.kind !== "linear.a1.form") {
      throw new Error("submit_credentials: invalid formToken kind");
    }
    if (!form.appId) {
      // Old formTokens minted before this change won't carry appId. Force the
      // user to restart the flow rather than mint a fresh appId here (which
      // would re-introduce the URL mismatch this fix is supposed to kill).
      throw new Error("submit_credentials: formToken missing appId — please restart the publish flow");
    }

    // Upsert keyed on appId so a re-submit (page refresh, network retry)
    // doesn't create a second row with a different id.
    const tenantId = await this.container.tenants.resolveByUserId(form.userId);
    const app = await this.container.apps.insert({
      id: form.appId,
      tenantId,
      publicationId: null,
      clientId,
      clientSecret,
      webhookSecret,
    });

    // Build the install URL the user clicks next. State JWT carries the
    // context we'll need on callback.
    const state = await this.container.jwt.sign(
      {
        kind: "linear.oauth.dedicated",
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
      redirectUri: this.dedicatedCallbackUri(app.id),
      scopes: this.config.scopes ?? DEFAULT_LINEAR_SCOPES,
      state,
      actor: "app",
    });

    return {
      kind: "step",
      step: "install_link",
      data: {
        url,
        appId: app.id,
        // Updated URLs the UI can show as the final values for this App.
        callbackUrl: this.dedicatedCallbackUri(app.id),
        webhookUrl: this.dedicatedWebhookUri(app.id),
      },
    };
  }

  private async completeDedicatedInstall(
    appId: string,
    code: string,
    stateToken: string,
  ): Promise<InstallComplete> {
    if (!appId) throw new Error("Linear OAuth dedicated callback: missing appId");
    if (!code) throw new Error("Linear OAuth dedicated callback: missing code");
    if (!stateToken) throw new Error("Linear OAuth dedicated callback: missing state");

    const state = await this.container.jwt.verify<{
      kind: string;
      appId: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
    }>(stateToken);
    if (state.kind !== "linear.oauth.dedicated") {
      throw new Error("Linear OAuth dedicated callback: invalid state kind");
    }
    if (state.appId !== appId) {
      throw new Error("Linear OAuth dedicated callback: appId mismatch");
    }

    const app = await this.container.apps.get(appId);
    if (!app) throw new Error("Linear OAuth dedicated callback: unknown appId");

    const clientSecret = await this.container.apps.getClientSecret(app.id);
    if (!clientSecret) {
      throw new Error("Linear OAuth dedicated callback: missing client secret");
    }

    // Token exchange with the user's own App credentials.
    const tokenReq = buildTokenExchangeBody({
      code,
      redirectUri: this.dedicatedCallbackUri(app.id),
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
        `Linear OAuth dedicated token exchange failed: ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);

    const { viewer, organization } = await this.graphql.fetchViewerAndOrg(token.access_token);

    // A1 installs are always fresh — one App per agent per workspace, no reuse.
    const tenantId = await this.container.tenants.resolveByUserId(state.userId);
    const installation = await this.container.installations.insert({
      tenantId,
      userId: state.userId,
      providerId: PROVIDER_ID,
      workspaceId: organization.id,
      workspaceName: organization.name,
      installKind: "dedicated",
      appId: app.id,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scopes: token.scope ? token.scope.split(/[\s,]+/) : [...(this.config.scopes ?? DEFAULT_LINEAR_SCOPES)],
      botUserId: viewer.id,
    });

    // Vault for outbound token injection (same as B+).
    const { vaultId } = await this.container.vaults.createCredentialForUser({
      userId: state.userId,
      vaultName: `Linear · ${organization.name} · ${state.persona.name}`,
      displayName: `Linear MCP token (${state.persona.name})`,
      mcpServerUrl: LINEAR_MCP_URL,
      bearerToken: token.access_token,
    });
    await this.container.installations.setVaultId(installation.id, vaultId);

    // Create publication and link App back to it.
    const publication = await this.container.publications.insert({
      tenantId,
      userId: state.userId,
      agentId: state.agentId,
      installationId: installation.id,
      environmentId: state.environmentId,
      mode: "full",
      status: "live",
      persona: state.persona,
      capabilities: new Set<CapabilityKey>(
        this.config.defaultCapabilities ?? ALL_CAPABILITIES,
      ),
      sessionGranularity: "per_issue",
    });
    await this.container.apps.setPublicationId(app.id, publication.id);

    return { kind: "complete", publicationId: publication.id };
  }

  private dedicatedCallbackUri(appId: string): string {
    return `${this.config.gatewayOrigin}/linear/oauth/app/${appId}/callback`;
  }
  private dedicatedWebhookUri(appId: string): string {
    return `${this.config.gatewayOrigin}/linear/webhook/app/${appId}`;
  }
  /** Placeholder shown before we know the appId; UI re-renders with real URL after. */
  private dedicatedCallbackPlaceholder(): string {
    return `${this.config.gatewayOrigin}/linear/oauth/app/<APP_ID>/callback`;
  }
  private dedicatedWebhookPlaceholder(): string {
    return `${this.config.gatewayOrigin}/linear/webhook/app/<APP_ID>`;
  }

  /**
   * Re-signs a 30-minute formToken into a 7-day handoff token an admin can
   * use without OMA login. Returns the public link URL.
   */
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
      webhookSecret: string;
    }>(formToken);
    if (form.kind !== "linear.a1.form") {
      throw new Error("handoff_link: invalid formToken kind");
    }
    // Re-sign with 7-day TTL. Same payload but explicitly marked as a handoff
    // so we can distinguish in audit logs / future expiry policies.
    const handoffToken = await this.container.jwt.sign(
      { ...form, kind: "linear.a1.form", handoff: true },
      7 * 24 * 60 * 60,
    );
    return {
      kind: "step",
      step: "install_link",
      data: {
        url: `${this.config.gatewayOrigin}/linear-setup/${handoffToken}`,
        expiresInDays: 7,
      },
    };
  }

  // ─── Webhook ─────────────────────────────────────────────────────────

  async handleWebhook(req: WebhookRequest): Promise<WebhookOutcome> {
    if (!req.installationId) {
      return { handled: false, reason: "missing_installation_id" };
    }
    if (!req.deliveryId) {
      return { handled: false, reason: "missing_delivery_id" };
    }

    const installation = await this.container.installations.get(req.installationId);
    if (!installation || installation.revokedAt !== null) {
      return { handled: false, reason: "installation_not_found_or_revoked" };
    }

    // Resolve the webhook secret from the per-app row.
    if (!installation.appId) {
      return { handled: false, reason: "missing_app_for_dedicated_install" };
    }
    const webhookSecret = await this.container.apps.getWebhookSecret(installation.appId);
    if (!webhookSecret) {
      return { handled: false, reason: "missing_webhook_secret" };
    }

    // Verify HMAC. Linear sends signatures in the `linear-signature` header.
    const signature = req.headers["linear-signature"];
    if (!signature) return { handled: false, reason: "missing_signature" };
    const ok = await this.container.hmac.verify(
      webhookSecret,
      req.rawBody,
      signature,
    );
    if (!ok) return { handled: false, reason: "invalid_signature" };

    // Idempotency: refuse to dispatch the same delivery twice. Linear retries
    // aggressively on 5xx, so this gate matters.
    const fresh = await this.container.webhookEvents.recordIfNew(
      req.deliveryId,
      installation.tenantId, // Phase 0: nullable until backfill of pre-existing rows
      installation.id,
      "unknown",
      this.container.clock.nowMs(),
    );
    if (!fresh) return { handled: false, reason: "duplicate_delivery" };

    // Parse + dispatch.
    let raw: RawWebhookEnvelope;
    try {
      raw = JSON.parse(req.rawBody) as RawWebhookEnvelope;
    } catch {
      await this.container.webhookEvents.attachError(req.deliveryId, "invalid_json");
      return { handled: false, reason: "invalid_json" };
    }
    const event = parseWebhook(raw);
    if (!event) {
      await this.container.webhookEvents.attachError(req.deliveryId, "unparseable");
      return { handled: false, reason: "unparseable" };
    }
    console.log(
      `[linear-parsed] eventType=${event.eventType} kind=${event.kind} issueId=${event.issueId} issueIdent=${event.issueIdentifier} agentSessionId=${event.agentSessionId ?? "-"} promptCtx=${event.promptContext ? event.promptContext.length : 0}b`,
    );

    // Linear sends multiple webhooks per agent action (e.g. an Issue update
    // PLUS an AgentSessionEvent). Only AgentSessionEvent and the
    // AppUserNotification subtypes carry actionable user intent for the
    // agent — bare Issue/Comment events are noise here. Drop them so we
    // don't create empty "Linear event on ?" sessions.
    if (event.kind === null) {
      return { handled: false, reason: `ignored_event_${event.eventType}` };
    }

    // A dedicated install has exactly one live publication.
    const pubs = await this.container.publications.listByInstallation(installation.id);
    const publication: Publication | null =
      pubs.find((p) => p.status === "live") ?? null;
    const routingReason = publication ? "dedicated_install" : "no_live_publication";

    if (!publication) {
      await this.container.webhookEvents.attachError(req.deliveryId, routingReason);
      return { handled: false, reason: routingReason };
    }
    await this.container.webhookEvents.attachPublication(
      req.deliveryId,
      publication.id,
    );

    // Comment-on-active-issue path: when ANY human (not the bot itself)
    // posts a comment on an issue with an active OMA session bound to it,
    // resume that session synchronously with the comment as a user message.
    // Routing key is issueId (not parentCommentId) — drops the
    // authored_comments lookup we used to maintain per-comment, in favor
    // of the simpler issue-level binding kept in linear_issue_sessions.
    //
    // Bots post comments via Linear's hosted MCP `save_comment`; replies
    // come back here naturally because Linear webhooks all comments on
    // issues in workspaces our app is installed in.
    if (event.kind === "commentReply" && event.issueId) {
      // Don't bounce the bot's own comments back at itself.
      if (event.actorUserId && installation.botUserId === event.actorUserId) {
        return { handled: false, reason: "comment_from_bot_self" };
      }
      const existing = await this.container.issueSessions.getByIssue(
        publication.id,
        event.issueId,
      );
      if (!existing || existing.status !== "active") {
        return { handled: false, reason: "comment_on_issue_with_no_active_session" };
      }
      const actorDisplayName = await this.resolveActorDisplayName(installation.id, event.actorUserId);
      const handle = actorDisplayName ? `@${actorDisplayName}` : "(unknown user)";
      const replyText = [
        `# Linear comment activity`,
        ``,
        `**Issue:** ${event.issueIdentifier ?? "?"}`,
        ...(event.issueId ? [`**Issue UUID:** \`${event.issueId}\``] : []),
        `**Author:** ${handle}`,
        ...(event.commentId ? [`**Comment id:** \`${event.commentId}\``] : []),
        ...(event.parentCommentId ? [`**Parent comment id:** \`${event.parentCommentId}\` (this is a thread reply)`] : []),
        ``,
        `> ${(event.commentBody ?? "").replace(/\n/g, "\n> ")}`,
        ``,
        `Reply via the Linear hosted MCP \`save_comment\` tool — pass \`parentId\``,
        `to reply within the same thread, or omit it to start a new top-level comment.`,
      ].join("\n");
      try {
        await this.container.sessions.resume(publication.userId, existing.sessionId, {
          type: "user.message",
          content: [{ type: "text", text: replyText }],
          metadata: { linear: { publicationId: publication.id } },
        });
      } catch (err) {
        // Bot session was archived/deleted between webhook and now. Comment
        // is dropped; operator can react via Linear if it matters.
        console.warn(
          `[linear-comment-route] resume failed session=${existing.sessionId} issue=${event.issueId} — dropping. err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { handled: false, reason: "comment_resume_failed_session_gone" };
      }
      await this.container.webhookEvents.attachSession(req.deliveryId, existing.sessionId);
      return {
        handled: true,
        reason: "comment_on_active_issue",
        publicationId: publication.id,
        sessionId: existing.sessionId,
        tenantId: installation.tenantId,
      };
    }

    // Dispatch path: persist event into pending_events queue, optionally
    // synchronously ack the panel (AgentSessionEvent only), return 200.
    // The cron sweep drains the queue and calls processPendingEvent which
    // does sessions.create/resume.
    //
    // Why async: Linear gives webhook handlers ~30s deadline, but spawning
    // a SessionDO + booting the sandbox container can take 10-30s on a
    // cold start. Persisting + 200ing in <500ms is safer; the panel ack
    // (when applicable) gives the user immediate UX feedback while the
    // real work is being prepared.
    if (event.kind === "agentSessionCreated" || event.kind === "agentSessionPrompted") {
      // Best-effort ack-and-close: post a single AgentActivity (kind=response)
      // that finalizes the panel UI. Bot's actual work then happens via
      // comments + state changes (no more linear_say). If this fails we
      // still continue — the queue entry exists, bot will pick it up via
      // cron and post a comment instead.
      if (event.agentSessionId) {
        try {
          await this.ackAgentSessionPanel(installation.id, event.agentSessionId);
        } catch (err) {
          console.warn(
            `[linear-ack] panel ack failed session=${event.agentSessionId} err=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // Promote the deduped row from "audit-only" into the drain queue by
    // setting payload + event_kind + publication_id. Drain picks it up on
    // the next cron tick.
    await this.container.webhookEvents.markActionable(
      req.deliveryId,
      event.kind ?? "unknown",
      publication.id,
      JSON.stringify(event),
    );

    return {
      handled: true,
      reason: `${routingReason}_queued`,
      publicationId: publication.id,
      // No sessionId yet — created by the drain. Caller logs this as null.
      // We surface deliveryId so that ops can grep linear_events for the
      // queue row.
      sessionId: req.deliveryId,
      tenantId: installation.tenantId,
    };
  }

  /**
   * Synchronously POST a `kind=response` AgentActivity to finalize the
   * panel Linear opened for this AgentSessionEvent. After this, the panel
   * is in `complete` state and any further linear_say-style writes won't
   * render — the bot does its real work via comments instead.
   *
   * Auth: uses the installation's stored access token. Returns once Linear
   * confirms 200; throws on transport / GraphQL errors so the caller can
   * decide whether to log and continue.
   */
  private async ackAgentSessionPanel(
    installationId: string,
    agentSessionId: string,
  ): Promise<void> {
    const accessToken = await this.container.installations.getAccessToken(installationId);
    if (!accessToken) throw new Error(`no access token for installation ${installationId}`);
    await this.graphql.query<{ agentActivityCreate: { success: boolean } }>(
      accessToken,
      `mutation AckPanel($input: AgentActivityCreateInput!) {
         agentActivityCreate(input: $input) { success }
       }`,
      {
        input: {
          agentSessionId,
          content: {
            type: "response",
            body:
              "Acknowledged — picking this up. I'll respond in the comment thread (this panel is now complete).",
          },
        },
      },
    );
  }

  private async dispatchEvent(
    publication: Publication,
    event: NormalizedWebhookEvent,
  ): Promise<string> {
    // Look up the installation to find the vault holding the access token.
    const installation = await this.container.installations.get(publication.installationId);
    const vaultIds = installation?.vaultId ? [installation.vaultId] : [];
    // Hand the bot Linear's hosted MCP server. The outbound MITM
    // Bearer-wraps the vaulted token (PAT or OAuth-app developer token);
    // both work against mcp.linear.app/mcp. Together with our own minimal
    // MCP (see apps/integrations/src/routes/linear/mcp.ts) the bot has
    // ~30 hosted tools + our routing tools.
    const mcpServers: Array<{ name: string; url: string }> = [
      { name: "linear", url: LINEAR_MCP_URL },
    ];

    const actorDisplayName = await this.resolveActorDisplayName(
      installation?.id ?? null,
      event.actorUserId,
    );

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        {
          type: "text" as const,
          text: this.renderEventAsUserMessage(event, actorDisplayName),
        },
      ],
      // Metadata only carries the immutable wiring fields the MCP server
      // needs. The bot owns all "where am I right now" decisions via the
      // tool semantics (issueId is in the prompt body for the bot to read).
      metadata: { linear: { publicationId: publication.id } },
    };

    if (publication.sessionGranularity === "per_issue" && event.issueId) {
      const existing = await this.container.issueSessions.getByIssue(
        publication.id,
        event.issueId,
      );
      if (existing) {
        // Linear is the source of truth; we don't track session lifecycle in
        // our DB. The row's status field is just a "claim marker" — assume
        // any existing row points at a still-resumable session. If resume
        // fails (session was archived/deleted), fall through to create.
        try {
          await this.container.sessions.resume(publication.userId, existing.sessionId, sessionEvent);
          return existing.sessionId;
        } catch (err) {
          console.warn(
            `[linear-dispatch] resume failed for session=${existing.sessionId} issue=${event.issueId} — falling through to create. err=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          // fall through
        }
      }
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds,
        mcpServers,
        metadata: { linear: { publicationId: publication.id, issueId: event.issueId, workspaceId: event.workspaceId } },
        initialEvent: sessionEvent,
      });
      await this.container.issueSessions.insert({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        issueId: event.issueId,
        sessionId: created.sessionId,
        status: "active",
        createdAt: this.container.clock.nowMs(),
      });
      return created.sessionId;
    }

    // per_event (or per_issue without an issue id): always fresh session.
    const created = await this.container.sessions.create({
      userId: publication.userId,
      agentId: publication.agentId,
      environmentId: publication.environmentId,
      vaultIds,
      mcpServers,
      metadata: { linear: { publicationId: publication.id, issueId: event.issueId, workspaceId: event.workspaceId } },
      initialEvent: sessionEvent,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(
    event: NormalizedWebhookEvent,
    actorDisplayName: string | null = null,
  ): string {
    // Hard rule: bot only ever sees `@<displayName>`, never the user's
    // `name`. Linear's pre-rendered `promptContext` XML embeds raw `name`
    // values (e.g. "蛇皮") in user attributes — passing it verbatim to
    // the bot causes it to copy the wrong handle into replies and fail to
    // render real mentions. We rebuild the context ourselves from the
    // parsed event fields so every user reference is the displayName.
    const actor = actorDisplayName ? `@${actorDisplayName}` : "(unknown)";
    const headerByKind: Record<string, string> = {
      agentSessionPrompted: `Linear agent session — new prompt`,
      agentSessionCreated: `Linear agent session — newly opened`,
    };
    const header = headerByKind[event.kind ?? ""] ?? `Linear ${event.kind ?? "event"}`;
    const lines: string[] = [`# ${header}`, ""];
    lines.push(`**Issue:** ${event.issueIdentifier ?? "?"}`);
    if (event.issueId) {
      lines.push(`**Issue UUID:** \`${event.issueId}\` (use this when a tool asks for issueId)`);
    }
    lines.push(`**Actor:** ${actor}`);
    if (event.agentSessionId) {
      lines.push(`**Linear panel:** \`${event.agentSessionId}\``);
    }
    if (event.issueTitle) {
      lines.push("");
      lines.push(`**Title:** ${event.issueTitle}`);
    }
    if (event.issueDescription) {
      lines.push("");
      lines.push(`**Description:**`);
      lines.push(event.issueDescription);
    }
    if (event.commentBody) {
      lines.push("");
      lines.push(`**Source comment:**`);
      lines.push(`> ${event.commentBody.replace(/\n/g, "\n> ")}`);
    }
    if (event.agentSessionId) {
      lines.push("");
      lines.push(
        `Linear opened a panel for this trigger but OMA already acknowledged ` +
          `and finalized it. Do all your work via comments + issue state ` +
          `changes — use \`linear_post_comment\` (OMA tool) for top-level ` +
          `progress notes and final results, and the Linear hosted MCP ` +
          `(\`save_issue\`, \`save_comment\` for replies, etc.) for everything else.`,
      );
    }
    return lines.join("\n");
  }

  /** Best-effort displayName resolution. Returns null if anything goes
   *  wrong — callers fall back to "(unknown)" and the bot just doesn't get
   *  the @-handle hint. */
  private async resolveActorDisplayName(
    installationId: string | null,
    actorUserId: string | null | undefined,
  ): Promise<string | null> {
    if (!installationId || !actorUserId) return null;
    try {
      const accessToken = await this.container.installations.getAccessToken(installationId);
      if (!accessToken) return null;
      const res = await this.container.http.fetch({
        method: "POST",
        url: "https://api.linear.app/graphql",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `query($id:String!){ user(id:$id){ displayName } }`,
          variables: { id: actorUserId },
        }),
      });
      const parsed = JSON.parse(res.body) as {
        data?: { user?: { displayName?: string } };
      };
      return parsed.data?.user?.displayName ?? null;
    } catch {
      return null;
    }
  }

  // ─── MCP (Phase 8+) ──────────────────────────────────────────────────

  async mcpTools(_scope: McpScope): Promise<readonly McpToolDescriptor[]> {
    throw new Error("LinearProvider.mcpTools: not yet implemented");
  }

  async invokeMcpTool(
    _scope: McpScope,
    _toolName: string,
    _input: unknown,
  ): Promise<McpToolResult> {
    throw new Error("LinearProvider.invokeMcpTool: not yet implemented");
  }

  // ─── Token refresh ───────────────────────────────────────────────────
  //
  // Linear's `actor=app` authorization-code grant returns a 24-hour access
  // token + a refresh token. We persist both at install time. When a Linear
  // API call returns 401, the gateway calls `refreshAccessToken(installationId)`
  // to swap the dead token for a fresh one in-place — no reinstall needed.
  //
  // Linear rotates the refresh_token on every call, so the response payload
  // must be persisted in full. If Linear ever responds with a missing or
  // empty refresh_token, we leave the old one in place to keep future
  // refreshes possible.

  /**
   * Run Linear's OAuth refresh flow for `installationId`. Persists the rotated
   * tokens via the installation repo and returns the new access token. Throws
   * if the installation is missing, has no stored refresh token, the App row
   * can't be located, or Linear rejects the refresh (e.g. user revoked the
   * App). Caller decides whether to bubble the error or surface a friendlier
   * "please reinstall" message.
   */
  async refreshAccessToken(installationId: string): Promise<string> {
    const installation = await this.container.installations.get(installationId);
    if (!installation) {
      throw new Error(`installation ${installationId} not found`);
    }
    if (installation.revokedAt !== null) {
      throw new Error(`installation ${installationId} is revoked`);
    }
    if (!installation.appId) {
      throw new Error(
        `installation ${installationId} has no appId — refresh requires the OAuth app's client credentials`,
      );
    }
    const refreshToken = await this.container.installations.getRefreshToken(installationId);
    if (!refreshToken) {
      throw new Error(
        `installation ${installationId} has no stored refresh_token — cannot refresh, user must reinstall`,
      );
    }
    const app = await this.container.apps.get(installation.appId);
    if (!app) {
      throw new Error(`app ${installation.appId} for installation ${installationId} not found`);
    }
    const clientSecret = await this.container.apps.getClientSecret(app.id);
    if (!clientSecret) {
      throw new Error(`app ${app.id} has no client_secret`);
    }
    const refreshReq = buildRefreshTokenBody({
      refreshToken,
      clientId: app.clientId,
      clientSecret,
    });
    const refreshRes = await this.container.http.fetch({
      method: "POST",
      url: refreshReq.url,
      headers: { "content-type": refreshReq.contentType },
      body: refreshReq.body,
    });
    if (refreshRes.status < 200 || refreshRes.status >= 300) {
      throw new Error(
        `Linear OAuth refresh failed: ${refreshRes.status} ${refreshRes.body.slice(0, 200)}`,
      );
    }
    const fresh = parseTokenResponse(refreshRes.body);
    await this.container.installations.setTokens(
      installationId,
      fresh.access_token,
      // null is fine here — setTokens leaves the prior refresh row in place
      // when Linear didn't rotate. In practice Linear always sends one.
      fresh.refresh_token,
    );

    // Mirror the new bearer into the vault so the sandbox MITM injection picks
    // it up on the next outbound HTTPS call. Best-effort: a missing vault row
    // (older installs) shouldn't fail the refresh.
    if (installation.vaultId) {
      await this.container.vaults.rotateBearerToken({
        userId: installation.userId,
        vaultId: installation.vaultId,
        newBearerToken: fresh.access_token,
      });
    }

    return fresh.access_token;
  }

  // ─── One-shot re-authorize (migrate pre-refresh-support installs) ────
  //
  // For installations created before refreshAccessToken landed: we have no
  // refresh_token to roll, so the only path back to a working state is for
  // the user to re-grant OAuth consent. These two methods drive that flow
  // without touching the new-install codepath:
  //
  //   buildReauthorizeUrl(installationId, redirectBase)
  //     → builds the Linear authorize URL + state JWT, no DB writes
  //   completeReauthorize(installationId, appId, code, state)
  //     → verifies state, exchanges code, rotates tokens + vault in place
  //
  // Once every previously-deployed install has been migrated, both methods
  // (and the admin endpoints that call them) can be deleted.

  /**
   * Build a single-use Linear authorize URL that re-grants consent for an
   * existing installation. The state JWT carries `installationId` so the
   * companion callback can rotate that exact row without searching.
   */
  async buildReauthorizeUrl(input: {
    installationId: string;
    redirectBase: string;
    ttlSeconds?: number;
  }): Promise<{
    authorizeUrl: string;
    appId: string;
    workspaceName: string;
    botUserId: string;
  }> {
    const inst = await this.container.installations.get(input.installationId);
    if (!inst) throw new Error(`installation ${input.installationId} not found`);
    if (!inst.appId) throw new Error(`installation ${input.installationId} has no appId`);
    const app = await this.container.apps.get(inst.appId);
    if (!app) throw new Error(`app ${inst.appId} not found`);

    const stateToken = await this.container.jwt.sign(
      { kind: "linear.oauth.reauth", installationId: inst.id, appId: app.id },
      input.ttlSeconds ?? 60 * 30,
    );
    // Reuse the install callback URI on purpose. The dedicated-callback
    // handler dispatches by state.kind: "linear.oauth.dedicated" → first
    // install; "linear.oauth.reauth" → token rotation. Reusing the URI
    // means we don't have to register a new redirect_uri in the Linear
    // OAuth app config.
    const redirectUri = this.dedicatedCallbackUriFromBase(input.redirectBase, app.id);
    const authorizeUrl = buildAuthorizeUrl({
      clientId: app.clientId,
      redirectUri,
      scopes: this.config.scopes ?? DEFAULT_LINEAR_SCOPES,
      state: stateToken,
      actor: "app",
    });
    return {
      authorizeUrl,
      appId: app.id,
      workspaceName: inst.workspaceName,
      botUserId: inst.botUserId,
    };
  }

  /**
   * Verify a re-authorize callback's state, exchange the fresh code for a
   * token pair, and rotate the existing installation's tokens (and vault
   * bearer) in place. Throws on any validation or upstream failure.
   */
  async completeReauthorize(input: {
    appId: string;
    code: string;
    state: string;
    redirectBase: string;
  }): Promise<{
    installationId: string;
    workspaceName: string;
    botUserId: string;
    accessToken: string;
    capturedRefreshToken: boolean;
  }> {
    const payload = await this.container.jwt.verify<{
      kind: string;
      installationId: string;
      appId: string;
    }>(input.state);
    if (payload.kind !== "linear.oauth.reauth") {
      throw new Error("reauth callback: wrong state kind");
    }
    if (payload.appId !== input.appId) {
      throw new Error("reauth callback: appId mismatch");
    }
    const inst = await this.container.installations.get(payload.installationId);
    if (!inst) throw new Error("reauth callback: installation not found");
    const app = await this.container.apps.get(input.appId);
    if (!app) throw new Error("reauth callback: app not found");
    const clientSecret = await this.container.apps.getClientSecret(app.id);
    if (!clientSecret) throw new Error("reauth callback: client_secret missing");

    const redirectUri = this.dedicatedCallbackUriFromBase(input.redirectBase, app.id);
    const tokenReq = buildTokenExchangeBody({
      code: input.code,
      redirectUri,
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
        `reauth token exchange failed: ${tokenRes.status} ${tokenRes.body.slice(0, 200)}`,
      );
    }
    const token = parseTokenResponse(tokenRes.body);
    if (!token.refresh_token) {
      throw new Error(
        "reauth token exchange returned no refresh_token — check the OAuth app's actor=app + offline access settings",
      );
    }

    await this.container.installations.setTokens(
      inst.id,
      token.access_token,
      token.refresh_token,
    );
    if (inst.vaultId) {
      await this.container.vaults.rotateBearerToken({
        userId: inst.userId,
        vaultId: inst.vaultId,
        newBearerToken: token.access_token,
      });
    }
    return {
      installationId: inst.id,
      workspaceName: inst.workspaceName,
      botUserId: inst.botUserId,
      accessToken: token.access_token,
      capturedRefreshToken: true,
    };
  }

  private reauthCallbackUri(redirectBase: string, appId: string): string {
    return this.dedicatedCallbackUriFromBase(redirectBase, appId);
  }

  /** Same shape as `dedicatedCallbackUri` but accepts an arbitrary base —
   *  used when callers pass in env.GATEWAY_ORIGIN explicitly (admin endpoints
   *  invoked from the Hono app rather than from the constructor's
   *  config.gatewayOrigin). */
  private dedicatedCallbackUriFromBase(redirectBase: string, appId: string): string {
    const trimmed = redirectBase.replace(/\/+$/, "");
    return `${trimmed}/linear/oauth/app/${appId}/callback`;
  }

  // ─── Cron sweep + queue drain ─────────────────────────────────

  /**
   * Drain the linear_events queue (rows where payload_json IS NOT NULL AND
   * processed_at IS NULL). Each event is parsed back into a
   * NormalizedWebhookEvent and processed via dispatchEvent. Per-event
   * failures are caught so one bad row doesn't poison the whole tick.
   *
   * `limit` caps work per tick to share cron CPU with runDispatchSweep.
   *
   * Successful + failed rows both get processed_at set (markProcessed /
   * markFailed); they then sit in the table until the 7-day retention
   * sweep GCs them. Operators can grep linear_events by delivery_id for
   * historical debug.
   */
  async drainPendingEvents(nowMs: number, limit = 25): Promise<{
    drainedEvents: number;
    succeeded: number;
    failed: number;
  }> {
    const rows = await this.container.webhookEvents.listUnprocessed(limit);
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const publication = await this.container.publications.get(row.publicationId);
        if (!publication || publication.status !== "live") {
          await this.container.webhookEvents.markFailed(
            row.deliveryId,
            "publication not found or not live",
            nowMs,
          );
          failed++;
          continue;
        }
        const event = JSON.parse(row.payload) as NormalizedWebhookEvent;
        const sessionId = await this.dispatchEvent(publication, event);
        // Linear stays the source of truth for issue state. Mark the row
        // processed with the spawned session id; 7-day retention sweep GCs
        // it later. Keeping it lets ops grep linear_events by delivery_id
        // for "what happened to this webhook" debugging.
        await this.container.webhookEvents.markProcessed(
          row.deliveryId,
          sessionId,
          nowMs,
        );
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await this.container.webhookEvents.markFailed(row.deliveryId, msg, nowMs);
        } catch {
          // best-effort
        }
        failed++;
        console.warn(`[linear-drain] delivery=${row.deliveryId} kind=${row.eventKind} err=${msg}`);
      }
    }
    return { drainedEvents: rows.length, succeeded, failed };
  }

  /**
   * Cron entry point. Picks rules whose `lastPolledAt` is older than the
   * configured interval, runs each, and marks polled. Per-rule errors are
   * caught so one bad rule doesn't poison the whole tick.
   *
   * `ruleLimit` caps how many rules a single tick processes — a noisy
   * Linear workspace (lots of due rules) shouldn't starve other tenants.
   * Default 50 leaves plenty of cron-tick budget.
   */
  async runDispatchSweep(nowMs: number, ruleLimit = 50): Promise<{
    sweptRules: number;
    assignedIssues: number;
    errors: ReadonlyArray<{ ruleId: string; message: string }>;
  }> {
    const rules = await this.container.dispatchRules.listDueForSweep(nowMs, ruleLimit);
    const errors: Array<{ ruleId: string; message: string }> = [];
    let assignedIssues = 0;
    for (const rule of rules) {
      try {
        const n = await this.processDispatchRule(rule, nowMs);
        assignedIssues += n;
      } catch (err) {
        errors.push({
          ruleId: rule.id,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Always advance lastPolledAt so a permanently broken rule
        // doesn't get retried every tick. Operator can re-enable by
        // patching the rule (which doesn't reset lastPolledAt — that's
        // fine, next interval will fire normally).
        try {
          await this.container.dispatchRules.markPolled(rule.id, nowMs);
        } catch {
          // markPolled failing is not fatal — sweep retries next tick.
        }
      }
    }
    return { sweptRules: rules.length, assignedIssues, errors };
  }

  private async processDispatchRule(
    rule: DispatchRule,
    nowMs: number,
  ): Promise<number> {
    const publication = await this.container.publications.get(rule.publicationId);
    if (!publication || publication.status !== "live") return 0;
    const installation = await this.container.installations.get(publication.installationId);
    if (!installation || installation.revokedAt !== null) return 0;
    const accessToken = await this.container.installations.getAccessToken(
      installation.id,
    );
    if (!accessToken) return 0;

    // Combined query: candidate issues + current bot load (for max_concurrent
    // enforcement) in one Linear round trip. We don't trust local DB rows
    // for "is the bot still working" — Linear is the source of truth.
    const initialSlots = Math.min(rule.maxConcurrent * 2, 25);
    const { candidates, currentLoad } = await this.queryDispatchCandidates(
      accessToken,
      rule,
      installation.botUserId,
      initialSlots,
    );
    const slots = Math.max(0, rule.maxConcurrent - currentLoad);
    if (slots === 0 || candidates.length === 0) return 0;

    let assigned = 0;
    for (const issue of candidates) {
      if (assigned >= slots) break;
      try {
        if (installation.installKind === "personal_token") {
          const ok = await this.dispatchPatModeIssue({
            rule,
            publication,
            installation,
            accessToken,
            issue,
            nowMs,
          });
          if (ok) assigned++;
        } else {
          // OAuth-app mode: assign and let Linear's IssueAssignedToYou
          // webhook fire dispatchEvent. linear_issue_sessions dedup
          // protects us from races.
          await this.linearIssueAssign(accessToken, issue.id, installation.botUserId);
          assigned++;
        }
      } catch (err) {
        // Per-issue failures don't poison the rule — log and continue.
        console.warn(
          `[linear-dispatch] rule=${rule.id} issue=${issue.identifier} kind=${installation.installKind} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return assigned;
  }

  /**
   * PAT mode has no webhook source, so the sweep claims atomically and
   * spawns the session itself. Order matters:
   *   1. CAS-claim with sentinel sessionId — wins the race or aborts.
   *   2. sessions.create() — actual session id assigned by host.
   *   3. issueSessions.insert() — UPSERTs the real sessionId over the
   *      sentinel (status remains 'active').
   *   4. issueUpdate(assignee) — best-effort, only for Linear UI
   *      visibility. Failure here doesn't unwind the session.
   *
   * If sessions.create throws after claim, we mark the row 'inactive' so
   * the next sweep tick can retry the issue.
   */
  private async dispatchPatModeIssue(args: {
    rule: DispatchRule;
    publication: Publication;
    installation: { id: string; tenantId: string; botUserId: string; vaultId: string | null };
    accessToken: string;
    issue: DispatchCandidate;
    nowMs: number;
  }): Promise<boolean> {
    const { rule, publication, installation, accessToken, issue, nowMs } = args;
    const claimed = await this.container.issueSessions.claim({
      tenantId: publication.tenantId,
      publicationId: publication.id,
      issueId: issue.id,
      sessionId: "_supervisor_claim",
      nowMs,
    });
    if (!claimed) return false;

    let sessionId: string | null = null;
    try {
      const sessionEvent = {
        type: "user.message" as const,
        content: [
          {
            type: "text" as const,
            text: this.renderSupervisorPickupAsUserMessage(rule, issue),
          },
        ],
        metadata: { linear: { publicationId: publication.id } },
      };
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds: installation.vaultId ? [installation.vaultId] : [],
        mcpServers: [{ name: "linear", url: LINEAR_MCP_URL }],
        metadata: {
          linear: {
            publicationId: publication.id,
            issueId: issue.id,
            workspaceId: null,
          },
        },
        initialEvent: sessionEvent,
      });
      sessionId = created.sessionId;

      // UPSERT the row with the real session id (replaces the sentinel).
      await this.container.issueSessions.insert({
        tenantId: publication.tenantId,
        publicationId: publication.id,
        issueId: issue.id,
        sessionId,
        status: "active",
        createdAt: nowMs,
      });
    } catch (err) {
      // Roll back the claim so next tick can retry.
      try {
        await this.container.issueSessions.updateStatus(
          publication.id,
          issue.id,
          "failed",
        );
      } catch {
        // best-effort
      }
      throw err;
    }

    // Best-effort visibility update — humans browsing the board should
    // see the bot has picked the issue up. Failure here is a UX papercut,
    // not a correctness issue.
    try {
      await this.linearIssueAssign(accessToken, issue.id, installation.botUserId);
    } catch (err) {
      console.warn(
        `[linear-dispatch] PAT visibility-assign failed issue=${issue.identifier} session=${sessionId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  private async queryDispatchCandidates(
    accessToken: string,
    rule: DispatchRule,
    botUserId: string,
    first: number,
  ): Promise<{ candidates: DispatchCandidate[]; currentLoad: number }> {
    const candidateFilter: Record<string, unknown> = {
      assignee: { null: true },
    };
    if (rule.filterStates && rule.filterStates.length > 0) {
      candidateFilter.state = { name: { in: rule.filterStates } };
    }
    if (rule.filterLabel) {
      candidateFilter.labels = { some: { name: { eq: rule.filterLabel } } };
    }
    if (rule.filterProjectId) {
      candidateFilter.project = { id: { eq: rule.filterProjectId } };
    }
    // Linear is the source of truth for "is the bot still working on this"
    // — we do NOT track session lifecycle in our DB. Count by querying for
    // the bot's own non-terminal assigned issues. Combined with the
    // candidate query in one round trip.
    const loadFilter = {
      assignee: { id: { eq: botUserId } },
      state: { type: { nin: ["completed", "canceled"] } },
    };
    const data = await this.graphql.query<{
      candidates: { nodes: DispatchCandidate[] };
      load: { nodes: Array<{ id: string }> };
    }>(
      accessToken,
      `query DispatchCandidatesAndLoad(
         $candidateFilter: IssueFilter, $loadFilter: IssueFilter,
         $first: Int!, $loadFirst: Int!
       ) {
         candidates: issues(filter: $candidateFilter, first: $first) {
           nodes { id identifier title url description }
         }
         load: issues(filter: $loadFilter, first: $loadFirst) {
           nodes { id }
         }
       }`,
      {
        candidateFilter,
        loadFilter,
        first,
        // Cap load query at maxConcurrent — we only need to know whether
        // we're at/over the cap, not the exact count if it's huge.
        loadFirst: rule.maxConcurrent,
      },
    );
    return {
      candidates: data.candidates.nodes ?? [],
      currentLoad: (data.load.nodes ?? []).length,
    };
  }

  private async linearIssueAssign(
    accessToken: string,
    issueId: string,
    assigneeId: string,
  ): Promise<void> {
    await this.graphql.query<{ issueUpdate: { success: boolean } }>(
      accessToken,
      `mutation AssignIssue($id: String!, $assigneeId: String!) {
         issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
       }`,
      { id: issueId, assigneeId },
    );
  }

  private renderSupervisorPickupAsUserMessage(
    rule: DispatchRule,
    issue: DispatchCandidate,
  ): string {
    const filters: string[] = [];
    if (rule.filterLabel) filters.push(`label="${rule.filterLabel}"`);
    if (rule.filterStates) filters.push(`state in [${rule.filterStates.join(", ")}]`);
    if (rule.filterProjectId) filters.push(`project=${rule.filterProjectId}`);
    const filterDesc = filters.length > 0 ? filters.join(" AND ") : "(no filter)";
    const lines: string[] = [
      `# Linear supervisor pickup`,
      ``,
      `**Issue:** ${issue.identifier}`,
      `**Issue UUID:** \`${issue.id}\` (use this when a tool asks for issueId)`,
      `**Title:** ${issue.title}`,
    ];
    if (issue.url) {
      lines.push(`**URL:** ${issue.url}`);
    }
    if (issue.description) {
      lines.push("");
      lines.push(`**Description:**`);
      lines.push(issue.description);
    }
    lines.push("");
    lines.push(
      `You were auto-assigned by the dispatch rule "${rule.name}" (${filterDesc}). ` +
        `Move the issue to In Progress (Linear hosted MCP: \`save_issue(id, state)\`), ` +
        `do the work, post progress comments via OMA's \`linear_post_comment\`, ` +
        `and when done set state to Done + clear assignee via \`save_issue\`.`,
    );
    return lines.join("\n");
  }
}

interface DispatchCandidate {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
  description: string | null;
}
