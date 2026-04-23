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
  IntegrationProvider,
  InstallComplete,
  InstallStep,
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

/** Subset of Container the LinearProvider depends on. */
export interface LinearContainer extends Container {}

const OAUTH_STATE_TTL_SECONDS = 30 * 60; // 30 min — covers slow OAuth UX
const PROVIDER_ID: ProviderId = "linear";

/** Linear's hosted MCP server. Outbound injection matches by hostname. */
const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

// MVP: hardcoded repo for the open-ma fleet. Move to publication.githubRepoUrl
// when we add per-publication GitHub config.
const PROD_GITHUB_REPO_URL = "https://github.com/open-ma/open-managed-agents.git";

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
    const app = await this.container.apps.insert({
      id: form.appId,
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
    const installation = await this.container.installations.insert({
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

    // Comment-reply path (M7): when a human posts a thread reply to a
    // bot-authored comment, deliver it as a user.message into the bot's OMA
    // session. The bot then chooses how to respond — call linear_post_comment
    // to reply in the same thread, or stay silent. There's no panel binding
    // for thread replies (Linear doesn't auto-spawn one), so the bot's
    // assistant text won't render anywhere unless it explicitly calls a tool.
    if (event.kind === "commentReply" && event.parentCommentId) {
      const authored = await this.container.authoredComments.get(event.parentCommentId);
      if (!authored) {
        return { handled: false, reason: "comment_reply_to_non_bot" };
      }
      // Don't bounce the bot's own thread replies back at itself.
      if (event.actorUserId && installation.botUserId === event.actorUserId) {
        return { handled: false, reason: "comment_reply_from_bot_self" };
      }
      const actorDisplayName = await this.resolveActorDisplayName(installation.id, event.actorUserId);
      const handle = actorDisplayName ? `@${actorDisplayName}` : "(unknown user)";
      const replyText = [
        `# Linear thread reply`,
        ``,
        `**Issue:** ${event.issueIdentifier ?? event.issueId ?? "?"}`,
        `**Thread anchor comment:** ${authored.commentId}`,
        `**Replier:** ${handle}`,
        ``,
        `> ${(event.commentBody ?? "").replace(/\n/g, "\n> ")}`,
        ``,
        `No Linear AgentSession panel is open for this turn. To respond visibly, call`,
        `\`linear_post_comment(body=..., parentId="${authored.commentId}")\` — that posts a sibling`,
        `comment in the same thread. Otherwise stay silent (your assistant text won't`,
        `appear anywhere on Linear unless you explicitly call a tool).`,
      ].join("\n");
      await this.container.sessions.resume(publication.userId, authored.omaSessionId, {
        type: "user.message",
        content: [{ type: "text", text: replyText }],
        // Metadata only carries the immutable wiring fields the MCP server
        // needs to authenticate. Everything else lives in the prompt body.
        metadata: { linear: { publicationId: publication.id } },
      });
      await this.container.webhookEvents.attachSession(req.deliveryId, authored.omaSessionId);
      return {
        handled: true,
        reason: "comment_reply_to_bot",
        publicationId: publication.id,
        sessionId: authored.omaSessionId,
      };
    }

    // Dispatch to OMA. per_issue mode resumes the existing session; per_event
    // (and the first hit on per_issue) creates a fresh one.
    const sessionId = await this.dispatchEvent(publication, event);
    await this.container.webhookEvents.attachSession(req.deliveryId, sessionId);

    return {
      handled: true,
      reason: routingReason,
      publicationId: publication.id,
      sessionId,
    };
  }

  private async dispatchEvent(
    publication: Publication,
    event: NormalizedWebhookEvent,
  ): Promise<string> {
    // Look up the installation to find the vault holding the access token.
    const installation = await this.container.installations.get(publication.installationId);
    const vaultIds = installation?.vaultId ? [installation.vaultId] : [];
    // We no longer pass mcp.linear.app here — apps/main wires the hosted
    // OMA-side Linear MCP (integrations.openma.dev/linear/mcp/<sessionId>)
    // when it sees metadata.linear, so sandbox never talks to Linear directly.
    const mcpServers: Array<{ name: string; url: string }> = [];

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
      // linear_enter_panel / linear_exit_panel tools (D1-backed). No more
      // mutating fields like currentAgentSessionId / triggerCommentId here.
      metadata: { linear: { publicationId: publication.id } },
    };

    if (publication.sessionGranularity === "per_issue" && event.issueId) {
      const existing = await this.container.issueSessions.getByIssue(
        publication.id,
        event.issueId,
      );
      if (existing && existing.status === "active") {
        await this.container.sessions.resume(publication.userId, existing.sessionId, sessionEvent);
        return existing.sessionId;
      }
      const created = await this.container.sessions.create({
        userId: publication.userId,
        agentId: publication.agentId,
        environmentId: publication.environmentId,
        vaultIds,
        mcpServers,
        metadata: { linear: { publicationId: publication.id, issueId: event.issueId, workspaceId: event.workspaceId } },
        initialEvent: sessionEvent,
        // MVP: hardcoded for the open-ma fleet. Move to publication.githubRepoUrl
        // when the schema lands.
        githubRepoUrl: PROD_GITHUB_REPO_URL,
      });
      await this.container.issueSessions.insert({
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
      githubRepoUrl: PROD_GITHUB_REPO_URL,
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
    lines.push(`**Issue:** ${event.issueIdentifier ?? event.issueId ?? "?"}`);
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
        `Linear opened panel \`${event.agentSessionId}\` for this turn. ` +
          `Call \`linear_enter_panel("${event.agentSessionId}")\` if you want users ` +
          `to watch your work — once entered, your subsequent reasoning and ` +
          `tool calls render in that panel automatically. Without entering, ` +
          `you stay silent and need explicit tool calls (linear_post_comment ` +
          `etc.) to produce any user-visible output.`,
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
}
