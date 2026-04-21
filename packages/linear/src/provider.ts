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
    // Generate appId AND webhookSecret upfront so we can hand the user the
    // *final* callback / webhook URLs to paste into Linear's app form. Without
    // this, step 1 returned `<APP_ID>` placeholder URLs and step 2 returned
    // the real ones — forcing the user to re-edit the Linear App after
    // creation. Linear bakes the webhook URL at creation time and won't let
    // you change it via API, so the only way out is to make step 1 final.
    //
    // Both values live inside a short-lived form_token; we don't write the
    // App row to D1 until step 2 (after the user pastes the OAuth client
    // credentials Linear gave them).
    const appId = this.container.ids.generate();
    const webhookSecret = this.container.ids.generate();
    const formToken = await this.container.jwt.sign(
      {
        kind: "linear.a1.form",
        userId: input.userId,
        agentId: input.agentId,
        environmentId: input.environmentId,
        persona: input.persona,
        returnUrl: input.returnUrl,
        appId,
        webhookSecret,
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
        webhookSecret,
      },
    };
  }

  private async submitDedicatedCredentials(
    payload: Record<string, unknown>,
  ): Promise<InstallStep> {
    const formToken = (payload.formToken as string) ?? "";
    const clientId = (payload.clientId as string) ?? "";
    const clientSecret = (payload.clientSecret as string) ?? "";
    if (!formToken || !clientId || !clientSecret) {
      throw new Error("submit_credentials: formToken, clientId, clientSecret required");
    }

    const form = await this.container.jwt.verify<{
      kind: string;
      userId: string;
      agentId: string;
      environmentId: string;
      persona: Persona;
      returnUrl: string;
      appId: string;
      webhookSecret: string;
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
      webhookSecret: form.webhookSecret,
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
      refreshToken: null,
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
    const mcpServers = [{ name: "linear", url: LINEAR_MCP_URL }];

    const sessionEvent = {
      type: "user.message" as const,
      content: [
        { type: "text" as const, text: this.renderEventAsUserMessage(event) },
      ],
      metadata: {
        linear: {
          workspaceId: event.workspaceId,
          issueId: event.issueId,
          issueIdentifier: event.issueIdentifier,
          commentId: event.commentId,
          actorUserId: event.actorUserId,
          eventKind: event.kind,
          deliveryId: event.deliveryId,
        },
      },
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
        metadata: { linear: { issueId: event.issueId, workspaceId: event.workspaceId } },
        initialEvent: sessionEvent,
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
      metadata: { linear: { issueId: event.issueId, workspaceId: event.workspaceId } },
      initialEvent: sessionEvent,
    });
    return created.sessionId;
  }

  private renderEventAsUserMessage(event: NormalizedWebhookEvent): string {
    // Compact text representation passed to the agent as the first user
    // message. The agent's MCP tools are how it fetches richer context.
    const lines: string[] = [];
    lines.push(`Linear ${event.kind ?? "event"} on ${event.issueIdentifier ?? "?"}`);
    if (event.issueTitle) lines.push(`Title: ${event.issueTitle}`);
    if (event.actorUserName) lines.push(`From: ${event.actorUserName}`);
    if (event.commentBody) lines.push(`\nComment:\n${event.commentBody}`);
    return lines.join("\n");
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
}
